"""
main.py: FastAPI application entry point.

UPGRADES vs previous version:
  - Real-time watchdog: reads from log_collector.realtime_event_queue
    instead of polling every 60s. New events are scored and alerted
    within <1 second of being written to the Windows Event Log.
    60s loop kept as a health-check backup.
  - start_realtime_watcher() called on startup: EvtSubscribe active.
  - load_models_on_startup() called on startup: no cold-start retrain.
  - backfill_hashes() called on startup: legacy events get integrity hashes.
  - check_and_warn_privileges() called on startup: warns if not Admin,
    forces DRY_RUN mode in response_executor automatically.
  - /integrity endpoint: SHA-256 chain verification report + UI badge.
  - /block-entity now calls response_executor.execute_block() for real
    Windows account disable + firewall IP block.
  - /unblock-entity endpoint added: reverses block actions.
  - /response-audit endpoint: immutable log of all block/unblock actions.
  - /chat updated: accepts full message history + system_override for
    Luffy's app-control command responses.
  - /watchdog now includes watcher_active and integrity_valid fields.
  - All previous fixes retained.
"""

import json
import logging
import platform
import threading
import time
from datetime import datetime

from typing import Optional
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from database import init_db, get_connection, prune_old_data
from integrity import verify_chain, backfill_hashes, get_event_integrity_status, migrate_integrity_scheme
from log_collector import (
    collect_logs,
    start_realtime_watcher,
    stop_realtime_watcher,
    is_watcher_running,
    realtime_event_queue,
)
from anomaly_detector import (
    run_anomaly_detection,
    score_single_event,
    load_models_on_startup,
    FEATURE_NAMES, FEATURE_LABELS, FEATURE_DESCRIPTIONS,
)
from detective import (
    generate_case_file, chat_with_detective,
    get_chat_history, analyze_single_event, warm_up,
)
from response_executor import (
    execute_block, execute_unblock,
    check_and_warn_privileges, get_audit_log, is_admin,
)
from report_generator import generate_report_pdf, generate_management_pdf
from scope import make_scope, scope_where
from demo_mode import inject_demo_attack, clear_demo_events

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Forensic Detective API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",   # any local dev port
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Startup sequence ──────────────────────────────────────────
init_db()

# Pre-load saved ML models so first real-time event scores instantly
load_models_on_startup()
warm_up()        # load the local AI model in the background

# Upgrade the hash chain to the current scheme (no-op once done)
try:
    resealed = migrate_integrity_scheme()
    if resealed:
        logger.warning("[Startup] Integrity chain re-sealed for %d events (scheme upgrade).", resealed)
except Exception as e:
    logger.warning("[Startup] Integrity scheme migration error (non-fatal): %s", e)

# Backfill integrity hashes for any legacy events (runs once, fast)
try:
    backfilled = backfill_hashes()
    if backfilled:
        logger.info("[Startup] Backfilled integrity hashes for %d legacy events.", backfilled)
except Exception as e:
    logger.warning("[Startup] Hash backfill error (non-fatal): %s", e)

# Check privileges and configure response executor
check_and_warn_privileges()

# Start real-time Windows Event Log watcher
start_realtime_watcher()

# ── Scan cooldown state ───────────────────────────────────────
_scan_lock        = threading.Lock()
_last_manual_scan = 0.0
SCAN_COOLDOWN_SECS = 30

# ── Integrity cache (avoid re-walking chain on every /watchdog poll) ──
_integrity_cache: dict = {"result": None, "computed_at": 0.0}
_INTEGRITY_CACHE_TTL   = 30.0  # seconds

# ── Watchdog / alert state ────────────────────────────────────
_alerts_lock   = threading.Lock()
watchdog_state = {
    "last_scan":  None,
    "new_alerts": [],
    "running":    True,
    "scan_count": 0,
}


# ─────────────────────────────────────────────────────────────
# REAL-TIME WATCHDOG THREAD
# ─────────────────────────────────────────────────────────────

