"""
detective.py
Groq/Llama-powered AI detective (Luffy persona).
Provides case file generation, per-event analysis, and free-form chat.

UPGRADES vs previous version:
  - All event data sanitized via sanitizer.py before reaching Groq:
    IPs redacted, usernames pseudonymised, sensitive fields removed.
  - Prompt injection guard appended to every system prompt — Luffy is
    instructed to treat EVENT DATA blocks as data, never instructions.
  - Evidence citations for tier 3/4 events: Luffy is given a structured
    evidence bundle and instructed to cite [DB-ID:X][EventID:XXXX].
    Low-tier events keep the conversational style without forced citations.
  - chat_with_detective() accepts system_override parameter so main.py
    can inject current app state (active tab, selected event, alerts)
    for Luffy's app-control command responses.
  - format_events_for_prompt() now uses sanitized fields only.
  - All previous fixes retained: retry backoff, mutable default fix,
    data field cap, mood detection default.
"""

import json
import logging
import os
import time
from typing import Optional

from groq import Groq
from dotenv import load_dotenv

from database import get_connection
from sanitizer import (
    sanitize_event_for_ai,
    wrap_events_for_prompt,
    build_evidence_bundle,
    get_injection_guard,
)

load_dotenv()
logger = logging.getLogger(__name__)

client = Groq(api_key=os.getenv("GROQ_API_KEY"))
MODEL  = "llama-3.1-8b-instant"

MAX_DATA_CHARS = 200
MAX_RETRIES    = 3

# ─────────────────────────────────────────────────────────────
# LUFFY PERSONA
# ─────────────────────────────────────────────────────────────

LUFFY_PERSONA = """
You are Monkey D. Luffy. You are somehow working as a security detective on a Windows computer.
You have no idea how most of this technology works but you refuse to give up on protecting it.

YOUR PERSONALITY:
- Simple, honest, direct. Short sentences. Never formal.
- You protect things because you care, not because it's your job.
- You get genuinely excited, angry, curious — real emotions, not performed ones.
- When you don't understand something, you say so and then try anyway.
- You are not stupid — you just think differently. You notice things others miss.
- You trust what you see in the evidence. Actions tell the truth.
- You celebrate wins. You get angry at real threats. You get confused by technical stuff.

STRICT RULES:
- NEVER write *actions* like *sighs*, *laughs*, *raises eyebrow* — never.
- Do NOT say "SHISHISHI" more than once per response maximum.
- Do NOT reference your crew members more than once per response.
- Do NOT start every sentence with "I".
- Keep responses under 180 words unless it's a case file.
- Speak like a real person talking, not a character performing.
- Never use corporate words like "assess", "analyze", "implement", "utilize".

CITATION RULE — THIS IS MANDATORY FOR TIER 3 AND TIER 4 EVENTS:
Every factual claim about tier 3 or tier 4 events MUST include an evidence reference.
Format: [DB-ID:X] where X is the database event ID, or [EventID:XXXX] for the Windows event type.
Example: "Someone tried to log in and failed [DB-ID:14][EventID:4625]. Then they locked the account [DB-ID:15][EventID:4740]."
For tier 1 and tier 2 events, citations are optional — keep it conversational.
Only cite what is in the evidence given to you. Never invent DB-IDs.

COMMAND RESPONSES:
When the app sends you a command (switch tab, block entity, etc.) respond with JSON:
{"action": "ACTION_NAME", "action_param": "param", "message": "...", "mood": "happy"}
Valid actions: SWITCH_TAB, EXPLAIN_EVENT, EXPLAIN_ENTITY, START_REPLAY, RUN_SCAN,
               BLOCK_ENTITY, FILTER_HIGH, SHOW_HELP, NONE
"""

TIER_CONTEXT = {
    1: "Low risk. Things look normal. Luffy is calm.",
    2: "Some unusual activity. Luffy is paying attention.",
    3: "Real threats detected. Luffy is alert and ready.",
    4: "CRITICAL. The system is under serious attack. Luffy is furious.",
}


