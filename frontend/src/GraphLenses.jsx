import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import PxIcon from "./px/PxIcon"
import PixelLuffy from "./px/PixelLuffy"
import TierTerrain from "./TierTerrain"
import SummaryCard from "./SummaryCard"
import { TIER, shortTitle } from "./px/cardModel"
import {
  DAYS, SOURCES, TIERS, bucketize, heatGrid, riskOf, sourceOf, stamp,
} from "./graphData"

// ─────────────────────────────────────────────────────────────
// The seven ways to look at the same events. Every lens gets the already filtered events
// (time brush + tier toggles applied). Nothing in here opens the Events tab: the charts only show.
// ─────────────────────────────────────────────────────────────
const INK = "#1d2527"
const MUTED = "#b5e8f2"
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
      {(t.lines || []).map((l, i) => <div key={i} style={{ fontSize: 16, color: "#dcdcdc" }}>{l}</div>)}
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
      <div style={{ height: 16, background: "#2a3638", border: `3px solid ${INK}`, borderRadius: 6, overflow: "hidden" }}>
        <div className="pz-bar" style={{ width: `${pct}%`, height: "100%", background: color, boxShadow: "inset 0 -5px 0 rgba(0,0,0,.25), inset 0 3px 0 rgba(255,255,255,.25)", animationDelay: `${delay}s` }} />
      </div>
    </div>
  )
}

function DotGrid({ id, x, y, w, h }) {
  return (
    <>
      <defs>
        <pattern id={id} width="12" height="12" patternUnits="userSpaceOnUse"><rect width="3" height="3" fill="#5e7977" opacity=".35" /></pattern>
      </defs>
      <rect x={x} y={y} width={w} height={h} fill={`url(#${id})`} />
    </>
  )
}

const svgBase = { width: "100%", display: "block", overflow: "visible" }

const HEAT = ["#2f3b3e", "#6b4a1a", "#a8680f", "#e08a00", "#fdcf51"]
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


// ── A count per kind, dealt as a row of cards instead of bars ──
// Each card: a rank and suit in the corner, a sprite that fits the kind of event, its name, the count in big
// numbers and its share, and a little pile whose height is that share (a taller pile is a bigger group).
const CG_RANKS = ["A", "K", "Q", "J", "10", "9", "8", "7"]
const CG_SUITS = ["spade", "heart", "diamond", "club"]
const CG_ART = [
  [/privilege|escalat/i, "star"],
  [/crash|\bhang\b|stopped responding|failed to/i, "bug"],
  [/power|standby|display|wi-?fi|driver|adapter|network card/i, "bolt"],
  [/service|install|licen|retired|software/i, "gear"],
  [/dcom|permission|locked|logon|logged/i, "lock"],
  [/backup|snapshot|restore|database|certificate/i, "scroll"],
  [/brute|password|login|logon|attempt/i, "key"],
  [/exfil|network|transfer|connection|firewall/i, "globe"],
  [/persist|schedule|task|startup|service|install/i, "clock"],
  [/credential|account|privilege|lock/i, "lock"],
  [/normal|system|activity|win32k|kernel/i, "eye"],
  [/malware|crash|bug|error|fail/i, "bug"],
]
const artFor = (name) => (CG_ART.find(([re]) => re.test(name)) || [null, "scroll"])[1]

export function CardGrid({ rows, tint, empty = "Nothing here yet." }) {
  const total = rows.reduce((s, r) => s + r[1], 0)
  const max = Math.max(...rows.map(r => r[1]), 1)
  if (!rows.length) return <Empty>{empty}</Empty>
  return (
    <div className="cg-grid">
      {rows.map(([name, count, note], i) => {
        const suit = CG_SUITS[i % 4], red = suit === "heart" || suit === "diamond"
        const none = count === 0
        const col = none ? "#dcdcdc" : red ? "#c0443b" : "#1d2527"
        const share = total ? Math.round((count / total) * 100) : 0
        const slabs = Math.max(1, Math.round((count / max) * 7))
        return (
          <div key={name} className={`cg-card ${none ? "none" : ""}`} style={{ "--tint": tint, "--r": `${[-1.5, 1, -0.5, 1.5, -1][i % 5]}deg`, animationDelay: `${i * 0.06}s` }}
            role="img" aria-label={none ? `${name}: not seen` : `${name}: ${count} events, ${share} percent`}>
            <div className="cg-corner" style={{ color: col }}><span className="cg-rank">{CG_RANKS[i % 8]}</span><PxIcon suit={suit} size={14} color={col} /></div>
            <div className="cg-frame"><PxIcon name={artFor(name)} size={44} /></div>
            <div className="cg-name">{name}</div>
            {note && <div className="cg-note">{note}</div>}
            <div className="cg-count">{count}</div>
            <div className="cg-share">{none ? "not seen yet" : `${share}% of these`}</div>
            {!none && <div className="cg-pile" aria-hidden="true">
              {Array.from({ length: slabs }, (_, k) => <i key={k} style={{ width: `${100 - k * 2}%` }} />)}
            </div>}
          </div>
        )
      })}
    </div>
  )
}

