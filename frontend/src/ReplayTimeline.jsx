import { useState, useEffect, useRef, useCallback } from "react"
import axios from "axios"
import { getHumanDescription, buildRichContext, explainPhase, formatTimestamp, PHASE_EXPLANATIONS } from "./humanlog"
import { sanitizeField } from "./sanitize"

const API = "http://localhost:8000"

const TIERS = {
  1:{label:"LOW",     color:"#4ade80",bg:"#0a1f0f"},
  2:{label:"MEDIUM",  color:"#facc15",bg:"#1a1400"},
  3:{label:"HIGH",    color:"#fb923c",bg:"#1a0e00"},
  4:{label:"CRITICAL",color:"#f87171",bg:"#1a0505"},
}

const PHASE_COLORS = {
  "Phase 1: Brute Force":              "#facc15",
  "Phase 1: Account Lockout":          "#fb923c",
  "Phase 2: Credential Access":        "#fb923c",
  "Phase 2: Credential Theft":         "#fb923c",
  "Phase 3: Privilege Escalation":     "#f87171",
  "Phase 3: Backdoor Login":           "#f87171",
  "Phase 4: Persistence":              "#f87171",
  "Phase 5: Data Exfiltration":        "#f87171",
  "Phase 5: Data Exfiltration Complete":"#f87171",
}

const LUFFY_PHASE_LINES = {
  "Phase 1: Brute Force":
    "Someone is guessing passwords over and over, trying to break into an account. Like trying every key on a keychain until one fits.",
  "Phase 1: Account Lockout":
    "The account got locked after too many wrong attempts! Windows protected itself. But this means someone was REALLY trying to get in.",
  "Phase 2: Credential Access":
    "They got in! They used real login credentials — either guessed right or stole a password from somewhere.",
  "Phase 2: Credential Theft":
    "They read saved passwords from Windows' secure storage. Now they have real keys to the system. This is serious.",
  "Phase 3: Privilege Escalation":
    "A new admin account appeared out of nowhere. The attacker upgraded themselves to full administrator. They have complete control now.",
  "Phase 3: Backdoor Login":
    "They're logging in through a backdoor they created. Even if you change passwords now, they can still get back in.",
  "Phase 4: Persistence":
    "A suspicious service installed itself to run automatically. The attacker has set up camp — they survive reboots now.",
  "Phase 5: Data Exfiltration":
    "Files are leaving the system right now, being sent to an unknown address outside. This is the theft — they're taking everything.",
  "Phase 5: Data Exfiltration Complete":
    "It's done. The attacker took what they came for. This is the end of the attack chain. Time to assess the damage.",
}

function useInterval(callback, delay) {
  const saved = useRef(callback)
  useEffect(() => { saved.current = callback }, [callback])
  useEffect(() => {
    if (delay === null) return
    const id = setInterval(() => saved.current(), delay)
    return () => clearInterval(id)
  }, [delay])
}

function btnStyle(color, bg) {
  return {
    padding:"7px 12px",borderRadius:"3px",background:bg,
    border:`1px solid ${color}`,color,cursor:"pointer",
    fontSize:"0.75rem",fontFamily:"'Share Tech Mono',monospace",
    transition:"all 0.2s",
  }
}

