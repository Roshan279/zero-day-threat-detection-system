import { useEffect, useRef, useState, useCallback } from "react"
import * as d3 from "d3"
import axios from "axios"
import { buildEntitySummary, getHumanDescription, explainTier, formatTimestamp } from "./Humanlog"
import { sanitizeField } from "./sanitize"
import PxIcon from "./px/PxIcon"
import { API } from "./api"

const TIERS = {
  1:{color:"#4bc292",label:"LOW"},
  2:{color:"#ffc83a",label:"MEDIUM"},
  3:{color:"#ff9a00",label:"HIGH"},
  4:{color:"#fe5f55",label:"CRITICAL"},
}

// Cluster to colour mapping for the grouping rings
const CLUSTER_COLORS = {
  "Brute Force Pattern":         "#ffc83a",
  "Credential Access Pattern":   "#ff9a00",
  "Privilege Escalation Pattern":"#fe5f55",
  "Persistence Pattern":         "#c46bd3",
  "Data Exfiltration Pattern":   "#fe5f55",
  "Normal System Activity":      "#4bc292",
  "Unknown Pattern":             "#8a9a9a",
}

const INK = "#1d2527"
const FONT = "'Jersey 15', monospace"
const tierColor = (tier, fallback="#8a9a9a") => TIERS[tier]?.color ?? fallback

