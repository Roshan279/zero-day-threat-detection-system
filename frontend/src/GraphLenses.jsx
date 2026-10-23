import { createContext, useContext, useEffect, useMemo, useState } from "react"
import PxIcon from "./px/PxIcon"
import PixelLuffy from "./px/PixelLuffy"
import { TIER, shortTitle } from "./px/cardModel"
import {
  DAYS, SOURCES, TIERS, bucketize, heatGrid, riskOf, sourceOf, stamp, topTier, tsOf,
} from "./graphData"

// ─────────────────────────────────────────────────────────────
// The seven ways to look at the same events. Every lens gets the already filtered events
// (time brush + tier toggles applied) and calls onPickTier(tier) to open those cards.
// ─────────────────────────────────────────────────────────────
const INK = "#1d2527"
const MUTED = "#9fb4b2"
const SVG_FONT = "var(--pxfont)"

// ── Shared tooltip (one floating box, driven imperatively so hovering never re-renders a chart) ──
let tipListener = null
export const showTip = (ev, tip) => { if (tipListener) tipListener({ x: ev.clientX, y: ev.clientY, ...tip }) }
export const hideTip = () => { if (tipListener) tipListener(null) }
const tp = (tip) => ({ onMouseMove: (ev) => showTip(ev, tip), onMouseLeave: hideTip })

export function Tip() {
  const [t, setT] = useState(null)
  useEffect(() => { tipListener = setT; return () => { tipListener = null } }, [])
  if (!t) return null
  return (
    <div className="pz-panel" style={{ position: "fixed", left: Math.max(8, Math.min(t.x + 14, window.innerWidth - 270)), top: t.y + 16, zIndex: 999, pointerEvents: "none", padding: "6px 10px", maxWidth: 260 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 20, fontWeight: 700 }}>
        {t.color && <span style={{ width: 12, height: 12, background: t.color, border: `2px solid ${INK}`, flexShrink: 0 }} />}
        {t.title}
      </div>
      {(t.lines || []).map((l, i) => <div key={i} style={{ fontSize: 16, color: "#cfe0dd" }}>{l}</div>)}
    </div>
  )
}

export function Empty({ children = "Nothing in this range." }) {
  return <div style={{ color: MUTED, padding: "26px 0", textAlign: "center", fontSize: 18 }}>{children}</div>
}

// Inside the chart window the window already has a title bar, so Box drops its own frame and shows just the hint.
export const BareCtx = createContext(false)

export function Box({ title, icon, children, style, right }) {
  const bare = useContext(BareCtx)
  if (bare) {
    return (
      <div>
        {right && <div style={{ fontSize: 16, color: MUTED, marginBottom: 8 }}>{right}</div>}
        {children}
      </div>
    )
  }
  return (
    <div className="pz-panel pz-fade-up" style={{ padding: 10, ...style }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <PxIcon name={icon} size={18} />
        <span className="pz-title" style={{ fontSize: 19 }}>{title}</span>
        {right && <span style={{ marginLeft: "auto", fontSize: 16, color: MUTED }}>{right}</span>}
      </div>
      {children}
    </div>
  )
}

function BarRow({ label, value, max, color, onClick, delay = 0, hint }) {
  const [hover, setHover] = useState(false)
  const pct = value ? Math.max(3, (value / Math.max(max, 1)) * 100) : 0
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ marginBottom: 5, cursor: onClick ? "pointer" : "default", transform: hover && onClick ? "translateX(4px)" : "none", transition: "transform .15s" }}
      title={hint}
    >
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, fontWeight: 600, marginBottom: 1 }}>
        <span style={{ paddingRight: 8 }}>{label}</span>
        <span style={{ color }}>{value}</span>
      </div>
      <div style={{ height: 16, background: "#1b2829", border: `3px solid ${INK}`, borderRadius: 6, overflow: "hidden" }}>
        <div className="pz-bar" style={{ width: `${pct}%`, height: "100%", background: color, boxShadow: "inset 0 -5px 0 rgba(0,0,0,.25), inset 0 3px 0 rgba(255,255,255,.25)", animationDelay: `${delay}s` }} />
      </div>
    </div>
  )
}

