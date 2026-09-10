import { useState, useEffect, useRef, useCallback } from "react"
import axios from "axios"
import LuffyOverlay, { MOOD_CONFIG } from "./LuffyOverlay"
import ReplayTimeline from "./ReplayTimeline"
import EntityGraph from "./EntityGraph"
import FeatureImportance from "./Featureimportance"
import ResponseSimulation from "./Responsesimulation"
import { getHumanDescription, buildRichContext, buildEntitySummary, explainTier, formatTimestamp } from "./humanlog"
import { sanitizeField, parseCitations } from "./sanitize"

const API = "http://localhost:8000"

const TIERS = {
  1:{color:"#4ade80",bg:"#0a1f0f",label:"LOW",      word:"low-risk"},
  2:{color:"#facc15",bg:"#1a1400",label:"MEDIUM",   word:"moderate-risk"},
  3:{color:"#fb923c",bg:"#1a0e00",label:"HIGH",     word:"high-risk"},
  4:{color:"#f87171",bg:"#1a0505",label:"CRITICAL", word:"critical"},
}

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT BUILDER
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt(appState) {
  const { activeTab, selectedEvent, alerts, topEntity } = appState
  const currentTabName = {
    dashboard:"the main dashboard showing live event feed",
    graphs:   "the graphs and charts tab",
    luffy:    "the Luffy chat tab",
    entity:   "the entity relationship graph",
    features: "the feature importance analysis tab",
    response: "the response simulation tab",
    replay:   "the attack replay timeline tab",
  }[activeTab] || activeTab

  const selectedStr = selectedEvent
    ? `The user currently has this event selected: "${getHumanDescription(selectedEvent)}" (Threat: ${TIERS[selectedEvent.threat_tier]?.label})`
    : "No event is currently selected."

  const alertStr = alerts?.length > 0
    ? `There are ${alerts.length} active alert(s). Most severe: Tier ${alerts[0]?.threat_tier}.`
    : "No active alerts."

  const entityStr = topEntity
    ? `Most suspicious entity: "${sanitizeField(topEntity.entity)}" with ${topEntity.event_count} events at tier ${topEntity.max_tier}.`
    : ""

  return `You are Detective Luffy, the AI brain of a Windows forensic security application. You are both an analyst AND a controller — you explain what's happening AND take actions in the app.

CURRENT APP STATE:
- User is on: ${currentTabName}
- ${selectedStr}
- ${alertStr}
- ${entityStr}

YOUR PERSONALITY: Talk like Monkey D. Luffy — confident, direct, sometimes goofy, NEVER technical jargon. Explain everything in plain English anyone can understand.

YOUR ACTIONS (you MUST pick one):
- SWITCH_TAB + action_param: "dashboard"|"graphs"|"entity"|"features"|"response"|"replay"|"luffy"
- EXPLAIN_EVENT (explain the selected event in plain English)
- EXPLAIN_ENTITY (explain the most suspicious entity)
- START_REPLAY (go to replay tab)
- RUN_SCAN (trigger a security scan)
- BLOCK_ENTITY + action_param: entity name to block
- FILTER_HIGH (show only high/critical events)
- SHOW_HELP (list what Luffy can do)
- NONE (just talk, no navigation)

RESPONSE — always valid JSON, nothing else:
{"action":"SWITCH_TAB","action_param":"entity","message":"Let me show you the entity graph!","mood":"happy"}

Valid moods: idle, alert, thinking, happy, angry, goofy
Keep message under 180 chars. Be specific — mention names/IDs if you know them.`
}

