import { useCallback, useEffect, useRef, useState } from "react"
import { getDataMode, setDataMode } from "./dataMode"

// ─────────────────────────────────────────────────────────────
// PULL CORD: a switch you pull. A lamp hangs from a rod, and a cord with a little playing card on the end hangs
// from the lamp. Grab the cord and pull it down: past a short distance the switch clicks, once per pull, and the
// cord swings back on a simple rope simulation (a chain of points joined by fixed-length links, Verlet steps).
// The lamp is lit while the switch is on. Space or Enter on the hidden button works too.
// ─────────────────────────────────────────────────────────────
const W = 120, H = 156
const ANCHOR = { x: 86, y: 44 }            // where the cord hangs from, under the lamp shade
const LINKS = 10
const LINK = 8
const STEP = 1 / 120                       // a fixed step keeps the chain stable on any refresh rate
const GRAVITY = 1400
const DAMPING = 0.992
const MAX_SPEED = 4                        // letting go of a stretched cord must not fling it into the shade
const BEND_MIN = LINK * 1.9                // a cord is a little stiff: it bends in curves, not kinks
const BEND_STIFFNESS = 0.8
const ITERATIONS = 14
const CLICK_PULL = 16                      // how far past its length the cord has to be pulled to click
const MAX_STRETCH = 26
const REST_EPSILON = 0.015
const REST_STEPS = 24
const INK = "#1d2527"

const damp = (distance, max) => max * (1 - Math.exp(-distance / max))
const haptic = () => { if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(8) }

// Move points a and b toward `length` apart. A bend constraint only ever pushes apart, and only part of the way.
function relax(chain, a, b, length, bend) {
  const { xs, ys, held } = chain
  const aFixed = a === 0 || a === held
  const bFixed = b === held
  if (aFixed && bFixed) return
  const dx = xs[b] - xs[a], dy = ys[b] - ys[a]
  const dist = Math.hypot(dx, dy) || 0.0001
  if (bend && dist >= length) return
  const diff = ((dist - length) / dist) * (bend ? BEND_STIFFNESS : 1)
  let wa = 0.5
  if (aFixed) wa = 0
  else if (bFixed) wa = 1
  xs[a] += dx * diff * wa; ys[a] += dy * diff * wa
  xs[b] -= dx * diff * (1 - wa); ys[b] -= dy * diff * (1 - wa)
}

function cordPath(xs, ys) {
  let d = `M${xs[0].toFixed(2)} ${ys[0].toFixed(2)}`
  for (let i = 1; i < xs.length - 1; i++) {
    d += ` Q${xs[i].toFixed(2)} ${ys[i].toFixed(2)} ${((xs[i] + xs[i + 1]) / 2).toFixed(2)} ${((ys[i] + ys[i + 1]) / 2).toFixed(2)}`
  }
  const n = xs.length - 1
  return `${d} L${xs[n].toFixed(2)} ${ys[n].toFixed(2)}`
}

const rest = () => {
  const xs = new Float64Array(LINKS + 1), ys = new Float64Array(LINKS + 1)
  for (let i = 0; i <= LINKS; i++) { xs[i] = ANCHOR.x; ys[i] = ANCHOR.y + i * LINK }
  return { xs, ys }
}
const REST = rest()
const REST_PATH = cordPath(REST.xs, REST.ys)

// The switch for Demo data, hung in the right rail of the main screen. The lamp lights and the cord swings first,
// then the page reloads into the other mode.
export function DemoSwitch() {
  const [on, setOn] = useState(getDataMode() === "demo")
  const flip = (next) => { setOn(next); setTimeout(() => setDataMode(next ? "demo" : "real"), 700) }
  return (
    <div style={{ position: "fixed", right: 18, top: 210, zIndex: 60, width: 120, textAlign: "center" }}>
      <PullCord checked={on} onChange={flip} label="Demo data" />
      <div style={{ fontSize: 16, lineHeight: 1.1, marginTop: -2, color: on ? "var(--gold)" : "#dcdcdc", textShadow: "0 2px 0 rgba(0,0,0,.6)" }}>
        Demo data: {on ? "on" : "off"}
        <div style={{ fontSize: 13, color: "#b5e8f2" }}>pull the cord</div>
      </div>
    </div>
  )
}