def realtime_watchdog():
    """
    Drains the real-time event queue and scores each new event immediately.
    Alert latency: <1 second from Windows writing the log entry.
    Also runs a 60-second health-check scan to catch missed events.
    """
    logger.info("[Watchdog] Real-time watchdog started.")
    last_health_check = time.time()

    while watchdog_state["running"]:
        try:
            # Drain real-time queue
            while not realtime_event_queue.empty():
                try:
                    event_db_id = realtime_event_queue.get_nowait()
                    _score_and_alert_single(event_db_id)
                except Exception as q_err:
                    logger.debug("[Watchdog] Queue drain error: %s", q_err)
                    break

            # 60s health-check scan
            now = time.time()
            if now - last_health_check >= 60:
                last_health_check = now
                _run_health_check_scan()

        except Exception as exc:
            logger.error("[Watchdog] Unexpected error: %s", exc, exc_info=True)

        time.sleep(0.25)


ALERT_MAX_AGE_MINUTES = 30


def _is_recent(timestamp: str, minutes: int = ALERT_MAX_AGE_MINUTES) -> bool:
    """True if an event happened within the last `minutes`. Unparseable timestamps count as recent."""
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            ts = datetime.strptime((timestamp or "")[:19], fmt)
        except ValueError:
            continue
        return (datetime.now() - ts).total_seconds() <= minutes * 60
    return True


def _score_and_alert_single(event_db_id: int):
    """Score a single new event and alert if tier >= 3."""
    try:
        conn   = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM events WHERE id = ?", (event_db_id,))
        row = cursor.fetchone()
        conn.close()

        if not row:
            return

        event  = dict(row)
        result = score_single_event(event)

        conn   = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE events
            SET anomaly_score = ?, threat_tier = ?,
                cluster_id = ?, cluster_label = ?
            WHERE id = ?
        """, (
            result["anomaly_score"],
            result["threat_tier"],
            result["cluster_id"],
            result["cluster_label"],
            event_db_id,
        ))
        conn.commit()
        conn.close()

        # Only alert for events that just happened. Older ones (an imported backlog) are scored and
        # stored, but they are history, not an incident in progress.
        if result["threat_tier"] >= 3 and _is_recent(event.get("timestamp", "")):
            event["anomaly_score"] = result["anomaly_score"]
            event["threat_tier"]   = result["threat_tier"]
            with _alerts_lock:
                watchdog_state["new_alerts"].append(event)
                watchdog_state["new_alerts"].sort(
                    key=lambda e: -e.get("anomaly_score", 0)
                )
                watchdog_state["new_alerts"] = watchdog_state["new_alerts"][:5]

            logger.info(
                "[Watchdog] REAL-TIME ALERT: event id=%d tier=%d score=%.2f",
                event_db_id, result["threat_tier"], result["anomaly_score"],
            )

        watchdog_state["last_scan"] = datetime.now().isoformat()

    except Exception as exc:
        logger.error("[Watchdog] Single-event scoring error (id=%d): %s",
                     event_db_id, exc)


def _run_health_check_scan():
    """60-second backup scan to catch anything the real-time watcher missed."""
    try:
        conn   = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT MAX(id) as max_id FROM events")
        row           = cursor.fetchone()
        max_id_before = row["max_id"] or 0
        conn.close()

        collected = collect_logs(max_events=50, max_age_minutes=10)   # recent misses only, never old history
        if collected > 0:
            run_anomaly_detection()

        conn   = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT * FROM events
            WHERE id > ? AND threat_tier >= 3
            ORDER BY anomaly_score DESC LIMIT 5
        """, (max_id_before,))
        new_high = [dict(e) for e in cursor.fetchall() if _is_recent(e["timestamp"])]
        conn.close()

        with _alerts_lock:
            if new_high:
                watchdog_state["new_alerts"] = new_high[:5]

        watchdog_state["scan_count"] += 1

        if watchdog_state["scan_count"] % 10 == 0:
            pruned = prune_old_data()
            logger.info("[Watchdog] DB pruned: %d rows removed.", pruned)

        logger.info(
            "[Watchdog] Health-check #%d: %d events collected.",
            watchdog_state["scan_count"], collected,
        )

    except Exception as exc:
        logger.error("[Watchdog] Health-check error: %s", exc, exc_info=True)


threading.Thread(
    target=realtime_watchdog, daemon=True, name="RealtimeWatchdog"
).start()


