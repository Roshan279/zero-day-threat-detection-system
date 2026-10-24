// ─────────────────────────────────────────────────────────────
// FABRICATED DATA for the "Demo data" mode. Nothing here touches the backend or its database.
// It builds the same payloads the API returns (events, entities, feature importance, response simulation,
// replay detail, integrity), from one fixed seed, so the same events appear every time.
//
// It is spread evenly on purpose: every cluster has four sources, one for each threat level, with the same number of
// events each, so LOW, MEDIUM, HIGH and CRITICAL are each exactly a quarter of the events, every behaviour pattern
// gets the same share, and the entities (one per source) top out at every level. Times and log channels are spread evenly too.
// ─────────────────────────────────────────────────────────────

const COMPUTER = "DEMO-WORKSTATION"
const COPIES = 7
const TIER_BAND = { 1: [0.06, 0.38], 2: [0.42, 0.64], 3: [0.67, 0.84], 4: [0.87, 0.985] }
const EVENT_TYPE = { AUDIT_FAILURE: "AUDIT_FAILURE", AUDIT_SUCCESS: "AUDIT_SUCCESS", WARNING: "WARNING", ERROR: "ERROR", INFORMATION: "INFORMATION" }

// cluster -> [behaviour key, label, the four sources: [SourceName, EventID, log channel, EventType, data template]]
const USERS = ["j.carter", "m.lopez", "svc-backup", "a.nguyen", "rohan.admin", "t.okafor", "guest", "k.suzuki"]
const IPS = ["192.168.1.47", "10.0.4.22", "172.16.8.9", "203.0.113.54", "198.51.100.7", "10.0.9.140"]
const CLUSTERS = [
  ["high_frequency_audit", "Brute Force Pattern", [
    ["Winlogon", 4625, "Security", "AUDIT_FAILURE", (u, ip) => `Account: ${u} | Failure: Wrong Password | IP: ${ip}`],
    ["NtLmSsp", 4776, "Security", "AUDIT_FAILURE", (u, ip) => `Credential validation failed for ${u} from ${ip}`],
    ["Kerberos-KDC", 4771, "Security", "AUDIT_FAILURE", (u, ip) => `Kerberos pre-authentication failed: ${u} | Source IP: ${ip}`],
    ["Microsoft-Windows-Security-Auditing", 4740, "Security", "AUDIT_FAILURE", (u, ip) => `Account locked out: ${u} | Source IP: ${ip}`],
  ]],
  ["credential_activity", "Credential Access Pattern", [
    ["Credential Manager", 5379, "Security", "AUDIT_SUCCESS", (u) => `Credential Manager credentials were read by ${u}`],
    ["Microsoft-Windows-CAPI2", 4648, "Security", "AUDIT_SUCCESS", (u, ip) => `Logon attempted using explicit credentials: ${u} | IP: ${ip}`],
    ["LsaSrv", 4768, "Security", "AUDIT_SUCCESS", (u, ip) => `A Kerberos ticket was requested for ${u} from ${ip}`],
    ["SAM Service", 4624, "Security", "AUDIT_SUCCESS", (u, ip) => `Logon type 3 (network) for ${u} | IP: ${ip}`],
  ]],
  ["privilege_change", "Privilege Escalation Pattern", [
    ["Group Policy", 4672, "Security", "AUDIT_SUCCESS", (u) => `Special privileges assigned to new logon: ${u}`],
    ["Microsoft-Windows-Eventlog", 4673, "Security", "AUDIT_SUCCESS", (u) => `A privileged service was called by ${u}`],
    ["TokenBroker", 4728, "Security", "AUDIT_SUCCESS", (u) => `${u} was added to a security-enabled global group`],
    ["Microsoft-Windows-Windows Defender", 4732, "Security", "AUDIT_SUCCESS", (u) => `${u} was added to the local Administrators group`],
  ]],
  ["service_manipulation", "Persistence Pattern", [
    ["Task Scheduler", 4702, "Security", "INFORMATION", () => "A scheduled task was updated"],
    ["Service Control Manager", 7040, "System", "INFORMATION", () => "The start type of a service was changed to auto start"],
    ["Windows Installer", 4698, "Security", "INFORMATION", () => "A scheduled task was created: \\Updater"],
    ["Microsoft-Windows-TaskScheduler", 7045, "System", "WARNING", () => "New service: SVCHOST_UPDATE | Path: C:\\Windows\\Temp\\svc.exe | Account: LocalSystem"],
  ]],
  ["application_anomaly", "Data Exfiltration Pattern", [
    ["Dnscache", 5158, "Security", "AUDIT_SUCCESS", (u, ip) => `Filtering Platform bound a port for outbound traffic to ${ip}`],
    ["Microsoft-Windows-Firewall", 5156, "Security", "AUDIT_SUCCESS", (u, ip) => `Allowed connection to ${ip}:443 | 18 MB sent`],
    ["Microsoft-Windows-SMBServer", 5140, "Security", "AUDIT_SUCCESS", (u, ip) => `A network share was accessed by ${u} from ${ip}`],
    ["Microsoft-Windows-WinRM", 4663, "Security", "AUDIT_SUCCESS", (u) => `An attempt was made to access an object: ${u} read 4,200 files`],
  ]],
  ["normal_system", "Normal System Activity", [
    ["Microsoft-Windows-Time-Service", 6062, "System", "INFORMATION", () => "The system clock was synchronised"],
    ["DCOM", 10016, "System", "WARNING", () => "application-specific permission settings do not grant Local Activation"],
    ["Win32k", 701, "System", "INFORMATION", () => "Display power state changed"],
    ["Microsoft-Windows-Kernel-Power", 566, "System", "WARNING", () => "The system sleep transition was interrupted"],
  ]],
  ["unknown", "Unknown Pattern", [
    ["Edge", 256, "Application", "INFORMATION", () => "Browser extension garbage collection ran"],
    ["VBScriptDeprecationAlert", 4096, "Application", "WARNING", () => "VBScript is scheduled for deprecation"],
    ["Netwtw14", 6062, "System", "ERROR", () => "Wi-Fi adapter reset"],
    ["Dell SupportAssist", 0, "Application", "ERROR", () => "Remediation service stopped unexpectedly"],
  ]],
]

