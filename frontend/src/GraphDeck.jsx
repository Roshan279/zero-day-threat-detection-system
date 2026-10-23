import { useCallback, useEffect, useRef, useState } from "react"
import PxIcon from "./px/PxIcon"

// ─────────────────────────────────────────────────────────────
// GRAPH DECK: a pile of cards, one per chart. Drag or flick the top card away and it
// flies off, turns around and slips under the pile. Click the top card to open it.
// Arrow keys and the buttons below the pile do the same. The motion is a small spring
// simulation driven from one requestAnimationFrame loop that sleeps when everything has settled.
// ─────────────────────────────────────────────────────────────
const INK = "#1d2527"

// Resting pose of each slot: the top card sits straight, the ones beneath keep a fixed tilt.
const TILTS = [0, -2, 1.5, -1]
const SLOT_Y = 9
const SLOT_SCALE = 0.035
const MAX_SLOT = TILTS.length - 1

const MAX_DRAG_ROTATION = 18
// A release throws the card when it is this fast (px/ms) or this far (share of its width).
const THROW_VELOCITY = 0.5
const THROW_DISTANCE = 0.35
const TAP_SLOP = 5            // a tap that moves less than this opens the card instead of dragging it
const VELOCITY_WINDOW = 90    // release speed is measured over the last stretch of the gesture only

// Springs as stiffness / damping (per second)
const HOME = { k: 420, c: 30 }
const FLIGHT = { k: 150, c: 15 }
const RETURN = { k: 240, c: 26 }
const TOP_Z = 1000

const slotPose = (depth) => {
  const d = Math.min(depth, MAX_SLOT)
  return { x: 0, y: d * SLOT_Y, r: TILTS[d] ?? 0, s: 1 - d * SLOT_SCALE }
}
const lerpPose = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, r: a.r + (b.r - a.r) * t, s: a.s + (b.s - a.s) * t })
const poseTransform = ({ x, y, r, s }) => `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${r.toFixed(3)}deg) scale(${s.toFixed(4)})`

function makeBody(depth) {
  const pose = slotPose(depth)
  return { ...pose, vx: 0, vy: 0, vr: 0, vs: 0, phase: "rest", out: pose, dx: 1, dy: 0, z: null, apexZ: null }
}

function springAxis(value, velocity, target, spring, dt) {
  const v = velocity + (-spring.k * (value - target) - spring.c * velocity) * dt
  return [value + v * dt, v]
}

function stepBody(body, target, dt) {
  const spring = body.phase === "out" ? FLIGHT : body.phase === "return" ? RETURN : HOME
  const steps = Math.max(1, Math.ceil(dt * 240))   // sub-step so a stiff spring stays stable on a slow frame
  const h = dt / steps
  for (let i = 0; i < steps; i++) {
    [body.x, body.vx] = springAxis(body.x, body.vx, target.x, spring, h);
    [body.y, body.vy] = springAxis(body.y, body.vy, target.y, spring, h);
    [body.r, body.vr] = springAxis(body.r, body.vr, target.r, spring, h);
    [body.s, body.vs] = springAxis(body.s, body.vs, target.s, spring, h)
  }
}

const isSettled = (b, t) =>
  Math.abs(b.x - t.x) < 0.1 && Math.abs(b.y - t.y) < 0.1 && Math.abs(b.r - t.r) < 0.02 && Math.abs(b.s - t.s) < 0.0005 &&
  Math.abs(b.vx) + Math.abs(b.vy) < 2 && Math.abs(b.vr) < 1 && Math.abs(b.vs) < 0.01

// Distance along (ux, uy) at which a w x h card no longer covers the deck
function clearance(w, h, ux, uy) {
  const along = Math.min(ux === 0 ? Infinity : w / Math.abs(ux), uy === 0 ? Infinity : h / Math.abs(uy))
  return along + 24
}

function releaseVelocity(samples) {
  const last = samples[samples.length - 1]
  const first = samples.find(s => last && last.t - s.t <= VELOCITY_WINDOW)
  if (!first || !last || last.t - first.t < 8) return { vx: 0, vy: 0 }
  const dt = last.t - first.t
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt }
}

