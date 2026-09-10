"""
log_collector.py
Collects Windows Event Logs and stores them in the forensic database.

UPGRADES vs previous version:
  - Real-time watcher via EvtSubscribe() — fires a callback the instant
    Windows writes a new event log entry. Alert latency: <1 second.
    Replaces the 60-second polling loop for live detection.
  - collect_logs() kept for manual/startup batch scans.
  - SHA-256 CHAINED integrity hash on every INSERT — each event hashes
    the previous event's hash so the full chain can be verified.
  - prev_hash stored alongside event_hash for chain-of-custody.
  - cluster_id and cluster_label stored as -1 / '' on INSERT;
    anomaly_detector.py fills them in after ML scoring.
  - Callbacks push scored events to a thread-safe queue read by main.py.

Cross-platform note: win32evtlog is Windows-only. On non-Windows systems
the collector prints a warning and returns 0 so the rest of the app still
runs (useful for development / demo mode on Linux/macOS).
"""

import json
import logging
import platform
import queue
import threading
import time
from datetime import datetime

from database import get_connection, get_last_event_hash
from integrity import compute_event_hash

logger = logging.getLogger(__name__)

# ── Real-time event queue ─────────────────────────────────────
# background_watcher() pushes newly inserted event IDs here.
# main.py's watchdog reads from it to trigger immediate scoring + alerts.
realtime_event_queue: queue.Queue = queue.Queue(maxsize=500)

# ── Watcher state ─────────────────────────────────────────────
_watcher_running  = False
_watcher_thread   = None
_watcher_lock     = threading.Lock()

SOURCES = [
    ("Security",    "AUDIT_FAILURE"),
    ("System",      "ERROR"),
    ("Application", "ERROR"),
]

TYPE_MAP = {
    1: "ERROR",
    2: "WARNING",
    3: "INFORMATION",
    4: "AUDIT_SUCCESS",
    5: "AUDIT_FAILURE",
}


# ─────────────────────────────────────────────────────────────
# SHARED HASH UTILITY
# ─────────────────────────────────────────────────────────────

def hash_event(data: str) -> str:
    """
    Simple SHA-256 of raw event string.
    Used for DEDUPLICATION — separate from the chained integrity hash.
    Kept as single source of truth; imported by demo_mode.py too.
    """
    import hashlib
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


# ─────────────────────────────────────────────────────────────
# EVENT PARSING
# ─────────────────────────────────────────────────────────────

def _parse_event_object(event, source_name: str) -> dict | None:
    """
    Parse a win32evtlog event object (old API) into a storable dict.
    Used by collect_logs() batch scanner.
    """
    try:
        event_id = event.EventID & 0xFFFF
        strings: list[str] = []
        try:
            if event.StringInserts:
                strings = [str(s) for s in event.StringInserts if s is not None]
        except Exception:
            pass

        raw = {
            "EventID":       event_id,
            "TimeGenerated": str(event.TimeGenerated),
            "SourceName":    str(event.SourceName)   if event.SourceName   else "Unknown",
            "EventType":     TYPE_MAP.get(event.EventType, "UNKNOWN"),
            "ComputerName":  str(event.ComputerName) if event.ComputerName else "Unknown",
            "Data":          " | ".join(strings[:3])[:500] if strings else "",
        }
        raw_str    = json.dumps(raw, ensure_ascii=False)
        dedup_hash = hash_event(raw_str)

        return {
            "timestamp":  str(event.TimeGenerated),
            "source":     source_name,
            "event_type": TYPE_MAP.get(event.EventType, "UNKNOWN"),
            "raw_data":   raw_str,
            "dedup_hash": dedup_hash,
        }
    except Exception as exc:
        logger.warning("[COLLECTOR] Failed to parse event from %s: %s", source_name, exc)
        return None