function DotGrid({ id, x, y, w, h }) {
  return (
    <>
      <defs>
        <pattern id={id} width="12" height="12" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#5f7f86" opacity=".35" /></pattern>
      </defs>
      <rect x={x} y={y} width={w} height={h} fill={`url(#${id})`} />
    </>
  )
}

const svgBase = { width: "100%", display: "block", overflow: "visible" }

export function StepLine({ events, W = 520, H = 150, idp = "sl" }) {
  const pts = events.map(e => [tsOf(e), e]).filter(([t]) => t != null).sort((a, b) => a[0] - b[0])
  if (!pts.length) return <Empty />
  const padL = 40, padR = 10, padT = 10, padB = 24
  const plotW = W - padL - padR, plotH = H - padT - padB
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0], span = Math.max(t1 - t0, 1)
  const scores = pts.map(p => p[1].anomaly_score || 0)
  let lo = Math.max(0, Math.floor((Math.min(...scores) - 0.05) * 10) / 10)
  let hi = Math.min(1, Math.ceil((Math.max(...scores) + 0.02) * 10) / 10)
  if (hi - lo < 0.2) { lo = Math.max(0, hi - 0.2); if (hi - lo < 0.2) hi = lo + 0.2 }
  const X = (t) => padL + (pts.length === 1 ? 0.5 : (t - t0) / span) * plotW
  const Y = (s) => padT + (1 - (s - lo) / (hi - lo)) * plotH
  let d = ""
  pts.forEach(([t, e], i) => {
    const x = X(t), y = Y(e.anomaly_score || 0)
    d += i === 0 ? `M${x} ${y}` : ` H${x} V${y}`
  })
  const ticks = [0, 1 / 3, 2 / 3, 1].map(f => lo + (hi - lo) * f)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={svgBase} role="img" aria-label="Anomaly score over time">
      <g shapeRendering="crispEdges">
        <DotGrid id={`${idp}-dots`} x={padL} y={padT} w={plotW} h={plotH} />
        {ticks.map((s, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={Y(s)} y2={Y(s)} stroke="#5f7f86" strokeWidth="1" strokeDasharray="2 6" opacity=".6" />
            <text x={padL - 6} y={Y(s) + 4} textAnchor="end" fontFamily={SVG_FONT} fontSize="14" fill={MUTED}>{Math.round(s * 100)}%</text>
          </g>
        ))}
        <path d={d} pathLength="1" fill="none" stroke="var(--gold)" strokeWidth="3" className="gl-draw" />
        {pts.map(([t, e]) => (
          <rect key={e.id} x={X(t) - 5} y={Y(e.anomaly_score || 0) - 5} width="10" height="10" fill={TIER[e.threat_tier]?.color || "#fff"} stroke={INK} strokeWidth="2" style={{ cursor: "pointer" }}
            {...tp({ title: shortTitle(e), color: TIER[e.threat_tier]?.color, lines: [stamp(t), `Score ${Math.round((e.anomaly_score || 0) * 100)}%`, TIER[e.threat_tier]?.name] })} />
        ))}
        <line x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} stroke={INK} strokeWidth="3" />
      </g>
      <text x={padL} y={H - 6} fontFamily={SVG_FONT} fontSize="13" fill={MUTED}>{stamp(t0)}</text>
      <text x={W - padR} y={H - 6} textAnchor="end" fontFamily={SVG_FONT} fontSize="13" fill={MUTED}>{stamp(t1)}</text>
    </svg>
  )
}

const HEAT = ["#223133", "#6b4a1a", "#a8680f", "#e08a00", "#ffc83a"]
export function Heatmap({ events, W = 520, H = 140 }) {
  const { grid, max } = useMemo(() => heatGrid(events), [events])
  if (!max) return <Empty>No timestamps to plot.</Empty>
  const padL = 36, padT = 6, padB = 20
  const cw = (W - padL) / 24, ch = (H - padT - padB) / 7
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={svgBase} shapeRendering="crispEdges" role="img" aria-label="Events by weekday and hour">
      {grid.map((row, r) => (
        <g key={r}>
          <text x={padL - 6} y={padT + r * ch + ch / 2 + 4} textAnchor="end" fontFamily={SVG_FONT} fontSize="14" fill={MUTED}>{DAYS[r]}</text>
          {row.map((v, c) => (
            <rect key={c} x={padL + c * cw + 1} y={padT + r * ch + 1} width={cw - 2} height={ch - 2}
              fill={HEAT[v ? Math.max(1, Math.ceil((v / max) * 4)) : 0]} stroke={v ? INK : "none"} strokeWidth="1.5"
              {...tp({ title: `${DAYS[r]} ${String(c).padStart(2, "0")}:00`, lines: [`${v} event${v === 1 ? "" : "s"}`] })} />
          ))}
        </g>
      ))}
      {[0, 6, 12, 18, 23].map(h => <text key={h} x={padL + h * cw + cw / 2} y={H - 5} textAnchor="middle" fontFamily={SVG_FONT} fontSize="13" fill={MUTED}>{h}h</text>)}
    </svg>
  )
}