const stateOf = (phase) => (phase === "drag" ? "drag" : phase === "rest" ? "rest" : "fly")
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

// cards: [{ id, title, rank, suit, icon, color, stat, caption }]
export default function GraphDeck({ cards, onOpen }) {
  const count = cards.length
  const [order, setOrder] = useState(() => cards.map((_, i) => i))
  const orderRef = useRef(order)
  const bodies = useRef(cards.map((_, i) => makeBody(i)))
  const nodes = useRef([])
  const drag = useRef(null)
  const progress = useRef(0)       // 0..1: how close the current drag is to a throw; the card beneath rises to meet it
  const raf = useRef(0)
  const tickRef = useRef(() => {})
  const last = useRef(0)
  const suppressClick = useRef(false)
  const focusTop = useRef(false)

  const write = useCallback((index, depth) => {
    const node = nodes.current[index], body = bodies.current[index]
    if (!node || !body) return
    node.style.transform = poseTransform(body)
    node.style.zIndex = String(body.z ?? orderRef.current.length - depth)
    const st = stateOf(body.phase)
    if (node.dataset.state !== st) node.dataset.state = st
  }, [])

  const targetFor = useCallback((body, depth) => {
    if (body.phase === "out") return body.out
    const pose = slotPose(depth)
    if (depth > 0 && progress.current > 0) return lerpPose(pose, slotPose(depth - 1), progress.current * 0.6)
    return pose
  }, [])

  const advance = useCallback((index, depth, dt) => {
    const body = bodies.current[index]
    if (!body) return false
    if (body.phase === "drag") { write(index, depth); return true }
    const reduced = reducedMotion()
    if (reduced && body.phase === "out") { body.phase = "rest"; body.z = null }
    const target = targetFor(body, depth)
    if (reduced) Object.assign(body, target, { vx: 0, vy: 0, vr: 0, vs: 0 })
    else stepBody(body, target, dt)
    // Top of the arc: the card stops travelling outward, swaps layer while clear of the deck, and heads home.
    if (body.phase === "out" && body.vx * body.dx + body.vy * body.dy <= 0) { body.phase = "return"; body.z = body.apexZ }
    const settled = isSettled(body, target)
    if (settled && body.phase !== "out") { body.phase = "rest"; body.z = null }
    write(index, depth)
    return !settled
  }, [targetFor, write])

  const tick = useCallback((now) => {
    const dt = Math.min((now - last.current) / 1000, 1 / 30)
    last.current = now
    let active = false
    orderRef.current.forEach((index, depth) => { if (advance(index, depth, dt)) active = true })
    raf.current = active ? requestAnimationFrame((t) => tickRef.current(t)) : 0
  }, [advance])
  useEffect(() => { tickRef.current = tick }, [tick])

  const kick = useCallback(() => {
    if (raf.current) return
    last.current = performance.now()
    raf.current = requestAnimationFrame((t) => tickRef.current(t))
  }, [])

  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const commitOrder = useCallback((next) => { orderRef.current = next; setOrder(next); kick() }, [kick])

  // Send the top card flying along (vx, vy) px/ms; it comes back under the pile.
  const throwTop = useCallback((vx, vy, fx, fy) => {
    const cur = orderRef.current
    const index = cur[0]
    if (index === undefined || cur.length < 2) return
    const body = bodies.current[index], node = nodes.current[index]
    if (!body) return
    const speed = Math.hypot(vx, vy)
    const rawX = speed > 0.05 ? vx : fx, rawY = speed > 0.05 ? vy : fy
    const norm = Math.hypot(rawX, rawY) || 1
    const ux = rawX / norm, uy = rawY / norm
    const distance = clearance(node?.offsetWidth ?? 256, node?.offsetHeight ?? 320, ux, uy) + Math.min(speed * 50, 90)
    const launch = Math.max(speed, 0.9) * 1000
    body.phase = "out"; body.dx = ux; body.dy = uy
    body.out = { x: ux * distance, y: uy * distance, r: Math.max(-40, Math.min(40, body.r + ux * 26)), s: 1 }
    body.vx = ux * launch; body.vy = uy * launch; body.vr += ux * launch * 0.05
    body.z = TOP_Z; body.apexZ = null
    commitOrder([...cur.slice(1), index])
  }, [commitOrder])

  // The bottom card slips out to the left, swaps on top at its apex and lands as the new top card.
  const bringBack = useCallback(() => {
    const cur = orderRef.current
    const index = cur[cur.length - 1]
    if (index === undefined || cur.length < 2) return
    const body = bodies.current[index], node = nodes.current[index]
    if (!body) return
    const ux = -0.97, uy = -0.24
    const distance = clearance(node?.offsetWidth ?? 256, node?.offsetHeight ?? 320, ux, uy) + 20
    body.phase = "out"; body.dx = ux; body.dy = uy
    body.out = { x: ux * distance, y: uy * distance, r: -16, s: 1 }
    body.vx = ux * 1100; body.vy = uy * 1100
    body.z = 0; body.apexZ = TOP_Z - 1
    commitOrder([index, ...cur.slice(0, -1)])
  }, [commitOrder])

  const cycle = useCallback((dir) => { if (dir === 1) throwTop(1.3, -0.35, 1, 0); else bringBack() }, [throwTop, bringBack])

  // Keep keyboard focus on whichever card is now on top.
  useEffect(() => {
    if (!focusTop.current) return
    focusTop.current = false
    const t = order[0]
    if (t !== undefined) nodes.current[t]?.focus({ preventScroll: true })
  }, [order])

  const onDown = (e, index) => {
    suppressClick.current = false
    if (drag.current || orderRef.current[0] !== index) return
    if (e.pointerType === "mouse" && e.button !== 0) return
    const body = bodies.current[index]
    if (!body) return
    const node = e.currentTarget
    const rect = node.getBoundingClientRect()
    node.setPointerCapture(e.pointerId)
    drag.current = {
      pointerId: e.pointerId, index, startX: e.clientX, startY: e.clientY, baseX: body.x, baseY: body.y,
      width: node.offsetWidth, lever: e.clientY - rect.top < rect.height / 2 ? 1 : -1, moved: false,
      samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }],
    }
  }

  const onMove = (e) => {
    const cur = drag.current
    if (!cur || cur.pointerId !== e.pointerId) return
    const dx = e.clientX - cur.startX, dy = e.clientY - cur.startY
    if (!cur.moved) {
      if (Math.hypot(dx, dy) < TAP_SLOP) return
      // Touch: a mostly vertical swipe is a page scroll, so let go of the card and leave it to the browser.
      if (e.pointerType !== "mouse" && Math.abs(dy) > Math.abs(dx)) {
        drag.current = null
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        return
      }
    }
    const body = bodies.current[cur.index]
    if (!body) return
    cur.moved = true
    cur.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY })
    if (cur.samples.length > 24) cur.samples.shift()
    body.phase = "drag"
    body.x = cur.baseX + dx; body.y = cur.baseY + dy; body.s = 1
    // Pivot at the bottom edge: grabbing the top half swings the top out, the bottom half swings it the other way.
    body.r = Math.max(-1, Math.min(1, body.x / cur.width)) * MAX_DRAG_ROTATION * cur.lever
    body.vx = 0; body.vy = 0; body.vr = 0; body.vs = 0
    progress.current = Math.min(Math.hypot(body.x, body.y) / (cur.width * THROW_DISTANCE), 1)
    kick()
  }

  const onUp = (e, cancelled = false) => {
    const cur = drag.current
    if (!cur || cur.pointerId !== e.pointerId) return
    drag.current = null
    progress.current = 0
    const body = bodies.current[cur.index]
    if (!body || !cur.moved) { kick(); return }
    if (cancelled) { body.phase = "rest"; kick(); return }
    suppressClick.current = true
    const { vx, vy } = releaseVelocity(cur.samples)
    const speed = Math.hypot(vx, vy)
    const distance = Math.hypot(body.x, body.y)
    const heading = distance > 0 ? (vx * body.x + vy * body.y) / distance : 0   // a flick back toward the deck is a change of mind
    const fast = speed > THROW_VELOCITY && heading > -0.2
    const far = distance > cur.width * THROW_DISTANCE && heading > -0.3
    if (fast || far) { throwTop(vx, vy, body.x / (distance || 1), body.y / (distance || 1)); return }
    body.phase = "rest"                     // spring home, carrying the release velocity into the spring
    body.vx = vx * 1000; body.vy = vy * 1000
    body.vr = ((vx * 1000) / cur.width) * MAX_DRAG_ROTATION * cur.lever
    kick()
  }

  const onKey = (e, card) => {
    suppressClick.current = false
    if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); focusTop.current = true; cycle(1) }
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); focusTop.current = true; cycle(-1) }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(card.id) }
  }

  const topIndex = order[0] ?? 0

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "10px 0 6px" }}>
      <section aria-label="Chart cards. Drag a card away or use the arrow keys to cycle. Press Enter to open the top card."
        style={{ position: "relative", width: 320, height: 440, marginBottom: 64 }}>
        {cards.map((card, index) => {
          const isTop = order.indexOf(index) === 0
          const red = card.suit === "heart" || card.suit === "diamond"
          const col = red ? "#d6453d" : INK
          return (
            <div key={card.id} ref={(n) => { nodes.current[index] = n }}
              className="gd-card" data-state="rest" role="button" tabIndex={isTop ? 0 : -1} aria-hidden={!isTop}
              aria-label={`${card.title}. ${card.stat}. Open chart`}
              style={{ transform: poseTransform(slotPose(index)), zIndex: count - index, cursor: isTop ? undefined : "default", pointerEvents: isTop ? "auto" : "none" }}
              onClick={() => {
                if (suppressClick.current) { suppressClick.current = false; return }
                if (orderRef.current[0] === index) onOpen(card.id)
              }}
              onKeyDown={(e) => onKey(e, card)}
              onLostPointerCapture={(e) => onUp(e, true)}
              onPointerCancel={(e) => onUp(e, true)}
              onPointerDown={(e) => onDown(e, index)}
              onPointerMove={onMove}
              onPointerUp={(e) => onUp(e)}>
              <div className="gd-corner tl" style={{ color: col }}>
                <div className="gd-rank">{card.rank}</div>
                <PxIcon suit={card.suit} size={20} color={col} />
              </div>
              <div className="gd-corner br" style={{ color: col }}>
                <div className="gd-rank">{card.rank}</div>
                <PxIcon suit={card.suit} size={20} color={col} />
              </div>
              <div className="gd-mark" aria-hidden="true"><PxIcon suit={card.suit} size={150} color={col} /></div>
              <div className="gd-title pz-title">{card.title}</div>
              <div className="gd-art" style={{ "--c": card.color }}>
                <i className="gd-spark" style={{ left: "14%", top: "16%" }} />
                <i className="gd-spark" style={{ left: "82%", top: "26%", animationDelay: ".6s" }} />
                <i className="gd-spark" style={{ left: "70%", top: "78%", animationDelay: "1.2s" }} />
                <div className="gd-icon"><PxIcon name={card.icon} size={92} /></div>
                <div className="gd-stat">{card.stat}</div>
              </div>
              <div className="gd-foot">
                <div>{card.caption}</div>
                <span className="gd-hint">click to open</span>
              </div>
            </div>
          )
        })}
      </section>

      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button className="pz-btn gray small" aria-label="Previous card" onClick={() => cycle(-1)}>&lsaquo;</button>
        <span style={{ fontSize: 20, minWidth: 70, textAlign: "center" }} aria-live="polite">
          <b>{String(topIndex + 1).padStart(2, "0")}</b> / {String(count).padStart(2, "0")}
        </span>
        <button className="pz-btn gray small" aria-label="Next card" onClick={() => cycle(1)}>&rsaquo;</button>
      </div>
      <div style={{ fontSize: 15, color: "#9fb4b2", marginTop: 8 }}>drag or flick the top card away. click it to open the chart.</div>
    </div>
  )
}

