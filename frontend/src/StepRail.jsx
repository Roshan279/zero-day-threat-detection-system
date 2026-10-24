import { useEffect, useRef, useState } from "react"
import PxIcon from "./px/PxIcon"

// ─────────────────────────────────────────────────────────────
// STEP RAIL: the "how it works" steps as a rail of playing cards you can flick.
// Release velocity projects an end point, a spring snaps to the nearest card, and the ends rubber-band.
// Where the browser supports scroll-driven animations the cards tilt in depth (cover-flow) as they pass
// the middle; otherwise they sit flat. Arrow buttons and the arrow keys step one card.
// ─────────────────────────────────────────────────────────────
const STIFFNESS = 170
const DAMPING = 26              // about 2 * sqrt(170): critically damped, so no bounce at the card
const DECELERATION = 0.997      // a normal scroll view's rate, per ms
const DRAG_THRESHOLD = 4
const CARD_W = 196

// One card per step: its rank, suit, sprite and tint
const DECK = [
  { rank: "A", suit: "spade", icon: "scroll", tint: "#fdcf51" },
  { rank: "K", suit: "heart", icon: "ml", tint: "#fa8f0b" },
  { rank: "Q", suit: "diamond", icon: "lock", tint: "#56a786" },
  { rank: "J", suit: "club", icon: "eye", tint: "#009cfd" },
  { rank: "10", suit: "spade", icon: "wall", tint: "#fd5f55" },
]

// What each step does in a little more detail, and the tab where you can see it
const MORE = [
  { text: "Reads the Windows Event Log, or journald on Linux and the unified log on macOS, as events happen. New events reach the database within about a second.", go: "dashboard", goLabel: "Open Events" },
  { text: "An Isolation Forest and a KMeans model score every event from 0 to 100% and sort it into a threat level. The ML SCORES tab shows which signals drove each score.", go: "features", goLabel: "Open ML scores" },
  { text: "Each event's hash includes the one before it, like a ledger. Change or delete a record and every hash after it stops matching, so tampering shows. The CHAIN box in the left panel says OK or BROKEN." },
  { text: "Pick cards and press Investigate, or ask Luffy. He explains what happened in plain words and points to the evidence behind it.", go: "luffy", goLabel: "Ask Luffy" },
  { text: "Block an account or an IP, but only after you approve it. Nothing runs on its own. The Response tab shows what each threat level would do.", go: "response", goLabel: "Open Response" },
]

const rubber = (over, size) => Math.sign(over) * (1 - 1 / ((Math.abs(over) * 0.55) / size + 1)) * size
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const maxScroll = (el) => el.scrollWidth - el.clientWidth

const snapPoints = (scroller, track) => {
  const max = maxScroll(scroller)
  return Array.from(track.children, (child) => clamp(track.offsetLeft + child.offsetLeft + child.offsetWidth / 2 - scroller.clientWidth / 2, 0, max))
}
const nearestIndex = (points, pos) => {
  let best = 0
  for (let i = 1; i < points.length; i++) if (Math.abs(points[i] - pos) < Math.abs(points[best] - pos)) best = i
  return best
}
// Release velocity in px/ms from the last 100ms of samples; a pause before letting go means no flick.
const releaseVelocity = (samples, now) => {
  const first = samples[0], last = samples[samples.length - 1] || first
  const dt = last.t - first.t
  if (dt <= 0 || now - last.t > 60) return 0
  return -(last.x - first.x) / dt
}

