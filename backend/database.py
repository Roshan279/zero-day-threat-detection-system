"""
database.py
SQLite connection, schema initialisation, and lightweight migration layer.

UPGRADES vs previous version:
  - prev_hash column added to events — enables chained SHA-256 integrity
    (each event hashes the previous, proving order + completeness).
  - cluster_id + cluster_label columns added to events — stores KMeans
    behavioral cluster assignments from anomaly_detector.py.
  - flagged_entities table — stores blocked accounts/IPs with full audit
    fields (who blocked, when, why, reversal status).
  - response_audit table — immutable log of every block/unblock action
    taken by response_executor.py (account disable, firewall rule, etc.).
  - All new columns added via the safe migration list — existing databases
    are upgraded without data loss on next startup.
"""

import sqlite3
import logging

logger = logging.getLogger(__name__)

DB_PATH = "forensic.db"


def get_connection():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn   = get_connection()
    cursor = conn.cursor()

    # ── Core tables ───────────────────────────────────────────
    cursor.executescript("""
        CREATE TABLE IF NOT EXISTS events (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp     TEXT    NOT NULL,
            source        TEXT    NOT NULL,
            event_type    TEXT    NOT NULL,
            raw_data      TEXT    NOT NULL,
            event_hash    TEXT    NOT NULL DEFAULT '',
            prev_hash     TEXT    NOT NULL DEFAULT '',
            anomaly_score REAL    DEFAULT 0.0,
            threat_tier   INTEGER DEFAULT 0,
            cluster_id    INTEGER DEFAULT -1,
            cluster_label TEXT    DEFAULT '',
            created_at    TEXT    DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_events_score     ON events (anomaly_score DESC);
        CREATE INDEX IF NOT EXISTS idx_events_tier      ON events (threat_tier);
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_source    ON events (source);

        CREATE TABLE IF NOT EXISTS case_files (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            event_ids   TEXT    NOT NULL,
            narrative   TEXT    NOT NULL,
            threat_tier INTEGER NOT NULL,
            confidence  REAL    NOT NULL,
            created_at  TEXT    DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS chat_history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            role       TEXT NOT NULL,
            message    TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS system_config (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        -- ── Blocked entities ─────────────────────────────────
        -- Stores every entity (account or IP) that has been flagged.
        -- blocked_type: 'account' | 'ip' | 'both'
        -- status: 'active' | 'reversed' | 'failed'
        CREATE TABLE IF NOT EXISTS flagged_entities (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            entity          TEXT    NOT NULL,
            entity_type     TEXT    NOT NULL DEFAULT 'account',
            blocked_type    TEXT    NOT NULL DEFAULT 'both',
            flagged_at      TEXT    NOT NULL,
            flagged_by      TEXT    NOT NULL DEFAULT 'luffy',
            reason          TEXT,
            threat_tier     INTEGER DEFAULT 0,
            event_db_id     INTEGER,
            status          TEXT    NOT NULL DEFAULT 'active',
            reversed_at     TEXT,
            dry_run         INTEGER NOT NULL DEFAULT 0
        );

        -- ── Response audit log ───────────────────────────────
        -- Immutable append-only log of every action taken.
        -- action_type: 'block_account' | 'block_ip' | 'unblock_account'
        --              | 'unblock_ip' | 'dry_run_block' | 'privilege_error'
        -- outcome: 'success' | 'failed' | 'skipped_whitelist' | 'dry_run'
        CREATE TABLE IF NOT EXISTS response_audit (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            action_type     TEXT    NOT NULL,
            target          TEXT    NOT NULL,
            outcome         TEXT    NOT NULL,
            detail          TEXT,
            command_run     TEXT,
            triggered_by    TEXT    NOT NULL DEFAULT 'luffy',
            event_db_id     INTEGER,
            threat_tier     INTEGER DEFAULT 0,
            is_admin        INTEGER NOT NULL DEFAULT 0,
            created_at      TEXT    DEFAULT CURRENT_TIMESTAMP
        );
    """)

    # ── Schema migrations (safe to re-run on every startup) ───
    # Each ALTER TABLE is skipped silently if the column already exists.
    add_column_migrations = [
        # Original columns — kept for databases that predate even these
        "ALTER TABLE events ADD COLUMN event_hash    TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE events ADD COLUMN anomaly_score REAL    DEFAULT 0.0",
        "ALTER TABLE events ADD COLUMN threat_tier   INTEGER DEFAULT 0",
        "ALTER TABLE events ADD COLUMN created_at    TEXT    DEFAULT CURRENT_TIMESTAMP",
        # New columns from this upgrade
        "ALTER TABLE events ADD COLUMN prev_hash     TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE events ADD COLUMN cluster_id    INTEGER DEFAULT -1",
        "ALTER TABLE events ADD COLUMN cluster_label TEXT    DEFAULT ''",
    ]

    for sql in add_column_migrations:
        try:
            cursor.execute(sql)
            logger.info("[DB] Migration applied: %s", sql[:70])
        except sqlite3.OperationalError:
            pass  # Column already exists — expected after first run

    # ── Create new indexes if they don't exist yet ─────────────
    index_migrations = [
        "CREATE INDEX IF NOT EXISTS idx_events_cluster ON events (cluster_id)",
    ]
    for sql in index_migrations:
        try:
            cursor.execute(sql)
        except sqlite3.OperationalError:
            pass

    # ── Legacy column rename: 'hash' → 'event_hash' ───────────
    cursor.execute("PRAGMA table_info(events)")
    columns = {row["name"] for row in cursor.fetchall()}

    if "hash" in columns and "event_hash" in columns:
        logger.info("[DB] Migrating data from legacy 'hash' column to 'event_hash'.")
        cursor.execute("""
            UPDATE events
            SET event_hash = hash
            WHERE (event_hash IS NULL OR event_hash = '')
              AND hash IS NOT NULL
              AND hash != ''
        """)
        cursor.executescript("""
            CREATE TABLE IF NOT EXISTS events_new (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp     TEXT    NOT NULL,
                source        TEXT    NOT NULL,
                event_type    TEXT    NOT NULL,
                raw_data      TEXT    NOT NULL,
                event_hash    TEXT    NOT NULL DEFAULT '',
                prev_hash     TEXT    NOT NULL DEFAULT '',
                anomaly_score REAL    DEFAULT 0.0,
                threat_tier   INTEGER DEFAULT 0,
                cluster_id    INTEGER DEFAULT -1,
                cluster_label TEXT    DEFAULT '',
                created_at    TEXT    DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO events_new
                (id, timestamp, source, event_type, raw_data,
                 event_hash, anomaly_score, threat_tier, created_at)
            SELECT
                id, timestamp, source, event_type, raw_data,
                event_hash, anomaly_score, threat_tier, created_at
            FROM events;

            DROP TABLE events;
            ALTER TABLE events_new RENAME TO events;

            CREATE INDEX IF NOT EXISTS idx_events_score     ON events (anomaly_score DESC);
            CREATE INDEX IF NOT EXISTS idx_events_tier      ON events (threat_tier);
            CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp);
            CREATE INDEX IF NOT EXISTS idx_events_source    ON events (source);
            CREATE INDEX IF NOT EXISTS idx_events_cluster   ON events (cluster_id);
        """)
        logger.info("[DB] Legacy 'hash' column removed — migration complete.")

    elif "hash" in columns and "event_hash" not in columns:
        logger.info("[DB] Renaming legacy 'hash' column to 'event_hash'.")
        cursor.executescript("""
            CREATE TABLE IF NOT EXISTS events_new (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp     TEXT    NOT NULL,
                source        TEXT    NOT NULL,
                event_type    TEXT    NOT NULL,
                raw_data      TEXT    NOT NULL,
                event_hash    TEXT    NOT NULL DEFAULT '',
                prev_hash     TEXT    NOT NULL DEFAULT '',
                anomaly_score REAL    DEFAULT 0.0,
                threat_tier   INTEGER DEFAULT 0,
                cluster_id    INTEGER DEFAULT -1,
                cluster_label TEXT    DEFAULT '',
                created_at    TEXT    DEFAULT CURRENT_TIMESTAMP
            );

            INSERT INTO events_new
                (id, timestamp, source, event_type, raw_data,
                 event_hash, anomaly_score, threat_tier, created_at)
            SELECT
                id, timestamp, source, event_type, raw_data,
                hash, anomaly_score, threat_tier, created_at
            FROM events;

            DROP TABLE events;
            ALTER TABLE events_new RENAME TO events;

            CREATE INDEX IF NOT EXISTS idx_events_score     ON events (anomaly_score DESC);
            CREATE INDEX IF NOT EXISTS idx_events_tier      ON events (threat_tier);
            CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events (timestamp);
            CREATE INDEX IF NOT EXISTS idx_events_source    ON events (source);
            CREATE INDEX IF NOT EXISTS idx_events_cluster   ON events (cluster_id);
        """)
        logger.info("[DB] Legacy 'hash' → 'event_hash' rename complete.")

    conn.commit()
    conn.close()
    print("[DB] Database initialized.")