// ── Contamination: one number (the flask), and the events behind it (the terrain and the level cards) ──
const SUITS = { 1: "heart", 2: "club", 3: "diamond", 4: "spade" }
const WORDS = { 1: "CLEAN", 2: "TRACES", 3: "TOXIC", 4: "CONTAMINATED" }

export function RiskPanel({ events }) {
  const r = useMemo(() => riskOf(events), [events])
  const mood = r.risk >= 0.75 ? "angry" : r.risk >= 0.5 ? "alert" : r.risk >= 0.25 ? "thinking" : "happy"
  const say = { angry: "The system is contaminated. Look at the red cards.", alert: "Toxic levels. A lot of high-risk events. Stay sharp.", thinking: "Traces of suspicious activity. Worth a look.", happy: "Clean. Nothing scary here." }[mood]
  const pct = Math.round(r.risk * 100)
  const level = r.risk < 0.25 ? 1 : r.risk < 0.5 ? 2 : r.risk < 0.75 ? 3 : 4
  const chips = events.length
  const mult = chips ? events.reduce((s, e) => s + (TIER[e.threat_tier]?.mult || 1), 0) / chips : 0
  return (
    <Box title="Contamination and threat levels" icon="warn" right="contamination = 60% average severity + 40% critical share. click a column or a card for a summary">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 220px", maxWidth: 250, margin: "0 auto" }}>
          <div className="cn-card" style={{ "--c": TIER[level].dark }} role="img" aria-label={`Contamination ${pct} percent, ${TIER[level].name}`}>
            <div className="cn-corner tl"><div className="cn-rank">{TIER[level].rank}</div><PxIcon suit={SUITS[level]} size={20} color={level % 2 ? "#ec2d33" : "#1d2527"} /></div>
            <div className="cn-corner br"><div className="cn-rank">{TIER[level].rank}</div><PxIcon suit={SUITS[level]} size={20} color={level % 2 ? "#ec2d33" : "#1d2527"} /></div>
            <div className="cn-label">CONTAMINATION</div>
            <div className="cn-num">{pct}<span>%</span></div>
            <div className="cn-word">{WORDS[level]}</div>
          </div>
          <div style={{ textAlign: "center", fontSize: 16, color: MUTED, margin: "2px 0 10px" }}>
            {chips} events, average threat multiplier {mult.toFixed(1)}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <PixelLuffy mood={mood} height={42} />
            <div className="pz-panel paper" style={{ padding: "4px 8px", fontSize: 15, flex: 1 }}>{say}</div>
          </div>
        </div>
        <div style={{ flex: "2 1 340px", minWidth: 0 }}>
          <TierTerrain events={events} />
        </div>
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

export function BoardLens({ events }) {
  const wrapRef = useRef(null)
  const [float, setFloat] = useState(null)
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
    <Box title="The board" icon="dice" right="rows are log sources, columns are time. one pawn per event. click a cell for a summary">
      <div ref={wrapRef} style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={svgBase} role="img" aria-label="Game board of events by source and time">
        {rows.map((src, r) => (
          <g key={src}>
            <foreignObject x="2" y={r * ch + ch / 2 - 14} width="28" height="28"><PxIcon suit={suit[src]} size={26} color="#dcdcdc" /></foreignObject>
            <text x="34" y={r * ch + ch / 2 + 5} fontFamily={SVG_FONT} fontSize="18" fill="#dcdcdc">{src}</text>
            {buckets.map((b, c) => {
              const here = b.events.filter(e => sourceOf(e) === src).sort((a, z) => z.threat_tier - a.threat_tier)
              const shown = here.slice(0, 4)
              const top = here[0]?.threat_tier
              return (
                <g key={c} style={{ cursor: top ? "pointer" : "default" }}
                  onClick={(ev) => { if (!top) return; const w = wrapRef.current.getBoundingClientRect(), r = ev.currentTarget.getBoundingClientRect(); setFloat({ src, b, here, x: r.left - w.left + r.width / 2, y: r.top - w.top, width: w.width }) }}
                  {...(here.length ? tp({ title: `${src}, ${b.label}`, color: TIER[top].color, lines: [`${here.length} event${here.length === 1 ? "" : "s"}`, ...TIERS.slice().reverse().map(t => [t, here.filter(e => e.threat_tier === t).length]).filter(x => x[1]).map(([t, k]) => `${TIER[t].name}: ${k}`)] }) : {})}>
                  <rect x={padL + c * cw} y={r * ch} width={cw} height={ch} fill={(r + c) % 2 ? "#3d4d51" : "#365054"} stroke={INK} strokeWidth="2" shapeRendering="crispEdges" />
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
      {float && (() => {
        const SUIT = { Security: "spade", System: "club", Application: "diamond", Other: "heart" }
        const list = float.here.slice().sort((a, b) => (b.anomaly_score || 0) - (a.anomaly_score || 0))
        const worst = list[0]
        const t = worst.threat_tier
        return (
          <SummaryCard anchor={{ x: float.x, y: float.y }} boxWidth={float.width} color={TIER[t].color} rank={TIER[t].rank} suit={SUIT[float.src]} icon="dice"
            title={`${float.src} log`} sub={float.b.label}
            stats={[["Time", stamp(float.b.t0)], ["Events", list.length], ["Worst", `${TIER[t].name}, ${Math.round((worst.anomaly_score || 0) * 100)}%`]]}
            rows={list.slice(0, 4).map(e => [shortTitle(e), `${Math.round((e.anomaly_score || 0) * 100)}%`])} onClose={() => setFloat(null)} />
        )
      })()}
      </div>
    </Box>
  )
}


export const GRAPH_CSS = `
@keyframes gl-draw { from { stroke-dashoffset: 1 } to { stroke-dashoffset: 0 } }
.gl-draw { stroke-dasharray: 1; animation: gl-draw 1s steps(24) backwards; }
@keyframes gl-drop { from { transform: translateY(-26px); opacity: 0 } to { transform: none; opacity: 1 } }
.gl-drop { animation: gl-drop .35s steps(5) backwards; }
@keyframes sc-reveal { from { width: 0 } }
.sc-reveal { animation: sc-reveal 1s steps(24) backwards; }

.cn-card { position: relative; height: 280px; padding: 0 46px; margin: 0 auto 12px; border: 5px solid #1d2527; border-radius: 14px; background: var(--paper); color: #1d2527; text-align: center;
  display: flex; flex-direction: column; align-items: center; justify-content: center; }
.cn-card::before { content: ""; position: absolute; inset: 7px; border: 2px dashed rgba(29,37,39,.25); border-radius: 9px; pointer-events: none; }
.cn-corner { position: absolute; display: flex; flex-direction: column; align-items: center; line-height: 1; }
.cn-corner.tl { left: 14px; top: 12px; } .cn-corner.br { right: 14px; bottom: 12px; transform: rotate(180deg); }
.cn-rank { font-family: var(--pxfont); font-size: 28px; }
.cn-label { font-family: var(--pxfont); font-size: 15px; letter-spacing: .1em; color: #5e7977; white-space: nowrap; margin-bottom: 4px; }
.cn-num { font-family: var(--pxfont); font-size: 84px; line-height: .95; color: var(--c); white-space: nowrap; }
.cn-num span { font-size: 42px; }
.cn-word { font-family: var(--pxfont); font-size: 22px; letter-spacing: .06em; color: var(--c); margin-top: 4px; white-space: nowrap; }
.bt-felt { position: relative; border: 4px solid #1d2527; border-radius: 12px; overflow: hidden;
  background: #4f7869; }
.bt-felt::after { content: ""; position: absolute; inset: 8px; border: 2px dashed rgba(255,255,255,.2); border-radius: 8px; pointer-events: none; }
.bt-minis { display: flex; justify-content: center; gap: 16px; margin-top: 18px; padding: 6px 0 10px; }
.bt-mini { position: relative; width: 92px; height: 130px; padding: 0; flex: none; border: 2px solid #b4aea0; border-radius: 9px; box-shadow: 0 5px 0 rgba(0,0,0,.34); cursor: pointer; color: #1d2527; text-align: left;
  background-color: var(--paper);   transform: rotate(var(--r)); transition: transform .15s steps(3); }
.bt-mini { cursor: pointer; }
.bt-mini:hover:not(.zero), .bt-mini:focus-visible { transform: translateY(-12px) rotate(0deg) scale(1.06); outline: none; z-index: 3; }
.bt-mini.zero { filter: grayscale(.9) brightness(.7); cursor: default; }
.bt-mini .corner { position: absolute; left: 5px; top: 3px; display: flex; flex-direction: column; align-items: center; line-height: 1; }
.bt-mini .rank { font-family: var(--pxfont); font-size: 22px; }
.bt-mini .art { position: absolute; left: 30px; right: 5px; top: 9px; height: 54px; display: flex; align-items: center; justify-content: center; }
.bt-mini .num { position: absolute; left: 0; right: 0; bottom: 0; height: 30px; display: flex; align-items: center; justify-content: center; border-top: 2px solid #b4aea0; color: var(--c); font-family: var(--pxfont); font-size: 24px; }
.bt-mini .name { position: absolute; left: 4px; right: 4px; bottom: 36px; text-align: center; font-family: var(--pxfont); font-size: 13px; letter-spacing: .04em; color: #5e7977; }
.cg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(138px, 1fr)); gap: 16px 12px; padding: 4px 2px 8px; }
.cg-card { position: relative; padding: 8px 8px 10px; background: #f8f4ec; color: #1d2527; border: 2px solid #b4aea0; border-radius: 12px; box-shadow: 0 5px 0 rgba(0,0,0,.34);
  display: flex; flex-direction: column; align-items: center; text-align: center; transform: rotate(var(--r)); transition: transform .15s; animation: pz-bounce-in .4s ease backwards; }
.cg-card:hover { transform: translateY(-8px) rotate(0deg); }
.cg-card.none { background: transparent; border: 2px dashed rgba(255,255,255,.45); box-shadow: none; color: #dcdcdc; opacity: .8; }
.cg-card.none .cg-frame { filter: grayscale(1) opacity(.55); background: rgba(255,255,255,.08); border-color: rgba(255,255,255,.3); }
.cg-card.none .cg-count { color: rgba(255,255,255,.55); }
.cg-card.none .cg-share { color: #b5e8f2; }
.cg-corner { position: absolute; left: 6px; top: 5px; display: flex; flex-direction: column; align-items: center; line-height: 1; }
.cg-rank { font-family: var(--pxfont); font-size: 21px; font-weight: 700; }
.cg-frame { width: 66px; height: 66px; display: flex; align-items: center; justify-content: center; margin: 2px 0 6px 22px; border-radius: 6px;
  background: color-mix(in srgb, var(--tint) 26%, #f8f4ec); border: 2px solid color-mix(in srgb, var(--tint) 58%, #f8f4ec); }
.cg-name { font-size: 15px; font-weight: 700; line-height: 1.05; min-height: 32px; display: flex; align-items: center; justify-content: center; padding: 0 2px; }
.cg-note { font-size: 12px; color: #7a7466; line-height: 1.1; margin-top: 1px; }
.cg-count { font-family: var(--pxfont); font-size: 38px; line-height: 1; color: var(--tint); margin-top: 2px; }
.cg-share { font-size: 13px; color: #6b7b78; margin-bottom: 6px; }
.cg-pile { width: 60%; display: flex; flex-direction: column-reverse; gap: 1px; align-items: center; margin-top: auto; }
.cg-pile i { display: block; height: 4px; background: var(--tint); border: 1.5px solid #1d2527; border-radius: 1px; }
@media (prefers-reduced-motion: reduce) { .cg-card { animation: none; transition: none; } }
@media (prefers-reduced-motion: reduce) { .bt-mini { transition: none } }
@media (prefers-reduced-motion: reduce) { .gl-draw, .gl-drop, .sc-reveal { animation: none } .gl-draw { stroke-dasharray: none } }
`