# ─────────────────────────────────────────────────────────────
# REQUEST MODELS
# ─────────────────────────────────────────────────────────────

class ChatMessage(BaseModel):
    message:  str | None = None
    messages: list | None = None
    system:   str | None = None

class EventAnalysisRequest(BaseModel):
    event_id: int
    event: Optional[dict] = None     # Demo data: the event itself, because it is not in the database

class BlockEntityRequest(BaseModel):
    entity:       str
    entity_type:  str  = "auto"
    reason:       str  = ""
    threat_tier:  int  = 0
    event_db_id:  int | None = None
    triggered_by: str  = "luffy"
    dry_run:      bool = False

class UnblockEntityRequest(BaseModel):
    entity:       str
    entity_type:  str  = "auto"
    triggered_by: str  = "luffy"
    dry_run:      bool = False


# ─────────────────────────────────────────────────────────────
# CORE ENDPOINTS
# ─────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {
        "status":         "Detective Luffy is on the case.",
        "watchdog":       "running",
        "watcher_active": is_watcher_running(),
        "is_admin":       is_admin(),
        "scans":          watchdog_state["scan_count"],
    }


@app.get("/events")
def get_events(
    tier: Optional[int] = Query(default=None, ge=1, le=4),
    cluster: Optional[str] = None, entity: Optional[str] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=1000),
):
    # With no filters this is exactly the old behaviour: the 100 highest-scoring events.
    where, params = scope_where(make_scope(tier, cluster, entity, start, end))
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute(f"SELECT * FROM events{where} ORDER BY anomaly_score DESC LIMIT ?", params + [limit])
    events = [dict(e) for e in cursor.fetchall()]
    cursor.execute(f"SELECT COUNT(*) AS n FROM events{where}", params)
    total = cursor.fetchone()["n"]          # how many match in all, even if `limit` cut the list short
    conn.close()
    return {"events": events, "total": total}


@app.get("/stats")
def get_stats():
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT threat_tier, COUNT(*) as c FROM events GROUP BY threat_tier")
    tiers = {str(r["threat_tier"]): r["c"] for r in cursor.fetchall()}
    cursor.execute("SELECT COUNT(*) as n FROM events")
    total = cursor.fetchone()["n"]
    cursor.execute("SELECT AVG(anomaly_score) as a FROM events")
    avg   = cursor.fetchone()["a"] or 0
    cursor.execute("SELECT raw_data FROM events ORDER BY anomaly_score DESC LIMIT 100")
    rows  = cursor.fetchall()
    conn.close()

    behaviors: dict[str, int] = {}
    for r in rows:
        try:
            bl = json.loads(r["raw_data"]).get("behavior_label", "Unknown Pattern")
            behaviors[bl] = behaviors.get(bl, 0) + 1
        except (json.JSONDecodeError, TypeError):
            pass

    return {
        "total_events":     total,
        "avg_threat_score": round(avg, 2),
        "tiers":            tiers,
        "behaviors":        behaviors,
        "last_auto_scan":   watchdog_state["last_scan"],
        "auto_scan_count":  watchdog_state["scan_count"],
        "watcher_active":   is_watcher_running(),
    }


@app.get("/casefile")
def get_case_file():
    narrative  = generate_case_file()
    confidence = _compute_confidence()
    return {"narrative": narrative, "confidence": confidence}


@app.get("/casefile/latest")
def get_latest_case_file():
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM case_files ORDER BY created_at DESC LIMIT 1")
    row    = cursor.fetchone()
    conn.close()
    if row:
        d = dict(row)
        d["confidence"] = _compute_confidence()
        return d
    return {"narrative": "No case files yet.", "confidence": 0}


def _compute_confidence() -> float:
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT anomaly_score, threat_tier FROM events "
        "ORDER BY anomaly_score DESC LIMIT 20"
    )
    rows = cursor.fetchall()
    conn.close()
    if not rows:
        return 0.0
    scores = [r["anomaly_score"] for r in rows]
    tiers  = [r["threat_tier"]   for r in rows]
    avg_s  = sum(scores) / len(scores)
    h_pct  = sum(1 for t in tiers if t >= 3) / len(tiers)
    return round(min(0.99, avg_s * 0.6 + h_pct * 0.4), 2)