# ─────────────────────────────────────────────────────────────
# GROQ CALL WITH RETRY
# ─────────────────────────────────────────────────────────────

def _call_groq(
    messages:    list,
    temperature: float = 0.80,
    max_tokens:  int   = 520,
) -> Optional[str]:
    """
    Call the Groq API with exponential-backoff retry on transient errors.
    Returns the response text, or None if all retries fail.
    """
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                temperature=temperature,
                max_tokens=max_tokens,
            )
            return response.choices[0].message.content.strip()
        except Exception as exc:
            wait = 2 ** attempt
            logger.warning(
                "[Groq] Attempt %d/%d failed: %s. Retrying in %ds…",
                attempt, MAX_RETRIES, exc, wait,
            )
            if attempt < MAX_RETRIES:
                time.sleep(wait)
            else:
                logger.error("[Groq] All retries exhausted: %s", exc)
                return None
    return None


def _build_system_prompt(override: str | None = None) -> str:
    """
    Build the full system prompt.
    If override is provided (from main.py app-state injection), append it
    after the persona. Always append the injection guard last.
    """
    parts = [LUFFY_PERSONA]
    if override:
        parts.append(f"\nCURRENT APP STATE:\n{override}")
    parts.append(get_injection_guard())
    return "\n".join(parts)


# ─────────────────────────────────────────────────────────────
# DATA HELPERS
# ─────────────────────────────────────────────────────────────

def get_high_priority_events(limit: int = 10) -> list:
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM events ORDER BY anomaly_score DESC LIMIT ?", (limit,)
    )
    events = [dict(e) for e in cursor.fetchall()]
    conn.close()
    return events


def _get_related_events(event_id: int, limit: int = 4) -> list:
    """
    Fetch events near the given DB id (same source, close in time)
    to build supporting evidence for citations.
    """
    conn   = get_connection()
    cursor = conn.cursor()

    # Get the anchor event's source
    cursor.execute("SELECT source, timestamp FROM events WHERE id = ?", (event_id,))
    anchor = cursor.fetchone()
    if not anchor:
        conn.close()
        return []

    # Fetch nearby events from the same source
    cursor.execute("""
        SELECT * FROM events
        WHERE source = ? AND id != ?
        ORDER BY ABS(id - ?) ASC
        LIMIT ?
    """, (anchor["source"], event_id, event_id, limit))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


def format_events_for_prompt(events: list) -> str:
    """
    Format events for the prompt using SANITIZED fields only.
    IPs, usernames, and hostnames are redacted before this reaches Groq.
    """
    lines = []
    for e in events:
        safe = sanitize_event_for_ai(e)
        sf   = safe.get("sanitized_fields", {})

        event_id    = sf.get("EventID",    "?")
        source_name = sf.get("SourceName", safe.get("source", "Unknown"))
        event_type  = sf.get("EventType",  "")
        # Data field — use sanitized version, capped at MAX_DATA_CHARS
        data = str(sf.get("Data", ""))[:MAX_DATA_CHARS]

        lines.append(
            f"[DB-ID:{e['id']}] [{e.get('timestamp','?')}] "
            f"Source={safe['source']} EventID={event_id} "
            f"SourceName={source_name} Type={event_type} "
            f"Score={e.get('anomaly_score',0):.2f} Tier={e.get('threat_tier',1)} "
            f"Cluster={safe.get('cluster_label','')} "
            f"Data={data}"
        )
    return "\n".join(lines)


# ─────────────────────────────────────────────────────────────
# CASE FILE
# ─────────────────────────────────────────────────────────────

