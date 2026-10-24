import { useRef, useState } from "react"
import { TIER, shortTitle } from "./px/cardModel"
import { baselineOf, isFlagged, stamp, tsOf } from "./graphData"
import { Empty, showTip, hideTip } from "./GraphLenses"
import FloatCard from "./FloatCard"

// ─────────────────────────────────────────────────────────────
// SCORE TABLE: every event is a playing card laid on the felt, placed by time (across) and anomaly score (up).
//   baseline   - the lighter lane is the typical range: the median score of the events the backend did NOT flag,
//                plus or minus two robust deviations, worked out from all events so zooming never moves it
//   anomalies  - the events the backend flagged (HIGH or CRITICAL) are dealt face up: big, ringed in gold, with their rank
//   threat     - a card's colour is its threat level, its size grows with the score, and the real tier
//                cut-offs (40 / 65 / 85) are drawn across the table, with the CRITICAL zone tinted
// Cards that fall at the same moment are dodged sideways so none hides behind another.
// Hover for a crosshair and details, click a card to lift it with a summary, drag across the table to zoom in on a
// time range, and use the toggles to hide a layer.
// ─────────────────────────────────────────────────────────────
const W = 760, H = 380
const PL = 54, PR = 112, PT = 16, PB = 36
const INK = "#1d2527"
const CREAM = "#f8f4ec"
const MUTED = "#b5e8f2"
const FELT = "#3f6a5c"
const LANE = "#d8ccb0"
const FONT = "var(--pxfont)"
const CUTOFFS = [[0.85, 4], [0.65, 3], [0.4, 2]]     // from the backend's assign_tier
const HIT = 22                                        // how close the pointer has to be to a card, in drawing units
const MAX_SHIFT = 160

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const pad = (n) => String(n).padStart(2, "0")
const clock = (t, span) => { const d = new Date(t); return span > 36 * 3600e3 ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}h` : `${pad(d.getHours())}:${pad(d.getMinutes())}` }

// One card, centred on (0, 0). Anomalies are bigger, ringed, and carry their rank.
function CardGlyph({ w, h, color, rank, anomaly, hot, dim }) {
  return (
    <g opacity={dim ? 0.82 : 1}>
      {(anomaly || hot) && <rect x={-w / 2 - 3} y={-h / 2 - 3} width={w + 6} height={h + 6} rx="4" fill="none" stroke={hot ? "#fff" : "var(--gold)"} strokeWidth="2.5" />}
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx="3" fill={CREAM} stroke={hot ? "#fff" : INK} strokeWidth="1.8" />
      <rect x={-w / 2 + 2.5} y={-h / 2 + (anomaly ? 10 : 3)} width={w - 5} height={h - (anomaly ? 13 : 6)} rx="1.5" fill={color} />
      {anomaly && <text x={-w / 2 + 3} y={-h / 2 + 8.5} fontFamily={FONT} fontSize="9" fill={INK}>{rank}</text>}
    </g>
  )
}

export default function ScoreScatter({ events, allEvents }) {
  const svgRef = useRef(null)
  const wrapRef = useRef(null)
  const [pin, setPin] = useState(null)                 // the card that is floating: { event, x, y }
  const [zoom, setZoom] = useState(null)               // [t0, t1] in ms, or null for everything
  const [hoverId, setHoverId] = useState(null)
  const [off, setOff] = useState({ normal: false, anomaly: false, band: false, lines: false })
  const [sel, setSel] = useState(null)                 // the drag in progress: { a, b } in drawing x units

  const pts = events.map(e => ({ e, t: tsOf(e), s: e.anomaly_score || 0, tier: e.threat_tier })).filter(p => p.t != null).sort((a, b) => a.t - b.t)
  const base = baselineOf(allEvents || events, events)
  if (!pts.length || !base) return <Empty />

  const vis = zoom ? pts.filter(p => p.t >= zoom[0] && p.t <= zoom[1]) : pts
  const pw = W - PL - PR, ph = H - PT - PB
  let x0 = zoom ? zoom[0] : pts[0].t, x1 = zoom ? zoom[1] : pts[pts.length - 1].t
  if (x1 - x0 < 60e3) { x0 -= 30 * 60e3; x1 += 30 * 60e3 }
  const padX = (x1 - x0) * 0.03
  x0 -= padX; x1 += padX
  const span = x1 - x0
  const scores = vis.map(p => p.s)
  let lo = Math.min(...(scores.length ? scores : [base.med]), off.band ? 1 : base.lo) - 0.04
  let hi = Math.max(...(scores.length ? scores : [base.med]), off.band ? 0 : base.hi) + 0.03
  lo = Math.max(0, Math.floor(lo * 20) / 20); hi = Math.min(1, Math.ceil(hi * 20) / 20)
  if (hi - lo < 0.2) { lo = Math.max(0, hi - 0.2); if (hi - lo < 0.2) hi = lo + 0.2 }
  const X = (t) => PL + ((t - x0) / span) * pw
  const Y = (s) => PT + (1 - (s - lo) / (hi - lo)) * ph
  const T = (vx) => x0 + ((vx - PL) / pw) * span

  const isAnom = (p) => isFlagged(p.e)
  const shown = vis.filter(p => (isAnom(p) ? !off.anomaly : !off.normal))
  const nAnom = vis.filter(isAnom).length

  // Card size: anomalies are dealt big, the rest grow a little with their score
  const dims = (p) => {
    const k = clamp((p.s - lo) / (hi - lo), 0, 1)
    const f = nAnom > 40 ? 0.7 : 1   // with a crowd of flagged events the face-up cards shrink so they still fit
    return isAnom(p) ? { w: (17 + k * 4) * f, h: (24 + k * 5) * f } : { w: 10 + k * 3, h: 14 + k * 4 }
  }
  // Dodge: place cards in time order, sliding sideways (0, +, -, ++, --) until nothing is underneath
  const placed = []
  const at = new Map()
  for (const p of shown) {
    const d = dims(p), baseX = X(p.t), y = Y(p.s)
    let x = baseX
    for (let k = 0; k <= MAX_SHIFT / 4; k++) {
      const cand = k === 0 ? baseX : baseX + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 4
      x = cand
      if (placed.every(q => Math.abs(q.x - cand) >= (q.w + d.w) / 2 + 1 || Math.abs(q.y - y) >= (q.h + d.h) / 2 + 1)) break
    }
    x = clamp(x, PL + d.w / 2, PL + pw - d.w / 2)
    const rec = { p, x, y, ...d }
    placed.push(rec)
    at.set(p.e.id, rec)
  }

  const hovered = hoverId != null ? at.get(hoverId) : null
  const local = (ev) => {
    const r = svgRef.current.getBoundingClientRect()
    return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H }
  }
  const nearest = (x, y) => {
    let best = null, bd = HIT
    for (const q of placed) {
      const dd = Math.hypot(q.x - x, q.y - y)
      if (dd < bd) { bd = dd; best = q }
    }
    return best
  }
  const tipFor = (q) => ({
    title: shortTitle(q.p.e), color: TIER[q.p.tier]?.color,
    lines: [stamp(q.p.t), `Score ${Math.round(q.p.s * 100)}% (${q.p.s >= base.med ? "+" : ""}${Math.round((q.p.s - base.med) * 100)} vs baseline)`, `${TIER[q.p.tier]?.name}${isAnom(q.p) ? ", anomaly" : ", normal range"}`],
  })

  const down = (ev) => {
    const { x } = local(ev)
    ev.currentTarget.setPointerCapture(ev.pointerId)
    setPin(null)
    setSel({ a: clamp(x, PL, PL + pw), b: clamp(x, PL, PL + pw), id: ev.pointerId, moved: false })
  }
  const move = (ev) => {
    const { x, y } = local(ev)
    if (sel) {
      const b = clamp(x, PL, PL + pw)
      setSel({ ...sel, b, moved: sel.moved || Math.abs(b - sel.a) > 5 })
      hideTip()
      return
    }
    const q = nearest(x, y)
    setHoverId(q ? q.p.e.id : null)
    if (q) showTip(ev, tipFor(q)); else hideTip()
  }
  const up = (ev) => {
    if (!sel || sel.id !== ev.pointerId) return
    const s = sel
    setSel(null)
    if (s.moved && Math.abs(s.b - s.a) > 8) {
      setZoom([T(Math.min(s.a, s.b)), T(Math.max(s.a, s.b))])
      setHoverId(null)
    } else if (hovered) {
      const r = svgRef.current.getBoundingClientRect(), w = wrapRef.current.getBoundingClientRect()
      setPin({ event: hovered.p.e, x: (hovered.x / W) * r.width + (r.left - w.left), y: (hovered.y / H) * r.height + (r.top - w.top), width: w.width })
      hideTip()
    }
  }
  const leave = () => { if (!sel) { setHoverId(null); hideTip() } }

  const toggle = (k) => setOff(o => ({ ...o, [k]: !o[k] }))
  const chip = (k, label) => (
    <button key={k} aria-pressed={!off[k]} className={`pz-btn small ${off[k] ? "gray" : "gold"}`} onClick={() => toggle(k)}>{label}</button>
  )

  const yTicks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4)
  const xTicks = Array.from({ length: 5 }, (_, i) => x0 + (span * i) / 4)
  const yBandTop = Y(base.hi), yBandBot = Y(base.lo)
  // Draw order: normal cards, then anomalies, then the one under the pointer
  const order = [...placed].sort((a, b) => Number(isAnom(a.p)) - Number(isAnom(b.p)) || a.y - b.y)
  const plaque = (y, text, color) => (
    <g>
      <rect x={PL + pw + 6} y={y - 9} width={PR - 10} height="18" rx="3" fill={color} stroke={INK} strokeWidth="1.5" />
      <text x={PL + pw + 6 + (PR - 10) / 2} y={y + 4} textAnchor="middle" fontFamily={FONT} fontSize="13" fill="#fff" stroke={INK} strokeWidth="2.5" paintOrder="stroke">{text}</text>
    </g>
  )

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 18px", fontSize: 16, marginBottom: 8, color: MUTED }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <svg width="16" height="22" viewBox="-9 -12 18 24" aria-hidden="true"><CardGlyph w={11} h={15} color="#e0803a" dim /></svg>
          <b style={{ color: "#fff" }}>{vis.length - nAnom} normal</b> events. The light lane is the typical range of {base.fromCalm ? "unflagged" : "all"} events: {Math.round(base.med * 100)}% baseline, {Math.round(base.lo * 100)} to {Math.round(base.hi * 100)}%
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <svg width="26" height="34" viewBox="-14 -17 28 34" aria-hidden="true"><CardGlyph w={19} h={27} color="#ec2d33" rank="A" anomaly /></svg>
          <b style={{ color: nAnom ? "#ff7269" : "#fff" }}>{nAnom} anomal{nAnom === 1 ? "y" : "ies"}</b> flagged HIGH or CRITICAL (65% and up), face up
        </span>
        <span>colour = threat level, size = score</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8, alignItems: "center" }}>
        {chip("normal", `Normal ${vis.length - nAnom}`)}
        {chip("anomaly", `Anomalies ${nAnom}`)}
        {chip("band", "Baseline")}
        {chip("lines", "Cut-offs")}
        {zoom && <button className="pz-btn blue small" onClick={() => setZoom(null)}>Reset zoom</button>}
        <span style={{ marginLeft: "auto", fontSize: 15, color: MUTED }}>{zoom ? "drag to zoom further" : "drag across the table to zoom"}</span>
      </div>

      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Anomaly scores over time. Baseline ${Math.round(base.med * 100)} percent, ${nAnom} anomalies.`}
        style={{ width: "100%", display: "block", touchAction: "none", userSelect: "none", cursor: hovered ? "pointer" : "crosshair", background: FELT, border: `3px solid ${INK}`, borderRadius: 10 }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setSel(null)} onPointerLeave={leave} onDoubleClick={() => setZoom(null)}>
        {/* stitched table edge */}
        <rect x="6" y="6" width={W - 12} height={H - 12} rx="6" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="2" strokeDasharray="7 6" />

        {/* the CRITICAL zone */}
        {!off.lines && hi > 0.85 && <rect x={PL} y={PT} width={pw} height={clamp(Y(0.85) - PT, 0, ph)} fill="#ec2d33" opacity=".25" />}

        {/* the normal lane */}
        {!off.band && <rect x={PL} y={yBandTop} width={pw} height={Math.max(3, yBandBot - yBandTop)} fill={LANE} opacity=".3" />}

        {/* axes */}
        <g shapeRendering="crispEdges">
          {yTicks.map((s, i) => (
            <g key={i}>
              <line x1={PL} x2={PL + pw} y1={Y(s)} y2={Y(s)} stroke="#fff" strokeWidth="1" strokeDasharray="2 7" opacity=".22" />
              <text x={PL - 7} y={Y(s) + 4} textAnchor="end" fontFamily={FONT} fontSize="14" fill={MUTED}>{Math.round(s * 100)}%</text>
            </g>
          ))}
          <line x1={PL} x2={PL + pw} y1={PT + ph} y2={PT + ph} stroke={INK} strokeWidth="3" />
        </g>
        {xTicks.map((t, i) => <text key={i} x={X(t)} y={H - 12} textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"} fontFamily={FONT} fontSize="14" fill={MUTED}>{clock(t, span)}</text>)}

        {/* the tier cut-offs, from the backend */}
        {!off.lines && CUTOFFS.filter(([c]) => c > lo && c < hi).map(([c, tier]) => (
          <g key={c}>
            <line x1={PL} x2={PL + pw} y1={Y(c)} y2={Y(c)} stroke={TIER[tier].color} strokeWidth="2" strokeDasharray="9 5" shapeRendering="crispEdges" />
            {plaque(Y(c), `${TIER[tier].name} ${Math.round(c * 100)}`, TIER[tier].dark)}
          </g>
        ))}

        {/* the baseline */}
        {!off.band && (
          <g>
            <line x1={PL} x2={PL + pw} y1={yBandTop} y2={yBandTop} stroke={LANE} strokeWidth="1.5" strokeDasharray="3 5" opacity=".8" shapeRendering="crispEdges" />
            <line x1={PL} x2={PL + pw} y1={yBandBot} y2={yBandBot} stroke={LANE} strokeWidth="1.5" strokeDasharray="3 5" opacity=".8" shapeRendering="crispEdges" />
            <line x1={PL} x2={PL + pw} y1={Y(base.med)} y2={Y(base.med)} stroke={CREAM} strokeWidth="2.5" shapeRendering="crispEdges" />
            {plaque(Y(base.med), `BASELINE ${Math.round(base.med * 100)}`, "#4f7869")}
          </g>
        )}

        {/* the cards */}
        <g>
          {order.map(q => (hovered && hovered.p.e.id === q.p.e.id ? null : (
            <g key={q.p.e.id} transform={`translate(${q.x} ${q.y})`}>
              <CardGlyph w={q.w} h={q.h} color={TIER[q.p.tier]?.color || "#fff"} rank={TIER[q.p.tier]?.rank} anomaly={isAnom(q.p)} dim={!isAnom(q.p)} />
            </g>
          )))}
        </g>

        {/* crosshair, axis tags and the lifted card under the pointer */}
        {hovered && !sel && (
          <g pointerEvents="none">
            <line x1={PL} x2={hovered.x} y1={hovered.y} y2={hovered.y} stroke="var(--gold)" strokeWidth="1.5" strokeDasharray="3 4" shapeRendering="crispEdges" />
            <line x1={hovered.x} x2={hovered.x} y1={hovered.y} y2={PT + ph} stroke="var(--gold)" strokeWidth="1.5" strokeDasharray="3 4" shapeRendering="crispEdges" />
            <rect x={PL - 48} y={hovered.y - 9} width="42" height="18" rx="3" fill="var(--gold)" stroke={INK} strokeWidth="1.5" />
            <text x={PL - 27} y={hovered.y + 4} textAnchor="middle" fontFamily={FONT} fontSize="14" fill={INK}>{Math.round(hovered.p.s * 100)}%</text>
            <rect x={clamp(hovered.x - 33, PL, PL + pw - 66)} y={PT + ph + 3} width="66" height="18" rx="3" fill="var(--gold)" stroke={INK} strokeWidth="1.5" />
            <text x={clamp(hovered.x, PL + 33, PL + pw - 33)} y={PT + ph + 16} textAnchor="middle" fontFamily={FONT} fontSize="14" fill={INK}>{clock(hovered.p.t, span)}</text>
            <g transform={`translate(${hovered.x} ${hovered.y - 6}) scale(1.35)`}>
              <CardGlyph w={hovered.w} h={hovered.h} color={TIER[hovered.p.tier]?.color || "#fff"} rank={TIER[hovered.p.tier]?.rank} anomaly={isAnom(hovered.p)} hot />
            </g>
          </g>
        )}

        {/* the zoom drag */}
        {sel && sel.moved && (
          <rect x={Math.min(sel.a, sel.b)} y={PT} width={Math.abs(sel.b - sel.a)} height={ph} fill="var(--gold)" opacity=".2" stroke="var(--gold)" strokeWidth="2" strokeDasharray="6 4" pointerEvents="none" />
        )}
      </svg>

      {pin && <FloatCard event={pin.event} anchor={{ x: pin.x, y: pin.y }} boxWidth={pin.width} onClose={() => setPin(null)} />}
    </div>
  )
}
