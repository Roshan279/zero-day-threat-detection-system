import { useEffect, useState } from "react"
import axios from "axios"
import { API } from "./api"
import PxIcon from "./px/PxIcon"
import { Btn } from "./px/ui"
import { tierOf } from "./px/cardModel"

// ─────────────────────────────────────────────────────────────
// ML SCORES: why the model flagged things, feature by feature.
// Each feature is a card; each flagged event shows what drove its score.
// ─────────────────────────────────────────────────────────────
const FEATURE = {
  hour_of_day:     { color: "#0093ff", icon: "clock" },
  event_id_mod:    { color: "#ff9a00", icon: "key" },
  log_source:      { color: "#4bc292", icon: "scroll" },
  event_type_risk: { color: "#fe5f55", icon: "warn" },
}
const fc = (f) => FEATURE[f]?.color || "#8a9a9a"

function Meter({ pct, color, delay = 0 }) {
  return (
    <div style={{ height: 16, background: "#1b2829", border: "3px solid var(--ink)", borderRadius: 5, overflow: "hidden" }}>
      <div className="pz-bar" style={{ width: `${Math.max(2, Math.min(100, pct))}%`, height: "100%", background: color, boxShadow: "inset 0 -4px 0 rgba(0,0,0,.25), inset 0 2px 0 rgba(255,255,255,.25)", animationDelay: `${delay}s` }} />
    </div>
  )
}

function FeatureCard({ f, i, active, onClick }) {
  const meta = FEATURE[f.feature] || {}
  return (
    <button
      onClick={onClick}
      className="pz-panel paper pz-fade-up"
      style={{ flex: "1 1 190px", minWidth: 170, textAlign: "left", padding: 12, cursor: "pointer", animationDelay: `${i * 0.08}s`, transition: "transform .15s", outline: active ? "4px solid var(--gold)" : "none", color: "var(--ink)" }}
      onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-6px) rotate(-1deg)" }}
      onMouseLeave={e => { e.currentTarget.style.transform = "none" }}
      aria-pressed={active}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PxIcon name={meta.icon || "eye"} size={34} />
        <div style={{ flex: 1, fontWeight: 700, fontSize: 22, lineHeight: 1 }}>{f.label}</div>
        <div style={{ fontWeight: 700, fontSize: 31, color: meta.color }}>{f.avg_pct}%</div>
      </div>
      <div style={{ margin: "8px 0" }}><Meter pct={f.avg_pct} color={meta.color} delay={i * 0.08} /></div>
      <div style={{ fontSize: 17, lineHeight: 1.2, color: "#3e4d4b" }}>{f.description}</div>
    </button>
  )
}

function EventRow({ ev, selected, onClick }) {
  const t = tierOf(ev.tier)
  const top = ev.features?.[0]
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", cursor: "pointer", color: "#fff",
        padding: "6px 10px", marginBottom: 6, background: selected ? "#43595e" : "var(--panel)", fontFamily: "var(--pxfont)", fontSize: 19,
        border: "3px solid var(--ink)", borderRadius: 8, boxShadow: selected ? `0 0 0 3px ${t.color}` : "0 3px 0 var(--ink)", transition: "transform .1s",
      }}
      onMouseEnter={e => { e.currentTarget.style.transform = "translateX(4px)" }}
      onMouseLeave={e => { e.currentTarget.style.transform = "none" }}
    >
      <span className="pz-tag" style={{ background: t.color, minWidth: 74, textAlign: "center", color: t.name === "MEDIUM" ? "#1d2527" : "#fff", textShadow: t.name === "MEDIUM" ? "none" : undefined }}>{t.name}</span>
      <span style={{ minWidth: 64, color: "#9fb4b2" }}>#{ev.event_id ?? "?"}</span>
      <span style={{ flex: 1, minWidth: 0, color: "#9fb4b2", fontSize: 17, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ev.timestamp}</span>
      {top && <span style={{ color: fc(top.feature), fontWeight: 600, minWidth: 120, whiteSpace: "nowrap" }}>{top.label}</span>}
      <span style={{ fontWeight: 700, color: t.color, minWidth: 44, textAlign: "right" }}>{ev.anomaly_score}%</span>
    </button>
  )
}