def get_last_event_hash() -> str:
    """
    Returns the event_hash of the most recently inserted event.
    Used by integrity.py to chain each new event's hash to the previous one.
    Returns empty string if no events exist yet (genesis block).
    """
    conn   = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT event_hash FROM events ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    conn.close()
    return row["event_hash"] if row else ""


def prune_old_data(
    max_events:     int = 2000,
    max_chat_rows:  int = 200,
    max_case_files: int = 50,
) -> int:
    """
    Delete oldest rows beyond the given limits.
    Returns the number of event rows pruned.
    Note: response_audit and flagged_entities are NOT pruned —
    they are immutable forensic records and must be retained.
    """
    conn   = get_connection()
    cursor = conn.cursor()

    cursor.execute("""
        DELETE FROM events
        WHERE id NOT IN (
            SELECT id FROM events ORDER BY id DESC LIMIT ?
        )
    """, (max_events,))
    pruned_events = cursor.rowcount

    cursor.execute("""
        DELETE FROM chat_history
        WHERE id NOT IN (
            SELECT id FROM chat_history ORDER BY id DESC LIMIT ?
        )
    """, (max_chat_rows,))

    cursor.execute("""
        DELETE FROM case_files
        WHERE id NOT IN (
            SELECT id FROM case_files ORDER BY id DESC LIMIT ?
        )
    """, (max_case_files,))

    conn.commit()
    conn.close()
    return pruned_events


if __name__ == "__main__":
    init_db()