def _parse_evt_xml(xml_str: str, source_name: str) -> dict | None:
    """
    Parse an event rendered as XML by the new EvtRender API.
    EvtSubscribe returns events as XML strings — extract the key fields.
    Falls back gracefully if XML parsing fails.
    """
    try:
        import xml.etree.ElementTree as ET
        root = ET.fromstring(xml_str)
        ns   = {"e": "http://schemas.microsoft.com/win/2004/08/events/event"}

        # System block
        sys_el    = root.find("e:System", ns)
        event_id  = sys_el.findtext("e:EventID",    namespaces=ns) if sys_el else "0"
        computer  = sys_el.findtext("e:Computer",   namespaces=ns) if sys_el else "Unknown"
        time_str  = ""
        if sys_el is not None:
            tc = sys_el.find("e:TimeCreated", ns)
            if tc is not None:
                time_str = tc.get("SystemTime", "")[:19]

        level_map = {"0":"INFORMATION","1":"CRITICAL","2":"ERROR",
                     "3":"WARNING","4":"INFORMATION","5":"VERBOSE"}
        level_raw = sys_el.findtext("e:Level", namespaces=ns) if sys_el else "0"
        event_type = level_map.get(str(level_raw), "INFORMATION")

        # EventData block — extract all named/unnamed data fields
        ev_data = root.find("e:EventData", ns)
        data_fields: dict = {}
        if ev_data is not None:
            for item in ev_data:
                name  = item.get("Name", "Data")
                value = (item.text or "").strip()[:300]
                if value:
                    data_fields[name] = value

        raw = {
            "EventID":       int(event_id) if event_id.isdigit() else 0,
            "TimeGenerated": time_str or datetime.now().isoformat(),
            "SourceName":    source_name,
            "EventType":     event_type,
            "ComputerName":  computer,
            **data_fields,
        }
        raw_str    = json.dumps(raw, ensure_ascii=False)
        dedup_hash = hash_event(raw_str)

        return {
            "timestamp":  time_str or datetime.now().isoformat(),
            "source":     source_name,
            "event_type": event_type,
            "raw_data":   raw_str,
            "dedup_hash": dedup_hash,
        }

    except Exception as exc:
        logger.warning("[COLLECTOR] XML parse failed for %s: %s", source_name, exc)
        # Fallback: store raw XML with minimal metadata
        ts         = datetime.now().isoformat()
        raw_str    = json.dumps({"raw_xml": xml_str[:1000], "SourceName": source_name})
        dedup_hash = hash_event(raw_str)
        return {
            "timestamp":  ts,
            "source":     source_name,
            "event_type": "UNKNOWN",
            "raw_data":   raw_str,
            "dedup_hash": dedup_hash,
        }


# ─────────────────────────────────────────────────────────────
# CHAINED INSERT
# ─────────────────────────────────────────────────────────────

# Lock to serialise INSERTs so the chain is always sequential
# even when the real-time watcher fires multiple callbacks simultaneously.
_insert_lock = threading.Lock()


def _insert_event(parsed: dict) -> int | None:
    """
    Insert a parsed event into the database with:
      - Deduplication check (skip if dedup_hash already seen)
      - Chained SHA-256 integrity hash (event_hash + prev_hash)
      - cluster_id = -1, cluster_label = '' (filled by anomaly_detector)

    Returns the new row's DB id, or None if skipped/failed.
    """
    if not parsed or not parsed.get("dedup_hash"):
        return None

    with _insert_lock:
        try:
            conn   = get_connection()
            cursor = conn.cursor()

            # Deduplication
            cursor.execute(
                "SELECT id FROM events WHERE event_hash = ? LIMIT 1",
                (parsed["dedup_hash"],)
            )
            if cursor.fetchone():
                conn.close()
                return None  # already stored

            # Get previous hash for chain
            cursor.execute(
                "SELECT event_hash FROM events ORDER BY id DESC LIMIT 1"
            )
            prev_row  = cursor.fetchone()
            prev_hash = prev_row["event_hash"] if prev_row else ""

            # Compute chained integrity hash
            integrity_hash = compute_event_hash(
                raw_data  = parsed["raw_data"],
                timestamp = parsed["timestamp"],
                source    = parsed["source"],
                prev_hash = prev_hash,
            )

            cursor.execute("""
                INSERT INTO events
                    (timestamp, source, event_type, raw_data,
                     event_hash, prev_hash,
                     cluster_id, cluster_label)
                VALUES (?, ?, ?, ?, ?, ?, -1, '')
            """, (
                parsed["timestamp"],
                parsed["source"],
                parsed["event_type"],
                parsed["raw_data"],
                integrity_hash,
                prev_hash,
            ))

            new_id = cursor.lastrowid
            conn.commit()
            conn.close()
            return new_id

        except Exception as exc:
            logger.error("[COLLECTOR] Insert failed: %s", exc, exc_info=True)
            try:
                conn.close()
            except Exception:
                pass
            return None