# ─────────────────────────────────────────────────────────────
# CHAT
# ─────────────────────────────────────────────────────────────

@app.post("/chat")
def chat(msg: ChatMessage):
    if msg.messages:
        last_user = next(
            (m.get("content") or m.get("message", "")
             for m in reversed(msg.messages)
             if m.get("role") == "user"),
            "",
        )
        history = [
            {"role": m.get("role", "user"),
             "message": m.get("content") or m.get("message", "")}
            for m in msg.messages[:-1]
        ]
        return chat_with_detective(last_user, history, msg.system)
    return chat_with_detective(msg.message or "", get_chat_history())


@app.get("/chat/history")
def chat_history():
    return {"history": get_chat_history()}


@app.post("/analyze-event")
def analyze_event(req: EventAnalysisRequest):
    if req.event:
        event = dict(req.event)
    else:
        conn   = get_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM events WHERE id = ?", (req.event_id,))
        row    = cursor.fetchone()
        conn.close()
        if not row:
            return {"narrative": "Can't find that clue.", "mood": "idle"}
        event     = dict(row)
    narrative = analyze_single_event(event)
    tier      = event.get("threat_tier", 1)
    mood = (
        "angry"    if tier >= 4 else
        "alert"    if tier >= 3 else
        "thinking" if tier >= 2 else
        "idle"
    )
    return {"narrative": narrative, "mood": mood}


# ─────────────────────────────────────────────────────────────
# SCAN
# ─────────────────────────────────────────────────────────────

@app.post("/scan")
def run_scan():
    global _last_manual_scan
    now = time.time()

    with _scan_lock:
        elapsed = now - _last_manual_scan
        if elapsed < SCAN_COOLDOWN_SECS:
            remaining = int(SCAN_COOLDOWN_SECS - elapsed)
            return {
                "message":   f"Scan cooldown: wait {remaining}s.",
                "collected": 0,
                "cooldown":  True,
            }
        _last_manual_scan = now

    collected = collect_logs(max_events=100)
    run_anomaly_detection()
    _integrity_cache["result"] = None  # invalidate after new events
    return {"message": f"Scan complete. {collected} events.", "collected": collected}


# ─────────────────────────────────────────────────────────────
# WATCHDOG POLL
# ─────────────────────────────────────────────────────────────

@app.get("/watchdog")
def watchdog():
    with _alerts_lock:
        alerts = list(watchdog_state["new_alerts"])
        watchdog_state["new_alerts"] = []

    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT MAX(threat_tier) as m FROM events")
    max_tier = cursor.fetchone()["m"] or 1
    conn.close()

    return {
        "new_critical_events": alerts,
        "has_alerts":          bool(alerts),
        "max_tier":            max_tier,
        "alert_count":         len(alerts),
        "last_auto_scan":      watchdog_state["last_scan"],
        "scan_count":          watchdog_state["scan_count"],
        "watcher_active":      is_watcher_running(),
        "is_admin":            is_admin(),
    }


# ─────────────────────────────────────────────────────────────
# INTEGRITY
# ─────────────────────────────────────────────────────────────

@app.get("/integrity")
def get_integrity():
    global _integrity_cache
    now = time.time()

    if (
        _integrity_cache["result"] is not None
        and now - _integrity_cache["computed_at"] < _INTEGRITY_CACHE_TTL
    ):
        return _integrity_cache["result"]

    result = verify_chain()
    _integrity_cache = {"result": result, "computed_at": now}
    return result


@app.get("/integrity/event/{event_id}")
def get_event_integrity(event_id: int):
    return get_event_integrity_status(event_id)


# ─────────────────────────────────────────────────────────────
# ACTIVE RESPONSE
# ─────────────────────────────────────────────────────────────

@app.post("/block-entity")
def block_entity(req: BlockEntityRequest):
    _integrity_cache["result"] = None
    return execute_block(
        entity       = req.entity,
        entity_type  = req.entity_type,
        reason       = req.reason,
        threat_tier  = req.threat_tier,
        event_db_id  = req.event_db_id,
        triggered_by = req.triggered_by,
        dry_run      = req.dry_run,
    )


