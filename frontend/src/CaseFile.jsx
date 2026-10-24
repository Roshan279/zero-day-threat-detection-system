import { useEffect, useState } from "react"
import axios from "axios"
import { API } from "./api"
import PxIcon from "./px/PxIcon"
import { Btn } from "./px/ui"
import { cardFace } from "./px/cardModel"
import { buildRichContext, formatTimestamp } from "./Humanlog"
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
    <div className="pz-fade-up" style={{ marginBottom: 8, animationDelay: `${delay}s`, breakInside: "avoid" }}>
      <div style={{ fontSize: 13, letterSpacing: ".12em", fontWeight: 700, color: "#6b7b78", marginBottom: 2 }}>{title}</div>
      <div style={{ border: "3px solid var(--ink)", borderRadius: 8, padding: "5px 9px", background: tone || "#fff", fontSize: 17, lineHeight: 1.2 }}>{children}</div>
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
  const ivColor = iv === true ? "var(--green-d)" : iv === false ? "var(--red-d)" : "#5e7977"

  return (
    <div className="pz-panel paper pz-bounce-in" style={{ width: wide ? "100%" : 340, height: wide ? "100%" : undefined, maxHeight: "100%", overflowY: "auto", padding: wide ? 18 : 14, background: "linear-gradient(180deg,#f7f2e6,#e9e2d0)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <div style={{ textAlign: "center", lineHeight: 1, color: f.suitColor, fontWeight: 700, fontSize: 34 }}>
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

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div className="pz-tag" style={{ background: ivColor, padding: "1px 6px", fontSize: 13 }}>{ivLabel}{integrity?.event_hash ? `  ${integrity.event_hash.slice(0, 8)}...` : ""}</div>
        <div style={{ flex: 1, position: "relative", height: 16, background: "#2a3638", border: "3px solid var(--ink)", borderRadius: 6, overflow: "hidden" }} title={`${f.score}% suspicious`}>
          <div className="pz-bar" style={{ width: `${Math.max(3, f.score)}%`, height: "100%", background: f.tier.color, animationDelay: ".3s" }} />
        </div>
        <b style={{ fontSize: 18, color: f.tier.dark }}>{f.score}%</b>
      </div>

      {note > 0 && <LuffyExplain key={note} event={event} onClose={() => setNote(0)} />}

      <div style={wide ? { columnCount: 2, columnGap: 16 } : undefined}>
      <Section title={ctx.cluster_label ? `WHAT HAPPENED  ·  ${String(ctx.cluster_label).toUpperCase()}` : "WHAT HAPPENED"} delay={.2}>{ctx.plain_english}</Section>
      {ctx.investigation_hint && <Section title="WHAT TO INVESTIGATE" tone={f.tier.color + "26"} delay={.28}>{ctx.investigation_hint}</Section>}
      {ctx.attack_phase && <Section title="ATTACK PHASE" tone="#fbd5d1" delay={.34}>{sanitizeField(ctx.attack_phase)}</Section>}

      <Section title="KEY FACTS" delay={.4}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 10, rowGap: 1, fontSize: 16 }}>
          {[
            ["Time", formatTimestamp(event.timestamp)],
            ["Source", ctx.source],
            ctx.entity && ["Account", ctx.entity],
            ctx.ip_address && ["IP", ctx.ip_address],
            ctx.computer && ["Computer", ctx.computer],
          ].filter(Boolean).map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <span style={{ color: "#6b7b78", fontWeight: 600 }}>{k}</span><span style={{ wordBreak: "break-word" }}>{v}</span>
            </div>
          ))}
        </div>
      </Section>

      {evidence.length > 0 && (
        <details style={{ marginBottom: 8 }}>
          <summary style={{ fontSize: 13, letterSpacing: ".12em", fontWeight: 700, color: "#6b7b78", cursor: "pointer" }}>RAW EVIDENCE ({evidence.length})</summary>
          <div style={{ border: "3px solid var(--ink)", borderRadius: 8, padding: "5px 9px", background: "#fff", marginTop: 3 }}>
            {evidence.map(([k, v]) => (
              <div key={k} style={{ display: "flex", gap: 8, fontSize: 14, lineHeight: 1.2 }}>
                <span style={{ minWidth: 84, color: "#6b7b78", fontWeight: 600 }}>{k}</span><span style={{ wordBreak: "break-all" }}>{v}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      </div>

      <div style={{ display: "flex", flexDirection: "row", gap: 8, marginTop: 2 }}>
        <Btn color="blue" style={{ flex: 1, padding: "6px 8px" }} onClick={() => (inlineLuffy ? setNote(n => n + 1) : onAskLuffy && onAskLuffy(event))}>{note ? "Ask again" : "Ask Luffy"}</Btn>
        {entityName && event.threat_tier >= 2 && !blocked && (
          <Btn color="red" style={{ flex: 1, padding: "6px 8px" }} disabled={blocking} onClick={block}>{blocking ? "Blocking..." : `Block ${entityName.slice(0, 14)}`}</Btn>
        )}
        {blocked && entityName && <UnblockButton entity={entityName} onDone={() => setBlocked(false)} />}
      </div>
    </div>
  )
}
