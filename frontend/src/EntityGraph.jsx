import { useEffect, useRef, useState, useCallback } from "react"
import * as d3 from "d3"
import axios from "axios"
import { buildEntitySummary, getHumanDescription, explainTier, formatTimestamp } from "./Humanlog"
import { sanitizeField } from "./sanitize"
import PxIcon from "./px/PxIcon"
import { API } from "./api"

// ─────────────────────────────────────────────────────────────
// ENTITIES: the same floating graph as before, with the nodes dealt as cards.
//   - every entity is a DECK that floats in the space: the deck's size and thickness follow its event count,
//     the top card's colour is its worst threat level, and the dashed outline is its behaviour cluster
//   - every event type it has seen is a single small card, linked to the decks that saw it
//   - drag a deck to move it, scroll to zoom, click one to investigate it (the detail opens on the right)
//   - the dashed regions group decks by behaviour pattern, like before
// ─────────────────────────────────────────────────────────────
const TIERS = {
  1: { color: "#56a786", dark: "#459373", label: "LOW", rank: "5" },
  2: { color: "#fdcf51", dark: "#db9720", label: "MEDIUM", rank: "10" },
  3: { color: "#fa8f0b", dark: "#d66b1b", label: "HIGH", rank: "K" },
  4: { color: "#fd5f55", dark: "#c14139", label: "CRITICAL", rank: "A" },
}

// Cluster to colour mapping for the grouping rings
const CLUSTER_COLORS = {
  "Brute Force Pattern": "#fdcf51",
  "Credential Access Pattern": "#fa8f0b",
  "Privilege Escalation Pattern": "#fd5f55",
  "Persistence Pattern": "#c46bd3",
  "Data Exfiltration Pattern": "#ec2d33",
  "Normal System Activity": "#56a786",
  "Unknown Pattern": "#8a9a9a",
}

const INK = "#1d2527"
const CREAM = "#f8f4ec"
const FONT = "'Jersey 15', monospace"
const tierOf = (tier) => TIERS[tier] || TIERS[1]

const dominantCluster = (ent) => {
  const counts = {}
  ;(ent.clusters || []).forEach(c => { counts[c] = (counts[c] || 0) + 1 })
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || ""
}

// A tiny person drawn in pixels, centred on 0,0 and sized by the unit u
function person(sel, u) {
  const px = (x, y, w, h) => sel.append("rect").attr("x", x * u).attr("y", y * u).attr("width", w * u).attr("height", h * u).attr("fill", INK).style("pointer-events", "none")
  px(-1.5, -4, 3, 3)        // head
  px(-3.5, -0.5, 7, 4)      // shoulders
  px(-4, 3.5, 8, 1)         // base
}

