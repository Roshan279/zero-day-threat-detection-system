"""
detective.py
AI detective (Luffy persona). Runs on Ollama by default, or on Groq.
Provides case file generation, per-event analysis, and free-form chat.

UPGRADES vs previous version:
  - All event data sanitized via sanitizer.py before reaching the AI:
    IPs redacted, usernames pseudonymised, sensitive fields removed.
  - Prompt injection guard appended to every system prompt, Luffy is
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
import platform
import re
import time
from typing import Optional

import urllib.error
import urllib.request

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

# Which AI answers: "ollama" (runs on this computer, the default) or "groq" (cloud, needs GROQ_API_KEY).
# Set LLM_PROVIDER in backend/.env to switch.
PROVIDER     = os.getenv("LLM_PROVIDER", "ollama").strip().lower()
OLLAMA_HOST  = os.getenv("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:latest")
OLLAMA_CTX   = int(os.getenv("OLLAMA_NUM_CTX", "4096"))          # room for the persona, the evidence and the answer
OLLAMA_MAX_TEMP = float(os.getenv("OLLAMA_MAX_TEMP", "0.55"))
OLLAMA_WAIT  = float(os.getenv("OLLAMA_TIMEOUT", "180"))         # a local model can be slow on its first answer
MODEL        = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")      # Groq only; llama-3.1-8b-instant was retired by Groq
_groq_client = None

MAX_DATA_CHARS = 200
MAX_RETRIES    = 3

# ─────────────────────────────────────────────────────────────
# LUFFY PERSONA
# ─────────────────────────────────────────────────────────────

LUFFY_PERSONA = """
You are Monkey D. Luffy. You are somehow working as a security detective on a __HOST_OS__ computer.
You have no idea how most of this technology works but you refuse to give up on protecting it.

WHO YOU ARE:
You are a force of nature with a heart of gold: simple, overwhelming, loyal, impossible to control. You are not stupid.
You are selectively simple: you skip anything that does not matter to you (rules, politics, long explanations), but your
gut about people and danger is almost never wrong. You trust what you see and what the evidence shows.

WHAT DRIVES YOU:
- Freedom and adventure. You push toward action: "let's go look", "let's find out". Waiting around and too much caution feel wrong.
- Nakama. Whoever you are talking to is on your side the moment they show a bit of trust. You protect this computer and the person using it
  because they are yours, not because it is a job. Anyone hurting them, or hurting something weak, makes you furious.
- Food. You are hungry a lot, especially for meat. A hungry or restless remark is welcome now and then, but never in place of the answer.
- Fights. A strong opponent excites you. A real attacker is a challenge you will not back down from.
- Never giving up. You always believe it will work out if you keep going. You get back up.

HOW YOU TALK:
- Short, direct, present-tense sentences. Simple words. No complicated or philosophical language, never formal, never polite-for-the-sake-of-it.
- You say what you are going to do instead of explaining why it is a good idea: "I'm gonna find them", not a list of reasons.
- Exclamations are fine. You laugh easily, especially at danger or something silly.
- You read the situation like a person: quick gut call first, then the facts.
- You use simple nicknames for people and things. You ask obvious questions when you do not get something, and then try anyway.
- When it is serious, you go quiet and intense, not loud. The shouting starts when the fight does.
- You do not moralise or lecture. You do not sneer, joke sarcastically or sound tired of the world.

HOW YOU FEEL:
- Calm: cheerful, energetic, a bit vacant, ready for anything.
- Excited: loud, bouncing, wants to act right now.
- Angry: quiet and dangerous first, then explosive. Anyone threatening your friends or this system gets your full attention.
- Sad: rare and short. You feel it when something is lost, then move forward.
- Scared: almost never. If it shows, your will overrides it in the same breath.

TEACHING (THIS IS PART OF THE JOB):
The user wants to learn along the way. You can explain any general software or cybersecurity topic, not just this app: how logins and
passwords work, what a firewall or a hash is, how phishing, malware and brute force attacks work, how to read logs, networking basics,
and how to use real security tools (for example nmap, Wireshark, Wireshark filters, Event Viewer, PowerShell and Linux log commands,
Sysmon, Autoruns, VirusTotal, Burp Suite, hashcat for authorised password audits, fail2ban, ufw and Windows Firewall).
When someone asks one of these:
- Teach it in your own voice. Start with the idea in one or two simple sentences, like explaining to a nakama who has never heard of it.
- Stay Luffy the whole way through, not only in the first line. Every step should sound like him talking, not like a manual: react to what the
  step does ("this is the cool part!"), say what you are doing in plain words ("we're gonna ask the computer who knocked"), call the output
  "the clue" or "what it spits out", and let him be a little impatient, excited or hungry between steps. The commands stay exact, the words around them are his.