@app.post("/unblock-entity")
def unblock_entity(req: UnblockEntityRequest):
    return execute_unblock(
        entity       = req.entity,
        entity_type  = req.entity_type,
        triggered_by = req.triggered_by,
        dry_run      = req.dry_run,
    )


@app.get("/blocked-entities")
def get_blocked_entities():
    try:
        conn   = get_connection()
        cursor = conn.cursor()
        cursor.execute(
            "SELECT * FROM flagged_entities ORDER BY flagged_at DESC"
        )
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return {"blocked": rows, "count": len(rows)}
    except Exception as e:
        logger.error("/blocked-entities error: %s", e)
        return {"blocked": [], "count": 0}


@app.get("/response-audit")
def get_response_audit(limit: int = Query(default=50, ge=1, le=500)):
    return {"audit": get_audit_log(limit), "is_admin": is_admin()}


# ─────────────────────────────────────────────────────────────
# FEATURE IMPORTANCE
# ─────────────────────────────────────────────────────────────

@app.get("/feature-importance")
def feature_importance():
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM events ORDER BY anomaly_score DESC LIMIT 30")
    events = [dict(e) for e in cursor.fetchall()]
    conn.close()

    per_event: list       = []
    agg: dict[str, float] = {n: 0.0 for n in FEATURE_NAMES}
    count                 = 0

    for e in events:
        raw = {}
        try:
            raw = json.loads(e["raw_data"])
        except (json.JSONDecodeError, TypeError):
            pass
        fi = raw.get("feature_importance", [])
        if fi:
            per_event.append({
                "event_db_id":   e["id"],
                "event_id":      raw.get("EventID"),
                "anomaly_score": round(e["anomaly_score"] * 100),
                "tier":          e["threat_tier"],
                "timestamp":     e.get("timestamp", "")[:19],
                "features":      fi,
            })
            for f in fi:
                agg[f["feature"]] = agg.get(f["feature"], 0) + f["pct"]
            count += 1

    if count:
        total_agg = sum(agg.values())
        aggregate = [
            {
                "feature":     n,
                "label":       FEATURE_LABELS[n],
                "description": FEATURE_DESCRIPTIONS[n],
                "avg_pct":     round(agg[n] / count, 1),
                "share_pct":   round(agg[n] / total_agg * 100, 1) if total_agg else 0,
            }
            for n in FEATURE_NAMES
        ]
        aggregate.sort(key=lambda x: -x["avg_pct"])
    else:
        aggregate = []

    return {
        "per_event":            per_event,
        "aggregate":            aggregate,
        "feature_labels":       FEATURE_LABELS,
        "feature_descriptions": FEATURE_DESCRIPTIONS,
    }


# ─────────────────────────────────────────────────────────────
# RESPONSE SIMULATION
# ─────────────────────────────────────────────────────────────

RESPONSE_RULES = {
    1: {
        "tier": 1, "label": "LOG ONLY", "color": "#4ade80",
        "action": "Passive monitoring. Event recorded to forensic log.",
        "system_action": None, "analyst_action": "No immediate action required.",
        "latency": "Background", "automation": "Fully automated",
        "spec_tier": "Tier 1 (<60% confidence)",
    },
    2: {
        "tier": 2, "label": "ALERT ANALYST", "color": "#facc15",
        "action": "Advisory alert sent to security analyst for review.",
        "system_action": "Increase monitoring frequency for this entity.",
        "analyst_action": "Review flagged events within 4 hours.",
        "latency": "<30 seconds", "automation": "Alert automated: response is manual",
        "spec_tier": "Tier 2 (60 to 85% confidence)",
    },
    3: {
        "tier": 3, "label": "CONDITIONAL RESPONSE", "color": "#fb923c",
        "action": "Temporary account suspension or IP block pending analyst review.",
        "system_action": "Suspend user account or block source IP for 15 minutes.",
        "analyst_action": "Confirm or override within 15 minutes. Document in SIEM.",
        "latency": "<5 seconds", "automation": "Automated: human override available",
        "spec_tier": "Tier 3 (>85% confidence)",
    },
    4: {
        "tier": 4, "label": "FULL ISOLATION", "color": "#f87171",
        "action": "CRITICAL: Full system isolation. Requires human authorisation.",
        "system_action": "Flag for emergency isolation. All lateral movement blocked.",
        "analyst_action": "IMMEDIATE: Escalate to CISO. Initiate incident response plan.",
        "latency": "Immediate", "automation": "Human authorisation required",
        "spec_tier": "Tier 4 (Manual: human only)",
    },
}


