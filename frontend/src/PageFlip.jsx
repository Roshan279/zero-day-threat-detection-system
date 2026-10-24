import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

// ─────────────────────────────────────────────────────────────
// PAGE FLIP: a book whose pages you can turn by dragging a corner, tapping a page, or with the arrow keys.
// The first page is the cover, alone on the right; after that the pages come in pairs. On a narrow frame it
// shows one page at a time. The turn is real geometry: the fold is the line halfway between the corner's rest
// point and where the pointer has dragged it, the page keeps the spine side, and its back is mirrored across the fold.
// Pixel look: square corners, hard ink lines, flat paper colours, a stepped gutter and no soft shadows.
// ─────────────────────────────────────────────────────────────
const SINGLE_BELOW = 520        // below this frame width (px) the book shows one page at a time
const HIDDEN = Symbol("hidden")
const PEEK_ZONE = 64            // the pointer has to be within this of a corner (px) for the page to lift on hover
const PEEK_MAX = 34             // how far a hovered corner lifts toward the pointer, at most (px)
const DRAG_SLOP = 4             // pointer travel that turns a press into a drag (px)
const TURN = { duration: 0.6, ease: [0.32, 0.72, 0, 1] }
const SETTLE = { duration: 0.32, ease: [0.23, 1, 0.32, 1] }
const INK = "#1d2527"
const PAPER = "#f8f4ec"
const PAPER_BACK = "#e6dfd0"

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y })
const dot = (a, b) => a.x * b.x + a.y * b.y
const len = (a) => Math.hypot(a.x, a.y)
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

// A small tween with a cubic-bezier ease, driven by requestAnimationFrame
function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by
  const X = (t) => ((ax * t + bx) * t + cx) * t
  const Y = (t) => ((ay * t + by) * t + cy) * t
  return (x) => {
    let lo = 0, hi = 1, t = x
    for (let i = 0; i < 24; i++) { const v = X(t); if (Math.abs(v - x) < 1e-5) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2 }
    return Y(t)
  }
}
function tween({ duration, ease }, onUpdate, onComplete) {
  const f = bezier(...ease)
  const t0 = performance.now()
  let raf = 0, done = false
  const frame = (now) => {
    const t = Math.min(1, (now - t0) / (duration * 1000))
    onUpdate(f(t))
    if (t < 1) raf = requestAnimationFrame(frame)
    else { done = true; onComplete() }
  }
  raf = requestAnimationFrame(frame)
  return { stop: () => { if (!done) cancelAnimationFrame(raf) } }
}

// Keeps a point within `radius` of `center`
function within(p, center, radius) {
  const d = sub(p, center), l = len(d)
  return l <= radius ? p : { x: center.x + (d.x / l) * radius, y: center.y + (d.y / l) * radius }
}

// The part of a polygon on one side of a line through m with normal n
function clipPolygon(poly, m, n, keepNegative) {
  const side = (p) => { const d = dot(sub(p, m), n); return keepNegative ? -d : d }
  const out = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const da = side(a), db = side(b)
    if (da >= 0) out.push(a)
    if (da >= 0 !== db >= 0) out.push(lerp(a, b, da / (da - db)))
  }
  return out
}
const polygon = (points, dx) => (points.length ? `polygon(${points.map(p => `${(p.x - dx).toFixed(2)}px ${p.y.toFixed(2)}px`).join(", ")})` : "polygon(0 0)")