export default function PullCord({ checked, onChange, label = "Switch" }) {
  const [grabbing, setGrabbing] = useState(false)
  const [focused, setFocused] = useState(false)
  const svgRef = useRef(null)
  const cordRef = useRef(null)
  const hitRef = useRef(null)
  const beadRef = useRef(null)
  const sim = useRef({
    xs: Float64Array.from(REST.xs), ys: Float64Array.from(REST.ys), pxs: Float64Array.from(REST.xs), pys: Float64Array.from(REST.ys),
    raf: 0, last: 0, carry: 0, still: 0, held: -1, targetX: 0, targetY: 0, armed: true, reduce: false,
  })
  const latest = useRef({ checked, onChange })
  const wakeRef = useRef(() => {})
  useEffect(() => { latest.current = { checked, onChange } }, [checked, onChange])

  useEffect(() => {
    const s = sim.current
    s.reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches

    const draw = () => {
      const d = cordPath(s.xs, s.ys)
      cordRef.current?.setAttribute("d", d)
      hitRef.current?.setAttribute("d", d)
      const n = LINKS
      const angle = (Math.atan2(s.xs[n] - s.xs[n - 1], s.ys[n] - s.ys[n - 1]) * 180) / Math.PI
      beadRef.current?.setAttribute("transform", `translate(${s.xs[n].toFixed(2)} ${s.ys[n].toFixed(2)}) rotate(${(-angle).toFixed(2)})`)
    }

    // Verlet: each free link keeps the velocity it had last step, plus gravity. The held link goes to the hand.
    const integrate = () => {
      let moved = 0
      for (let i = 1; i <= LINKS; i++) {
        if (i === s.held) continue
        let vx = (s.xs[i] - s.pxs[i]) * DAMPING, vy = (s.ys[i] - s.pys[i]) * DAMPING
        const speed = Math.hypot(vx, vy)
        if (speed > MAX_SPEED) { vx *= MAX_SPEED / speed; vy *= MAX_SPEED / speed }
        s.pxs[i] = s.xs[i]; s.pys[i] = s.ys[i]
        s.xs[i] += vx; s.ys[i] += vy + GRAVITY * STEP * STEP
        moved = Math.max(moved, Math.abs(vx) + Math.abs(vy))
      }
      if (s.held > 0) {
        const i = s.held
        moved = Math.max(moved, Math.abs(s.targetX - s.xs[i]) + Math.abs(s.targetY - s.ys[i]))
        s.pxs[i] = s.xs[i]; s.pys[i] = s.ys[i]
        s.xs[i] = s.targetX; s.ys[i] = s.targetY
      }
      return moved
    }
    const constrain = () => {
      for (let k = 0; k < ITERATIONS; k++) {
        for (let i = 0; i < LINKS; i++) relax(s, i, i + 1, LINK, false)
        for (let i = 0; i + 2 <= LINKS; i++) relax(s, i, i + 2, BEND_MIN, true)
      }
    }
    const tick = (now) => {
      s.raf = 0
      s.carry += s.last ? Math.min((now - s.last) / 1000, 0.05) : STEP
      s.last = now
      let moved = 0
      while (s.carry >= STEP) { moved = Math.max(moved, integrate()); constrain(); s.carry -= STEP }
      draw()
      s.still = moved < REST_EPSILON ? s.still + 1 : 0
      if (s.held > 0 || s.still < REST_STEPS) s.raf = requestAnimationFrame(tick)
      else s.last = 0
    }
    wakeRef.current = () => { s.still = 0; if (!s.raf) s.raf = requestAnimationFrame(tick) }
    draw()
    return () => cancelAnimationFrame(s.raf)
  }, [])

  const wake = useCallback(() => wakeRef.current(), [])

  const localPoint = (e) => {
    const r = svgRef.current?.getBoundingClientRect()
    return r ? { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H } : { x: 0, y: 0 }
  }
  // The hand can pull the cord a little past its length, with growing resistance, but never off the anchor.
  const reach = (index, x, y) => {
    const dx = x - ANCHOR.x, dy = y - ANCHOR.y
    const dist = Math.hypot(dx, dy) || 0.0001
    const length = index * LINK
    if (dist <= length) return { x, y, pull: 0 }
    const allowed = length + damp(dist - length, MAX_STRETCH)
    return { x: ANCHOR.x + (dx / dist) * allowed, y: ANCHOR.y + (dy / dist) * allowed, pull: dy > 0 ? (allowed - length) * (dy / dist) : 0 }
  }

  const onDown = (e) => {
    const s = sim.current
    if (s.held > 0) return
    if (e.pointerType === "mouse" && e.button !== 0) return
    e.preventDefault()
    const p = localPoint(e)
    let nearest = LINKS, best = Infinity
    for (let i = 1; i <= LINKS; i++) {
      const d = Math.hypot(s.xs[i] - p.x, s.ys[i] - p.y)
      if (d < best) { best = d; nearest = i }
    }
    svgRef.current?.setPointerCapture(e.pointerId)
    s.held = nearest; s.targetX = s.xs[nearest]; s.targetY = s.ys[nearest]; s.armed = true
    setGrabbing(true)
    wake()
  }
  const onMove = (e) => {
    const s = sim.current
    if (s.held < 0) return
    const p = localPoint(e)
    const t = reach(s.held, p.x, p.y)
    s.targetX = t.x; s.targetY = t.y
    // The switch clicks once per pull, as soon as the cord is pulled far enough, and re-arms when it eases back.
    if (s.armed && t.pull > CLICK_PULL) { s.armed = false; haptic(); latest.current.onChange(!latest.current.checked) }
    else if (!s.armed && t.pull < CLICK_PULL * 0.4) s.armed = true
    wake()
  }
  const onUp = () => {
    const s = sim.current
    if (s.held < 0) return
    s.held = -1
    setGrabbing(false)
    if (s.reduce) {                // no swinging back: the cord drops straight to rest
      s.xs.set(REST.xs); s.ys.set(REST.ys); s.pxs.set(REST.xs); s.pys.set(REST.ys)
      cordRef.current?.setAttribute("d", REST_PATH); hitRef.current?.setAttribute("d", REST_PATH)
      beadRef.current?.setAttribute("transform", `translate(${ANCHOR.x} ${ANCHOR.y + LINKS * LINK})`)
      return
    }
    wake()
  }
  const onKeyToggle = () => {
    latest.current.onChange(!latest.current.checked)
    const s = sim.current
    if (!s.reduce) { s.pys[LINKS] = s.ys[LINKS] - 5; wake() }   // a small tug, so the cord answers the key too
  }

  const glow = checked ? "#fdcf51" : "#4f6367"
  return (
    <div style={{ position: "relative", width: W, height: H, flexShrink: 0 }}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true"
        onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onLostPointerCapture={onUp}
        style={{ display: "block", touchAction: "none", cursor: grabbing ? "grabbing" : "default", overflow: "visible" }}>
        {/* the wooden rod it all hangs from, and the wire down to the lamp */}
        <rect x="6" y="0" width={W - 12} height="8" fill="#7a5a40" stroke={INK} strokeWidth="3" shapeRendering="crispEdges" />
        <rect x="58" y="8" width="4" height="10" fill={INK} shapeRendering="crispEdges" />
        {/* the lamp: a stepped pixel shade */}
        <g shapeRendering="crispEdges" stroke={INK} strokeWidth="3">
          <rect x="52" y="16" width="16" height="6" fill="#d66b1b" />
          <rect x="44" y="22" width="32" height="6" fill="#d66b1b" />
          <rect x="36" y="28" width="48" height="8" fill="#fa8f0b" />
          <rect x="30" y="36" width="60" height="8" fill="#fdcf51" />
        </g>
        {/* the bulb: lit gold with a halo when the switch is on */}
        {checked && <rect x="40" y="46" width="40" height="20" fill="#fdcf51" opacity=".22" style={{ filter: "blur(3px)" }} />}
        <rect x="52" y="44" width="16" height="12" fill={glow} stroke={INK} strokeWidth="3" shapeRendering="crispEdges" style={{ transition: "fill .25s" }} />
        {checked && <rect x="56" y="47" width="5" height="3" fill="#fff" opacity=".8" shapeRendering="crispEdges" />}

        <path ref={cordRef} d={REST_PATH} fill="none" stroke={INK} strokeWidth="3" strokeLinecap="square" />
        <path ref={hitRef} d={REST_PATH} fill="none" stroke="transparent" strokeWidth="22" pointerEvents="stroke"
          onPointerDown={onDown} style={{ cursor: grabbing ? "grabbing" : "grab" }} />
        {/* the pull: a little playing card */}
        <g ref={beadRef} transform={`translate(${ANCHOR.x} ${ANCHOR.y + LINKS * LINK})`} onPointerDown={onDown} style={{ cursor: grabbing ? "grabbing" : "grab" }}>
          <circle r="20" fill="transparent" />
          {focused && <rect x="-11" y="-2" width="22" height="30" rx="4" fill="none" stroke="var(--gold)" strokeWidth="2.5" />}
          <rect x="-7" y="1" width="14" height="20" rx="2" fill="#f8f4ec" stroke={INK} strokeWidth="2.5" />
          <rect x="-4" y="5" width="8" height="8" fill={checked ? "#fd5f55" : "#3d4d51"} shapeRendering="crispEdges" style={{ transition: "fill .25s" }} />
        </g>
      </svg>

      <button type="button" role="switch" aria-checked={checked} aria-label={label}
        onClick={onKeyToggle} onFocus={(e) => setFocused(e.currentTarget.matches(":focus-visible"))} onBlur={() => setFocused(false)}
        style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", opacity: 0 }} />
    </div>
  )
}
