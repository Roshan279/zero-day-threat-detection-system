"""
response_executor.py
Executes real active-response actions on the Windows host.

ACTIONS:
  - Disable a Windows user account:   net user {account} /active:no
  - Block a source IP via firewall:    netsh advfirewall firewall add rule …
  - Reverse both actions:              net user /active:yes + delete rule

SAFETY CONTROLS:
  1. Whitelist — SYSTEM, Administrator, and local IPs are never blocked.
  2. Privilege check — detects if running as Administrator on startup.
     If not, all actions go to dry-run mode automatically.
  3. Dry-run mode — can be forced on via DRY_RUN = True. All commands
     are built and logged but never executed. Safe for testing.
  4. Audit trail — every attempted action (success or fail) is written
     to the response_audit table in the DB. Never deleted (forensic record).
  5. Input validation — account names and IPs are validated before being
     passed to subprocess to prevent shell injection.

USAGE (from main.py):
  from response_executor import execute_block, execute_unblock, is_admin

  result = execute_block(entity="192.168.1.45", entity_type="ip",
                         reason="Brute force", threat_tier=4,
                         event_db_id=821, triggered_by="luffy")
"""

import re
import ctypes
import logging
import platform
import subprocess
from datetime import datetime
from typing import Literal

logger = logging.getLogger(__name__)

# ── Dry-run flag ──────────────────────────────────────────────
# Set to True to build + log commands without executing them.
# Automatically forced True if not running as Administrator.
DRY_RUN: bool = False

# ── Firewall rule name prefix ─────────────────────────────────
RULE_PREFIX = "ForensicDetective_Block_"

# ── Account / IP whitelists ───────────────────────────────────
# These will NEVER be blocked regardless of threat level.
ACCOUNT_WHITELIST = {
    "administrator",
    "system",
    "local service",
    "network service",
    "nt authority\\system",
    "nt authority\\local service",
    "nt authority\\network service",
    "guest",              # disabling guest rarely helps and can break things
}

IP_WHITELIST = {
    "127.0.0.1",
    "::1",
    "0.0.0.0",
    "localhost",
}

# Auto-whitelist private subnets that are almost certainly the analyst's
# own network — blocking these would lock out the operator.
_PRIVATE_PREFIXES = ("10.", "192.168.", "172.16.", "172.17.", "172.18.",
                     "172.19.", "172.20.", "172.21.", "172.22.", "172.23.",
                     "172.24.", "172.25.", "172.26.", "172.27.", "172.28.",
                     "172.29.", "172.30.", "172.31.")

# ── Input validation patterns ─────────────────────────────────
# Prevent shell injection by only allowing safe characters in
# account names and IP addresses before passing to subprocess.
_SAFE_ACCOUNT_RE = re.compile(r"^[a-zA-Z0-9_\-\.\\ @]{1,64}$")
_SAFE_IP_RE      = re.compile(
    r"^(\d{1,3}\.){3}\d{1,3}$"          # IPv4
    r"|^([0-9a-fA-F:]+)$"               # IPv6
)


# ─────────────────────────────────────────────────────────────
# PRIVILEGE CHECK
# ─────────────────────────────────────────────────────────────

def is_admin() -> bool:
    """
    Returns True if the current process has Administrator privileges
    on Windows. Always returns False on non-Windows platforms.
    """
    if platform.system() != "Windows":
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def check_and_warn_privileges() -> bool:
    """
    Called once on startup from main.py.
    Logs a clear warning if not running as Administrator and forces
    DRY_RUN mode so commands are never silently dropped.
    Returns True if admin, False if not.
    """
    global DRY_RUN
    admin = is_admin()
    if not admin:
        DRY_RUN = True
        logger.warning(
            "[ResponseExecutor] NOT running as Administrator. "
            "Active response (account block / IP block) will run in "
            "DRY-RUN mode — commands will be logged but NOT executed. "
            "Restart backend as Administrator to enable live response."
        )
    else:
        logger.info(
            "[ResponseExecutor] Running as Administrator. "
            "Live active response is ENABLED. "
            "DRY_RUN=%s", DRY_RUN
        )
    return admin


# ─────────────────────────────────────────────────────────────
# INPUT VALIDATION
# ─────────────────────────────────────────────────────────────

def _validate_account(account: str) -> tuple[bool, str]:
    """Validate account name is safe to pass to subprocess."""
    if not account or not account.strip():
        return False, "Account name is empty"
    if not _SAFE_ACCOUNT_RE.match(account.strip()):
        return False, f"Account name contains unsafe characters: {account!r}"
    if account.strip().lower() in ACCOUNT_WHITELIST:
        return False, f"Account is on the whitelist and will not be blocked: {account!r}"
    return True, ""