@app.get("/response-simulation")
def response_simulation():
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM events ORDER BY anomaly_score DESC LIMIT 50")
    events = [dict(e) for e in cursor.fetchall()]
    conn.close()

    simulated:    list           = []
    tier_summary: dict[int, int] = {1: 0, 2: 0, 3: 0, 4: 0}

    for e in events:
        raw = {}
        try:
            raw = json.loads(e["raw_data"])
        except (json.JSONDecodeError, TypeError):
            pass

        tier = e.get("threat_tier", 1)
        simulated.append({
            "event_db_id":   e["id"],
            "event_id":      raw.get("EventID"),
            "timestamp":     (raw.get("TimeGenerated") or e.get("timestamp", ""))[:19],
            "source":        e.get("source", "?"),
            "anomaly_score": round(e["anomaly_score"] * 100),
            "tier":          tier,
            "phase":         raw.get("phase"),
            "cluster_label": e.get("cluster_label", ""),
            "is_demo":       raw.get("demo", False),
            "response":      RESPONSE_RULES.get(tier, RESPONSE_RULES[1]),
        })
        tier_summary[tier] = tier_summary.get(tier, 0) + 1

    return {
        "simulated_responses": simulated,
        "tier_summary":        tier_summary,
        "response_rules":      RESPONSE_RULES,
        "spec_note": "Actions per original platform spec Layer 6A autonomy tiers",
    }


# ─────────────────────────────────────────────────────────────
# ENTITY CORRELATION
# ─────────────────────────────────────────────────────────────

@app.get("/entities")
def get_entities(limit: int = Query(default=100, ge=10, le=1000)):
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM events ORDER BY timestamp ASC LIMIT ?", (limit,)
    )
    events = [dict(e) for e in cursor.fetchall()]
    conn.close()

    entity_map: dict = {}
    for e in events:
        raw = {}
        try:
            raw = json.loads(e["raw_data"])
        except (json.JSONDecodeError, TypeError):
            pass

        key     = raw.get("SourceName") or e.get("source", "Unknown")
        eid     = raw.get("EventID")
        phase   = raw.get("phase")
        behav   = raw.get("behavior_label", "Unknown Pattern")
        cluster = e.get("cluster_label", raw.get("behavior_label", ""))

        if key not in entity_map:
            entity_map[key] = {
                "entity":      key,
                "computer":    raw.get("ComputerName", "Unknown"),
                "event_count": 0,
                "max_tier":    0,
                "total_score": 0.0,
                "event_ids":   [],
                "phases":      [],
                "behaviors":   [],
                "clusters":    [],
                "events":      [],
                "first_seen":  e.get("timestamp", ""),
                "last_seen":   e.get("timestamp", ""),
            }

        em = entity_map[key]
        em["event_count"]  += 1
        em["max_tier"]      = max(em["max_tier"], e.get("threat_tier", 1))
        em["total_score"]  += e.get("anomaly_score", 0)
        em["last_seen"]     = e.get("timestamp", "")

        if eid    and eid    not in em["event_ids"]:  em["event_ids"].append(eid)
        if phase  and phase  not in em["phases"]:     em["phases"].append(phase)
        if behav  and behav  not in em["behaviors"]:  em["behaviors"].append(behav)
        if cluster and cluster not in em["clusters"]: em["clusters"].append(cluster)

        em["events"].append({
            "id":         e["id"],
            "timestamp":  e.get("timestamp", ""),
            "event_id":   eid,
            "tier":       e.get("threat_tier", 1),
            "score":      round(e.get("anomaly_score", 0) * 100),
            "phase":      phase,
            "cluster":    cluster,
            "event_hash": e.get("event_hash", ""),
        })

    result = []
    for v in entity_map.values():
        v["avg_score"] = (
            round(v["total_score"] / v["event_count"] * 100)
            if v["event_count"] else 0
        )
        v["events"] = v["events"][-10:]
        result.append(v)

    result.sort(key=lambda x: (-x["max_tier"], -x["avg_score"]))
    return {"entities": result}


