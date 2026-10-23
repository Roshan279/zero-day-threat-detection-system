import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import axios from "axios"
import LuffyOverlay, { MOOD_CONFIG } from "./LuffyOverlay"
import ReplayTimeline from "./ReplayTimeline"
import EntityGraph from "./EntityGraph"
import FeatureImportance from "./Featureimportance"
import ResponseSimulation from "./Responsesimulation"
import Home from "./Home"
import EventsPage, { playTotals } from "./EventsPage"
import GraphsPage from "./GraphsPage"
import Jukebox from "./Jukebox"
import ChatPage from "./ChatPage"
import { CaseInfoModal, OptionsModal } from "./Modals"
import { LeftPanel, JokerRow, AlertSlot, LEFT_WIDTH } from "./px/Shell"
import PxIcon from "./px/PxIcon"
import { Btn } from "./px/ui"
import { tierOf, shortTitle } from "./px/cardModel"
import { API } from "./api"
import { TAB_LINES, routeLocally, CHAT_MOODS, buildSystemPrompt } from "./chatLogic"
import { getHumanDescription, buildRichContext, buildEntitySummary } from "./Humanlog"
import { sanitizeField } from "./sanitize"

// State that survives a reload (reviewed cards, case score, options)
function usePersisted(key, initial) {
  const [value, setValue] = useState(() => {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial } catch { return initial }
  })
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ } }, [key, value])
  return [value, setValue]
}

// A small pop-up when a new alert arrives
function AlertToast({ alerts, onDismiss, onOpen }) {
  useEffect(() => {
    if (!alerts.length) return
    const t = setTimeout(onDismiss, 12000)
    return () => clearTimeout(t)
  }, [alerts, onDismiss])
  if (!alerts.length) return null
  const top = alerts[0]
  const t = tierOf(top.threat_tier)
  return (
    <div className="pz-panel pz-bounce-in" style={{ position: "fixed", top: 14, left: "50%", translate: "-50% 0", zIndex: 150, width: 420, maxWidth: "92vw", padding: 0, overflow: "hidden" }} role="alert">
      <div style={{ background: t.color, color: t.name === "MEDIUM" ? "#1d2527" : "#fff", padding: "4px 12px", display: "flex", alignItems: "center", gap: 8, fontWeight: 700, letterSpacing: ".08em" }}>
        <PxIcon name="warn" size={20} />
        <span style={{ flex: 1 }}>{alerts.length} NEW ALERT{alerts.length > 1 ? "S" : ""}: {t.name}</span>
        <button onClick={onDismiss} aria-label="Dismiss alert" style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", fontWeight: 700, fontSize: 23 }}>X</button>
      </div>
      <div style={{ padding: "8px 12px", fontSize: 19, lineHeight: 1.2 }}>
        {getHumanDescription(top)}
        <div style={{ marginTop: 8 }}><Btn size="small" color="blue" onClick={() => onOpen(top)}>Open the card</Btn></div>
      </div>
    </div>
  )
}