export default function EntityGraph({ onNodeClick }) {
  const svgRef = useRef(null)
  const simRef = useRef(null)
  const [entities, setEntities] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [tooltip, setTooltip] = useState(null)

  useEffect(() => {
    axios.get(`${API}/entities`)
      .then(r => { setEntities(r.data.entities || []); setLoading(false) })
      .catch(() => { setError(true); setLoading(false) })
  }, [])

  const buildGraph = useCallback(() => {
    if (!svgRef.current || !entities.length) return
    const el = svgRef.current
    const parent = el.parentElement
    const rect = parent.getBoundingClientRect()
    const W = rect.width || parent.clientWidth || 800
    const H = rect.height || parent.clientHeight || Math.max(window.innerHeight - 120, 400)
    d3.select(el).selectAll("*").remove()

    const svg = d3.select(el).attr("width", W).attr("height", H)
    const g = svg.append("g")
    const zoom = d3.zoom().scaleExtent([0.2, 3]).on("zoom", event => g.attr("transform", event.transform))
    svg.call(zoom)

    const nodes = []
    const links = []
    const eidMap = {}

    // ── Entity decks ─────────────────────────────────────────
    entities.forEach((ent, i) => {
      const w = Math.max(46, Math.min(82, 40 + ent.event_count * 1.6))
      nodes.push({
        id: `entity-${i}`, type: "entity", label: sanitizeField(ent.entity),
        shortLabel: sanitizeField(ent.entity.length > 20 ? ent.entity.slice(0, 18) + "…" : ent.entity),
        tier: ent.max_tier, count: ent.event_count, score: ent.avg_score, phases: ent.phases,
        cluster: dominantCluster(ent), data: ent,
        w, h: w * 1.4, layers: Math.min(4, Math.max(1, Math.ceil(ent.event_count / 4))),
        r: w * 0.85,
        x: W / 2 + (Math.random() - 0.5) * 300, y: H / 2 + (Math.random() - 0.5) * 300,
      })
    })

    // ── Event type cards + links ─────────────────────────────
    entities.forEach((ent, i) => {
      ent.event_ids.slice(0, 6).forEach(eid => {
        const key = `eid-${eid}`
        if (!eidMap[key]) {
          eidMap[key] = { id: key, type: "eventid", label: `#${eid}`, tier: 1, count: 0, w: 24, h: 33, r: 24,
            x: W / 2 + (Math.random() - 0.5) * 400, y: H / 2 + (Math.random() - 0.5) * 400 }
          nodes.push(eidMap[key])
        }
        eidMap[key].tier = Math.max(eidMap[key].tier, ent.max_tier)
        eidMap[key].count += 1
        links.push({ source: `entity-${i}`, target: key, tier: ent.max_tier })
      })
    })

    // ── Simulation ───────────────────────────────────────────
    if (simRef.current) simRef.current.stop()
    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links).id(d => d.id).distance(118).strength(0.6))
      .force("charge", d3.forceManyBody().strength(-380).distanceMax(500))
      .force("center", d3.forceCenter(W / 2, H / 2).strength(0.06))
      .force("x", d3.forceX(W / 2).strength(0.05))
      .force("y", d3.forceY(H / 2).strength(0.05))
      .force("collision", d3.forceCollide(d => d.r + 32))
      .alpha(1).alphaDecay(0.016)
    simRef.current = sim

    // Fit the whole table into view once the layout has spread out. Pan and zoom still work afterwards.
    const fitToView = () => {
      if (!svgRef.current || !nodes.length) return
      const xs = nodes.map(n => n.x).filter(Number.isFinite), ys = nodes.map(n => n.y).filter(Number.isFinite)
      if (!xs.length) return
      const pad = 50
      const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad
      const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad
      const k = Math.max(0.2, Math.min(1.2, W / (x1 - x0), H / (y1 - y0)))
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(W / 2 - k * (x0 + x1) / 2, H / 2 - k * (y0 + y1) / 2).scale(k))
    }
    sim.on("end.fit", fitToView)
    setTimeout(fitToView, 2600)

    // ── Cluster regions (drawn first, behind everything) ─────
    const clusterGroup = g.append("g")

    // ── Links ────────────────────────────────────────────────
    const linkSel = g.append("g").selectAll("line").data(links).join("line")
      .attr("stroke", "rgba(255,255,255,0.38)")
      .attr("stroke-width", d => (d.tier >= 3 ? 3 : 2))
      .style("stroke-dasharray", d => (d.tier >= 4 ? "8,5" : "none"))

    // ── Node groups ──────────────────────────────────────────
    const nodeSel = g.append("g").selectAll("g").data(nodes).join("g").attr("class", "ent-node").style("cursor", "grab")

    nodeSel.call(
      d3.drag()
        .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
        .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y })
        .on("end", (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null })
    )
    nodeSel.on("click", (event, d) => {
      event.stopPropagation()
      setSelected(d)
      nodeSel.select(".top").attr("stroke", n => (n === d ? "#fdcf51" : INK)).attr("stroke-width", n => (n === d ? 4 : 2.5))
    })
    nodeSel.on("mousemove", (event, d) => setTooltip({ x: event.clientX, y: event.clientY, d }))
    nodeSel.on("mouseleave", () => setTooltip(null))

    // Everything inside a node sits in .deck, so a hover can lift it without fighting the simulation's translate
    const deck = nodeSel.append("g").attr("class", "deck")

    // entity decks: thickness edges, top card, tier-coloured art field, rank, person sprite, dashed cluster outline
    deck.filter(d => d.type === "entity").each(function (d) {
      const s = d3.select(this), t = tierOf(d.tier)
      for (let k = d.layers - 1; k >= 1; k--) {
        s.append("rect").attr("x", -d.w / 2 + k * 3).attr("y", -d.h / 2 + k * 3).attr("width", d.w).attr("height", d.h).attr("rx", 6)
          .attr("fill", "#e6dfd0").attr("stroke", INK).attr("stroke-width", 2)
      }
      if (d.cluster) {
        s.append("rect").attr("x", -d.w / 2 - 6).attr("y", -d.h / 2 - 6).attr("width", d.w + 12 + (d.layers - 1) * 3).attr("height", d.h + 12 + (d.layers - 1) * 3).attr("rx", 10)
          .attr("fill", "none").attr("stroke", CLUSTER_COLORS[d.cluster] || "#8a9a9a").attr("stroke-width", 3).attr("stroke-dasharray", "6 4")
      }
      s.append("rect").attr("class", "top").attr("x", -d.w / 2).attr("y", -d.h / 2).attr("width", d.w).attr("height", d.h).attr("rx", 6)
        .attr("fill", CREAM).attr("stroke", INK).attr("stroke-width", 2.5)
      s.append("rect").attr("x", -d.w / 2 + d.w * 0.3).attr("y", -d.h / 2 + d.h * 0.09).attr("width", d.w * 0.62).attr("height", d.h * 0.46).attr("rx", 3)
        .attr("fill", t.color).attr("fill-opacity", 0.45).attr("stroke", t.dark).attr("stroke-width", 1.5).style("pointer-events", "none")
      const red = d.tier === 3 || d.tier === 1
      s.append("text").text(t.rank).attr("x", -d.w / 2 + 5).attr("y", -d.h / 2 + 16).attr("font-family", FONT).attr("font-size", d.w * 0.28).attr("font-weight", 700)
        .attr("fill", red ? "#c0443b" : INK).style("pointer-events", "none")
      s.append("rect").attr("x", -d.w / 2 + 6).attr("y", -d.h / 2 + 20).attr("width", 6).attr("height", 6).attr("fill", red ? "#c0443b" : INK).style("pointer-events", "none")
      const p = s.append("g").attr("transform", `translate(${d.w * 0.11}, ${-d.h / 2 + d.h * 0.32})`)
      person(p, d.w / 17)
      s.append("text").text(d.count).attr("x", 0).attr("y", d.h / 2 - 8).attr("text-anchor", "middle").attr("font-family", FONT).attr("font-size", d.w * 0.34)
        .attr("font-weight", 700).attr("fill", t.dark).style("pointer-events", "none")
    })

    // event type cards: one small card each
    deck.filter(d => d.type === "eventid").each(function (d) {
      const s = d3.select(this), t = tierOf(d.tier)
      s.append("rect").attr("class", "top").attr("x", -d.w / 2).attr("y", -d.h / 2).attr("width", d.w).attr("height", d.h).attr("rx", 4)
        .attr("fill", CREAM).attr("stroke", INK).attr("stroke-width", 2.5).attr("transform", "rotate(-6)")
      s.append("rect").attr("x", -d.w / 2 + 3).attr("y", -d.h / 2 + 5).attr("width", d.w - 6).attr("height", d.h - 14).attr("rx", 2)
        .attr("fill", t.color).attr("transform", "rotate(-6)").style("pointer-events", "none")
    })

    // Labels
    nodeSel.filter(d => d.type === "entity").append("text")
      .text(d => d.shortLabel).attr("text-anchor", "middle").attr("y", d => d.h / 2 + 18)
      .attr("font-size", "14px").attr("font-weight", 700).attr("font-family", FONT)
      .attr("fill", "#fff").attr("stroke", INK).attr("stroke-width", 3).attr("paint-order", "stroke").style("pointer-events", "none")
    nodeSel.filter(d => d.type === "entity").append("text")
      .text(d => `${d.count} ${d.count === 1 ? "event" : "events"}`).attr("text-anchor", "middle").attr("y", d => d.h / 2 + 32)
      .attr("font-size", "13px").attr("font-weight", 700).attr("font-family", FONT)
      .attr("fill", "#dcdcdc").attr("stroke", INK).attr("stroke-width", 3).attr("paint-order", "stroke").style("pointer-events", "none")
    nodeSel.filter(d => d.type === "eventid").append("text")
      .text(d => d.label).attr("text-anchor", "middle").attr("y", d => d.h / 2 + 14)
      .attr("font-size", "13px").attr("font-weight", 700).attr("font-family", FONT)
      .attr("fill", "#fff").attr("stroke", INK).attr("stroke-width", 3).attr("paint-order", "stroke").style("pointer-events", "none")

    // ── Tick: move everything, redraw the behaviour regions ──
    sim.on("tick", () => {
      linkSel.attr("x1", d => d.source.x).attr("y1", d => d.source.y).attr("x2", d => d.target.x).attr("y2", d => d.target.y)
      nodeSel.attr("transform", d => `translate(${d.x},${d.y})`)

      clusterGroup.selectAll("*").remove()
      const byCluster = {}
      nodes.filter(n => n.type === "entity" && n.cluster).forEach(n => { (byCluster[n.cluster] ||= []).push([n.x, n.y]) })
      Object.entries(byCluster).forEach(([cluster, pts]) => {
        if (pts.length < 2) return
        const hull = d3.polygonHull(pts)
        if (!hull) return
        const color = CLUSTER_COLORS[cluster] || "#555"
        const c = d3.polygonCentroid(hull)
        const padded = hull.map(([px, py]) => {
          const dx = px - c[0], dy = py - c[1], len = Math.sqrt(dx * dx + dy * dy) || 1
          return [px + dx / len * 56, py + dy / len * 56]
        })
        clusterGroup.append("path").datum(padded).attr("d", d3.line().curve(d3.curveCatmullRomClosed)(padded))
          .attr("fill", color + "22").attr("stroke", color + "99").attr("stroke-width", 3).attr("stroke-dasharray", "10 6")
      })
    })

    svg.on("click", () => { setSelected(null); nodeSel.select(".top").attr("stroke", INK).attr("stroke-width", 2.5) })
  }, [entities])

  useEffect(() => {
    if (loading || !entities.length || !svgRef.current) return
    // Defer one frame so the flex container has painted and getBoundingClientRect() is non-zero
    const raf = requestAnimationFrame(() => { buildGraph() })
    const observer = new ResizeObserver(() => buildGraph())
    observer.observe(svgRef.current.parentElement)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      if (simRef.current) simRef.current.stop()
    }
  }, [loading, entities.length, buildGraph])

  const stateBox = (txt) => <div style={{ padding: 40, textAlign: "center" }} className="pz-title">{txt}</div>
  if (loading) return stateBox("Dealing the entity decks...")
  if (error) return stateBox("Failed to load entities: is the backend running?")
  if (!entities.length) return stateBox("No entities found. Run a scan or inject the demo attack first.")

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", padding: "0 160px 16px 20px", gap: 14 }}>
      <style>{`
        .ent-node .deck { transition: transform .15s; transform-box: fill-box; transform-origin: center; }
        .ent-node:hover .deck { transform: scale(1.1); }
        @media (prefers-reduced-motion: reduce) { .ent-node .deck { transition: none; } }
        .ed-minis { display: flex; flex-wrap: wrap; gap: 6px; }
        .ed-mini { width: 54px; height: 66px; padding: 0; position: relative; border: 2px solid #b4aea0; border-radius: 6px; background: ${CREAM}; color: ${INK}; cursor: pointer; font-family: var(--pxfont); }
        .ed-mini[aria-pressed="true"] { box-shadow: 0 0 0 3px var(--gold); }
        .ed-mini .ico { position: absolute; left: 0; right: 0; top: 6px; display: flex; justify-content: center; }
        .ed-mini .id { position: absolute; left: 0; right: 0; bottom: 4px; text-align: center; font-size: 15px; }
      `}</style>
      <div className="pz-inset" style={{ flex: 1, position: "relative", overflow: "hidden", minWidth: 0 }}>
        <svg ref={svgRef} style={{ width: "100%", height: "100%", display: "block" }} />

        <div className="pz-panel" style={{ position: "absolute", top: 12, left: 12, padding: "8px 12px", pointerEvents: "none" }}>
          <div className="pz-label" style={{ marginBottom: 6 }}>Legend</div>
          {Object.entries(TIERS).map(([tier, t]) => (
            <div key={tier} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
              <span style={{ width: 12, height: 16, borderRadius: 2, background: t.color, border: "2px solid var(--ink)" }} />
              <span style={{ fontSize: 17, fontWeight: 600 }}>{t.label} deck</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span style={{ width: 10, height: 14, borderRadius: 2, background: CREAM, border: "2px solid var(--ink)", transform: "rotate(-6deg)" }} />
            <span style={{ fontSize: 17, fontWeight: 600 }}>Event type</span>
          </div>
        </div>

        <div className="pz-panel" style={{ position: "absolute", top: 12, right: 12, padding: "8px 12px", pointerEvents: "none", maxWidth: 210 }}>
          <div className="pz-label" style={{ marginBottom: 6 }}>Behaviour clusters</div>
          {Object.entries(CLUSTER_COLORS).filter(([k]) => k !== "Unknown Pattern").map(([label, color]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
              <span style={{ width: 12, height: 12, border: `3px dashed ${color}`, borderRadius: 3, flexShrink: 0 }} />
              <span style={{ fontSize: 15, lineHeight: 1.1 }}>{label}</span>
            </div>
          ))}
        </div>

        <div style={{ position: "absolute", bottom: 10, left: 14, fontSize: 17, color: "#dcdcdc", pointerEvents: "none", textShadow: "0 2px 0 rgba(0,0,0,.6)" }}>
          Drag decks. Scroll to zoom. Click one to investigate. {entities.length} entities.
        </div>
      </div>

      <DetailPanel selected={selected} onAsk={onNodeClick} entities={entities} />

      {tooltip && (
        <div className="pz-tip no-arrow" style={{ position: "fixed", left: tooltip.x + 14, top: tooltip.y - 10, zIndex: 9999, pointerEvents: "none", maxWidth: 250 }}>
          <div style={{ fontWeight: 700, fontSize: 20 }}>{tooltip.d.type === "entity" ? tooltip.d.label : `Event type ${tooltip.d.label}`}</div>
          {tooltip.d.cluster && <div style={{ fontSize: 17, color: "#7d51ae", fontWeight: 600 }}>{tooltip.d.cluster}</div>}
          <div style={{ fontSize: 17, marginTop: 2 }}>
            {tooltip.d.type === "entity"
              ? `${tierOf(tooltip.d.tier).label} threat, ${tooltip.d.count} events, avg ${tooltip.d.score}% suspicious`
              : `Connected to ${tooltip.d.count} ${tooltip.d.count === 1 ? "entity" : "entities"}, ${tierOf(tooltip.d.tier).label} tier`}
          </div>
        </div>
      )}
    </div>
  )
}

// Collapsible detail panel
function DetailPanel({ selected, onAsk, entities }) {
  const [open, setOpen] = useState(true)
  useEffect(() => { if (selected) setOpen(true) }, [selected])

  if (!open) return (
    <button className="pz-btn gray" onClick={() => setOpen(true)} style={{ alignSelf: "center", writingMode: "vertical-rl", padding: "14px 6px" }}>DETAIL</button>
  )
  return (
    <div className="pz-panel paper" style={{ width: 300, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden", color: "var(--ink)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderBottom: "3px solid var(--ink)", background: "#e0dac8" }}>
        <span style={{ fontWeight: 700, letterSpacing: ".08em" }}>ENTITY DETAIL</span>
        <button className="pz-btn gray small" style={{ padding: "0 8px" }} onClick={() => setOpen(false)} aria-label="Collapse panel">X</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {!selected ? (
          <div style={{ textAlign: "center", marginTop: 40, color: "#4b5a58" }}>
            <PxIcon name="entities" size={52} style={{ margin: "0 auto 8px" }} />
            <div style={{ fontWeight: 700, fontSize: 23 }}>Click any deck</div>
            <div style={{ fontSize: 18 }}>to investigate it.</div>
          </div>
        ) : selected.type === "entity"
          ? <EntityDetail key={selected.id} entity={selected.data} onAsk={onAsk} entities={entities} />
          : <EventIdDetail node={selected} />}
      </div>
    </div>
  )
}

function Box({ title, children, tone }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 14, letterSpacing: ".12em", fontWeight: 700, color: "#6b7b78", marginBottom: 3 }}>{title}</div>
      <div style={{ border: "3px solid var(--ink)", borderRadius: 8, padding: "6px 10px", background: tone || "#fff", fontSize: 18, lineHeight: 1.25 }}>{children}</div>
    </div>
  )
}

