import { useEffect, useState } from "react"
import axios from "axios"
import { API } from "./api"
import PxIcon from "./px/PxIcon"
import { Btn } from "./px/ui"
import { cardFace } from "./px/cardModel"
import { buildRichContext, explainTier, formatTimestamp } from "./Humanlog"
import { sanitizeField } from "./sanitize"
import LuffyExplain from "./LuffyExplain"

// Re-enable a blocked entity
function UnblockButton({ entity, onDone }) {
  const [state, setState] = useState("idle")   // idle | loading | done | failed
  const go = async () => {
    setState("loading")
    try {
      const res = await axios.post(`${API}/unblock-entity`, { entity, entity_type: "auto", triggered_by: "ui" })
      setState(res.data.success ? "done" : "failed")
      if (res.data.success && onDone) onDone()
    } catch { setState("failed") }
  }
  if (state === "done")   return <div className="pz-tag" style={{ background: "var(--green-d)", display: "block", textAlign: "center", padding: 6 }}>Unblocked</div>
  if (state === "failed") return <div className="pz-tag" style={{ background: "var(--red-d)", display: "block", textAlign: "center", padding: 6 }}>Unblock failed: check the backend</div>
  return <Btn color="green" style={{ width: "100%" }} disabled={state === "loading"} onClick={go}>{state === "loading" ? "Unblocking..." : "Unblock this entity"}</Btn>
}

function Section({ title, children, tone, delay = 0 }) {
  return (
    <div className="pz-fade-up" style={{ marginBottom: 12, animationDelay: `${delay}s`, breakInside: "avoid" }}>
      <div style={{ fontSize: 15, letterSpacing: ".12em", fontWeight: 700, color: "#6b7b78", marginBottom: 4 }}>{title}</div>
      <div style={{ border: "3px solid var(--ink)", borderRadius: 8, padding: "8px 10px", background: tone || "#fff", fontSize: 19, lineHeight: 1.25 }}>{children}</div>
    </div>
  )
}

