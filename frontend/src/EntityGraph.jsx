import { useEffect, useRef, useState, useCallback } from "react"
import * as d3 from "d3"
import axios from "axios"
import { buildEntitySummary, getHumanDescription, explainTier, formatTimestamp } from "./humanlog"
import { sanitizeField, sanitizeEventRecord } from "./sanitize"

const API = "http://localhost:8000"

const TIERS = {
  1:{color:"#4ade80",label:"LOW",      bg:"#0a1f0f"},
  2:{color:"#facc15",label:"MEDIUM",   bg:"#1a1400"},
  3:{color:"#fb923c",label:"HIGH",     bg:"#1a0e00"},
  4:{color:"#f87171",label:"CRITICAL", bg:"#1a0505"},
}

// Cluster → colour mapping for the grouping rings
const CLUSTER_COLORS = {
  "Brute Force Pattern":        "#facc15",
  "Credential Access Pattern":  "#fb923c",
  "Privilege Escalation Pattern":"#f87171",
  "Persistence Pattern":        "#f87171",
  "Data Exfiltration Pattern":  "#f87171",
  "Normal System Activity":     "#4ade80",
  "Unknown Pattern":            "#555",
}

const tierColor = (tier, fallback="#2a2a2a") => TIERS[tier]?.color ?? fallback

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
    svg.call(
      d3.zoom().scaleExtent([0.3, 3])
        .on("zoom", event => g.attr("transform", event.transform))
    )

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
      .force("link",      d3.forceLink(links).id(d => d.id).distance(120).strength(0.4))
      .force("charge",    d3.forceManyBody().strength(-500))
      .force("center",    d3.forceCenter(W/2, H/2).strength(0.05))
      .force("collision", d3.forceCollide(d => d.r + 20))
      .alpha(1).alphaDecay(0.02)
    simRef.current = sim

    // ── Cluster grouping rings ───────────────────────────────
    // Drawn first so they're behind everything else
    const clusterGroup = g.append("g").attr("class", "cluster-rings")

    // ── Links ────────────────────────────────────────────────
    const linkSel = g.append("g").selectAll("line").data(links).join("line")
      .attr("stroke", d => (tierColor(d.tier, "#2a2a2a")) + "55")
      .attr("stroke-width", d => d.tier >= 3 ? 1.8 : 0.9)
      .style("stroke-dasharray", d => d.tier >= 4 ? "5,3" : "none")

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
      .attr("fill", d => tierColor(d.tier, "#888") + "18")
      .attr("stroke", d => tierColor(d.tier, "#888"))
      .attr("stroke-width", d => d.tier >= 3 ? 2 : 1.5)
      .attr("filter", d => `url(#glow-t${d.tier})`)

    // Cluster ring around entity node (coloured by cluster)
    nodeSel.filter(d => d.type === "entity" && d.cluster).append("circle")
      .attr("r", d => d.r + 7)
      .attr("fill", "none")
      .attr("stroke", d => (CLUSTER_COLORS[d.cluster] || "#555") + "55")
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "4 3")

    // Event ID diamonds
    nodeSel.filter(d => d.type === "eventid").append("rect")
      .attr("x", -9).attr("y", -9).attr("width", 18).attr("height", 18).attr("rx", 2)
      .attr("transform", "rotate(45)")
      .attr("fill", d => tierColor(d.tier, "#888") + "22")
      .attr("stroke", d => tierColor(d.tier, "#888"))
      .attr("stroke-width", 1.2)

    // Entity label
    nodeSel.filter(d => d.type === "entity").append("text")
      .text(d => d.shortLabel)
      .attr("text-anchor", "middle").attr("dy", "0.35em")
      .attr("font-size", d => d.r > 26 ? "8px" : "7px")
      .attr("font-family", "'Share Tech Mono',monospace")
      .attr("fill", d => tierColor(d.tier, "#888"))
      .style("pointer-events", "none")

    // Event ID label
    nodeSel.filter(d => d.type === "eventid").append("text")
      .text(d => d.label)
      .attr("text-anchor", "middle").attr("dy", "0.35em")
      .attr("font-size", "6.5px").attr("font-family", "'Orbitron',monospace")
      .attr("fill", d => tierColor(d.tier, "#888"))
      .style("pointer-events", "none")

    // Event count sub-label
    nodeSel.filter(d => d.type === "entity" && d.count > 0).append("text")
      .text(d => `${d.count}ev`)
      .attr("text-anchor", "middle").attr("dy", d => d.r + 12)
      .attr("font-size", "6.5px").attr("font-family", "'Orbitron',monospace")
      .attr("fill", d => tierColor(d.tier, "#888") + "88")
      .style("pointer-events", "none")

    // ── Tick — update positions + cluster rings ───────────────
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
          .attr("fill",   color + "0a")
          .attr("stroke", color + "30")
          .attr("stroke-width", 1.5)
          .attr("stroke-dasharray", "6 4")
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

  if (loading) return <div style={{color:"#333",textAlign:"center",padding:"40px",fontSize:"0.8rem"}}>Building entity graph...</div>
  if (error)   return <div style={{color:"#f87171",textAlign:"center",padding:"40px",fontSize:"0.8rem",fontFamily:"'Share Tech Mono',monospace"}}>⚠ Failed to load entities — is the backend running?</div>
  if (!entities.length) return <div style={{color:"#333",textAlign:"center",padding:"40px",fontSize:"0.8rem"}}>No entities found. Run a scan or inject demo attack first.</div>

  return (
    <div className="tab-enter" style={{display:"flex",height:"100%",overflow:"hidden",position:"relative"}}>
      <div style={{flex:1,position:"relative",background:"#050508",overflow:"hidden"}}>
        <svg ref={svgRef} style={{width:"100%",height:"100%",display:"block"}}/>

        {/* Legend */}
        <div style={{position:"absolute",top:"14px",left:"14px",background:"rgba(8,8,8,0.92)",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"10px 12px",fontFamily:"'Share Tech Mono',monospace",pointerEvents:"none"}}>
          <div style={{color:"#333",fontSize:"0.56rem",letterSpacing:"0.15em",marginBottom:"8px"}}>LEGEND</div>
          {Object.entries(TIERS).map(([tier, t]) => (
            <div key={tier} style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:"4px"}}>
              <div style={{width:"8px",height:"8px",borderRadius:"50%",border:`1.5px solid ${t.color}`,background:`${t.color}22`}}/>
              <span style={{color:t.color,fontSize:"0.58rem"}}>{t.label} ENTITY</span>
            </div>
          ))}
          <div style={{marginTop:"6px",paddingTop:"6px",borderTop:"1px solid #1a1a1a"}}>
            <div style={{display:"flex",alignItems:"center",gap:"6px",marginBottom:"3px"}}>
              <div style={{width:"8px",height:"8px",border:"1px solid #888",transform:"rotate(45deg)"}}/>
              <span style={{color:"#555",fontSize:"0.58rem"}}>Event type</span>
            </div>
            <div style={{display:"flex",alignItems:"center",gap:"6px"}}>
              <div style={{width:"10px",height:"10px",borderRadius:"50%",border:"1px dashed #8888cc",background:"transparent"}}/>
              <span style={{color:"#8888cc",fontSize:"0.58rem"}}>Cluster group</span>
            </div>
          </div>
        </div>

        {/* Cluster legend */}
        <div style={{position:"absolute",top:"14px",right:"235px",background:"rgba(8,8,8,0.88)",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"10px 12px",fontFamily:"'Share Tech Mono',monospace",pointerEvents:"none",maxWidth:"180px"}}>
          <div style={{color:"#333",fontSize:"0.56rem",letterSpacing:"0.15em",marginBottom:"8px"}}>BEHAVIOUR CLUSTERS</div>
          {Object.entries(CLUSTER_COLORS).filter(([k]) => k !== "Unknown Pattern").map(([label, color]) => (
            <div key={label} style={{display:"flex",alignItems:"center",gap:"5px",marginBottom:"4px"}}>
              <div style={{width:"6px",height:"6px",borderRadius:"50%",border:`1px dashed ${color}`,flexShrink:0}}/>
              <span style={{color:`${color}cc`,fontSize:"0.54rem",lineHeight:"1.3"}}>{label}</span>
            </div>
          ))}
        </div>

        <div style={{position:"absolute",bottom:"14px",left:"14px",color:"#222",fontSize:"0.58rem",fontFamily:"'Share Tech Mono',monospace",pointerEvents:"none"}}>
          Drag · Scroll to zoom · Click to investigate · {entities.length} entities
        </div>
      </div>

      {/* Detail panel — collapsible */}
      <DetailPanel selected={selected}/>

      {/* Tooltip */}
      {tooltip && (
        <div style={{
          position:"fixed",left:tooltip.x+14,top:tooltip.y-10,
          background:"#0d0d0d",border:`1px solid ${tierColor(tooltip.d.tier)}`,
          borderRadius:"4px",padding:"8px 12px",zIndex:9999,pointerEvents:"none",
          fontFamily:"'Share Tech Mono',monospace",maxWidth:"240px",
        }}>
          <div style={{color:tierColor(tooltip.d.tier,"#888"),fontSize:"0.65rem",fontWeight:"bold",marginBottom:"3px"}}>
            {tooltip.d.type === "entity" ? tooltip.d.label : `Event type ${tooltip.d.label}`}
          </div>
          {/* Cluster badge in tooltip */}
          {tooltip.d.cluster && (
            <div style={{color:CLUSTER_COLORS[tooltip.d.cluster]||"#555",fontSize:"0.56rem",marginBottom:"3px"}}>
              ◈ {tooltip.d.cluster}
            </div>
          )}
          <div style={{color:"#555",fontSize:"0.58rem",lineHeight:"1.5"}}>
            {tooltip.d.type === "entity"
              ? `${TIERS[tooltip.d.tier]?.label||"?"} threat · ${tooltip.d.count} events · avg ${tooltip.d.score}% suspicious`
              : `Connected to ${tooltip.d.count} ${tooltip.d.count===1?"entity":"entities"} · ${TIERS[tooltip.d.tier]?.label||"?"} tier`
            }
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// COLLAPSIBLE DETAIL PANEL WRAPPER
// ─────────────────────────────────────────────────────────────
function DetailPanel({ selected }) {
  const [open, setOpen] = useState(true)

  // Auto-open when something is selected
  useEffect(() => { if (selected) setOpen(true) }, [selected])

  if (!open) return (
    <button
      onClick={() => setOpen(true)}
      style={{
        position:"absolute",right:"0",top:"50%",transform:"translateY(-50%)",
        background:"#0d0d0d",border:"1px solid #1a1a1a",borderRight:"none",
        borderRadius:"4px 0 0 4px",padding:"10px 6px",cursor:"pointer",
        color:"#333",fontSize:"0.6rem",fontFamily:"'Share Tech Mono',monospace",
        writingMode:"vertical-rl",letterSpacing:"0.1em",zIndex:10,
      }}
    >◀ DETAIL</button>
  )

  return (
    <div style={{
      width:"240px",minWidth:"240px",background:"#080808",
      borderLeft:"1px solid #1a1a1a",display:"flex",flexDirection:"column",
      overflow:"hidden",
    }}>
      {/* Header with collapse button */}
      <div style={{
        display:"flex",justifyContent:"space-between",alignItems:"center",
        padding:"10px 14px",borderBottom:"1px solid #1a1a1a",flexShrink:0,
      }}>
        <span style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.15em"}}>ENTITY DETAIL</span>
        <button
          onClick={() => setOpen(false)}
          style={{background:"transparent",border:"none",color:"#333",cursor:"pointer",fontSize:"0.72rem",lineHeight:1,padding:"0 2px"}}
          title="Collapse panel"
        >▶</button>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:"14px"}}>
        {!selected ? (
          <div style={{color:"#1a1a1a",fontSize:"0.68rem",lineHeight:"2.2",textAlign:"center",marginTop:"30px",fontFamily:"'Share Tech Mono',monospace"}}>
            Click any node<br/>to investigate
          </div>
        ) : selected.type === "entity" ? (
          <EntityDetail entity={selected.data}/>
        ) : (
          <EventIdDetail node={selected}/>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// ENTITY DETAIL PANEL
// ─────────────────────────────────────────────────────────────
function EntityDetail({ entity }) {
  const t       = TIERS[entity.max_tier] || TIERS[1]
  const summary = buildEntitySummary(entity)
  const first   = formatTimestamp(entity.first_seen)
  const last    = formatTimestamp(entity.last_seen)

  // Dominant cluster
  const clusterCounts = {}
  ;(entity.clusters || []).forEach(c => { clusterCounts[c] = (clusterCounts[c]||0)+1 })
  const dominantCluster = Object.entries(clusterCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || ""
  const clusterColor    = CLUSTER_COLORS[dominantCluster] || "#555"

  return (
    <div style={{display:"flex",flexDirection:"column",gap:"12px",fontFamily:"'Share Tech Mono',monospace"}}>
      {/* Name + tier */}
      <div style={{background:t.bg,border:`1px solid ${t.color}`,borderRadius:"4px",padding:"10px 12px"}}>
        <div style={{color:t.color,fontSize:"0.72rem",fontWeight:"bold",lineHeight:"1.4",textShadow:`0 0 8px ${t.color}88`}}>
          {sanitizeField(entity.entity)}
        </div>
        <div style={{color:"#444",fontSize:"0.58rem",marginTop:"2px"}}>{sanitizeField(entity.computer||"")}</div>
        <div style={{color:t.color,fontSize:"0.62rem",marginTop:"4px"}}>{explainTier(entity.max_tier)}</div>
      </div>

      {/* Cluster badge */}
      {dominantCluster && (
        <div style={{background:"#0d0d1a",border:`1px solid ${clusterColor}44`,borderRadius:"3px",padding:"6px 10px"}}>
          <div style={{color:"#333",fontSize:"0.54rem",letterSpacing:"0.1em",marginBottom:"2px"}}>BEHAVIOUR CLUSTER</div>
          <div style={{color:clusterColor,fontSize:"0.66rem"}}>◈ {dominantCluster}</div>
        </div>
      )}

      {/* All clusters observed */}
      {entity.clusters && entity.clusters.length > 1 && (
        <div>
          <div style={{color:"#333",fontSize:"0.54rem",marginBottom:"4px"}}>ALL CLUSTERS OBSERVED</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:"4px"}}>
            {entity.clusters.map((c, i) => (
              <span key={i} style={{background:"#0d0d1a",border:`1px solid ${(CLUSTER_COLORS[c]||"#555")}44`,color:CLUSTER_COLORS[c]||"#555",padding:"2px 7px",borderRadius:"2px",fontSize:"0.56rem"}}>
                {c}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Plain-English summary */}
      <div>
        <div style={{color:"#333",fontSize:"0.56rem",letterSpacing:"0.12em",marginBottom:"6px"}}>PLAIN ENGLISH SUMMARY</div>
        <div style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"10px 12px",color:"#e8d5b0",fontSize:"0.68rem",lineHeight:"1.7"}}>
          {summary}
        </div>
      </div>

      {/* Stats */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px"}}>
        {[
          ["EVENTS",     entity.event_count,     t.color],
          ["AVG SCORE",  `${entity.avg_score}%`, t.color],
          ["FIRST SEEN", first,                  "#888"],
          ["LAST SEEN",  last,                   "#888"],
        ].map(([lbl,val,col]) => (
          <div key={lbl} style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:"3px",padding:"7px"}}>
            <div style={{color:"#333",fontSize:"0.54rem",marginBottom:"2px"}}>{lbl}</div>
            <div style={{color:col,fontSize:"0.7rem"}}>{val}</div>
          </div>
        ))}
      </div>

      {/* Attack phases */}
      {entity.phases?.length > 0 && (
        <div>
          <div style={{color:"#333",fontSize:"0.56rem",marginBottom:"5px"}}>ATTACK PHASES INVOLVED</div>
          {entity.phases.map((p, i) => (
            <div key={i} style={{background:"#1a0505",border:"1px solid #f8717144",color:"#f87171",padding:"4px 10px",borderRadius:"2px",fontSize:"0.62rem",marginBottom:"4px",lineHeight:"1.5"}}>
              {sanitizeField(p)}
            </div>
          ))}
        </div>
      )}

      {/* Event IDs observed */}
      <div>
        <div style={{color:"#333",fontSize:"0.56rem",marginBottom:"5px"}}>EVENT TYPES SEEN</div>
        <div style={{display:"flex",flexWrap:"wrap",gap:"4px"}}>
          {entity.event_ids.map((id, i) => (
            <span key={i} style={{background:"#0d0d0d",border:"1px solid #1a1a1a",color:"#e8d5b0",padding:"2px 8px",borderRadius:"2px",fontSize:"0.62rem"}}>#{id}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// EVENT ID NODE DETAIL
// ─────────────────────────────────────────────────────────────
function EventIdDetail({ node }) {
  const t = TIERS[node.tier] || TIERS[1]
  const fakeEvent = {
    raw_data: JSON.stringify({ EventID: parseInt(node.label.replace("#","")) || 0 }),
    threat_tier: node.tier, anomaly_score: 0, timestamp: "", source: "",
  }
  const humanDesc = getHumanDescription(fakeEvent)

  return (
    <div style={{fontFamily:"'Share Tech Mono',monospace"}}>
      <div style={{color:t.color,fontSize:"0.9rem",fontWeight:"bold",textShadow:`0 0 8px ${t.color}88`,marginBottom:"8px"}}>{sanitizeField(node.label)}</div>
      <div style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"10px 12px",color:"#e8d5b0",fontSize:"0.68rem",lineHeight:"1.7",marginBottom:"12px"}}>
        {humanDesc}
      </div>
      <div style={{marginBottom:"10px"}}>
        <div style={{color:"#333",fontSize:"0.56rem",marginBottom:"3px"}}>CONNECTED TO</div>
        <div style={{color:t.color,fontSize:"1.1rem",fontFamily:"'Orbitron',monospace"}}>
          {node.count} {node.count===1?"entity":"entities"}
        </div>
      </div>
      <div>
        <div style={{color:"#333",fontSize:"0.56rem",marginBottom:"4px"}}>HIGHEST THREAT SEEN</div>
        <div style={{background:t.bg,border:`1px solid ${t.color}`,borderRadius:"4px",padding:"8px 12px"}}>
          <div style={{color:t.color,fontSize:"0.8rem",fontWeight:"bold"}}>{t.label}</div>
          <div style={{color:"#888",fontSize:"0.6rem",marginTop:"2px"}}>{explainTier(node.tier)}</div>
        </div>
      </div>
    </div>
  )
}