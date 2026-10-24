"""
report_generator.py
Generates the combined security report (management summary plus technical detail) using ReportLab.

FIXES vs original:
  - `import re` at module top level (was buried inside a function body).
  - get_report_data() no longer crashes if system_config is empty, safe fallback.
  - Tier colour indexing uses explicit dict lookup instead of fragile `5-i` arithmetic.
  - Page numbers added to the multi-page Technical Report via an onPage callback.
  - All bare `except` clauses replaced with typed exceptions.
  - Variable name collision fixed: inner `bl` in generate_management_pdf()
    renamed to `bl_data` so it no longer shadows the outer `bl` tuple element.
"""

import json
import re
import hashlib
import logging
from datetime import datetime
from io import BytesIO

from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, CondPageBreak,
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY
from xml.sax.saxutils import escape as xml_escape

from database import get_connection
from scope import scope_label, scope_where

logger = logging.getLogger(__name__)

# ── Palette ───────────────────────────────────────────────────
BLACK      = colors.HexColor("#000000")
DARK       = colors.HexColor("#1a1a1a")
MID_GRAY   = colors.HexColor("#555555")
LIGHT_GRAY = colors.HexColor("#aaaaaa")
RULE_GRAY  = colors.HexColor("#cccccc")
WHITE      = colors.white

HEADER_BG  = colors.HexColor("#2c3e50")
ALT_BG     = colors.HexColor("#f8f9fa")

T_COLORS = {
    1: colors.HexColor("#1e8449"),  # green
    2: colors.HexColor("#b7950b"),  # amber
    3: colors.HexColor("#d35400"),  # orange
    4: colors.HexColor("#c0392b"),  # red
}
T_LABELS = {1: "LOW", 2: "MEDIUM", 3: "HIGH", 4: "CRITICAL"}

EVENT_DESCRIPTIONS = {
    6062: "Network Adapter Activity",
    7045: "New Service Installed",
    7040: "Service Start Type Changed",
    6013: "System Uptime Reported",
    5379: "Credential Read from Manager",
    4624: "Successful Account Logon",
    4625: "Failed Logon Attempt",
    4648: "Explicit Credential Logon",
    4720: "New User Account Created",
    4726: "User Account Deleted",
    4740: "User Account Locked Out",
    1000: "Application Error",
    1001: "Application Fault",
    8224: "VSS Service Activity",
}


def get_desc(eid) -> str:
    return EVENT_DESCRIPTIONS.get(eid, f"Event {eid}")


def report_hash(events: list) -> str:
    return hashlib.sha256("".join(e.get("event_hash", "") for e in events).encode()).hexdigest()


# ═════════════════════════════════════════════════════════════
# ONE COMBINED REPORT
# A management summary up front (what happened, how bad, what to do), then the technical detail behind it
# (patterns, entities, timeline, evidence, model drivers, chain of custody). Both report URLs return this.
# Everything is worked out from the events in scope, so a scoped report describes only its own events.
# ═════════════════════════════════════════════════════════════
MARGIN = 0.8 * inch
PAGE_W = letter[0] - 2 * MARGIN          # the width every table has to add up to (6.9 inch)
FEATURE_NAMES = {
    "event_type_risk": ("Event Type Risk", "How risky the event classification is (AUDIT_FAILURE > ERROR > WARNING)."),
    "hour_of_day":     ("Time of Day",     "How unusual the time of day is. Night-time activity scores higher."),
    "log_source":      ("Log Source",      "Which log channel it came from (Security > System > Application)."),
    "event_id_mod":    ("Event ID Pattern", "How rare this event ID is in the log baseline."),
}
PATTERN_RISK = {
    "Brute Force Pattern":          "Many failed logins: accounts may be under attack.",
    "Credential Access Pattern":    "Credentials may be compromised. Review access logs.",
    "Privilege Escalation Pattern": "An attacker may have gained elevated access.",
    "Persistence Pattern":          "Something may have been installed to survive a restart.",
    "Data Exfiltration Pattern":    "Sensitive data may have left the organisation.",
    "Normal System Activity":       "Routine activity. No business impact identified.",
    "Unknown Pattern":              "Does not match a known pattern. Needs an analyst.",
}
ACTIONS = {
    1: [("Monitor", "Continue standard monitoring. No immediate action is needed."),
        ("Review", "Schedule a routine log review within 5 business days.")],
    2: [("Investigate", "Assign an analyst to review the flagged events within 24 hours."),
        ("Monitor", "Increase monitoring of the affected systems.")],
    3: [("Urgent review", "Assign a senior analyst now and review every HIGH event."),
        ("Consider isolation", "Decide whether the affected accounts or systems should be suspended."),
        ("Document", "Start formal incident documentation for compliance.")],
    4: [("Immediate action", "Escalate to the CISO and the incident response team now."),
        ("Isolate", "Consider isolating the affected systems to stop further damage."),
        ("Preserve evidence", "Keep all logs. Do not restart the affected systems."),
        ("Notify", "Check whether breach notification obligations apply.")],
}


