/**
 * sanitize.js
 * -----------
 * XSS prevention for raw Windows Event Log data rendered in React.
 *
 * USAGE:
 *   import { sanitizeField, sanitizeEvent, safeParseRaw, parseCitations } from "./sanitize"
 */

// ── Manual fallback sanitizer (no DOMPurify dependency required) ──
const DANGEROUS_PATTERNS = [
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /<script[^>]*>/gi,
  /\bon\w+\s*=\s*["']?[^"'>]*/gi,
  /javascript\s*:/gi,
  /data\s*:\s*text\/html/gi,
  /vbscript\s*:/gi,
  /expression\s*\(/gi,
  /<i?frame[\s\S]*?>/gi,
  /<(object|embed|applet)[\s\S]*?>/gi,
  /<[^>]+>/g,
]

function manualSanitize(str) {
  if (typeof str !== "string") return str
  let result = str
  for (const pattern of DANGEROUS_PATTERNS) {
    result = result.replace(pattern, "")
  }
  return result
}

function getPurify() {
  if (typeof window !== "undefined" && window.DOMPurify) return window.DOMPurify
  return null
}

export function sanitizeField(value) {
  if (value === null || value === undefined) return value
  if (typeof value !== "string") return value
  if (value.length === 0) return value
  const purify = getPurify()
  if (purify) return purify.sanitize(value, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
  return manualSanitize(value)
}

export const sanitizeText = sanitizeField

export function sanitizeEvent(rawObj) {
  if (!rawObj || typeof rawObj !== "object") return rawObj
  const result = {}
  for (const [key, value] of Object.entries(rawObj)) {
    if (typeof value === "string") {
      result[key] = sanitizeField(value)
    } else if (Array.isArray(value)) {
      result[key] = value.map(item => typeof item === "string" ? sanitizeField(item) : item)
    } else if (value && typeof value === "object") {
      result[key] = sanitizeEvent(value)
    } else {
      result[key] = value
    }
  }
  return result
}

export function safeParseRaw(rawDataStr) {
  if (!rawDataStr) return {}
  try {
    const parsed = typeof rawDataStr === "string" ? JSON.parse(rawDataStr) : rawDataStr
    return sanitizeEvent(parsed)
  } catch {
    return {}
  }
}

export function sanitizeEventRecord(event) {
  if (!event) return event
  return {
    ...event,
    timestamp:     sanitizeField(event.timestamp),
    source:        sanitizeField(event.source),
    event_type:    sanitizeField(event.event_type),
    cluster_label: sanitizeField(event.cluster_label),
  }
}

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"])

export function sanitizeUrl(url) {
  if (!url || typeof url !== "string") return "#"
  const trimmed = url.trim().toLowerCase()
  if (trimmed.startsWith("javascript:")) return "#"
  if (trimmed.startsWith("vbscript:"))   return "#"
  if (trimmed.startsWith("data:") && !trimmed.startsWith("data:image/")) return "#"
  try {
    const parsed = new URL(url)
    return SAFE_URL_PROTOCOLS.has(parsed.protocol) ? url : "#"
  } catch {
    return url.startsWith("/") || url.startsWith("./") || url.startsWith("../") ? url : "#"
  }
}

const CITATION_RE = /\[(?:DB-ID|EventID):([^\]]+)\]/g

export function parseCitations(text) {
  if (!text || typeof text !== "string") return { cleanText: text || "", citations: [] }
  const citations = []
  let index = 0
  const cleanText = text.replace(CITATION_RE, (match, id) => {
    citations.push({
      type:  match.startsWith("[DB-ID:") ? "db_id" : "event_id",
      id:    sanitizeField(id.trim()),
      index: index,
      label: match,
    })
    index++
    return `[${index}]`
  })
  return { cleanText: sanitizeText(cleanText), citations }
}