// Where everything goes for a corner at `at`: the fold is the line halfway between the corner's rest and where it is now
function foldStyles(turn, w, h) {
  const x0 = turn.dir === 1 ? w : 0
  const page = [{ x: x0, y: 0 }, { x: x0 + w, y: 0 }, { x: x0 + w, y: h }, { x: x0, y: h }]
  const d = sub(turn.at, turn.corner), l = len(d)
  if (l < 0.5) return null
  const n = { x: d.x / l, y: d.y / l }
  const m = lerp(turn.corner, turn.at, 0.5)
  const front = clipPolygon(page, m, n, false)
  const flap = clipPolygon(page, m, n, true)
  // Reflection across the fold: X -> A X + b
  const a = 1 - 2 * n.x * n.x, bc = -2 * n.x * n.y, dd = 1 - 2 * n.y * n.y
  const k = 2 * dot(m, n), bx = k * n.x, by = k * n.y
  const e = a * x0 + bx - x0, f = bc * x0 + by
  return {
    front: { clipPath: polygon(front, x0) },
    flap: { clipPath: polygon(flap, x0), transform: `matrix(${a}, ${bc}, ${bc}, ${dd}, ${e}, ${f})` },
    progress: Math.min(1, l / (2 * w)),
  }
}

// Two pages open: the cover alone on the right, then pairs
function twoPages(pages, spread, dir) {
  const leftOf = (s) => (s > 0 ? pages[2 * s - 1] : undefined)
  const rightOf = (s) => pages[2 * s]
  if (!dir) return { left: leftOf(spread), right: rightOf(spread) }
  const target = spread + dir
  return dir === 1
    ? { left: leftOf(spread), right: rightOf(target), turning: rightOf(spread), back: leftOf(target) }
    : { left: leftOf(target), right: rightOf(spread), turning: leftOf(spread), back: rightOf(target) }
}
// One page at a time: a page turns off to the left with blank paper on its back, and turning back brings the previous page in
function onePage(pages, page, dir) {
  if (dir === 1) return { right: pages[page + 1], turning: pages[page], back: null }
  if (dir === -1) return { right: pages[page], back: pages[page - 1] ?? HIDDEN }
  return { right: pages[page] }
}
// How far to slide a closed book so its one page sits in the middle
const centerShift = ({ left, right }) => (left === undefined ? -0.25 : right === undefined ? 0.25 : 0)