export default function EntityGraph({ onNodeClick }) {
  const svgRef   = useRef(null)
  const simRef   = useRef(null)
  const [entities, setEntities] = useState([])
  const [selected, setSelected] = useState(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState(false)
  const [tooltip,  setTooltip]  = useState(null)

  useEffect(() => {
    axios.get(`${API}/entities`)
      .then(r => { setEntities(r.data.entities || []); setLoading(false) })
      .catch(() => { setError(true); setLoading(false) })
  }, [])

  const buildGraph = useCallback(() => {
    if (!svgRef.current || !entities.length) return
    const el     = svgRef.current
    const parent = el.parentElement
    const rect   = parent.getBoundingClientRect()
    const W      = rect.width  || parent.clientWidth  || 800
    const H      = rect.height || parent.clientHeight || Math.max(window.innerHeight - 120, 400)
    d3.select(el).selectAll("*").remove()

    const svg = d3.select(el).attr("width", W).attr("height", H)
    const g   = svg.append("g")
    const zoom = d3.zoom().scaleExtent([0.2, 3])
      .on("zoom", event => g.attr("transform", event.transform))
    svg.call(zoom)

    // Glow filters
    const defs = svg.append("defs")
    ;[1,2,3,4].forEach(tier => {
      const f = defs.append("filter").attr("id", `glow-t${tier}`)
      f.append("feGaussianBlur").attr("stdDeviation", "3").attr("result", "blur")
      const m = f.append("feMerge")
      m.append("feMergeNode").attr("in", "blur")
      m.append("feMergeNode").attr("in", "SourceGraphic")
    })
    // Cluster glow filter
    const cf = defs.append("filter").attr("id", "glow-cluster")
    cf.append("feGaussianBlur").attr("stdDeviation", "6").attr("result", "blur")
    const cm = cf.append("feMerge")
    cm.append("feMergeNode").attr("in", "blur")
    cm.append("feMergeNode").attr("in", "SourceGraphic")

    const nodes = []
    const links = []
    const eidMap = {}

    // ── Build entity nodes ───────────────────────────────────
    entities.forEach((ent, i) => {
      // Determine dominant cluster for this entity from its events
      const clusterCounts = {}
      ;(ent.clusters || []).forEach(c => {
        clusterCounts[c] = (clusterCounts[c] || 0) + 1
      })
      const dominantCluster = Object.entries(clusterCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || ""

      nodes.push({
        id:      `entity-${i}`,
        type:    "entity",
        label:   sanitizeField(ent.entity),
        shortLabel: sanitizeField(
          ent.entity.length > 20 ? ent.entity.slice(0, 18) + "…" : ent.entity
        ),
        tier:    ent.max_tier,
        count:   ent.event_count,
        score:   ent.avg_score,
        phases:  ent.phases,
        cluster: dominantCluster,
        data:    ent,
        r:       Math.max(16, Math.min(38, 10 + ent.event_count * 2)),
        x:       W/2 + (Math.random() - 0.5) * 300,
        y:       H/2 + (Math.random() - 0.5) * 300,
      })
    })

    // ── Build event-ID nodes + links ─────────────────────────
    entities.forEach((ent, i) => {
      ent.event_ids.slice(0, 6).forEach(eid => {
        const key = `eid-${eid}`
        if (!eidMap[key]) {
          eidMap[key] = {
            id:    key,
            type:  "eventid",
            label: `#${eid}`,
            tier:  1,
            count: 0,
            r:     10,
            x:     W/2 + (Math.random() - 0.5) * 400,
            y:     H/2 + (Math.random() - 0.5) * 400,
          }
          nodes.push(eidMap[key])
        }
        eidMap[key].tier  = Math.max(eidMap[key].tier, ent.max_tier)
        eidMap[key].count += 1
        links.push({ source: `entity-${i}`, target: key, tier: ent.max_tier })
      })
    })

    // ── Simulation ───────────────────────────────────────────
    if (simRef.current) simRef.current.stop()
    const sim = d3.forceSimulation(nodes)
      .force("link",      d3.forceLink(links).id(d => d.id).distance(70).strength(0.7))
      .force("charge",    d3.forceManyBody().strength(-170))
      .force("center",    d3.forceCenter(W/2, H/2).strength(0.12))
      .force("x",         d3.forceX(W/2).strength(0.07))
      .force("y",         d3.forceY(H/2).strength(0.07))
      .force("collision", d3.forceCollide(d => d.r + 16))
      .alpha(1).alphaDecay(0.02)
    simRef.current = sim

    // Fit the whole graph into view once the layout has spread out, so no node starts off-screen.
    // Pan and zoom still work afterwards.
    const fitToView = () => {
      if (!svgRef.current || !nodes.length) return
      const xs = nodes.map(n => n.x).filter(Number.isFinite), ys = nodes.map(n => n.y).filter(Number.isFinite)
      if (!xs.length) return
      const pad = 60
      const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad
      const y0 = Math.min(...ys) - pad, y1 = Math.max(...ys) + pad
      const k  = Math.max(0.2, Math.min(1.5, W / (x1 - x0), H / (y1 - y0)))
      const tx = W / 2 - k * (x0 + x1) / 2, ty = H / 2 - k * (y0 + y1) / 2
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k))
    }
    sim.on("end.fit", fitToView)
    setTimeout(fitToView, 1800)   // also fit early, the full settle can take several seconds

    // ── Cluster grouping rings ───────────────────────────────
    // Drawn first so they're behind everything else
    const clusterGroup = g.append("g").attr("class", "cluster-rings")

    // ── Links ────────────────────────────────────────────────
    const linkSel = g.append("g").selectAll("line").data(links).join("line")
      .attr("stroke", "rgba(255,255,255,0.38)")
      .attr("stroke-width", d => d.tier >= 3 ? 3 : 2)
      .style("stroke-dasharray", d => d.tier >= 4 ? "8,5" : "none")

    // ── Node groups ──────────────────────────────────────────
    const nodeSel = g.append("g").selectAll("g").data(nodes).join("g")
      .style("cursor", "grab")

    nodeSel.call(
      d3.drag()
        .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y })
        .on("drag",  (event, d) => { d.fx = event.x; d.fy = event.y })
        .on("end",   (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null })
    )

    nodeSel.on("click", (event, d) => {
      event.stopPropagation()
      setSelected(d)
      if (d.type === "entity" && onNodeClick) onNodeClick(d.data)
    })
    nodeSel.on("mousemove", (event, d) => setTooltip({ x: event.clientX, y: event.clientY, d }))
    nodeSel.on("mouseleave", () => setTooltip(null))

    // Entity circles
    nodeSel.filter(d => d.type === "entity").append("circle")
      .attr("r", d => d.r)
      .attr("fill", d => tierColor(d.tier))
      .attr("stroke", INK)
      .attr("stroke-width", 4)

    // Cluster ring around entity node (coloured by cluster)
    nodeSel.filter(d => d.type === "entity" && d.cluster).append("circle")
      .attr("r", d => d.r + 7)
      .attr("fill", "none")
      .attr("stroke", d => CLUSTER_COLORS[d.cluster] || "#8a9a9a")
      .attr("stroke-width", 3)
      .attr("stroke-dasharray", "6 4")

    // Event ID diamonds
    nodeSel.filter(d => d.type === "eventid").append("rect")
      .attr("x", -11).attr("y", -11).attr("width", 22).attr("height", 22).attr("rx", 3)
      .attr("transform", "rotate(45)")
      .attr("fill", d => tierColor(d.tier))
      .attr("stroke", INK)
      .attr("stroke-width", 3)

    // Entity label
    nodeSel.filter(d => d.type === "entity").append("text")
      .text(d => d.shortLabel)
      .attr("text-anchor", "middle").attr("dy", "0.35em")
      .attr("font-size", d => d.r > 26 ? "16px" : "13px")
      .attr("font-weight", 700)
      .attr("font-family", FONT)
      .attr("fill", "#fff").attr("stroke", INK).attr("stroke-width", 3).attr("paint-order", "stroke")
      .style("pointer-events", "none")

    // Event ID label
    nodeSel.filter(d => d.type === "eventid").append("text")
      .text(d => d.label)
      .attr("text-anchor", "middle").attr("dy", "0.35em")
      .attr("font-size", "13px").attr("font-weight", 700).attr("font-family", FONT)
      .attr("fill", "#fff").attr("stroke", INK).attr("stroke-width", 3).attr("paint-order", "stroke")
      .style("pointer-events", "none")

    // Event count sub-label
    nodeSel.filter(d => d.type === "entity" && d.count > 0).append("text")
      .text(d => `${d.count}ev`)
      .attr("text-anchor", "middle").attr("dy", d => d.r + 12)
      .attr("font-size", "13px").attr("font-weight", 700).attr("font-family", FONT)
      .attr("fill", "#cfe0dd").attr("stroke", INK).attr("stroke-width", 3).attr("paint-order", "stroke")
      .style("pointer-events", "none")

    // ── Tick: update positions + cluster rings ───────────────
    sim.on("tick", () => {
      linkSel
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y)
      nodeSel.attr("transform", d => `translate(${d.x},${d.y})`)

      // Redraw cluster convex hulls on each tick
      clusterGroup.selectAll("*").remove()
      const clusterNodes = {}
      nodes.filter(n => n.type === "entity" && n.cluster).forEach(n => {
        if (!clusterNodes[n.cluster]) clusterNodes[n.cluster] = []
        clusterNodes[n.cluster].push([n.x, n.y])
      })
      Object.entries(clusterNodes).forEach(([cluster, pts]) => {
        if (pts.length < 2) return
        const hull = d3.polygonHull(pts)
        if (!hull) return
        const color = CLUSTER_COLORS[cluster] || "#555"
        // Expand hull outward by padding
        const centroid = d3.polygonCentroid(hull)
        const padded   = hull.map(([px, py]) => {
          const dx = px - centroid[0]
          const dy = py - centroid[1]
          const len = Math.sqrt(dx*dx + dy*dy) || 1
          return [px + dx/len * 28, py + dy/len * 28]
        })
        clusterGroup.append("path")
          .datum(padded)
          .attr("d", d3.line().curve(d3.curveCatmullRomClosed)(padded))
          .attr("fill",   color + "22")
          .attr("stroke", color + "99")
          .attr("stroke-width", 3)
          .attr("stroke-dasharray", "10 6")
      })
    })

    svg.on("click", () => setSelected(null))
  }, [entities, onNodeClick])

  useEffect(() => {
    if (loading || !entities.length || !svgRef.current) return
    // Defer one frame so the flex container has painted and getBoundingClientRect() is non-zero
    const raf = requestAnimationFrame(() => {
      buildGraph()
    })
    const observer = new ResizeObserver(() => buildGraph())
    observer.observe(svgRef.current.parentElement)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      if (simRef.current) simRef.current.stop()
    }
  }, [loading, buildGraph])

  const stateBox = (txt) => <div style={{ padding: 40, textAlign: "center" }} className="pz-title">{txt}</div>
  if (loading) return stateBox("Building entity graph...")
  if (error) return stateBox("Failed to load entities: is the backend running?")
  if (!entities.length) return stateBox("No entities found. Run a scan or inject the demo attack first.")

  return (
    <div style={{ display: "flex", width: "100%", height: "100%", padding: "0 160px 16px 20px", gap: 14 }}>
      <div className="pz-inset" style={{ flex: 1, position: "relative", overflow: "hidden", minWidth: 0 }}>
        <svg ref={svgRef} style={{ width: "100%", height: "100%", display: "block" }} />

        <div className="pz-panel" style={{ position: "absolute", top: 12, left: 12, padding: "8px 12px", pointerEvents: "none" }}>
          <div className="pz-label" style={{ marginBottom: 6 }}>Legend</div>
          {Object.entries(TIERS).map(([tier, t]) => (
            <div key={tier} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
              <span style={{ width: 14, height: 14, borderRadius: "50%", background: t.color, border: "3px solid var(--ink)" }} />
              <span style={{ fontSize: 17, fontWeight: 600 }}>{t.label} entity</span>
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <span style={{ width: 12, height: 12, background: "#cfe0dd", border: "3px solid var(--ink)", transform: "rotate(45deg)" }} />
            <span style={{ fontSize: 17, fontWeight: 600 }}>Event type</span>
          </div>
        </div>

        <div className="pz-panel" style={{ position: "absolute", top: 12, right: 12, padding: "8px 12px", pointerEvents: "none", maxWidth: 210 }}>
          <div className="pz-label" style={{ marginBottom: 6 }}>Behaviour clusters</div>
          {Object.entries(CLUSTER_COLORS).filter(([k]) => k !== "Unknown Pattern").map(([label, color]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
              <span style={{ width: 10, height: 10, border: `3px dashed ${color}`, borderRadius: "50%", flexShrink: 0 }} />
              <span style={{ fontSize: 15, lineHeight: 1.1 }}>{label}</span>
            </div>
          ))}
        </div>

        <div style={{ position: "absolute", bottom: 10, left: 14, fontSize: 17, color: "#cfe0dd", pointerEvents: "none", textShadow: "0 2px 0 rgba(0,0,0,.6)" }}>
          Drag nodes. Scroll to zoom. Click one to investigate. {entities.length} entities.
        </div>
      </div>

      <DetailPanel selected={selected} />

      {tooltip && (
        <div className="pz-tip no-arrow" style={{ position: "fixed", left: tooltip.x + 14, top: tooltip.y - 10, zIndex: 9999, pointerEvents: "none", maxWidth: 250 }}>
          <div style={{ fontWeight: 700, fontSize: 20 }}>{tooltip.d.type === "entity" ? tooltip.d.label : `Event type ${tooltip.d.label}`}</div>
          {tooltip.d.cluster && <div style={{ fontSize: 17, color: "#6a41c9", fontWeight: 600 }}>{tooltip.d.cluster}</div>}
          <div style={{ fontSize: 17, marginTop: 2 }}>
            {tooltip.d.type === "entity"
              ? `${TIERS[tooltip.d.tier]?.label || "?"} threat, ${tooltip.d.count} events, avg ${tooltip.d.score}% suspicious`
              : `Connected to ${tooltip.d.count} ${tooltip.d.count === 1 ? "entity" : "entities"}, ${TIERS[tooltip.d.tier]?.label || "?"} tier`}
          </div>
        </div>
      )}
    </div>
  )
}

// Collapsible detail panel
function DetailPanel({ selected }) {
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
            <div style={{ fontWeight: 700, fontSize: 23 }}>Click any node</div>
            <div style={{ fontSize: 18 }}>to investigate it.</div>
          </div>
        ) : selected.type === "entity" ? <EntityDetail entity={selected.data} /> : <EventIdDetail node={selected} />}
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

function EntityDetail({ entity }) {
  const t = TIERS[entity.max_tier] || TIERS[1]
  const summary = buildEntitySummary(entity)
  const clusterCounts = {}
  ;(entity.clusters || []).forEach(c => { clusterCounts[c] = (clusterCounts[c] || 0) + 1 })
  const dominant = Object.entries(clusterCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || ""

  return (
    <div className="pz-bounce-in">
      <div style={{ background: t.color, border: "3px solid var(--ink)", borderRadius: 8, padding: "8px 10px", marginBottom: 10, color: t.label === "MEDIUM" ? "#1d2527" : "#fff" }}>
        <div className="pz-title" style={{ fontSize: 23, lineHeight: 1.1, textShadow: t.label === "MEDIUM" ? "none" : undefined }}>{sanitizeField(entity.entity)}</div>
        <div style={{ fontSize: 15, opacity: .9 }}>{sanitizeField(entity.computer || "")}</div>
        <div style={{ fontSize: 17, marginTop: 2 }}>{explainTier(entity.max_tier)}</div>
      </div>
      {dominant && <Box title="BEHAVIOUR CLUSTER">{dominant}</Box>}
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
      <Box title="EVENT TYPES SEEN">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {entity.event_ids.map((id, i) => <span key={i} className="pz-tag" style={{ background: "#26373b" }}>#{id}</span>)}
        </div>
      </Box>
    </div>
  )
}

function EventIdDetail({ node }) {
  const t = TIERS[node.tier] || TIERS[1]
  const fakeEvent = {
    raw_data: JSON.stringify({ EventID: parseInt(node.label.replace("#", "")) || 0 }),
    threat_tier: node.tier, anomaly_score: 0, timestamp: "", source: "",
  }
  return (
    <div className="pz-bounce-in">
      <div style={{ fontWeight: 700, fontSize: 36, color: t.color, textShadow: "0 2px 0 var(--ink)", marginBottom: 8 }}>{sanitizeField(node.label)}</div>
      <Box title="WHAT IT MEANS">{getHumanDescription(fakeEvent)}</Box>
      <Box title="CONNECTED TO">{node.count} {node.count === 1 ? "entity" : "entities"}</Box>
      <Box title="HIGHEST THREAT SEEN" tone={t.color + "55"}><b>{t.label}.</b> {explainTier(node.tier)}</Box>
    </div>
  )
}
