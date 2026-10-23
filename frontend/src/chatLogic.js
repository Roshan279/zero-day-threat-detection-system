// Pure helpers for Luffy: local command routing, the AI system prompt, and tab-change lines.
import { getHumanDescription } from "./Humanlog"
import { sanitizeField } from "./sanitize"
import { tierOf } from "./px/cardModel"

// Basic commands that work without the AI service (used when the backend says ai_available is false)
export const TAB_ALIASES = {
  home: "home", events: "dashboard", event: "dashboard", dashboard: "dashboard", graphs: "graphs", graph: "graphs",
  entities: "entity", entity: "entity", ml: "features", features: "features", scores: "features",
  response: "response", replay: "replay", chat: "luffy", luffy: "luffy",
}
export function routeLocally(raw) {
  const m = raw.toLowerCase().trim()
  const block = m.match(/^block\s+(.+)$/)
  if (block) return { action: "BLOCK_ENTITY", param: raw.trim().slice(6).trim(), message: `Blocking ${raw.trim().slice(6).trim()}.` }
  const go = m.match(/(?:go to|open|show me|switch to)\s+(?:the\s+)?([a-z ]+?)(?:\s+tab)?$/)
  if (go) {
    const word = go[1].trim().split(" ")[0]
    if (TAB_ALIASES[word]) return { action: "SWITCH_TAB", param: TAB_ALIASES[word], message: `Opening ${word}.` }
  }
  if (/\bscan\b/.test(m))                              return { action: "RUN_SCAN",       message: "Starting a scan." }
  if (/(critical|high)/.test(m))                       return { action: "FILTER_HIGH",    message: "Showing high and critical events only." }
  if (/replay|attack/.test(m))                         return { action: "START_REPLAY",   message: "Opening the attack replay." }
  if (/suspicious|who is|who's/.test(m))               return { action: "EXPLAIN_ENTITY", message: "Here is the most suspicious entity." }
  if (/explain/.test(m))                               return { action: "EXPLAIN_EVENT",  message: "Here is that event in plain English." }
  if (/help|what can you do/.test(m))                  return { action: "SHOW_HELP",      message: "Here is what I can do." }
  return null
}

// Moods the chat model may pick. goofy (case solved) and sleepy (offline) are set by the app itself.
export const CHAT_MOODS = ["idle", "alert", "thinking", "happy", "angry"]


export function buildSystemPrompt(appState) {
  const { activeTab, selectedEvent, alerts, topEntity } = appState
  const currentTabName = {
    home:     "the home page",
    dashboard:"the main dashboard showing live event feed",
    graphs:   "the graphs and charts tab",
    luffy:    "the Luffy chat tab",
    entity:   "the entity relationship graph",
    features: "the feature importance analysis tab",
    response: "the response simulation tab",
    replay:   "the attack replay timeline tab",
  }[activeTab] || activeTab

  const selectedStr = selectedEvent
    ? `The user currently has this event selected: "${getHumanDescription(selectedEvent)}" (Threat: ${tierOf(selectedEvent.threat_tier).name})`
    : "No event is currently selected."

  const alertStr = alerts?.length > 0
    ? `There are ${alerts.length} active alert(s). Most severe: Tier ${alerts[0]?.threat_tier}.`
    : "No active alerts."

  const entityStr = topEntity
    ? `Most suspicious entity: "${sanitizeField(topEntity.entity)}" with ${topEntity.event_count} events at tier ${topEntity.max_tier}.`
    : ""

  return `You are Detective Luffy, the AI brain of a forensic security application (Windows, Linux and macOS). You are both an analyst AND a controller, you explain what's happening AND take actions in the app.

CURRENT APP STATE:
- User is on: ${currentTabName}
- ${selectedStr}
- ${alertStr}
- ${entityStr}

YOUR PERSONALITY: Never use em dashes or emojis. Talk like Monkey D. Luffy, confident, direct, sometimes goofy, NEVER technical jargon. Explain everything in plain English anyone can understand.

YOUR ACTIONS (you MUST pick one):
- SWITCH_TAB + action_param: "home"|"dashboard"|"graphs"|"entity"|"features"|"response"|"replay"|"luffy"
- EXPLAIN_EVENT (explain the selected event in plain English)
- EXPLAIN_ENTITY (explain the most suspicious entity)
- START_REPLAY (go to replay tab)
- RUN_SCAN (trigger a security scan)
- BLOCK_ENTITY + action_param: entity name to block
- FILTER_HIGH (show only high/critical events)
- SHOW_HELP (list what Luffy can do)
- NONE (just talk, no navigation)

RESPONSE: always valid JSON, nothing else:
{"action":"SWITCH_TAB","action_param":"entity","message":"Let me show you the entity graph!","mood":"happy"}

Valid moods: idle, alert, thinking, happy, angry. Pick the one that matches the threat level of what you are talking about: angry for critical, alert for high, thinking for medium or when investigating, happy for good news or all clear, idle for routine.
Keep message under 180 chars. Be specific, mention names/IDs if you know them.`
}


// Short lines Luffy says when you switch pages
export const TAB_LINES = {
  home:      ["Back at the hub. Anything on fire?", "Home base. I'll keep watching from here."],
  dashboard: ["Here come the events. Click a card and I'll explain it.", "Pick a few cards and hit Investigate. I'd start with the red ones."],
  graphs:    ["Bars and numbers. Taller red bars mean more trouble."],
  entity:    ["This shows who is connected to what. Big nodes make the most noise."],
  features:  ["This is why the model flagged things. I only half understand it, but the colors help."],
  response:  ["This is what I'd do at each threat level. Nothing runs until you say so."],
  replay:    ["Want to watch the attack again, step by step? Hit play."],
  luffy:     ["Ask me anything. I'll try my best."],
}