export default function App() {
  const [events,         setEvents]         = useState([])
  const [activeTab,      setActiveTab]      = useState("home")
  const [focusEvent,     setFocusEvent]     = useState(null)
  const [alerts,         setAlerts]         = useState([])
  const [recentAlerts,   setRecentAlerts]   = useState([])
  const [chatHistory,    setChatHistory]    = useState([])
  const [chatInput,      setChatInput]      = useState("")
  const [chatLoading,    setChatLoading]    = useState(false)
  const [luffyOverride,  setLuffyOverride]  = useState(null)   // short reaction, see "Luffy mood model"
  const [online,         setOnline]         = useState(true)   // can we reach the backend?
  const [luffyMessage,   setLuffyMessage]   = useState(null)
  const [topEntity,      setTopEntity]      = useState(null)
  const [entityCount,    setEntityCount]    = useState(0)
  const [filterTier,     setFilterTier]     = useState(0)
  const [actionFeedback, setActionFeedback] = useState(null)
  const [watcherActive,  setWatcherActive]  = useState(false)   // eslint-disable-line no-unused-vars
  const [chain,          setChain]          = useState(null)
  const [modal,          setModal]          = useState(null)    // "info" | "options" | null
  const [selectedIds,    setSelectedIds]    = useState(new Set())
  const [seenList,       setSeenList]       = usePersisted("pz.seen", [])
  const [caseScore,      setCaseScore]      = usePersisted("pz.score", 0)
  const [options,        setOptions]        = usePersisted("pz.options", { bg: true, bubbles: true })

  const seenIds = useMemo(() => new Set(seenList), [seenList])
  const selectedEvent = focusEvent
  const setSelectedEvent = setFocusEvent
  const [winH, setWinH] = useState(() => window.innerHeight)
  useEffect(() => {
    const on = () => setWinH(window.innerHeight)
    window.addEventListener("resize", on)
    return () => window.removeEventListener("resize", on)
  }, [])

  // ── Luffy mood model ────────────────────────────────────────
  // One rule decides how Luffy looks:
  //   1. Ambient mood comes from the real state of the system:
  //        backend unreachable          -> sleepy
  //        any HIGH or CRITICAL events  -> alert
  //        only MEDIUM events           -> thinking
  //        otherwise                    -> idle
  //   2. Reactions to a specific moment (new alert, scan result, picking an event,
  //      blocking something...) override it for a few seconds, then it fades back.
  const eventsRef = useRef([])
  useEffect(() => { eventsRef.current = events }, [events])

  const ambientMood = useMemo(() => {
    if (!online) return "sleepy"
    const top = events.reduce((m, e) => Math.max(m, e.threat_tier || 1), 0)
    if (top >= 3) return "alert"
    if (top === 2) return "thinking"
    return "idle"
  }, [events, online])

  const overrideTimer = useRef(null)
  const setLuffyState = useCallback((mood, ms = 9000) => {
    clearTimeout(overrideTimer.current)
    setLuffyOverride(mood)
    if (mood) overrideTimer.current = setTimeout(() => setLuffyOverride(null), ms)
  }, [])
  useEffect(() => () => clearTimeout(overrideTimer.current), [])

  const luffyState = luffyOverride || ambientMood
  const overrideRef = useRef(null)
  useEffect(() => { overrideRef.current = luffyOverride }, [luffyOverride])

  // luffySay(text, mood): say something, optionally reacting with a mood
  const [luffyNonce, setLuffyNonce] = useState(0)
  const lastMsgAt = useRef(0)
  const firstTab  = useRef(true)
  const luffySay = useCallback((text, mood) => {
    if (mood) setLuffyState(mood)
    setLuffyMessage(text)
    setLuffyNonce(n => n + 1)
  }, [setLuffyState])
  useEffect(() => { lastMsgAt.current = Date.now() }, [luffyMessage, luffyNonce])

  // Say why the ambient mood changed
  const prevAmbient = useRef(null)
  useEffect(() => {
    const prev = prevAmbient.current
    prevAmbient.current = ambientMood
    if (prev === null || prev === ambientMood) return
    const evs  = eventsRef.current
    const crit = evs.filter(e => e.threat_tier >= 4).length
    const high = evs.filter(e => e.threat_tier === 3).length
    const text =
      ambientMood === "sleepy"   ? "I can't reach the backend. Is it running on port 8000?" :
      ambientMood === "alert"    ? (crit ? `${crit} critical and ${high} high-risk events are waiting. Check the red layer.`
                                         : `${high} high-risk events need a look.`) :
      ambientMood === "thinking" ? "Only medium-risk events so far. Probably nothing, but I'm watching." :
      prev === "sleepy"          ? "Back online. Everything looks calm." :
                                   "All calm again. Nothing high-risk left."
    luffySay(text)
  }, [ambientMood, luffySay])

  // Tab changes get a short line in whatever mood he is already in
  useEffect(() => {
    if (firstTab.current) { firstTab.current = false; return }
    if (Date.now() - lastMsgAt.current < 800) return   // an action just spoke, don't talk over it
    if (overrideRef.current) return                    // a reaction is showing, keep its mood and line
    const lines = TAB_LINES[activeTab]
    if (lines) luffySay(lines[Math.floor(Math.random() * lines.length)])
  }, [activeTab, luffySay])

  const prevCountRef = useRef(0)

  // ── Fetch events + entities ─────────────────────────────────
  const fetchAll = useCallback(async () => {
    let loaded = []
    try {
      const [evRes, entRes] = await Promise.allSettled([
        axios.get(`${API}/events`),
        axios.get(`${API}/entities`),
      ])
      if (evRes.status==="fulfilled") {
        const evs = evRes.value.data.events || []
        setEvents(evs)
        setOnline(true)
        prevCountRef.current = evs.length
        loaded = evs
      } else {
        setOnline(false)
      }
      if (entRes.status==="fulfilled") {
        const entities = entRes.value.data.entities||[]
        if (entities.length>0) {
          const sorted=[...entities].sort((a,b) => (b.max_tier-a.max_tier)||(b.event_count-a.event_count))
          setTopEntity(sorted[0])
        }
        setEntityCount(entities.length)
      }
    } catch(e) { console.error("fetchAll:",e) }
    return loaded
  }, [])

  useEffect(() => {
    fetchAll()
    const id = setInterval(fetchAll, 60000)
    return () => clearInterval(id)
  }, [fetchAll])

  // ── Real-time watchdog: polls every 5s ─────────────────────
  // Replaces the old 60s fetchAll-based alert detection.
  // /watchdog returns new_critical_events that were scored in real-time
  // by the backend's EvtSubscribe watcher.
  const lastAlertId = useRef(null)
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await axios.get(`${API}/watchdog`)
        const d   = res.data
        setWatcherActive(d.watcher_active || false)
        setOnline(true)

        if (d.has_alerts && d.new_critical_events?.length > 0) {
          const top = d.new_critical_events[0]
          // Only react to an alert we haven't reacted to yet
          if (top.id !== lastAlertId.current) {
            lastAlertId.current = top.id
            setAlerts(d.new_critical_events)
            setRecentAlerts(r => [top, ...r.filter(x => x.id !== top.id)].slice(0, 3))
            luffySay(`Alert! ${getHumanDescription(top)}`, top.threat_tier >= 4 ? "angry" : "alert")
          }
        }
      } catch {
        setOnline(false)
        setWatcherActive(false)
      }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [luffySay])

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
        showFeedback("Switched to Attack Replay")
        break
      case "RUN_SCAN":
        showFeedback("Scanning...")
        luffySay("Scanning the logs...", "thinking")
        try {
          const lastId = eventsRef.current.reduce((m, e) => Math.max(m, e.id || 0), 0)
          await axios.post(`${API}/scan`)
          const evs   = await fetchAll()
          const fresh = evs.filter(e => (e.id || 0) > lastId)
          const top   = fresh.reduce((m, e) => Math.max(m, e.threat_tier || 1), 0)
          showFeedback("Scan complete")
          if (!fresh.length)  luffySay("Scan done. Nothing new.", "happy")
          else if (top >= 4)  luffySay(`Scan found ${fresh.length} new events and some are critical.`, "angry")
          else if (top === 3) luffySay(`Scan found ${fresh.length} new events. Some are high-risk.`, "alert")
          else                luffySay(`Scan found ${fresh.length} new events, all low risk.`, "idle")
        } catch {
          showFeedback("Scan failed: check backend")
          luffySay("The scan failed. Is the backend running?", "alert")
        }
        break
      case "BLOCK_ENTITY": {
        const target=param||topEntity?.entity
        if(!target){setLuffyMessage("Tell me who to block: use a name or click an entity first.");break}
        showFeedback(`Blocking "${sanitizeField(target)}"...`)
        try {
          await axios.post(`${API}/block-entity`,{
            entity:       target,
            entity_type:  "auto",
            triggered_by: "luffy",
          })
          showFeedback(`"${sanitizeField(target)}" blocked`)
          luffySay(`Done! "${sanitizeField(target)}" is blocked. They won't be sneaking around anymore!`, "goofy")
        } catch {
          showFeedback(`Block failed: check backend`)
          luffySay("I couldn't block that. Check the backend and your permissions.", "alert")
        }
        break
      }
      case "FILTER_HIGH":
        setFilterTier(3)
        setActiveTab("dashboard")
        showFeedback("Showing HIGH + CRITICAL only")
        break
      case "SHOW_HELP":
        setLuffyMessage("I can: explain events, show critical threats, replay the attack, identify suspicious entities, run scans, block entities. Just tell me what you want!")
        break
      default: break
    }
  }, [selectedEvent, topEntity, fetchAll, showFeedback, luffySay])

  // ── Command router ──────────────────────────────────────────
  const sendChat = useCallback(async (override) => {
    const msg=(typeof override === "string" ? override : chatInput).trim()
    if(!msg||chatLoading)return
    setChatInput("")
    setChatLoading(true)
    setLuffyState("thinking", 30000)
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

      // The backend says the AI service is down (missing or rejected key): handle basic commands locally
      if (res.data.ai_available === false) {
        const local = routeLocally(msg)
        if (local) {
          await dispatchAction(local.action, local.param)
          setChatHistory(h => [...h,{role:"assistant",content:`${local.message} (My AI service is offline, so I only handle basic commands.)`}])
        } else {
          let why = "My AI service is offline."
          try { why = JSON.parse(raw).message || why } catch { /* keep default */ }
          setChatHistory(h => [...h,{role:"assistant",content:`${why} I can still do basic commands: run a scan, show critical, replay the attack, who is suspicious, explain this event, go to [tab], block [name].`}])
          luffySay(why, "alert")
        }
        return
      }

      let parsed=null
      try { parsed=JSON.parse(raw.replace(/```json|```/g,"").trim()) } catch { /* plain text reply */ }

      if(parsed?.action){
        await dispatchAction(parsed.action,parsed.action_param)
        setLuffyState(CHAT_MOODS.includes(parsed.mood) ? parsed.mood : null)
        if(parsed.message) setLuffyMessage(parsed.message)
        setChatHistory(h => [...h,{role:"assistant",content:parsed.message||raw}])
      } else {
        setChatHistory(h => [...h,{role:"assistant",content:raw}])
        setLuffyState(null)
        setLuffyMessage(raw.slice(0,200))
      }
    } catch {
      setChatHistory(h => [...h,{role:"assistant",content:"Something went wrong! Is the backend running?"}])
      setLuffyState("alert")
    } finally {
      setChatLoading(false)
    }
  }, [chatInput,chatLoading,chatHistory,activeTab,selectedEvent,alerts,topEntity,dispatchAction,luffySay,setLuffyState])

  // ── Event click ─────────────────────────────────────────────
  const handleEventClick = useCallback((event) => {
    setSelectedEvent(event)
    const ctx=buildRichContext(event)
    const parts=[
      ctx.plain_english,
      ctx.attack_phase ? ` This is part of ${ctx.attack_phase}.` : "",
      ctx.anomaly_score>=80 ? ` ${ctx.anomaly_score}% anomaly score: really suspicious!` : ` Anomaly score: ${ctx.anomaly_score}%.`,
      ` ${ctx.investigation_hint}`,
    ]
    setLuffyMessage(parts.join(""))
    setLuffyState(ctx.threat_level==="CRITICAL"?"angry":ctx.threat_level==="HIGH"?"alert":ctx.threat_level==="MEDIUM"?"thinking":"idle")
  }, [setLuffyState])

  const handleGraphClick   = useCallback((ev) => {handleEventClick(ev);setActiveTab("luffy")},[handleEventClick])
  const handleFeatureClick = useCallback((ev) => {handleEventClick(ev);setActiveTab("luffy")},[handleEventClick])
  const handleAskLuffy     = useCallback((ev) => {
    setSelectedEvent(ev)
    setActiveTab("luffy")
    const ctx=buildRichContext(ev)
    setChatInput(`Explain this: ${ctx.plain_english}`)
  },[])


  // ── Page helpers ────────────────────────────────────────────
  const navigate = useCallback((tab, opts = {}) => {
    if (opts.filter !== undefined) setFilterTier(opts.filter)
    if (opts.focus) { setFocusEvent(opts.focus) }
    setActiveTab(tab)
  }, [])

  const toggleCard = useCallback((ev) => {
    setSelectedIds(s => { const n = new Set(s); if (n.has(ev.id)) n.delete(ev.id); else n.add(ev.id); return n })
  }, [])
  const markSeen = useCallback((ids) => {
    setSeenList(list => [...new Set([...list, ...ids])].slice(-2000))
  }, [setSeenList])
  const onScore = useCallback((points, evs) => {
    setCaseScore(s => s + points)
    const top = evs.reduce((m, e) => Math.max(m, e.threat_tier || 1), 1)
    luffySay(`Looked into ${evs.length} card${evs.length > 1 ? "s" : ""} for ${points.toLocaleString()} case points.`, top >= 4 ? "angry" : top >= 3 ? "alert" : "happy")
  }, [setCaseScore, luffySay])
  const focusCard = useCallback((ev) => { if (ev) handleEventClick(ev); else setFocusEvent(null) }, [handleEventClick])

  const injectDemo = useCallback(async () => {
    try { await axios.post(`${API}/demo/inject`); showFeedback("Demo attack injected"); fetchAll() }
    catch { showFeedback("Could not reach the backend") }
  }, [fetchAll, showFeedback])

  // Integrity of the whole chain, for the CHAIN tile
  useEffect(() => {
    const poll = async () => { try { const r = await axios.get(`${API}/integrity`); setChain(!!r.data.valid) } catch { setChain(null) } }
    poll()
    const id = setInterval(poll, 30000)
    return () => clearInterval(id)
  }, [])

  // ── Numbers for the left panel ──────────────────────────────
  const stats = useMemo(() => {
    const critical = events.filter(e => e.threat_tier >= 4).length
    const high = events.filter(e => e.threat_tier === 3).length
    const top = Math.round(events.reduce((m, e) => Math.max(m, e.anomaly_score || 0), 0) * 100)
    const maxTier = events.reduce((m, e) => Math.max(m, e.threat_tier || 1), 1)
    const counts = {}
    events.forEach(e => { const t = shortTitle(e); counts[t] = (counts[t] || 0) + 1 })
    const common = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || ""
    return { critical, high, top, maxTier, common }
  }, [events])
  const selectedEvents = useMemo(() => events.filter(e => selectedIds.has(e.id)), [events, selectedIds])
  const totals = playTotals(selectedEvents)

  // How Luffy is shown: a full portrait if there is room under the panels, else a small avatar
  const dock = winH >= 930 ? { mode: "full", scale: 5 } : winH >= 800 ? { mode: "full", scale: 3 } : { mode: "avatar", scale: 0 }
  const reserve = dock.mode === "full" ? 42 * dock.scale + 64 : 74

  const pageStyle = { height: "100%" }
  let page = null
  if (activeTab === "home") page = <Home events={events} seenIds={seenIds} mood={luffyState} online={online} onNavigate={navigate} onScan={() => dispatchAction("RUN_SCAN")} onDemo={injectDemo} />
  else if (activeTab === "dashboard") page = (
    <EventsPage
      events={events} filterTier={filterTier} onFilterTier={setFilterTier}
      selectedIds={selectedIds} onToggle={toggleCard} onClearSelection={() => setSelectedIds(new Set())}
      seenIds={seenIds} onScore={onScore} onMarkSeen={markSeen}
      focusEvent={focusEvent} onFocus={focusCard}
      onAskLuffy={handleAskLuffy} onBlockEntity={name => showFeedback(`"${sanitizeField(name)}" blocked`)}
      onResetSeen={() => setSeenList([])}
      onScan={() => dispatchAction("RUN_SCAN")} onReload={() => { fetchAll(); showFeedback("Reloaded") }}
    />
  )
  else if (activeTab === "graphs") page = <GraphsPage events={events} onPickTier={(t) => navigate("dashboard", { filter: t >= 3 ? t : 0 })} />
  else if (activeTab === "entity") page = <EntityGraph onNodeClick={handleGraphClick} />
  else if (activeTab === "features") page = <FeatureImportance onAskLuffy={handleFeatureClick} />
  else if (activeTab === "response") page = <ResponseSimulation />
  else if (activeTab === "replay") page = <ReplayTimeline onLuffyState={setLuffyState} onLuffyMessage={setLuffyMessage} />
  else if (activeTab === "luffy") page = (
    <ChatPage history={chatHistory} input={chatInput} setInput={setChatInput} send={sendChat} loading={chatLoading} mood={luffyState} onQuick={(q) => sendChat(q)} />
  )

  const caseStats = {
    top: stats.top, common: stats.common, total: events.length, seen: seenList.length,
    critical: stats.critical, high: stats.high, entities: entityCount, caseScore, chain,
  }

  return (
    <div style={{ height: "100vh", display: "flex", position: "relative", overflow: "hidden" }}>
      <div className={`pz-felt ${options.bg ? "" : "still"}`} />

      <LeftPanel
        threat={stats.maxTier} topScore={stats.top} caseScore={caseScore}
        chips={totals.chips} mult={totals.mult} selectedCount={selectedEvents.length}
        critical={stats.critical} high={stats.high} total={events.length}
        entities={entityCount} chain={chain} online={online}
        onInfo={() => setModal("info")} onOptions={() => setModal("options")} reserve={reserve}
      />

      <main style={{ flex: 1, minWidth: 0, position: "relative", zIndex: 1, display: "flex", flexDirection: "column" }}>
        <JokerRow active={activeTab} onSelect={setActiveTab} badges={{ dashboard: stats.critical + stats.high }} />
        <div style={{ flex: 1, minHeight: 0, position: "relative", marginTop: 16 }}>
          <div key={activeTab} className="pz-fade-up" style={pageStyle}>{page}</div>
        </div>
        <AlertSlot alerts={recentAlerts} onClick={(ev) => navigate("dashboard", { focus: ev })} />
      </main>

      <Jukebox mood={stats.maxTier >= 4 ? "tense" : "calm"} />

      <LuffyOverlay
        ariaState={luffyState}
        externalMessage={luffyMessage}
        messageKey={luffyNonce}
        dock={dock}
        panelWidth={LEFT_WIDTH}
        quiet={activeTab === "luffy" || !options.bubbles}
        onCommand={cmd => { setChatInput(""); setActiveTab("luffy"); sendChat(cmd) }}
      />

      <AlertToast alerts={alerts} onDismiss={() => setAlerts([])} onOpen={(ev) => { setAlerts([]); navigate("dashboard", { focus: ev }) }} />

      {actionFeedback && (
        <div className="pz-panel pz-bounce-in" style={{ position: "fixed", bottom: 22, left: "50%", translate: "-50% 0", zIndex: 160, padding: "8px 18px", fontWeight: 700, fontSize: 20, background: "var(--panel-d)" }} role="status">
          {actionFeedback}
        </div>
      )}

      {modal === "info" && <CaseInfoModal stats={caseStats} mood={luffyState} onClose={() => setModal(null)} onScan={() => dispatchAction("RUN_SCAN")} />}
      {modal === "options" && (
        <OptionsModal
          options={options} setOptions={setOptions} seenCount={seenList.length}
          onResetSeen={() => setSeenList([])} onResetScore={() => setCaseScore(0)} onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}
