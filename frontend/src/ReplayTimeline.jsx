import { useState, useEffect, useRef, useCallback } from "react"
import axios from "axios"
import { API } from "./api"
import { buildRichContext, formatTimestamp, PHASE_EXPLANATIONS } from "./Humanlog"
import { sanitizeField } from "./sanitize"
import { PixelCard } from "./px/Card"
import { LuffyAvatar } from "./px/PixelLuffy"
import { Btn } from "./px/ui"
import PxIcon from "./px/PxIcon"
import { tierOf } from "./px/cardModel"

// ─────────────────────────────────────────────────────────────
// REPLAY: an incident played back as a row of cards. Cards you have not reached yet
// are face down; each step flips the next one over while Luffy narrates.
// ─────────────────────────────────────────────────────────────
const PHASE_COLORS = {
  "Phase 1: Brute Force":              "#fdcf51",
  "Phase 1: Account Lockout":          "#fa8f0b",
  "Phase 2: Credential Access":        "#fa8f0b",
  "Phase 2: Credential Theft":         "#fa8f0b",
  "Phase 3: Privilege Escalation":     "#fd5f55",
  "Phase 3: Backdoor Login":           "#fd5f55",
  "Phase 4: Persistence":              "#fd5f55",
  "Phase 5: Data Exfiltration":        "#fd5f55",
  "Phase 5: Data Exfiltration Complete":"#fd5f55",
}

const LUFFY_PHASE_LINES = {
  "Phase 1: Brute Force":
    "Someone is guessing passwords over and over, trying to break into an account. Like trying every key on a keychain until one fits.",
  "Phase 1: Account Lockout":
    "The account got locked after too many wrong attempts! The system protected itself. But this means someone was REALLY trying to get in.",
  "Phase 2: Credential Access":
    "They got in! They used real login credentials, either guessed right or stole a password from somewhere.",
  "Phase 2: Credential Theft":
    "They read saved passwords from the secure storage. Now they have real keys to the system. This is serious.",
  "Phase 3: Privilege Escalation":
    "A new admin account appeared out of nowhere. The attacker upgraded themselves to full administrator. They have complete control now.",
  "Phase 3: Backdoor Login":
    "They're logging in through a backdoor they created. Even if you change passwords now, they can still get back in.",
  "Phase 4: Persistence":
    "A suspicious service installed itself to run automatically. The attacker has set up camp, they survive reboots now.",
  "Phase 5: Data Exfiltration":
    "Files are leaving the system right now, being sent to an unknown address outside. This is the theft, they're taking everything.",
  "Phase 5: Data Exfiltration Complete":
    "It's done. The attacker took what they came for. This is the end of the attack chain. Time to assess the damage.",
}

const SPEEDS = [[4000, "0.5x"], [2000, "1x"], [1000, "2x"], [500, "4x"]]

function useInterval(callback, delay) {
  const saved = useRef(callback)
  useEffect(() => { saved.current = callback }, [callback])
  useEffect(() => {
    if (delay === null) return
    const id = setInterval(() => saved.current(), delay)
    return () => clearInterval(id)
  }, [delay])
}

function Section({ title, children, tone }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 14, letterSpacing: ".12em", fontWeight: 700, color: "#6b7b78", marginBottom: 3 }}>{title}</div>
      <div style={{ border: "3px solid var(--ink)", borderRadius: 8, padding: "6px 10px", background: tone || "#fff", fontSize: 18, lineHeight: 1.25 }}>{children}</div>
    </div>
  )
}

// Hash status for one event
function IntegrityTag({ integrity, hash }) {
  if (!integrity) return null
  const v = integrity.valid
  const label = v === true ? "HASH VERIFIED" : v === false ? "HASH MISMATCH" : "LEGACY EVENT"
  const color = v === true ? "var(--green-d)" : v === false ? "var(--red-d)" : "#5e7977"
  return <span className="pz-tag" style={{ background: color }}>{label}{hash ? `  ${hash}` : ""}</span>
}

