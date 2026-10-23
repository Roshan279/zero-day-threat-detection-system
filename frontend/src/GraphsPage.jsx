import { useEffect, useMemo, useRef, useState } from "react"
import { TIER, tierOf } from "./px/cardModel"
import { bucketize, clusterCounts, commonEvents, heatGrid, riskOf, sourceOf, stamp, tierCounts, tsOf, TIERS, SOURCES } from "./graphData"
import GraphDeck, { DECK_CSS } from "./GraphDeck"
import PxIcon from "./px/PxIcon"
import {
  BareCtx, BoardLens, Box, Empty, GRAPH_CSS, Heatmap, IsoLens, LevelTokens, ListBars, RiskDial, StepLine, Tip, hideTip,
} from "./GraphLenses"

// ─────────────────────────────────────────────────────────────
// GRAPHS: the numbers behind the cards. Each chart answers one question, once:
//   how bad (dial), where it piles up (chips), how it moves (towers), which events stand out (step line),
//   which log and when (board), which hours (heatmap), what kind (clusters, common events).
// Controls above everything:
//   - tier chips switch a threat level on or off
//   - each chart is a card in a deck; click the top card to open its chart in a window
//   - the overview strip is a brush: drag across it to filter every chart to that time range
// ─────────────────────────────────────────────────────────────
function Brush({ master, range, onChange }) {
  const ref = useRef(null)
  const [drag, setDrag] = useState(null)
  const { buckets } = master
  if (!buckets.length) return null
  const W = 880, H = 48, padB = 14
  const T0 = buckets[0].t0, T1 = buckets[buckets.length - 1].t1
  const step = buckets[0].t1 - buckets[0].t0
  const X = (t) => ((t - T0) / (T1 - T0)) * W
  const tAt = (cx) => { const r = ref.current.getBoundingClientRect(); return T0 + Math.min(1, Math.max(0, (cx - r.left) / r.width)) * (T1 - T0) }
  const snap = (a, b) => [T0 + Math.floor((Math.min(a, b) - T0) / step) * step, Math.min(T1, T0 + Math.ceil((Math.max(a, b) - T0) / step) * step)]
  const sel = drag ? snap(drag.a, drag.b) : range
  const maxT = Math.max(...buckets.map(b => b.total), 1)
  const bw = W / buckets.length

  const end = (e) => {
    if (!drag) return
    if (Math.abs(e.clientX - drag.cx) < 4) onChange(null)
    else onChange(snap(drag.a, drag.b))
    setDrag(null)
  }
  return (
    <div className="pz-panel" style={{ padding: "6px 12px 6px", marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, fontSize: 17 }}>
        <span className="pz-title" style={{ fontSize: 20 }}>Time brush</span>
        <span style={{ color: "#9fb4b2" }}>{sel ? `${stamp(sel[0])}  to  ${stamp(sel[1])}` : "drag across the strip to zoom every chart. click to clear."}</span>
        {range && <button className="pz-btn gray small" style={{ marginLeft: "auto" }} onClick={() => onChange(null)}>Clear range</button>}
      </div>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block", cursor: "col-resize", touchAction: "none", userSelect: "none" }} shapeRendering="crispEdges"
        role="slider" aria-label="Time range filter" aria-valuetext={sel ? `${stamp(sel[0])} to ${stamp(sel[1])}` : "all time"}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const t = tAt(e.clientX); setDrag({ a: t, b: t, cx: e.clientX }) }}
        onPointerMove={(e) => { if (drag) setDrag({ ...drag, b: tAt(e.clientX) }) }}
        onPointerUp={end} onPointerCancel={() => setDrag(null)}>
        <rect x="0" y="0" width={W} height={H - padB} fill="#1b2829" />
        {buckets.map((b, i) => {
          let y = H - padB
          return TIERS.map(t => {
            const h = (b.counts[t] / maxT) * (H - padB - 4)
            if (!h) return null
            y -= h
            return <rect key={`${i}-${t}`} x={i * bw + 1} y={y} width={bw - 2} height={h} fill={TIER[t].color} />
          })
        })}
        {sel && (
          <>
            <rect x="0" y="0" width={X(sel[0])} height={H - padB} fill="rgba(0,0,0,.6)" />
            <rect x={X(sel[1])} y="0" width={W - X(sel[1])} height={H - padB} fill="rgba(0,0,0,.6)" />
            <rect x={X(sel[0])} y="1" width={Math.max(2, X(sel[1]) - X(sel[0]))} height={H - padB - 2} fill="none" stroke="var(--gold)" strokeWidth="3" strokeDasharray="6 4" />
          </>
        )}
        <rect x="0" y="0" width={W} height={H - padB} fill="none" stroke="#1d2527" strokeWidth="3" />
        {[0, buckets.length - 1].map(i => (
          <text key={i} x={i === 0 ? 2 : W - 2} y={H - 3} textAnchor={i === 0 ? "start" : "end"} fontFamily="var(--pxfont)" fontSize="13" fill="#9fb4b2">{buckets[i].label}</text>
        ))}
      </svg>
    </div>
  )
}