function useMomentumRail(scrollerRef, trackRef, onIndex) {
  const state = useRef({ mode: "idle", pointerId: -1, startX: 0, startPos: 0, pos: 0, vel: 0, target: 0, samples: [], raf: 0, last: 0, suppressClick: false, caught: false })
  const onIndexRef = useRef(onIndex)
  const api = useRef({ goTo: () => {}, currentIndex: () => 0 })
  useEffect(() => { onIndexRef.current = onIndex }, [onIndex])

  useEffect(() => {
    const scroller = scrollerRef.current, track = trackRef.current
    if (!scroller || !track) return
    const s = state.current
    let scrollRaf = 0

    // The in-range part scrolls natively, the rest becomes a damped translate on the track (the rubber band).
    const apply = (pos) => {
      const inRange = clamp(pos, 0, maxScroll(scroller))
      scroller.scrollLeft = inRange
      const over = pos - inRange
      track.style.transform = Math.abs(over) > 0.1 ? `translate3d(${(-rubber(over, scroller.clientWidth)).toFixed(2)}px,0,0)` : ""
    }
    const setFree = (free) => { scroller.dataset.free = String(free) }   // native scroll snap is off while JS owns the position

    const step = (now) => {
      const dt = Math.min((now - s.last) / 1000, 1 / 30)
      s.last = now
      const h = dt / 4
      for (let i = 0; i < 4; i++) {          // semi-implicit Euler substeps keep the spring stable at any frame rate
        s.vel += (-STIFFNESS * (s.pos - s.target) - DAMPING * s.vel) * h
        s.pos += s.vel * h
      }
      if (Math.abs(s.pos - s.target) < 0.5 && Math.abs(s.vel) < 8) {
        s.pos = s.target; s.vel = 0; s.mode = "idle"
        apply(s.target); setFree(false)
        return
      }
      apply(s.pos)
      s.raf = requestAnimationFrame(step)
    }

    const springTo = (target, velocity) => {
      cancelAnimationFrame(s.raf)
      if (s.mode === "idle") s.pos = scroller.scrollLeft
      s.target = target
      s.vel = velocity
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        s.mode = "idle"; s.pos = target
        apply(target); setFree(false)
        return
      }
      s.mode = "spring"
      setFree(true)
      s.last = performance.now()
      s.raf = requestAnimationFrame(step)
    }

    const goTo = (index) => {
      const points = snapPoints(scroller, track)
      springTo(points[clamp(index, 0, points.length - 1)], s.mode === "spring" ? s.vel : 0)
    }
    const currentIndex = () => nearestIndex(snapPoints(scroller, track), s.mode === "spring" ? s.target : scroller.scrollLeft)
    api.current = { goTo, currentIndex }

    const onScroll = () => {
      cancelAnimationFrame(scrollRaf)
      scrollRaf = requestAnimationFrame(() => onIndexRef.current(nearestIndex(snapPoints(scroller, track), scroller.scrollLeft)))
    }
    const suppressNextClick = () => { s.suppressClick = true; setTimeout(() => { s.suppressClick = false }, 0) }

    const onPointerDown = (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return
      if (e.target.closest("button")) return
      cancelAnimationFrame(s.raf)
      s.caught = s.mode === "spring"          // catching a moving rail keeps its virtual position, overshoot included
      s.pos = s.caught ? s.pos : scroller.scrollLeft
      s.mode = "pressing"
      s.pointerId = e.pointerId
      s.startX = e.clientX
      s.startPos = s.pos
      s.samples = [{ t: e.timeStamp, x: e.clientX }]
    }
    const onPointerMove = (e) => {
      if (e.pointerId !== s.pointerId) return
      const dx = e.clientX - s.startX
      if (s.mode === "pressing" && Math.abs(dx) > DRAG_THRESHOLD) {
        s.mode = "dragging"
        scroller.setPointerCapture(e.pointerId)
        scroller.dataset.dragging = "true"
        setFree(true)
      }
      if (s.mode !== "dragging") return
      s.pos = s.startPos - dx
      apply(s.pos)
      s.samples.push({ t: e.timeStamp, x: e.clientX })
      while (s.samples.length > 2 && e.timeStamp - s.samples[0].t > 100) s.samples.shift()
    }
    const onRelease = (e) => {
      if (e.pointerId !== s.pointerId) return
      s.pointerId = -1
      if (s.mode !== "dragging") {
        if (s.caught) {                       // a rail caught mid-flight settles on the nearest card instead of freezing
          suppressNextClick()
          const points = snapPoints(scroller, track)
          springTo(points[nearestIndex(points, s.pos)], 0)
          return
        }
        s.mode = "idle"
        setFree(false)
        return
      }
      scroller.dataset.dragging = "false"
      suppressNextClick()
      const v = releaseVelocity(s.samples, e.timeStamp)
      const projected = s.pos + (v * DECELERATION) / (1 - DECELERATION)
      const points = snapPoints(scroller, track)
      springTo(points[nearestIndex(points, projected)], v * 1000)
    }
    const onClickCapture = (e) => { if (s.suppressClick) { e.preventDefault(); e.stopPropagation(); s.suppressClick = false } }
    const onNativeInput = () => {             // wheel or touch takes over from a running spring
      if (s.mode !== "spring") return
      cancelAnimationFrame(s.raf)
      s.mode = "idle"
      apply(clamp(s.pos, 0, maxScroll(scroller)))
      setFree(false)
    }
    const onKeyDown = (e) => {
      if (e.target !== scroller) return
      const i = currentIndex()
      const next = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: track.children.length - 1 }[e.key]
      if (next === undefined) return
      e.preventDefault()
      goTo(next)
    }

    scroller.addEventListener("keydown", onKeyDown)
    scroller.addEventListener("scroll", onScroll, { passive: true })
    scroller.addEventListener("pointerdown", onPointerDown)
    scroller.addEventListener("pointermove", onPointerMove)
    scroller.addEventListener("pointerup", onRelease)
    scroller.addEventListener("pointercancel", onRelease)
    scroller.addEventListener("lostpointercapture", onRelease)
    scroller.addEventListener("click", onClickCapture, true)
    scroller.addEventListener("wheel", onNativeInput, { passive: true })
    scroller.addEventListener("touchstart", onNativeInput, { passive: true })
    return () => {
      cancelAnimationFrame(scrollRaf); cancelAnimationFrame(s.raf)
      scroller.removeEventListener("keydown", onKeyDown)
      scroller.removeEventListener("scroll", onScroll)
      scroller.removeEventListener("pointerdown", onPointerDown)
      scroller.removeEventListener("pointermove", onPointerMove)
      scroller.removeEventListener("pointerup", onRelease)
      scroller.removeEventListener("pointercancel", onRelease)
      scroller.removeEventListener("lostpointercapture", onRelease)
      scroller.removeEventListener("click", onClickCapture, true)
      scroller.removeEventListener("wheel", onNativeInput)
      scroller.removeEventListener("touchstart", onNativeInput)
    }
  }, [scrollerRef, trackRef])

  return api
}