function ForensicDetail({ detail, loading }) {
  if (loading) return <div className="pz-panel paper" style={{ padding: 12, color: "var(--ink)" }}>Loading forensic detail...</div>
  if (!detail) return null
  const phase = detail.raw?.phase
  const color = PHASE_COLORS[phase] || tierOf(detail.event?.threat_tier).color
  return (
    <div className="pz-panel paper pz-bounce-in" style={{ padding: 12, color: "var(--ink)" }}>
      <div style={{ fontWeight: 700, fontSize: 20, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <PxIcon name="scroll" size={22} /> FORENSIC ANALYSIS
      </div>
      <div style={{ marginBottom: 10 }}><IntegrityTag integrity={detail.integrity} hash={detail.event_hash_short} /></div>
      {detail.cluster_label && <Section title="BEHAVIOUR CLUSTER">{sanitizeField(detail.cluster_label)}</Section>}
      <Section title="WHAT THE SYSTEM DID">{detail.windows_response}</Section>
      <Section title="SECURITY CONTROL GAP" tone={color + "33"}>{detail.missed_control}</Section>
      <Section title="FORENSIC SIGNIFICANCE">{detail.significance}</Section>
    </div>
  )
}

// A step in the track: face down until reached
function Step({ event, index, revealed, current, onClick }) {
  const f = event
  return (
    <div
      onClick={onClick}
      style={{ position: "relative", flex: "0 0 auto", width: 92, height: 138, cursor: "pointer", marginRight: 10, transform: current ? "translateY(-14px) scale(1.06)" : "none", transition: "transform .25s cubic-bezier(.3,1.6,.5,1)" }}
      role="button"
      aria-label={`Step ${index + 1}${revealed ? "" : ", hidden"}`}
    >
      {revealed ? (
        <div key={`up-${index}`} style={{ position: "absolute", inset: 0, animation: "pz-flip .4s ease backwards" }}>
          <PixelCard event={f} width={92} interactive={false} selected={current} style={{ animation: "none", "--lift": "0px" }} />
        </div>
      ) : (
        <div className="pz-card back" style={{ "--cw": "92px", "--x": "0px", "--y": "0px", "--r": "0deg", animation: "none", cursor: "pointer" }}>
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 36, color: "rgba(255,255,255,.75)", textShadow: "0 3px 0 rgba(0,0,0,.4)" }}>{index + 1}</div>
        </div>
      )}
    </div>
  )
}

function Commentary({ event, isPlaying }) {
  const [text, setText] = useState("")
  const [shown, setShown] = useState("")
  useEffect(() => {
    if (!event) return
    const ctx = buildRichContext(event)
    const phase = ctx.attack_phase
    setText(phase && LUFFY_PHASE_LINES[phase] ? LUFFY_PHASE_LINES[phase] : `${ctx.plain_english} ${ctx.investigation_hint}`)
  }, [event])
  useEffect(() => {
    if (!text) return
    let i = 0
    setShown("")
    const id = setInterval(() => { setShown(text.slice(0, i + 1)); i++; if (i >= text.length) clearInterval(id) }, 18)
    return () => clearInterval(id)
  }, [text])
  if (!event) return null
  const t = tierOf(event.threat_tier)
  const mood = event.threat_tier >= 4 ? "angry" : event.threat_tier >= 3 ? "alert" : event.threat_tier >= 2 ? "thinking" : "idle"
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
      <LuffyAvatar mood={mood} size={56} color={t.color} />
      <div className="pz-tip no-arrow" style={{ flex: 1, padding: "8px 12px" }}>
        <span className="pz-tag" style={{ background: t.color, color: t.name === "MEDIUM" ? "#1d2527" : "#fff", textShadow: t.name === "MEDIUM" ? "none" : undefined }}>LUFFY {isPlaying ? "LIVE" : "PAUSED"}</span>
        <div style={{ fontSize: 19, lineHeight: 1.2, marginTop: 4, minHeight: 54 }}>{shown}</div>
      </div>
    </div>
  )
}

