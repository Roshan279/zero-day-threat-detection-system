import { useEffect, useMemo, useRef, useState } from "react"
import PxIcon from "./px/PxIcon"
import { parseSource, useYouTube } from "./useYouTube"

// ─────────────────────────────────────────────────────────────
// JUKEBOX: a pixel record player backed by YouTube. Click the speaker in the right rail to open it.
//   - the record spins while music plays; grab it and turn it to scrub through the track
//   - paste any YouTube video, live stream or playlist link
//   - Mood DJ switches music with the case: a calm link normally, a tense link while a CRITICAL event is open
// The video screen has to stay on the page (YouTube's rules), so closing the panel only hides it.
// ─────────────────────────────────────────────────────────────
const INK = "#1d2527"
const CRUISE = 200            // deg/s: one turn per 1.8s, and 1 second of track per second of turning
const SCRUB_THROTTLE = 200    // ms between seeks while turning the disc
const PREFS_KEY = "jukebox_prefs_yt"
const MOOD_COLOR = { calm: "#56a786", tense: "#fd5f55" }

// Real, public streams as starting points. Replace them with anything you like inside the Jukebox.
const DEFAULT_CALM = import.meta.env.VITE_YT_CALM || "https://www.youtube.com/watch?v=jfKfPfyJRdk"
const DEFAULT_TENSE = import.meta.env.VITE_YT_TENSE || "https://www.youtube.com/watch?v=4xDzrJKXOOY"