export function ListBars({ rows, color, empty }) {
  const max = Math.max(...rows.map(r => r[1]), 1)
  if (!rows.length) return <Empty>{empty}</Empty>
  return rows.map(([name, count], i) => <BarRow key={name} label={name} value={count} max={max} color={color} delay={i * 0.05} />)
}


export function Dial({ value, label, sub, W = 300, H = 200, segments = 24, big = true }) {
  const [v, setV] = useState(0)
  useEffect(() => { const id = requestAnimationFrame(() => setV(value)); return () => cancelAnimationFrame(id) }, [value])
  const cx = W / 2, cy = H - 58, R = Math.min(W / 2 - 10, cy - 8), r = R * 0.7
  const colorAt = (f) => (f < 0.4 ? "#4bc292" : f < 0.65 ? "#ffc83a" : f < 0.85 ? "#ff9a00" : "#fe5f55")
  const band = value < 0.25 ? "CALM" : value < 0.5 ? "WATCHFUL" : value < 0.75 ? "DANGER" : "CRITICAL"
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={svgBase} role="img" aria-label={`${label}: ${Math.round(value * 100)}%`}>
      {Array.from({ length: segments }, (_, i) => {
        const f = (i + 0.5) / segments
        const a = Math.PI * (1 - f)
        const mr = (R + r) / 2
        const lit = f <= v
        return (
          <rect key={i} x={-(R - r) / 2} y={-7} width={R - r} height={14}
            transform={`translate(${cx + Math.cos(a) * mr} ${cy - Math.sin(a) * mr}) rotate(${(-a * 180) / Math.PI})`}
            fill={lit ? colorAt(f) : "#243234"} stroke={INK} strokeWidth="2" style={{ transition: `fill .2s ${i * 0.02}s` }} />
        )
      })}
      <g style={{ transform: `rotate(${v * 180 - 90}deg)`, transformOrigin: `${cx}px ${cy}px`, transition: "transform .9s steps(12)" }}>
        <polygon points={`${cx - 5},${cy} ${cx},${cy - R + 4} ${cx + 5},${cy}`} fill="#fff" stroke={INK} strokeWidth="2" />
      </g>
      <rect x={cx - 9} y={cy - 9} width="18" height="18" fill={INK} />
      <rect x={cx - 5} y={cy - 5} width="10" height="10" fill="#fff" />
      <text x={cx} y={cy + (big ? 38 : 30)} textAnchor="middle" fontFamily={SVG_FONT} fontSize={big ? 38 : 28} fill="#fff" stroke={INK} strokeWidth="5" paintOrder="stroke">{Math.round(value * 100)}%</text>
      <text x={cx} y={H - 4} textAnchor="middle" fontFamily={SVG_FONT} fontSize="17" fill={colorAt(value)}>{sub || band}</text>
      <text x={cx - R + 6} y={cy + 18} textAnchor="middle" fontFamily={SVG_FONT} fontSize="13" fill={MUTED}>0</text>
      <text x={cx + R - 6} y={cy + 18} textAnchor="middle" fontFamily={SVG_FONT} fontSize="13" fill={MUTED}>100</text>
    </svg>
  )
}


