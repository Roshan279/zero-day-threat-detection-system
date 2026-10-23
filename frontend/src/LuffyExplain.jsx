import { useEffect, useMemo, useState } from "react"
import axios from "axios"
import { API } from "./api"
import PixelLuffy from "./px/PixelLuffy"
import { buildRichContext, explainTier } from "./Humanlog"

// ─────────────────────────────────────────────────────────────
// LUFFY NOTE: a short note inside the case file. Luffy puffs in through a smoke burst next to
// the text and explains the event. Mount it with a new key each time it should replay.
// ─────────────────────────────────────────────────────────────
const PUFFS = 14
const AI_DOWN = /offline|couldn't read|api key|unavailable/i

// Built from the event itself, for when the AI is not reachable
function localExplain(event) {
  const ctx = buildRichContext(event)
  const parts = [ctx.plain_english, explainTier(event.threat_tier), ctx.investigation_hint].filter(Boolean)
  const gap = String.fromCharCode(10)
  return { narrative: parts.join(gap) + gap + "(Built-in summary. My AI brain is offline.)", mood: event.threat_tier >= 4 ? "angry" : event.threat_tier >= 3 ? "alert" : "thinking" }
}

function Smoke() {
  const puffs = useMemo(() => Array.from({ length: PUFFS }, (_, i) => {
    const a = (i / PUFFS) * Math.PI * 2 + (i % 2) * 0.2
    const r = 70 + (i % 3) * 28
    return { dx: Math.cos(a) * r, dy: Math.sin(a) * r * 0.8 - 20, size: 30 + (i % 4) * 11, delay: (i % 5) * 0.03, tone: i % 3 }
  }), [])
  const tones = ["#f3f1ea", "#d6dbd8", "#b5c0bd"]
  return (
    <>
      {puffs.map((p, i) => (
        <span key={i} style={{
          position: "absolute", left: "50%", top: "52%", width: p.size, height: p.size, marginLeft: -p.size / 2, marginTop: -p.size / 2,
          background: tones[p.tone], border: "3px solid #1d2527", borderRadius: 6, pointerEvents: "none", zIndex: 3,
          "--dx": `${p.dx}px`, "--dy": `${p.dy}px`, animation: `pz-smoke .85s steps(7) ${p.delay}s both`,
        }} />
      ))}
      <span style={{ position: "absolute", inset: 0, background: "#fff", opacity: 0, animation: "pz-poof-flash .35s ease-out both", pointerEvents: "none", borderRadius: 14, zIndex: 2 }} />
    </>
  )
}

export default function LuffyExplain({ event, onClose }) {
  const [reply, setReply] = useState(null)       // { narrative, mood } once it arrives
  const [shown, setShown] = useState(0)

  useEffect(() => {
    let live = true
    axios.post(`${API}/analyze-event`, { event_id: event.id })
      .then(r => {
        if (!live) return
        const n = r.data.narrative || ""
        setReply(!n || AI_DOWN.test(n) ? localExplain(event) : { narrative: n, mood: r.data.mood || "alert" })
      })
      .catch(() => { if (live) setReply(localExplain(event)) })
    return () => { live = false }
  }, [event])

  // type the text out
  useEffect(() => {
    if (!reply) return
    const total = reply.narrative.length
    const t = setInterval(() => setShown(s => (s >= total ? s : s + 2)), 16)
    return () => clearInterval(t)
  }, [reply])

  const mood = reply ? reply.mood : "thinking"
  const typing = reply && shown < reply.narrative.length
  const text = reply ? reply.narrative.slice(0, shown) : null

  return (
    <div className="pz-bounce-in" style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 14, padding: 10, background: "#e4eef0", border: "3px solid var(--ink)", borderRadius: 10 }}>
      <div style={{ position: "relative", flex: "0 0 92px", height: 110, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
        <Smoke />
        <div style={{ animation: "pz-luffy-pop .55s cubic-bezier(.3,1.6,.5,1) .28s both", transformOrigin: "50% 100%" }}>
          <PixelLuffy mood={mood} height={108} />
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, animation: "pz-fade-up .35s ease .5s both" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span className="pz-tag" style={{ background: "var(--blue)" }}>LUFFY SAYS</span>
          <span style={{ flex: 1 }} />
          {typing && <button className="pz-btn gray small" style={{ padding: "0 8px" }} onClick={() => setShown(reply.narrative.length)}>Skip</button>}
          <button className="pz-btn gold small" style={{ padding: "0 8px" }} onClick={onClose} aria-label="Hide Luffy's note">Got it</button>
        </div>
        <div style={{ fontSize: 19, lineHeight: 1.25, whiteSpace: "pre-wrap", maxHeight: 190, overflowY: "auto" }}>
          {text === null ? "Hmm, let me look at this one..." : <>{text}{typing && <span style={{ opacity: .5 }}>_</span>}</>}
        </div>
      </div>
    </div>
  )
}
