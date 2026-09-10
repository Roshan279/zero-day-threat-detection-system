"""
integrity.py
Forensic chain-of-custody via SHA-256 chained hashing.

HOW THE CHAIN WORKS:
  event_hash = SHA-256(raw_data + timestamp + source + prev_hash)

  Each event's hash depends on the previous event's hash — exactly
  like a blockchain. This means:
    - Modifying ANY event invalidates every hash after it
    - Deleting an event breaks the chain (missing link)
    - Reordering events breaks the chain (wrong prev_hash)

  This is stronger than simple per-event hashing, which only proves
  an individual record wasn't modified — it cannot detect deletions
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
import logging
from datetime import datetime

logger = logging.getLogger(__name__)


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
      raw_data + | + timestamp + | + source + | + prev_hash

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
    content = f"{raw_data}|{timestamp}|{source}|{prev_hash}"
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def compute_genesis_hash() -> str:
    """
    Returns the hash for an imaginary 'block zero' — used as
    prev_hash for the very first event in the database.
    Deterministic so it's always the same value.
    """
    return hashlib.sha256(b"forensic_detective_genesis_block_v1").hexdigest()


# ── Chain verification ────────────────────────────────────────

def verify_chain() -> dict:
    """
    Walk every event in insertion order and verify the hash chain.

    Returns a dict with:
      valid          bool   — True if chain is fully intact
      total          int    — Total events checked
      corrupted      list   — List of {id, reason} for broken links
      first_break    int|None — DB id of first broken event
      chain_length   int    — Number of events in the chain
      verified_at    str    — ISO timestamp of this check
      genesis_hash   str    — The expected hash of the first link

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
            "summary":      "No events in database — chain is empty.",
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
        # (they have empty hashes — mark as legacy, not corrupted)
        if not stored_hash:
            expected_prev = ""  # reset chain at legacy boundary
            continue

        # Verify prev_hash linkage
        # Allow empty prev_hash for first event (pre-upgrade databases)
        if i == 0 or not stored_prev:
            # First event or first hashed event after legacy gap —
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
        summary = f"Chain intact — {total} events verified."
    else:
        summary = (
            f"CHAIN COMPROMISED — {len(corrupted)} broken link(s) "
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
            "reason":     "Legacy event — inserted before integrity upgrade",
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
            "reason":     f"Hash mismatch — event may have been tampered with",
            "short_hash": stored_hash[:12] + "…",
        }

    # Check prev_hash linkage if we have a predecessor
    if prev_row and stored_prev and stored_prev != prev_row["event_hash"]:
        return {
            "valid":      False,
            "hash":       stored_hash,
            "prev_hash":  stored_prev,
            "reason":     "Chain break — previous event hash does not match",
            "short_hash": stored_hash[:12] + "…",
        }

    return {
        "valid":      True,
        "hash":       stored_hash,
        "prev_hash":  stored_prev,
        "reason":     "Hash verified — event is untampered",
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