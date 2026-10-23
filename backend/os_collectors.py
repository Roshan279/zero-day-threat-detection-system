"""
os_collectors.py
Linux / macOS log sources, normalised to the same event schema the Windows
collector produces so the ML pipeline, detective and dashboard work unchanged.

Security-relevant log lines are mapped onto their Windows Event ID equivalents:

    failed login / bad password   -> 4625  AUDIT_FAILURE
    successful login / session    -> 4624  AUDIT_SUCCESS
    account locked out            -> 4740  AUDIT_FAILURE
    sudo / su (explicit creds)    -> 4648  AUDIT_SUCCESS
    user account created          -> 4720  AUDIT_SUCCESS
    user account deleted          -> 4726  AUDIT_SUCCESS
    new service / unit installed  -> 7045  INFORMATION
    other error-priority entries  -> 1000  ERROR  (System / Application)

Sources:
    Linux  : `journalctl -o json`  (fallback: /var/log/auth.log or /var/log/secure)
    macOS  : `log show` / `log stream` with --style ndjson
"""

import json
import logging
import platform
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator

logger = logging.getLogger(__name__)

SYSTEM = platform.system()  # "Linux" | "Darwin" | "Windows"

# (compiled regex, event_id, event_type) , first match wins
_RULES: list[tuple[re.Pattern, int, str]] = [
    # log tampering / logging stopped
    (re.compile(r"vacuuming done|journal file .*truncated|logs? (?:were |was )?(?:cleared|wiped)|"
                r"rm .*/var/log|truncat\w+ .*(?:auth\.log|wtmp|btmp|secure)", re.I),
     1102, "AUDIT_SUCCESS"),
    (re.compile(r"(?:systemd-journald|rsyslogd).*(?:exiting|stopping|shutting down)|"
                r"stopping (?:journal service|system logging)|stopped (?:journal service|system logging)|"
                r"journald.*stopped", re.I),
     1100, "INFORMATION"),
    (re.compile(r"auditctl|audit.*rules? (?:deleted|cleared)|stopp(?:ed|ing) .*auditd|"
                r"auditd.*(?:stopp|shutting)", re.I),
     4719, "AUDIT_SUCCESS"),
    (re.compile(r"account (?:is )?locked|pam_faillock.*(?:locked|denied)|"
                r"maximum authentication attempts|too many authentication failures", re.I),
     4740, "AUDIT_FAILURE"),
    (re.compile(r"failed password|authentication failure|invalid user|"
                r"failed to authenticate|authentication failed|incorrect password|"
                r"failed publickey|connection closed by authenticating user", re.I),
     4625, "AUDIT_FAILURE"),
    (re.compile(r"new user: name=|useradd\b.*new user|added user|sysadminctl.*create", re.I),
     4720, "AUDIT_SUCCESS"),
    (re.compile(r"delete user|userdel\b|removed user|sysadminctl.*delete", re.I),
     4726, "AUDIT_SUCCESS"),
    (re.compile(r"add '[^']+' to (?:shadow )?group '[^']+'|added .* to group|"
                r"gpasswd.*(?:added|add)\b", re.I),
     4732, "AUDIT_SUCCESS"),
    (re.compile(r"delete '[^']+' from (?:shadow )?group '[^']+'|removed .* from group", re.I),
     4733, "AUDIT_SUCCESS"),
    (re.compile(r"password changed for|chage\b|usermod\b.*change|change user '[^']+'|"
                r"chfn\b|chsh\b|pam_unix\(passwd:chauthtok\)", re.I),
     4738, "AUDIT_SUCCESS"),
    (re.compile(r"\bsudo\b.*COMMAND=|\bsu\b.*session opened|\bsu:.*to root|"
                r"\bsudo\b.*TTY=", re.I),
     4648, "AUDIT_SUCCESS"),
    (re.compile(r"session opened for user root\b|new session \d+ of user root\b|"
                r"accepted \S+ for root\b", re.I),
     4672, "AUDIT_SUCCESS"),
    (re.compile(r"accepted (?:password|publickey|keyboard-interactive)|"
                r"session opened for user|new session \d+ of user|"
                r"user authenticated|login succeeded", re.I),
     4624, "AUDIT_SUCCESS"),
    (re.compile(r"crontab:\s*\(\S+\)\s*(?:REPLACE|BEGIN EDIT|END EDIT)|"
                r"\batd\b.*\bjob\b|systemd.*\.timer.*(?:created|enabled|started)", re.I),
     4698, "AUDIT_SUCCESS"),
    (re.compile(r"created symlink|unit .*\.service.*(?:installed|enabled)|"
                r"launchd.*(?:bootstrap|load).*(?:LaunchDaemons|LaunchAgents)", re.I),
     7045, "INFORMATION"),
    (re.compile(r"removed (?:'?/etc/systemd|symlink)|unit .*\.service.*(?:disabled|masked)", re.I),
     7040, "INFORMATION"),
    (re.compile(r"main process exited, code=(?:killed|dumped)|"
                r"failed with result '(?:exit-code|signal|core-dump|timeout)'|"
                r"segfault at|out of memory: kill", re.I),
     7034, "ERROR"),
    # kernel firewall log lines (iptables -j LOG): "IN=eth0 ... SRC=a DST=b ... DPT=22"
    (re.compile(r"\bSRC=\S+ DST=\S+.*\bDPT=\d+", re.I), 5157, "AUDIT_FAILURE"),
]

