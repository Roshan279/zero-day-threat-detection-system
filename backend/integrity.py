"""
integrity.py
Forensic chain-of-custody via SHA-256 chained hashing.

HOW THE CHAIN WORKS:
  event_hash = SHA-256(raw_data + timestamp + source + prev_hash)

  Each event's hash depends on the previous event's hash: exactly
  like a blockchain. This means:
    - Modifying ANY event invalidates every hash after it
    - Deleting an event breaks the chain (missing link)
    - Reordering events breaks the chain (wrong prev_hash)

  This is stronger than simple per-event hashing, which only proves
  an individual record wasn't modified: it cannot detect deletions
  or reordering.

USAGE:
  # Called by log_collector.py on every new event INSERT:
  from integrity import compute_event_hash
  h = compute_event_hash(raw_data, timestamp, source, prev_hash)

  # Called by main.py /integrity endpoint:
  from integrity import verify_chain, compute_event_hash
  report = verify_chain()
"""

import hashlib
import json
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


# ── Evidence vs analysis ──────────────────────────────────────
# raw_data holds the original log record, but anomaly_detector.py later adds its
# own analysis (cluster, feature importance, scores, hashes) to the same JSON.
# The integrity chain must only cover the ORIGINAL evidence, otherwise scoring an
# event would break its hash. These keys are analysis output and are excluded.
ANALYSIS_KEYS = frozenset({
    "cluster_id", "behavior", "behavior_label", "feature_importance",
    "if_score", "baseline_score", "raw_hash", "normalized_hash", "combined_hash",
})

# Bump when the hashing rules change; migrate_integrity_scheme() re-seals the chain once.
INTEGRITY_SCHEME = "3"