const WINDOWS_RESPONSE = {
  "Brute Force Pattern": "Windows records each failure and locks the account after the lockout threshold.",
  "Credential Access Pattern": "Windows allows the request and writes an audit entry. It does not block it.",
  "Privilege Escalation Pattern": "Windows applies the change and logs it. A person has to notice that it is unusual.",
  "Persistence Pattern": "Windows installs or updates the item and logs it, without questioning the new path.",
  "Data Exfiltration Pattern": "Windows allows outbound traffic that the firewall rules permit and logs the connection.",
  "Normal System Activity": "Windows handles this on its own. No action is needed.",
  "Unknown Pattern": "Windows logs this and carries on. It does not match a known pattern.",
}
const MISSED = {
  "Brute Force Pattern": "MISSED CONTROL: lockout is working, but the threshold may be too high to stop a slow attack.",
  "Credential Access Pattern": "MISSED CONTROL: no alert fires when credentials are read outside normal use.",
  "Privilege Escalation Pattern": "MISSED CONTROL: group changes are not reviewed by a second person.",
  "Persistence Pattern": "MISSED CONTROL: new services and tasks are not checked against an allow list.",
  "Data Exfiltration Pattern": "MISSED CONTROL: no limit or alert on large outbound transfers.",
  "Normal System Activity": "No missed control. This is routine.",
  "Unknown Pattern": "No clear control applies. Worth a manual look.",
}

// ── helpers ──────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, "0")
const frac = (x) => x - Math.floor(x)
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 } }
function hashHex(str) {          // a 64 character hex digest from a simple, repeatable mix
  let out = ""
  for (let k = 0; k < 8; k++) {
    let h = 2166136261 ^ (k * 16777619)
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) }
    out += (h >>> 0).toString(16).padStart(8, "0")
  }
  return out
}
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const iso = (d) => stamp(d).replace(" ", "T")