const WIDE = { W: 720, H: 240 }

export default function GraphsPage({ events, onPickTier }) {
  const [range, setRange] = useState(null)
  const [hidden, setHidden] = useState(() => new Set())
  const [openId, setOpenId] = useState(null)

  const master = useMemo(() => bucketize(events, 48), [events])
  const filtered = useMemo(() => events.filter(e => {
    if (hidden.has(e.threat_tier)) return false
    if (!range) return true
    const t = tsOf(e)
    return t != null && t >= range[0] && t < range[1]
  }), [events, hidden, range])

  const counts = useMemo(() => tierCounts(events), [events])

  // One card per chart: the face shows a headline number, the window shows the chart itself.
  const cards = useMemo(() => {
    const risk = riskOf(filtered)
    const band = risk.risk < 0.25 ? "calm" : risk.risk < 0.5 ? "watchful" : risk.risk < 0.75 ? "danger" : "critical"
    const tc = tierCounts(filtered)
    const { buckets } = bucketize(filtered, 14)
    const peak = buckets.reduce((m, b) => Math.max(m, b.total), 0)
    const scores = filtered.map(e => e.anomaly_score || 0)
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    const bySource = Object.fromEntries(SOURCES.map(s => [s, 0]))
    filtered.forEach(e => { bySource[sourceOf(e)]++ })
    const [busySrc, busyN] = Object.entries(bySource).sort((a, b) => b[1] - a[1])[0]
    const { grid } = heatGrid(filtered)
    const perHour = Array.from({ length: 24 }, (_, h) => grid.reduce((s, row) => s + row[h], 0))
    const peakHour = perHour.indexOf(Math.max(...perHour))
    const clusters = clusterCounts(filtered)
    const common = commonEvents(filtered)
    const hasClusters = clusters.length && !(clusters.length === 1 && clusters[0][0] === "Unknown")
    const list = [
      { id: "risk", title: "Risk", rank: "A", suit: "spade", icon: "warn", color: "#fe5f55", stat: `${Math.round(risk.risk * 100)}%`, caption: `overall risk: ${band}`,
        body: <RiskDial events={filtered} /> },
      { id: "levels", title: "Threat levels", rank: "K", suit: "heart", icon: "eye", color: "#ff9a00", stat: `${tc[4]} critical`, caption: `${filtered.length} events across 4 levels`,
        body: <LevelTokens events={filtered} onPickTier={onPickTier} /> },
      { id: "towers", title: "Over time", rank: "Q", suit: "diamond", icon: "clock", color: "#ffc83a", stat: `peak ${peak}`, caption: "events in the busiest time slot",
        body: <IsoLens events={filtered} onPickTier={onPickTier} /> },
      { id: "score", title: "Anomaly score", rank: "J", suit: "club", icon: "bolt", color: "#4bc292", stat: `${Math.round(avg * 100)}%`, caption: "average anomaly score",
        body: <Box title="Anomaly score" icon="bolt" right="one square per event"><StepLine events={filtered} W={WIDE.W} H={WIDE.H} /></Box> },
      { id: "board", title: "The board", rank: "10", suit: "spade", icon: "dice", color: "#0093ff", stat: busySrc, caption: `busiest log, ${busyN} events`,
        body: <BoardLens events={filtered} onPickTier={onPickTier} /> },
      { id: "heat", title: "Busy hours", rank: "9", suit: "heart", icon: "scroll", color: "#9b6bff", stat: `${String(peakHour).padStart(2, "0")}:00`, caption: "the hour with the most events",
        body: <Box title="Busy hours" icon="clock" right="weekday x hour"><Heatmap events={filtered} W={WIDE.W} H={WIDE.H - 40} /></Box> },
    ]
    if (hasClusters) {
      list.push({ id: "clusters", title: "Behaviour", rank: "8", suit: "diamond", icon: "ml", color: "#ff9a00", stat: clusters[0][0].slice(0, 22), caption: `${clusters.length} behaviour groups`,
        body: <Box title="Behaviour clusters" icon="ml"><ListBars rows={clusters} color="var(--purple)" /></Box> })
    }
    list.push({ id: "common", title: "Common events", rank: "7", suit: "club", icon: "scroll", color: "#4bc292", stat: common[0] ? common[0][0].slice(0, 22) : "none", caption: common[0] ? `seen ${common[0][1]} times` : "no events yet",
      body: <Box title="Most common events" icon="scroll"><ListBars rows={common} color="var(--gold)" empty="No events yet." /></Box> })
    return list
  }, [filtered, onPickTier])

  const open = cards.find(c => c.id === openId)
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === "Escape") setOpenId(null) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  const toggle = (t) => setHidden(s => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n })

  return (
    <div style={{ position: "relative", height: "100%" }} onMouseLeave={hideTip}>
      <style>{GRAPH_CSS}{DECK_CSS}</style>
      <Tip />
      <div style={{ height: "100%", overflowY: "auto", padding: "6px 160px 30px 20px" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8 }} role="group" aria-label="Threat levels shown">
          <span className="pz-title" style={{ fontSize: 20 }}>Show</span>
          {TIERS.slice().reverse().map(t => (
            <button key={t} aria-pressed={!hidden.has(t)} title={hidden.has(t) ? `Show ${TIER[t].name}` : `Hide ${TIER[t].name}`}
              className="pz-btn small" onClick={() => toggle(t)}
              style={{ "--btn": hidden.has(t) ? "#4a5d5b" : TIER[t].color, "--btn-d": hidden.has(t) ? "#2f3d3c" : TIER[t].dark, color: hidden.has(t) ? "#8aa09e" : t === 2 ? "#1d2527" : "#fff", textDecoration: hidden.has(t) ? "line-through" : "none" }}>
              {TIER[t].name} {counts[t]}
            </button>
          ))}
        </div>

        <Brush master={master} range={range} onChange={setRange} />

        <div style={{ fontSize: 16, color: "#9fb4b2", marginBottom: 4 }}>
          Showing {filtered.length} of {events.length} events{range ? " in the chosen range" : ""}{hidden.size ? `, ${hidden.size} level${hidden.size > 1 ? "s" : ""} hidden` : ""}.
        </div>

        {filtered.length === 0
          ? <div className="pz-panel" style={{ padding: 14 }}><Empty>{events.length ? "Nothing matches these filters. Clear the range or switch a level back on." : "No events yet."}</Empty></div>
          : <GraphDeck key={cards.length} cards={cards} onOpen={setOpenId} />}
      </div>

      {open && (
        <div style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center", padding: "12px 160px 12px 20px", background: "rgba(10,18,20,.62)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setOpenId(null) }}>
          <div className="pz-panel pz-bounce-in" role="dialog" aria-modal="true" aria-label={open.title}
            style={{ width: "min(860px, 100%)", maxHeight: "100%", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "3px solid var(--ink)", background: open.color }}>
              <PxIcon name={open.icon} size={22} />
              <span className="pz-title" style={{ fontSize: 22, color: "#fff" }}>{open.title}</span>
              <button className="pz-btn red small" style={{ marginLeft: "auto" }} aria-label="Close chart" autoFocus onClick={() => setOpenId(null)}>X</button>
            </div>
            <div style={{ overflowY: "auto", padding: 12 }}>
              <BareCtx.Provider value={true}>{open.body}</BareCtx.Provider>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export { tierOf }