def _validate_ip(ip: str) -> tuple[bool, str]:
    """Validate IP address is safe to pass to subprocess."""
    if not ip or not ip.strip():
        return False, "IP address is empty"
    ip = ip.strip()
    if ip in IP_WHITELIST:
        return False, f"IP is on the whitelist: {ip}"
    if ip.startswith(_PRIVATE_PREFIXES):
        return False, f"IP is a private/internal address (auto-whitelisted): {ip}"
    if not _SAFE_IP_RE.match(ip):
        return False, f"IP address contains unsafe characters: {ip!r}"
    return True, ""


# ─────────────────────────────────────────────────────────────
# AUDIT LOGGING
# ─────────────────────────────────────────────────────────────

def _write_audit(
    action_type:  str,
    target:       str,
    outcome:      str,
    detail:       str  = "",
    command_run:  str  = "",
    triggered_by: str  = "luffy",
    event_db_id:  int | None = None,
    threat_tier:  int  = 0,
) -> None:
    """Write an immutable audit record to the response_audit table."""
    try:
        from database import get_connection
        conn   = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO response_audit
                (action_type, target, outcome, detail, command_run,
                 triggered_by, event_db_id, threat_tier, is_admin, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            action_type, target, outcome, detail, command_run,
            triggered_by, event_db_id, threat_tier,
            1 if is_admin() else 0,
            datetime.now().isoformat(),
        ))
        conn.commit()
        conn.close()
    except Exception as e:
        # Never let audit failure crash the response action
        logger.error("[ResponseExecutor] Failed to write audit record: %s", e)


# ─────────────────────────────────────────────────────────────
# SUBPROCESS RUNNER
# ─────────────────────────────────────────────────────────────

def _run(cmd: list[str], dry_run: bool = False) -> tuple[bool, str]:
    """
    Run a subprocess command safely.

    Args:
        cmd:     List of command parts (never use shell=True)
        dry_run: If True, log the command but don't execute it.

    Returns:
        (success: bool, output: str)
    """
    cmd_str = " ".join(cmd)

    if dry_run or DRY_RUN:
        logger.info("[ResponseExecutor] DRY-RUN — would execute: %s", cmd_str)
        return True, f"[DRY-RUN] Command would run: {cmd_str}"

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=15,
            shell=False,          # NEVER shell=True — prevents injection
        )
        output = (result.stdout + result.stderr).strip()
        success = result.returncode == 0

        if success:
            logger.info("[ResponseExecutor] SUCCESS: %s → %s", cmd_str, output[:100])
        else:
            logger.warning("[ResponseExecutor] FAILED (rc=%d): %s → %s",
                           result.returncode, cmd_str, output[:200])

        return success, output

    except subprocess.TimeoutExpired:
        msg = f"Command timed out after 15s: {cmd_str}"
        logger.error("[ResponseExecutor] %s", msg)
        return False, msg

    except FileNotFoundError as e:
        msg = f"Command not found: {e}"
        logger.error("[ResponseExecutor] %s", msg)
        return False, msg

    except Exception as e:
        msg = f"Unexpected error running command: {e}"
        logger.error("[ResponseExecutor] %s", msg)
        return False, msg


# ─────────────────────────────────────────────────────────────
# ACCOUNT ACTIONS
# ─────────────────────────────────────────────────────────────

def disable_account(
    account:      str,
    triggered_by: str = "luffy",
    event_db_id:  int | None = None,
    threat_tier:  int = 0,
    dry_run:      bool = False,
) -> dict:
    """
    Disable a Windows user account via `net user {account} /active:no`.

    Returns:
        { success: bool, action: str, target: str, output: str,
          dry_run: bool, command: str }
    """
    valid, reason = _validate_account(account)
    if not valid:
        _write_audit("block_account", account, "skipped_whitelist",
                     reason, "", triggered_by, event_db_id, threat_tier)
        logger.info("[ResponseExecutor] Account block skipped: %s", reason)
        return {
            "success": False,
            "action":  "block_account",
            "target":  account,
            "output":  reason,
            "dry_run": dry_run or DRY_RUN,
            "command": "",
            "skipped": True,
            "reason":  reason,
        }

    cmd = ["net", "user", account.strip(), "/active:no"]
    success, output = _run(cmd, dry_run=dry_run)
    outcome = "dry_run" if (dry_run or DRY_RUN) else ("success" if success else "failed")

    _write_audit("block_account", account, outcome,
                 output, " ".join(cmd), triggered_by, event_db_id, threat_tier)

    # Update flagged_entities status
    if success or dry_run or DRY_RUN:
        _upsert_flagged_entity(account, "account", "account",
                               triggered_by, threat_tier, event_db_id,
                               dry_run or DRY_RUN)

    return {
        "success": success,
        "action":  "block_account",
        "target":  account,
        "output":  output,
        "dry_run": dry_run or DRY_RUN,
        "command": " ".join(cmd),
    }


