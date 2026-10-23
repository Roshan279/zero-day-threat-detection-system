import { useCallback, useEffect, useRef, useState } from "react"

// ─────────────────────────────────────────────────────────────
// YouTube IFrame Player API as a React hook. No account, no API key: paste a video, live stream or playlist link.
// The hook creates the player inside the element you pass as mountRef and keeps it alive for the life of the
// component, so the music keeps playing while the UI around it opens and closes.
//   state: "idle" | "buffering" | "playing" | "paused" | "ended"
// ─────────────────────────────────────────────────────────────
let apiPromise = null
function loadApi() {
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) { resolve(window.YT); return }
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT) }
    const s = document.createElement("script")
    s.src = "https://www.youtube.com/iframe_api"
    s.async = true
    s.onerror = () => { apiPromise = null; reject(new Error("Could not load the YouTube player. Check your connection or ad blocker.")) }
    document.head.appendChild(s)
  })
  return apiPromise
}

// Accepts watch / youtu.be / shorts / live / embed links, playlist links, or a bare 11 character video id.
export function parseSource(input) {
  const s = String(input || "").trim()
  if (!s) return null
  const list = s.match(/[?&]list=([A-Za-z0-9_-]+)/)
  const vid = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/)
  if (list) return { kind: "playlist", id: list[1] }
  if (vid) return { kind: "video", id: vid[1] }
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return { kind: "video", id: s }
  return null
}

const STATES = { "-1": "idle", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "idle" }
const ERRORS = {
  2: "That link isn't a valid YouTube video.",
  5: "The player hit an error. Try another video.",
  100: "That video was removed or is private.",
  101: "The owner doesn't allow this video to be played here. Try another.",
  150: "The owner doesn't allow this video to be played here. Try another.",
}

export function useYouTube(mountRef, { width = 320, height = 200 } = {}) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState("")
  const [state, setState] = useState("idle")
  const [info, setInfo] = useState({ title: "", author: "", live: false, inPlaylist: false })
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolumeState] = useState(0.5)
  const playerRef = useRef(null)
  const hold = useRef(false)     // true while the user is scrubbing, so polling doesn't fight the drag
  const stateRef = useRef("idle")

  const readInfo = useCallback(() => {
    const p = playerRef.current
    if (!p?.getVideoData) return
    const d = p.getVideoData() || {}
    setInfo({ title: d.title || "", author: d.author || "", live: Boolean(d.isLive), inPlaylist: (p.getPlaylist?.() || []).length > 1 })
  }, [])

  useEffect(() => {
    let cancelled = false
    let player = null
    loadApi().then((YT) => {
      if (cancelled || !mountRef.current) return
      const el = document.createElement("div")
      mountRef.current.appendChild(el)
      player = new YT.Player(el, {
        width, height,
        playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0, modestbranding: 1, iv_load_policy: 3, origin: window.location.origin },
        events: {
          onReady: () => { playerRef.current = player; player.setVolume(50); setReady(true) },
          onStateChange: (e) => {
            const st = STATES[e.data] || "idle"
            stateRef.current = st
            setState(st)
            if (st === "playing") { setError(""); readInfo() }
          },
          onError: (e) => { setError(ERRORS[e.data] || "Playback failed."); setState("idle"); stateRef.current = "idle" },
        },
      })
    }).catch((e) => { if (!cancelled) setError(e.message) })
    return () => {
      cancelled = true
      playerRef.current = null
      try { player?.destroy() } catch { /* already gone */ }
    }
  }, [mountRef, width, height, readInfo])

  // Progress: poll the player while something is playing.
  useEffect(() => {
    if (state !== "playing" && state !== "buffering") return
    const id = setInterval(() => {
      const p = playerRef.current
      if (!p || hold.current) return
      setPosition(p.getCurrentTime?.() || 0)
      setDuration(p.getDuration?.() || 0)
    }, 250)
    return () => clearInterval(id)
  }, [state])

  const play = useCallback((input) => {
    const src = parseSource(input)
    const p = playerRef.current
    if (!src) { setError("That doesn't look like a YouTube link."); return false }
    if (!p) { setError("The player isn't ready yet."); return false }
    setError("")
    setPosition(0)
    if (src.kind === "playlist") p.loadPlaylist({ listType: "playlist", list: src.id, index: 0 })
    else p.loadVideoById(src.id)
    return true
  }, [])

  const toggle = useCallback(() => {
    const p = playerRef.current
    if (!p) return
    if (stateRef.current === "playing" || stateRef.current === "buffering") p.pauseVideo()
    else if (stateRef.current === "ended") p.seekTo(0, true)
    else p.playVideo()
  }, [])

  const next = useCallback(() => playerRef.current?.nextVideo?.(), [])
  const prev = useCallback(() => {
    const p = playerRef.current
    if (!p) return
    if ((p.getCurrentTime?.() || 0) > 3 || !(p.getPlaylist?.() || []).length) { p.seekTo(0, true); setPosition(0) }
    else p.previousVideo()
  }, [])

  // While dragging: seek loosely and show the time. On release: seek for real.
  const scrub = useCallback((t, final = false) => {
    const p = playerRef.current
    hold.current = !final
    setPosition(t)
    p?.seekTo?.(t, final)
  }, [])
  const holdProgress = useCallback((on) => { hold.current = on }, [])

  const setVolume = useCallback((v) => { setVolumeState(v); playerRef.current?.setVolume?.(Math.round(v * 100)) }, [])

  return { ready, error, setError, state, info, position, duration, volume, play, toggle, next, prev, scrub, holdProgress, setVolume }
}
