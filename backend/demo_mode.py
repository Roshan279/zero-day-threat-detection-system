"""
demo_mode.py
Injects a synthetic multi-phase attack scenario into the database for
demonstration and testing purposes.

FIXES vs original:
  - Shared hash_event imported from log_collector (single source of truth).
  - inject_demo_attack() checks for existing demo hashes before inserting
    so calling /demo/inject twice never duplicates events.
  - Demo-event detection uses a JSON-parsed check instead of a LIKE string
    match, which is more robust and avoids false positives from log lines
    that happen to contain the substring '"demo": true'.
"""

import json
from datetime import datetime, timedelta

from database import get_connection
from integrity import dedup_hash_of, reseal_chain, verify_chain
from log_collector import _insert_event

ATTACKER_IP   = "192.168.1.47"
ATTACKER_USER = "rohan.admin"
TARGET_HOST   = "DESKTOP-FORENSIC"


def ts(minutes_ago: int) -> str:
    t = datetime.now() - timedelta(minutes=minutes_ago)
    return t.strftime("%Y-%m-%dT%H:%M:%S")


ATTACK_EVENTS = [
    # ── Phase 1: Brute Force ─────────────────────────────────
    {
        "source": "Security", "event_type": "AUDIT_FAILURE",
        "threat_tier": 3, "anomaly_score": 0.72,
        "raw": {
            "EventID": 4625, "SourceName": "Microsoft-Windows-Security-Auditing",
            "TimeGenerated": ts(45), "ComputerName": TARGET_HOST,
            "EventType": "AUDIT_FAILURE",
            "Data": f"Account: {ATTACKER_USER} | Failure: Wrong Password | IP: {ATTACKER_IP}",
            "demo": True, "phase": "Phase 1: Brute Force",
        },
    },
    {
        "source": "Security", "event_type": "AUDIT_FAILURE",
        "threat_tier": 3, "anomaly_score": 0.75,
        "raw": {
            "EventID": 4625, "SourceName": "Microsoft-Windows-Security-Auditing",
            "TimeGenerated": ts(44), "ComputerName": TARGET_HOST,
            "EventType": "AUDIT_FAILURE",
            "Data": f"Account: {ATTACKER_USER} | Failure: Wrong Password | IP: {ATTACKER_IP}",
            "demo": True, "phase": "Phase 1: Brute Force",
        },
    },
    {
        "source": "Security", "event_type": "AUDIT_FAILURE",
        "threat_tier": 4, "anomaly_score": 0.88,
        "raw": {
            "EventID": 4740, "SourceName": "Microsoft-Windows-Security-Auditing",
            "TimeGenerated": ts(42), "ComputerName": TARGET_HOST,
            "EventType": "AUDIT_FAILURE",
            "Data": f"Account locked out: {ATTACKER_USER} | Source IP: {ATTACKER_IP}",
            "demo": True, "phase": "Phase 1: Account Lockout",
        },
    },
    # ── Phase 2: Credential Access ───────────────────────────
    {
        "source": "Security", "event_type": "AUDIT_SUCCESS",
        "threat_tier": 4, "anomaly_score": 0.91,
        "raw": {
            "EventID": 4648, "SourceName": "Microsoft-Windows-Security-Auditing",
            "TimeGenerated": ts(38), "ComputerName": TARGET_HOST,
            "EventType": "AUDIT_SUCCESS",
            "Data": f"Explicit credential logon: {ATTACKER_USER} | Target: ADMIN$ | IP: {ATTACKER_IP}",
            "demo": True, "phase": "Phase 2: Credential Access",
        },
    },
    {
        "source": "Security", "event_type": "AUDIT_SUCCESS",
        "threat_tier": 4, "anomaly_score": 0.93,
        "raw": {
            "EventID": 5379, "SourceName": "Microsoft-Windows-Security-Auditing",
            "TimeGenerated": ts(37), "ComputerName": TARGET_HOST,
            "EventType": "AUDIT_SUCCESS",
            "Data": f"Credential read from manager | User: {ATTACKER_USER} | Target: SYSTEM credentials",
            "demo": True, "phase": "Phase 2: Credential Theft",
        },
    },
    # ── Phase 3: Privilege Escalation ────────────────────────
    {
        "source": "Security", "event_type": "AUDIT_SUCCESS",
        "threat_tier": 4, "anomaly_score": 0.95,
        "raw": {
            "EventID": 4720, "SourceName": "Microsoft-Windows-Security-Auditing",
            "TimeGenerated": ts(32), "ComputerName": TARGET_HOST,
            "EventType": "AUDIT_SUCCESS",
            "Data": f"New user account created: BACKDOOR_ADMIN | Created by: {ATTACKER_USER}",
            "demo": True, "phase": "Phase 3: Privilege Escalation",
        },
    },
    {
        "source": "Security", "event_type": "AUDIT_SUCCESS",
        "threat_tier": 4, "anomaly_score": 0.96,
        "raw": {
            "EventID": 4624, "SourceName": "Microsoft-Windows-Security-Auditing",
            "TimeGenerated": ts(30), "ComputerName": TARGET_HOST,
            "EventType": "AUDIT_SUCCESS",
            "Data": f"Logon: BACKDOOR_ADMIN | Type: Network | IP: {ATTACKER_IP} | Time: 03:14:00",
            "demo": True, "phase": "Phase 3: Backdoor Login",
        },
    },
    # ── Phase 4: Persistence ─────────────────────────────────
    {
        "source": "System", "event_type": "ERROR",
        "threat_tier": 4, "anomaly_score": 0.97,
        "raw": {
            "EventID": 7045, "SourceName": "Service Control Manager",
            "TimeGenerated": ts(25), "ComputerName": TARGET_HOST,
            "EventType": "ERROR",
            "Data": "New service: SVCHOST_BACKDOOR | Path: C:\\Windows\\Temp\\svc.exe | Account: LocalSystem",
            "demo": True, "phase": "Phase 4: Persistence",
        },
    },
    # ── Phase 5: Exfiltration ────────────────────────────────
    {
        "source": "Application", "event_type": "ERROR",
        "threat_tier": 4, "anomaly_score": 0.98,
        "raw": {
            "EventID": 1001, "SourceName": "RADAR_PRE_LEAK",
            "TimeGenerated": ts(18), "ComputerName": TARGET_HOST,
            "EventType": "ERROR",
            "Data": f"Large data transfer: 2.4GB | Destination: {ATTACKER_IP}:443 | Process: svc.exe",
            "demo": True, "phase": "Phase 5: Data Exfiltration",
        },
    },
    {
        "source": "Application", "event_type": "ERROR",
        "threat_tier": 4, "anomaly_score": 0.99,
        "raw": {
            "EventID": 1000, "SourceName": "RADAR_PRE_LEAK",
            "TimeGenerated": ts(15), "ComputerName": TARGET_HOST,
            "EventType": "ERROR",
            "Data": f"Exfiltration complete | Files compressed and sent | Destination: {ATTACKER_IP} | Volume: 2.4GB",
            "demo": True, "phase": "Phase 5: Data Exfiltration Complete",
        },
    },
]