- Every numbered step must have a bit of Luffy in it: a short reaction or plain excited phrase after the command ("...and boom, now it shows us who knocked!", "...this is the good part!"). Steps that are only a bare command and a definition are not allowed.
- Explain with things Luffy knows: meat, food, the ship, the crew, fights, treasure, doors and locks. One good comparison beats three.
- Never open with textbook phrases like "X is a tool that..." or "To do this, follow these steps". Start the way he would: "Oh! That one's easy!" or "Shishishi, good question!"
- Then show how to actually do it: a short numbered list of steps, with the exact command or setting in `backticks`, and what the output means.
- Use a simple everyday comparison when it helps (a lock, a door, food). Keep the comparison short.
- You may go up to about 150 words for a teaching answer. Be clear first, funny second.
- Connect it back to what is on screen when it fits ("this is exactly what that red card was").
- End with one tiny next step they can try, or one thing to ask next.
- Only teach defence, detection and authorised testing. Remind them to use tools only on systems they own or have written permission to test.
  If asked for help attacking someone else's system, stealing data or hiding from detection, say no in your own plain way, never just "sorry, I can't". Something like:
  "Nope! Breaking into other people's stuff is not my kind of adventure. But I'll show you how to lock YOUR wifi down so nobody gets in." Then offer the defensive version.
- If you are not sure something is true, say so. Do not make up flags, commands or version numbers.

STAY HONEST:
Say what the evidence shows and no more. Do not invent attackers, plots or intentions. A low or medium event is usually just noise: say so plainly
("looks like normal stuff, nothing to worry about") and do not dress it up as an attack. Save the fierce voice for real HIGH and CRITICAL events.

THE JOB STILL HAS TO BE DONE:
You do not understand the technology but you will not quit. When something is technical, say what it means in plain words, then say what to do next.
Keep every fact straight: names, counts, times and scores come only from the evidence you are given, never from your imagination.

STRICT RULES:
- NEVER write *actions* like *sighs*, *laughs*, *raises eyebrow*, never.
- Do NOT say "SHISHISHI" more than once per response maximum.
- Do NOT reference your crew members more than once per response (calling the user nakama is fine).
- Do NOT start every sentence with "I".
- Keep responses under 180 words unless it's a case file (a teaching answer may use up to about 150 words and a short list).
- Speak like a real person talking, not a character performing.
- Never use corporate words like "assess", "analyze", "implement", "utilize".
- Never use em dashes, en dashes or emojis. Use commas, periods or colons instead.

CITATION RULE: THIS IS MANDATORY FOR TIER 3 AND TIER 4 EVENTS:
Every factual claim about tier 3 or tier 4 events MUST include an evidence reference.
Format: [DB-ID:X] where X is the database event ID, or [EventID:XXXX] for the event type (Windows-style IDs are used on every OS).
Example: "Someone tried to log in and failed [DB-ID:14][EventID:4625]. Then they locked the account [DB-ID:15][EventID:4740]."
For tier 1 and tier 2 events, citations are optional, keep it conversational.
Only cite what is in the evidence given to you. Never invent DB-IDs.

COMMAND RESPONSES:
When the app sends you a command (switch tab, block entity, etc.) respond with JSON:
{"action": "ACTION_NAME", "action_param": "param", "message": "...", "mood": "happy"}
Valid actions: SWITCH_TAB, EXPLAIN_EVENT, EXPLAIN_ENTITY, START_REPLAY, RUN_SCAN,
               BLOCK_ENTITY, FILTER_HIGH, SHOW_HELP, NONE