const RAIL_CSS = `
.sr-scroller { position: relative; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x mandatory; padding: 26px 0 30px; outline: none; scrollbar-width: none; cursor: grab; user-select: none; }
.sr-scroller::-webkit-scrollbar { display: none; }
.sr-scroller { -webkit-mask-image: linear-gradient(90deg, transparent 0, transparent 5%, #000 28%, #000 72%, transparent 95%, transparent 100%); mask-image: linear-gradient(90deg, transparent 0, transparent 5%, #000 28%, #000 72%, transparent 95%, transparent 100%); }
.sr-scroller[data-dragging="true"] { cursor: grabbing; }
.sr-scroller[data-free="true"] { scroll-snap-type: none; }
.sr-scroller:focus-visible { outline: 3px solid var(--gold); outline-offset: -3px; }
.sr-track { position: relative; display: flex; gap: 18px; width: max-content; list-style: none; padding: 0 calc(50% - ${CARD_W / 2}px); }
.sr-item { flex: none; width: ${CARD_W}px; scroll-snap-align: center; }
.sr-card { position: relative; height: 262px; background: #f8f4ec; color: var(--ink); border: 2px solid #b4aea0; border-radius: 15px; box-shadow: 0 6px 0 rgba(0,0,0,.34); }
.sr-corner { position: absolute; display: flex; flex-direction: column; align-items: center; line-height: 1; z-index: 2; }
.sr-corner.tl { left: 9px; top: 7px; } .sr-corner.br { right: 9px; bottom: 7px; transform: rotate(180deg); }
.sr-rank { font-family: var(--pxfont); font-size: 32px; font-weight: 700; }
.sr-frame { position: absolute; left: 40px; right: 40px; top: 12px; height: 108px; display: flex; align-items: center; justify-content: center; border-radius: 6px;
  background: color-mix(in srgb, var(--tint) 28%, #f8f4ec); border: 2px solid color-mix(in srgb, var(--tint) 60%, #f8f4ec); }
.sr-step { position: absolute; left: 16px; right: 16px; top: 128px; font-size: 14px; letter-spacing: .14em; color: #7a7466; text-align: center; }
.sr-title { position: absolute; left: 16px; right: 16px; top: 143px; font-family: var(--pxfont); font-size: 25px; line-height: 1; text-align: center; font-weight: 700; }
.sr-text { position: absolute; left: 16px; right: 48px; top: 176px; font-size: 16px; line-height: 1.15; color: #3e4d4b; text-align: left; }
.sr-card { transition: translate .2s, outline-color .2s; outline: 3px solid transparent; outline-offset: 1px; cursor: pointer; }
.sr-card.lifted { translate: 0 -26px; outline-color: var(--gold); box-shadow: 0 20px 0 rgba(0,0,0,.28); }
@media (prefers-reduced-motion: reduce) { .sr-card { transition: none; } }
@keyframes sr-tilt {
  0% { transform: perspective(900px) translateZ(-150px) rotateY(-14deg); }
  50% { transform: perspective(900px) translateZ(0) rotateY(0deg); }
  100% { transform: perspective(900px) translateZ(-150px) rotateY(14deg); }
}
@supports (animation-timeline: view()) {
  @media (prefers-reduced-motion: no-preference) {
    .sr-item .sr-card { animation: sr-tilt linear both; animation-timeline: view(inline); }
  }
}
`

