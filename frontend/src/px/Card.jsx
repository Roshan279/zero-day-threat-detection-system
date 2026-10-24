import { useEffect, useRef, useState } from "react"
import PxIcon from "./PxIcon"
import { cardFace } from "./cardModel"

// ─────────────────────────────────────────────────────────────
// PixelCard: one event as a playing card.
// Position comes from CSS variables (--x --y --r), set by <Hand/> or by the caller,
// so hover and selection can lift the card with a transition.
// ─────────────────────────────────────────────────────────────
export function PixelCard({
  event, selected = false, seen = false, leaving = false, width = 120,
  x = 0, y = 0, rot = 0, z = 1, delay = 0, from, interactive = true,
  onClick, onHover, style,
}) {
  const f = cardFace(event)
  const css = {
    "--cw": `${width}px`, "--x": `${x}px`, "--y": `${y}px`, "--r": `${rot}deg`,
    "--delay": `${delay}s`, "--seal": f.tier.seal, zIndex: z,
    ...(from ? { "--from-x": `${from.x}px`, "--from-y": `${from.y}px` } : {}),
    ...style,
  }
  const scale = width / 120
  return (
    <div
      className={`pz-card ${selected ? "selected" : ""} ${seen ? "seen" : ""} ${leaving ? "leaving" : ""}`}
      style={css}
      onClick={interactive ? onClick : undefined}
      onMouseEnter={interactive && onHover ? () => onHover(event) : undefined}
      onMouseLeave={interactive && onHover ? () => onHover(null) : undefined}
      role="button"
      aria-pressed={selected}
      aria-label={`${f.tier.name} ${f.title}`}
      data-event-id={event.id}
    >
      <div className="c-corner" style={{ color: f.suitColor, fontSize: 31 * scale }}>
        <span>{f.tier.rank}</span>
        <PxIcon suit={f.suit} size={16 * scale} color={f.suitColor} />
      </div>
      <div className="c-corner br" style={{ color: f.suitColor, fontSize: 31 * scale }}>
        <span>{f.tier.rank}</span>
        <PxIcon suit={f.suit} size={16 * scale} color={f.suitColor} />
      </div>
      <div className="c-frame" style={{ "--tc": f.tier.color, left: 30 * scale, right: 30 * scale, top: 8 * scale, height: 98 * scale }}>
        <PxIcon name={f.art} size={50 * scale} />
      </div>
      <div className="c-title" style={{ left: 34 * scale, right: 34 * scale, top: 109 * scale, fontSize: 11.5 * scale, height: 26 * scale }}>{f.title}</div>
      <div className="c-score" style={{
        background: f.tier.color, color: f.tier.name === "MEDIUM" ? "#1d2527" : "#fff", textShadow: f.tier.name === "MEDIUM" ? "none" : undefined,
        bottom: 5 * scale, height: 24 * scale, minWidth: 46 * scale, fontSize: 19 * scale, padding: `0 ${5 * scale}px`, borderRadius: 5 * scale, borderWidth: Math.max(1, 2 * scale),
      }}>
        {f.score}
      </div>
      {seen && <div className="c-seen">SEEN</div>}
    </div>
  )
}

// A face-down card (the deck)
export function CardBack({ width = 120, x = 0, y = 0, rot = 0, z = 1, style }) {
  return (
    <div
      className="pz-card back"
      style={{ "--cw": `${width}px`, "--x": `${x}px`, "--y": `${y}px`, "--r": `${rot}deg`, zIndex: z, animation: "none", ...style }}
    />
  )
}