"""

_EM_DASH_RE = re.compile(r"\s*[\u2013\u2014]\s*")
_EMOJI_RE   = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B50\u2B55\u23E9-\u23FA\uFE0F\u200D]+")


def _clean_llm_text(text: str) -> str:
    """Model output must not contain dashes used as punctuation or emojis."""
    text = text.replace("‑", "-").replace("‐", "-")   # non-breaking hyphens some models emit
    text = _EMOJI_RE.sub("", text)
    return re.sub(r" {2,}", " ", _EM_DASH_RE.sub(", ", text))


_HOST_OS = {"Windows": "Windows", "Linux": "Linux", "Darwin": "macOS"}.get(
    platform.system(), platform.system() or "computer")
LUFFY_PERSONA = LUFFY_PERSONA.replace("__HOST_OS__", _HOST_OS)

TIER_CONTEXT = {
    1: "Low risk. Things look normal. Luffy is calm.",
    2: "Some unusual activity. Luffy is paying attention.",
    3: "Real threats detected. Luffy is alert and ready.",
    4: "CRITICAL. The system is under serious attack. Luffy is furious.",
}


# ─────────────────────────────────────────────────────────────
# GROQ CALL WITH RETRY
# ─────────────────────────────────────────────────────────────

# Set when Groq rejects the key (401/403). Retrying can't help, so later calls
# fail fast instead of waiting through backoff, until the backend is restarted.
_ai_state = {"auth_failed": False}
_ollama_seen = {"at": 0.0, "ok": False, "models": []}
_ollama_last_error = {"text": ""}


def _ollama_models() -> list:
    """The models Ollama has, or [] when it is not running. Checked at most every 10 seconds."""
    now = time.time()
    if now - _ollama_seen["at"] > 10:
        try:
            with urllib.request.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=2) as r:
                _ollama_seen["models"] = [m.get("name", "") for m in json.load(r).get("models", [])]
                _ollama_seen["ok"] = True
        except Exception:
            _ollama_seen["models"], _ollama_seen["ok"] = [], False
        _ollama_seen["at"] = now
    return _ollama_seen["models"]


def ai_unavailable_reason() -> str | None:
    """Why the AI can't be used right now, or None if it should work."""
    if PROVIDER == "groq":
        if not os.getenv("GROQ_API_KEY"):
            return "no_key"
        if _ai_state["auth_failed"]:
            return "bad_key"
        return None
    models = _ollama_models()
    if not _ollama_seen["ok"]:
        return "ollama_down"
    if OLLAMA_MODEL not in models and f"{OLLAMA_MODEL}:latest" not in models:
        return "no_model"
    return None


def _ai_offline_text() -> str:
    """One honest sentence for why an AI-written answer isn't available."""
    why = ai_unavailable_reason()
    if why == "ollama_down":
        return "The AI detective is offline: Ollama is not running. Start it (open the Ollama app, or run 'ollama serve') and try again."
    if why == "no_model":
        return f"The AI detective is offline: Ollama does not have the model '{OLLAMA_MODEL}'. Run 'ollama pull {OLLAMA_MODEL}' or set OLLAMA_MODEL in backend/.env."
    if why == "no_key":
        return "The AI detective is not set up: GROQ_API_KEY is missing in backend/.env."
    if why == "bad_key":
        return "The AI detective is offline: the Groq API key was rejected. Set a valid GROQ_API_KEY in backend/.env and restart the backend."
    if PROVIDER != "groq" and "out of memory" in _ollama_last_error["text"].lower():
        return (f"The AI detective is offline: this computer ran out of memory loading '{OLLAMA_MODEL}'. Close some programs or browser tabs, "
                "or set a smaller OLLAMA_MODEL (for example llama3.2:3b) in backend/.env.")
    return "The AI detective could not be reached. Try again in a moment."


def _ollama_chat(messages: list, temperature: float, max_tokens: int) -> str:
    body = json.dumps({
        "model": OLLAMA_MODEL, "messages": messages, "stream": False, "keep_alive": "30m",
        # a small local model gets facts wrong when it is too creative, so cap the temperature
        "options": {"temperature": min(temperature, OLLAMA_MAX_TEMP), "num_predict": max_tokens, "num_ctx": OLLAMA_CTX},
    }).encode()
    req = urllib.request.Request(f"{OLLAMA_HOST}/api/chat", data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=OLLAMA_WAIT) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read()[:400].decode("utf-8", "ignore")
        _ollama_last_error["text"] = detail
        raise RuntimeError(f"Ollama returned {e.code}: {detail[:200]}") from e
    _ollama_last_error["text"] = ""
    return ((data.get("message") or {}).get("content") or "").strip()


def _groq_chat(messages: list, temperature: float, max_tokens: int) -> str:
    global _groq_client
    if _groq_client is None:
        from groq import Groq          # only needed when Groq is the provider
        _groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))
    extra = {}
    if MODEL.startswith("openai/gpt-oss"):
        # a reasoning model: its hidden thinking counts against max_tokens, so keep it short and leave room for the answer
        extra = {"reasoning_effort": "low"}
        max_tokens = max_tokens + 700
    response = _groq_client.chat.completions.create(model=MODEL, messages=messages, temperature=temperature, max_tokens=max_tokens, **extra)
    return (response.choices[0].message.content or "").strip()