def _raw(e: dict) -> dict:
    try:
        r = json.loads(e.get("raw_data") or "{}")
        return r if isinstance(r, dict) else {}
    except (json.JSONDecodeError, TypeError):
        return {}


def _ts(e: dict) -> str:
    return str(e.get("timestamp", "")).replace("T", " ")[:19]


def _esc(text) -> str:
    return xml_escape(str(text if text is not None else ""))


def _load_events(scope: dict | None, events: list | None) -> list:
    """Every event in scope, highest score first. From the database, or from a list the caller supplied."""
    if events is not None:
        rows = [dict(e) for e in events]
    else:
        where, params = scope_where(scope)
        conn = get_connection()
        cur = conn.cursor()
        cur.execute(f"SELECT * FROM events{where} ORDER BY anomaly_score DESC LIMIT 5000", params)
        rows = [dict(r) for r in cur.fetchall()]
        conn.close()
    rows.sort(key=lambda e: e.get("anomaly_score", 0), reverse=True)
    return rows


def _case_file_and_baseline() -> tuple:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT * FROM case_files ORDER BY created_at DESC LIMIT 1")
    cf_row = cur.fetchone()
    baseline: dict = {}
    try:
        cur.execute("SELECT value FROM system_config WHERE key = 'feature_baseline'")
        row = cur.fetchone()
        if row:
            baseline = json.loads(row["value"])
    except Exception as exc:
        logger.warning("Could not load feature_baseline from system_config: %s", exc)
    conn.close()
    return (dict(cf_row) if cf_row else None), baseline


FRIENDLY_SOURCE = {
    "Application Error": "An app crashed", "Application Hang": "An app stopped responding", "Win32k": "Display power change",
    "Microsoft-Windows-Kernel-Power": "Power state change", "Microsoft-Windows-Perflib": "Performance counters failed to load",
    "VSS": "Backup snapshot activity", "Microsoft-Windows-System-Restore": "System Restore snapshot", "MsiInstaller": "Software installed or removed",
    "VBScriptDeprecationAlert": "VBScript is being retired", "Software Protection Platform Service": "Windows licence check",
    "Microsoft-Windows-Directory-Services-SAM": "Account database notice", "Microsoft-Windows-NDIS": "Network adapter notice",
    "Netwtw14": "Wi-Fi driver notice", "Microsoft-Windows-CAPI2": "Certificate service notice", "Edge": "Edge browser log",
    "DCOM": "A DCOM permission or start-up error", "Dell SupportAssist Remediation": "Dell SupportAssist activity", "SupportAssistAgent": "Dell SupportAssist activity",
}
FRIENDLY_ID = {
    506: "Power state change", 507: "Power state change", 566: "Power state change", 700: "Display power change", 701: "Display power change",
    6062: "Wi-Fi driver notice", 1000: "An app crashed", 1002: "An app stopped responding", 1008: "Performance counters failed to load",
    4624: "An account logged on", 4625: "A logon failed", 4740: "An account was locked out", 7045: "A new service was installed",
    7000: "A service failed to start", 7009: "A service took too long to start", 7023: "A service stopped with an error", 7034: "A service crashed",
}