# ─────────────────────────────────────────────────────────────
# REAL-TIME WATCHER (EvtSubscribe)
# ─────────────────────────────────────────────────────────────

def _make_evt_callback(source_name: str):
    """
    Returns a callback function for win32evtlog.EvtSubscribe().
    The callback fires the instant Windows writes a new event to the log.
    """
    import win32evtlog

    def callback(action, context, event_handle):
        """
        Called by Windows immediately when a new event is written.
        Runs in a Windows thread — must be fast and thread-safe.
        """
        try:
            if action != win32evtlog.EvtSubscribeActionDeliver:
                return

            # Render the event as XML (richest format, includes all fields)
            xml_str = win32evtlog.EvtRender(
                event_handle,
                win32evtlog.EvtRenderEventXml,
            )

            parsed = _parse_evt_xml(xml_str, source_name)
            if not parsed:
                return

            new_id = _insert_event(parsed)
            if new_id is not None:
                # Push to queue so main.py can immediately score + alert
                try:
                    realtime_event_queue.put_nowait(new_id)
                except queue.Full:
                    # Queue full — drop oldest to make room
                    try:
                        realtime_event_queue.get_nowait()
                        realtime_event_queue.put_nowait(new_id)
                    except queue.Empty:
                        pass

                logger.debug(
                    "[WATCHER] New event id=%d from %s inserted in real-time.",
                    new_id, source_name,
                )

        except Exception as exc:
            # Never let a callback exception crash the watcher thread
            logger.warning("[WATCHER] Callback error for %s: %s", source_name, exc)

    return callback


def start_realtime_watcher() -> bool:
    """
    Start the real-time Windows Event Log watcher using EvtSubscribe.

    Subscribes to Security, System, and Application logs.
    Each subscription fires a callback within milliseconds of a new entry.

    Returns True if started successfully, False if unavailable
    (non-Windows, missing pywin32, or insufficient privileges).
    """
    global _watcher_running, _watcher_thread

    with _watcher_lock:
        if _watcher_running:
            logger.info("[WATCHER] Already running — skipping duplicate start.")
            return True

    if platform.system() != "Windows":
        logger.info("[WATCHER] Non-Windows platform — real-time watcher not available.")
        return False

    try:
        import win32evtlog
    except ImportError:
        logger.error("[WATCHER] pywin32 not installed — real-time watcher unavailable.")
        return False

    def watcher_thread_fn():
        global _watcher_running
        subscriptions = []

        try:
            for source_name, _ in SOURCES:
                try:
                    callback = _make_evt_callback(source_name)
                    sub = win32evtlog.EvtSubscribe(
                        source_name,
                        win32evtlog.EvtSubscribeToFutureEvents,
                        Callback=callback,
                    )
                    subscriptions.append((source_name, sub))
                    logger.info(
                        "[WATCHER] Subscribed to %s log — real-time monitoring active.",
                        source_name,
                    )
                except Exception as exc:
                    # Security log requires Administrator — warn but continue
                    logger.warning(
                        "[WATCHER] Could not subscribe to %s: %s "
                        "(Security log requires Administrator privileges)",
                        source_name, exc,
                    )

            if not subscriptions:
                logger.error("[WATCHER] No log subscriptions succeeded — watcher inactive.")
                _watcher_running = False
                return

            logger.info(
                "[WATCHER] Real-time watcher active on %d log(s). "
                "Alert latency: <1 second.",
                len(subscriptions),
            )

            # Keep the thread alive — subscriptions are callback-driven
            # and stay active as long as this thread runs.
            while _watcher_running:
                time.sleep(1)

        except Exception as exc:
            logger.error("[WATCHER] Fatal watcher error: %s", exc, exc_info=True)
        finally:
            # Clean up subscriptions on exit
            for name, sub in subscriptions:
                try:
                    win32evtlog.EvtClose(sub)
                    logger.info("[WATCHER] Closed subscription to %s.", name)
                except Exception:
                    pass
            _watcher_running = False

    with _watcher_lock:
        _watcher_running = True
        _watcher_thread  = threading.Thread(
            target=watcher_thread_fn,
            name="EventLogWatcher",
            daemon=True,
        )
        _watcher_thread.start()

    logger.info("[WATCHER] Watcher thread started.")
    return True