// ─────────────────────────────────────────────────────────────
// INTEGRITY BADGE — per-event hash status
// ─────────────────────────────────────────────────────────────
function IntegrityBadge({ integrity }) {
  if (!integrity) return null
  const valid = integrity.valid
  if (valid === null || valid === undefined) return (
    <span style={{color:"#444",fontSize:"0.52rem",letterSpacing:"0.05em"}}>— legacy</span>
  )
  const color = valid ? "#4ade80" : "#f87171"
  const icon  = valid ? "⛓" : "⛓‍💥"
  const label = valid ? "verified" : "MISMATCH"
  const hash  = integrity.event_hash ? integrity.event_hash.slice(0,10)+"…" : ""
  return (
    <span title={hash} style={{
      color,fontSize:"0.52rem",letterSpacing:"0.05em",
      background:`${color}11`,border:`1px solid ${color}33`,
      borderRadius:"2px",padding:"1px 5px",
    }}>
      {icon} {label}{hash ? ` · ${hash}` : ""}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// PHASE BANNER
// ─────────────────────────────────────────────────────────────
function PhaseBanner({ phase }) {
  if (!phase) return null
  const color   = PHASE_COLORS[phase] || "#fb923c"
  const explain = PHASE_EXPLANATIONS[phase]
  const [showExplain, setShowExplain] = useState(false)
  return (
    <div style={{marginBottom:"6px"}}>
      <div
        style={{padding:"6px 14px",background:`${color}18`,border:`1px solid ${color}44`,borderRadius:"3px",display:"inline-flex",alignItems:"center",gap:"8px",cursor:"pointer",animation:"luffyFadeIn 0.3s ease"}}
        onClick={() => setShowExplain(s => !s)}
      >
        <div style={{width:"6px",height:"6px",borderRadius:"50%",background:color,boxShadow:`0 0 8px ${color}`}}/>
        <span style={{color,fontSize:"0.68rem",letterSpacing:"0.1em",fontFamily:"'Share Tech Mono',monospace"}}>{sanitizeField(phase)}</span>
        <span style={{color:color+"88",fontSize:"0.56rem"}}>{showExplain?"▲":"▼ what's this?"}</span>
      </div>
      {showExplain && explain && (
        <div style={{marginTop:"4px",padding:"8px 12px",background:`${color}11`,border:`1px solid ${color}33`,borderRadius:"4px",color:"#c8b890",fontSize:"0.68rem",lineHeight:"1.6",animation:"luffyFadeIn 0.2s ease"}}>
          {explain}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// FORENSIC DETAIL PANEL
// Loaded from /replay-detail/{id} — richer than the old inline data
// ─────────────────────────────────────────────────────────────
function ForensicDetail({ detail, loading }) {
  if (loading) return (
    <div style={{color:"#333",fontSize:"0.66rem",padding:"8px 0",fontFamily:"'Share Tech Mono',monospace"}}>
      Loading forensic detail...
    </div>
  )
  if (!detail) return null

  const t     = TIERS[detail.event?.threat_tier] || TIERS[1]
  const color = PHASE_COLORS[detail.raw?.phase] || t.color

  return (
    <div style={{display:"flex",flexDirection:"column",gap:"10px",fontFamily:"'Share Tech Mono',monospace"}}>
      {/* Integrity */}
      <div style={{background:"#0a0a0a",border:"1px solid #1a1a1a",borderRadius:"3px",padding:"7px 10px"}}>
        <div style={{color:"#333",fontSize:"0.54rem",letterSpacing:"0.1em",marginBottom:"4px"}}>CHAIN OF CUSTODY</div>
        <IntegrityBadge integrity={detail.integrity}/>
        {detail.event_hash_short && (
          <div style={{color:"#222",fontSize:"0.52rem",marginTop:"4px"}}>SHA-256: {detail.event_hash_short}</div>
        )}
      </div>

      {/* Cluster */}
      {detail.cluster_label && (
        <div style={{background:"#0d0d1a",border:"1px solid #3a3a6a",borderRadius:"3px",padding:"7px 10px"}}>
          <div style={{color:"#333",fontSize:"0.54rem",letterSpacing:"0.1em",marginBottom:"3px"}}>BEHAVIOUR CLUSTER</div>
          <div style={{color:"#8888cc",fontSize:"0.66rem"}}>◈ {sanitizeField(detail.cluster_label)}</div>
        </div>
      )}

      {/* What Windows did */}
      <div>
        <div style={{color:"#333",fontSize:"0.54rem",letterSpacing:"0.1em",marginBottom:"5px"}}>WHAT WINDOWS DID</div>
        <div style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"8px 10px",color:"#c8b890",fontSize:"0.64rem",lineHeight:"1.6"}}>
          {detail.windows_response}
        </div>
      </div>

      {/* Missed control */}
      <div>
        <div style={{color:"#333",fontSize:"0.54rem",letterSpacing:"0.1em",marginBottom:"5px"}}>SECURITY CONTROL GAP</div>
        <div style={{background:"#1a0a0a",border:`1px solid ${color}44`,borderRadius:"4px",padding:"8px 10px",color:"#c8b890",fontSize:"0.64rem",lineHeight:"1.6"}}>
          {detail.missed_control}
        </div>
      </div>

      {/* Forensic significance */}
      <div>
        <div style={{color:"#333",fontSize:"0.54rem",letterSpacing:"0.1em",marginBottom:"5px"}}>FORENSIC SIGNIFICANCE</div>
        <div style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"8px 10px",color:"#e8d5b0",fontSize:"0.64rem",lineHeight:"1.6"}}>
          {detail.significance}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// TIMELINE NODE
// ─────────────────────────────────────────────────────────────
function TimelineNode({ event, index, isCompleted, isCurrent, onClick }) {
  const ctx        = buildRichContext(event)
  const t          = TIERS[event.threat_tier] || TIERS[1]
  const phase      = ctx.attack_phase
  const phaseColor = phase ? (PHASE_COLORS[phase] || t.color) : t.color
  const ts         = formatTimestamp(ctx.timestamp)
  const cluster    = sanitizeField(event.cluster_label || "")

  return (
    <div onClick={onClick} style={{display:"flex",gap:"0",cursor:"pointer",opacity:isCompleted||isCurrent?1:0.25,transition:"opacity 0.4s ease"}}>
      {/* Connector */}
      <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:"40px",flexShrink:0}}>
        <div style={{
          width:"32px",height:"32px",borderRadius:"50%",
          border:`2px solid ${isCurrent?phaseColor:(isCompleted?phaseColor:"#1a1a1a")}`,
          background:isCurrent?`${phaseColor}22`:(isCompleted?"#0d0d0d":"#080808"),
          display:"flex",alignItems:"center",justifyContent:"center",
          boxShadow:isCurrent?`0 0 16px ${phaseColor}88`:"none",
          transition:"all 0.4s ease",flexShrink:0,
          animation:isCurrent?"pulse-node 1.5s ease-in-out infinite":"none",
        }}>
          {isCompleted && !isCurrent
            ? <span style={{color:phaseColor,fontSize:"0.7rem"}}>✓</span>
            : <span style={{color:isCurrent?phaseColor:"#333",fontSize:"0.65rem",fontFamily:"'Orbitron',monospace"}}>{String(index+1).padStart(2,"0")}</span>
          }
        </div>
        {index < 99 && (
          <div style={{width:"2px",flex:1,minHeight:"24px",background:isCompleted?`${phaseColor}66`:"#1a1a1a",transition:"background 0.4s"}}/>
        )}
      </div>

      {/* Card */}
      <div style={{
        flex:1,marginLeft:"10px",marginBottom:"8px",
        background:isCurrent?`${phaseColor}11`:"#080808",
        border:`1px solid ${isCurrent?phaseColor:(isCompleted?phaseColor+"44":"#111")}`,
        borderRadius:"4px",padding:"10px 12px",transition:"all 0.4s",
        boxShadow:isCurrent?`0 0 20px ${phaseColor}33`:"none",
      }}>
        {phase && <PhaseBanner phase={phase}/>}

        {/* Plain-English description */}
        <div style={{color:isCurrent?"#e8d5b0":"#888",fontSize:"0.72rem",lineHeight:"1.6",marginBottom:"6px",transition:"color 0.4s"}}>
          {ctx.plain_english}
        </div>

        {/* Metadata row */}
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:"4px"}}>
          <div style={{display:"flex",gap:"6px",alignItems:"center",flexWrap:"wrap"}}>
            <span style={{background:t.bg,border:`1px solid ${t.color}44`,color:t.color,fontSize:"0.56rem",padding:"1px 7px",borderRadius:"2px"}}>{t.label}</span>
            {/* Cluster badge on node */}
            {cluster && (
              <span style={{background:"#0d0d1a",border:"1px solid #3a3a6a44",color:"#8888cc",fontSize:"0.52rem",padding:"1px 6px",borderRadius:"2px"}}>
                {cluster}
              </span>
            )}
            <span style={{color:"#333",fontSize:"0.58rem"}}>{ts}</span>
          </div>
          <div style={{display:"flex",gap:"8px",alignItems:"center"}}>
            <span style={{color:"#333",fontSize:"0.58rem"}}>[{sanitizeField(event.source)}]</span>
            <span style={{color:isCurrent?phaseColor:"#333",fontSize:"0.6rem"}}>Score: {Math.round(event.anomaly_score*100)}%</span>
          </div>
        </div>

        {/* Technical details (collapsible) — only on current step */}
        {isCurrent && ctx.key_fields && Object.keys(ctx.key_fields).length > 0 && (
          <details style={{marginTop:"8px"}}>
            <summary style={{color:"#333",fontSize:"0.58rem",cursor:"pointer",userSelect:"none"}}>▶ technical details</summary>
            <div style={{marginTop:"6px",display:"flex",flexDirection:"column",gap:"3px"}}>
              {Object.entries(ctx.key_fields).slice(0,6).map(([k,v]) => (
                <div key={k} style={{display:"flex",gap:"8px",fontSize:"0.58rem"}}>
                  <span style={{color:"#333",minWidth:"120px",flexShrink:0}}>{k}</span>
                  <span style={{color:"#666",wordBreak:"break-all"}}>{String(v).slice(0,80)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// LUFFY COMMENTARY
// ─────────────────────────────────────────────────────────────
function LuffyCommentary({ event, isPlaying }) {
  const [displayed, setDisplayed] = useState("")
  const [text, setText] = useState("")

  useEffect(() => {
    if (!event) return
    const ctx   = buildRichContext(event)
    const phase = ctx.attack_phase
    const line  = phase && LUFFY_PHASE_LINES[phase]
      ? LUFFY_PHASE_LINES[phase]
      : `${ctx.plain_english} ${ctx.investigation_hint}`
    setText(line)
    setDisplayed("")
  }, [event])

  useEffect(() => {
    if (!text) return
    let i = 0
    setDisplayed("")
    const interval = setInterval(() => {
      setDisplayed(text.slice(0,i+1))
      i++
      if (i >= text.length) clearInterval(interval)
    }, 20)
    return () => clearInterval(interval)
  }, [text])

  if (!event) return null

  const ctx   = buildRichContext(event)
  const t     = TIERS[event.threat_tier] || TIERS[1]
  const phase = ctx.attack_phase
  const color = phase ? (PHASE_COLORS[phase]||t.color) : t.color

  return (
    <div style={{background:"#080808",border:`1.5px solid ${color}`,borderRadius:"8px",padding:"14px 16px",boxShadow:`0 0 24px ${color}33`,animation:"luffyFadeIn 0.3s ease",fontFamily:"'Share Tech Mono',monospace"}}>
      <div style={{color,fontSize:"0.58rem",letterSpacing:"0.18em",marginBottom:"6px",fontWeight:"bold"}}>
        LUFFY // {isPlaying?"LIVE ANALYSIS":"PAUSED"}
      </div>
      <div style={{color:"#e8d5b0",fontSize:"0.75rem",lineHeight:"1.7"}}>
        {displayed}<span style={{color,animation:"luffyBlink 0.6s infinite"}}>▌</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────
export default function ReplayTimeline({ onLuffyState, onLuffyMessage }) {
  const [allEvents,     setAllEvents]     = useState([])
  const [replayEvents,  setReplayEvents]  = useState([])
  const [currentStep,   setCurrentStep]   = useState(-1)
  const [isPlaying,     setIsPlaying]     = useState(false)
  const [speed,         setSpeed]         = useState(2000)
  const [mode,          setMode]          = useState("demo")
  const [loading,       setLoading]       = useState(true)
  // Forensic detail for the current step — loaded from /replay-detail/{id}
  const [replayDetail,  setReplayDetail]  = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const nodeRefs     = useRef({})
  const containerRef = useRef(null)

  const loadEvents = useCallback(async () => {
    setLoading(true)
    try {
      const res = await axios.get(`${API}/events`)
      const evs = (res.data.events || []).slice().reverse()
      setAllEvents(evs)
      const demo = evs.filter(e => { try { return JSON.parse(e.raw_data).demo === true } catch { return false } })
      setReplayEvents(demo.length > 0 ? demo : evs.slice(0,20))
      setMode(demo.length > 0 ? "demo" : "all")
    } catch(e) { console.error(e) }
    setLoading(false)
  }, [])

  useEffect(() => { loadEvents() }, [loadEvents])

  // ── Load /replay-detail when step changes ──────────────────
  useEffect(() => {
    if (currentStep < 0 || !replayEvents[currentStep]) {
      setReplayDetail(null)
      return
    }
    const event = replayEvents[currentStep]
    if (!event?.id) return

    setDetailLoading(true)
    axios.get(`${API}/replay-detail/${event.id}`)
      .then(r => setReplayDetail(r.data))
      .catch(() => setReplayDetail(null))
      .finally(() => setDetailLoading(false))
  }, [currentStep, replayEvents])

  // ── Playback interval ──────────────────────────────────────
  useInterval(() => {
    if (!isPlaying) return
    setCurrentStep(prev => {
      const next = prev + 1
      if (next >= replayEvents.length) {
        setIsPlaying(false)
        onLuffyState && onLuffyState("goofy")
        onLuffyMessage && onLuffyMessage("Case replay complete! I still don't fully understand it but the evidence is all there!")
        return prev
      }
      const ev = replayEvents[next]
      if (ev) {
        const ctx  = buildRichContext(ev)
        const tier = ev.threat_tier
        onLuffyState && onLuffyState(tier>=4?"angry":tier>=3?"alert":tier>=2?"thinking":"idle")
        const phase = ctx.attack_phase
        if (phase && LUFFY_PHASE_LINES[phase]) {
          onLuffyMessage && onLuffyMessage(LUFFY_PHASE_LINES[phase].slice(0,140)+"...")
        } else {
          onLuffyMessage && onLuffyMessage(ctx.plain_english)
        }
      }
      return next
    })
  }, isPlaying ? speed : null)

  // ── Auto-scroll ────────────────────────────────────────────
  useEffect(() => {
    if (currentStep >= 0 && nodeRefs.current[currentStep])
      nodeRefs.current[currentStep].scrollIntoView({ behavior:"smooth", block:"center" })
  }, [currentStep])

  const handlePlay = () => {
    if (currentStep >= replayEvents.length - 1) { setCurrentStep(-1); setTimeout(() => setIsPlaying(true), 100) }
    else setIsPlaying(true)
    onLuffyState && onLuffyState("thinking")
  }
  const handlePause   = () => setIsPlaying(false)
  const handleReset   = () => { setCurrentStep(-1); setIsPlaying(false); onLuffyState && onLuffyState("idle") }
  const handleSkipEnd = () => { setCurrentStep(replayEvents.length-1); setIsPlaying(false) }

  const switchMode = m => {
    setMode(m); setCurrentStep(-1); setIsPlaying(false); setReplayDetail(null)
    if (m === "demo") {
      const demo = allEvents.filter(e => { try { return JSON.parse(e.raw_data).demo === true } catch { return false } })
      setReplayEvents(demo.length > 0 ? demo : allEvents.slice(0,20))
    } else {
      setReplayEvents(allEvents.slice(0,30))
    }
  }

  const currentEvent = currentStep >= 0 ? replayEvents[currentStep] : null
  const progress     = replayEvents.length > 0 ? ((currentStep+1)/replayEvents.length)*100 : 0

  if (loading) return <div style={{color:"#333",textAlign:"center",padding:"40px",fontSize:"0.8rem"}}>Loading replay data...</div>
  if (replayEvents.length===0) return <div style={{color:"#333",textAlign:"center",padding:"40px",fontSize:"0.8rem"}}>No events to replay. Run a scan or inject a demo attack first.</div>

  return (
    <div className="tab-enter" style={{display:"flex",height:"100%",overflow:"hidden"}}>
      {/* Timeline scroll area */}
      <div ref={containerRef} style={{flex:1,overflowY:"auto",padding:"16px 16px 16px 20px",borderRight:"1px solid #1a1a1a"}}>
        <div style={{marginBottom:"16px"}}>
          <div style={{fontFamily:"'Orbitron',monospace",fontSize:"0.9rem",color:"#e8d5b0",marginBottom:"4px"}}>ATTACK REPLAY</div>
          <div style={{color:"#333",fontSize:"0.6rem"}}>{replayEvents.length} events · {mode==="demo"?"Demo attack scenario":"Live system logs"} · Click any step to jump</div>
        </div>

        <div style={{display:"flex",gap:"6px",marginBottom:"14px"}}>
          {[["demo","⚡ DEMO ATTACK"],["all","📋 ALL EVENTS"]].map(([m,lbl]) => (
            <button key={m} onClick={() => switchMode(m)} style={{padding:"4px 12px",borderRadius:"3px",background:mode===m?"#1a0505":"transparent",border:`1px solid ${mode===m?"#f87171":"#222"}`,color:mode===m?"#f87171":"#333",cursor:"pointer",fontSize:"0.62rem",fontFamily:"'Share Tech Mono',monospace"}}>{lbl}</button>
          ))}
          <button onClick={loadEvents} style={{padding:"4px 10px",borderRadius:"3px",background:"transparent",border:"1px solid #222",color:"#333",cursor:"pointer",fontSize:"0.62rem",fontFamily:"'Share Tech Mono',monospace",marginLeft:"auto"}}>↻ RELOAD</button>
        </div>

        <div style={{paddingLeft:"4px"}}>
          {replayEvents.map((ev,i) => (
            <div key={ev.id} ref={el => nodeRefs.current[i] = el}>
              <TimelineNode
                event={ev} index={i}
                isCompleted={i < currentStep}
                isCurrent={i === currentStep}
                onClick={() => { setCurrentStep(i); setIsPlaying(false) }}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Right panel */}
      <div style={{width:"340px",minWidth:"340px",display:"flex",flexDirection:"column",padding:"16px",gap:"14px",background:"#080808",overflowY:"auto"}}>
        {/* Progress */}
        <div>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:"5px"}}>
            <span style={{color:"#444",fontSize:"0.58rem",letterSpacing:"0.12em"}}>REPLAY PROGRESS</span>
            <span style={{color:"#e8d5b0",fontSize:"0.62rem",fontFamily:"'Orbitron',monospace"}}>{Math.max(0,currentStep+1)}/{replayEvents.length}</span>
          </div>
          <div style={{height:"3px",background:"#111",borderRadius:"2px",overflow:"hidden"}}>
            <div style={{height:"100%",width:`${progress}%`,background:"linear-gradient(90deg,#4ade80,#fb923c,#f87171)",transition:"width 0.4s",boxShadow:"0 0 8px #fb923c"}}/>
          </div>
        </div>

        {/* Controls */}
        <div style={{display:"flex",flexDirection:"column",gap:"8px"}}>
          <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.12em"}}>PLAYBACK CONTROLS</div>
          <div style={{display:"flex",gap:"6px"}}>
            <button onClick={handleReset} style={btnStyle("#444","#111")}>⏮</button>
            {isPlaying
              ? <button onClick={handlePause} style={{...btnStyle("#facc15","#1a1400"),flex:1}}>⏸ PAUSE</button>
              : <button onClick={handlePlay}  style={{...btnStyle("#4ade80","#0a1f0f"),flex:1}}>▶ PLAY</button>
            }
            <button onClick={handleSkipEnd} style={btnStyle("#444","#111")}>⏭</button>
          </div>
          <div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:"4px"}}>
              <span style={{color:"#333",fontSize:"0.58rem"}}>SPEED</span>
              <span style={{color:"#e8d5b0",fontSize:"0.58rem"}}>{speed===500?"4x (Fast)":speed===1000?"2x":speed===2000?"1x (Normal)":"0.5x (Slow)"}</span>
            </div>
            <div style={{display:"flex",gap:"5px"}}>
              {[[3000,"0.5x"],[2000,"1x"],[1000,"2x"],[500,"4x"]].map(([ms,lbl]) => (
                <button key={ms} onClick={() => setSpeed(ms)} style={{flex:1,padding:"4px",borderRadius:"2px",background:speed===ms?"#1a1a00":"transparent",border:`1px solid ${speed===ms?"#facc15":"#222"}`,color:speed===ms?"#facc15":"#333",cursor:"pointer",fontSize:"0.6rem",fontFamily:"'Share Tech Mono',monospace"}}>{lbl}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Current event summary */}
        {currentEvent && (
          <div>
            <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.12em",marginBottom:"8px"}}>CURRENT STEP</div>
            <div style={{background:"#0d0d0d",border:`1px solid ${(TIERS[currentEvent.threat_tier]||TIERS[1]).color}44`,borderRadius:"4px",padding:"10px 12px",fontFamily:"'Share Tech Mono',monospace"}}>
              <div style={{color:"#e8d5b0",fontSize:"0.72rem",lineHeight:"1.6",marginBottom:"6px"}}>
                {getHumanDescription(currentEvent)}
              </div>
              <div style={{color:"#444",fontSize:"0.58rem"}}>{formatTimestamp(currentEvent.timestamp)}</div>
            </div>
          </div>
        )}

        {/* Forensic detail panel — replaces old plain detail block */}
        {currentEvent && (
          <div>
            <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.12em",marginBottom:"8px"}}>FORENSIC ANALYSIS</div>
            <ForensicDetail detail={replayDetail} loading={detailLoading}/>
          </div>
        )}

        {/* Luffy commentary */}
        {currentEvent && (
          <div>
            <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.12em",marginBottom:"8px"}}>LUFFY'S ANALYSIS</div>
            <LuffyCommentary event={currentEvent} isPlaying={isPlaying}/>
          </div>
        )}

        {/* Attack phase legend */}
        <div style={{marginTop:"auto"}}>
          <div style={{color:"#222",fontSize:"0.56rem",letterSpacing:"0.12em",marginBottom:"8px"}}>ATTACK PHASES</div>
          {[
            ["Phase 1","Reconnaissance — trying to get in","#facc15"],
            ["Phase 2","Access — they got credentials",   "#fb923c"],
            ["Phase 3","Escalation — full admin control", "#f87171"],
            ["Phase 4","Persistence — surviving reboots", "#f87171"],
            ["Phase 5","Exfiltration — stealing data",    "#f87171"],
          ].map(([ph,label,color]) => (
            <div key={ph} style={{display:"flex",alignItems:"flex-start",gap:"8px",marginBottom:"5px"}}>
              <div style={{width:"5px",height:"5px",borderRadius:"50%",background:color,flexShrink:0,marginTop:"5px"}}/>
              <div>
                <span style={{color:"#555",fontSize:"0.58rem"}}>{ph}: </span>
                <span style={{color:"#333",fontSize:"0.58rem"}}>{label}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}