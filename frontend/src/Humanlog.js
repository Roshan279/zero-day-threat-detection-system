/**
 * humanlog.js
 * -----------
 * Converts raw Windows event log data into plain-English sentences.
 *
 * UPGRADE vs previous version:
 *   - All attacker-controlled field values (usernames, IPs, filenames,
 *     process names, service names, etc.) are passed through sanitizeField()
 *     before being interpolated into template strings.
 *     This prevents XSS if an attacker wrote <script> or onerror= into a
 *     Windows Event Log field value.
 *   - safeParseRaw() replaces bare JSON.parse() in getHumanDescription()
 *     and buildRichContext() so the parse + sanitize is atomic.
 *   - Everything else unchanged — all templates, fallback, exports intact.
 */

import { sanitizeField, safeParseRaw } from "./sanitize"

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

// Sanitize + trim a raw field value. Falls back to fallback string.
const sf = (val, fallback = "") =>
  sanitizeField(typeof val === "string" && val && val !== "-" ? val : fallback) || fallback

// Grab last path component of a Windows path safely
const basename = (path) => sf(path).split("\\").pop() || sf(path)

// ─────────────────────────────────────────────────────────────
// EVENT ID → HUMAN TEMPLATE
// ─────────────────────────────────────────────────────────────
const EVENT_TEMPLATES = {
  // ── Authentication ──────────────────────────────────────────
  4624: (f) => {
    const who  = sf(f.TargetUserName  || f.SubjectUserName, "an unknown user")
    const from = sf(f.IpAddress       || f.WorkstationName, "an unknown location")
    const how  = f.LogonType === "3"  ? "over the network"
               : f.LogonType === "2"  ? "at the console"
               : f.LogonType === "10" ? "via Remote Desktop"
               : "via an automated process"
    return `✅ Login succeeded — ${who} logged in ${how} from ${from}.`
  },

  4625: (f) => {
    const who    = sf(f.TargetUserName || f.SubjectUserName, "an unknown user")
    const from   = sf(f.IpAddress      || f.WorkstationName, "an unknown location")
    const reason = sf(f.FailureReason  || f.Status, "")
    const why    = reason.includes("0xC000006A") ? " (wrong password)"
                 : reason.includes("0xC0000064") ? " (username doesn't exist)"
                 : reason.includes("0xC000006D") ? " (bad credentials)"
                 : reason.includes("0xC0000234") ? " (account is locked out)"
                 : ""
    return `❌ Login FAILED — ${who} tried to log in from ${from} but was rejected${why}.`
  },

  4648: (f) => {
    const who    = sf(f.SubjectUserName, "someone")
    const target = sf(f.TargetUserName,  "another account")
    const via    = f.ProcessName ? ` using ${basename(f.ProcessName)}` : ""
    return `⚠️ Credential use — ${who} explicitly used ${target}'s credentials${via}. This can mean impersonation.`
  },

  4740: (f) => {
    const who  = sf(f.TargetUserName,    "an account")
    const from = sf(f.CallerComputerName,"somewhere")
    return `🔒 Account locked — ${who} was locked out after too many failed login attempts from ${from}.`
  },

  4720: (f) => {
    const newUser = sf(f.TargetUserName,  "a new user")
    const creator = sf(f.SubjectUserName, "someone")
    return `👤 New account created — ${creator} created a new user account called "${newUser}". Investigate if unexpected.`
  },

  4726: (f) => {
    const who     = sf(f.TargetUserName,  "a user account")
    const deleter = sf(f.SubjectUserName, "someone")
    return `🗑️ Account deleted — ${deleter} deleted the user account "${who}".`
  },

  4738: (f) => {
    const who     = sf(f.TargetUserName,  "an account")
    const changer = sf(f.SubjectUserName, "someone")
    return `✏️ Account changed — ${changer} modified the settings of account "${who}".`
  },

  4732: (f) => {
    const who   = sf(f.MemberName,    "someone")
    const group = sf(f.TargetUserName,"a privileged group")
    return `👥 Added to group — ${who} was added to "${group}". If this is Administrators, this is serious.`
  },

  4733: (f) => {
    const who   = sf(f.MemberName,    "someone")
    const group = sf(f.TargetUserName,"a group")
    return `👥 Removed from group — ${who} was removed from "${group}".`
  },

  // ── Privilege / Escalation ───────────────────────────────────
  4672: (f) => {
    const who = sf(f.SubjectUserName, "a user")
    return `🔑 Admin privileges used — ${who} logged in with special administrator rights. Normal for admins, suspicious otherwise.`
  },

  4673: (f) => {
    const who  = sf(f.SubjectUserName, "a process")
    const priv = sf(f.PrivilegeList,   "elevated rights")
    return `⚡ Privilege requested — ${who} asked for ${priv}. This is how attackers escalate access.`
  },

  4674: (f) => {
    const who  = sf(f.SubjectUserName, "a process")
    const priv = sf(f.PrivilegeList,   "elevated rights")
    return `⚡ Privilege attempted — ${who} tried to use ${priv}.`
  },

  // ── Services ─────────────────────────────────────────────────
  7045: (f) => {
    const name = sf(f.ServiceName,    "an unknown service")
    const file = sf(f.ImagePath,      "unknown location")
    const user = sf(f.ServiceAccount, "LocalSystem")
    return `🆕 New service installed — A service called "${name}" was installed, running from ${file} as ${user}. Malware often installs itself as a service.`
  },

  7040: (f) => {
    const name = sf(f.param1 || f.ServiceName, "a service")
    const from = sf(f.param3, "auto-start")
    const to   = sf(f.param4, "disabled")
    return `⚙️ Service changed — The start type of "${name}" was changed from ${from} to ${to}.`
  },

  7036: (f) => {
    const name  = sf(f.param1, "a service")
    const state = sf(f.param2, "changed state")
    return `⚙️ Service state — "${name}" has ${state}.`
  },

  7034: (f) => {
    const name = sf(f.param1, "a service")
    return `💥 Service crashed — "${name}" unexpectedly stopped. This can indicate tampering or a faulty install.`
  },

  // ── Credential / Secret access ───────────────────────────────
  5379: (f) => {
    const who    = sf(f.SubjectUserName, "a process")
    const target = sf(f.TargetName,      "stored credentials")
    return `🔓 Credential read — ${who} read credentials from the Windows Credential Manager (${target}). Malware does this to steal passwords.`
  },

  5381: (f) => {
    const who = sf(f.SubjectUserName, "a process")
    return `🔓 Vault credentials read — ${who} read secrets from the Windows Vault. This is how credential-theft tools extract saved passwords.`
  },

  // ── Network ──────────────────────────────────────────────────
  5156: (f) => {
    const app  = basename(f.Application || "")  || "an application"
    const dest = sf(f.DestAddress, "an unknown address")
    const port = sf(f.DestPort,    "?")
    const dir  = f.Direction === "%%14593" ? "outbound" : "inbound"
    return `🌐 Network connection — ${app} made a ${dir} connection to ${dest}:${port}.`
  },

  5157: (f) => {
    const app  = basename(f.Application || "") || "an application"
    const dest = sf(f.DestAddress, "an unknown address")
    const port = sf(f.DestPort,    "?")
    return `🚫 Connection blocked — Windows Firewall blocked ${app} from connecting to ${dest}:${port}.`
  },

  5158: (f) => {
    const app  = basename(f.Application || "") || "an application"
    const port = sf(f.LocalPort, "?")
    return `🌐 Port opened — ${app} started listening on port ${port}.`
  },

  // ── Process / Execution ──────────────────────────────────────
  4688: (f) => {
    const name   = basename(f.NewProcessName    || "") || "a process"
    const parent = basename(f.ParentProcessName || "") || "unknown"
    const user   = sf(f.SubjectUserName, "unknown user")
    const cmd    = sanitizeField(f.CommandLine  || "")
    const cmdStr = cmd ? ` with command: ${cmd.slice(0, 80)}` : ""
    return `▶️ Process started — ${user} ran "${name}" (launched by ${parent})${cmdStr}.`
  },

  4689: (f) => {
    const name = basename(f.ProcessName || "") || "a process"
    const code = sf(f.ExitCode, "0")
    return `⏹️ Process ended — "${name}" exited with code ${code}.`
  },

  4657: (f) => {
    const key  = sf(f.ObjectName,      "a registry key")
    const who  = sf(f.SubjectUserName, "someone")
    const type = sf(f.OperationType,   "modified")
    return `🗝️ Registry changed — ${who} ${type.toLowerCase()} the registry key "${key}". Malware often modifies registry for persistence.`
  },

  // ── Files / Objects ──────────────────────────────────────────
  4663: (f) => {
    const obj  = basename(f.ObjectName || "") || "a file"
    const who  = sf(f.SubjectUserName, "someone")
    const acc  = f.AccessMask || ""
    const type = acc === "0x2" ? "wrote to" : acc === "0x1" ? "read" : "accessed"
    return `📁 File accessed — ${who} ${type} "${obj}".`
  },

  4660: (f) => {
    const obj = basename(f.ObjectName || "") || "a file or object"
    const who = sf(f.SubjectUserName, "someone")
    return `🗑️ Object deleted — ${who} deleted "${obj}".`
  },

  // ── Audit / Policy ───────────────────────────────────────────
  4719: (f) => {
    const who = sf(f.SubjectUserName, "someone")
    return `🔧 Audit policy changed — ${who} changed the system audit policy. Attackers do this to hide their tracks.`
  },

  4616: (f) => {
    const who = sf(f.SubjectUserName, "something")
    return `⏰ System time changed — ${who} changed the system clock. This can be used to confuse log timestamps.`
  },

  1102: (f) => {
    const who = sf(f.SubjectUserName, "someone")
    return `🚨 AUDIT LOG CLEARED — ${who} erased the Windows Security event log. This is a major red flag and common in cover-up attacks.`
  },

  1100: () =>
    `🛑 Event logging stopped — The Windows event logging service was shut down. Logs may be incomplete from this point.`,

  // ── Application Errors ───────────────────────────────────────
  1000: (f) => {
    const app = sf(f.param1 || f.Application, "an application")
    const ver = sf(f.param2, "")
    const mod = sf(f.param3, "")
    return `💥 Application crash — "${app}" (${ver}) crashed${mod ? ` in module ${mod}` : ""}. May be normal or indicate tampering.`
  },

  1001: (f) => {
    const app = sf(f.param1, "an application")
    return `💥 Application fault — "${app}" encountered a critical error and was terminated.`
  },

  // ── System ───────────────────────────────────────────────────
  6013: (f) => {
    const uptime = f.param1 || f.Data || "0"
    const days   = Math.floor(Number(uptime) / 86400)
    const hrs    = Math.floor((Number(uptime) % 86400) / 3600)
    return `🖥️ System uptime — This machine has been running for ${days} day${days !== 1 ? "s" : ""} and ${hrs} hour${hrs !== 1 ? "s" : ""}.`
  },

  41: () =>
    `⚡ Unexpected shutdown — The system was shut down unexpectedly (power loss or crash) and did not shut down cleanly.`,

  6008: () =>
    `⚡ Dirty shutdown — The previous system shutdown was unexpected. The machine may have crashed or been forcibly powered off.`,

  // ── VSS / Backup ─────────────────────────────────────────────
  8224: () =>
    `💾 VSS activity — The Volume Shadow Copy service performed an operation. Ransomware often deletes shadow copies to prevent recovery.`,

  8193: () =>
    `💾 VSS error — The Volume Shadow Copy service encountered an error. If during an attack, this may indicate ransomware activity.`,

  // ── Scheduled Tasks ──────────────────────────────────────────
  4698: (f) => {
    const task = sf(f.TaskName,       "a task")
    const who  = sf(f.SubjectUserName,"someone")
    return `⏰ Scheduled task created — ${who} created a scheduled task named "${task}". Attackers use these for persistence.`
  },

  4702: (f) => {
    const task = sf(f.TaskName,       "a task")
    const who  = sf(f.SubjectUserName,"someone")
    return `⏰ Scheduled task modified — ${who} modified the scheduled task "${task}".`
  },

  4699: (f) => {
    const task = sf(f.TaskName,       "a task")
    const who  = sf(f.SubjectUserName,"someone")
    return `⏰ Scheduled task deleted — ${who} deleted the scheduled task "${task}".`
  },

  // ── RDP / Remote ─────────────────────────────────────────────
  4778: (f) => {
    const who  = sf(f.AccountName,    "a user")
    const from = sf(f.ClientAddress,  "somewhere")
    return `🖥️ Remote session reconnected — ${who} reconnected an RDP session from ${from}.`
  },

  4779: (f) => {
    const who = sf(f.AccountName, "a user")
    return `🖥️ Remote session disconnected — ${who} disconnected from a Remote Desktop session.`
  },

  // ── Firewall ─────────────────────────────────────────────────
  2004: (f) => {
    const rule = sf(f.RuleName,     "a firewall rule")
    const who  = sf(f.ModifyingUser,"someone")
    return `🔥 Firewall rule added — ${who} added a new rule: "${rule}". Malware does this to allow incoming connections.`
  },

  2006: (f) => {
    const rule = sf(f.RuleName, "a firewall rule")
    return `🔥 Firewall rule deleted — The firewall rule "${rule}" was removed. This may be intentional or an attacker opening a port.`
  },
}