def enable_account(
    account:      str,
    triggered_by: str = "luffy",
    event_db_id:  int | None = None,
    dry_run:      bool = False,
) -> dict:
    """Re-enable a previously disabled account via `net user {account} /active:yes`."""
    valid, reason = _validate_account(account)
    if not valid:
        return {"success": False, "action": "unblock_account",
                "target": account, "output": reason, "dry_run": dry_run or DRY_RUN}

    cmd = ["net", "user", account.strip(), "/active:yes"]
    success, output = _run(cmd, dry_run=dry_run)
    outcome = "dry_run" if (dry_run or DRY_RUN) else ("success" if success else "failed")

    _write_audit("unblock_account", account, outcome,
                 output, " ".join(cmd), triggered_by, event_db_id)
    _mark_entity_reversed(account)

    return {
        "success": success,
        "action":  "unblock_account",
        "target":  account,
        "output":  output,
        "dry_run": dry_run or DRY_RUN,
        "command": " ".join(cmd),
    }


# ─────────────────────────────────────────────────────────────
# IP FIREWALL ACTIONS
# ─────────────────────────────────────────────────────────────

def block_ip(
    ip:           str,
    triggered_by: str = "luffy",
    event_db_id:  int | None = None,
    threat_tier:  int = 0,
    dry_run:      bool = False,
) -> dict:
    """
    Block an IP address via Windows Firewall inbound rule.
    Rule name: ForensicDetective_Block_{ip}
    """
    valid, reason = _validate_ip(ip)
    if not valid:
        _write_audit("block_ip", ip, "skipped_whitelist",
                     reason, "", triggered_by, event_db_id, threat_tier)
        logger.info("[ResponseExecutor] IP block skipped: %s", reason)
        return {
            "success": False,
            "action":  "block_ip",
            "target":  ip,
            "output":  reason,
            "dry_run": dry_run or DRY_RUN,
            "command": "",
            "skipped": True,
            "reason":  reason,
        }

    rule_name = f"{RULE_PREFIX}{ip.replace(':', '_')}"
    cmd = [
        "netsh", "advfirewall", "firewall", "add", "rule",
        f"name={rule_name}",
        "dir=in",
        "action=block",
        f"remoteip={ip.strip()}",
        "enable=yes",
        "profile=any",
    ]
    success, output = _run(cmd, dry_run=dry_run)
    outcome = "dry_run" if (dry_run or DRY_RUN) else ("success" if success else "failed")

    _write_audit("block_ip", ip, outcome,
                 output, " ".join(cmd), triggered_by, event_db_id, threat_tier)

    if success or dry_run or DRY_RUN:
        _upsert_flagged_entity(ip, "ip", "ip",
                               triggered_by, threat_tier, event_db_id,
                               dry_run or DRY_RUN)

    return {
        "success":   success,
        "action":    "block_ip",
        "target":    ip,
        "output":    output,
        "dry_run":   dry_run or DRY_RUN,
        "command":   " ".join(cmd),
        "rule_name": rule_name,
    }


def unblock_ip(
    ip:           str,
    triggered_by: str = "luffy",
    event_db_id:  int | None = None,
    dry_run:      bool = False,
) -> dict:
    """Remove the firewall block rule for an IP address."""
    valid, reason = _validate_ip(ip)
    if not valid:
        return {"success": False, "action": "unblock_ip",
                "target": ip, "output": reason, "dry_run": dry_run or DRY_RUN}

    rule_name = f"{RULE_PREFIX}{ip.replace(':', '_')}"
    cmd = [
        "netsh", "advfirewall", "firewall", "delete", "rule",
        f"name={rule_name}",
    ]
    success, output = _run(cmd, dry_run=dry_run)
    outcome = "dry_run" if (dry_run or DRY_RUN) else ("success" if success else "failed")

    _write_audit("unblock_ip", ip, outcome,
                 output, " ".join(cmd), triggered_by, event_db_id)
    _mark_entity_reversed(ip)

    return {
        "success": success,
        "action":  "unblock_ip",
        "target":  ip,
        "output":  output,
        "dry_run": dry_run or DRY_RUN,
        "command": " ".join(cmd),
    }


# ─────────────────────────────────────────────────────────────
# COMBINED BLOCK / UNBLOCK
# ─────────────────────────────────────────────────────────────