def stop_realtime_watcher():
    """Signal the watcher thread to shut down cleanly."""
    global _watcher_running
    with _watcher_lock:
        _watcher_running = False
    logger.info("[WATCHER] Stop signal sent.")


def is_watcher_running() -> bool:
    return _watcher_running


# ─────────────────────────────────────────────────────────────
# BATCH COLLECTOR (kept for manual scans + startup backfill)
# ─────────────────────────────────────────────────────────────

def _get_existing_hashes(cursor) -> set:
    """Return all event_hash values already in the DB for deduplication."""
    cursor.execute("SELECT event_hash FROM events")
    return {row["event_hash"] for row in cursor.fetchall()}


def collect_logs(max_events: int = 100) -> int:
    """
    Read up to max_events from the Windows Event Log and insert only new ones.
    Uses the old OpenEventLog/ReadEventLog API for batch backfill.
    Returns the count of newly inserted events.

    Called by:
      - main.py /scan endpoint (manual scan)
      - Startup backfill before the real-time watcher takes over
      - Watchdog health-check every 60s (catches any missed events)
    """
    if platform.system() != "Windows":
        logger.info("[COLLECTOR] Non-Windows — skipping. Use /demo/inject for test events.")
        return 0

    try:
        import win32evtlog
        import win32evtlogutil  # noqa: F401
    except ImportError:
        logger.error("[COLLECTOR] pywin32 not installed.")
        return 0

    conn   = get_connection()
    cursor = conn.cursor()

    existing_hashes = _get_existing_hashes(cursor)
    conn.close()

    collected   = 0
    per_source  = max(1, max_events // len(SOURCES))
    to_insert   = []

    for log_type, _ in SOURCES:
        source_count = 0
        try:
            hand  = win32evtlog.OpenEventLog(None, log_type)
            flags = (win32evtlog.EVENTLOG_BACKWARDS_READ |
                     win32evtlog.EVENTLOG_SEQUENTIAL_READ)

            while source_count < per_source:
                try:
                    batch = win32evtlog.ReadEventLog(hand, flags, 0)
                except Exception as read_exc:
                    logger.warning("[COLLECTOR] Read error %s: %s", log_type, read_exc)
                    break

                if not batch:
                    break

                for event in batch:
                    parsed = _parse_event_object(event, log_type)
                    if not parsed:
                        continue
                    if not parsed.get("dedup_hash"):
                        continue
                    if parsed["dedup_hash"] in existing_hashes:
                        continue

                    to_insert.append(parsed)
                    existing_hashes.add(parsed["dedup_hash"])
                    source_count += 1

                    if source_count >= per_source:
                        break

            win32evtlog.CloseEventLog(hand)

        except Exception as exc:
            logger.warning("[COLLECTOR] Could not read %s: %s", log_type, exc)

    # Insert all collected events with chained integrity hashes
    for parsed in to_insert:
        new_id = _insert_event(parsed)
        if new_id is not None:
            collected += 1
            # Also push to realtime queue so scoring fires immediately
            try:
                realtime_event_queue.put_nowait(new_id)
            except queue.Full:
                pass

    logger.info(
        "[COLLECTOR] Batch: %d new events inserted (checked %d existing hashes).",
        collected, len(existing_hashes),
    )
    return collected


if __name__ == "__main__":
    n = collect_logs()
    print(f"Done — {n} events collected.")