// ─────────────────────────────────────────────────────────────
// FALLBACK TEMPLATE
// ─────────────────────────────────────────────────────────────
function fallbackDescription(eventId, raw) {
  const id = Number(eventId)
  const category =
    (id >= 4608 && id <= 4799) ? "account/security policy change" :
    (id >= 4800 && id <= 4999) ? "system security event" :
    (id >= 5000 && id <= 5499) ? "network policy/IPsec event" :
    (id >= 5500 && id <= 5999) ? "network connection event" :
    (id >= 6000 && id <= 6099) ? "system health/diagnostic" :
    (id >= 7000 && id <= 7099) ? "Windows service event" :
    (id >= 8000 && id <= 8999) ? "application/VSS event" :
    (id >= 1000 && id <= 1999) ? "application event" :
    (id >= 10000 && id <= 19999) ? "Windows component event" :
    "system activity"

  // Sanitize fields used in fallback too
  const who    = sf(raw.SubjectUserName || raw.TargetUserName || raw.UserName, "")
  const comp   = sf(raw.Computer || raw.WorkstationName, "")
  const source = sf(raw.SourceName || raw.Channel, "")

  const whoStr  = who  ? ` involving account "${who}"` : ""
  const compStr = comp ? ` on ${comp}` : ""

  return `📋 Event ${eventId} — A ${category} event was recorded${whoStr}${compStr}. ${source ? `[${source}]` : ""}`.trim()
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT: getHumanDescription
// ─────────────────────────────────────────────────────────────
export function getHumanDescription(event) {
  if (!event) return "No event data available."

  // safeParseRaw = JSON.parse + sanitizeEvent in one call
  const raw = safeParseRaw(
    typeof event.raw_data === "string" ? event.raw_data : JSON.stringify(event.raw_data || {})
  )

  const eid      = Number(raw.EventID || event.event_id || 0)
  const template = EVENT_TEMPLATES[eid]

  if (template) {
    try { return template(raw) } catch { /* fall through */ }
  }

  return fallbackDescription(eid, raw)
}

// ─────────────────────────────────────────────────────────────
// RICH CONTEXT BUILDER
// ─────────────────────────────────────────────────────────────
export function buildRichContext(event, extraContext = {}) {
  if (!event) return { error: "No event provided" }

  const raw = safeParseRaw(
    typeof event.raw_data === "string" ? event.raw_data : JSON.stringify(event.raw_data || {})
  )

  const eid        = Number(raw.EventID || event.event_id || 0)
  const tier       = event.threat_tier || 1
  const tierLabels = { 1:"LOW", 2:"MEDIUM", 3:"HIGH", 4:"CRITICAL" }
  const tierWords  = {
    1: "low-level routine activity",
    2: "moderate concern worth watching",
    3: "high-risk action that likely needs investigation",
    4: "CRITICAL threat — immediate action required",
  }

  const human = getHumanDescription(event)
  const ts    = sf(raw.TimeGenerated || event.timestamp, "unknown time")

  const keyFields = {}
  const interesting = [
    "TargetUserName","SubjectUserName","IpAddress","WorkstationName",
    "ProcessName","NewProcessName","CommandLine","ServiceName","ImagePath",
    "DestAddress","DestPort","ObjectName","TaskName","RuleName","TargetName",
    "LogonType","FailureReason","PrivilegeList","param1","param2","Data","Message",
  ]
  interesting.forEach(k => {
    if (raw[k] && raw[k] !== "-" && raw[k] !== "") keyFields[k] = raw[k]
  })

  return {
    event_id:          eid,
    db_id:             event.id || event.event_db_id,
    timestamp:         ts,
    source:            sanitizeField(event.source || raw.Channel || "Windows"),
    plain_english:     human,
    what_happened:     human.replace(/^[^\s]+\s/, ""),
    threat_level:      tierLabels[tier] || "UNKNOWN",
    threat_meaning:    tierWords[tier]  || "unknown severity",
    anomaly_score:     Math.round((event.anomaly_score || 0) * 100),
    attack_phase:      raw.phase || null,
    is_demo_attack:    raw.demo === true,
    entity:            event.entity || raw.TargetUserName || raw.SubjectUserName || null,
    computer:          raw.Computer || raw.WorkstationName || null,
    ip_address:        raw.IpAddress || null,
    cluster_label:     sanitizeField(event.cluster_label || raw.behavior_label || ""),
    key_fields:        keyFields,
    investigation_hint: getInvestigationHint(eid, tier, raw),
    ...extraContext,
  }
}

// ─────────────────────────────────────────────────────────────
// INVESTIGATION HINT
// ─────────────────────────────────────────────────────────────
function getInvestigationHint(eid, tier, raw) {
  if (tier >= 4) return "This is CRITICAL. Focus on immediate containment — what was accessed and how to stop further damage."
  if (eid === 4625) {
    const ip = raw.IpAddress
    return ip && ip !== "-"
      ? `Focus on the source IP ${sanitizeField(ip)} — is this an internal machine or an outside attacker?`
      : "Focus on how many times this failed and what account was targeted."
  }
  if (eid === 4624) return "Check when this login happened. A login at 3AM is very different from 9AM."
  if (eid === 7045) return `The service "${sf(raw.ServiceName, "unknown")}" was installed. Check if this is a known program or something suspicious.`
  if (eid === 4648) return "Explicit credential use is normal for some IT tasks but dangerous if an attacker is impersonating an account."
  if (eid === 1102) return "Log clearing is almost always an attacker covering tracks. This should be treated as a confirmed intrusion."
  if (eid === 4698) return `A scheduled task "${sf(raw.TaskName, "unknown")}" was created. Attackers use these to survive reboots.`
  if (eid === 5379) return "Credential theft from Windows Credential Manager is a common step after initial access."
  if (tier >= 3) return "High severity — look at what account did this and whether it's behaving normally."
  return "Compare this to normal activity. Is this user or machine usually this active?"
}

// ─────────────────────────────────────────────────────────────
// ENTITY SUMMARY BUILDER
// ─────────────────────────────────────────────────────────────
export function buildEntitySummary(entity) {
  if (!entity) return "No entity data."

  const tier   = entity.max_tier   || 1
  const count  = entity.event_count || 0
  const phases = entity.phases      || []
  const eids   = entity.event_ids   || []
  const score  = entity.avg_score   || 0
  const name   = sanitizeField(entity.entity || "Unknown entity")
  const first  = sanitizeField((entity.first_seen || "").slice(0, 16).replace("T", " at "))
  const last   = sanitizeField((entity.last_seen  || "").slice(0, 16).replace("T", " at "))

  const severityWord =
    tier >= 4 ? "extremely dangerous" :
    tier >= 3 ? "highly suspicious"   :
    tier >= 2 ? "moderately suspicious" :
    "mostly routine but worth watching"

  const phaseStr = phases.length > 0
    ? `It appears to be involved in: ${phases.map(p => sanitizeField(p)).join(", ")}.`
    : ""

  const eidStr = eids.length > 0
    ? `The most common event types were: ${eids.slice(0, 4).map(id => `#${id}`).join(", ")}.`
    : ""

  const timeStr = first
    ? `Activity started ${first} and most recently was seen ${last}.`
    : ""

  return `"${name}" is ${severityWord}. It generated ${count} suspicious event${count !== 1 ? "s" : ""} with an average threat score of ${score}%. ${phaseStr} ${eidStr} ${timeStr}`.trim()
}

// ─────────────────────────────────────────────────────────────
// ATTACK PHASE EXPLAINER
// ─────────────────────────────────────────────────────────────
export const PHASE_EXPLANATIONS = {
  "Phase 1: Brute Force":
    "The attacker is guessing passwords over and over, trying to break into an account. Like someone trying every key on a keychain.",
  "Phase 1: Account Lockout":
    "So many failed logins happened that Windows locked the account to protect it. The attacker was caught trying to break in.",
  "Phase 2: Credential Access":
    "The attacker successfully logged in using real account credentials. They either guessed correctly or stole a password.",
  "Phase 2: Credential Theft":
    "The attacker read saved passwords from Windows' secure storage. They now have real login credentials to use.",
  "Phase 3: Privilege Escalation":
    "The attacker upgraded their access from a normal user to an administrator. Now they have full control.",
  "Phase 3: Backdoor Login":
    "The attacker created a hidden way back into the system. They can return even if passwords are changed.",
  "Phase 4: Persistence":
    "The attacker installed software that runs automatically, ensuring they stay connected even after a reboot.",
  "Phase 5: Data Exfiltration":
    "The attacker is copying or sending files out of the system. This is the theft stage — data is leaving.",
  "Phase 5: Data Exfiltration Complete":
    "The attacker has finished stealing data. The breach is complete.",
}

export function explainPhase(phase) {
  return PHASE_EXPLANATIONS[phase] || `Attack phase: ${phase}. This represents a stage in a multi-step intrusion.`
}

// ─────────────────────────────────────────────────────────────
// TIER EXPLAINER
// ─────────────────────────────────────────────────────────────
export const TIER_EXPLANATIONS = {
  1: "🟢 LOW — Routine activity. Probably normal, but we're keeping an eye on it.",
  2: "🟡 MEDIUM — Something unusual happened. Worth investigating but not an emergency.",
  3: "🟠 HIGH — This looks like part of an attack. Needs investigation soon.",
  4: "🔴 CRITICAL — Active attack in progress or severe threat. Act now.",
}

export function explainTier(tier) {
  return TIER_EXPLANATIONS[tier] || `Threat level ${tier}.`
}

// ─────────────────────────────────────────────────────────────
// FORMAT TIMESTAMP
// ─────────────────────────────────────────────────────────────
export function formatTimestamp(ts) {
  if (!ts) return "unknown time"
  try {
    const d      = new Date(ts)
    const days   = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"]
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    const h      = d.getHours()
    const m      = d.getMinutes().toString().padStart(2, "0")
    const ampm   = h >= 12 ? "PM" : "AM"
    const h12    = h % 12 || 12
    const isNight = h >= 22 || h < 6
    const timeNote = isNight ? " ⚠️ (unusual hour)" : ""
    return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} at ${h12}:${m} ${ampm}${timeNote}`
  } catch {
    return ts.slice(0, 16).replace("T", " at ")
  }
}