_USER_RE = re.compile(
    r"(?:\bfor\s+(?:invalid user\s+)?(?:user\s+)?|\binvalid user\s+|\buser[=\s]+|\bname=)"
    r"'?([A-Za-z0-9_.\-$@]{1,64})|^([A-Za-z0-9_.\-$@]{1,64})\s*:\s*TTY=", re.I)
_IP_RE   = re.compile(r"\bfrom\s+((?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]{3,39})\b")

_AUTH_PROCS = {"sshd", "sudo", "su", "login", "passwd", "useradd", "userdel",
               "usermod", "groupadd", "chpasswd", "gdm", "gdm-password", "lightdm",
               "systemd-logind", "polkitd", "unix_chkpwd", "authd", "loginwindow",
               "opendirectoryd", "securityd", "sysadminctl", "screensaverengine"}


_SYSTEM_IDS = {1100, 7034, 7040, 7045}
_BY_RE      = re.compile(r"\bby\s+([A-Za-z0-9_.\-$@]+)\(uid=", re.I)
_RUNAS_RE   = re.compile(r"\bUSER=([A-Za-z0-9_.\-$@]+)")
_UNIT_RE    = re.compile(r"([A-Za-z0-9_.@\-]+\.(?:service|timer|socket))")
_GROUP_RE   = re.compile(r"(?:add|delete) '([^']+)' (?:to|from) (?:shadow )?group '([^']+)'", re.I)
_FW_RE      = re.compile(r"\b(SRC|DST|DPT|SPT|PROTO)=(\S+)")


def _enrich(raw: dict, event_id: int, ident: str, message: str) -> None:
    """Populate the Windows-style fields the dashboard / Luffy read for this event ID."""
    m = _USER_RE.search(message)
    user = (m.group(1) or m.group(2)) if m else None
    m = _IP_RE.search(message)
    ip = m.group(1) if m else None

    if event_id in (4624, 4625, 4740, 4672, 4720, 4726, 4738):
        if user:
            raw["TargetUserName"] = user
        if ip:
            raw["IpAddress"] = ip
        m = _BY_RE.search(message)
        if m:
            raw["SubjectUserName"] = m.group(1)

    if event_id in (4624, 4625):
        # LogonType: 3 = network (ssh), 2 = interactive console
        raw["LogonType"] = "3" if ident.lower() == "sshd" else "2"
    if event_id == 4625:
        low = message.lower()
        raw["FailureReason"] = ("0xC0000064" if "invalid user" in low or "unknown user" in low
                                else "0xC000006A")  # nonexistent user / wrong password
    if event_id == 4648:
        if user and ":" in message and "COMMAND=" in message:
            raw["SubjectUserName"] = user                 # "bob : TTY=... ; COMMAND=..."
        m = _RUNAS_RE.search(message)
        raw["TargetUserName"] = m.group(1) if m else "root"
        raw["ProcessName"] = ident
    if event_id in (4732, 4733):
        m = _GROUP_RE.search(message)
        if m:
            raw["MemberName"], raw["TargetUserName"] = m.group(1), m.group(2)
    if event_id in (7034, 7040, 7045):
        m = _UNIT_RE.search(message)
        name = m.group(1) if m else ident
        raw["ServiceName"] = name
        raw["param1"] = name
        if event_id == 7045:
            raw["ServiceAccount"] = "root"
            raw["ImagePath"] = "systemd unit"
    if event_id == 5157:
        f = dict(_FW_RE.findall(message))
        raw["SourceAddress"] = f.get("SRC", "")
        raw["DestAddress"]   = f.get("DST", "")
        raw["DestPort"]      = f.get("DPT", "")
        raw["Application"]   = f.get("PROTO", "kernel")
        if f.get("SRC"):
            raw["IpAddress"] = f["SRC"]