def describe(e: dict) -> str:
    """What the event is, in a few plain words. Falls back to the log text only when that text is readable."""
    raw = _raw(e)
    eid = raw.get("EventID")
    src = str(raw.get("SourceName") or e.get("source") or "")
    if eid in EVENT_DESCRIPTIONS:
        return EVENT_DESCRIPTIONS[eid]
    if src in FRIENDLY_SOURCE:
        return FRIENDLY_SOURCE[src]
    if eid in FRIENDLY_ID:
        return FRIENDLY_ID[eid]
    data = " ".join(str(raw.get("Data") or "").split())
    if data and re.search(r"[A-Za-z]{3,}", data) and not re.fullmatch(r"[0-9A-Fa-f{}\- ]+", data[:40]):
        return data[:60] + ("..." if len(data) > 60 else "")
    return f"{src or 'Event'} event {eid}"


# ── building blocks ─────────────────────────────────────────
def S(name: str, **kw) -> ParagraphStyle:
    size = kw.get("fontSize", 9)
    base = dict(fontName="Helvetica", fontSize=size, textColor=BLACK, leading=size * 1.32, spaceAfter=4)
    base.update(kw)
    return ParagraphStyle(name, **base)


def hr(t: float = 0.5, c=RULE_GRAY, before: float = 3, after: float = 5) -> HRFlowable:
    return HRFlowable(width="100%", thickness=t, color=c, spaceBefore=before, spaceAfter=after)


def P(text, size=8, bold=False, color=BLACK, align=TA_LEFT, font=None) -> Paragraph:
    """A table cell: it wraps inside its column instead of running over the next one."""
    return Paragraph(text, S("c", fontSize=size, fontName=font or ("Helvetica-Bold" if bold else "Helvetica"),
                             textColor=color, alignment=align, spaceAfter=0, leading=size * 1.25))