# ─────────────────────────────────────────────────────────────
# REPLAY DETAIL
# ─────────────────────────────────────────────────────────────

@app.get("/replay-detail/{event_id}")
def get_replay_detail(event_id: int):
    """Enriched forensic detail for a single replay step."""
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM events WHERE id = ?", (event_id,))
    row = cursor.fetchone()
    conn.close()

    if not row:
        return {"error": "Event not found"}

    event = dict(row)
    raw   = {}
    try:
        raw = json.loads(event.get("raw_data", "{}"))
    except (json.JSONDecodeError, TypeError):
        pass

    eid       = raw.get("EventID", 0)
    integrity = get_event_integrity_status(event_id)

    return {
        "event":            event,
        "raw":              raw,
        "integrity":        integrity,
        "cluster_label":    event.get("cluster_label", raw.get("behavior_label", "")),
        "windows_response": _get_windows_response_context(eid),
        "missed_control":   _get_missed_control(eid, event.get("threat_tier", 1)),
        "significance":     _get_forensic_significance(event, raw),
        "event_hash_short": (
            (event.get("event_hash") or "")[:16] + "…"
            if event.get("event_hash") else "NO HASH"
        ),
    }


def _get_windows_response_context(event_id: int) -> str:
    if platform.system() != "Windows":
        posix = {
            4625: "The system logged a failed authentication attempt (PAM/sshd).",
            4624: "The system opened a new login session and granted access.",
            4740: "The account was locked after too many failed attempts (pam_faillock).",
            4648: "A user ran a command as another account via sudo/su.",
            4672: "A session was opened for root, full administrative privileges.",
            4720: "A new local user account was created (useradd / sysadminctl).",
            4726: "A local user account was deleted (userdel).",
            4732: "A user was added to a group, check for sudo/wheel/admin membership.",
            4733: "A user was removed from a group.",
            4738: "An account's password or settings were changed.",
            7045: "A new service/unit was installed or enabled (systemd / launchd).",
            7040: "A service/unit was disabled, masked or removed.",
            7034: "A service crashed or was killed unexpectedly.",
            1102: "The system logs were cleared or truncated, this entry may be the only remaining evidence.",
            1100: "The logging service was stopped: logs may be incomplete from this point.",
            4698: "A cron/at/timer job was created or edited.",
            4719: "The audit configuration was changed or the audit daemon stopped.",
            5157: "The firewall dropped a connection.",
        }
        return posix.get(event_id, f"The system logged event {event_id}.")
    ctx = {
        4625: "Windows logged a failed logon and incremented the bad-password counter.",
        4624: "Windows created a new logon session and granted access.",
        4740: "Windows automatically locked the account after too many failed attempts.",
        4648: "Windows logged an explicit credential use, credentials provided directly.",
        4672: "Windows assigned special privileges including SeDebugPrivilege.",
        4720: "Windows created a new user account in the local SAM database.",
        4726: "Windows deleted a user account: the account no longer exists.",
        7045: "Windows registered a new service in the Service Control Manager.",
        7040: "Windows updated the start type for an existing service.",
        1102: "Windows cleared the Security event log, this entry is the only remaining evidence.",
        4698: "Windows registered a new scheduled task in Task Scheduler.",
        5379: "Windows Credential Manager was accessed: the credential vault was read.",
        4688: "Windows created a new process and assigned it a security token.",
    }
    return ctx.get(event_id, f"Windows logged Event ID {event_id} to the event log.")


def _get_missed_control(event_id: int, tier: int) -> str:
    controls = {
        4625: "Account lockout policy should trigger after 3 to 5 failures. If unconfigured, brute force is unlimited.",
        4740: "Account lockout IS working: but the threshold may be too high.",
        4648: "Multi-factor authentication prevents credential reuse even if the password is known.",
        4672: "Least-privilege policy should restrict who receives special privileges.",
        4720: "User account creation should require approval and SIEM monitoring.",
        4726: "Account deletion should trigger an alert, attackers delete accounts to cover tracks.",
        7045: "Application whitelisting (AppLocker/WDAC) blocks unauthorised service installation.",
        1102: "Log forwarding to external SIEM means local log clearing doesn't destroy evidence.",
        4698: "Scheduled task creation should be restricted and monitored.",
        5379: "Credential Guard protects the credential vault from userspace access.",
        4688: "Process creation auditing with command-line logging reveals what was executed.",
    }
    base = controls.get(event_id, "Review detection rules for this event type.")
    return f"MISSED CONTROL: {base}" if tier >= 3 else base