const FEATURES = {
  event_type_risk: ["Event Type Risk", "How risky the event classification is (AUDIT_FAILURE > ERROR > WARNING)"],
  hour_of_day: ["Time of Day", "How unusual the time of this event is (e.g. 3AM logins score higher)"],
  log_source: ["Log Source", "Which log channel this came from (Security > System > Application)"],
  event_id_mod: ["Event ID Pattern", "How rare this specific Event ID is in the log baseline"],
}

let cache = null
export function fabricated() {
  if (cache) return cache
  const now = new Date()
  const events = []
  let seq = 0
  CLUSTERS.forEach(([behavior, label, sources], ci) => {
    sources.forEach(([source, eid, channel, etype, tmpl], si) => {
      for (let j = 0; j < COPIES; j++) {
        const n = seq++
        const r = rng(9001 + n * 7919)
        const tier = si + 1   // each source holds one level, so every level is exactly a quarter and entities top out at 1, 2, 3 and 4
        const [lo, hi] = TIER_BAND[tier]
        const score = lo + (hi - lo) * r()
        // time: a low-discrepancy walk, so days, weekdays and hours are all covered
        const day = (n + Math.floor(n / 7)) % 7
        const hour = label === "Brute Force Pattern" && j % 2 === 0 ? Math.floor(frac(n * 0.381) * 6) : Math.floor(frac(n * 0.381966 + ci * 0.137) * 24)
        const when = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day, hour, Math.floor(r() * 60), Math.floor(r() * 60))
        if (when > now) when.setHours(Math.max(0, now.getHours() - 1 - (n % 3)), when.getMinutes())   // today only reaches back to this morning
        const user = USERS[(n * 3 + ci) % USERS.length], ip = IPS[(n + si) % IPS.length]
        const pcts = [r() + 0.4, r() + 0.2, r() + 0.1, r() + 0.1]
        const tot = pcts.reduce((a, b) => a + b, 0)
        const keys = Object.keys(FEATURES)
        const fi = keys.map((k, i) => ({ feature: k, label: FEATURES[k][0], description: FEATURES[k][1], value: Math.round(r() * 20 * 10) / 10, pct: Math.round((pcts[i] / tot) * 1000) / 10 }))
          .sort((a, b) => b.pct - a.pct)
        const raw = {
          ComputerName: COMPUTER, Data: tmpl(user, ip), EventID: eid, EventType: etype, SourceName: source, TimeGenerated: stamp(when),
          TargetUserName: channel === "Security" ? user : undefined, IpAddress: channel === "Security" && /IP|from/.test(tmpl(user, ip)) ? ip : undefined,
          fabricated: true, cluster_id: ci, behavior, behavior_label: label, feature_importance: fi, if_score: Math.round(score * 10000) / 10000,
        }
        events.push({
          id: 90000 + n, timestamp: stamp(when), source: channel, event_type: etype, raw_data: JSON.stringify(raw),
          anomaly_score: score, threat_tier: tier, cluster_id: ci, cluster_label: label, created_at: stamp(now), _fi: fi,
        })
      }
    })
  })

  // chain the hashes in time order, like the real database does
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  let prev = "0".repeat(64)
  events.forEach(e => {
    e.prev_hash = prev
    e.event_hash = hashHex(prev + e.raw_data + e.timestamp)
    e.dedup_hash = hashHex(e.raw_data)
    prev = e.event_hash
  })
  const byScore = [...events].sort((a, b) => b.anomaly_score - a.anomaly_score)

  // entities: grouped by SourceName, exactly as the backend does
  const map = {}
  ;[...events].forEach(e => {
    const raw = JSON.parse(e.raw_data)
    const key = raw.SourceName
    const m = (map[key] ||= { entity: key, computer: COMPUTER, event_count: 0, max_tier: 0, total_score: 0, event_ids: [], phases: [], behaviors: [], clusters: [], events: [], first_seen: e.timestamp, last_seen: e.timestamp })
    m.event_count++; m.max_tier = Math.max(m.max_tier, e.threat_tier); m.total_score += e.anomaly_score; m.last_seen = e.timestamp
    if (!m.event_ids.includes(raw.EventID)) m.event_ids.push(raw.EventID)
    if (!m.behaviors.includes(raw.behavior_label)) m.behaviors.push(raw.behavior_label)
    if (!m.clusters.includes(e.cluster_label)) m.clusters.push(e.cluster_label)
    m.events.push({ id: e.id, timestamp: e.timestamp, event_id: raw.EventID, tier: e.threat_tier, score: Math.round(e.anomaly_score * 100), phase: null, cluster: e.cluster_label, event_hash: e.event_hash })
  })
  const entities = Object.values(map).map(v => ({ ...v, avg_score: Math.round((v.total_score / v.event_count) * 100), events: v.events.slice(-10) }))
    .sort((a, b) => b.max_tier - a.max_tier || b.avg_score - a.avg_score)

  const aggregate = Object.keys(FEATURES).map(k => {
    const avg = events.reduce((s, e) => s + (e._fi.find(f => f.feature === k)?.pct || 0), 0) / events.length
    return { feature: k, label: FEATURES[k][0], description: FEATURES[k][1], avg_pct: Math.round(avg * 10) / 10, share_pct: Math.round(avg * 10) / 10 }
  }).sort((a, b) => b.avg_pct - a.avg_pct)

  cache = { events, byScore, entities, aggregate }
  return cache
}