def execute_block(
    entity:       str,
    entity_type:  Literal["account", "ip", "both", "auto"] = "auto",
    reason:       str = "",
    threat_tier:  int = 0,
    event_db_id:  int | None = None,
    triggered_by: str = "luffy",
    dry_run:      bool = False,
) -> dict:
    """
    Main entry point called by main.py /block-entity endpoint.

    Auto-detects whether the entity is an IP or account name if
    entity_type is "auto".

    Returns a combined result dict with all actions taken.
    """
    # Auto-detect type
    if entity_type == "auto":
        entity_type = "ip" if _SAFE_IP_RE.match(entity.strip()) else "account"

    results = []
    overall_success = True

    if entity_type in ("account", "both"):
        r = disable_account(entity, triggered_by, event_db_id, threat_tier, dry_run)
        results.append(r)
        if not r.get("skipped") and not r["success"]:
            overall_success = False

    if entity_type in ("ip", "both"):
        r = block_ip(entity, triggered_by, event_db_id, threat_tier, dry_run)
        results.append(r)
        if not r.get("skipped") and not r["success"]:
            overall_success = False

    actions_taken = [r["action"] for r in results if not r.get("skipped")]
    skipped       = [r.get("reason", "") for r in results if r.get("skipped")]

    is_dry = dry_run or DRY_RUN

    return {
        "success":      overall_success,
        "entity":       entity,
        "entity_type":  entity_type,
        "dry_run":      is_dry,
        "is_admin":     is_admin(),
        "actions_taken": actions_taken,
        "skipped":      skipped,
        "results":      results,
        "message": (
            f"[DRY-RUN] Would block {entity} ({entity_type}). "
            f"No real action taken — backend needs Administrator privileges."
            if is_dry else
            f"Blocked {entity} ({entity_type}). Actions: {', '.join(actions_taken)}."
            if overall_success else
            f"Block partially failed for {entity}. Check audit log."
        ),
    }


def execute_unblock(
    entity:       str,
    entity_type:  Literal["account", "ip", "both", "auto"] = "auto",
    triggered_by: str = "luffy",
    event_db_id:  int | None = None,
    dry_run:      bool = False,
) -> dict:
    """
    Reverse a previous block action.
    Called by main.py /unblock-entity endpoint.
    """
    if entity_type == "auto":
        entity_type = "ip" if _SAFE_IP_RE.match(entity.strip()) else "account"

    results = []

    if entity_type in ("account", "both"):
        results.append(enable_account(entity, triggered_by, event_db_id, dry_run))

    if entity_type in ("ip", "both"):
        results.append(unblock_ip(entity, triggered_by, event_db_id, dry_run))

    return {
        "success":  all(r["success"] for r in results),
        "entity":   entity,
        "dry_run":  dry_run or DRY_RUN,
        "results":  results,
        "message":  f"Unblock actions completed for {entity}.",
    }


# ─────────────────────────────────────────────────────────────
# DATABASE HELPERS
# ─────────────────────────────────────────────────────────────

def _upsert_flagged_entity(
    entity:       str,
    entity_type:  str,
    blocked_type: str,
    flagged_by:   str,
    threat_tier:  int,
    event_db_id:  int | None,
    is_dry_run:   bool,
) -> None:
    """Insert or update the flagged_entities record for this entity."""
    try:
        from database import get_connection
        conn   = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            INSERT INTO flagged_entities
                (entity, entity_type, blocked_type, flagged_at, flagged_by,
                 threat_tier, event_db_id, status, dry_run)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
        """, (
            entity, entity_type, blocked_type,
            datetime.now().isoformat(), flagged_by,
            threat_tier, event_db_id,
            1 if is_dry_run else 0,
        ))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error("[ResponseExecutor] Failed to upsert flagged entity: %s", e)


def _mark_entity_reversed(entity: str) -> None:
    """Mark a flagged entity as reversed (unblocked)."""
    try:
        from database import get_connection
        conn   = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            UPDATE flagged_entities
            SET status = 'reversed', reversed_at = ?
            WHERE entity = ? AND status = 'active'
        """, (datetime.now().isoformat(), entity))
        conn.commit()
        conn.close()
    except Exception as e:
        logger.error("[ResponseExecutor] Failed to mark entity reversed: %s", e)


def get_audit_log(limit: int = 50) -> list:
    """Return the most recent response audit entries."""
    try:
        from database import get_connection
        conn   = get_connection()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT * FROM response_audit
            ORDER BY created_at DESC LIMIT ?
        """, (limit,))
        rows = [dict(r) for r in cursor.fetchall()]
        conn.close()
        return rows
    except Exception as e:
        logger.error("[ResponseExecutor] Failed to fetch audit log: %s", e)
        return []