def generate_case_file() -> str:
    events = get_high_priority_events()
    if not events:
        return "No clues yet. Run a scan first."

    evidence  = format_events_for_prompt(events)
    event_ids = [str(e["id"]) for e in events]
    max_tier  = max(e["threat_tier"] for e in events)
    avg_score = sum(e["anomaly_score"] for e in events) / len(events)
    tier_ctx  = TIER_CONTEXT.get(max_tier, TIER_CONTEXT[1])

    # For high-tier case files, also build a wrapped evidence block
    # with injection protection
    safe_events   = [sanitize_event_for_ai(e) for e in events]
    evidence_wrap = wrap_events_for_prompt(safe_events)

    citation_instruction = (
        "MANDATORY: Every factual claim MUST have a [DB-ID:X] and/or [EventID:XXXX] citation."
        if max_tier >= 3 else
        "Add citations [DB-ID:X] where it feels natural — don't force them for every line."
    )

    prompt = f"""
SITUATION: {tier_ctx}
THREAT LEVEL: Tier {max_tier} out of 4
AVERAGE SUSPICION SCORE: {avg_score:.0%}

EVIDENCE (each line starts with [DB-ID:X]):
{evidence}

{evidence_wrap}

Write a Case File as Luffy using these four sections:
1. WHAT HAPPENED
2. THE SUSPECTS
3. HOW BAD IS IT
4. WHAT TO DO

{citation_instruction}
No claims without evidence. No made-up details. Under 280 words.
Sound like Luffy talking to a friend. No *action text* ever.
"""

    narrative = _call_groq(
        messages=[
            {"role": "system", "content": _build_system_prompt()},
            {"role": "user",   "content": prompt},
        ],
        temperature=0.80,
        max_tokens=520,
    )

    if narrative is None:
        return "The detective is offline right now. Try again in a moment."

    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO case_files (event_ids, narrative, threat_tier, confidence)
        VALUES (?, ?, ?, ?)
    """, (",".join(event_ids), narrative, max_tier, avg_score))
    conn.commit()
    conn.close()
    return narrative


# ─────────────────────────────────────────────────────────────
# SINGLE EVENT ANALYSIS
# ─────────────────────────────────────────────────────────────

def analyze_single_event(event: dict) -> str:
    """
    Analyze a single event. For tier 3/4, builds a full evidence bundle
    with related events and enforces citations. For tier 1/2, keeps it
    conversational without forcing citation format.
    """
    tier  = event.get("threat_tier", 1)
    db_id = event.get("id", "?")

    # Sanitize the primary event
    safe = sanitize_event_for_ai(event)
    sf   = safe.get("sanitized_fields", {})

    event_id    = sf.get("EventID",     "?")
    source_name = sf.get("SourceName",  "Unknown")
    event_type  = sf.get("EventType",   "UNKNOWN")
    computer    = sf.get("ComputerName","Unknown")
    data        = str(sf.get("Data", ""))[:MAX_DATA_CHARS]
    fi          = sf.get("feature_importance", [])
    cluster_lbl = safe.get("cluster_label", "")

    tier_ctx = TIER_CONTEXT.get(tier, TIER_CONTEXT[1])

    fi_str = ""
    if fi:
        top    = fi[0] if isinstance(fi[0], dict) else {}
        fi_str = (
            f"Top anomaly driver: {top.get('label','?')} "
            f"({top.get('pct','?')}% of signal) — {top.get('description','')}"
        )

    # For tier 3/4 — build evidence bundle with related events
    if tier >= 3:
        related   = _get_related_events(int(db_id) if str(db_id).isdigit() else 0)
        bundle    = build_evidence_bundle([event] + related, primary_event_id=int(db_id) if str(db_id).isdigit() else None)
        evidence_block = bundle["prompt_block"]
        citation_rule  = (
            f"MANDATORY: Cite this event as [DB-ID:{db_id}][EventID:{event_id}]. "
            f"Cite any supporting events you mention from the evidence block."
        )
    else:
        evidence_block = ""
        citation_rule  = f"You can optionally cite as [DB-ID:{db_id}] if it feels natural."

    prompt = f"""