function Detail({ ev, onAsk }) {
  if (!ev) {
    return (
      <div className="pz-panel" style={{ padding: 18, textAlign: "center" }}>
        <PxIcon name="ml" size={46} style={{ margin: "0 auto 8px" }} />
        <div className="pz-title" style={{ fontSize: 23 }}>Pick an event</div>
        <div style={{ color: "#9fb4b2", fontSize: 18, marginTop: 4 }}>See which features pushed its score up.</div>
      </div>
    )
  }
  const t = tierOf(ev.tier)
  return (
    <div className="pz-panel paper pz-bounce-in" style={{ padding: 14, color: "var(--ink)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 44, color: t.dark, lineHeight: 1 }}>{ev.anomaly_score}%</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 22, lineHeight: 1 }}>Event #{ev.event_id ?? "?"}</div>
          <div style={{ fontSize: 15, color: "#6b7b78" }}>DB-{ev.event_db_id} · {ev.timestamp}</div>
        </div>
        <span className="pz-tag" style={{ background: t.color, color: t.name === "MEDIUM" ? "#1d2527" : "#fff", textShadow: t.name === "MEDIUM" ? "none" : undefined }}>{t.name}</span>
      </div>
      <div style={{ marginTop: 12 }}>
        {ev.features?.map((f, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 19 }}>
              <span style={{ color: fc(f.feature) }}>{f.label}</span><span>{f.pct.toFixed(1)}%</span>
            </div>
            <Meter pct={f.pct} color={fc(f.feature)} delay={i * 0.06} />
            <div style={{ fontSize: 15, color: "#4b5a58", marginTop: 2, lineHeight: 1.2 }}>{f.description}</div>
          </div>
        ))}
      </div>
      <Btn color="blue" style={{ width: "100%" }} onClick={() => onAsk && onAsk(ev)}>Ask Luffy about this</Btn>
    </div>
  )
}

export default function FeatureImportance({ onAskLuffy }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [feature, setFeature] = useState(null)

  useEffect(() => {
    axios.get(`${API}/feature-importance`).then(r => { setData(r.data); setLoading(false) }).catch(() => setLoading(false))
  }, [])

  if (loading) return <div style={{ padding: 40, textAlign: "center" }} className="pz-title">Computing feature importance...</div>
  if (!data) return <div style={{ padding: 40, textAlign: "center" }} className="pz-title">No data yet. Run a scan first.</div>

  const events = (data.per_event || []).filter(ev => !feature || ev.features?.[0]?.feature === feature)

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "0 160px 24px 20px" }}>
      <div className="pz-label" style={{ marginBottom: 6 }}>What the model looks at. Click a card to filter the events by their top driver.</div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 18 }}>
        {(data.aggregate || []).map((f, i) => (
          <FeatureCard key={f.feature} f={f} i={i} active={feature === f.feature} onClick={() => setFeature(feature === f.feature ? null : f.feature)} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 460px", minWidth: 0 }}>
          <div className="pz-label" style={{ marginBottom: 6 }}>Flagged events {feature ? "(filtered)" : ""}</div>
          {events.length === 0 && <div className="pz-panel" style={{ padding: 16 }}>No events with that top driver.</div>}
          {events.map(ev => (
            <EventRow key={ev.event_db_id} ev={ev} selected={selected?.event_db_id === ev.event_db_id} onClick={() => setSelected(ev)} />
          ))}
        </div>
        <div style={{ flex: "0 0 320px", position: "sticky", top: 0 }}>
          <Detail ev={selected} onAsk={onAskLuffy} />
        </div>
      </div>
    </div>
  )
}