def evidence_string(raw_data: str) -> str:
    """Canonical form of the original evidence in a raw_data JSON string."""
    try:
        obj = json.loads(raw_data)
    except (TypeError, ValueError):
        return raw_data or ""
    if not isinstance(obj, dict):
        return raw_data or ""
    kept = {k: v for k, v in obj.items() if k not in ANALYSIS_KEYS}
    return json.dumps(kept, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def utc_to_local(utc_text: str) -> str:
    """
    "2026-10-23T05:18:22.1234567Z" (UTC, as Windows XML events report it) ->
    "2026-10-23 10:48:22" (local time, the format every collector stores).
    Returns "" if the text can't be parsed.
    """
    try:
        dt = datetime.strptime(utc_text[:19].replace("T", " "), "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return ""
    return dt.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")


def dedup_hash_of(raw_data: str) -> str:
    """Stable identity of an event's evidence, used to skip events we already stored."""
    return hashlib.sha256(evidence_string(raw_data).encode("utf-8")).hexdigest()


# ── Hash computation ──────────────────────────────────────────

def compute_event_hash(
    raw_data:  str,
    timestamp: str,
    source:    str,
    prev_hash: str = "",
) -> str:
    """
    Compute the SHA-256 hash for a single event.

    The hash is computed over the concatenation of:
      evidence(raw_data) + | + timestamp + | + source + | + prev_hash
    where evidence() drops analysis fields added later by the scorer.

    The pipe separator prevents field-boundary collisions
    (e.g. raw="ab" ts="c" is distinct from raw="a" ts="bc").

    Args:
        raw_data:  The raw JSON string of the event.
        timestamp: The event timestamp string.
        source:    The event source (e.g. "Security", "System").
        prev_hash: The hash of the immediately preceding event.
                   Empty string for the very first event (genesis).

    Returns:
        64-character lowercase hex SHA-256 digest.
    """
    content = f"{evidence_string(raw_data)}|{timestamp}|{source}|{prev_hash}"
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def compute_genesis_hash() -> str:
    """
    Returns the hash for an imaginary 'block zero', used as
    prev_hash for the very first event in the database.
    Deterministic so it's always the same value.
    """
    return hashlib.sha256(b"forensic_detective_genesis_block_v1").hexdigest()


# ── Chain verification ────────────────────────────────────────

def verify_chain() -> dict:
    """
    Walk every event in insertion order and verify the hash chain.

    Returns a dict with:
      valid          bool  : True if chain is fully intact
      total          int   : Total events checked
      corrupted      list  : List of {id, reason} for broken links
      first_break    int|None: DB id of first broken event
      chain_length   int   : Number of events in the chain
      verified_at    str   : ISO timestamp of this check
      genesis_hash   str   : The expected hash of the first link

    Performance note: this does a full table scan. For large databases
    (>10k events) this will take a few seconds. The /integrity endpoint
    in main.py should cache results for 30 seconds.
    """
    # Import here to avoid circular imports at module load time
    from database import get_connection

    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, raw_data, timestamp, source, event_hash, prev_hash
        FROM events
        ORDER BY id ASC
    """)
    rows = cursor.fetchall()
    conn.close()

    total     = len(rows)
    corrupted = []
    first_break = None

    if total == 0:
        return {
            "valid":        True,
            "total":        0,
            "corrupted":    [],
            "first_break":  None,
            "chain_length": 0,
            "verified_at":  datetime.now().isoformat(),
            "genesis_hash": compute_genesis_hash(),
            "summary":      "No events in database: chain is empty.",
        }

    # The first event's prev_hash should be the genesis hash
    # OR empty string (for events inserted before this upgrade)
    expected_prev = compute_genesis_hash()

    for i, row in enumerate(rows):
        event_id   = row["id"]
        raw_data   = row["raw_data"]  or ""
        timestamp  = row["timestamp"] or ""
        source     = row["source"]    or ""
        stored_hash = row["event_hash"] or ""
        stored_prev = row["prev_hash"]  or ""

        # Skip events that were inserted before the integrity upgrade
        # (they have empty hashes: mark as legacy, not corrupted)
        if not stored_hash:
            expected_prev = ""  # reset chain at legacy boundary
            continue

        # Verify prev_hash linkage
        # Allow empty prev_hash for first event (pre-upgrade databases)
        if i == 0 or not stored_prev:
            # First event or first hashed event after legacy gap,
            # don't enforce prev_hash but do verify the event_hash itself
            recomputed = compute_event_hash(raw_data, timestamp, source, stored_prev)
        else:
            # Check that this event's prev_hash matches what we computed
            # for the previous event
            if stored_prev != expected_prev and expected_prev != "":
                reason = (
                    f"Chain break: expected prev_hash={expected_prev[:16]}… "
                    f"but stored prev_hash={stored_prev[:16]}…"
                )
                corrupted.append({"id": event_id, "reason": reason})
                if first_break is None:
                    first_break = event_id
                logger.warning("[Integrity] %s at event id=%d", reason, event_id)

            recomputed = compute_event_hash(raw_data, timestamp, source, stored_prev)

        # Verify the event_hash itself
        if stored_hash != recomputed:
            reason = (
                f"Hash mismatch: stored={stored_hash[:16]}… "
                f"recomputed={recomputed[:16]}…"
            )
            corrupted.append({"id": event_id, "reason": reason})
            if first_break is None:
                first_break = event_id
            logger.warning("[Integrity] %s at event id=%d", reason, event_id)

        # Advance expected_prev to this event's hash for next iteration
        expected_prev = stored_hash

    valid = len(corrupted) == 0

    if valid:
        summary = f"Chain intact: {total} events verified."
    else:
        summary = (
            f"CHAIN COMPROMISED: {len(corrupted)} broken link(s) "
            f"out of {total} events. First break at event id={first_break}."
        )
        logger.error("[Integrity] %s", summary)

    return {
        "valid":        valid,
        "total":        total,
        "corrupted":    corrupted[:50],  # cap at 50 to avoid huge responses
        "first_break":  first_break,
        "chain_length": total,
        "verified_at":  datetime.now().isoformat(),
        "genesis_hash": compute_genesis_hash(),
        "summary":      summary,
    }


def get_event_integrity_status(event_id: int) -> dict:
    """
    Check the integrity of a single event by ID.
    Used by the replay timeline to show a per-step integrity badge.

    Returns:
      { valid: bool, hash: str, prev_hash: str, reason: str }
    """
    from database import get_connection

    conn   = get_connection()
    cursor = conn.cursor()

    # Get this event and the one before it
    cursor.execute("""
        SELECT id, raw_data, timestamp, source, event_hash, prev_hash
        FROM events WHERE id = ?
    """, (event_id,))
    row = cursor.fetchone()

    if not row:
        conn.close()
        return {"valid": False, "hash": "", "prev_hash": "", "reason": "Event not found"}

    # Get the previous event's hash to verify linkage
    cursor.execute("""
        SELECT event_hash FROM events
        WHERE id < ? ORDER BY id DESC LIMIT 1
    """, (event_id,))
    prev_row = cursor.fetchone()
    conn.close()

    stored_hash  = row["event_hash"] or ""
    stored_prev  = row["prev_hash"]  or ""

    # Events with no hash were inserted before the integrity upgrade
    if not stored_hash:
        return {
            "valid":      None,   # None = legacy (no hash, not corrupted)
            "hash":       "",
            "prev_hash":  "",
            "reason":     "Legacy event: inserted before integrity upgrade",
            "short_hash": "LEGACY",
        }

    recomputed = compute_event_hash(
        row["raw_data"]  or "",
        row["timestamp"] or "",
        row["source"]    or "",
        stored_prev,
    )

    if stored_hash != recomputed:
        return {
            "valid":      False,
            "hash":       stored_hash,
            "prev_hash":  stored_prev,
            "reason":     f"Hash mismatch: event may have been tampered with",
            "short_hash": stored_hash[:12] + "…",
        }

    # Check prev_hash linkage if we have a predecessor
    if prev_row and stored_prev and stored_prev != prev_row["event_hash"]:
        return {
            "valid":      False,
            "hash":       stored_hash,
            "prev_hash":  stored_prev,
            "reason":     "Chain break: previous event hash does not match",
            "short_hash": stored_hash[:12] + "…",
        }

    return {
        "valid":      True,
        "hash":       stored_hash,
        "prev_hash":  stored_prev,
        "reason":     "Hash verified: event is untampered",
        "short_hash": stored_hash[:12] + "…",
    }


def backfill_hashes() -> int:
    """
    Backfill SHA-256 hashes for existing events that have empty event_hash.
    Called once on startup if legacy events are detected.

    This computes hashes for old events so the chain starts from the
    beginning of the database rather than only from the upgrade point.

    Returns the number of events backfilled.
    """
    from database import get_connection

    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT id, raw_data, timestamp, source
        FROM events
        WHERE event_hash = '' OR event_hash IS NULL
        ORDER BY id ASC
    """)
    rows = cursor.fetchall()

    if not rows:
        conn.close()
        return 0

    logger.info("[Integrity] Backfilling hashes for %d legacy events...", len(rows))

    prev_hash = compute_genesis_hash()

    # Also get the hash of the event just before our first unhashed event
    # so the chain connects properly if some events already have hashes
    if rows:
        first_id = rows[0]["id"]
        cursor.execute("""
            SELECT event_hash FROM events
            WHERE id < ? AND event_hash != ''
            ORDER BY id DESC LIMIT 1
        """, (first_id,))
        anchor = cursor.fetchone()
        if anchor:
            prev_hash = anchor["event_hash"]

    count = 0
    for row in rows:
        new_hash = compute_event_hash(
            row["raw_data"]  or "",
            row["timestamp"] or "",
            row["source"]    or "",
            prev_hash,
        )
        cursor.execute("""
            UPDATE events SET event_hash = ?, prev_hash = ? WHERE id = ?
        """, (new_hash, prev_hash, row["id"]))
        prev_hash = new_hash
        count += 1

    conn.commit()
    conn.close()
    logger.info("[Integrity] Backfilled %d events.", count)
    return count


def reseal_chain() -> int:
    """
    Recompute every event's hash and prev_hash in id order.
    Only for migrations and for repairs after an operator-approved deletion
    (for example clearing demo events). Never call it to "fix" a chain that
    failed verification for unknown reasons: that would hide tampering.

    Returns the number of events re-sealed.
    """
    from database import get_connection

    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, raw_data, timestamp, source FROM events ORDER BY id ASC")
    rows = cursor.fetchall()

    prev  = ""     # matches log_collector._insert_event: the first event has no predecessor
    batch = []
    for row in rows:
        h = compute_event_hash(row["raw_data"] or "", row["timestamp"] or "", row["source"] or "", prev)
        batch.append((h, prev, row["id"]))
        prev = h

    cursor.executemany("UPDATE events SET event_hash = ?, prev_hash = ? WHERE id = ?", batch)
    conn.commit()
    conn.close()
    return len(batch)


def _normalize_timestamps() -> int:
    """
    Older real-time events were stored with UTC timestamps ("...T...") while batch scans
    stored local time. Convert the UTC ones to local so the timeline is consistent.
    Demo events are skipped: their ISO timestamps are already local.
    """
    from database import get_connection

    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, timestamp, raw_data FROM events WHERE timestamp LIKE '%T%'")
    updates = []
    for row in cursor.fetchall():
        try:
            raw = json.loads(row["raw_data"])
        except (TypeError, ValueError):
            continue
        if not isinstance(raw, dict) or raw.get("demo") is True:
            continue
        local = utc_to_local(row["timestamp"])
        if not local:
            continue
        if raw.get("TimeGenerated") == row["timestamp"]:
            raw["TimeGenerated"] = local
        new_raw = json.dumps(raw, ensure_ascii=False)
        updates.append((local, new_raw, dedup_hash_of(new_raw), row["id"]))
    cursor.executemany("UPDATE events SET timestamp = ?, raw_data = ?, dedup_hash = ? WHERE id = ?", updates)
    conn.commit()
    conn.close()
    return len(updates)


def _remove_duplicate_events() -> int:
    """
    Delete rows whose original evidence is identical to an earlier row (keeps the lowest id).
    Older versions re-inserted the same log events on every scan, so these are copies,
    not separate events. Only used by the scheme migration, right before re-sealing.
    """
    from database import get_connection

    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        DELETE FROM events
        WHERE dedup_hash != ''
          AND id NOT IN (SELECT MIN(id) FROM events WHERE dedup_hash != '' GROUP BY dedup_hash)
    """)
    removed = cursor.rowcount
    conn.commit()
    conn.close()
    return removed


def migrate_integrity_scheme() -> int:
    """
    One-time upgrade to the current hashing rules (see INTEGRITY_SCHEME).
    Returns the number of events re-sealed, or 0 if already up to date.
    """
    from database import get_connection

    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT value FROM system_config WHERE key = 'integrity_scheme'")
    row = cursor.fetchone()
    if row and row["value"] == INTEGRITY_SCHEME:
        conn.close()
        return 0
    conn.close()

    logger.warning(
        "[Integrity] Upgrading hash scheme to v%s: re-sealing the existing chain once. "
        "Hashes now cover the original evidence only, not the scorer's analysis fields.",
        INTEGRITY_SCHEME,
    )
    fixed = _normalize_timestamps()
    if fixed:
        logger.warning("[Integrity] Converted %d UTC timestamps to local time.", fixed)
    removed = _remove_duplicate_events()
    if removed:
        logger.warning(
            "[Integrity] Removed %d duplicate rows (identical evidence stored again by earlier scans).",
            removed,
        )
    n = reseal_chain()

    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO system_config (key, value, updated_at) VALUES ('integrity_scheme', ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
        (INTEGRITY_SCHEME,),
    )
    conn.commit()
    conn.close()
    return n