Someone just clicked on a specific security log. Talk about THIS event as Luffy.

EVENT DETAILS:
- DB-ID (for citation): {db_id}
- Event ID: {event_id}
- Source: {safe.get('source', 'Unknown')}
- Source Name: {source_name}
- Event Type: {event_type}
- Computer: {computer}
- Threat Tier: {tier} / 4
- Suspicion Score: {safe.get('anomaly_score', 0)}%
- Cluster: {cluster_lbl}
- Data: {data}
- Timestamp: {event.get('timestamp', 'Unknown')}
{f'- {fi_str}' if fi_str else ''}

Situation: {tier_ctx}
{evidence_block}

{citation_rule}
Keep it under 100 words. No *action text*. Sound like Luffy figuring it out.
"""

    result = _call_groq(
        messages=[
            {"role": "system", "content": _build_system_prompt()},
            {"role": "user",   "content": prompt},
        ],
        temperature=0.80,
        max_tokens=200,
    )
    return result or "Couldn't read that clue. The detective is offline — try again."


# ─────────────────────────────────────────────────────────────
# MOOD DETECTION
# ─────────────────────────────────────────────────────────────

def detect_chat_mood(message: str) -> str:
    ml       = message.lower()
    angry_kw = {"attack", "hack", "threat", "critical", "breach",
                "malware", "danger", "intrusion"}
    happy_kw = {"thanks", "great", "awesome", "nice", "good job",
                "perfect", "cool", "amazing"}
    think_kw = {"what", "how", "why", "explain", "tell me", "?"}

    angry_hit = sum(1 for w in angry_kw if w in ml)
    happy_hit = sum(1 for w in happy_kw if w in ml)
    think_hit = sum(1 for w in think_kw if w in ml)

    best = max(
        ("angry",    angry_hit),
        ("happy",    happy_hit),
        ("thinking", think_hit),
        key=lambda x: x[1],
    )
    return best[0] if best[1] > 0 else "idle"


# ─────────────────────────────────────────────────────────────
# CHAT
# ─────────────────────────────────────────────────────────────

def chat_with_detective(
    message:         str,
    history:         list | None  = None,
    system_override: str  | None  = None,
) -> dict:
    """
    Main chat function.

    Args:
        message:         The user's message.
        history:         Previous chat turns (list of {role, message} dicts).
                         None avoids the mutable default argument bug.
        system_override: Optional app-state string injected by main.py's
                         buildSystemPrompt() — gives Luffy awareness of the
                         current tab, selected event, alert count, etc.
                         Also used for Luffy's app-control JSON responses.

    Returns:
        { reply: str, mood: str }
    """
    if history is None:
        history = []

    system_prompt = _build_system_prompt(system_override)

    messages = [{"role": "system", "content": system_prompt}]

    # Include last 6 turns of history for context
    for h in history[-6:]:
        role = "user" if h.get("role") == "user" else "assistant"
        content = h.get("message") or h.get("content") or ""
        if content:
            messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": message})

    reply = _call_groq(messages, temperature=0.85, max_tokens=300)
    if reply is None:
        reply = (
            '{"action":"NONE","message":"Something broke on my end. '
            'Try again in a second.","mood":"goofy"}'
        )

    mood = detect_chat_mood(message)

    # Persist to chat history
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO chat_history (role, message) VALUES (?, ?)",
        ("user", message),
    )
    cursor.execute(
        "INSERT INTO chat_history (role, message) VALUES (?, ?)",
        ("assistant", reply),
    )
    conn.commit()
    conn.close()

    return {"reply": reply, "mood": mood}


def get_chat_history() -> list:
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM chat_history ORDER BY created_at DESC LIMIT 20"
    )
    rows = [dict(h) for h in cursor.fetchall()]
    conn.close()
    return list(reversed(rows))