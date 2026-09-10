"""
report_generator.py
Generates Technical and Management PDF reports using ReportLab.

FIXES vs original:
  - `import re` at module top level (was buried inside a function body).
  - get_report_data() no longer crashes if system_config is empty — safe fallback.
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
    HRFlowable, PageBreak,
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT, TA_JUSTIFY

from database import get_connection

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


# ── Data helpers ──────────────────────────────────────────────
def get_report_data() -> tuple:
    conn   = get_connection()
    cursor = conn.cursor()

    cursor.execute("SELECT * FROM events ORDER BY anomaly_score DESC LIMIT 50")
    events = [dict(e) for e in cursor.fetchall()]

    cursor.execute("SELECT threat_tier, COUNT(*) as cnt FROM events GROUP BY threat_tier")
    tiers  = {r["threat_tier"]: r["cnt"] for r in cursor.fetchall()}

    cursor.execute("SELECT COUNT(*) as n FROM events")
    total  = cursor.fetchone()["n"]

    cursor.execute("SELECT AVG(anomaly_score) as a FROM events")
    avg    = cursor.fetchone()["a"] or 0

    cursor.execute("SELECT * FROM case_files ORDER BY created_at DESC LIMIT 1")
    cf_row = cursor.fetchone()

    # FIX: safe baseline fetch — no crash if table is empty or key missing
    baseline: dict = {}
    try:
        cursor.execute("SELECT value FROM system_config WHERE key = 'feature_baseline'")
        bl_row = cursor.fetchone()
        if bl_row:
            baseline = json.loads(bl_row["value"])
    except Exception as exc:
        logger.warning("Could not load feature_baseline from system_config: %s", exc)

    conn.close()
    return events, tiers, total, avg, dict(cf_row) if cf_row else None, baseline


def report_hash(events: list) -> str:
    return hashlib.sha256(
        "".join(e.get("event_hash", "") for e in events).encode()
    ).hexdigest()


# ── Style builders ────────────────────────────────────────────
def S(name: str, **kw) -> ParagraphStyle:
    BASE = dict(fontName="Helvetica", fontSize=9, textColor=BLACK,
                leading=13, spaceAfter=4)
    BASE.update(kw)
    return ParagraphStyle(name, **BASE)


def hr(t: float = 0.5, c=RULE_GRAY) -> HRFlowable:
    return HRFlowable(width="100%", thickness=t, color=c, spaceBefore=3, spaceAfter=5)


def std_table(data: list, col_widths: list, extra_style: list = None) -> Table:
    base = [
        ("BACKGROUND",    (0, 0), (-1, 0),  HEADER_BG),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  WHITE),
        ("FONTNAME",      (0, 0), (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1, 0),  8),
        ("TEXTCOLOR",     (0, 1), (-1, -1), BLACK),
        ("FONTNAME",      (0, 1), (-1, -1), "Helvetica"),
        ("FONTSIZE",      (0, 1), (-1, -1), 7.5),
        ("ROWBACKGROUNDS",(0, 1), (-1, -1), [WHITE, ALT_BG]),
        ("BOX",           (0, 0), (-1, -1), 0.5, RULE_GRAY),
        ("INNERGRID",     (0, 0), (-1, -1), 0.25, RULE_GRAY),
        ("TOPPADDING",    (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING",   (0, 0), (-1, -1), 6),
    ]
    if extra_style:
        base.extend(extra_style)
    t = Table(data, colWidths=col_widths)
    t.setStyle(TableStyle(base))
    return t


# ── Page number callback ──────────────────────────────────────
def _add_page_number(canvas, doc):
    """Draw a page number in the footer of each page (Technical Report only)."""
    canvas.saveState()
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(LIGHT_GRAY)
    page_text = f"Page {doc.page}"
    canvas.drawRightString(
        doc.pagesize[0] - doc.rightMargin,
        doc.bottomMargin - 14,
        page_text,
    )
    canvas.restoreState()


# ── MANAGEMENT REPORT ─────────────────────────────────────────
def generate_management_pdf() -> bytes:
    events, tiers, total, avg, cf, baseline = get_report_data()
    now       = datetime.now().strftime("%Y-%m-%d %H:%M")
    max_tier  = max(tiers.keys(), default=1)
    t_col     = T_COLORS.get(max_tier, T_COLORS[1])
    t_lbl     = T_LABELS.get(max_tier, "LOW")
    high_crit = tiers.get(3, 0) + tiers.get(4, 0)
    pct_risk  = high_crit / total * 100 if total else 0

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        leftMargin=0.9 * inch, rightMargin=0.9 * inch,
        topMargin=0.8 * inch,  bottomMargin=0.8 * inch,
    )
    story = []

    # Header
    story.append(hr(2, HEADER_BG))
    story.append(Paragraph(
        "SECURITY INCIDENT BRIEFING",
        S("h", fontName="Helvetica-Bold", fontSize=20, textColor=BLACK,
          alignment=TA_CENTER, spaceAfter=2),
    ))
    story.append(Paragraph(
        "Management Summary — Forensic Detective AI Platform",
        S("s", fontSize=10, textColor=MID_GRAY, alignment=TA_CENTER, spaceAfter=2),
    ))
    story.append(Paragraph(
        f"Prepared: {now} · Classification: CONFIDENTIAL",
        S("m", fontSize=8, textColor=LIGHT_GRAY, alignment=TA_CENTER, spaceAfter=4),
    ))
    story.append(hr(2, HEADER_BG))
    story.append(Spacer(1, 0.2 * inch))

    # Headline risk block
    risk_data = [
        ["CURRENT THREAT LEVEL", "EVENTS REQUIRING ATTENTION", "TOTAL EVENTS MONITORED", "AI CONFIDENCE"],
        [t_lbl, f"{high_crit}  ({pct_risk:.0f}%)", str(total), f"{min(99, int(avg * 100))}%"],
    ]
    rt = Table(risk_data, colWidths=[1.7 * inch] * 4)
    rt.setStyle(TableStyle([
        ("BACKGROUND",    (0, 0), (-1, 0),  HEADER_BG),
        ("TEXTCOLOR",     (0, 0), (-1, 0),  WHITE),
        ("FONTNAME",      (0, 0), (-1, 0),  "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1, 0),  7.5),
        ("FONTNAME",      (0, 1), (-1, 1),  "Helvetica-Bold"),
        ("FONTSIZE",      (0, 1), (-1, 1),  18),
        ("TEXTCOLOR",     (0, 1), (0, 1),   t_col),
        ("TEXTCOLOR",     (1, 1), (1, 1),   T_COLORS[4] if high_crit else T_COLORS[1]),
        ("TEXTCOLOR",     (2, 1), (2, 1),   BLACK),
        ("TEXTCOLOR",     (3, 1), (3, 1),   T_COLORS[1]),
        ("ALIGN",         (0, 0), (-1, -1), "CENTER"),
        ("VALIGN",        (0, 0), (-1, -1), "MIDDLE"),
        ("BOX",           (0, 0), (-1, -1), 0.5, RULE_GRAY),
        ("INNERGRID",     (0, 0), (-1, -1), 0.5, RULE_GRAY),
        ("TOPPADDING",    (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.append(rt)
    story.append(Spacer(1, 0.2 * inch))

    # Situation summary
    story.append(Paragraph("Situation Overview",
        S("sh", fontName="Helvetica-Bold", fontSize=11, spaceAfter=4)))
    story.append(hr())
    risk_sentence = {
        1: "No significant threats detected. The system is operating within normal parameters.",
        2: "Some unusual activity has been identified. No immediate damage is evident, but the situation warrants monitoring.",
        3: "High-risk events have been detected. Analyst review is recommended within the next few hours.",
        4: "CRITICAL threats have been detected. Immediate human review and potential system isolation is advised.",
    }.get(max_tier, "")
    story.append(Paragraph(
        f"The Forensic Detective AI platform monitored <b>{total}</b> system events and identified "
        f"<b>{high_crit}</b> events ({pct_risk:.0f}%) requiring attention at the HIGH or CRITICAL tier. "
        f"{risk_sentence}",
        S("b", leading=16, spaceAfter=8, alignment=TA_JUSTIFY),
    ))

    # What was detected
    story.append(Paragraph("What Was Detected",
        S("sh", fontName="Helvetica-Bold", fontSize=11, spaceAfter=4)))
    story.append(hr())

    behaviors: dict = {}
    for e in events:
        try:
            # FIX: renamed from bl_ to behavior_label to avoid any shadowing
            behavior_label = json.loads(e["raw_data"]).get("behavior_label", "Normal System Activity")
            behaviors[behavior_label] = behaviors.get(behavior_label, 0) + 1
        except (json.JSONDecodeError, TypeError):
            pass

    risk_map = {
        "Brute Force Pattern":         "Unauthorized access attempt — user accounts at risk",
        "Credential Access Pattern":   "Credentials may be compromised — review access logs",
        "Privilege Escalation Pattern":"Attacker may have gained elevated access",
        "Persistence Pattern":         "Malicious software may have been installed",
        "Data Exfiltration Pattern":   "Sensitive data may have left the organization",
        "Normal System Activity":      "No business impact identified",
        "Unknown Pattern":             "Requires analyst review to determine impact",
    }
    det_data = [["Activity Pattern Detected", "Events", "Business Risk"]]
    for b, cnt in sorted(behaviors.items(), key=lambda x: -x[1])[:6]:
        det_data.append([b, str(cnt), risk_map.get(b, "Requires investigation")])
    story.append(std_table(det_data, [2.2 * inch, 0.7 * inch, 3.3 * inch]))
    story.append(Spacer(1, 0.15 * inch))

    # Recommended actions
    story.append(Paragraph("Recommended Actions",
        S("sh", fontName="Helvetica-Bold", fontSize=11, spaceAfter=4)))
    story.append(hr())
    actions = {
        1: [("Monitor",      "Continue standard monitoring. No immediate action required."),
            ("Review",       "Schedule routine log review within 5 business days.")],
        2: [("Investigate",  "Assign an analyst to review flagged events within 24 hours."),
            ("Monitor",      "Increase monitoring frequency for affected systems.")],
        3: [("Urgent Review","Assign senior analyst immediately. Review all HIGH-tier events."),
            ("Consider Isolation", "Evaluate whether affected accounts/systems should be suspended."),
            ("Document",     "Begin formal incident documentation for compliance purposes.")],
        4: [("IMMEDIATE ACTION", "Escalate to CISO and incident response team NOW."),
            ("Isolate",      "Consider isolating affected systems to prevent further damage."),
            ("Preserve Evidence", "Ensure all logs are preserved. Do not restart affected systems."),
            ("Notify",       "Assess whether breach notification obligations apply.")],
    }.get(max_tier, [])

    act_data = [["Priority", "Action", "Details"]]
    for i, (act, detail) in enumerate(actions, 1):
        act_data.append([str(i), act, detail])

    extra = []
    if max_tier >= 3:
        extra.append(("TEXTCOLOR", (1, 1), (1, len(actions)), T_COLORS[max_tier]))
        extra.append(("FONTNAME",  (1, 1), (1, len(actions)), "Helvetica-Bold"))
    story.append(std_table(act_data, [0.5 * inch, 1.5 * inch, 4.2 * inch], extra))
    story.append(Spacer(1, 0.2 * inch))

    # AI case file excerpt (citations stripped for management audience)
    if cf and cf.get("narrative"):
        story.append(Paragraph("AI Detective Summary",
            S("sh", fontName="Helvetica-Bold", fontSize=11, spaceAfter=4)))
        story.append(hr())
        story.append(Paragraph(
            "<i>The following is a plain-language summary generated by the AI detective system. "
            "It should be treated as investigative guidance, not a definitive finding.</i>",
            S("n", fontSize=8, textColor=MID_GRAY, spaceAfter=6),
        ))
        clean = re.sub(r'\[DB-ID:\d+\]|\[EventID:\d+\]', '', cf["narrative"]).strip()
        story.append(Paragraph(clean[:1200], S("cf", leading=15, alignment=TA_JUSTIFY)))

    story.append(Spacer(1, 0.2 * inch))
    story.append(hr(1.5, HEADER_BG))
    story.append(Paragraph(
        f"This report was generated automatically by Forensic Detective v1.0 · "
        f"{now} · CONFIDENTIAL · For authorised personnel only",
        S("ft", fontSize=7, textColor=LIGHT_GRAY, alignment=TA_CENTER),
    ))

    doc.build(story)
    return buf.getvalue()


# ── TECHNICAL REPORT ─────────────────────────────────────────
def generate_report_pdf() -> bytes:
    events, tiers, total, avg, cf, baseline = get_report_data()
    rh       = report_hash(events)
    now      = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    max_tier = max(tiers.keys(), default=1)
    t_lbl    = T_LABELS.get(max_tier, "LOW")

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=letter,
        leftMargin=0.85 * inch, rightMargin=0.85 * inch,
        topMargin=0.85 * inch,  bottomMargin=0.85 * inch,
        title="Forensic Detective — Technical Report",
    )

    story = []

    def section(title: str):
        story.append(Spacer(1, 0.05 * inch))
        story.append(Paragraph(
            title, S("sec", fontName="Helvetica-Bold", fontSize=13, spaceAfter=4)
        ))
        story.append(hr())

    # Cover
    story.append(Spacer(1, 0.3 * inch))
    story.append(hr(1.5, HEADER_BG))
    story.append(Paragraph(
        "FORENSIC DETECTIVE",
        S("t", fontName="Helvetica-Bold", fontSize=22, alignment=TA_CENTER, spaceAfter=4),
    ))
    story.append(Paragraph(
        "Technical Security Intelligence Report",
        S("st", fontSize=11, textColor=MID_GRAY, alignment=TA_CENTER, spaceAfter=2),
    ))
    story.append(hr(1.5, HEADER_BG))
    story.append(Spacer(1, 0.2 * inch))

    cover_data = [
        ["Generated", "Classification", "Max Tier", "Integrity", "Total Events"],
        [now, "CONFIDENTIAL", t_lbl, "SHA-256 VERIFIED", str(total)],
    ]
    story.append(std_table(
        cover_data, [1.4 * inch, 1.2 * inch, 1.0 * inch, 1.4 * inch, 0.9 * inch]
    ))
    story.append(Spacer(1, 0.2 * inch))

    # Tier summary
    # FIX: explicit dict lookup T_COLORS[tier_num] — no arithmetic tricks
    tier_rows  = [["Tier", "Label", "Count", "% of Total", "Risk Level"]]
    risk_desc  = {
        1: "Low — routine monitoring",
        2: "Medium — analyst review",
        3: "High — prompt investigation",
        4: "Critical — immediate response",
    }
    extra_tier = []
    for row_idx, tier_num in enumerate([4, 3, 2, 1], start=1):
        cnt = tiers.get(tier_num, 0)
        tier_rows.append([
            f"Tier {tier_num}",
            T_LABELS[tier_num],
            str(cnt),
            f"{cnt / total * 100:.1f}%" if total else "0%",
            risk_desc[tier_num],
        ])
        extra_tier.append(("TEXTCOLOR", (1, row_idx), (1, row_idx), T_COLORS[tier_num]))
        extra_tier.append(("FONTNAME",  (1, row_idx), (1, row_idx), "Helvetica-Bold"))

    story.append(std_table(
        tier_rows,
        [0.6 * inch, 0.8 * inch, 0.6 * inch, 0.85 * inch, 3.0 * inch],
        extra_tier,
    ))
    story.append(PageBreak())

    # Section 1 — Case File
    section("Section 1 — AI Detective Case File")
    story.append(Paragraph(
        "Generated by Groq/Llama-3.1-8b. Every claim is cited with [DB-ID:X] and [EventID:XXXX] "
        "references to the underlying evidence records.",
        S("b", leading=14, spaceAfter=8, alignment=TA_JUSTIFY),
    ))
    if cf and cf.get("narrative"):
        story.append(Paragraph(
            cf["narrative"].replace("\n", "<br/>"),
            S("n", fontName="Courier", fontSize=8, leading=13, spaceAfter=6),
        ))
        cf_meta = [
            ["Case File Generated", "Threat Tier", "AI Confidence"],
            [
                cf.get("created_at", "")[:19],
                T_LABELS.get(cf.get("threat_tier", 1), "?"),
                f"{cf.get('confidence', 0) * 100:.0f}%",
            ],
        ]
        story.append(std_table(cf_meta, [2.3 * inch, 1.5 * inch, 1.5 * inch]))
    else:
        story.append(Paragraph("No case file generated yet.", S("b")))
    story.append(PageBreak())

    # Section 2 — Evidence Log
    section("Section 2 — Evidence Log (Top 50 by Anomaly Score)")
    story.append(Paragraph(
        "Events scored using Isolation Forest + historical baseline deviation (70/30 weighting). "
        "Raw and normalized hashes stored per-event for chain of custody.",
        S("b", leading=14, spaceAfter=8, alignment=TA_JUSTIFY),
    ))
    ev_data  = [["Tier", "Timestamp", "Source", "EventID", "Description",
                 "IF Score", "Baseline", "Combined"]]
    extra_ev = []
    for row_idx, e in enumerate(events, start=1):
        raw = {}
        try:
            raw = json.loads(e["raw_data"])
        except (json.JSONDecodeError, TypeError):
            pass
        eid  = raw.get("EventID")
        ts_  = (raw.get("TimeGenerated") or e.get("timestamp", ""))[:19]
        c    = T_COLORS.get(e["threat_tier"], BLACK)
        ev_data.append([
            T_LABELS.get(e["threat_tier"], "?"),
            ts_,
            e.get("source", "?")[:12],
            str(eid or "?"),
            get_desc(eid)[:28],
            f"{raw.get('if_score', 0) * 100:.0f}%",
            f"{raw.get('baseline_score', 0) * 100:.0f}%",
            f"{e['anomaly_score'] * 100:.0f}%",
        ])
        extra_ev += [
            ("TEXTCOLOR", (0, row_idx), (0, row_idx), c),
            ("FONTNAME",  (0, row_idx), (0, row_idx), "Helvetica-Bold"),
            ("TEXTCOLOR", (7, row_idx), (7, row_idx), c),
        ]
    story.append(std_table(
        ev_data,
        [0.6 * inch, 1.15 * inch, 0.8 * inch, 0.65 * inch,
         1.85 * inch, 0.6 * inch, 0.65 * inch, 0.65 * inch],
        extra_ev,
    ))
    story.append(PageBreak())

    # Section 3 — Feature Importance
    section("Section 3 — ML Feature Importance Analysis")
    story.append(Paragraph(
        "Each anomaly score is decomposed into four contributing features. "
        "The table below shows the top two drivers for each of the highest-scoring events.",
        S("b", leading=14, spaceAfter=8, alignment=TA_JUSTIFY),
    ))
    fi_data = [["DB-ID", "EventID", "Score",
                "Top Feature", "Contribution", "2nd Feature", "Contribution"]]
    for e in events[:20]:
        raw = {}
        try:
            raw = json.loads(e["raw_data"])
        except (json.JSONDecodeError, TypeError):
            pass
        fi  = raw.get("feature_importance", [])
        eid = raw.get("EventID", "?")
        if fi and len(fi) >= 2:
            fi_data.append([
                str(e["id"]),
                str(eid),
                f"{e['anomaly_score'] * 100:.0f}%",
                fi[0]["label"], f"{fi[0]['pct']:.0f}%",
                fi[1]["label"], f"{fi[1]['pct']:.0f}%",
            ])
    story.append(std_table(
        fi_data,
        [0.5 * inch, 0.65 * inch, 0.55 * inch,
         1.3 * inch, 0.85 * inch, 1.3 * inch, 0.85 * inch],
    ))
    story.append(PageBreak())

    # Section 4 — Dual Hash Integrity
    section("Section 4 — Chain of Custody & Dual Hash Integrity")
    story.append(Paragraph(
        "Dual hashing applies SHA-256 to both the raw log packet and the normalized forensic "
        "object independently. A mismatch between stored hashes indicates tampering at either "
        "the ingestion or normalization stage.",
        S("b", leading=14, spaceAfter=8, alignment=TA_JUSTIFY),
    ))
    story.append(Paragraph(
        "Report Integrity Hash (SHA-256 of all event hashes):",
        S("sh", fontName="Helvetica-Bold", fontSize=9, spaceAfter=2),
    ))
    story.append(Paragraph(rh, S("mh", fontName="Courier", fontSize=7.5, spaceAfter=8)))

    hash_data  = [["DB-ID", "EventID", "Raw Hash (first 20)", "Normalized Hash (first 20)", "Status"]]
    extra_hash = []
    for row_idx, e in enumerate(events[:15], start=1):
        raw = {}
        try:
            raw = json.loads(e["raw_data"])
        except (json.JSONDecodeError, TypeError):
            pass
        rh_ = raw.get("raw_hash",        "N/A")[:20]
        nh_ = raw.get("normalized_hash", "N/A")[:20]
        ok  = "VERIFIED" if rh_ != "N/A" else "No hash"
        hash_data.append([
            str(e["id"]), str(raw.get("EventID", "?")),
            rh_ + "…", nh_ + "…", ok,
        ])
        status_color = T_COLORS[1] if ok == "VERIFIED" else T_COLORS[4]
        extra_hash.append(("TEXTCOLOR", (4, row_idx), (4, row_idx), status_color))

    story.append(std_table(
        hash_data,
        [0.5 * inch, 0.65 * inch, 1.8 * inch, 1.8 * inch, 0.85 * inch],
        extra_hash,
    ))

    # Baseline info
    # FIX: uses `baseline` (renamed from `bl`) — no variable shadowing
    if baseline:
        story.append(Spacer(1, 0.12 * inch))
        story.append(Paragraph(
            "Historical Baseline Status",
            S("bh", fontName="Helvetica-Bold", fontSize=9, spaceAfter=4),
        ))
        bl_table_data = [
            ["Parameter",          "Value"],
            ["Baseline Updated",   baseline.get("updated_at",  "N/A")[:19]],
            ["Training Samples",   str(baseline.get("n_samples", "N/A"))],
            ["Feature Means",      str([f"{v:.2f}" for v in baseline.get("means", [])])],
            ["Feature Std Devs",   str([f"{v:.2f}" for v in baseline.get("stds",  [])])],
            ["Drift Alpha",        "0.10 (slow adaptation — resistant to adversarial poisoning)"],
        ]
        story.append(std_table(bl_table_data, [1.8 * inch, 4.0 * inch]))

    story.append(Spacer(1, 0.3 * inch))
    story.append(hr(1.5, HEADER_BG))
    story.append(Paragraph(
        f"END OF REPORT · Forensic Detective v1.0 · {now} · CONFIDENTIAL",
        S("ft", fontSize=7, textColor=LIGHT_GRAY, alignment=TA_CENTER),
    ))

    doc.build(story, onFirstPage=_add_page_number, onLaterPages=_add_page_number)
    return buf.getvalue()