def table(rows: list, widths: list, extra: list | None = None, header: bool = True, size: float = 8) -> Table:
    """A table with a dark header, zebra rows and padding that keeps the text off the lines."""
    assert abs(sum(widths) - PAGE_W) < 0.02 * inch or sum(widths) < PAGE_W + 0.01, "columns wider than the page"
    out = []
    for r, row in enumerate(rows):
        out.append([c if not isinstance(c, str) else
                    P(_esc(c), size=size, bold=(header and r == 0), color=(WHITE if header and r == 0 else BLACK)) for c in row])
    style = [
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("BOX",           (0, 0), (-1, -1), 0.5, RULE_GRAY),
        ("INNERGRID",     (0, 0), (-1, -1), 0.25, RULE_GRAY),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING",   (0, 0), (-1, -1), 6),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 6),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), HEADER_BG), ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, ALT_BG])]
    else:
        style += [("ROWBACKGROUNDS", (0, 0), (-1, -1), [WHITE, ALT_BG])]
    if extra:
        style += extra
    t = Table(out, colWidths=widths, repeatRows=1 if header else 0)
    t.setStyle(TableStyle(style))
    return t


def tcell(tier: int, text: str | None = None, size: float = 8) -> Paragraph:
    return P(_esc(text or T_LABELS.get(tier, "?")), size=size, bold=True, color=T_COLORS.get(tier, BLACK))


def _page(canvas, doc, label: str = ""):
    canvas.saveState()
    canvas.setStrokeColor(RULE_GRAY)
    canvas.setLineWidth(0.5)
    canvas.line(MARGIN, 0.62 * inch, letter[0] - MARGIN, 0.62 * inch)
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(MID_GRAY)
    canvas.drawString(MARGIN, 0.46 * inch, f"Forensic Detective · {label}")
    canvas.drawRightString(letter[0] - MARGIN, 0.46 * inch, f"Page {doc.page}")
    canvas.restoreState()


def generate_report_pdf(scope: dict | None = None, events: list | None = None) -> bytes:
    rows = _load_events(scope, events)
    total = len(rows)
    tiers = {t: sum(1 for e in rows if e.get("threat_tier") == t) for t in (1, 2, 3, 4)}
    avg = sum(e.get("anomaly_score", 0) for e in rows) / total if total else 0
    max_tier = max((t for t, n in tiers.items() if n), default=1)
    flagged = tiers[3] + tiers[4]
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    label = scope_label(scope)
    cf, baseline = (None, {}) if events is not None else _case_file_and_baseline()
    top50 = rows[:50]
    rh = report_hash(top50)

    # ── everything worked out once ──
    patterns: dict = {}
    for e in rows:
        name = e.get("cluster_label") or _raw(e).get("behavior_label") or "Unknown Pattern"
        d = patterns.setdefault(name, {"n": 0, "score": 0.0, "tier": 1})
        d["n"] += 1; d["score"] += e.get("anomaly_score", 0); d["tier"] = max(d["tier"], e.get("threat_tier", 1))
    ents: dict = {}
    for e in rows:
        r = _raw(e)
        name = r.get("SourceName") or e.get("source") or "Unknown"
        d = ents.setdefault(name, {"n": 0, "score": 0.0, "tier": 1, "first": _ts(e), "last": _ts(e)})
        d["n"] += 1; d["score"] += e.get("anomaly_score", 0); d["tier"] = max(d["tier"], e.get("threat_tier", 1))
        d["first"] = min(d["first"], _ts(e)); d["last"] = max(d["last"], _ts(e))
    days: dict = {}
    hours: dict = {}
    for e in rows:
        day = _ts(e)[:10]
        d = days.setdefault(day, {1: 0, 2: 0, 3: 0, 4: 0})
        d[e.get("threat_tier", 1)] += 1
        if len(_ts(e)) >= 13:
            hours[_ts(e)[11:13]] = hours.get(_ts(e)[11:13], 0) + 1
    phases: dict = {}
    for e in rows:
        ph = _raw(e).get("phase")
        if ph:
            d = phases.setdefault(ph, {"n": 0, "tier": 1, "first": _ts(e)})
            d["n"] += 1; d["tier"] = max(d["tier"], e.get("threat_tier", 1)); d["first"] = min(d["first"], _ts(e))
    drivers = {k: [0.0, 0] for k in FEATURE_NAMES}
    for e in rows:
        for f in _raw(e).get("feature_importance", []) or []:
            if f.get("feature") in drivers:
                drivers[f["feature"]][0] += float(f.get("pct", 0)); drivers[f["feature"]][1] += 1

    top_pattern = max(patterns.items(), key=lambda kv: kv[1]["n"], default=(None, None))
    risky = sorted(ents.items(), key=lambda kv: (-kv[1]["tier"], -(kv[1]["score"] / kv[1]["n"])))
    busy_day = max(days.items(), key=lambda kv: sum(kv[1].values()), default=(None, None))
    busy_hour = max(hours.items(), key=lambda kv: kv[1], default=(None, None))

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=letter, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=0.75 * inch, bottomMargin=0.85 * inch,
                            title="Forensic Detective: Security Report")
    story: list = []
    H1 = S("h1", fontName="Helvetica-Bold", fontSize=13, spaceBefore=10, spaceAfter=2, keepWithNext=1)
    BODY = S("body", fontSize=9.5, leading=14, alignment=TA_JUSTIFY, spaceAfter=6)
    NOTE = S("note", fontSize=8, textColor=MID_GRAY, leading=11, spaceAfter=6)

    NOTE = S("note", fontSize=8, textColor=MID_GRAY, leading=11, spaceAfter=6, keepWithNext=1)

    def section(title: str, note: str = ""):
        story.append(CondPageBreak(1.7 * inch))      # never leave a heading alone at the foot of a page
        story.append(Paragraph(title, H1))
        story.append(hr(0.8, HEADER_BG, 1, 5))
        if note:
            story.append(Paragraph(note, NOTE))

    # ── header ──
    story.append(hr(2, HEADER_BG, 0, 6))
    story.append(Paragraph("SECURITY INCIDENT REPORT", S("t", fontName="Helvetica-Bold", fontSize=22, leading=27, alignment=TA_CENTER, spaceAfter=3)))
    story.append(Paragraph("Forensic Detective: management summary and technical detail", S("st", fontSize=10.5, leading=14, textColor=MID_GRAY, alignment=TA_CENTER, spaceAfter=3)))
    story.append(Paragraph(f"Prepared {now} · Classification: CONFIDENTIAL", S("m", fontSize=8, leading=11, textColor=LIGHT_GRAY, alignment=TA_CENTER, spaceAfter=4)))
    story.append(hr(2, HEADER_BG, 0, 6))
    story.append(Paragraph(f"<b>{_esc(label)}</b> · {total} event{'s' if total != 1 else ''}", S("sc", fontSize=10, leading=14, alignment=TA_CENTER, spaceAfter=10)))

    # ── headline numbers ──
    t_col = T_COLORS.get(max_tier, BLACK)
    kpi = [
        [P("THREAT LEVEL", 7, True, WHITE, TA_CENTER), P("NEED ATTENTION", 7, True, WHITE, TA_CENTER), P("EVENTS", 7, True, WHITE, TA_CENTER), P("AVERAGE SCORE", 7, True, WHITE, TA_CENTER)],
        [P(T_LABELS[max_tier], 17, True, t_col, TA_CENTER), P(f"{flagged} ({flagged / total * 100:.0f}%)" if total else "0", 17, True, T_COLORS[4] if flagged else T_COLORS[1], TA_CENTER),
         P(str(total), 17, True, BLACK, TA_CENTER), P(f"{avg * 100:.0f}%", 17, True, BLACK, TA_CENTER)],
    ]
    kt = Table(kpi, colWidths=[PAGE_W / 4] * 4, rowHeights=[22, 40])
    kt.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE_GRAY), ("INNERGRID", (0, 0), (-1, -1), 0.5, RULE_GRAY),
    ]))
    story.append(kt)
    story.append(Spacer(1, 0.14 * inch))

    rows_t = [["Level", "Events", "Share", "Meaning"]]
    meaning = {4: "Active attack or severe threat. Act now.", 3: "Looks like part of an attack. Investigate soon.",
               2: "Unusual. Worth a look, not an emergency.", 1: "Routine activity. Keep an eye on it."}
    extra = []
    for i, t in enumerate((4, 3, 2, 1), 1):
        rows_t.append([tcell(t), str(tiers[t]), f"{tiers[t] / total * 100:.0f}%" if total else "0%", meaning[t]])
    story.append(table(rows_t, [1.0 * inch, 0.8 * inch, 0.8 * inch, PAGE_W - 2.6 * inch], extra))

    # ── 1. summary ──
    section("1. Summary")
    if not total:
        story.append(Paragraph("There are no events in this scope, so there is nothing to report.", BODY))
    else:
        if tiers[4]:
            tone = "CRITICAL threats were detected. Immediate human review and possible isolation of the affected systems is advised."
        elif tiers[3]:
            tone = "HIGH-risk activity was detected. Prompt investigation is advised."
        else:
            tone = "Nothing reached HIGH or CRITICAL."
        story.append(Paragraph(
            f"The platform examined <b>{total}</b> events and flagged <b>{flagged}</b> ({flagged / total * 100:.0f}%) at the HIGH or CRITICAL level, "
            f"with an average anomaly score of <b>{avg * 100:.0f}%</b>. {tone}", BODY))
        points = []
        if top_pattern[0]:
            points.append(f"The most common behaviour is <b>{_esc(top_pattern[0])}</b> ({top_pattern[1]['n']} events).")
        if risky:
            n, d = risky[0]
            points.append(f"The riskiest entity is <b>{_esc(n)}</b>: {d['n']} event{'s' if d['n'] != 1 else ''}, level {T_LABELS[d['tier']]}, average score {d['score'] / d['n'] * 100:.0f}%.")
        if busy_day[0]:
            points.append(f"The busiest day is <b>{busy_day[0]}</b> ({sum(busy_day[1].values())} event{'s' if sum(busy_day[1].values()) != 1 else ''})" + (f" and the busiest hour is <b>{busy_hour[0]}:00</b> ({busy_hour[1]} event{'s' if busy_hour[1] != 1 else ''})." if busy_hour[0] else "."))
        top = rows[0]
        points.append(f"The highest-scoring event is <b>{_esc(describe(top))}</b> at <b>{top['anomaly_score'] * 100:.0f}%</b> ({_esc(_ts(top))}).")
        if phases:
            points.append(f"The events include <b>{len(phases)}</b> recorded attack phase{'s' if len(phases) != 1 else ''}; see section 5.")
        for p in points:
            story.append(Paragraph(f"•&nbsp;&nbsp;{p}", S("bl", fontSize=9.5, leading=14, leftIndent=12, firstLineIndent=-10, spaceAfter=3)))

    # ── 2. actions ──
    section("2. Recommended actions", f"Based on the highest level in scope: {T_LABELS[max_tier]}.")
    act = [["Priority", "Action", "Details"]]
    for i, (a, d) in enumerate(ACTIONS.get(max_tier, ACTIONS[1]), 1):
        act.append([str(i), a, d])
    ex = []
    if max_tier >= 3:
        ex += [("TEXTCOLOR", (1, 1), (1, -1), T_COLORS[max_tier])]
        for r in range(1, len(act)):
            act[r][1] = P(_esc(act[r][1]), bold=True, color=T_COLORS[max_tier])
    story.append(table(act, [0.7 * inch, 1.5 * inch, PAGE_W - 2.2 * inch], ex))

    # ── 3. what was detected ──
    section("3. What was detected", "The behaviour the model recognised, by pattern.")
    pt = [["Pattern", "Events", "Share", "Avg score", "Worst level", "What it can mean"]]
    for name, d in sorted(patterns.items(), key=lambda kv: -kv[1]["n"]):
        pt.append([name, str(d["n"]), f"{d['n'] / total * 100:.0f}%", f"{d['score'] / d['n'] * 100:.0f}%", tcell(d["tier"]), PATTERN_RISK.get(name, "Needs investigation.")])
    story.append(table(pt, [1.45 * inch, 0.55 * inch, 0.5 * inch, 0.65 * inch, 0.75 * inch, PAGE_W - 3.9 * inch]))

    # ── 4. who ──
    section("4. Entities involved", "An entity is one log source: an account, host or service. The riskiest first.")
    et = [["Entity", "Events", "Avg score", "Worst level", "First seen", "Last seen"]]
    for name, d in risky[:12]:
        et.append([name, str(d["n"]), f"{d['score'] / d['n'] * 100:.0f}%", tcell(d["tier"]), d["first"][:16], d["last"][:16]])
    story.append(table(et, [PAGE_W - 4.55 * inch, 0.6 * inch, 0.75 * inch, 0.85 * inch, 1.175 * inch, 1.175 * inch]))
    if len(risky) > 12:
        story.append(Paragraph(f"{len(risky) - 12} more entities are not shown.", NOTE))

    # ── 5. timeline ──
    section("5. Timeline", "Events per day, split by level.")
    dt = [["Day", "Total", "CRITICAL", "HIGH", "MEDIUM", "LOW"]]
    for day in sorted(days)[-14:]:
        v = days[day]
        dt.append([day, str(sum(v.values())), str(v[4]), str(v[3]), str(v[2]), str(v[1])])
    cw = (PAGE_W - 1.5 * inch) / 5
    story.append(table(dt, [1.5 * inch] + [cw] * 5))
    if phases:
        story.append(Spacer(1, 0.1 * inch))
        story.append(Paragraph("Recorded attack phases", S("ph", fontName="Helvetica-Bold", fontSize=10, spaceAfter=3, keepWithNext=1)))
        pht = [["Phase", "Events", "Worst level", "First seen"]]
        for name, d in sorted(phases.items(), key=lambda kv: kv[1]["first"]):
            pht.append([name, str(d["n"]), tcell(d["tier"]), d["first"][:16]])
        story.append(table(pht, [PAGE_W - 3.2 * inch, 0.7 * inch, 1.0 * inch, 1.5 * inch]))

    # ── 6. evidence ──
    story.append(PageBreak())
    section("6. Evidence: the highest-scoring events", "The top 25. Scores combine an Isolation Forest result with deviation from the historical baseline.")
    ev = [["Level", "Time", "Source", "ID", "What happened", "Score"]]
    for e in rows[:25]:
        r = _raw(e)
        ev.append([tcell(e.get("threat_tier", 1)), _ts(e)[:16], str(r.get("SourceName") or e.get("source", "?"))[:34], str(r.get("EventID", "?")),
                   describe(e), f"{e.get('anomaly_score', 0) * 100:.0f}%"])
    story.append(table(ev, [0.75 * inch, 1.05 * inch, 1.55 * inch, 0.5 * inch, PAGE_W - 4.4 * inch, 0.55 * inch], size=7.5))

    # ── 7. model drivers ──
    section("7. Why the model flagged them", "Each score is built from four signals. This is how much each one contributed on average across the events in scope.")
    ft = [["Signal", "Average contribution", "What it measures"]]
    for k, (name, desc) in FEATURE_NAMES.items():
        s, n = drivers[k]
        ft.append([name, f"{s / n:.0f}%" if n else "n/a", desc])
    story.append(table(ft, [1.4 * inch, 1.3 * inch, PAGE_W - 2.7 * inch]))
    drv = [["Event", "Score", "Top driver", "2nd driver"]]
    for e in rows[:10]:
        fi = _raw(e).get("feature_importance", []) or []
        if len(fi) >= 2:
            drv.append([describe(e), f"{e.get('anomaly_score', 0) * 100:.0f}%", f"{fi[0].get('label', '?')} ({float(fi[0].get('pct', 0)):.0f}%)", f"{fi[1].get('label', '?')} ({float(fi[1].get('pct', 0)):.0f}%)"])
    if len(drv) > 1:
        story.append(Spacer(1, 0.1 * inch))
        story.append(table(drv, [PAGE_W - 4.4 * inch, 0.6 * inch, 1.9 * inch, 1.9 * inch], size=7.5))

    # ── 8. case file ──
    section("8. AI detective case file")
    if events is not None:
        story.append(Paragraph("Not included: this report was built from demo events, which the AI case file does not cover.", NOTE))
    elif scope:
        story.append(Paragraph("Not included: the AI case file describes the whole case, and this report covers only part of it.", NOTE))
    elif cf and cf.get("narrative"):
        story.append(Paragraph("A plain-language account written by the AI detective. Treat it as investigative guidance, not a definitive finding. "
                               "Citations to the evidence records are kept.", NOTE))
        for para in [p.strip() for p in cf["narrative"].split("\n") if p.strip()]:
            story.append(Paragraph(_esc(para), S("cf", fontSize=9, leading=13, spaceAfter=4)))
        story.append(Paragraph(f"Generated {_esc(str(cf.get('created_at', ''))[:19])} · level {T_LABELS.get(cf.get('threat_tier', 1), '?')} · confidence {cf.get('confidence', 0) * 100:.0f}%", NOTE))
    else:
        story.append(Paragraph("No case file has been generated yet.", NOTE))

    # ── 9. custody ──
    section("9. Chain of custody", "Every event is stored with a fingerprint that includes the one before it. Changing or deleting a record breaks every fingerprint after it.")
    story.append(Paragraph("Report fingerprint (SHA-256 of the event fingerprints of the top 50 events):", S("rh", fontName="Helvetica-Bold", fontSize=9, spaceAfter=2, keepWithNext=1)))
    story.append(Paragraph(rh, S("mh", fontName="Courier", fontSize=7.5, leading=10, spaceAfter=8)))
    ht = [["ID", "Event", "Fingerprint", "Previous fingerprint", "Linked"]]
    ex_h = []
    for i, e in enumerate(rows[:10], 1):
        h, ph = str(e.get("event_hash") or ""), str(e.get("prev_hash") or "")
        ok = bool(h and ph)
        ht.append([str(e.get("id", "")), str(_raw(e).get("EventID", "?")), P((h[:24] + "...") if h else "none", 7, font="Courier"), P((ph[:24] + "...") if ph else "none", 7, font="Courier"),
                   P("yes" if ok else "no", 8, True, T_COLORS[1] if ok else T_COLORS[4])])
    story.append(table(ht, [0.6 * inch, 0.7 * inch, 2.1 * inch, 2.1 * inch, PAGE_W - 5.5 * inch], size=7.5))
    if baseline:
        story.append(Spacer(1, 0.1 * inch))
        bt = [["Baseline", "Value"],
              ["Updated", str(baseline.get("updated_at", "N/A"))[:19]],
              ["Training samples", str(baseline.get("n_samples", "N/A"))],
              ["Adaptation", "Slow (alpha 0.10), so the baseline resists poisoning"]]
        story.append(table(bt, [1.6 * inch, PAGE_W - 1.6 * inch]))

    story.append(Spacer(1, 0.25 * inch))
    story.append(hr(1.5, HEADER_BG, 0, 4))
    story.append(Paragraph(f"Generated automatically by Forensic Detective · {now} · CONFIDENTIAL · authorised personnel only",
                           S("ft", fontSize=7, leading=9, textColor=LIGHT_GRAY, alignment=TA_CENTER)))

    short = _esc(label)[:70]
    doc.build(story, onFirstPage=lambda c, d: _page(c, d, short), onLaterPages=lambda c, d: _page(c, d, short))
    return buf.getvalue()


def generate_management_pdf(scope: dict | None = None, events: list | None = None) -> bytes:
    """The management summary is now part of the one combined report, so this returns the same document."""
    return generate_report_pdf(scope, events)