// ─────────────────────────────────────────────────────────────
// INTEGRITY BADGE
// Polls /integrity every 30s and shows chain status in the header
// ─────────────────────────────────────────────────────────────
function IntegrityBadge() {
  const [status, setStatus] = useState(null)

  useEffect(() => {
    const fetch = async () => {
      try {
        const res = await axios.get(`${API}/integrity`)
        setStatus(res.data)
      } catch {
        setStatus(null)
      }
    }
    fetch()
    const id = setInterval(fetch, 30000)
    return () => clearInterval(id)
  }, [])

  if (!status) return null

  const valid   = status.valid
  const color   = valid ? "#4ade80" : "#f87171"
  const icon    = valid ? "⛓" : "⛓‍💥"
  const label   = valid ? "CHAIN INTACT" : "CHAIN BROKEN"
  const corruptedCount = Array.isArray(status.corrupted) ? status.corrupted.length : (status.corrupted || 0)
  const detail  = valid
    ? `${status.chain_length} events verified`
    : `${corruptedCount} corrupted · break at #${status.first_break}`

  return (
    <div title={status.summary} style={{
      display:"flex",alignItems:"center",gap:"5px",
      background:`${color}11`,border:`1px solid ${color}44`,
      borderRadius:"3px",padding:"3px 9px",cursor:"default",
    }}>
      <span style={{fontSize:"0.7rem"}}>{icon}</span>
      <div>
        <div style={{color,fontSize:"0.54rem",letterSpacing:"0.1em",fontWeight:"bold"}}>{label}</div>
        <div style={{color:`${color}88`,fontSize:"0.5rem"}}>{detail}</div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// WATCHDOG TOAST
// ─────────────────────────────────────────────────────────────
function WatchdogToast({ alerts, onDismissAll }) {
  useEffect(() => {
    if (!alerts.length) return
    const t = setTimeout(onDismissAll, 12000)
    return () => clearTimeout(t)
  }, [alerts, onDismissAll])

  if (!alerts.length) return null
  const top   = alerts[0]
  const t     = TIERS[top.threat_tier] || TIERS[3]
  const human = getHumanDescription(top)

  return (
    <div style={{
      position:"fixed",top:"14px",right:"320px",zIndex:9990,
      background:"#0d0d0d",border:`1.5px solid ${t.color}`,borderRadius:"6px",
      padding:"12px 16px",maxWidth:"420px",animation:"luffyFadeIn 0.3s ease",
      boxShadow:`0 0 24px ${t.color}44`,fontFamily:"'Share Tech Mono',monospace",
    }}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:"12px"}}>
        <div>
          <div style={{color:t.color,fontSize:"0.62rem",letterSpacing:"0.15em",marginBottom:"4px",fontWeight:"bold"}}>
            ⚠ {alerts.length} NEW ALERT{alerts.length>1?"S":""}
          </div>
          <div style={{color:"#e8d5b0",fontSize:"0.72rem",lineHeight:"1.5"}}>{human}</div>
          <div style={{color:"#555",fontSize:"0.6rem",marginTop:"4px"}}>
            {formatTimestamp(top.timestamp)} · {t.label} threat
          </div>
        </div>
        <button onClick={onDismissAll} style={{background:"transparent",border:"none",color:"#444",cursor:"pointer",fontSize:"0.8rem",flexShrink:0}}>✕</button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// EVENT ROW — with cluster label badge
// ─────────────────────────────────────────────────────────────
function EventRow({ event, isSelected, onClick }) {
  const t     = TIERS[event.threat_tier] || TIERS[1]
  const human = getHumanDescription(event)
  const ts    = formatTimestamp(event.timestamp)
  const cluster = sanitizeField(event.cluster_label || "")

  let raw = {}
  try { raw = JSON.parse(event.raw_data || "{}") } catch {}

  return (
    <div
      onClick={onClick}
      style={{
        padding:"10px 16px",borderBottom:"1px solid #0d0d0d",
        background:isSelected ? t.bg : "transparent",
        borderLeft:`3px solid ${isSelected ? t.color : t.color+"33"}`,
        cursor:"pointer",transition:"all 0.15s",
      }}
      onMouseEnter={e => e.currentTarget.style.background = t.bg}
      onMouseLeave={e => e.currentTarget.style.background = isSelected ? t.bg : "transparent"}
    >
      {raw.phase && (
        <div style={{
          display:"inline-block",background:"#1a0505",border:"1px solid #f8717144",
          color:"#f87171",fontSize:"0.54rem",padding:"1px 7px",borderRadius:"2px",
          marginBottom:"4px",letterSpacing:"0.1em",
        }}>{sanitizeField(raw.phase)}</div>
      )}
      <div style={{color:"#e8d5b0",fontSize:"0.74rem",lineHeight:"1.5",marginBottom:"4px"}}>
        {human}
      </div>
      <div style={{display:"flex",alignItems:"center",gap:"8px",flexWrap:"wrap"}}>
        <span style={{background:t.bg,border:`1px solid ${t.color}44`,color:t.color,fontSize:"0.56rem",padding:"1px 7px",borderRadius:"2px",fontWeight:"bold"}}>{t.label}</span>
        {/* Cluster label badge — new */}
        {cluster && (
          <span style={{background:"#0d0d1a",border:"1px solid #3a3a6a",color:"#8888cc",fontSize:"0.54rem",padding:"1px 7px",borderRadius:"2px"}}>
            {cluster}
          </span>
        )}
        <span style={{color:"#444",fontSize:"0.6rem"}}>{ts}</span>
        <span style={{color:"#333",fontSize:"0.58rem"}}>[{sanitizeField(event.source)}]</span>
        <span style={{color:t.color,fontSize:"0.6rem",marginLeft:"auto"}}>Score: {Math.round((event.anomaly_score||0)*100)}%</span>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// UNBLOCK BUTTON — calls /unblock-entity
// ─────────────────────────────────────────────────────────────
function UnblockButton({ entity, onDone }) {
  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState(null)

  const handleUnblock = async () => {
    setLoading(true)
    try {
      const res = await axios.post(`${API}/unblock-entity`, {
        entity,
        entity_type:  "auto",
        triggered_by: "ui",
      })
      setResult(res.data.success ? "unblocked" : "failed")
      if (res.data.success && onDone) onDone()
    } catch {
      setResult("failed")
    }
    setLoading(false)
  }

  if (result === "unblocked") return (
    <div style={{color:"#4ade80",fontSize:"0.62rem",padding:"6px 0"}}>✓ Unblocked successfully</div>
  )
  if (result === "failed") return (
    <div style={{color:"#f87171",fontSize:"0.62rem",padding:"6px 0"}}>⚠ Unblock failed — check backend</div>
  )

  return (
    <button onClick={handleUnblock} disabled={loading} style={{
      width:"100%",padding:"7px",borderRadius:"3px",marginTop:"6px",
      background:"#0a1f0f",border:"1px solid #4ade80",color:"#4ade80",
      cursor:loading?"not-allowed":"pointer",fontSize:"0.65rem",
      fontFamily:"'Share Tech Mono',monospace",transition:"all 0.2s",
      opacity: loading ? 0.6 : 1,
    }}>
      {loading ? "Unblocking..." : "🔓 Unblock this entity"}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────
// EVENT DETAIL PANEL — with integrity badge + unblock UI
// ─────────────────────────────────────────────────────────────
function EventDetail({ event, onAskLuffy, onBlockEntity }) {
  const [blocked,    setBlocked]    = useState(false)
  const [blocking,   setBlocking]   = useState(false)
  const [integrity,  setIntegrity]  = useState(null)

  useEffect(() => {
    setBlocked(false)
    setIntegrity(null)
    if (!event?.id) return
    // Fetch single-event integrity status for the badge
    axios.get(`${API}/integrity/event/${event.id}`)
      .then(r => setIntegrity(r.data))
      .catch(() => setIntegrity(null))
  }, [event?.id])

  if (!event) return (
    <div style={{color:"#1a1a1a",textAlign:"center",padding:"40px 20px",fontSize:"0.72rem",lineHeight:"2",fontFamily:"'Share Tech Mono',monospace"}}>
      Click any event<br/>to see a plain-English<br/>explanation here
    </div>
  )

  const t   = TIERS[event.threat_tier] || TIERS[1]
  const ctx = buildRichContext(event)
  const ts  = formatTimestamp(event.timestamp)

  // Entity name for block/unblock
  const entityName = ctx.entity || ctx.computer || sanitizeField(event.source) || ""

  const handleBlock = async () => {
    if (!entityName) return
    setBlocking(true)
    try {
      await axios.post(`${API}/block-entity`, {
        entity:       entityName,
        entity_type:  "auto",
        reason:       `Blocked from event detail — DB-ID:${event.id}`,
        threat_tier:  event.threat_tier,
        event_db_id:  event.id,
        triggered_by: "ui",
      })
      setBlocked(true)
      if (onBlockEntity) onBlockEntity(entityName)
    } catch {
      // still mark as attempted
    }
    setBlocking(false)
  }

  // Integrity indicator for this specific event
  const integrityColor = integrity?.valid === true  ? "#4ade80"
                       : integrity?.valid === false ? "#f87171"
                       : "#444"
  const integrityLabel = integrity?.valid === true  ? "✓ HASH VERIFIED"
                       : integrity?.valid === false ? "✗ HASH MISMATCH"
                       : integrity?.valid === null  ? "— LEGACY EVENT"
                       : "CHECKING…"

  return (
    <div style={{fontFamily:"'Share Tech Mono',monospace"}}>
      {/* Integrity badge */}
      <div style={{
        display:"flex",alignItems:"center",gap:"6px",marginBottom:"10px",
        padding:"5px 8px",background:"#0a0a0a",border:`1px solid ${integrityColor}33`,borderRadius:"3px",
      }}>
        <span style={{color:integrityColor,fontSize:"0.56rem",fontWeight:"bold"}}>{integrityLabel}</span>
        {integrity?.event_hash && (
          <span style={{color:"#333",fontSize:"0.5rem",letterSpacing:"0.05em"}}>
            {integrity.event_hash.slice(0,12)}…
          </span>
        )}
      </div>

      {/* Threat level */}
      <div style={{background:t.bg,border:`1px solid ${t.color}`,borderRadius:"4px",padding:"8px 12px",marginBottom:"12px",boxShadow:`0 0 12px ${t.color}22`}}>
        <div style={{color:t.color,fontSize:"0.6rem",letterSpacing:"0.15em",marginBottom:"2px"}}>THREAT LEVEL</div>
        <div style={{color:t.color,fontSize:"0.85rem",fontFamily:"'Orbitron',monospace",fontWeight:"bold"}}>{t.label}</div>
        <div style={{color:"#888",fontSize:"0.6rem",marginTop:"2px"}}>{explainTier(event.threat_tier)}</div>
      </div>

      {/* Cluster label */}
      {ctx.cluster_label && (
        <div style={{marginBottom:"10px"}}>
          <div style={{color:"#333",fontSize:"0.56rem",letterSpacing:"0.12em",marginBottom:"4px"}}>BEHAVIOUR CLUSTER</div>
          <div style={{background:"#0d0d1a",border:"1px solid #3a3a6a",borderRadius:"3px",padding:"5px 10px",color:"#8888cc",fontSize:"0.66rem"}}>
            {ctx.cluster_label}
          </div>
        </div>
      )}

      {/* What happened */}
      <div style={{marginBottom:"12px"}}>
        <div style={{color:"#333",fontSize:"0.56rem",letterSpacing:"0.12em",marginBottom:"6px"}}>WHAT HAPPENED</div>
        <div style={{background:"#0d0d0d",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"10px 12px",color:"#e8d5b0",fontSize:"0.72rem",lineHeight:"1.7"}}>
          {ctx.plain_english}
        </div>
      </div>

      {ctx.investigation_hint && (
        <div style={{marginBottom:"12px"}}>
          <div style={{color:"#333",fontSize:"0.56rem",letterSpacing:"0.12em",marginBottom:"6px"}}>WHAT TO INVESTIGATE</div>
          <div style={{background:"#0d0505",border:"1px solid #2a1a1a",borderRadius:"4px",padding:"10px 12px",color:"#c8b890",fontSize:"0.68rem",lineHeight:"1.6"}}>
            {ctx.investigation_hint}
          </div>
        </div>
      )}

      {ctx.attack_phase && (
        <div style={{marginBottom:"12px"}}>
          <div style={{color:"#333",fontSize:"0.56rem",letterSpacing:"0.12em",marginBottom:"6px"}}>ATTACK PHASE</div>
          <div style={{background:"#1a0505",border:"1px solid #f8717144",borderRadius:"4px",padding:"8px 12px",color:"#f87171",fontSize:"0.68rem",lineHeight:"1.5"}}>
            {sanitizeField(ctx.attack_phase)}
          </div>
        </div>
      )}

      {/* Key facts */}
      <div style={{marginBottom:"14px"}}>
        <div style={{color:"#333",fontSize:"0.56rem",letterSpacing:"0.12em",marginBottom:"6px"}}>KEY FACTS</div>
        <div style={{display:"flex",flexDirection:"column",gap:"4px"}}>
          {[
            ["Time",          ts],
            ["Anomaly Score", `${ctx.anomaly_score}% suspicious`],
            ["Source",        ctx.source],
            ctx.entity     && ["Account",    ctx.entity],
            ctx.ip_address && ["IP Address", ctx.ip_address],
            ctx.computer   && ["Computer",   ctx.computer],
          ].filter(Boolean).map(([k,v]) => (
            <div key={k} style={{display:"flex",gap:"8px",fontSize:"0.62rem"}}>
              <span style={{color:"#333",minWidth:"100px",flexShrink:0}}>{k}</span>
              <span style={{color:"#c8b890"}}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Action buttons */}
      <button onClick={() => onAskLuffy && onAskLuffy(event)} style={{
        width:"100%",padding:"9px",borderRadius:"3px",marginBottom:"6px",
        background:t.bg,border:`1px solid ${t.color}`,color:t.color,
        cursor:"pointer",fontSize:"0.68rem",fontFamily:"'Share Tech Mono',monospace",transition:"all 0.2s",
      }}>🔍 Ask Luffy to explain this</button>

      {/* Block button — only show for tier 2+ events with an entity */}
      {entityName && event.threat_tier >= 2 && !blocked && (
        <button onClick={handleBlock} disabled={blocking} style={{
          width:"100%",padding:"9px",borderRadius:"3px",marginBottom:"6px",
          background:"#1a0505",border:"1px solid #f87171",color:"#f87171",
          cursor:blocking?"not-allowed":"pointer",fontSize:"0.68rem",
          fontFamily:"'Share Tech Mono',monospace",transition:"all 0.2s",
          opacity:blocking ? 0.6 : 1,
        }}>
          {blocking ? "Blocking..." : `🔒 Block "${entityName}"`}
        </button>
      )}

      {/* Unblock UI — shown after blocking, or for already-blocked entities */}
      {blocked && entityName && (
        <UnblockButton entity={entityName} onDone={() => setBlocked(false)} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// CITATION RENDERER — converts [1] markers to styled spans
// ─────────────────────────────────────────────────────────────
function CitedText({ text, onCitationClick }) {
  if (!text) return null
  const { cleanText, citations } = parseCitations(text)

  // Split on [N] markers and intersperse citation links
  const parts = cleanText.split(/(\[\d+\])/)
  return (
    <span>
      {parts.map((part, i) => {
        const match = part.match(/^\[(\d+)\]$/)
        if (match) {
          const idx = parseInt(match[1]) - 1
          const cit = citations[idx]
          return (
            <sup key={i}
              onClick={() => cit && onCitationClick && onCitationClick(cit)}
              title={cit ? `${cit.type === "db_id" ? "DB" : "EventID"}: ${cit.id}` : ""}
              style={{
                color:"#fb923c",cursor:cit?"pointer":"default",
                fontSize:"0.7em",marginLeft:"1px",
                textDecoration:"underline",textDecorationStyle:"dotted",
              }}
            >[{match[1]}]</sup>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────
// GRAPH DASHBOARD
// ─────────────────────────────────────────────────────────────
function GraphDashboard({ events, onBarClick }) {
  const tierCounts = {1:0,2:0,3:0,4:0}
  events.forEach(e => { tierCounts[e.threat_tier] = (tierCounts[e.threat_tier]||0)+1 })
  const tierData = Object.entries(tierCounts).map(([k,v]) => ({name:TIERS[k]?.label||k,value:v,color:TIERS[k]?.color||"#888",tier:Number(k)}))

  const hourCounts = {}
  events.slice(0,60).forEach(e => {
    const ts  = e.timestamp || ""
    const key = ts.length >= 13 ? ts.slice(0,13) : (ts||"?")
    hourCounts[key] = (hourCounts[key]||0)+1
  })
  const timelineData = Object.entries(hourCounts).slice(-12).map(([k,v]) => ({label:k.slice(11)||k.slice(8,10),value:v}))

  const eidCounts = {}
  events.forEach(e => {
    try {
      const raw = JSON.parse(e.raw_data||"{}")
      const eid = raw.EventID
      if (eid == null) return
      const human = getHumanDescription(e)
      let key
      if (human.startsWith("📋")) {
        // fallback template fired — use event source + id
        const src = sanitizeField(e.source || raw.SourceName || "")
        key = `#${eid}${src ? " · " + src.slice(0,14) : ""}`
      } else {
        const emoji = human.match(/^(\S+)/)?.[1] || ""
        const desc  = human.replace(/^[^\s]+\s/,"").split(/[\u2014\u2013\-]/)[0].trim().slice(0,30)
        key = `${emoji} ${desc}`
      }
      eidCounts[key] = (eidCounts[key]||0)+1
    } catch {}
  })
  const eidData = Object.entries(eidCounts).sort((a,b) => b[1]-a[1]).slice(0,8).map(([k,v]) => ({name:k,value:v}))

  // Cluster breakdown
  const clusterCounts = {}
  events.forEach(e => {
    const cl = sanitizeField(e.cluster_label || "Unknown")
    if (cl) clusterCounts[cl] = (clusterCounts[cl]||0)+1
  })
  const clusterData = Object.entries(clusterCounts).sort((a,b) => b[1]-a[1]).slice(0,6)

  const maxTimeline = Math.max(...timelineData.map(d=>d.value),1)
  const maxEid      = Math.max(...eidData.map(d=>d.value),1)
  const maxTierVal  = Math.max(...tierData.map(d=>d.value),1)
  const maxCluster  = Math.max(...clusterData.map(([,v])=>v),1)

  return (
    <div style={{width:"100%",height:"100%",overflowY:"auto",padding:"16px",boxSizing:"border-box",display:"flex",flexDirection:"column",gap:"12px"}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"12px",flexShrink:0}}>
        {/* Threat tiers */}
        <div style={{background:"#080808",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"14px"}}>
          <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.15em",marginBottom:"12px"}}>THREAT LEVEL BREAKDOWN</div>
          {tierData.map(d => (
            <div key={d.name} onClick={() => onBarClick&&onBarClick(d.tier)} style={{marginBottom:"8px",cursor:"pointer"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:"2px"}}>
                <span style={{color:d.color,fontSize:"0.62rem"}}>{d.name}</span>
                <span style={{color:d.color,fontSize:"0.62rem",fontFamily:"'Orbitron',monospace"}}>{d.value}</span>
              </div>
              <div style={{height:"5px",background:"#111",borderRadius:"3px",overflow:"hidden"}}>
                <div style={{width:`${(d.value/maxTierVal)*100}%`,height:"100%",background:d.color,transition:"width 0.5s"}}/>
              </div>
            </div>
          ))}
        </div>

        {/* Activity over time */}
        <div style={{background:"#080808",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"14px"}}>
          <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.15em",marginBottom:"12px"}}>ACTIVITY OVER TIME</div>
          {timelineData.length===0
            ? <div style={{color:"#1a1a1a",fontSize:"0.68rem",textAlign:"center",paddingTop:"30px"}}>No data yet</div>
            : <div style={{display:"flex",alignItems:"flex-end",gap:"4px",height:"120px"}}>
                {timelineData.map((d,i) => (
                  <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:"3px"}}>
                    <div style={{width:"100%",background:"#fb923c",borderRadius:"2px 2px 0 0",height:`${(d.value/maxTimeline)*100}px`,minHeight:"3px",transition:"height 0.5s"}}/>
                    <span style={{color:"#333",fontSize:"0.5rem",writingMode:"vertical-rl",transform:"rotate(180deg)",maxHeight:"28px",overflow:"hidden"}}>{d.label}</span>
                  </div>
                ))}
              </div>
          }
        </div>
      </div>

      {/* Cluster breakdown — hide if only Unknown */}
      {clusterData.length > 0 && !(clusterData.length === 1 && clusterData[0][0] === "Unknown") && (
        <div style={{background:"#080808",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"14px",flexShrink:0}}>
          <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.15em",marginBottom:"12px"}}>BEHAVIOUR CLUSTERS (ML)</div>
          {clusterData.map(([label, count]) => (
            <div key={label} style={{marginBottom:"7px"}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:"2px"}}>
                <span style={{color:"#8888cc",fontSize:"0.62rem"}}>{label}</span>
                <span style={{color:"#8888cc",fontSize:"0.62rem",fontFamily:"'Orbitron',monospace"}}>{count}×</span>
              </div>
              <div style={{height:"4px",background:"#111",borderRadius:"2px",overflow:"hidden"}}>
                <div style={{width:`${(count/maxCluster)*100}%`,height:"100%",background:"#5555aa",transition:"width 0.5s"}}/>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Most common events */}
      <div style={{background:"#080808",border:"1px solid #1a1a1a",borderRadius:"4px",padding:"14px",flexShrink:0}}>
        <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.15em",marginBottom:"12px"}}>MOST COMMON EVENTS (plain English)</div>
        {eidData.map((d,i) => (
          <div key={i} style={{marginBottom:"7px"}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:"2px"}}>
              <span style={{color:"#e8d5b0",fontSize:"0.64rem",flex:1,paddingRight:"8px"}}>{d.name}</span>
              <span style={{color:"#fb923c",fontSize:"0.62rem",fontFamily:"'Orbitron',monospace",flexShrink:0}}>{d.value}×</span>
            </div>
            <div style={{height:"3px",background:"#111",borderRadius:"2px",overflow:"hidden"}}>
              <div style={{width:`${(d.value/maxEid)*100}%`,height:"100%",background:"#fb923c44",transition:"width 0.5s"}}/>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// LUFFY CHAT TAB
// ─────────────────────────────────────────────────────────────
function LuffyTab({ chatHistory, chatInput, setChatInput, sendChat, chatLoading }) {
  const endRef = useRef(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior:"smooth" }) }, [chatHistory])

  const handleKeyDown = e => {
    if (e.key==="Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      sendChat()
    }
  }

  return (
    <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
      <div style={{flex:1,overflowY:"auto",padding:"16px",display:"flex",flexDirection:"column",gap:"10px"}}>
        {chatHistory.length===0 && (
          <div style={{color:"#222",textAlign:"center",marginTop:"40px",fontSize:"0.72rem",lineHeight:"2.5",fontFamily:"'Share Tech Mono',monospace"}}>
            <div style={{fontSize:"2rem",marginBottom:"8px"}}>🏴‍☠️</div>
            <div style={{color:"#444"}}>Luffy is watching your system.</div>
            <div style={{color:"#1a1a1a",fontSize:"0.62rem",marginTop:"16px",lineHeight:"2"}}>
              "explain this event" · "show critical threats"<br/>
              "replay the attack" · "who is most suspicious?"<br/>
              "block [name]" · "run a scan"
            </div>
          </div>
        )}
        {chatHistory.map((msg,i) => (
          <div key={i} style={{display:"flex",flexDirection:"column",alignItems:msg.role==="user"?"flex-end":"flex-start"}}>
            <div style={{
              maxWidth:"82%",padding:"10px 14px",borderRadius:"8px",
              background:msg.role==="user"?"#1a1a0a":"#080808",
              border:`1px solid ${msg.role==="user"?"#facc1544":"#1a1a1a"}`,
              color:msg.role==="user"?"#e8d5b0":"#c8b890",
              fontSize:"0.74rem",lineHeight:"1.6",fontFamily:"'Share Tech Mono',monospace",
            }}>
              {msg.role==="assistant" && <div style={{color:"#fb923c",fontSize:"0.56rem",letterSpacing:"0.15em",marginBottom:"4px"}}>LUFFY //</div>}
              {msg.role==="assistant"
                ? <CitedText text={msg.content} onCitationClick={cit => console.log("Citation clicked:", cit)} />
                : msg.content
              }
            </div>
          </div>
        ))}
        {chatLoading && (
          <div style={{display:"flex",alignItems:"center",gap:"8px",color:"#444",fontSize:"0.68rem",fontFamily:"'Share Tech Mono',monospace"}}>
            <div style={{display:"flex",gap:"3px"}}>
              {[0,1,2].map(i => <div key={i} style={{width:"6px",height:"6px",borderRadius:"50%",background:"#fb923c",animation:`luffyBlink ${0.6+i*0.2}s infinite`}}/>)}
            </div>
            Luffy is thinking...
          </div>
        )}
        <div ref={endRef}/>
      </div>
      <div style={{padding:"12px 16px",borderTop:"1px solid #1a1a1a",display:"flex",gap:"8px"}}>
        <input
          value={chatInput}
          onChange={e => setChatInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder='Ask anything — "block this", "explain the attack", "show critical events"...'
          disabled={chatLoading}
          style={{flex:1,background:"#0d0d0d",border:"1px solid #2a2a2a",borderRadius:"4px",padding:"10px 14px",color:"#e8d5b0",fontSize:"0.72rem",fontFamily:"'Share Tech Mono',monospace",outline:"none"}}
        />
        <button
          onClick={sendChat}
          disabled={chatLoading||!chatInput.trim()}
          style={{
            padding:"10px 18px",borderRadius:"4px",
            background:chatLoading?"#111":"#1a0e00",
            border:`1px solid ${chatLoading?"#222":"#fb923c"}`,
            color:chatLoading?"#333":"#fb923c",
            cursor:chatLoading?"not-allowed":"pointer",
            fontSize:"0.72rem",fontFamily:"'Share Tech Mono',monospace",transition:"all 0.2s",
          }}
        >{chatLoading?"...":"SEND ▶"}</button>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────
export default function App() {
  const [events,         setEvents]         = useState([])
  const [filteredEvents, setFilteredEvents] = useState([])
  const [activeTab,      setActiveTab]      = useState("dashboard")
  const [selectedEvent,  setSelectedEvent]  = useState(null)
  const [alerts,         setAlerts]         = useState([])
  const [chatHistory,    setChatHistory]    = useState([])
  const [chatInput,      setChatInput]      = useState("")
  const [chatLoading,    setChatLoading]    = useState(false)
  const [luffyState,     setLuffyState]     = useState("idle")
  const [luffyMessage,   setLuffyMessage]   = useState(null)
  const [topEntity,      setTopEntity]      = useState(null)
  const [filterTier,     setFilterTier]     = useState(0)
  const [actionFeedback, setActionFeedback] = useState(null)
  const [watcherActive,  setWatcherActive]  = useState(false)

  const prevCountRef = useRef(0)

  // ── Fetch events + entities ─────────────────────────────────
  const fetchAll = useCallback(async () => {
    try {
      const [evRes, entRes] = await Promise.allSettled([
        axios.get(`${API}/events`),
        axios.get(`${API}/entities`),
      ])
      if (evRes.status==="fulfilled") {
        const evs = evRes.value.data.events || []
        setEvents(evs)
        const maxTier = evs.reduce((acc,e) => Math.max(acc,e.threat_tier||1),1)
        setLuffyState(maxTier>=4?"angry":maxTier>=3?"alert":maxTier>=2?"thinking":"idle")
        prevCountRef.current = evs.length
      }
      if (entRes.status==="fulfilled") {
        const entities = entRes.value.data.entities||[]
        if (entities.length>0) {
          const sorted=[...entities].sort((a,b) => (b.max_tier-a.max_tier)||(b.event_count-a.event_count))
          setTopEntity(sorted[0])
        }
      }
    } catch(e) { console.error("fetchAll:",e) }
  }, [])

  useEffect(() => {
    fetchAll()
    const id = setInterval(fetchAll, 60000)
    return () => clearInterval(id)
  }, [fetchAll])

  // ── Real-time watchdog — polls every 5s ─────────────────────
  // Replaces the old 60s fetchAll-based alert detection.
  // /watchdog returns new_critical_events that were scored in real-time
  // by the backend's EvtSubscribe watcher.
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await axios.get(`${API}/watchdog`)
        const d   = res.data
        setWatcherActive(d.watcher_active || false)

        if (d.has_alerts && d.new_critical_events?.length > 0) {
          setAlerts(d.new_critical_events)
          const top = d.new_critical_events[0]
          setLuffyMessage(`Alert! ${getHumanDescription(top)}`)
          setLuffyState(top.threat_tier >= 4 ? "angry" : "alert")
        }
      } catch { /* backend offline — silent */ }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [])

  // ── Filter ──────────────────────────────────────────────────
  useEffect(() => {
    if (filterTier===0) setFilteredEvents(events)
    else setFilteredEvents(events.filter(e => e.threat_tier>=filterTier))
  }, [filterTier, events])

  // ── Action dispatcher ───────────────────────────────────────
  const showFeedback = useCallback((msg) => {
    setActionFeedback(msg)
    setTimeout(() => setActionFeedback(null), 3500)
  }, [])

  const dispatchAction = useCallback(async (action, param) => {
    switch(action) {
      case "SWITCH_TAB":
        if(param) setActiveTab(param)
        break
      case "EXPLAIN_EVENT": {
        if(!selectedEvent){setLuffyMessage("Click on an event first so I know which one!");break}
        const ctx=buildRichContext(selectedEvent)
        setLuffyMessage(`${ctx.plain_english} Threat: ${ctx.threat_level}. ${ctx.investigation_hint}`)
        setActiveTab("luffy")
        break
      }
      case "EXPLAIN_ENTITY": {
        if(!topEntity){setLuffyMessage("No suspicious entities found yet. Run a scan first!");break}
        setLuffyMessage(buildEntitySummary(topEntity))
        setActiveTab("entity")
        break
      }
      case "START_REPLAY":
        setActiveTab("replay")
        showFeedback("⏵ Switched to Attack Replay")
        break
      case "RUN_SCAN":
        showFeedback("🔍 Scanning...")
        setLuffyState("thinking")
        try {
          await axios.post(`${API}/scan`)
          await fetchAll()
          showFeedback("✅ Scan complete")
        } catch {
          showFeedback("⚠ Scan failed — check backend")
        }
        break
      case "BLOCK_ENTITY": {
        const target=param||topEntity?.entity
        if(!target){setLuffyMessage("Tell me who to block — use a name or click an entity first.");break}
        showFeedback(`🔒 Blocking "${sanitizeField(target)}"...`)
        try {
          await axios.post(`${API}/block-entity`,{
            entity:       target,
            entity_type:  "auto",
            triggered_by: "luffy",
          })
          showFeedback(`✅ "${sanitizeField(target)}" blocked`)
          setLuffyMessage(`Done! "${sanitizeField(target)}" is blocked. They won't be sneaking around anymore!`)
        } catch {
          showFeedback(`⚠ Block failed — check backend`)
        }
        break
      }
      case "FILTER_HIGH":
        setFilterTier(3)
        setActiveTab("dashboard")
        showFeedback("🔴 Showing HIGH + CRITICAL only")
        break
      case "SHOW_HELP":
        setLuffyMessage("I can: explain events, show critical threats, replay the attack, identify suspicious entities, run scans, block entities. Just tell me what you want!")
        break
      default: break
    }
  }, [selectedEvent, topEntity, fetchAll, showFeedback])

  // ── Command router ──────────────────────────────────────────
  const sendChat = useCallback(async () => {
    const msg=chatInput.trim()
    if(!msg||chatLoading)return
    setChatInput("")
    setChatLoading(true)
    setLuffyState("thinking")
    setChatHistory(h => [...h,{role:"user",content:msg}])

    const appState    = {activeTab,selectedEvent,alerts,topEntity}
    const systemPrompt = buildSystemPrompt(appState)
    const userContent  = selectedEvent
      ? `${msg}\n\n[SELECTED EVENT: ${JSON.stringify(buildRichContext(selectedEvent))}]`
      : msg

    try {
      const res=await axios.post(`${API}/chat`,{
        messages:[
          ...chatHistory.map(m => ({role:m.role,content:m.content})),
          {role:"user",content:userContent},
        ],
        system:systemPrompt,
      })
      const raw=res.data.reply||res.data.response||res.data.message||""
      let parsed=null
      try { parsed=JSON.parse(raw.replace(/```json|```/g,"").trim()) } catch {}

      if(parsed?.action){
        await dispatchAction(parsed.action,parsed.action_param)
        if(parsed.mood)    setLuffyState(parsed.mood)
        if(parsed.message) setLuffyMessage(parsed.message)
        setChatHistory(h => [...h,{role:"assistant",content:parsed.message||raw}])
      } else {
        setChatHistory(h => [...h,{role:"assistant",content:raw}])
        setLuffyMessage(raw.slice(0,200))
      }
    } catch {
      setChatHistory(h => [...h,{role:"assistant",content:"Something went wrong! Is the backend running?"}])
      setLuffyState("goofy")
    } finally {
      setChatLoading(false)
    }
  }, [chatInput,chatLoading,chatHistory,activeTab,selectedEvent,alerts,topEntity,dispatchAction])

  // ── Event click ─────────────────────────────────────────────
  const handleEventClick = useCallback((event) => {
    setSelectedEvent(event)
    const ctx=buildRichContext(event)
    const parts=[
      ctx.plain_english,
      ctx.attack_phase ? ` This is part of ${ctx.attack_phase}.` : "",
      ctx.anomaly_score>=80 ? ` ${ctx.anomaly_score}% anomaly score — really suspicious!` : ` Anomaly score: ${ctx.anomaly_score}%.`,
      ` ${ctx.investigation_hint}`,
    ]
    setLuffyMessage(parts.join(""))
    setLuffyState(ctx.threat_level==="CRITICAL"?"angry":ctx.threat_level==="HIGH"?"alert":ctx.threat_level==="MEDIUM"?"thinking":"idle")
  }, [])

  const handleGraphClick   = useCallback((ev) => {handleEventClick(ev);setActiveTab("luffy")},[handleEventClick])
  const handleFeatureClick = useCallback((ev) => {handleEventClick(ev);setActiveTab("luffy")},[handleEventClick])
  const handleAskLuffy     = useCallback((ev) => {
    setSelectedEvent(ev)
    setActiveTab("luffy")
    const ctx=buildRichContext(ev)
    setChatInput(`Explain this: ${ctx.plain_english}`)
  },[])

  // ── Render ──────────────────────────────────────────────────
  const tabs = [
    {id:"dashboard",label:"EVENTS",    icon:"◈"},
    {id:"graphs",   label:"GRAPHS",    icon:"▦"},
    {id:"entity",   label:"ENTITIES",  icon:"◉"},
    {id:"features", label:"ML SCORES", icon:"⊞"},
    {id:"response", label:"RESPONSE",  icon:"⊕"},
    {id:"replay",   label:"REPLAY",    icon:"▶"},
    {id:"luffy",    label:"ASK LUFFY", icon:"🏴‍☠️"},
  ]

  return (
    <div style={{height:"100vh",display:"flex",flexDirection:"column",background:"#050508",color:"#e8d5b0",fontFamily:"'Share Tech Mono',monospace",position:"relative",overflow:"hidden"}}>
      <div className="grid-bg"/>

      {/* Header */}
      <div style={{padding:"10px 20px",borderBottom:"1px solid #1a1a1a",display:"flex",alignItems:"center",justifyContent:"space-between",flexShrink:0,zIndex:10,background:"rgba(5,5,8,0.98)"}}>
        <div>
          <div style={{fontFamily:"'Orbitron',monospace",fontSize:"1.1rem",color:"#e8d5b0",letterSpacing:"0.1em"}}>FORENSIC DETECTIVE</div>
          <div style={{color:"#333",fontSize:"0.56rem",letterSpacing:"0.2em",display:"flex",alignItems:"center",gap:"8px"}}>
            <span>AI-POWERED · LUFFY MODE</span>
            {/* Real-time watcher status dot */}
            <span style={{display:"flex",alignItems:"center",gap:"3px"}}>
              <span style={{width:"5px",height:"5px",borderRadius:"50%",background:watcherActive?"#4ade80":"#444",display:"inline-block",boxShadow:watcherActive?"0 0 6px #4ade80":""}}/>
              <span style={{color:watcherActive?"#4ade8088":"#333",fontSize:"0.52rem"}}>{watcherActive?"LIVE":"OFFLINE"}</span>
            </span>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:"10px"}}>
          {/* Integrity badge */}
          <IntegrityBadge/>

          {/* Tier filter */}
          <div style={{display:"flex",gap:"4px"}}>
            {[[0,"ALL","#555"],[3,"HIGH+","#fb923c"],[4,"CRITICAL","#f87171"]].map(([v,l,c]) => (
              <button key={v} onClick={() => setFilterTier(v)} style={{padding:"3px 8px",borderRadius:"2px",fontSize:"0.58rem",cursor:"pointer",background:filterTier===v?`${c}18`:"transparent",border:`1px solid ${filterTier===v?c:"#111"}`,color:filterTier===v?c:"#222"}}>{l}</button>
            ))}
          </div>

          {/* Tier counts */}
          {[4,3].map(tier => {
            const count=events.filter(e=>e.threat_tier===tier).length
            if(!count)return null
            return <div key={tier} style={{display:"flex",alignItems:"center",gap:"4px",background:`${TIERS[tier].color}11`,border:`1px solid ${TIERS[tier].color}44`,borderRadius:"3px",padding:"3px 8px"}}><span style={{color:TIERS[tier].color,fontSize:"0.62rem"}}>{count} {TIERS[tier].label}</span></div>
          })}

          <button onClick={() => dispatchAction("RUN_SCAN")} style={{padding:"5px 12px",borderRadius:"3px",background:"transparent",border:"1px solid #2a2a2a",color:"#444",cursor:"pointer",fontSize:"0.62rem"}}>SCAN NOW</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={{display:"flex",borderBottom:"1px solid #1a1a1a",flexShrink:0,zIndex:10,background:"rgba(5,5,8,0.98)"}}>
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{padding:"9px 16px",background:"transparent",border:"none",borderBottom:`2px solid ${activeTab===tab.id?"#fb923c":"transparent"}`,color:activeTab===tab.id?"#fb923c":"#333",cursor:"pointer",fontSize:"0.62rem",letterSpacing:"0.12em",fontFamily:"'Share Tech Mono',monospace",transition:"all 0.2s",display:"flex",alignItems:"center",gap:"6px"}}>
            <span>{tab.icon}</span><span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Action feedback toast */}
      {actionFeedback && (
        <div style={{position:"fixed",top:"60px",left:"50%",transform:"translateX(-50%)",background:"#0d0d0d",border:"1px solid #fb923c",borderRadius:"4px",padding:"8px 18px",color:"#fb923c",fontSize:"0.68rem",fontFamily:"'Share Tech Mono',monospace",zIndex:9999,animation:"luffyFadeIn 0.2s ease",boxShadow:"0 0 16px #fb923c33"}}>
          {actionFeedback}
        </div>
      )}

      <WatchdogToast alerts={alerts} onDismissAll={() => setAlerts([])}/>

      {/* Content */}
      <div style={{flex:1,overflow:"hidden",display:"flex",position:"relative",zIndex:1}}>
        {activeTab==="dashboard" && (
          <div style={{display:"flex",width:"100%",height:"100%",overflow:"hidden"}}>
            <div style={{flex:1,overflowY:"auto"}}>
              {filteredEvents.length===0
                ? <div style={{color:"#333",textAlign:"center",padding:"60px",fontSize:"0.8rem"}}>No events yet. Run a scan or inject demo attack.</div>
                : filteredEvents.map(ev => <EventRow key={ev.id} event={ev} isSelected={selectedEvent?.id===ev.id} onClick={() => handleEventClick(ev)}/>)
              }
            </div>
            <div style={{width:"280px",minWidth:"280px",background:"#080808",borderLeft:"1px solid #1a1a1a",padding:"16px",overflowY:"auto"}}>
              <div style={{color:"#333",fontSize:"0.58rem",letterSpacing:"0.15em",marginBottom:"10px"}}>EVENT DETAIL</div>
              <EventDetail
                event={selectedEvent}
                onAskLuffy={handleAskLuffy}
                onBlockEntity={name => showFeedback(`🔒 "${sanitizeField(name)}" blocked`)}
              />
            </div>
          </div>
        )}
        {activeTab==="graphs"   && <div style={{width:"100%",height:"100%",overflow:"hidden",display:"flex",flexDirection:"column"}}><GraphDashboard events={events} onBarClick={tier => {setFilterTier(tier);setActiveTab("dashboard")}}/></div>}
        {activeTab==="entity"   && <div style={{width:"100%",height:"100%",overflow:"hidden",display:"flex"}}><EntityGraph onNodeClick={handleGraphClick}/></div>}
        {activeTab==="features" && <FeatureImportance onAskLuffy={handleFeatureClick}/>}
        {activeTab==="response" && <ResponseSimulation/>}
        {activeTab==="replay"   && <ReplayTimeline onLuffyState={setLuffyState} onLuffyMessage={setLuffyMessage}/>}
        {activeTab==="luffy"    && <LuffyTab chatHistory={chatHistory} chatInput={chatInput} setChatInput={setChatInput} sendChat={sendChat} chatLoading={chatLoading}/>}
      </div>

      <LuffyOverlay
        ariaState={luffyState}
        externalMessage={luffyMessage}
        onCommand={cmd => {setChatInput(cmd);setActiveTab("luffy")}}
      />
    </div>
  )
}