// ── Threat levels as chips: one chip per event, a column per level ──
export function LevelTokens({ events, onPickTier }) {
  const by = { 1: [], 2: [], 3: [], 4: [] }
  events.forEach(e => { if (by[e.threat_tier]) by[e.threat_tier].push(e) })
  const W = 440, H = 190, padB = 40, padT = 6
  const avail = H - padB - padT
  const maxT = Math.max(...TIERS.map(t => by[t].length), 1)
  const slotW = W / 4
  let sq = 5
  for (const s of [14, 12, 10, 8, 6]) {
    const cols = Math.ceil(maxT / Math.max(1, Math.floor(avail / (s + 2))))
    if (cols * (s + 2) <= slotW - 14) { sq = s; break }
  }
  const rows = Math.max(1, Math.floor(avail / (sq + 2)))
  return (
    <Box title="Threat levels" icon="warn" right="one chip per event. click a column to open it">
      <svg viewBox={`0 0 ${W} ${H}`} style={svgBase} shapeRendering="crispEdges" role="img" aria-label="Events as chips, one column per threat level">
        {[4, 3, 2, 1].map((t, ci) => {
          const evs = by[t].slice().sort((a, b) => (a.anomaly_score || 0) - (b.anomaly_score || 0))
          const x0 = ci * slotW + 7
          return (
            <g key={t} style={{ cursor: evs.length ? "pointer" : "default" }} onClick={() => evs.length && onPickTier(t)}>
              <rect x={ci * slotW} y="0" width={slotW} height={H - padB} fill="transparent" />
              {evs.map((e, k) => (
                <rect key={e.id ?? k} className="gl-drop" x={x0 + Math.floor(k / rows) * (sq + 2)} y={H - padB - ((k % rows) + 1) * (sq + 2)} width={sq} height={sq}
                  fill={TIER[t].color} stroke={INK} strokeWidth="2" style={{ animationDelay: `${ci * 0.1 + k * 0.01}s` }}
                  {...tp({ title: shortTitle(e), color: TIER[t].color, lines: [e.timestamp, `Score ${Math.round((e.anomaly_score || 0) * 100)}%`] })} />
              ))}
              <line x1={ci * slotW + 4} x2={(ci + 1) * slotW - 4} y1={H - padB} y2={H - padB} stroke={INK} strokeWidth="3" />
              <text x={ci * slotW + slotW / 2} y={H - 24} textAnchor="middle" fontFamily={SVG_FONT} fontSize="17" fill={TIER[t].color}>{TIER[t].name}</text>
              <text x={ci * slotW + slotW / 2} y={H - 6} textAnchor="middle" fontFamily={SVG_FONT} fontSize="18" fill="#fff">{evs.length}</text>
            </g>
          )
        })}
      </svg>
    </Box>
  )
}