export default function PageFlip({ pages, onSpreadChange, className }) {
  const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  const bookRef = useRef(null)
  const frameRef = useRef(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [single, setSingle] = useState(false)
  const singleRef = useRef(false)
  const [spread, setSpread] = useState(0)
  const [turn, setTurn] = useState(null)
  const [heading, setHeading] = useState(null)       // the spread a committed turn is heading for, so the book recentres with it
  const turnRef = useRef(null)
  const pressRef = useRef(null)
  const animRef = useRef(null)
  const playingRef = useRef(false)
  const committingRef = useRef(false)                // a turn that will finish on its own: presses wait for it
  const cbRef = useRef(onSpreadChange)
  useEffect(() => { cbRef.current = onSpreadChange }, [onSpreadChange])

  const spreads = single ? pages.length : Math.floor(pages.length / 2) + 1

  useLayoutEffect(() => {
    const book = bookRef.current, frame = frameRef.current
    if (!book || !frame) return
    const measure = () => {
      const narrow = frame.clientWidth < SINGLE_BELOW
      if (narrow !== singleRef.current) {
        singleRef.current = narrow
        setSingle(narrow)
        setSpread((s) => (narrow ? Math.max(0, 2 * s - 1) : Math.ceil(s / 2)))   // keep the same page in view when the layout changes
      }
      setSize({ w: book.clientWidth / 2, h: book.clientHeight })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(frame); ro.observe(book)
    return () => ro.disconnect()
  }, [])
  useEffect(() => () => animRef.current?.stop(), [])

  const stop = () => { animRef.current?.stop(); playingRef.current = false }
  const setAt = useCallback((next) => { turnRef.current = next; setTurn(next) }, [])

  // Keeps the corner where paper can reach: the page stays on its spine
  const reach = (p, corner) => {
    const { w, h } = size
    return within(within(p, { x: w, y: corner.y }, w), { x: w, y: corner.y === 0 ? h : 0 }, Math.hypot(w, h))
  }
  const cornerFor = (dir, y) => ({ x: dir === 1 ? 2 * size.w : 0, y: y < size.h / 2 ? 0 : size.h })

  // Runs the corner from where it is to `to`, lifting it on the way over
  const run = (from, to, complete) => {
    stop()
    const start = from.at
    const lift = complete ? size.h * 0.14 * (from.corner.y === 0 ? 1 : -1) : 0
    committingRef.current = complete
    const next = spread + from.dir
    if (complete) setHeading(next)
    playingRef.current = true
    animRef.current = tween(complete ? TURN : SETTLE, (t) => {
      const p = lerp(start, to, t)
      setAt({ ...from, at: { x: p.x, y: p.y + Math.sin(Math.PI * t) * lift } })
    }, () => {
      playingRef.current = false
      committingRef.current = false
      setAt(null)
      setHeading(null)
      if (complete) { setSpread(next); cbRef.current?.(next) }
    })
  }

  const canTurn = (dir) => (dir === 1 ? spread < spreads - 1 : spread > 0)

  const go = (dir) => {
    if (!canTurn(dir) || !size.w || committingRef.current) return
    if (reduceMotion) { setSpread(spread + dir); cbRef.current?.(spread + dir); return }
    const corner = cornerFor(dir, size.h)
    run({ dir, corner, at: { x: corner.x - dir, y: corner.y - 1 } }, { x: corner.x - dir * 2 * size.w, y: corner.y }, true)
  }

  const local = (e) => {
    const r = bookRef.current?.getBoundingClientRect()
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 }
  }

  const onPointerDown = (e) => {
    if (e.button !== 0 || !size.w || committingRef.current) return
    const p = local(e)
    const backZone = single && p.x < size.w * 1.3         // on one page, its left edge goes back and the rest turns forward
    const dir = p.x >= size.w && !backZone ? 1 : -1
    if (!canTurn(dir)) return
    if (reduceMotion) { go(dir); return }
    stop()
    e.currentTarget.setPointerCapture(e.pointerId)
    pressRef.current = { start: p, dragging: false }
    if (single && dir === -1) { pressRef.current = { start: p, dragging: false, back: true }; return }
    const cur = turnRef.current
    const corner = cur?.dir === dir ? cur.corner : cornerFor(dir, p.y)
    setAt({ dir, corner, at: cur?.dir === dir ? cur.at : corner })
  }

  // A corner near the pointer lifts a little, inviting the turn
  const peek = (p) => {
    const dir = p.x >= size.w ? 1 : -1
    const corner = cornerFor(dir, p.y)
    const near = canTurn(dir) && len(sub(p, corner)) < PEEK_ZONE
    const cur = turnRef.current
    if (!near) { if (cur) run(cur, cur.corner, false); return }
    stop()
    const toward = sub(p, corner)
    const l = Math.max(1, len(toward))
    const lift = Math.min(PEEK_MAX, l * 0.6 + 14)
    setAt({ dir, corner, at: reach({ x: corner.x + (toward.x / l) * lift, y: corner.y + (toward.y / l) * lift }, corner) })
  }

  const onPointerMove = (e) => {
    const p = local(e)
    const press = pressRef.current, cur = turnRef.current
    if (press?.back) { press.dragging ||= len(sub(p, press.start)) >= DRAG_SLOP; return }
    if (press && cur) {
      if (!press.dragging && len(sub(p, press.start)) < DRAG_SLOP) return
      press.dragging = true
      setAt({ ...cur, at: reach(p, cur.corner) })
      return
    }
    if (e.pointerType === "mouse" && !playingRef.current && !reduceMotion) peek(p)
  }

  const onPointerUp = () => {
    const press = pressRef.current, cur = turnRef.current
    pressRef.current = null
    if (press?.back) { if (!press.dragging) go(-1); return }
    if (!press || !cur) return
    // A tap turns the page; a drag turns it once the corner crosses the spine
    const crossed = cur.dir === 1 ? cur.at.x < size.w : cur.at.x > size.w
    const complete = press.dragging ? crossed : true
    run(cur, complete ? { x: cur.corner.x - cur.dir * 2 * size.w, y: cur.corner.y } : cur.corner, complete)
  }
  const onPointerLeave = () => {
    const cur = turnRef.current
    if (!pressRef.current && cur && !playingRef.current) run(cur, cur.corner, false)
  }
  const onKeyDown = (e) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); go(e.key === "ArrowRight" ? 1 : -1) }
  }

  const fold = turn && size.w ? foldStyles(turn, size.w, size.h) : null
  const { left, right, turning, back } = single ? onePage(pages, spread, turn?.dir) : twoPages(pages, spread, turn?.dir)
  const shift = single ? 0 : centerShift(twoPages(pages, heading ?? spread))   // a closed book sits centred: the cover alone, or the back alone
  const first = single ? spread + 1 : Math.max(1, 2 * spread)
  const last = single ? spread + 1 : Math.min(pages.length, 2 * spread + 1)

  return (
    <div ref={frameRef} className={className} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", overflowX: "clip" }}>
      <div style={{ flexShrink: 0, width: single ? "200%" : "100%", alignSelf: single ? "flex-start" : undefined,
        transform: `translateX(${single ? -50 : shift * 100}%)`, transition: single || reduceMotion ? "none" : "transform .5s cubic-bezier(.32,.72,0,1)" }}>
        <div ref={bookRef} onPointerCancel={onPointerUp} onPointerDown={onPointerDown} onPointerLeave={onPointerLeave} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          style={{ position: "relative", width: "100%", aspectRatio: "3 / 2", touchAction: "none", userSelect: "none" }}>
          {left !== undefined && <Paper side="left">{left}</Paper>}
          {right !== undefined && <Paper side="right">{right}</Paper>}
          {turn && fold && turning !== undefined && <Paper side={turn.dir === 1 ? "right" : "left"} style={fold.front}>{turning}</Paper>}
          {turn && !fold && turning !== undefined && <Paper side={turn.dir === 1 ? "right" : "left"}>{turning}</Paper>}
          {turn && fold && back !== undefined && back !== HIDDEN && (
            <div style={{ pointerEvents: "none", position: "absolute", inset: 0 }}>
              <Paper back side={turn.dir === 1 ? "right" : "left"} style={fold.flap}>{back}</Paper>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 12, fontSize: 18 }}>
        <button className="pz-btn gray small" aria-label="Previous page" aria-disabled={spread === 0 || undefined} onClick={spread === 0 ? undefined : () => go(-1)} onKeyDown={onKeyDown}>&lsaquo;</button>
        <span aria-live="polite" style={{ minWidth: 96, textAlign: "center" }}>{first === last ? first : `${first}-${last}`} of {pages.length}</span>
        <button className="pz-btn gray small" aria-label="Next page" aria-disabled={spread === spreads - 1 || undefined} onClick={spread === spreads - 1 ? undefined : () => go(1)} onKeyDown={onKeyDown}>&rsaquo;</button>
      </div>
    </div>
  )
}