// ─────────────────────────────────────────────────────────────
// Hand: cards fanned along an arc at the bottom of the table
// ─────────────────────────────────────────────────────────────
export function Hand({ events, selectedIds, seenIds, leavingIds, onToggle, onHover, cardWidth = 120, dealKey = 0, from }) {
  const ref = useRef(null)
  const [w, setW] = useState(900)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width || 900))
    ro.observe(ref.current)
    setW(ref.current.getBoundingClientRect().width)
    return () => ro.disconnect()
  }, [])

  const n = events.length
  const cw = cardWidth
  const spread = Math.max(0, w - cw - 40)
  // never let the fan collapse into one pile, and never start left of the table
  const step = n > 1 ? Math.max(24, Math.min(cw * 0.66, spread / (n - 1))) : 0
  const startX = Math.max(0, (w - (step * (n - 1) + cw)) / 2)
  const maxAngle = Math.min(13, 1.4 * n)

  return (
    <div ref={ref} style={{ position: "relative", width: "100%", height: cw * 1.4 + 44 }}>
      {/* the key restarts the deal animation; the measured wrapper above is never remounted */}
      <div key={dealKey} style={{ position: "absolute", inset: 0 }}>
      {events.map((ev, i) => {
        const t = n > 1 ? (i / (n - 1)) * 2 - 1 : 0
        return (
          <PixelCard
            key={ev.id}
            event={ev}
            width={cw}
            x={startX + i * step}
            y={Math.pow(Math.abs(t), 2) * 26 + 12}
            rot={t * maxAngle}
            z={i + 1}
            delay={i * 0.045}
            from={from}
            selected={selectedIds?.has(ev.id)}
            seen={seenIds?.has(ev.id)}
            leaving={leavingIds?.has(ev.id)}
            onClick={() => onToggle && onToggle(ev)}
            onHover={onHover}
          />
        )
      })}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// CardStack: one pile per threat tier, drawn as a small hand of its worst real event cards.
// Click a card to open that event; click the label under the fan to open the whole pile.
// Everything stays inside the pile's own box so neighbouring piles are never covered.
// ─────────────────────────────────────────────────────────────
export function CardStack({ tier, count, events = [], width = 90, active = false, onClick, onHover, onPick }) {
  const fan = events.slice(0, 3).reverse()  // worst card ends up on top
  const m = fan.length
  const step = Math.round(width * 0.3)
  const boxW = width + step * 2 + 8
  const h = width * 1.4
  return (
    <div
      onMouseEnter={() => onHover && onHover(true)}
      onMouseLeave={() => onHover && onHover(false)}
      style={{ width: boxW }}
      role="group"
      aria-label={`${tier.name} pile, ${count} events`}
    >
      <div style={{ position: "relative", width: boxW, height: h + 26 }}>
        {m === 0 && (
          <div style={{
            position: "absolute", left: (boxW - width) / 2, top: 16, width, height: h, borderRadius: 10,
            border: "3px dashed rgba(255,255,255,.45)", display: "flex", alignItems: "center", justifyContent: "center",
            color: "rgba(255,255,255,.7)", fontSize: 18, textAlign: "center", padding: 6,
          }}>none</div>
        )}
        {fan.map((ev, i) => {
          const t = m > 1 ? (i / (m - 1)) * 2 - 1 : 0
          return (
            <PixelCard
              key={ev.id} event={ev} width={width}
              x={(boxW - width - step * 2) / 2 + i * step + (m < 3 ? (3 - m) * step / 2 : 0)}
              y={14 + t * t * 8}
              rot={t * 9}
              z={i + 1}
              style={{ animation: "none" }}
              onClick={() => onPick && onPick(ev)}
            />
          )
        })}
      </div>
      <button
        onClick={onClick}
        className="pz-panel"
        aria-label={`Open the ${tier.name} pile`}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8, width: "100%", padding: "2px 6px 4px", cursor: "pointer",
          color: "#fff", fontFamily: "var(--pxfont)", background: tier.dark,
          boxShadow: active ? "0 0 0 4px var(--gold), 0 4px 0 var(--ink)" : "0 4px 0 var(--ink)",
        }}
      >
        <span style={{ fontSize: 26, fontWeight: 700, lineHeight: 1, textShadow: "0 2px 0 rgba(0,0,0,.45)" }}>{count}</span>
        <span style={{ fontSize: 16, letterSpacing: ".08em", textShadow: "0 2px 0 rgba(0,0,0,.45)" }}>{tier.name}</span>
      </button>
    </div>
  )
}