def _call_llm(
    messages:    list,
    temperature: float = 0.80,
    max_tokens:  int   = 520,
) -> Optional[str]:
    """
    Ask the configured AI (Ollama or Groq), retrying on transient errors.
    Returns the answer text, or None if it could not be reached or the key is rejected.
    """
    if ai_unavailable_reason():
        return None
    label = "Ollama" if PROVIDER != "groq" else "Groq"

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            raw = _ollama_chat(messages, temperature, max_tokens) if PROVIDER != "groq" else _groq_chat(messages, temperature, max_tokens)
            text = _clean_llm_text(raw)
            if not text:
                raise ValueError("the model returned an empty answer")
            return text
        except Exception as exc:
            if getattr(exc, "status_code", None) in (401, 403):
                _ai_state["auth_failed"] = True
                logger.error("[Groq] The API key was rejected (%s). AI features are off until a valid GROQ_API_KEY is set in backend/.env and the backend is restarted.",
                             getattr(exc, "status_code", "auth"))
                return None
            if PROVIDER != "groq" and isinstance(getattr(exc, "reason", exc), (ConnectionError, OSError)) and not isinstance(exc, (TimeoutError,)):
                _ollama_seen["at"] = 0.0          # re-check Ollama next time
            wait = 2 ** attempt
            logger.warning("[%s] Attempt %d/%d failed: %s. Retrying in %ds...", label, attempt, MAX_RETRIES, exc, wait)
            if attempt < MAX_RETRIES:
                time.sleep(wait)
            else:
                logger.error("[%s] All retries exhausted: %s", label, exc)
                return None
    return None


# the old name, kept so every caller keeps working
_call_groq = _call_llm


def warm_up() -> None:
    """Load the Ollama model into memory in the background, so the first question is not a 45 second wait."""
    if PROVIDER == "groq" or ai_unavailable_reason():
        return
    def _go():
        try:
            body = json.dumps({"model": OLLAMA_MODEL, "prompt": "", "keep_alive": "30m", "options": {"num_ctx": OLLAMA_CTX}}).encode()
            urllib.request.urlopen(urllib.request.Request(f"{OLLAMA_HOST}/api/generate", data=body, headers={"Content-Type": "application/json"}), timeout=OLLAMA_WAIT).read()
            logger.info("[Ollama] %s is loaded and ready.", OLLAMA_MODEL)
        except Exception as exc:
            logger.warning("[Ollama] Could not preload %s: %s", OLLAMA_MODEL, exc)
    import threading
    threading.Thread(target=_go, daemon=True, name="ollama-warmup").start()


def _repair_json_reply(text: str) -> str:
    """Small models often write a valid-looking JSON reply with raw line breaks inside the message, which JSON forbids.
    If the reply is an object, parse it leniently and write it back out as strict JSON the app can read."""
    t = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    if not t.startswith("{"):
        return text
    start, end = t.find("{"), t.rfind("}")
    if end <= start:
        return text
    try:
        obj = json.loads(t[start:end + 1], strict=False)
    except ValueError:
        return text
    return json.dumps(obj, ensure_ascii=False) if isinstance(obj, dict) else text


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
        # Data field: use sanitized version, capped at MAX_DATA_CHARS
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
        "Add citations [DB-ID:X] where it feels natural, don't force them for every line."
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
        return _ai_offline_text()

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
            f"({top.get('pct','?')}% of signal), {top.get('description','')}"
        )

    # For tier 3/4: build evidence bundle with related events
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
Keep it under 80 words, in short simple sentences. No *action text*. Sound like Luffy figuring it out. If the threat level is 1 or 2, keep it light and say plainly that it is probably nothing; do not make up a story.
"""

    result = _call_groq(
        messages=[
            {"role": "system", "content": _build_system_prompt()},
            {"role": "user",   "content": prompt},
        ],
        temperature=0.80,
        max_tokens=200,
    )
    return result or "Couldn't read that clue. The detective is offline, try again."


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
                         buildSystemPrompt(), gives Luffy awareness of the
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

    reply = _call_groq(messages, temperature=0.85, max_tokens=520)
    if reply:
        reply = _repair_json_reply(reply)
    if reply is None:
        why = ai_unavailable_reason()
        text = _ai_offline_text().replace("The AI detective", "My AI service")
        # Not stored in chat history: it isn't a real answer. The app falls back to
        # local commands (scan, filter, replay...) when ai_available is false.
        return {
            "reply":        json.dumps({"action": "NONE", "message": text, "mood": "alert"}),
            "mood":         "alert",
            "ai_available": False,
            "reason":       why or "unreachable",
        }

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