// The full detail of one event, shown as a big card with actions
export default function CaseFile({ event, onAskLuffy, onBlockEntity, onClose, wide = false, inlineLuffy = false }) {
  const [blocked, setBlocked]   = useState(false)
  const [blocking, setBlocking] = useState(false)
  const [integrity, setIntegrity] = useState(null)
  const [note, setNote] = useState(0)          // Luffy's note: 0 = hidden, otherwise a counter so it replays

  useEffect(() => {
    setBlocked(false); setIntegrity(null); setNote(0)
    if (!event?.id) return
    axios.get(`${API}/integrity/event/${event.id}`).then(r => setIntegrity(r.data)).catch(() => setIntegrity(null))
  }, [event?.id])

  if (!event) return null
  const f   = cardFace(event)
  const ctx = buildRichContext(event)
  const evidence = Object.entries(f.raw || {})
    .filter(([k, v]) => (typeof v === "string" || typeof v === "number") && String(v).length > 0 && String(v).length <= 44 && !/message|label|cluster|description|hash/i.test(k))
    .slice(0, 7)
    .map(([k, v]) => [k, sanitizeField(String(v))])
  const entityName = ctx.entity || ctx.computer || sanitizeField(event.source) || ""

  const block = async () => {
    if (!entityName) return
    setBlocking(true)
    try {
      await axios.post(`${API}/block-entity`, {
        entity: entityName, entity_type: "auto", reason: `Blocked from case file: DB-ID:${event.id}`,
        threat_tier: event.threat_tier, event_db_id: event.id, triggered_by: "ui",
      })
      setBlocked(true)
      onBlockEntity && onBlockEntity(entityName)
    } catch { /* the toast in the parent reports failures */ }
    setBlocking(false)
  }

  const iv = integrity?.valid
  const ivLabel = iv === true ? "HASH VERIFIED" : iv === false ? "HASH MISMATCH" : iv === null ? "LEGACY EVENT" : "CHECKING..."
  const ivColor = iv === true ? "var(--green-d)" : iv === false ? "var(--red-d)" : "#6f8583"

  return (
    <div className="pz-panel paper pz-bounce-in" style={{ width: wide ? "100%" : 340, height: wide ? "100%" : undefined, maxHeight: "100%", overflowY: "auto", padding: wide ? 18 : 14, background: "linear-gradient(180deg,#f7f2e6,#e9e2d0)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <div style={{ textAlign: "center", lineHeight: 1, color: f.suitColor, fontWeight: 700, fontSize: 38 }}>
          {f.tier.rank}
          <div style={{ display: "flex", justifyContent: "center", marginTop: 2 }}><PxIcon suit={f.suit} size={22} color={f.suitColor} /></div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 24, lineHeight: 1.05 }}>{f.title}</div>
          <span className="pz-tag" style={{ background: f.tier.color, color: f.tier.name === "MEDIUM" ? "#1d2527" : "#fff", textShadow: f.tier.name === "MEDIUM" ? "none" : undefined, marginTop: 4 }}>{f.tier.name}</span>
        </div>
        <PxIcon name={f.art} size={46} />
        {onClose && <button className="pz-btn red small" style={{ padding: "2px 8px" }} onClick={onClose} aria-label="Close case file">X</button>}
      </div>

      <div className="pz-tag pz-bounce-in" style={{ display: "block", textAlign: "center", background: ivColor, marginBottom: 12, padding: "4px 6px", animationDelay: ".1s" }}>
        {ivLabel}{integrity?.event_hash ? `  ${integrity.event_hash.slice(0, 10)}...` : ""}
      </div>

      <div className="pz-fade-up" style={{ marginBottom: 12, animationDelay: ".15s" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, letterSpacing: ".12em", fontWeight: 700, color: "#6b7b78", marginBottom: 4 }}>
          <span>HOW SUSPICIOUS</span><span style={{ color: f.tier.dark }}>{f.score}%</span>
        </div>
        <div style={{ position: "relative", height: 20, background: "#1b2829", border: "3px solid var(--ink)", borderRadius: 6, overflow: "hidden" }}>
          <div className="pz-bar" style={{ width: `${Math.max(3, f.score)}%`, height: "100%", background: f.tier.color, boxShadow: "inset 0 -4px 0 rgba(0,0,0,.25), inset 0 2px 0 rgba(255,255,255,.3)", animationDelay: ".3s" }} />
          {[25, 50, 75].map(t => <span key={t} style={{ position: "absolute", left: `${t}%`, top: 0, bottom: 0, width: 2, background: "rgba(255,255,255,.25)" }} />)}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#8a9a98", marginTop: 2 }}>
          <span>routine</span><span>unusual</span><span>very unusual</span>
        </div>
      </div>

      {note > 0 && <LuffyExplain key={note} event={event} onClose={() => setNote(0)} />}

      <div style={wide ? { columnCount: 2, columnGap: 16 } : undefined}>
      <Section title="WHAT HAPPENED" delay={.2}>{ctx.plain_english}</Section>
      <Section title="THREAT LEVEL" tone={f.tier.color + "33"} delay={.28}>
        <b>{f.tier.name}.</b> {explainTier(event.threat_tier)}
      </Section>
      {ctx.cluster_label && <Section title="BEHAVIOUR" delay={.36}>{ctx.cluster_label}</Section>}
      {ctx.investigation_hint && <Section title="WHAT TO INVESTIGATE" delay={.44}>{ctx.investigation_hint}</Section>}
      {ctx.attack_phase && <Section title="ATTACK PHASE" tone="#fbd5d1" delay={.5}>{sanitizeField(ctx.attack_phase)}</Section>}

      <Section title="KEY FACTS" delay={.56}>
        {[
          ["Time", formatTimestamp(event.timestamp)],
          ["Anomaly", `${ctx.anomaly_score}% suspicious`],
          ["Source", ctx.source],
          ctx.entity && ["Account", ctx.entity],
          ctx.ip_address && ["IP", ctx.ip_address],
          ctx.computer && ["Computer", ctx.computer],
        ].filter(Boolean).map(([k, v]) => (
          <div key={k} style={{ display: "flex", gap: 8, fontSize: 18 }}>
            <span style={{ minWidth: 70, color: "#6b7b78", fontWeight: 600 }}>{k}</span><span>{v}</span>
          </div>
        ))}
      </Section>

      {evidence.length > 0 && (
        <Section title="RAW EVIDENCE" delay={.64}>
          {evidence.map(([k, v]) => (
            <div key={k} style={{ display: "flex", gap: 8, fontSize: 16, lineHeight: 1.2 }}>
              <span style={{ minWidth: 92, color: "#6b7b78", fontWeight: 600 }}>{k}</span><span style={{ wordBreak: "break-all" }}>{v}</span>
            </div>
          ))}
        </Section>
      )}

      </div>

      <div style={{ display: "flex", flexDirection: wide ? "row" : "column", gap: 10, marginTop: 4 }}>
        <Btn color="blue" style={wide ? { flex: 1 } : undefined} onClick={() => (inlineLuffy ? setNote(n => n + 1) : onAskLuffy && onAskLuffy(event))}>{note ? "Ask Luffy again" : "Ask Luffy to explain"}</Btn>
        {entityName && event.threat_tier >= 2 && !blocked && (
          <Btn color="red" style={wide ? { flex: 1 } : undefined} disabled={blocking} onClick={block}>{blocking ? "Blocking..." : `Block "${entityName.slice(0, 22)}"`}</Btn>
        )}
        {blocked && entityName && <UnblockButton entity={entityName} onDone={() => setBlocked(false)} />}
      </div>
    </div>
  )
}
