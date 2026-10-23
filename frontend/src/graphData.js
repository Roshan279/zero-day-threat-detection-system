import { getHumanDescription, hasEventTemplate } from "./Humanlog"
import { sanitizeField } from "./sanitize"
import { TIER } from "./px/cardModel"

// ─────────────────────────────────────────────────────────────
// Number crunching for the Graphs page. No drawing in here.
// ─────────────────────────────────────────────────────────────
export const TIERS = [1, 2, 3, 4]
export const SOURCES = ["Security", "System", "Application", "Other"]
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

const pad = (n) => String(n).padStart(2, "0")

export const tsOf = (e) => {
  const t = Date.parse(String(e.timestamp || "").replace(" ", "T"))
  return Number.isFinite(t) ? t : null
}

export const stamp = (t) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const sourceOf = (e) => {
  const s = String(e.source || "").toLowerCase()
  if (s.includes("security")) return "Security"
  if (s.includes("system")) return "System"
  if (s.includes("application")) return "Application"
  return "Other"
}

const STEPS = [60e3, 5 * 60e3, 15 * 60e3, 3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3]

function labelFor(t, step, span) {
  const d = new Date(t)
  if (step >= 86400e3) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (span > 86400e3) return `${pad(d.getDate())} ${pad(d.getHours())}h`
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Slice the events into equal time buckets, picking the finest step that gives at most maxBuckets.
export function bucketize(events, maxBuckets = 24) {
  const timed = []
  let min = Infinity, max = -Infinity
  for (const e of events) {
    const t = tsOf(e)
    if (t == null) continue
    timed.push([e, t])
    if (t < min) min = t
    if (t > max) max = t
  }
  if (!timed.length) return { buckets: [], step: 0 }
  const span = max - min
  const step = STEPS.find(s => span / s < maxBuckets - 1) || Math.ceil(span / (maxBuckets - 1) / 86400e3) * 86400e3
  const start = Math.floor(min / step) * step
  const n = Math.floor((max - start) / step) + 1
  const buckets = Array.from({ length: n }, (_, i) => ({
    i, t0: start + i * step, t1: start + (i + 1) * step, events: [], counts: { 1: 0, 2: 0, 3: 0, 4: 0 }, total: 0,
    label: labelFor(start + i * step, step, span),
  }))
  for (const [e, t] of timed) {
    const b = buckets[Math.min(n - 1, Math.floor((t - start) / step))]
    b.events.push(e)
    b.counts[e.threat_tier] = (b.counts[e.threat_tier] || 0) + 1
    b.total++
  }
  return { buckets, step }
}

export const topTier = (counts) => [4, 3, 2, 1].find(t => counts[t] > 0) || 0

export function tierCounts(events) {
  const c = { 1: 0, 2: 0, 3: 0, 4: 0 }
  events.forEach(e => { c[e.threat_tier] = (c[e.threat_tier] || 0) + 1 })
  return c
}

// 0..1. 60% average severity, 40% share of CRITICAL events.
export function riskOf(events) {
  const n = events.length
  if (!n) return { risk: 0, critShare: 0, highShare: 0, avgScore: 0 }
  let w = 0, crit = 0, high = 0, sc = 0
  events.forEach(e => {
    w += (TIER[e.threat_tier]?.mult || 1) / 8
    if (e.threat_tier === 4) crit++
    if (e.threat_tier >= 3) high++
    sc += e.anomaly_score || 0
  })
  const critShare = crit / n
  return { risk: Math.min(1, 0.6 * (w / n) + 0.4 * critShare), critShare, highShare: high / n, avgScore: sc / n }
}

export function commonEvents(events, limit = 8) {
  const counts = {}
  events.forEach(e => {
    try {
      const raw = JSON.parse(e.raw_data || "{}")
      const eid = raw.EventID
      if (eid == null) return
      let key
      if (!hasEventTemplate(eid)) {
        const src = sanitizeField(e.source || raw.SourceName || "")
        key = `#${eid}${src ? " · " + src.slice(0, 14) : ""}`
      } else {
        key = getHumanDescription(e).split(":")[0].trim().slice(0, 32)
      }
      counts[key] = (counts[key] || 0) + 1
    } catch { /* skip */ }
  })
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit)
}

export function clusterCounts(events, limit = 6) {
  const counts = {}
  events.forEach(e => {
    const cl = sanitizeField(e.cluster_label || "Unknown")
    if (cl) counts[cl] = (counts[cl] || 0) + 1
  })
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, limit)
}

// 7 weekdays x 24 hours
export function heatGrid(events) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0))
  let max = 0
  events.forEach(e => {
    const t = tsOf(e)
    if (t == null) return
    const d = new Date(t)
    const v = ++grid[(d.getDay() + 6) % 7][d.getHours()]
    if (v > max) max = v
  })
  return { grid, max }
}
