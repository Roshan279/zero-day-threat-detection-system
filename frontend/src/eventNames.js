// ─────────────────────────────────────────────────────────────
// Plain names for the Windows events that show up all the time, so a card can say "An app crashed"
// instead of "#1000 · Application Error". Looked up by log source first, then by event ID.
// Anything not listed falls back to the log's own message text, then to "<source> event <id>".
// ─────────────────────────────────────────────────────────────
const BY_SOURCE = {
  "Application Error": "An app crashed",
  "Application Hang": "An app stopped responding",
  "Win32k": "Display power change",
  "Microsoft-Windows-Kernel-Power": "Power state change",
  "Microsoft-Windows-Perflib": "Performance counters failed to load",
  "VSS": "Backup snapshot activity",
  "Microsoft-Windows-System-Restore": "System Restore snapshot",
  "MsiInstaller": "Software installed or removed",
  "VBScriptDeprecationAlert": "VBScript is being retired",
  "Software Protection Platform Service": "Windows licence check",
  "Microsoft-Windows-Directory-Services-SAM": "Account database notice",
  "Microsoft-Windows-NDIS": "Network adapter notice",
  "Netwtw14": "Wi-Fi driver notice",
  "Microsoft-Windows-CAPI2": "Certificate service notice",
  "Edge": "Edge browser log",
  "winsrvext": "Windows service extension notice",
  "hcmon": "Hardware monitor driver",
  "Dell SupportAssist Remediation": "Dell SupportAssist activity",
  "SupportAssistAgent": "Dell SupportAssist activity",
}

const DCOM = { 10010: "A DCOM server did not start", 10016: "A DCOM permission error" }
const SCM = {
  7000: "A service failed to start", 7001: "A service depends on one that failed", 7009: "A service took too long to start",
  7023: "A service stopped with an error", 7024: "A service stopped with an error", 7031: "A service crashed and restarted",
  7034: "A service crashed", 7036: "A service started or stopped", 7040: "A service's start type changed", 7045: "A new service was installed",
}
// The "System" source on this machine mostly carries power and driver messages; the ID says which
const BY_ID = {
  506: "Power state change", 507: "Power state change", 566: "Power state change",
  700: "Display power change", 701: "Display power change",
  6062: "Wi-Fi driver notice", 10010: "A DCOM server did not start", 10016: "A DCOM permission error",
  1000: "An app crashed", 1002: "An app stopped responding", 1008: "Performance counters failed to load",
  4624: "An account logged on", 4625: "A logon failed", 4740: "An account was locked out", 7045: "A new service was installed",
}

export function friendlyEventName(sourceName, eventId, data) {
  const src = String(sourceName || "")
  const id = Number(eventId)
  if (src === "DCOM" && DCOM[id]) return DCOM[id]
  if (src === "Service Control Manager" && SCM[id]) return SCM[id]
  if (BY_SOURCE[src]) return BY_SOURCE[src]
  if (BY_ID[id]) return BY_ID[id]
  // Services and apps that log through the "Application" channel with ID 0: use what they said
  const text = String(data || "").trim()
  if (id === 0 && src && /^[\w .-]{3,40}$/.test(text)) return `${src}: ${text.toLowerCase()}`
  if (id === 0 && src) return `${src} notice`
  return src ? `${src} event ${id}` : `Event ${id}`
}
