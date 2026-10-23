import { useEffect, useState } from "react"
import axios from "axios"
import { API } from "./api"
import PxIcon from "./px/PxIcon"
import { tierOf } from "./px/cardModel"

// ─────────────────────────────────────────────────────────────
// RESPONSE: what the system WOULD do at each threat level. Nothing here runs anything.
// The four tarot-style cards are also the filter for the list below.
// ─────────────────────────────────────────────────────────────
const RULE_ICON = { 1: "scroll", 2: "bolt", 3: "response", 4: "skull" }

function RuleCard({ rule, active, count, onClick, i }) {
  const t = tierOf(rule.tier)
  const rows = [
    ["Action", rule.action],
    ["System does", rule.system_action || "Record to the forensic log only"],
    ["Analyst must", rule.analyst_action],
    ["Response time", rule.latency],
    ["Automation", rule.automation],
  ]
  return (
    <button
      onClick={onClick}
      className="pz-panel paper pz-fade-up"
      style={{ flex: "1 1 230px", minWidth: 220, textAlign: "left", padding: 0, overflow: "hidden", cursor: "pointer", color: "var(--ink)", animationDelay: `${i * 0.08}s`, transition: "transform .15s", outline: active ? "4px solid var(--gold)" : "none" }}
      onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-8px) rotate(-1deg)" }}
      onMouseLeave={e => { e.currentTarget.style.transform = "none" }}
      aria-pressed={active}
    >
      <div style={{ background: t.color, color: t.name === "MEDIUM" ? "#1d2527" : "#fff", padding: "8px 12px", display: "flex", alignItems: "center", gap: 10, borderBottom: "3px solid var(--ink)" }}>
        <PxIcon name={RULE_ICON[rule.tier] || "eye"} size={34} />
        <div style={{ flex: 1 }}>
          <div className="pz-title" style={{ fontSize: 22, lineHeight: 1, textShadow: t.name === "MEDIUM" ? "none" : undefined }}>{rule.label}</div>
          <div style={{ fontSize: 15, opacity: .9 }}>{rule.spec_tier}</div>
        </div>
        <span className="pz-tag" style={{ background: "var(--ink)" }}>{count}</span>
      </div>
      <div style={{ padding: "8px 12px 10px" }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ marginBottom: 6 }}>
            <div style={{ fontSize: 14, letterSpacing: ".12em", fontWeight: 700, color: "#6b7b78" }}>{k.toUpperCase()}</div>
            <div style={{ fontSize: 18, lineHeight: 1.15 }}>{v}</div>
          </div>
        ))}
      </div>
    </button>
  )
}

function Row({ item }) {
  const [open, setOpen] = useState(false)
  const t = tierOf(item.tier)
  const r = item.response
  return (
    <div style={{ marginBottom: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", cursor: "pointer", color: "#fff", fontFamily: "var(--pxfont)", fontSize: 19, padding: "6px 10px", background: "var(--panel)", border: "3px solid var(--ink)", borderRadius: 8, boxShadow: "0 3px 0 var(--ink)" }}
        aria-expanded={open}
      >
        <span className="pz-tag" style={{ background: t.color, minWidth: 74, textAlign: "center", color: t.name === "MEDIUM" ? "#1d2527" : "#fff", textShadow: t.name === "MEDIUM" ? "none" : undefined }}>{t.name}</span>
        <span style={{ minWidth: 150, color: "#9fb4b2", fontSize: 17 }}>{item.timestamp}</span>
        <span style={{ minWidth: 56, color: "#cfe0dd" }}>#{item.event_id ?? "?"}</span>
        <span style={{ flex: 1, minWidth: 0, color: item.phase ? "var(--red)" : "#9fb4b2", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.phase || item.source || "-"}</span>
        <span style={{ fontWeight: 700, color: t.color, minWidth: 44 }}>{item.anomaly_score}%</span>
        <span className="pz-tag" style={{ background: t.dark, minWidth: 130, textAlign: "center" }}>{r.label}</span>
        <span style={{ color: "#9fb4b2", width: 14 }}>{open ? "-" : "+"}</span>
      </button>
      {open && (
        <div className="pz-inset pz-bounce-in" style={{ margin: "6px 0 0 14px", padding: "10px 14px", display: "flex", gap: 20, flexWrap: "wrap" }}>
          {[["System action", r.system_action || "Record to forensic log"], ["Analyst required", r.analyst_action], ["Response time", `${r.latency}, ${r.automation}`]].map(([k, v]) => (
            <div key={k} style={{ flex: "1 1 200px" }}>
              <div className="pz-label" style={{ fontSize: 14 }}>{k}</div>
              <div style={{ fontSize: 19, lineHeight: 1.2 }}>{v}</div>
            </div>
          ))}
          {item.phase && <div style={{ color: "var(--red)", fontWeight: 700 }}>Attack phase: {item.phase}</div>}
        </div>
      )}
    </div>
  )
}

export default function ResponseSimulation() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState(0)

  useEffect(() => {
    axios.get(`${API}/response-simulation`).then(r => { setData(r.data); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: 40, textAlign: "center" }} className="pz-title">Loading response simulation...</div>
  if (!data) return <div style={{ padding: 40, textAlign: "center" }} className="pz-title">No data. Run a scan first.</div>

  const rules = Object.values(data.response_rules).sort((a, b) => a.tier - b.tier)
  const list = filter === 0 ? data.simulated_responses : data.simulated_responses.filter(r => r.tier === filter)

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "0 160px 24px 20px" }}>
      <div className="pz-label" style={{ marginBottom: 2 }}>Active mitigation strategy</div>
      <div style={{ fontSize: 18, color: "#cfe0dd", marginBottom: 10 }}>{data.spec_note} Click a card to filter the list.</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 20 }}>
        {rules.map((rule, i) => (
          <RuleCard key={rule.tier} rule={rule} i={i} active={filter === rule.tier} count={data.tier_summary[rule.tier] || 0} onClick={() => setFilter(filter === rule.tier ? 0 : rule.tier)} />
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <span className="pz-title" style={{ fontSize: 23 }}>Simulated responses</span>
        <span className="pz-pill">{list.length} events</span>
        {filter !== 0 && <button className="pz-btn gray small" onClick={() => setFilter(0)}>Clear filter</button>}
      </div>
      {list.length === 0 && <div className="pz-panel" style={{ padding: 16 }}>No events match this filter.</div>}
      {list.map(item => <Row key={item.event_db_id} item={item} />)}
    </div>
  )
}