def _get_forensic_significance(event: dict, raw: dict) -> str:
    eid   = raw.get("EventID", 0)
    tier  = event.get("threat_tier", 1)
    score = round((event.get("anomaly_score") or 0) * 100)
    ts    = event.get("timestamp", "")
    hour  = 12
    try:
        hour = datetime.fromisoformat(ts.replace("T", " ").split(".")[0]).hour
    except Exception:
        pass
    time_note = " Outside business hours: higher suspicion." if (hour >= 22 or hour <= 5) else ""
    base = {
        4625: f"Failed login. Score {score}%: check for a sequence of failures.{time_note}",
        4624: f"Successful login. Score {score}%: verify expected access.{time_note}",
        4740: f"Account locked out: confirms repeated failed attempts occurred.{time_note}",
        7045: f"New service. Score {score}%: malware commonly persists as a service.{time_note}",
        1102: f"Audit log cleared. Almost always malicious, standard is to never clear logs.{time_note}",
        4672: f"Privileged logon. Score {score}%: verify the account legitimately holds these privileges.{time_note}",
    }
    return base.get(eid, f"Event ID {eid} scored {score}% anomaly.{time_note}")


# ─────────────────────────────────────────────────────────────
# PDF REPORTS
# ─────────────────────────────────────────────────────────────

@app.get("/report/pdf")
def download_technical(
    tier: Optional[int] = Query(default=None, ge=1, le=4), cluster: Optional[str] = None,
    entity: Optional[str] = None, start: Optional[str] = None, end: Optional[str] = None,
):
    pdf  = generate_report_pdf(make_scope(tier, cluster, entity, start, end))
    name = f"forensic_technical_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={name}"},
    )


class ReportBody(BaseModel):
    events: list[dict]
    scope: dict = {}


# The same two reports, built from a list of events sent in the request. The app uses this for Demo data, whose
# events do not exist in the database. Nothing is stored.
@app.post("/report/pdf")
def technical_from_events(body: ReportBody):
    pdf = generate_report_pdf(body.scope, body.events)
    return Response(content=pdf, media_type="application/pdf", headers={"Content-Disposition": "inline; filename=demo_technical.pdf"})


@app.post("/report/management")
def management_from_events(body: ReportBody):
    pdf = generate_management_pdf(body.scope, body.events)
    return Response(content=pdf, media_type="application/pdf", headers={"Content-Disposition": "inline; filename=demo_management.pdf"})


@app.get("/report/management")
def download_management(
    tier: Optional[int] = Query(default=None, ge=1, le=4), cluster: Optional[str] = None,
    entity: Optional[str] = None, start: Optional[str] = None, end: Optional[str] = None,
):
    pdf  = generate_management_pdf(make_scope(tier, cluster, entity, start, end))
    name = f"forensic_management_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename={name}"},
    )


# ─────────────────────────────────────────────────────────────
# DEMO
# ─────────────────────────────────────────────────────────────

@app.post("/demo/inject")
def demo_inject():
    n = inject_demo_attack()
    if n > 0:
        run_anomaly_detection()
        _integrity_cache["result"] = None
    return {"message": f"Demo injected: {n} new events across 5 phases", "injected": n}


@app.post("/demo/clear")
def demo_clear():
    n = clear_demo_events()
    _integrity_cache["result"] = None
    return {"message": f"Cleared {n} demo events", "cleared": n}


# ─────────────────────────────────────────────────────────────
# SHUTDOWN
# ─────────────────────────────────────────────────────────────

@app.on_event("shutdown")
def shutdown_event():
    watchdog_state["running"] = False
    stop_realtime_watcher()
    logger.info("[Shutdown] Watchdog and watcher stopped.")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)