function EntityDetail({ entity, onAsk, entities }) {
  const [typeSel, setTypeSel] = useState(null)
  const t = tierOf(entity.max_tier)
  const summary = buildEntitySummary(entity)
  const cluster = dominantCluster(entity)

  // The highest threat each event type reached for this entity, and how many entities have seen it
  const typeInfo = (id) => {
    const tier = (entity.events || []).filter(e => e.event_id === id).reduce((m, e) => Math.max(m, e.tier || 1), 1)
    return { id, tier, count: entities.filter(e => (e.event_ids || []).includes(id)).length }
  }

  return (
    <div className="pz-bounce-in">
      <div style={{ background: t.color, border: "3px solid var(--ink)", borderRadius: 8, padding: "8px 10px", marginBottom: 10, color: t.label === "MEDIUM" ? "#1d2527" : "#fff" }}>
        <div className="pz-title" style={{ fontSize: 23, lineHeight: 1.1, textShadow: t.label === "MEDIUM" ? "none" : undefined }}>{sanitizeField(entity.entity)}</div>
        <div style={{ fontSize: 15, opacity: .9 }}>{sanitizeField(entity.computer || "")}</div>
        <div style={{ fontSize: 17, marginTop: 2 }}>{explainTier(entity.max_tier)}</div>
      </div>
      {cluster && <Box title="BEHAVIOUR CLUSTER">{cluster}</Box>}
      <Box title="PLAIN ENGLISH">{summary}</Box>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {[["EVENTS", entity.event_count], ["AVG SCORE", `${entity.avg_score}%`], ["FIRST", formatTimestamp(entity.first_seen)], ["LAST", formatTimestamp(entity.last_seen)]].map(([k, v]) => (
          <div key={k} style={{ flex: "1 1 120px", border: "3px solid var(--ink)", borderRadius: 8, padding: "4px 8px", background: "#fff" }}>
            <div style={{ fontSize: 13, letterSpacing: ".1em", color: "#6b7b78", fontWeight: 700 }}>{k}</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{v}</div>
          </div>
        ))}
      </div>
      {entity.phases?.length > 0 && (
        <Box title="ATTACK PHASES" tone="#fbd5d1">{entity.phases.map((p, i) => <div key={i}>{sanitizeField(p)}</div>)}</Box>
      )}
      {entity.event_ids?.length > 0 && (
        <Box title="EVENT TYPES SEEN">
          <div className="ed-minis">
            {entity.event_ids.map(id => {
              const info = typeInfo(id), tt = tierOf(info.tier)
              return (
                <button key={id} className="ed-mini" aria-pressed={typeSel === id} onClick={() => setTypeSel(typeSel === id ? null : id)} title={`Event type #${id}`}>
                  <span className="ico"><PxIcon name="scroll" size={26} color={tt.dark} /></span>
                  <span className="id">#{id}</span>
                </button>
              )
            })}
          </div>
          {typeSel != null && (() => {
            const info = typeInfo(typeSel), tt = tierOf(info.tier)
            const fake = { raw_data: JSON.stringify({ EventID: typeSel }), threat_tier: info.tier, anomaly_score: 0, timestamp: "", source: "" }
            return (
              <div className="pz-bounce-in" style={{ marginTop: 8, paddingTop: 6, borderTop: "2px solid #b4aea0" }}>
                <div style={{ fontWeight: 700, fontSize: 22, color: tt.dark }}>#{typeSel}</div>
                <div style={{ fontSize: 16, lineHeight: 1.2 }}>{getHumanDescription(fake)}</div>
                <div style={{ fontSize: 15, color: "#6b7b78", marginTop: 4 }}>Seen by {info.count} {info.count === 1 ? "entity" : "entities"}. Highest here: {tt.label}.</div>
              </div>
            )
          })()}
        </Box>
      )}
      {onAsk && <button className="pz-btn blue small" style={{ width: "100%" }} onClick={() => onAsk(entity)}>Ask Luffy about this</button>}
    </div>
  )
}

function EventIdDetail({ node }) {
  const t = tierOf(node.tier)
  const fakeEvent = {
    raw_data: JSON.stringify({ EventID: parseInt(node.label.replace("#", "")) || 0 }),
    threat_tier: node.tier, anomaly_score: 0, timestamp: "", source: "",
  }
  return (
    <div className="pz-bounce-in">
      <div style={{ fontWeight: 700, fontSize: 36, color: t.dark, marginBottom: 8 }}>{sanitizeField(node.label)}</div>
      <Box title="WHAT IT MEANS">{getHumanDescription(fakeEvent)}</Box>
      <Box title="CONNECTED TO">{node.count} {node.count === 1 ? "entity" : "entities"}</Box>
      <Box title="HIGHEST THREAT SEEN" tone={t.color + "55"}><b>{t.label}.</b> {explainTier(node.tier)}</Box>
    </div>
  )
}