const strip = (e) => { const { _fi, ...rest } = e; return rest }   // the API never sends the helper field

const RULES = {"1":{"tier":1,"label":"LOG ONLY","color":"#4ade80","action":"Passive monitoring. Event recorded to forensic log.","system_action":null,"analyst_action":"No immediate action required.","latency":"Background","automation":"Fully automated","spec_tier":"Tier 1 (<60% confidence)"},"2":{"tier":2,"label":"ALERT ANALYST","color":"#facc15","action":"Advisory alert sent to security analyst for review.","system_action":"Increase monitoring frequency for this entity.","analyst_action":"Review flagged events within 4 hours.","latency":"<30 seconds","automation":"Alert automated: response is manual","spec_tier":"Tier 2 (60 to 85% confidence)"},"3":{"tier":3,"label":"CONDITIONAL RESPONSE","color":"#fb923c","action":"Temporary account suspension or IP block pending analyst review.","system_action":"Suspend user account or block source IP for 15 minutes.","analyst_action":"Confirm or override within 15 minutes. Document in SIEM.","latency":"<5 seconds","automation":"Automated: human override available","spec_tier":"Tier 3 (>85% confidence)"},"4":{"tier":4,"label":"FULL ISOLATION","color":"#f87171","action":"CRITICAL: Full system isolation. Requires human authorisation.","system_action":"Flag for emergency isolation. All lateral movement blocked.","analyst_action":"IMMEDIATE: Escalate to CISO. Initiate incident response plan.","latency":"Immediate","automation":"Human authorisation required","spec_tier":"Tier 4 (Manual: human only)"}}