const loadPrefs = () => {
  const base = { calm: DEFAULT_CALM, tense: DEFAULT_TENSE, dj: false }
  try { return { ...base, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") } } catch { return base }
}
const fmt = (s) => { const t = Math.max(0, Math.floor(s)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}` }
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

// The record, as a 36 x 36 pixel grid: grooves, a rim, a glossy streak, and an accent label with a notch
// so you can see it turn.
const N = 36, C = (N - 1) / 2
function buildDisc() {
  const rects = []
  for (let y = 0; y < N; y++) {
    let run = null
    for (let x = 0; x <= N; x++) {
      let color = null
      if (x < N) {
        const dx = x - C, dy = y - C, r = Math.hypot(dx, dy)
        if (r <= C + 0.4) {
          if (r <= 1.3) color = "#2a3638"
          else if (r <= 7.2) color = (dx >= 3 && dx <= 4.5 && dy >= -5 && dy <= -3) ? "#fff" : "var(--jb-accent)"
          else if (r > C - 1) color = "#0d1315"
          else {
            const streak = Math.abs(Math.atan2(dy, dx) + Math.PI / 4) < 0.28 && r > 9
            color = streak ? "#4a5f62" : Math.floor(r) % 2 ? "#232f31" : "#3d4d51"
          }
        }
      }
      if (run && run.color === color) { run.w++ } else {
        if (run && run.color) rects.push(run)
        run = { x, y, w: 1, color }
      }
    }
  }
  return rects
}

function Disc({ onDown, onMove, onUp, discRef, canScrub }) {
  const rects = useMemo(() => buildDisc(), [])
  return (
    <div ref={discRef} className="jb-disc" title={canScrub ? "Turn the record to scrub" : undefined}
      style={{ cursor: canScrub ? "grab" : "default" }}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onLostPointerCapture={onUp}>
      <svg viewBox={`0 0 ${N} ${N}`} width="112" height="112" shapeRendering="crispEdges" aria-hidden="true" style={{ display: "block", pointerEvents: "none" }}>
        {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height="1" fill={r.color} />)}
      </svg>
    </div>
  )
}

function Tonearm({ down }) {
  return (
    <svg viewBox="0 0 24 56" width="46" height="108" shapeRendering="crispEdges" aria-hidden="true"
      style={{ position: "absolute", right: -26, top: -8, pointerEvents: "none", transformOrigin: "75% 12%", transition: "transform .5s steps(6)", transform: `rotate(${down ? 10 : -14}deg)` }}>
      <rect x="15" y="1" width="9" height="9" fill={INK} /><rect x="16" y="2" width="7" height="7" fill="#dcdcdc" /><rect x="18" y="4" width="3" height="3" fill="#5e7977" />
      <rect x="18" y="10" width="3" height="32" fill={INK} /><rect x="19" y="10" width="1" height="32" fill="#b5e8f2" />
      <rect x="7" y="40" width="14" height="3" fill={INK} /><rect x="8" y="41" width="12" height="1" fill="#b5e8f2" />
      <rect x="3" y="40" width="7" height="12" fill={INK} /><rect x="4" y="41" width="5" height="10" fill="var(--jb-accent)" />
    </svg>
  )
}

export default function Jukebox({ mood = "calm" }) {
  const mount = useRef(null)
  const yt = useYouTube(mount)
  const [open, setOpen] = useState(false)
  const [prefs, setPrefs] = useState(loadPrefs)
  const [link, setLink] = useState("")
  const discRef = useRef(null)
  const eng = useRef({ angle: 0, omega: 0, raf: 0, last: 0, playing: false, drag: null, reduced: false, kick: null })
  const lastMood = useRef(null)

  const playing = yt.state === "playing"
  const accent = MOOD_COLOR[mood] || MOOD_COLOR.calm
  const canScrub = yt.ready && !yt.info.live && yt.duration > 0
  const pct = yt.duration > 0 ? clamp(yt.position / yt.duration, 0, 1) * 100 : 0

  const setPref = (patch) => setPrefs(p => {
    const n = { ...p, ...patch }
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(n)) } catch { /* private mode */ }
    return n
  })

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === "Escape") setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  // The record: one rAF loop, asleep unless something is moving. Speed eases toward 200 deg/s while playing, toward 0 when not.
  useEffect(() => {
    const e = eng.current
    e.reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    const tick = (now) => {
      const dt = Math.min((now - e.last) / 1000, 0.05)
      e.last = now
      if (!e.drag) {
        const target = e.playing && !e.reduced ? CRUISE : 0
        e.omega = target + (e.omega - target) * Math.exp(-dt / (e.playing ? 0.25 : 0.2))
        if (Math.abs(e.omega - target) < 2) e.omega = target
        e.angle += e.omega * dt
      }
      if (discRef.current) discRef.current.style.transform = `rotate(${(e.angle % 360).toFixed(2)}deg)`
      e.raf = e.playing || e.drag || e.omega !== 0 ? requestAnimationFrame(tick) : 0
    }
    e.kick = () => { if (!e.raf) { e.last = performance.now(); e.raf = requestAnimationFrame(tick) } }
    return () => { cancelAnimationFrame(e.raf); e.raf = 0; e.kick = null }
  }, [])
  useEffect(() => { eng.current.playing = playing; eng.current.kick?.() }, [playing])

  // Mood DJ: start the link for the current mood, once per change.
  const { ready, play } = yt
  useEffect(() => {
    if (!prefs.dj || !ready) { lastMood.current = null; return }
    if (lastMood.current === mood) return
    const url = mood === "tense" ? prefs.tense : prefs.calm
    if (!parseSource(url)) return
    lastMood.current = mood
    play(url)
  }, [prefs.dj, prefs.calm, prefs.tense, mood, ready, play])

  // ── turning the record ──
  const angleOf = (d, x, y) => Math.atan2(y - d.cy, x - d.cx) * 180 / Math.PI
  const onDiscDown = (ev) => {
    const e = eng.current
    if (!canScrub || ev.button !== 0 || e.drag) return
    const rect = discRef.current.getBoundingClientRect()
    const d = { id: ev.pointerId, cx: rect.left + rect.width / 2, cy: rect.top + rect.height / 2, deg: 0, from: yt.position, lastSeek: 0, target: yt.position }
    d.a = angleOf(d, ev.clientX, ev.clientY)
    e.drag = d
    e.omega = 0
    ev.currentTarget.setPointerCapture(ev.pointerId)
    yt.holdProgress(true)
    e.kick?.()
  }
  const onDiscMove = (ev) => {
    const e = eng.current, d = e.drag
    if (!d || d.id !== ev.pointerId) return
    const a = angleOf(d, ev.clientX, ev.clientY)
    let delta = a - d.a
    delta -= Math.round(delta / 360) * 360
    d.a = a
    e.angle += delta
    d.deg += delta
    d.target = clamp(d.from + d.deg / CRUISE, 0, yt.duration)
    const now = performance.now()
    if (now - d.lastSeek > SCRUB_THROTTLE) { d.lastSeek = now; yt.scrub(d.target, false) }
  }
  const onDiscUp = (ev) => {
    const e = eng.current, d = e.drag
    if (!d || d.id !== ev.pointerId) return
    e.drag = null
    yt.scrub(d.target, true)
    e.kick?.()
  }

  // ── seek bar ──
  const barRef = useRef(null)
  const barDrag = useRef(false)
  const seekTo = (clientX, final) => {
    const r = barRef.current.getBoundingClientRect()
    yt.scrub(clamp((clientX - r.left) / r.width, 0, 1) * yt.duration, final)
  }
  const onBarKey = (ev) => {
    if (!canScrub) return
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[ev.key]
    if (step === undefined) return
    ev.preventDefault()
    yt.scrub(clamp(yt.position + step, 0, yt.duration), true)
  }

  const startLink = () => { if (yt.play(link)) setLink("") }
  const status = !yt.ready ? "loading..." : yt.state === "buffering" ? "buffering..." : playing ? "playing" : yt.info.title ? "paused" : "ready"

  return (
    <>
      <style>{`
        .jb-root { --jb-accent: ${accent}; }
        .jb-disc { position: relative; width: 112px; height: 112px; border-radius: 50%; touch-action: none; user-select: none; border: 4px solid ${INK}; }
        .jb-disc:active { cursor: grabbing !important; }
        .jb-bars { display: inline-flex; gap: 3px; align-items: flex-end; height: 18px; }
        .jb-bars i { width: 4px; height: 4px; background: currentColor; animation: jb-eq .7s steps(4) infinite; animation-play-state: paused; }
        .jb-bars[data-on="true"] i { animation-play-state: running; }
        .jb-bars i:nth-child(2) { animation-delay: -.15s } .jb-bars i:nth-child(3) { animation-delay: -.3s } .jb-bars i:nth-child(4) { animation-delay: -.45s } .jb-bars i:nth-child(5) { animation-delay: -.6s }
        @keyframes jb-eq { 0%, 100% { height: 4px } 50% { height: 18px } }
        @media (prefers-reduced-motion: reduce) { .jb-bars i { animation: none !important; height: 10px } }
        .jb-range { -webkit-appearance: none; appearance: none; height: 12px; background: #2a3638; border: 3px solid ${INK}; border-radius: 4px; width: 100%; }
        .jb-range::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 18px; background: var(--gold); border: 3px solid ${INK}; }
        .jb-range::-moz-range-thumb { width: 8px; height: 14px; background: var(--gold); border: 3px solid ${INK}; border-radius: 0; }
        .jb-input { font: inherit; padding: 4px 8px; border: 3px solid ${INK}; border-radius: 6px; background: var(--paper); color: ${INK}; box-sizing: border-box; }
      `}</style>

      <div className="jb-root">
        <button className="pz-btn gold small" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label="Jukebox"
          title={playing ? `${yt.info.title}` : "Jukebox (YouTube)"}
          style={{ position: "fixed", right: 44, top: 420, zIndex: 60, padding: "8px 10px", display: "flex", alignItems: "center", gap: 8 }}>
          <PxIcon name="bolt" size={22} />
          <span className="jb-bars" data-on={playing} aria-hidden="true"><i /><i /><i /><i /><i /></span>
        </button>

        <div className="pz-panel" role="dialog" aria-label="Jukebox" aria-hidden={!open}
          style={{ position: "fixed", right: 160, top: "50%", translate: "0 -50%", zIndex: 61, width: 348, maxHeight: "92vh", overflowY: "auto", padding: 12,
            visibility: open ? "visible" : "hidden", pointerEvents: open ? "auto" : "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <span className="pz-title" style={{ fontSize: 22 }}>Jukebox</span>
            <span style={{ fontSize: 15, color: accent }}>{mood}</span>
            <span style={{ fontSize: 15, color: "#b5e8f2" }}>{status}</span>
            <button className="pz-btn gray small" style={{ marginLeft: "auto" }} aria-label="Close jukebox" onClick={() => setOpen(false)}>X</button>
          </div>

          {/* the record, the tonearm and what is on */}
          <div style={{ display: "flex", gap: 34, alignItems: "center", marginBottom: 12, padding: "6px 4px" }}>
            <div style={{ position: "relative", flexShrink: 0 }}>
              <Disc discRef={discRef} onDown={onDiscDown} onMove={onDiscMove} onUp={onDiscUp} canScrub={canScrub} />
              <Tonearm down={playing} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: accent }}>
                <span className="jb-bars" data-on={playing} aria-hidden="true"><i /><i /><i /><i /><i /></span>
                <span style={{ fontSize: 15, letterSpacing: ".08em", color: "#b5e8f2" }}>NOW PLAYING</span>
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.1, margin: "6px 0 2px", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" }}>
                {yt.info.title || "Nothing yet"}
              </div>
              <div style={{ fontSize: 16, color: "#b5e8f2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{yt.info.author || "Paste a link below"}</div>
              <div style={{ fontSize: 14, color: "#a0b29d", marginTop: 4 }}>{yt.info.live ? "LIVE" : playing ? "33 rpm" : "0 rpm"}</div>
            </div>
          </div>

          {/* progress */}
          <div ref={barRef} role="slider" tabIndex={0} aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(yt.duration)} aria-valuenow={Math.round(yt.position)}
            aria-valuetext={`${fmt(yt.position)} of ${fmt(yt.duration)}`} aria-disabled={!canScrub} onKeyDown={onBarKey}
            onPointerDown={(ev) => { if (!canScrub) return; barDrag.current = true; ev.currentTarget.setPointerCapture(ev.pointerId); seekTo(ev.clientX, false) }}
            onPointerMove={(ev) => { if (barDrag.current) seekTo(ev.clientX, false) }}
            onPointerUp={(ev) => { if (barDrag.current) { barDrag.current = false; seekTo(ev.clientX, true) } }}
            onPointerCancel={() => { barDrag.current = false; yt.holdProgress(false) }}
            style={{ height: 18, background: "#2a3638", border: `3px solid ${INK}`, borderRadius: 6, overflow: "hidden", cursor: canScrub ? "pointer" : "default", touchAction: "none", outlineOffset: 3 }}>
            <div style={{ width: yt.info.live ? "100%" : `${pct}%`, height: "100%", background: accent, opacity: yt.info.live ? 0.5 : 1 }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, color: "#b5e8f2", margin: "3px 0 10px" }}>
            <span>{fmt(yt.position)}</span><span>{yt.info.live ? "LIVE" : fmt(yt.duration)}</span>
          </div>

          <div style={{ display: "flex", justifyContent: "center", gap: 10, marginBottom: 10 }}>
            <button className="pz-btn gray" aria-label="Previous or restart" onClick={yt.prev} disabled={!yt.ready}>&lsaquo;</button>
            <button className="pz-btn gold" aria-label={playing ? "Pause" : "Play"} onClick={yt.toggle} disabled={!yt.ready || !yt.info.title} style={{ minWidth: 76 }}>{playing ? "Pause" : "Play"}</button>
            <button className="pz-btn gray" aria-label="Next track" onClick={yt.next} disabled={!yt.ready || !yt.info.inPlaylist}>&rsaquo;</button>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, marginBottom: 10 }}>
            Vol
            <input type="range" className="jb-range" min="0" max="1" step="0.05" value={yt.volume} aria-label="Volume" onChange={(e) => yt.setVolume(Number(e.target.value))} />
          </label>

          {/* the screen: YouTube asks for a visible player of at least 200 x 200 */}
          <div style={{ position: "relative", border: `4px solid ${INK}`, borderRadius: 8, background: "#000", overflow: "hidden", width: 320, height: 200, margin: "0 auto 10px" }}>
            <div ref={mount} style={{ width: 320, height: 200 }} />
            {!yt.info.title && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 16, fontSize: 18, color: "#b5e8f2", background: "#141c1e", pointerEvents: "none" }}>
                {yt.ready ? "Paste a YouTube link below, or turn on Mood DJ." : "Loading player..."}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            <input className="jb-input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="YouTube video or playlist link" aria-label="YouTube link"
              onKeyDown={(e) => { if (e.key === "Enter" && link) startLink() }} style={{ flex: 1, minWidth: 0, fontSize: 16 }} />
            <button className="pz-btn blue small" disabled={!link || !yt.ready} onClick={startLink}>Play</button>
          </div>

          <div style={{ borderTop: `3px solid ${INK}`, paddingTop: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 18, fontWeight: 700, cursor: "pointer" }}>
              <input type="checkbox" checked={prefs.dj} onChange={(e) => setPref({ dj: e.target.checked })} style={{ width: 18, height: 18 }} />
              Mood DJ
              <span style={{ fontWeight: 400, fontSize: 15, color: "#b5e8f2" }}>now: {mood}</span>
            </label>
            <div style={{ fontSize: 15, color: "#b5e8f2", margin: "2px 0 6px" }}>Calm music normally, tense music while a CRITICAL event is open.</div>
            {[["calm", "Calm link"], ["tense", "Tense link"]].map(([k, ph]) => (
              <input key={k} className="jb-input" value={prefs[k]} onChange={(e) => setPref({ [k]: e.target.value })} placeholder={ph} aria-label={ph}
                style={{ width: "100%", fontSize: 15, padding: "3px 8px", marginBottom: 6, borderColor: prefs[k] && !parseSource(prefs[k]) ? "var(--red)" : INK }} />
            ))}
          </div>

          {yt.error && (
            <div role="alert" style={{ marginTop: 8, padding: "6px 10px", fontSize: 16, background: "#5a2a28", border: `3px solid ${INK}`, borderRadius: 6, lineHeight: 1.2 }}>{yt.error}</div>
          )}
        </div>
      </div>
    </>
  )
}