export default function ReplayTimeline({ onLuffyState, onLuffyMessage }) {
  const [allEvents,     setAllEvents]     = useState([])
  const [replayEvents,  setReplayEvents]  = useState([])
  const [currentStep,   setCurrentStep]   = useState(-1)
  const [isPlaying,     setIsPlaying]     = useState(false)
  const [speed,         setSpeed]         = useState(2000)
  const [mode,          setMode]          = useState("demo")
  const [loading,       setLoading]       = useState(true)
  const [replayDetail,  setReplayDetail]  = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const track = useRef(null)

  const loadEvents = useCallback(async () => {
    setLoading(true)
    try {
      const res = await axios.get(`${API}/events`)
      const evs = (res.data.events || []).slice().reverse()
      setAllEvents(evs)
      const demo = evs.filter(e => { try { return JSON.parse(e.raw_data).demo === true } catch { return false } })
      setReplayEvents(demo.length > 0 ? demo : evs.slice(0, 20))
      setMode(demo.length > 0 ? "demo" : "all")
    } catch (e) { console.error(e) }
    setLoading(false)
  }, [])
  useEffect(() => { loadEvents() }, [loadEvents])

  // Forensic detail for the current step
  useEffect(() => {
    if (currentStep < 0 || !replayEvents[currentStep]) { setReplayDetail(null); return }
    const event = replayEvents[currentStep]
    if (!event?.id) return
    setDetailLoading(true)
    axios.get(`${API}/replay-detail/${event.id}`)
      .then(r => setReplayDetail(r.data))
      .catch(() => setReplayDetail(null))
      .finally(() => setDetailLoading(false))
  }, [currentStep, replayEvents])

  // Playback. The next step is computed here, not inside a setState updater: updaters must be
  // pure, and this also notifies the parent (Luffy's mood and line).
  const stepRef = useRef(-1)
  useEffect(() => { stepRef.current = currentStep }, [currentStep])

  useInterval(() => {
    if (!isPlaying) return
    const next = stepRef.current + 1
    if (next >= replayEvents.length) {
      setIsPlaying(false)
      onLuffyState && onLuffyState("goofy")
      onLuffyMessage && onLuffyMessage("Case replay complete! I still don't fully understand it but the evidence is all there!")
      return
    }
    stepRef.current = next
    setCurrentStep(next)
    const ev = replayEvents[next]
    if (ev) {
      const ctx = buildRichContext(ev)
      const tier = ev.threat_tier
      onLuffyState && onLuffyState(tier >= 4 ? "angry" : tier >= 3 ? "alert" : tier >= 2 ? "thinking" : "idle")
      const phase = ctx.attack_phase
      onLuffyMessage && onLuffyMessage(phase && LUFFY_PHASE_LINES[phase] ? LUFFY_PHASE_LINES[phase].slice(0, 140) + "..." : ctx.plain_english)
    }
  }, isPlaying ? speed : null)

  // Keep the current card in view
  useEffect(() => {
    if (currentStep < 0 || !track.current) return
    const el = track.current.children[currentStep]
    if (el) track.current.scrollTo({ left: el.offsetLeft - track.current.clientWidth / 2 + 46, behavior: "smooth" })
  }, [currentStep])

  const handlePlay = () => {
    if (currentStep >= replayEvents.length - 1) { setCurrentStep(-1); setTimeout(() => setIsPlaying(true), 100) }
    else setIsPlaying(true)
    onLuffyState && onLuffyState("thinking")
  }
  const handlePause = () => setIsPlaying(false)
  const handleReset = () => { setCurrentStep(-1); setIsPlaying(false); onLuffyState && onLuffyState("idle") }
  const handleEnd   = () => { setCurrentStep(replayEvents.length - 1); setIsPlaying(false) }

  const switchMode = (m) => {
    setMode(m); setCurrentStep(-1); setIsPlaying(false); setReplayDetail(null)
    if (m === "demo") {
      const demo = allEvents.filter(e => { try { return JSON.parse(e.raw_data).demo === true } catch { return false } })
      setReplayEvents(demo.length > 0 ? demo : allEvents.slice(0, 20))
    } else {
      setReplayEvents(allEvents.slice(0, 20))
    }
  }

  const total = replayEvents.length
  const current = currentStep >= 0 ? replayEvents[currentStep] : null
  const ctx = current ? buildRichContext(current) : null
  const phase = ctx?.attack_phase
  const t = current ? tierOf(current.threat_tier) : null
  const phaseColor = phase ? (PHASE_COLORS[phase] || t.color) : t?.color

  if (loading) return <div style={{ padding: 40, textAlign: "center" }} className="pz-title">Loading the case...</div>

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "0 160px 24px 20px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
        <span className="pz-title" style={{ fontSize: 33 }}>ATTACK REPLAY</span>
        <span className="pz-pill">{total} steps</span>
        <div style={{ flex: 1 }} />
        <Btn size="small" color={mode === "demo" ? "gold" : "gray"} onClick={() => switchMode("demo")}>Demo attack</Btn>
        <Btn size="small" color={mode === "all" ? "gold" : "gray"} onClick={() => switchMode("all")}>All events</Btn>
        <Btn size="small" color="gray" onClick={loadEvents}>Reload</Btn>
      </div>

      {total === 0 ? (
        <div className="pz-panel" style={{ padding: 20, maxWidth: 420 }}>
          <div className="pz-title" style={{ fontSize: 26 }}>Nothing to replay yet</div>
          <div style={{ color: "#b5e8f2", marginTop: 4 }}>Run a scan, or inject the demo attack from Home.</div>
        </div>
      ) : (
        <>
          {/* The track of cards */}
          <div ref={track} style={{ display: "flex", overflowX: "auto", padding: "44px 10px 18px", marginBottom: 6 }} aria-label="Replay steps">
            {replayEvents.map((ev, i) => (
              <Step key={ev.id} event={ev} index={i} revealed={i <= currentStep} current={i === currentStep}
                onClick={() => { setCurrentStep(i); setIsPlaying(false) }} />
            ))}
          </div>

          {/* Controls */}
          <div className="pz-panel" style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
            <Btn color="gray" onClick={handleReset}>Reset</Btn>
            {isPlaying
              ? <Btn color="gold" className="big" onClick={handlePause} style={{ minWidth: 130 }}>Pause</Btn>
              : <Btn color="green" className="big" onClick={handlePlay} style={{ minWidth: 130 }}>Play</Btn>}
            <Btn color="gray" onClick={handleEnd}>End</Btn>
            <div style={{ flex: 1, minWidth: 140 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 17, fontWeight: 700, marginBottom: 2 }}>
                <span className="pz-label">Progress</span><span>{Math.max(0, currentStep + 1)}/{total}</span>
              </div>
              <div style={{ height: 16, background: "#2a3638", border: "3px solid var(--ink)", borderRadius: 5, overflow: "hidden" }}>
                <div style={{ width: `${(Math.max(0, currentStep + 1) / total) * 100}%`, height: "100%", background: "var(--green)", transition: "width .4s", boxShadow: "inset 0 -4px 0 rgba(0,0,0,.25)" }} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span className="pz-label">Speed</span>
              {SPEEDS.map(([ms, l]) => <Btn key={ms} size="small" color={speed === ms ? "gold" : "gray"} onClick={() => setSpeed(ms)}>{l}</Btn>)}
            </div>
          </div>

          {/* Current step */}
          {current ? (
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
              <div style={{ flex: "1 1 400px", minWidth: 0 }}>
                <div className="pz-panel paper pz-bounce-in" key={current.id} style={{ padding: 14, color: "var(--ink)", marginBottom: 14 }}>
                  {phase && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "3px 12px", border: "3px solid var(--ink)", borderRadius: 8, background: phaseColor, color: "#fff", fontWeight: 700, marginBottom: 8, textShadow: "0 2px 0 rgba(0,0,0,.45)" }}>
                      <PxIcon name="warn" size={18} />{sanitizeField(phase)}
                    </div>
                  )}
                  {phase && PHASE_EXPLANATIONS[phase] && <div style={{ fontSize: 18, color: "#3e4d4b", marginBottom: 8, lineHeight: 1.2 }}>{PHASE_EXPLANATIONS[phase]}</div>}
                  <div style={{ fontSize: 23, lineHeight: 1.2, marginBottom: 10 }}>{ctx.plain_english}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <span className="pz-tag" style={{ background: t.color, color: t.name === "MEDIUM" ? "#1d2527" : "#fff", textShadow: t.name === "MEDIUM" ? "none" : undefined }}>{t.name}</span>
                    {current.cluster_label && <span className="pz-tag" style={{ background: "var(--purple-d)" }}>{sanitizeField(current.cluster_label)}</span>}
                    <span style={{ fontSize: 17, color: "#6b7b78" }}>{formatTimestamp(ctx.timestamp)}</span>
                    <span style={{ fontSize: 17, color: "#6b7b78" }}>[{sanitizeField(current.source)}]</span>
                    <span style={{ marginLeft: "auto", fontWeight: 700 }}>Score {Math.round(current.anomaly_score * 100)}%</span>
                  </div>
                  {ctx.key_fields && Object.keys(ctx.key_fields).length > 0 && (
                    <details style={{ marginTop: 10 }}>
                      <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 18 }}>Technical details</summary>
                      <div style={{ marginTop: 6 }}>
                        {Object.entries(ctx.key_fields).slice(0, 6).map(([k, v]) => (
                          <div key={k} style={{ display: "flex", gap: 8, fontSize: 17 }}>
                            <span style={{ minWidth: 120, color: "#6b7b78", fontWeight: 600 }}>{k}</span>
                            <span style={{ wordBreak: "break-all" }}>{String(v).slice(0, 80)}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
                <Commentary event={current} isPlaying={isPlaying} />
              </div>
              <div style={{ flex: "0 0 340px", minWidth: 280 }}>
                <ForensicDetail detail={replayDetail} loading={detailLoading} />
              </div>
            </div>
          ) : (
            <div className="pz-panel pz-fade-up" style={{ padding: 18, maxWidth: 440 }}>
              <div className="pz-title" style={{ fontSize: 26 }}>Press Play</div>
              <div style={{ color: "#b5e8f2", marginTop: 4 }}>Each card flips over as the incident unfolds. Click any card to jump to that step.</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
