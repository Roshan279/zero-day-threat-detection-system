import { useEffect } from "react"
import PxIcon from "./px/PxIcon"

// ─────────────────────────────────────────────────────────────
// SUMMARY CARD: a card lifted off a chart, opened up into a short summary. It never leaves the page:
// a few numbers, then a short list. Escape or the X puts it back. Position is inside the chart's own box.
// ─────────────────────────────────────────────────────────────
const W = 250

export default function SummaryCard({ anchor, boxWidth, color, rank, suit, icon, title, sub, stats = [], rows = [], onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const red = suit === "heart" || suit === "diamond"
  const col = red ? "#c0443b" : "#1d2527"
  const left = Math.max(0, Math.min(anchor.x - W / 2, boxWidth - W))
  const top = Math.max(0, anchor.y - 250)

  return (
    <div className="pz-bounce-in" role="dialog" aria-label={title}
      style={{ position: "absolute", left, top, width: W, zIndex: 80, background: "#f8f4ec", color: "var(--ink)", border: "2px solid #b4aea0", borderRadius: 16,
        boxShadow: "0 14px 0 rgba(0,0,0,.3)", padding: "10px 12px 12px", transform: "rotate(-1.2deg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ textAlign: "center", lineHeight: 1, color: col, fontWeight: 700, fontSize: 30 }}>
          {rank}
          <div style={{ display: "flex", justifyContent: "center" }}><PxIcon suit={suit} size={16} color={col} /></div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 22, lineHeight: 1.05 }}>{title}</div>
          {sub && <div style={{ fontSize: 14, color: "#6b7b78" }}>{sub}</div>}
        </div>
        <div style={{ width: 50, height: 50, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6,
          background: `color-mix(in srgb, ${color} 26%, #f8f4ec)`, border: `2px solid color-mix(in srgb, ${color} 55%, #f8f4ec)` }}>
          <PxIcon name={icon} size={36} />
        </div>
        <button className="pz-btn red small" style={{ padding: "1px 7px", alignSelf: "flex-start" }} onClick={onClose} aria-label="Put the card back">X</button>
      </div>

      {stats.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", columnGap: 10, rowGap: 1, fontSize: 16, margin: "10px 0 6px" }}>
          {stats.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <span style={{ color: "#6b7b78", fontWeight: 600 }}>{k}</span><b style={{ wordBreak: "break-word" }}>{v}</b>
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ borderTop: "2px solid #b4aea0", paddingTop: 6 }}>
          <div style={{ fontSize: 12, letterSpacing: ".12em", color: "#7a7466", marginBottom: 2 }}>HIGHEST SCORES</div>
          {rows.map(([name, value], i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 15, lineHeight: 1.25 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
              <b style={{ color }}>{value}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