def _classify(message: str) -> tuple[int, str] | None:
    for rx, eid, etype in _RULES:
        if rx.search(message):
            return eid, etype
    return None


def _build(message: str, ident: str, host: str, ts: str,
           priority: int | None = None) -> dict | None:
    """Turn one log line into the parsed-event dict log_collector expects."""
    message = (message or "").strip()
    if not message:
        return None

    # journald/unified-log messages omit the process name, which several rules need
    hit = _classify(f"{ident}: {message}")
    is_auth_proc = ident.lower() in _AUTH_PROCS

    if hit:
        event_id, event_type = hit
        source = "System" if event_id in _SYSTEM_IDS else "Security"
    elif priority is not None and priority <= 3:
        event_id, event_type = 1000, "ERROR"
        source = "System" if ident.lower() in ("kernel", "systemd", "launchd", "kernel_task") \
            else "Application"
    elif is_auth_proc and priority is not None and priority <= 4:
        event_id, event_type, source = 4625, "WARNING", "Security"
    else:
        return None  # uninteresting noise

    raw = {
        "EventID":       event_id,
        "TimeGenerated": ts,
        "SourceName":    ident or "Unknown",
        "EventType":     event_type,
        "ComputerName":  host or platform.node() or "Unknown",
        "Data":          message[:300],
    }
    _enrich(raw, event_id, ident, message)

    return {"timestamp": ts, "source": source, "event_type": event_type, "raw": raw}


def _utc_iso(epoch_seconds: float) -> str:
    """Local time as "YYYY-MM-DD HH:MM:SS", the one timestamp format used everywhere."""
    return datetime.fromtimestamp(epoch_seconds).strftime("%Y-%m-%d %H:%M:%S")


# ─────────────────────────────────────────────────────────────
# LINUX
# ─────────────────────────────────────────────────────────────

_AUTH_FILES = ("/var/log/auth.log", "/var/log/secure")


def _parse_journal_line(line: str) -> dict | None:
    try:
        j = json.loads(line)
    except json.JSONDecodeError:
        return None
    msg = j.get("MESSAGE")
    if not isinstance(msg, str):
        return None
    try:
        ts = _utc_iso(int(j["__REALTIME_TIMESTAMP"]) / 1_000_000)
    except (KeyError, ValueError):
        ts = _utc_iso(time.time())
    try:
        prio = int(j.get("PRIORITY", 6))
    except ValueError:
        prio = 6
    ident = j.get("SYSLOG_IDENTIFIER") or j.get("_COMM") or ""
    return _build(msg, ident, j.get("_HOSTNAME", ""), ts, prio)


def _parse_syslog_line(line: str) -> dict | None:
    # "Oct 23 12:00:01 host sshd[123]: message"
    m = re.match(r"^\S+\s+\d+\s+[\d:]+\s+(\S+)\s+([^\[:\s]+)(?:\[\d+\])?:\s*(.*)$", line)
    if not m:
        return None
    host, ident, msg = m.groups()
    return _build(msg, ident, host, _utc_iso(time.time()), None)


def _linux_file() -> Path | None:
    for p in _AUTH_FILES:
        if Path(p).is_file():
            return Path(p)
    return None