// One sheet. Content is sized in cqw (a hundredth of the sheet's width) so a page scales whole.
function Paper({ side, back = false, style, children }) {
  return (
    <div style={{
      position: "absolute", top: 0, height: "100%", width: "50%", transformOrigin: "top left", overflow: "hidden", containerType: "inline-size",
      left: side === "left" ? 0 : "50%", background: back ? PAPER_BACK : PAPER, color: INK,
      borderTop: `3px solid ${INK}`, borderBottom: `3px solid ${INK}`, borderLeft: side === "left" ? `3px solid ${INK}` : 0, borderRight: side === "right" ? `3px solid ${INK}` : 0,
      boxSizing: "border-box", ...style,
    }}>
      <div style={{ width: "100%", height: "100%", transform: back ? "scaleX(-1)" : undefined }}>{children}</div>
      {/* the gutter: three stepped stripes where the paper meets the spine */}
      <span aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, [side === "left" ? "right" : "left"]: 0, width: "4%", pointerEvents: "none",
        background: `linear-gradient(${side === "left" ? "270deg" : "90deg"}, rgba(29,37,39,.28) 0 25%, rgba(29,37,39,.16) 25% 50%, rgba(29,37,39,.07) 50% 75%, transparent 75%)` }} />
    </div>
  )
}
