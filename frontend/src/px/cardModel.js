// Turns an event from the API into the parts of a playing card:
//   rank  <- threat tier        (A = critical ... 5 = low)
//   suit  <- log source         (Security spade, System club, Application diamond, other heart)
//   art   <- what kind of event (login key, account person, service gear, crash bug...)
import { getHumanDescription } from "../Humanlog"

export const TIER = {
  4: { name: "CRITICAL", rank: "A",  color: "#fe5f55", dark: "#b83a33", seal: "#fe5f55", mult: 8 },
  3: { name: "HIGH",     rank: "K",  color: "#ff9a00", dark: "#c46a00", seal: "#ff9a00", mult: 5 },
  2: { name: "MEDIUM",   rank: "10", color: "#ffc83a", dark: "#c9922a", seal: "#ffc83a", mult: 3 },
  1: { name: "LOW",      rank: "5",  color: "#4bc292", dark: "#2f8a63", seal: "#4bc292", mult: 1 },
}
export const tierOf = (t) => TIER[t] || TIER[1]

export function suitFor(source = "") {
  const s = String(source).toLowerCase()
  if (s.includes("security")) return "spade"
  if (s.includes("system"))   return "club"
  if (s.includes("application")) return "diamond"
  return "heart"
}
export const suitColor = (suit) => (suit === "heart" || suit === "diamond" ? "#d6453d" : "#1d2527")

const ART_BY_ID = {
  4624: "key", 4625: "key", 4648: "key", 4740: "lock", 4672: "star", 4673: "star", 4674: "star",
  4720: "person", 4726: "person", 4738: "person", 4732: "person", 4733: "person", 4778: "person", 4779: "person",
  7045: "gear", 7040: "gear", 7036: "gear", 7034: "gear",
  1000: "bug", 1001: "bug", 1002: "bug",
  5156: "globe", 5157: "wall", 5158: "globe",
  1102: "scroll", 1100: "scroll", 4719: "scroll",
  4698: "clock", 4699: "clock", 4702: "clock",
  4688: "bolt", 4689: "bolt",
  5379: "lock", 5381: "lock",
}
export function artFor(raw) {
  const id = Number(raw?.EventID)
  if (ART_BY_ID[id]) return ART_BY_ID[id]
  if (id >= 10000 && id < 20000) return "gear"
  return "eye"
}

export function parseRaw(event) {
  try { return JSON.parse(event.raw_data || "{}") } catch { return {} }
}

// One short label for the card title: the part of the description before the colon
export function shortTitle(event) {
  const human = getHumanDescription(event)
  const head = human.split(":")[0].trim()
  const raw = parseRaw(event)
  if (head && head.length <= 34 && human.includes(":")) return head
  const src = raw.SourceName ? String(raw.SourceName) : event.source
  return `${src || "Event"} #${raw.EventID ?? "?"}`.slice(0, 34)
}

export function cardFace(event) {
  const raw = parseRaw(event)
  const tier = tierOf(event.threat_tier)
  const suit = suitFor(event.source)
  return {
    id: event.id, raw, tier, suit,
    suitColor: suitColor(suit),
    art: artFor(raw),
    title: shortTitle(event),
    score: Math.round((event.anomaly_score || 0) * 100),
  }
}