// ── 4. ISOMETRIC: the threat cube, stretched along the time axis ──
export function IsoLens({ events, onPickTier }) {
  const { buckets } = useMemo(() => bucketize(events, 14), [events])
  const [hov, setHov] = useState(-1)
  const n = buckets.length
  if (!n) return <Empty />
  const T = 24, OX = 60, MAXH = 90
  const maxT = Math.max(...buckets.map(b => b.total), 1)
  const unit = Math.min(9, MAXH / maxT)
  const OY = 24 + MAXH
  const P = (u, v, z) => [OX + (u - v) * T, OY + ((u + v) * T) / 2 - z]
  const pts = (l) => l.map(p => p.join(",")).join(" ")
  const W = OX + (n + 1) * T + 40, H = OY + ((n + 1) * T) / 2 + 44
  const every = Math.max(1, Math.ceil(n / 8))
  return (
    <Box title="Threat towers over time" icon="warn" right="hover to lift a tower">
      <svg viewBox={`0 0 ${W} ${H}`} style={svgBase} role="img" aria-label="Isometric towers of events per time slot">
        <polygon points={pts([P(-0.4, -0.4, 0), P(n, -0.4, 0), P(n, 1.3, 0), P(-0.4, 1.3, 0)])} fill="rgba(0,0,0,.28)" stroke="#5f7f86" strokeWidth="2" />
        {Array.from({ length: n + 1 }, (_, i) => { const [x, y] = P(i - 0.1, 0.45, 0); return <rect key={i} x={x - 1.5} y={y - 1.5} width="3" height="3" fill="#5f7f86" shapeRendering="crispEdges" /> })}
        {buckets.map((b, i) => {
          let z = 0
          const lift = hov === i ? 12 : 0
          const u0 = i, u1 = i + 0.8, v0 = 0.05, v1 = 0.85
          const top = topTier(b.counts)
          const segs = TIERS.filter(t => b.counts[t]).map(t => {
            const h = Math.max(4, b.counts[t] * unit)
            const z0 = z; z += h
            const t_ = TIER[t]
            return (
              <g key={t}>
                <polygon points={pts([P(u0, v1, z0), P(u1, v1, z0), P(u1, v1, z), P(u0, v1, z)])} fill={t_.dark} stroke={INK} strokeWidth="2" />
                <polygon points={pts([P(u1, v0, z0), P(u1, v1, z0), P(u1, v1, z), P(u1, v0, z)])} fill={t_.dark} opacity=".78" stroke={INK} strokeWidth="2" />
                <polygon points={pts([P(u0, v0, z), P(u1, v0, z), P(u1, v1, z), P(u0, v1, z)])} fill={t_.color} stroke={INK} strokeWidth="2" />
              </g>
            )
          })
          const [lx, ly] = P(u0 + 0.4, v1, 0)
          const [cx, cy] = P(u0 + 0.4, 0.45, z)
          return (
            <g key={b.i} style={{ cursor: top ? "pointer" : "default", opacity: hov >= 0 && hov !== i ? 0.45 : 1, transition: "opacity .2s" }}
              onMouseEnter={() => setHov(i)} onMouseLeave={() => { setHov(-1); hideTip() }}
              onClick={() => top && onPickTier(top)}
              onMouseMove={(ev) => showTip(ev, { title: `${b.total} event${b.total === 1 ? "" : "s"}`, lines: [stamp(b.t0), ...TIERS.slice().reverse().filter(t => b.counts[t]).map(t => `${TIER[t].name}: ${b.counts[t]}`)] })}>
              <g className="pz-vbar" style={{ transform: `translateY(${-lift}px)`, transition: "transform .25s steps(5)", transformBox: "fill-box", transformOrigin: "bottom", animationDelay: `${i * 0.05}s` }}>
                {segs}
                {b.total > 0 && <text x={cx} y={cy - 8} textAnchor="middle" fontFamily={SVG_FONT} fontSize="16" fill="#fff" stroke={INK} strokeWidth="4" paintOrder="stroke">{b.total}</text>}
              </g>
              {i % every === 0 && <text x={lx} y={ly + 18} textAnchor="middle" fontFamily={SVG_FONT} fontSize="13" fill={MUTED}>{b.label}</text>}
            </g>
          )
        })}
      </svg>
    </Box>
  )
}

// ── Risk: the one number, with Luffy's read on it ──
export function RiskDial({ events }) {
  const bare = useContext(BareCtx)
  const r = useMemo(() => riskOf(events), [events])
  const mood = r.risk >= 0.75 ? "angry" : r.risk >= 0.5 ? "alert" : r.risk >= 0.25 ? "thinking" : "happy"
  const say = { angry: "This is bad. Look at the red cards.", alert: "A lot of high-risk events. Stay sharp.", thinking: "Some activity worth watching.", happy: "All quiet. Nothing scary here." }[mood]
  const stat = (label, v) => <div style={{ textAlign: "center" }}><div style={{ fontSize: 18, fontWeight: 700 }}>{Math.round(v * 100)}%</div><div style={{ fontSize: 15, color: MUTED }}>{label}</div></div>
  return (
    <Box title="Risk" icon="eye" right="60% average severity + 40% critical share">
      <div style={{ maxWidth: bare ? 380 : 210, margin: "0 auto" }}><Dial value={r.risk} label="Risk" W={260} H={170} /></div>
      <div style={{ display: "flex", justifyContent: "space-around", margin: "0 0 6px" }}>
        {stat("critical share", r.critShare)}{stat("high and up", r.highShare)}{stat("avg anomaly", r.avgScore)}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <PixelLuffy mood={mood} height={46} />
        <div className="pz-panel paper" style={{ padding: "4px 8px", fontSize: 15, flex: 1 }}>{say}</div>
      </div>
    </Box>
  )
}