// ── the fake API: path in, response body out ─────────────────
export function fakeGet(path, params = {}) {
  const d = fabricated()
  if (path === "/events") {
    const f = params
    const when = (e) => String(e.timestamp).replace("T", " ")
    const rows = d.byScore.filter(e => {
      if (f.tier && e.threat_tier !== Number(f.tier)) return false
      if (f.cluster && e.cluster_label !== f.cluster) return false
      if (f.entity && JSON.parse(e.raw_data).SourceName !== f.entity) return false
      if (f.start && when(e) < f.start) return false
      if (f.end && when(e) > (f.end.length === 10 ? f.end + " 23:59:59" : f.end)) return false
      return true
    })
    return { events: rows.slice(0, Number(f.limit) || 200).map(strip), total: rows.length }
  }
  if (path === "/entities") return { entities: d.entities }
  if (path === "/feature-importance") {
    return {
      per_event: d.byScore.slice(0, 40).map(e => ({ event_db_id: e.id, event_id: JSON.parse(e.raw_data).EventID, anomaly_score: Math.round(e.anomaly_score * 100), tier: e.threat_tier, timestamp: e.timestamp, features: e._fi })),
      aggregate: d.aggregate,
      feature_labels: Object.fromEntries(Object.entries(FEATURES).map(([k, v]) => [k, v[0]])),
      feature_descriptions: Object.fromEntries(Object.entries(FEATURES).map(([k, v]) => [k, v[1]])),
    }
  }
  if (path === "/response-simulation") {
    // sixty cards, spread over the four levels, so no level is missing
    const picked = [1, 2, 3, 4].flatMap(t => d.byScore.filter(e => e.threat_tier === t).slice(0, 15))
    return {
      simulated_responses: picked.sort((a, b) => b.anomaly_score - a.anomaly_score).map(e => ({
        event_db_id: e.id, event_id: JSON.parse(e.raw_data).EventID, timestamp: e.timestamp, source: e.source, anomaly_score: Math.round(e.anomaly_score * 100),
        tier: e.threat_tier, phase: null, cluster_label: e.cluster_label, is_demo: true, response: RULES[e.threat_tier],
      })),
      tier_summary: { 1: d.events.filter(e => e.threat_tier === 1).length, 2: d.events.filter(e => e.threat_tier === 2).length, 3: d.events.filter(e => e.threat_tier === 3).length, 4: d.events.filter(e => e.threat_tier === 4).length },
      response_rules: RULES, spec_note: "Actions per original platform spec Layer 6A autonomy tiers",
    }
  }
  let m
  if ((m = path.match(/^\/replay-detail\/(\d+)$/))) {
    const e = d.events.find(x => x.id === Number(m[1]))
    if (!e) return { error: "not found" }
    const raw = JSON.parse(e.raw_data)
    return {
      event: strip(e), raw, integrity: { valid: true, hash: e.event_hash, prev_hash: e.prev_hash, reason: "Hash verified: event is untampered", short_hash: e.event_hash.slice(0, 12) + "..." },
      cluster_label: e.cluster_label, windows_response: WINDOWS_RESPONSE[e.cluster_label], missed_control: MISSED[e.cluster_label],
      significance: `${raw.Data}. This fits the ${e.cluster_label.toLowerCase()}.`, event_hash_short: e.event_hash.slice(0, 16),
    }
  }
  if ((m = path.match(/^\/integrity\/event\/(\d+)$/))) {
    const e = d.events.find(x => x.id === Number(m[1]))
    return e ? { valid: true, hash: e.event_hash, prev_hash: e.prev_hash, reason: "Hash verified: event is untampered", short_hash: e.event_hash.slice(0, 12) + "..." } : { valid: null, reason: "Legacy event" }
  }
  if (path === "/integrity") return { valid: true, total: d.events.length, corrupted: [], first_break: null, chain_length: d.events.length, verified_at: iso(new Date()), genesis_hash: "0".repeat(64), summary: `Chain intact: ${d.events.length} events verified.` }
  if (path === "/watchdog") return { new_critical_events: [], has_alerts: false, max_tier: 4, alert_count: 0, last_auto_scan: iso(new Date()), scan_count: 0, watcher_active: true, is_admin: false }
  if (path === "/blocked-entities") return { blocked: [], count: 0 }
  if (path === "/response-audit") return { audit: [], is_admin: false }
  return null
}

export function fakePost(path, body) {
  if (path === "/scan") return { message: "Demo mode: nothing to scan.", collected: 0 }
  if (path === "/block-entity") return { success: true, message: "Demo mode: nothing was blocked.", dry_run: true }
  if (path === "/unblock-entity") return { success: true, message: "Demo mode: nothing to unblock." }
  if (path === "/demo/inject") return { message: "Demo mode: already using fabricated data.", injected: 0 }
  if (path === "/demo/clear") return { message: "Demo mode: nothing to clear." }
  if (path === "/analyze-event") {
    const e = fabricated().events.find(x => x.id === Number(body?.event_id))
    const raw = e ? JSON.parse(e.raw_data) : {}
    return { narrative: e ? `This is demo data. ${raw.Data}. It falls under the ${e.cluster_label.toLowerCase()} and scored ${Math.round(e.anomaly_score * 100)}%.` : "That event is not in the demo set.", mood: e && e.threat_tier >= 3 ? "alert" : "idle" }
  }
  if (path === "/chat") return { reply: "I'm looking at demo data, so my AI service is not connected. I can still run basic commands.", ai_available: false }
  return null
}
