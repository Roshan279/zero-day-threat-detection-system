import { useEffect, useMemo, useRef, useState } from "react"
import { TIER } from "./px/cardModel"
import PxIcon from "./px/PxIcon"
import { bucketize, stamp } from "./graphData"
import SummaryCard from "./SummaryCard"
import { shortTitle } from "./px/cardModel"

// ─────────────────────────────────────────────────────────────
// TIER TERRAIN: events as a 3D landscape. One row per threat level (CRITICAL at the back), one column
// per time slot, and every column stands as tall as the events in it. Drag to turn and tilt it, flick to
// let it coast, or switch to Flat for a heatmap.
// A canvas with a small spring simulation: the columns rise in a wave from where you grabbed, the one under
// the pointer bumps up, and the view settles with a little overshoot.
// ─────────────────────────────────────────────────────────────
const ROWS = 4
const GAP = 0.18
const MAX_HEIGHT = 3.4                       // tallest column, in cells
const DEG = Math.PI / 180
const PITCH_TERRAIN = 54 * DEG               // tilt of the terrain view; flat is looking straight down
const YAW_TERRAIN = 18 * DEG
const YAW_LIMIT = 38 * DEG                   // how far it turns before the edges pull back
const PITCH_LIMIT = 66 * DEG
const DRAG_YAW = 0.32 * DEG                  // radians per px dragged
const DRAG_PITCH = 0.36 * DEG
const SPIN_HALF_LIFE = 0.16                  // a flick keeps going and slows on this half-life (s)
const SPIN_IN = (YAW_TERRAIN * Math.LN2) / SPIN_HALF_LIFE
const PITCH_STIFFNESS = 140
const PITCH_DAMPING = 2 * Math.sqrt(PITCH_STIFFNESS)
const EDGE_STIFFNESS = 180
const BUMP_STIFFNESS = 400
const BUMP_DAMPING = 2 * Math.sqrt(BUMP_STIFFNESS) * 0.7
const BUMP = 0.45
const WAVE = 0.7                             // the far end of the board lags by this share of the rise
const PAD_L = 76, PAD_R = 14, PAD_Y = 22     // room for the row names on the left
const REST_EPSILON = 0.0005
const BASE = [36, 50, 52]
const FONT = `15px "Jersey 15", "Courier New", monospace`

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const easeOutBack = (t) => { const c = 1.4, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u }
function rubber(v, min, max) {          // resistance past an edge: the further out, the less it moves
  if (v < min) return min - 0.18 * (1 - Math.exp((v - min) / 0.18))
  if (v > max) return max + 0.18 * (1 - Math.exp((max - v) / 0.18))
  return v
}
const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
const shade = ([r, g, b], amount) => { const k = 1 - amount; return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})` }
const TIER_RGB = Object.fromEntries([1, 2, 3, 4].map(t => [t, hexRgb(TIER[t].color)]))

function buildCells(buckets) {
  let max = 1
  buckets.forEach(b => [1, 2, 3, 4].forEach(t => { max = Math.max(max, b.counts[t]) }))
  const cells = []
  buckets.forEach((b, col) => {
    for (let row = 0; row < ROWS; row++) {
      const tier = 4 - row
      const count = b.counts[tier]
      const norm = count / max
      cells.push({
        index: cells.length, col, row, tier, count, bucket: b,
        height: count ? 0.12 + norm ** 0.85 * MAX_HEIGHT : 0.05,
        color: count ? mix(BASE, TIER_RGB[tier], 0.5 + 0.5 * norm ** 0.6) : BASE,
      })
    }
  })
  return cells
}

function project(p, x, y, z) {
  const cos = Math.cos(p.yaw), sin = Math.sin(p.yaw)
  const xr = x * cos - z * sin, zr = x * sin + z * cos
  return [p.cx + xr * p.scale, p.cy + (zr * Math.cos(p.pitch) - y * Math.sin(p.pitch)) * p.scale]
}

// The faces of one column that face the camera, top last.
function visibleFaces(p, x0, z0, h) {
  const x1 = x0 + 1 - GAP, z1 = z0 + 1 - GAP
  const q = (x, y, z) => project(p, x, y, z)
  const faces = []
  const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw)
  if (h > 0.02 && p.pitch > 0.01) {
    faces.push(cos > 0
      ? { points: [q(x0, 0, z1), q(x1, 0, z1), q(x1, h, z1), q(x0, h, z1)], tone: 0.22 }
      : { points: [q(x0, 0, z0), q(x1, 0, z0), q(x1, h, z0), q(x0, h, z0)], tone: 0.22 })
    if (sin > 0.001) faces.push({ points: [q(x1, 0, z0), q(x1, 0, z1), q(x1, h, z1), q(x1, h, z0)], tone: 0.38 })
    else if (sin < -0.001) faces.push({ points: [q(x0, 0, z0), q(x0, 0, z1), q(x0, h, z1), q(x0, h, z0)], tone: 0.38 })
  }
  faces.push({ points: [q(x0, h, z0), q(x1, h, z0), q(x1, h, z1), q(x0, h, z1)], tone: 0 })
  return faces
}

function inside(points, x, y) {
  let hit = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function polygon(ctx, points) {
  ctx.beginPath()
  ctx.moveTo(points[0][0], points[0][1])
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1])
  ctx.closePath()
}

export default function TierTerrain({ events }) {
  const { buckets } = useMemo(() => bucketize(events, 16), [events])
  const cells = useMemo(() => buildCells(buckets), [buckets])
  const counts = useMemo(() => {
    const c = { 1: 0, 2: 0, 3: 0, 4: 0 }
    events.forEach(e => { c[e.threat_tier] = (c[e.threat_tier] || 0) + 1 })
    return c
  }, [events])
  const [flat, setFlat] = useState(false)
  const [active, setActive] = useState(null)
  const [dragging, setDragging] = useState(false)

  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const [float, setFloat] = useState(null)       // a summary card lifted off the terrain or a level card
  const api = useRef({})
  const dataRef = useRef({ cells, cols: buckets.length })
  const sim = useRef({
    yaw: 0, yawSpeed: 0, pitch: 0, pitchSpeed: 0, pitchTarget: PITCH_TERRAIN,
    bumps: new Float64Array(0), bumpSpeeds: new Float64Array(0), hovered: -1, origin: { col: 0, row: 1 },
    width: 0, height: 0, dpr: 1, drag: null, raf: 0, last: 0, visible: false, started: false, reduce: false,
  })

  // New data: fresh bumps, and repaint.
  useEffect(() => {
    const s = sim.current
    dataRef.current = { cells, cols: buckets.length }
    s.bumps = new Float64Array(cells.length)
    s.bumpSpeeds = new Float64Array(cells.length)
    s.hovered = -1
    s.origin = { col: Math.floor(buckets.length / 2), row: 1 }
    api.current.draw?.()
  }, [cells, buckets.length])

  useEffect(() => {
    const s = sim.current
    const canvas = canvasRef.current
    if (!canvas) return
    const cols = () => dataRef.current.cols
    const list = () => dataRef.current.cells

    // How tall each column stands right now: the rise travels as a wave out from the origin and overshoots as it lands.
    const columnHeight = (cell, lift) => {
      const span = Math.hypot(cols(), ROWS) || 1
      const d = Math.hypot(cell.col - s.origin.col, cell.row - s.origin.row) / span
      const local = clamp(lift * (1 + WAVE) - d * WAVE, 0, 1)
      return cell.height * easeOutBack(local) + (s.bumps[cell.index] || 0)
    }

    // Fit the whole board, at its current turn and tilt, into the canvas.
    const pose = () => {
      const w = cols()
      const lift = clamp(s.pitch / PITCH_TERRAIN, 0, 1.2)
      const probe = { yaw: s.yaw, pitch: s.pitch, scale: 1, cx: 0, cy: 0 }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const [x, z] of [[0, 0], [w, 0], [0, ROWS], [w, ROWS]]) {
        for (const y of [0, MAX_HEIGHT * Math.min(lift, 1)]) {
          const [px, py] = project(probe, x - w / 2, y, z - ROWS / 2)
          minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py)
        }
      }
      const scale = Math.max(1, Math.min((s.width - PAD_L - PAD_R) / (maxX - minX), (s.height - PAD_Y * 2) / (maxY - minY)))
      return {
        yaw: s.yaw, pitch: s.pitch, scale, lift,
        cx: PAD_L + (s.width - PAD_L - PAD_R) / 2 - ((minX + maxX) / 2) * scale,
        cy: s.height / 2 - ((minY + maxY) / 2) * scale,
      }
    }

    // Back to front: the further a column's base, the earlier it's drawn.
    const ordered = (p) => {
      const sin = Math.sin(p.yaw), cos = Math.cos(p.yaw), w = cols()
      const depth = (c) => (c.col + 0.5 - w / 2) * sin + (c.row + 0.5 - ROWS / 2) * cos
      return [...list()].sort((a, b) => depth(a) - depth(b))
    }

    const drawLabels = (ctx, p) => {
      const alpha = clamp(1 - p.lift * 1.1, 0.4, 1)
      const w = cols()
      ctx.globalAlpha = alpha
      ctx.font = FONT
      ctx.textBaseline = "middle"
      ctx.textAlign = "right"
      for (let row = 0; row < ROWS; row++) {
        const t = 4 - row
        const [x, y] = project(p, -0.35 - w / 2, 0, row + 0.45 - ROWS / 2)
        ctx.fillStyle = TIER[t].color
        ctx.fillText(TIER[t].name, x, y)
      }
      ctx.textAlign = "center"
      ctx.fillStyle = "#b5e8f2"
      const step = Math.max(1, Math.ceil(w / 7))
      dataRef.current.cells.forEach(c => {
        if (c.row !== 0 || c.col % step) return
        const [x, y] = project(p, c.col + 0.5 - w / 2, 0, ROWS - ROWS / 2 + 0.6)
        ctx.fillText(c.bucket.label, x, y)
      })
      ctx.globalAlpha = 1
    }

    const draw = () => {
      const ctx = canvas.getContext("2d")
      if (!ctx || !s.width) return
      const p = pose()
      const w = cols()
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0)
      ctx.clearRect(0, 0, s.width, s.height)
      drawLabels(ctx, p)
      ctx.lineJoin = "round"
      for (const cell of ordered(p)) {
        const h = columnHeight(cell, p.lift)
        const color = cell.index === s.hovered ? mix(cell.color, [255, 255, 255], 0.35) : cell.color
        for (const face of visibleFaces(p, cell.col - w / 2, cell.row - ROWS / 2, h)) {
          polygon(ctx, face.points)
          const fill = shade(color, face.tone)
          ctx.fillStyle = fill
          ctx.fill()
          ctx.strokeStyle = cell.count ? "#1d2527" : fill   // empty slots stay quiet, filled ones get the pixel outline
          ctx.lineWidth = cell.count ? 1.5 : 0.6
          ctx.stroke()
        }
      }
    }

    const hitTest = (x, y) => {
      const p = pose()
      const w = cols()
      const sorted = ordered(p)
      for (let i = sorted.length - 1; i >= 0; i--) {
        const cell = sorted[i]
        const h = columnHeight(cell, p.lift)
        for (const face of visibleFaces(p, cell.col - w / 2, cell.row - ROWS / 2, h)) {
          if (inside(face.points, x, y)) return cell
        }
      }
      return null
    }

    const stepSprings = (dt) => {
      let energy = 0
      if (!s.drag) {
        s.yawSpeed *= 0.5 ** (dt / SPIN_HALF_LIFE)
        let target = s.yaw
        if (s.pitchTarget === 0) target = 0                    // flat is always square on
        else if (s.yaw > YAW_LIMIT) target = YAW_LIMIT
        else if (s.yaw < -YAW_LIMIT) target = -YAW_LIMIT
        if (target !== s.yaw) s.yawSpeed += ((target - s.yaw) * EDGE_STIFFNESS - s.yawSpeed * 2 * Math.sqrt(EDGE_STIFFNESS)) * dt
        s.yaw += s.yawSpeed * dt
        energy = Math.max(energy, Math.abs(s.yawSpeed), Math.abs(target - s.yaw))
        s.pitchSpeed += ((s.pitchTarget - s.pitch) * PITCH_STIFFNESS - s.pitchSpeed * PITCH_DAMPING) * dt
        s.pitch += s.pitchSpeed * dt
        energy = Math.max(energy, Math.abs(s.pitchSpeed), Math.abs(s.pitchTarget - s.pitch))
      }
      for (let i = 0; i < s.bumps.length; i++) {
        const target = i === s.hovered && s.pitch > 0.1 ? BUMP : 0
        s.bumpSpeeds[i] += ((target - s.bumps[i]) * BUMP_STIFFNESS - s.bumpSpeeds[i] * BUMP_DAMPING) * dt
        s.bumps[i] += s.bumpSpeeds[i] * dt
        energy = Math.max(energy, Math.abs(s.bumpSpeeds[i]) * 0.1, Math.abs(target - s.bumps[i]))
      }
      return energy
    }

    const tick = (now) => {
      s.raf = 0
      const dt = s.last ? Math.min((now - s.last) / 1000, 1 / 30) : 1 / 60
      s.last = now
      const energy = stepSprings(dt)
      draw()
      if ((s.drag || energy > REST_EPSILON) && s.visible) s.raf = requestAnimationFrame(tick)
      else s.last = 0
    }

    // Swing round from straight on as it tilts up, coasting to a stop at the resting turn.
    const turnIn = () => {
      if (Math.abs(s.yaw) > 2 * DEG) return
      if (s.reduce) s.yaw = YAW_TERRAIN
      else s.yawSpeed = SPIN_IN
    }

    const wake = () => {
      if (s.reduce) {                       // no travel: everything lands where it is going
        s.pitch = s.pitchTarget
        s.yaw = clamp(s.yaw, -YAW_LIMIT, YAW_LIMIT)
        s.pitchSpeed = 0; s.yawSpeed = 0
        s.bumps.fill(0)
        draw()
        return
      }
      if (!s.raf && s.visible) s.raf = requestAnimationFrame(tick)
    }

    const hover = (cell) => {
      const index = cell ? cell.index : -1
      if (index === s.hovered) return
      s.hovered = index
      setActive(cell)
      if (s.reduce) draw(); else wake()
    }

    const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top } }

    const onDown = (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return
      const { x, y } = local(e)
      canvas.setPointerCapture(e.pointerId)
      const cell = hitTest(x, y)
      if (cell) s.origin = { col: cell.col, row: cell.row }
      s.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: s.yaw, pitch: s.pitch, moved: false, samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }], cell }
      s.yawSpeed = 0; s.pitchSpeed = 0
      setFloat(null)
      setDragging(true)
      hover(cell)
      wake()
    }

    const onMove = (e) => {
      const d = s.drag
      if (!d || d.id !== e.pointerId) {
        if (e.pointerType === "mouse") { const { x, y } = local(e); hover(hitTest(x, y)) }
        return
      }
      const dx = e.clientX - d.x, dy = e.clientY - d.y
      if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true
      if (!d.moved) return
      s.yaw = rubber(d.yaw + dx * DRAG_YAW, -YAW_LIMIT, YAW_LIMIT)
      s.pitch = rubber(d.pitch + dy * DRAG_PITCH, 0, PITCH_LIMIT)
      d.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY })
      if (d.samples.length > 5) d.samples.shift()
      if (s.reduce) draw(); else wake()
    }

    const onUp = (e) => {
      const d = s.drag
      if (!d || d.id !== e.pointerId) return
      s.drag = null
      setDragging(false)
      if (!d.moved) {                                 // a tap lifts that column's summary
        const { x, y } = local(e)
        const cell = hitTest(x, y) || d.cell
        if (cell && cell.count > 0) {
          const w = wrapRef.current.getBoundingClientRect()
          setFloat({ kind: "cell", cell, x: e.clientX - w.left, y: e.clientY - w.top, width: w.width })
        }
        wake()
        return
      }
      const first = d.samples[0], last = d.samples[d.samples.length - 1] || first
      const dt = Math.max((last.t - first.t) / 1000, 0.016)
      const recent = e.timeStamp - last.t < 80
      s.yawSpeed = recent ? ((last.x - first.x) / dt) * DRAG_YAW : 0
      s.pitchSpeed = recent ? ((last.y - first.y) / dt) * DRAG_PITCH : 0
      const nextFlat = s.pitch + s.pitchSpeed * 0.15 < PITCH_TERRAIN / 2     // land on whichever view the throw is heading for
      setFlat(nextFlat)
      s.pitchTarget = nextFlat ? 0 : PITCH_TERRAIN
      wake()
    }

    const onLeave = (e) => { if (!s.drag && e.pointerType === "mouse") hover(null) }

    const onKey = (e) => {
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      const mv = moves[e.key]
      if (!mv) return
      e.preventDefault()
      const cur = list()[s.hovered] || list()[list().length - 1]
      if (!cur) return
      const next = list().find(c => c.col === cur.col + mv[0] && c.row === cur.row + mv[1])
      hover(next || cur)
    }

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    s.reduce = motion.matches
    const resize = new ResizeObserver(([entry]) => {
      s.width = entry.contentRect.width
      s.height = entry.contentRect.height
      s.dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(s.width * s.dpr)
      canvas.height = Math.round(s.height * s.dpr)
      draw()
    })
    resize.observe(canvas)

    let onScreen = false
    const update = () => {
      s.visible = onScreen && !document.hidden
      if (s.visible) {
        if (!s.started) { s.started = true; if (s.pitchTarget > 0) turnIn() }   // the intro tilts it up from flat once it is on screen
        wake()
      } else if (s.raf) { cancelAnimationFrame(s.raf); s.raf = 0; s.last = 0 }
    }
    const io = new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; update() })
    io.observe(canvas)
    document.addEventListener("visibilitychange", update)

    canvas.addEventListener("pointerdown", onDown)
    canvas.addEventListener("pointermove", onMove)
    canvas.addEventListener("pointerup", onUp)
    canvas.addEventListener("pointercancel", onUp)
    canvas.addEventListener("lostpointercapture", onUp)
    canvas.addEventListener("pointerleave", onLeave)
    canvas.addEventListener("keydown", onKey)
    const onBlur = () => { if (!s.drag) hover(null) }
    canvas.addEventListener("blur", onBlur)

    api.current = {
      draw,
      setView: (nextFlat) => {
        setFlat(nextFlat)
        s.origin = { col: nextFlat ? cols() : 0, row: 1 }
        s.pitchTarget = nextFlat ? 0 : PITCH_TERRAIN
        s.yawSpeed = 0
        if (!nextFlat) turnIn()
        wake()
      },
    }

    return () => {
      resize.disconnect(); io.disconnect()
      document.removeEventListener("visibilitychange", update)
      canvas.removeEventListener("pointerdown", onDown)
      canvas.removeEventListener("pointermove", onMove)
      canvas.removeEventListener("pointerup", onUp)
      canvas.removeEventListener("pointercancel", onUp)
      canvas.removeEventListener("lostpointercapture", onUp)
      canvas.removeEventListener("pointerleave", onLeave)
      canvas.removeEventListener("keydown", onKey)
      canvas.removeEventListener("blur", onBlur)
      cancelAnimationFrame(s.raf); s.raf = 0
    }
  }, [])

  const readout = active
    ? `${active.count} ${TIER[active.tier].name} event${active.count === 1 ? "" : "s"} at ${stamp(active.bucket.t0)}`
    : `${events.length} events in ${buckets.length} time slot${buckets.length === 1 ? "" : "s"}. Drag to turn it.`

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div aria-live="polite" style={{ flex: 1, minWidth: 0, fontSize: 16, color: active ? TIER[active.tier].color : "#b5e8f2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{readout}</div>
        {[["Flat", true], ["Terrain", false]].map(([name, value]) => (
          <button key={name} aria-pressed={flat === value} className={`pz-btn small ${flat === value ? "gold" : "gray"}`}
            onClick={() => flat !== value && api.current.setView?.(value)}>{name}</button>
        ))}
      </div>
      <div className="bt-felt">
        <canvas ref={canvasRef} tabIndex={0} role="img"
          aria-label={`Events by time slot and threat level: ${[4, 3, 2, 1].map(c => `${counts[c]} ${TIER[c].name}`).join(", ")}. Use the arrow keys to read each column.`}
          style={{ display: "block", width: "100%", height: 250, touchAction: "pan-y", cursor: dragging ? "grabbing" : "grab", outlineOffset: -4 }} />
      </div>
      <div className="bt-minis">
        {[4, 3, 2, 1].map((c, i) => {
          const red = c === 4 || c === 2
          const col = red ? "#ec2d33" : "#1d2527"
          return (
            <button key={c} className={`bt-mini ${counts[c] ? "" : "zero"}`} disabled={!counts[c]}
              onClick={(e) => { const w = wrapRef.current.getBoundingClientRect(), r = e.currentTarget.getBoundingClientRect(); setFloat({ kind: "tier", tier: c, x: r.left - w.left + r.width / 2, y: r.top - w.top, width: w.width }) }}
              aria-label={`${TIER[c].name}: ${counts[c]} events. Show a summary`} style={{ "--c": TIER[c].color, "--r": `${[-5, -2, 2, 5][i]}deg` }}>
              <span className="corner" style={{ color: col }}><span className="rank">{TIER[c].rank}</span><PxIcon suit={["heart", "club", "diamond", "spade"][4 - c]} size={14} color={col} /></span>
              <span className="art"><PxIcon name={["", "eye", "bolt", "warn", "warn"][c]} size={36} /></span>
              <span className="name">{TIER[c].name}</span>
              <span className="num">{counts[c]}</span>
            </button>
          )
        })}
      </div>
      {float && (() => {
        const SUIT = { 4: "spade", 3: "diamond", 2: "club", 1: "heart" }, ICON = { 4: "warn", 3: "warn", 2: "bolt", 1: "eye" }
        const tier = float.kind === "tier" ? float.tier : float.cell.tier
        const list = (float.kind === "tier" ? events.filter(e => e.threat_tier === tier) : float.cell.bucket.events.filter(e => e.threat_tier === tier))
          .slice().sort((a, b) => (b.anomaly_score || 0) - (a.anomaly_score || 0))
        const top = list[0] ? Math.round((list[0].anomaly_score || 0) * 100) : 0
        const busiest = buckets.reduce((m, b) => (b.counts[tier] > (m?.counts[tier] || 0) ? b : m), null)
        const stats = float.kind === "tier"
          ? [["Events", list.length], ["Share", `${Math.round((list.length / Math.max(1, events.length)) * 100)}% of all`], ["Top score", `${top}%`], ["Busiest", busiest ? busiest.label : "none"]]
          : [["Time", stamp(float.cell.bucket.t0)], ["Events", list.length], ["Top score", `${top}%`]]
        return (
          <SummaryCard anchor={{ x: float.x, y: float.y }} boxWidth={float.width} color={TIER[tier].color} rank={TIER[tier].rank} suit={SUIT[tier]} icon={ICON[tier]}
            title={float.kind === "tier" ? `${TIER[tier].name} pile` : `${TIER[tier].name} column`} sub={float.kind === "tier" ? "all time slots" : "one time slot"}
            stats={stats} rows={list.slice(0, 4).map(e => [shortTitle(e), `${Math.round((e.anomaly_score || 0) * 100)}%`])} onClose={() => setFloat(null)} />
        )
      })()}
    </div>
  )
}