def _linux_batch(limit: int) -> list[dict]:
    out: list[dict] = []
    if shutil.which("journalctl"):
        try:
            r = subprocess.run(
                ["journalctl", "-o", "json", "-n", str(limit * 20), "--no-pager"],
                capture_output=True, text=True, timeout=30)
            for line in r.stdout.splitlines():
                p = _parse_journal_line(line)
                if p:
                    out.append(p)
            if r.returncode != 0 and not out:
                logger.warning("[COLLECTOR] journalctl: %s", r.stderr.strip()[:200])
        except Exception as exc:
            logger.warning("[COLLECTOR] journalctl failed: %s", exc)
    if not out:
        f = _linux_file()
        if f:
            try:
                for line in f.read_text(errors="replace").splitlines()[-limit * 20:]:
                    p = _parse_syslog_line(line)
                    if p:
                        out.append(p)
            except OSError as exc:
                logger.warning("[COLLECTOR] Cannot read %s: %s", f, exc)
    return out[-limit:]


def _linux_stream(should_run: Callable[[], bool]) -> Iterator[dict]:
    if shutil.which("journalctl"):
        proc = subprocess.Popen(
            ["journalctl", "-f", "-n", "0", "-o", "json", "--no-pager"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            for line in proc.stdout:
                if not should_run():
                    break
                p = _parse_journal_line(line)
                if p:
                    yield p
        finally:
            proc.terminate()
        return

    f = _linux_file()
    if not f:
        logger.error("[WATCHER] No journalctl and no %s, nothing to watch.",
                     " or ".join(_AUTH_FILES))
        return
    with open(f, errors="replace") as fh:
        fh.seek(0, 2)
        while should_run():
            line = fh.readline()
            if not line:
                time.sleep(0.5)
                continue
            p = _parse_syslog_line(line)
            if p:
                yield p


# ─────────────────────────────────────────────────────────────
# macOS
# ─────────────────────────────────────────────────────────────

_MAC_PREDICATE = (
    'process IN {"sshd","sudo","su","login","authd","loginwindow","opendirectoryd",'
    '"securityd","sysadminctl","launchd"} OR messageType IN {"error","fault"}'
)


def _parse_mac_line(line: str) -> dict | None:
    try:
        j = json.loads(line)
    except json.JSONDecodeError:
        return None
    msg = j.get("eventMessage")
    if not isinstance(msg, str):
        return None
    ts_raw = j.get("timestamp", "")
    try:
        ts = datetime.strptime(ts_raw[:19], "%Y-%m-%d %H:%M:%S").strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        ts = _utc_iso(time.time())
    ident = Path(j.get("processImagePath", "") or "").name
    prio = 3 if j.get("messageType") in ("Error", "Fault", "error", "fault") else 6
    return _build(msg, ident, platform.node(), ts, prio)


def _mac_batch(limit: int) -> list[dict]:
    out: list[dict] = []
    try:
        r = subprocess.run(
            ["log", "show", "--last", "1h", "--style", "ndjson", "--predicate", _MAC_PREDICATE],
            capture_output=True, text=True, timeout=60)
        for line in r.stdout.splitlines():
            p = _parse_mac_line(line)
            if p:
                out.append(p)
    except Exception as exc:
        logger.warning("[COLLECTOR] `log show` failed: %s", exc)
    return out[-limit:]


def _mac_stream(should_run: Callable[[], bool]) -> Iterator[dict]:
    proc = subprocess.Popen(
        ["log", "stream", "--style", "ndjson", "--predicate", _MAC_PREDICATE],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        for line in proc.stdout:
            if not should_run():
                break
            p = _parse_mac_line(line)
            if p:
                yield p
    finally:
        proc.terminate()


# ─────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────

def is_supported() -> bool:
    return SYSTEM in ("Linux", "Darwin")


def collect_batch(limit: int) -> list[dict]:
    """Recent security-relevant events, oldest first."""
    if SYSTEM == "Linux":
        return _linux_batch(limit)
    if SYSTEM == "Darwin":
        return _mac_batch(limit)
    return []


def stream_events(should_run: Callable[[], bool]) -> Iterator[dict]:
    """Blocking generator of new events until should_run() returns False."""
    if SYSTEM == "Linux":
        yield from _linux_stream(should_run)
    elif SYSTEM == "Darwin":
        yield from _mac_stream(should_run)