export default function StepRail({ steps, label = "How it works", onGo }) {
  const wrapRef = useRef(null)
  const [open, setOpen] = useState(null)        // { index, x, y, width }: the card that is floating
  const toggleOpen = (index, el) => {
    if (open && open.index === index) { setOpen(null); return }
    const w = wrapRef.current.getBoundingClientRect(), r = el.getBoundingClientRect()
    setOpen({ index, x: r.left - w.left + r.width / 2, y: r.top - w.top, width: w.width })
  }
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === "Escape") setOpen(null) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
  const scrollerRef = useRef(null)
  const trackRef = useRef(null)
  const [active, setActive] = useState(0)
  const api = useMomentumRail(scrollerRef, trackRef, setActive)
  const step = (d) => api.current.goTo(api.current.currentIndex() + d)

  return (
    <section ref={wrapRef} aria-label={label} aria-roledescription="carousel" style={{ position: "relative" }}>
      <style>{RAIL_CSS}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0 0" }}>
        <div className="pz-label">{label}</div>
        <span style={{ marginLeft: "auto", fontSize: 17 }} aria-live="polite">
          <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden" }}>Card </span>
          {String(active + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
        </span>
        <button className="pz-btn gray small" aria-label="Previous" aria-disabled={active === 0} onClick={() => step(-1)}>&lsaquo;</button>
        <button className="pz-btn gray small" aria-label="Next" aria-disabled={active === steps.length - 1} onClick={() => step(1)}>&rsaquo;</button>
      </div>
      <div className="sr-scroller" ref={scrollerRef} tabIndex={0} aria-label={`${label}. Use the arrow keys to move.`}>
        <ul className="sr-track" ref={trackRef}>
          {steps.map(([n, title, text], i) => {
            const d = DECK[i % DECK.length]
            const red = d.suit === "heart" || d.suit === "diamond"
            const col = red ? "#c0443b" : "#1d2527"
            return (
              <li className="sr-item" key={n} onClick={(e) => toggleOpen(i, e.currentTarget)}>
                <div className={`sr-card ${open && open.index === i ? "lifted" : ""}`} style={{ "--tint": d.tint }} role="button" aria-pressed={!!open && open.index === i}>
                  <div className="sr-corner tl" style={{ color: col }}><span className="sr-rank">{d.rank}</span><PxIcon suit={d.suit} size={18} color={col} /></div>
                  <div className="sr-corner br" style={{ color: col }}><span className="sr-rank">{d.rank}</span><PxIcon suit={d.suit} size={18} color={col} /></div>
                  <div className="sr-frame"><PxIcon name={d.icon} size={72} /></div>
                  <div className="sr-step">STEP {n}</div>
                  <div className="sr-title">{title}</div>
                  <div className="sr-text">{text}</div>
                </div>
              </li>
            )
          })}
        </ul>
      </div>

      {open && (() => {
        const i = open.index, [n, title, text] = steps[i], d = DECK[i % DECK.length], more = MORE[i] || {}
        const red = d.suit === "heart" || d.suit === "diamond"
        const col = red ? "#c0443b" : "#1d2527"
        const W = 262
        return (
          <div className="pz-bounce-in" role="dialog" aria-label={`Step ${n}: ${title}`}
            style={{ position: "absolute", left: Math.max(0, Math.min(open.x - W / 2, open.width - W)), top: Math.max(-330, open.y - 300), width: W, zIndex: 80,
              background: "#f8f4ec", color: "var(--ink)", border: "2px solid #b4aea0", borderRadius: 16, boxShadow: "0 14px 0 rgba(0,0,0,.3)", padding: "10px 12px 12px", transform: "rotate(1.2deg)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ textAlign: "center", lineHeight: 1, color: col, fontWeight: 700, fontSize: 30 }}>
                {d.rank}
                <div style={{ display: "flex", justifyContent: "center" }}><PxIcon suit={d.suit} size={16} color={col} /></div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, letterSpacing: ".14em", color: "#7a7466" }}>STEP {n}</div>
                <div style={{ fontWeight: 700, fontSize: 24, lineHeight: 1 }}>{title}</div>
              </div>
              <div style={{ width: 54, height: 54, flex: "none", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6,
                background: `color-mix(in srgb, ${d.tint} 28%, #f8f4ec)`, border: `2px solid color-mix(in srgb, ${d.tint} 60%, #f8f4ec)` }}>
                <PxIcon name={d.icon} size={40} />
              </div>
              <button className="pz-btn red small" style={{ padding: "1px 7px", alignSelf: "flex-start" }} onClick={() => setOpen(null)} aria-label="Put the card back">X</button>
            </div>
            <div style={{ fontSize: 17, fontWeight: 600, lineHeight: 1.15, margin: "10px 0 6px" }}>{text}</div>
            <div style={{ fontSize: 15, lineHeight: 1.2, color: "#4a5a59", marginBottom: more.go ? 10 : 0 }}>{more.text}</div>
            {more.go && onGo && <button className="pz-btn gray small" style={{ width: "100%" }} onClick={() => onGo(more.go)}>{more.goLabel}</button>}
          </div>
        )
      })()}
    </section>
  )
}