def _is_demo_event(raw_data_str: str) -> bool:
    """
    Safely detect demo events by parsing the JSON rather than using a
    substring LIKE query.  Avoids false positives from real log lines that
    happen to contain the text '"demo": true'.
    """
    try:
        return json.loads(raw_data_str).get("demo") is True
    except (json.JSONDecodeError, TypeError):
        return False


def inject_demo_attack() -> int:
    """
    Insert demo attack events through the same chained insert as real events,
    so the integrity chain stays valid. Calling this twice never duplicates
    events: a demo event is skipped if one with the same EventID, phase and
    data already exists (timestamps change on every restart, so they are ignored).
    Returns the number of newly inserted events.
    """
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT raw_data FROM events")
    seen: set[tuple] = set()
    for row in cursor.fetchall():
        if _is_demo_event(row["raw_data"]):
            r = json.loads(row["raw_data"])
            seen.add((r.get("EventID"), r.get("phase"), r.get("Data")))
    conn.close()

    injected = 0
    for ev in ATTACK_EVENTS:
        key = (ev["raw"].get("EventID"), ev["raw"].get("phase"), ev["raw"].get("Data"))
        if key in seen:
            continue
        raw_str = json.dumps(ev["raw"], ensure_ascii=False)
        new_id = _insert_event({
            "timestamp":  ev["raw"]["TimeGenerated"],
            "source":     ev["source"],
            "event_type": ev["event_type"],
            "raw_data":   raw_str,
            "dedup_hash": dedup_hash_of(raw_str),
        }, anomaly_score=ev["anomaly_score"], threat_tier=ev["threat_tier"])
        if new_id is not None:
            seen.add(key)
            injected += 1
    return injected


def clear_demo_events() -> int:
    """
    Remove all demo events.
    Uses a two-step fetch-then-delete to avoid relying on a LIKE substring
    match, which can produce false positives on real log data.
    Returns number of deleted rows.
    """
    conn   = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT id, raw_data FROM events")
    demo_ids = [
        row["id"] for row in cursor.fetchall()
        if _is_demo_event(row["raw_data"])
    ]

    if not demo_ids:
        conn.close()
        return 0

    # Only repair the chain if it was intact before: removing rows leaves a gap
    # that we close by re-linking. A chain that was already broken stays broken.
    was_valid = verify_chain()["valid"]

    # Parameterised deletion: safe for any number of IDs
    placeholders = ",".join("?" * len(demo_ids))
    cursor.execute(f"DELETE FROM events WHERE id IN ({placeholders})", demo_ids)
    deleted = cursor.rowcount
    conn.commit()
    conn.close()

    if was_valid:
        reseal_chain()
    return deleted