// ── 6. BOARD: a game board, events are pawns placed by source (row) and time (column) ──
function Pawn({ x, y, s, color }) {
  const r = (rx, ry, w, h, f) => <rect x={x + rx * s} y={y + ry * s} width={w * s} height={h * s} fill={f} />
  return (
    <g shapeRendering="crispEdges">
      {r(1, -1, 5, 5, INK)}{r(0, 3, 7, 5, INK)}{r(-1, 6, 9, 4, INK)}
      {r(2, 0, 3, 3, color)}{r(1, 3, 5, 3, color)}{r(0, 6, 7, 2, color)}
      {r(2, 0, 1, 1, "rgba(255,255,255,.55)")}
    </g>
  )
}

export function BoardLens({ events, onPickTier }) {
  const { buckets } = useMemo(() => bucketize(events, 12), [events])
  const n = buckets.length
  if (!n) return <Empty />
  const rows = SOURCES.filter(s => s !== "Other" || events.some(e => sourceOf(e) === "Other"))
  const W = 880, padL = 108, padB = 22, ch = 50
  const H = rows.length * ch + padB + 6
  const cw = (W - padL) / n
  const s = Math.min(2.4, cw / 34)
  const suit = { Security: "spade", System: "club", Application: "diamond", Other: "heart" }
  return (
    <Box title="The board" icon="dice" right="rows are log sources, columns are time. one pawn per event">
      <svg viewBox={`0 0 ${W} ${H}`} style={svgBase} role="img" aria-label="Game board of events by source and time">
        {rows.map((src, r) => (
          <g key={src}>
            <foreignObject x="2" y={r * ch + ch / 2 - 14} width="28" height="28"><PxIcon suit={suit[src]} size={26} color="#cfe0dd" /></foreignObject>
            <text x="34" y={r * ch + ch / 2 + 5} fontFamily={SVG_FONT} fontSize="18" fill="#cfe0dd">{src}</text>
            {buckets.map((b, c) => {
              const here = b.events.filter(e => sourceOf(e) === src).sort((a, z) => z.threat_tier - a.threat_tier)
              const shown = here.slice(0, 4)
              const top = here[0]?.threat_tier
              return (
                <g key={c} style={{ cursor: top ? "pointer" : "default" }} onClick={() => top && onPickTier(top)}
                  {...(here.length ? tp({ title: `${src}, ${b.label}`, color: TIER[top].color, lines: [`${here.length} event${here.length === 1 ? "" : "s"}`, ...TIERS.slice().reverse().map(t => [t, here.filter(e => e.threat_tier === t).length]).filter(x => x[1]).map(([t, k]) => `${TIER[t].name}: ${k}`)] }) : {})}>
                  <rect x={padL + c * cw} y={r * ch} width={cw} height={ch} fill={(r + c) % 2 ? "#2c4144" : "#365054"} stroke={INK} strokeWidth="2" shapeRendering="crispEdges" />
                  {shown.map((e, k) => (
                    <g key={e.id ?? k} className="gl-drop" style={{ animationDelay: `${c * 0.05 + k * 0.05}s` }}>
                      <Pawn x={padL + c * cw + 8 + k * (cw - 12) / 4} y={r * ch + 12} s={s} color={TIER[e.threat_tier]?.color || "#fff"} />
                    </g>
                  ))}
                  {here.length > 4 && <text x={padL + (c + 1) * cw - 4} y={r * ch + ch - 6} textAnchor="end" fontFamily={SVG_FONT} fontSize="15" fill="#fff" stroke={INK} strokeWidth="4" paintOrder="stroke">+{here.length - 4}</text>}
                </g>
              )
            })}
          </g>
        ))}
        {buckets.map((b, c) => (n > 8 && c % 2 ? null : <text key={c} x={padL + c * cw + cw / 2} y={H - 8} textAnchor="middle" fontFamily={SVG_FONT} fontSize="13" fill={MUTED}>{b.label}</text>))}
      </svg>
    </Box>
  )
}


export const GRAPH_CSS = `
@keyframes gl-draw { from { stroke-dashoffset: 1 } to { stroke-dashoffset: 0 } }
.gl-draw { stroke-dasharray: 1; animation: gl-draw 1s steps(24) backwards; }
@keyframes gl-drop { from { transform: translateY(-26px); opacity: 0 } to { transform: none; opacity: 1 } }
.gl-drop { animation: gl-drop .35s steps(5) backwards; }
@media (prefers-reduced-motion: reduce) { .gl-draw, .gl-drop { animation: none } .gl-draw { stroke-dasharray: none } }
`
