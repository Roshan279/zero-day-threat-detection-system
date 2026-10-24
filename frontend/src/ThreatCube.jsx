import { useMemo, useState } from "react"
import { TIER } from "./px/cardModel"

// ─────────────────────────────────────────────────────────────
// THREAT CUBE: four isometric layers, one per threat level. Every event is a dot
// on its layer. Hover a layer to lift it out of the stack, click to open that pile.
// ─────────────────────────────────────────────────────────────
const W = 600, H = 470
const CX = 250, BASE_Y = 290
const HW = 160, HH = 60          // half-width / half-height of a layer diamond
const GAP = 78                   // vertical distance between layers
const ORDER = [1, 2, 3, 4]       // bottom to top
const GRID = 9                   // lattice size
const MAX_DOTS = 44

const iso = (u, v, z) => [CX + (u - v) * HW, BASE_Y + (u + v - 1) * HH - z]
const pts = (list) => list.map(([x, y]) => `${x},${y}`).join(" ")

const hash = (n) => { let x = (Number(n) || 1) * 2654435761 % 4294967296; x ^= x >>> 13; x = (x * 1274126177) % 4294967296; return (x >>> 0) / 4294967296 }

export default function ThreatCube({ events = [], onOpen }) {
  const [hover, setHover] = useState(0)

  const layers = useMemo(() => {
    const by = { 1: [], 2: [], 3: [], 4: [] }
    events.forEach(e => { if (by[e.threat_tier]) by[e.threat_tier].push(e) })
    return by
  }, [events])

  const lattice = useMemo(() => {
    const out = []
    for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) out.push([(i + .5) / GRID, (j + .5) / GRID])
    return out
  }, [])

  const top = (hover && layers[hover][0]) || null
  const markerY = hover ? BASE_Y - ORDER.indexOf(hover) * GAP : null

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 620 }}>
      <style>{`
        @keyframes tc-float { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-4px) } }
        @keyframes tc-blink { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
        .tc-layer { transition: transform .25s steps(5), opacity .2s; cursor: pointer; }
        .tc-float { animation: tc-float 3.2s ease-in-out infinite; }
        .tc-blink { animation: tc-blink 1s steps(2) infinite; }
        @media (prefers-reduced-motion: reduce) { .tc-float, .tc-blink { animation: none } }
      `}</style>
      <svg viewBox={`0 -70 ${W} ${H + 70}`} style={{ width: "100%", display: "block", overflow: "visible" }} role="group" aria-label="Threat layers">
        {/* cube frame */}
        <polygon points={pts([iso(0, 0, 3 * GAP + 40), iso(1, 0, 3 * GAP + 40), iso(1, 1, 3 * GAP + 40), iso(0, 1, 3 * GAP + 40)])} fill="none" stroke="#5e7977" strokeWidth="2" strokeDasharray="4 4" />
        <polyline points={pts([iso(0, 1, 3 * GAP + 40), iso(0, 1, -40), iso(1, 1, -40), iso(1, 0, -40), iso(1, 0, 3 * GAP + 40)])} fill="none" stroke="#5e7977" strokeWidth="2" strokeDasharray="4 4" />
        <line x1={iso(1, 1, 3 * GAP + 40)[0]} y1={iso(1, 1, 3 * GAP + 40)[1]} x2={iso(1, 1, -40)[0]} y2={iso(1, 1, -40)[1]} stroke="#5e7977" strokeWidth="2" strokeDasharray="4 4" />
        <polygon points={pts([iso(0, 0, -40), iso(1, 0, -40), iso(1, 1, -40), iso(0, 1, -40)])} fill="rgba(0,0,0,.25)" stroke="#5e7977" strokeWidth="2" />

        {ORDER.map((t, idx) => {
          const tier = TIER[t]
          const z = idx * GAP
          const active = hover === t
          const dim = hover && !active
          const lift = active ? 22 : 0
          const evs = layers[t].slice(0, MAX_DOTS)
          return (
            <g key={t} className="tc-layer" style={{ transform: `translateY(${-lift}px)`, opacity: dim ? .38 : 1 }}
              onMouseEnter={() => setHover(t)} onMouseLeave={() => setHover(0)}
              onFocus={() => setHover(t)} onBlur={() => setHover(0)}
              onClick={() => onOpen && onOpen(t)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen && onOpen(t) } }}
              tabIndex={0} role="button" aria-label={`${tier.name} layer, ${layers[t].length} events`}>
              <g className="tc-float" style={{ animationDelay: `${idx * -0.8}s` }}>
                {/* slab edge */}
                <polygon points={pts([iso(0, 1, z), iso(1, 1, z), iso(1, 1, z - 9), iso(0, 1, z - 9)])} fill={tier.dark} stroke="#1d2527" strokeWidth="2" />
                <polygon points={pts([iso(1, 0, z), iso(1, 1, z), iso(1, 1, z - 9), iso(1, 0, z - 9)])} fill={tier.dark} stroke="#1d2527" strokeWidth="2" opacity=".8" />
                {/* top face */}
                <polygon points={pts([iso(0, 0, z), iso(1, 0, z), iso(1, 1, z), iso(0, 1, z)])} fill={tier.color} fillOpacity={active ? .42 : .22} stroke={tier.color} strokeWidth={active ? 3 : 2} />
                {/* lattice */}
                {lattice.map(([u, v], i) => { const [x, y] = iso(u, v, z); return <rect key={i} x={x - 1.5} y={y - 1.5} width="3" height="3" fill={tier.color} opacity=".45" shapeRendering="crispEdges" /> })}
                {/* events */}
                {evs.map((e, i) => {
                  const u = .08 + hash(e.id * 7 + t) * .84, v = .08 + hash(e.id * 13 + 3) * .84
                  const [x, y] = iso(u, v, z)
                  const r = i === 0 ? 6 : 4.5
                  return <rect key={e.id ?? i} className={i === 0 ? "tc-blink" : undefined} x={x - r} y={y - r} width={r * 2} height={r * 2} fill={i === 0 ? "#fff" : tier.color} stroke="#1d2527" strokeWidth="2" shapeRendering="crispEdges" />
                })}
              </g>
              <text x={iso(0, 1, z)[0] - 8} y={iso(0, 1, z)[1] + 4} textAnchor="end" fontFamily="var(--pxfont)" fontSize="20" fill={active ? "#fff" : tier.color}>{tier.name}</text>
            </g>
          )
        })}

        {/* timeline rail */}
        <line x1="490" y1="30" x2="490" y2="430" stroke="#5e7977" strokeWidth="3" />
        {Array.from({ length: 19 }, (_, i) => <line key={i} x1="490" x2={i % 6 === 0 ? 506 : 498} y1={30 + i * 22.2} y2={30 + i * 22.2} stroke="#5e7977" strokeWidth="2" />)}
        {ORDER.slice().reverse().map((t, i) => (
          <text key={t} x="512" y={44 + i * 110} fontFamily="var(--pxfont)" fontSize="19" fill={hover === t ? "#fff" : "#b5e8f2"}>{TIER[t].name}</text>
        ))}
        {markerY != null && (
          <g style={{ transition: "transform .25s steps(5)" }}>
            <rect x="482" y={markerY - 16} width="16" height="12" fill={TIER[hover].color} stroke="#1d2527" strokeWidth="2" shapeRendering="crispEdges" />
            <line x1="152" x2="482" y1={markerY - 10} y2={markerY - 10} stroke={TIER[hover].color} strokeWidth="2" strokeDasharray="3 5" opacity=".7" />
          </g>
        )}
      </svg>

      <div className="pz-panel" style={{ position: "absolute", left: 0, bottom: 0, padding: "8px 12px", minWidth: 230, pointerEvents: "none" }}>
        {hover ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="pz-tag" style={{ background: TIER[hover].color, color: hover === 2 ? "#1d2527" : "#fff" }}>{TIER[hover].name}</span>
              <span style={{ fontSize: 22 }}>{layers[hover].length} events</span>
            </div>
            <div style={{ fontSize: 17, color: "#b5e8f2", marginTop: 4 }}>
              {top ? `Top score ${top.anomaly_score}%. Click to open.` : "Nothing on this layer."}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 18, color: "#dcdcdc" }}>Hover a layer. Each square is one event.</div>
        )}
      </div>
    </div>
  )
}