export const DECK_CSS = `
.gd-card { position: absolute; inset: 0; transform-origin: bottom; touch-action: pan-y; user-select: none; will-change: transform; outline: none; overflow: hidden;
  color: ${INK}; border: 5px solid ${INK}; border-radius: 18px; padding: 14px 16px; display: flex; flex-direction: column; align-items: center; gap: 10px;
  background: radial-gradient(circle at 50% 38%, #fffaf0 0, var(--paper) 62%, #e6dcc6 100%);
  box-shadow: 0 8px 0 rgba(0,0,0,.38), inset 0 0 0 3px rgba(255,255,255,.55); transition: box-shadow .2s; }
.gd-card::before { content: ""; position: absolute; inset: 7px; border: 2px dashed rgba(29,37,39,.28); border-radius: 12px; pointer-events: none; }
.gd-card[tabindex="0"]::after { content: ""; position: absolute; inset: -40% -60%; pointer-events: none;
  background: linear-gradient(105deg, transparent 42%, rgba(255,255,255,.55) 50%, transparent 58%); animation: gd-shine 3.6s steps(18) infinite; }
@keyframes gd-shine { 0%, 55% { transform: translateX(-60%) } 100% { transform: translateX(60%) } }
.gd-card[tabindex="0"] { cursor: grab; }
.gd-card[data-state="drag"] { cursor: grabbing; box-shadow: 0 26px 0 rgba(0,0,0,.28), inset 0 0 0 3px rgba(255,255,255,.55); }
.gd-card[data-state="fly"] { box-shadow: 0 26px 0 rgba(0,0,0,.28), inset 0 0 0 3px rgba(255,255,255,.55); }
.gd-card:focus-visible { box-shadow: 0 0 0 5px var(--gold), 0 8px 0 rgba(0,0,0,.38); }
.gd-corner { position: absolute; display: flex; flex-direction: column; align-items: center; line-height: 1; z-index: 2; }
.gd-corner.tl { left: 14px; top: 12px; }
.gd-corner.br { right: 14px; bottom: 12px; transform: rotate(180deg); }
.gd-rank { font-family: var(--pxfont); font-size: 34px; font-weight: 700; }
.gd-mark { position: absolute; left: 50%; top: 52%; transform: translate(-50%, -50%); opacity: .07; pointer-events: none; }
.gd-title { height: 66px; flex: none; display: flex; align-items: center; justify-content: center; font-size: 28px; line-height: 1; text-shadow: none; color: ${INK}; text-align: center; padding: 0 56px; z-index: 1; }
.gd-art { position: relative; flex: 1; min-height: 0; width: 100%; margin: 0; border: 4px solid ${INK}; border-radius: 12px; overflow: hidden; z-index: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  background: radial-gradient(circle at 50% 30%, rgba(255,255,255,.4), transparent 60%), repeating-linear-gradient(45deg, rgba(255,255,255,.14) 0 8px, transparent 8px 16px), var(--c);
  box-shadow: inset 0 -10px 0 rgba(0,0,0,.18), inset 0 4px 0 rgba(255,255,255,.3); }
.gd-icon { filter: drop-shadow(0 5px 0 rgba(0,0,0,.35)); animation: gd-bob 2.4s steps(4) infinite; }
@keyframes gd-bob { 0%, 100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }
.gd-stat { font-family: var(--pxfont); font-size: 46px; line-height: 1; color: #fff; text-align: center; padding: 0 12px; overflow-wrap: anywhere;
  text-shadow: 0 4px 0 ${INK}, 3px 0 0 ${INK}, -3px 0 0 ${INK}, 0 -3px 0 ${INK}; }
.gd-spark { position: absolute; width: 8px; height: 8px; background: #fff; box-shadow: 0 0 0 2px ${INK}; animation: gd-twinkle 1.8s steps(2) infinite; }
@keyframes gd-twinkle { 0%, 100% { opacity: 1; transform: scale(1) } 50% { opacity: .25; transform: scale(.6) } }
.gd-foot { z-index: 1; text-align: center; font-size: 18px; line-height: 1.1; color: #4a5a59; padding: 0 56px; height: 66px; flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.gd-hint { display: inline-block; margin-top: 6px; font-size: 14px; padding: 1px 10px; border: 2px solid ${INK}; border-radius: 99px; background: var(--gold); color: ${INK}; }
@media (prefers-reduced-motion: reduce) { .gd-card::after, .gd-icon, .gd-spark { animation: none } }
`
