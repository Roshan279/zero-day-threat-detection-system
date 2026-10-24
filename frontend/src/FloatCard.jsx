import { useEffect } from "react"
import PxIcon from "./px/PxIcon"
import { cardFace } from "./px/cardModel"
import { buildRichContext, formatTimestamp } from "./Humanlog"

// ─────────────────────────────────────────────────────────────
// FLOAT CARD: the card you picked on Home, lifted off the table and opened up.
// It shows a short summary of the event on the card itself. Opening the full case file is a small
// button, not what clicking the card does. Escape or the X puts it back.
// ─────────────────────────────────────────────────────────────
const W = 250

export default function FloatCard({ event, anchor, boxWidth, onClose, onOpenCase }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  if (!event) return null
  const f = cardFace(event)
  const ctx = buildRichContext(event)
  const left = Math.max(0, Math.min(anchor.x - W / 2, boxWidth - W))
  const top = Math.max(0, anchor.y - 270)
  const tone = f.tier.name === "MEDIUM" ? "#1d2527" : "#fff"
  const facts = [
    ["Time", formatTimestamp(event.timestamp)],
    ["Source", ctx.source],
    ctx.entity && ["Account", ctx.entity],
    ctx.ip_address && ["IP", ctx.ip_address],
  ].filter(Boolean)

  return (
    <div className="pz-bounce-in" role="dialog" aria-label={`${f.tier.name}: ${f.title}`}
      style={{ position: "absolute", left, top, width: W, zIndex: 80, background: "#f8f4ec", color: "var(--ink)", border: "2px solid #b4aea0", borderRadius: 16,
        boxShadow: "0 14px 0 rgba(0,0,0,.3)", padding: "10px 12px 12px", transform: "rotate(-1.5deg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ textAlign: "center", lineHeight: 1, color: f.suitColor, fontWeight: 700, fontSize: 30 }}>
          {f.tier.rank}
          <div style={{ display: "flex", justifyContent: "center" }}><PxIcon suit={f.suit} size={16} color={f.suitColor} /></div>
        </div>
        <div style={{ flex: 1, minWidth: 0, fontWeight: 700, fontSize: 21, lineHeight: 1.05 }}>{f.title}</div>
        <div style={{ width: 54, height: 54, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6,
          background: `color-mix(in srgb, ${f.tier.color} 24%, #f8f4ec)`, border: `2px solid color-mix(in srgb, ${f.tier.color} 55%, #f8f4ec)` }}>
          <PxIcon name={f.art} size={40} />
        </div>
        <button className="pz-btn red small" style={{ padding: "1px 7px", alignSelf: "flex-start" }} onClick={onClose} aria-label="Put the card back">X</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "8px 0 6px" }}>
        <span style={{ fontSize: 16, fontWeight: 700, color: f.tier.dark }}>{f.tier.name}</span>
        <div style={{ flex: 1, height: 12, background: "#2a3638", border: "2px solid var(--ink)", borderRadius: 5, overflow: "hidden" }}>
          <div style={{ width: `${Math.max(3, f.score)}%`, height: "100%", background: f.tier.color }} />
        </div>
        <b style={{ fontSize: 17 }}>{f.score}%</b>
      </div>

      <div style={{ fontSize: 16, lineHeight: 1.2, marginBottom: 6 }}>{ctx.plain_english}</div>
      {ctx.investigation_hint && <div style={{ fontSize: 15, lineHeight: 1.15, color: "#5b6b6a", marginBottom: 6 }}>{ctx.investigation_hint}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 8, fontSize: 14, marginBottom: 8 }}>
        {facts.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <span style={{ color: "#6b7b78", fontWeight: 600 }}>{k}</span><span style={{ wordBreak: "break-word" }}>{v}</span>
          </div>
        ))}
      </div>

      {onOpenCase && <button className="pz-btn gray small" style={{ width: "100%", color: tone === "#fff" ? "#fff" : undefined }} onClick={onOpenCase}>Select it in Events</button>}
    </div>
  )
}
