import { useEffect, useMemo } from "react"
import PageFlip from "./PageFlip"
import PxIcon from "./px/PxIcon"
import PixelLuffy from "./px/PixelLuffy"
import { TIER, shortTitle } from "./px/cardModel"
import { explainTier, formatTimestamp } from "./Humanlog"
import { sanitizeField } from "./sanitize"
import { clusterCounts, commonEvents, riskOf, tierCounts, tsOf } from "./graphData"

// ─────────────────────────────────────────────────────────────
// CASE BOOK: the whole case written out as a book you can page through. Opened from "Summary" in Case Info.
// Everything is worked out from the events the app already holds (plus the entity list from the backend), so it
// matches the numbers on the other tabs, and in Demo data mode it tells the story of the demo data.
// Pages: cover, at a glance, threat levels, when it happened, behaviour, who is involved, worst events,
// attack story, records and integrity, next steps, back cover.
// ─────────────────────────────────────────────────────────────
const INK = "#1d2527"
const MUTED = "#5e7977"
const GOLD = "#fdcf51"
const SUIT = { 4: "spade", 3: "diamond", 2: "club", 1: "heart" }
const PATTERN_MEANING = {
  "Brute Force Pattern": "Many failed logins in a short time.",
  "Credential Access Pattern": "Passwords or tickets being read or reused.",
  "Privilege Escalation Pattern": "An account gaining more power than before.",
  "Persistence Pattern": "Something set up to keep running or come back.",
  "Data Exfiltration Pattern": "Data leaving the machine in bulk.",
  "Normal System Activity": "Routine system noise.",
  "Unknown Pattern": "Does not match any known pattern.",
}
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`
const pct = (n, total) => (total ? Math.round((n / total) * 100) : 0)
const dayKey = (e) => String(e.timestamp || "").slice(0, 10)

// A page: a header, a short rule, the body, and the page number at the foot
function Page({ title, icon, no, children }) {
  return (
    <div style={{ width: "100%", height: "100%", padding: "6cqw 7cqw 4.5cqw 8cqw", boxSizing: "border-box", display: "flex", flexDirection: "column", fontSize: "5.2cqw", lineHeight: 1.18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "2.5cqw" }}>
        <PxIcon name={icon} size={30} />
        <div style={{ fontFamily: "var(--pxfont)", fontSize: "9.0cqw", fontWeight: 700, lineHeight: 1 }}>{title}</div>
      </div>
      <div style={{ height: 0, borderTop: `3px dashed ${INK}`, opacity: 0.35, margin: "2.5cqw 0 3cqw" }} />
      <div style={{ flex: 1, minHeight: 0 }}>{children}</div>
      <div style={{ textAlign: "center", fontSize: "4.4cqw", color: MUTED }}>- {no} -</div>
    </div>
  )
}

const Row = ({ label, children, color }) => (
  <div style={{ display: "flex", justifyContent: "space-between", gap: "3cqw", padding: "0.8cqw 0", borderBottom: `2px dotted rgba(29,37,39,.25)` }}>
    <span style={{ color: MUTED }}>{label}</span>
    <b style={{ textAlign: "right", color }}>{children}</b>
  </div>
)
const Stat = ({ label, value, color }) => (
  <div style={{ border: `3px solid ${INK}`, padding: "1.6cqw 2cqw", background: "#fff" }}>
    <div style={{ fontSize: "4.0cqw", color: MUTED, letterSpacing: ".08em" }}>{label}</div>
    <div style={{ fontFamily: "var(--pxfont)", fontSize: "11.0cqw", lineHeight: 1, color }}>{value}</div>
  </div>
)
// a row of little squares, one per unit, so a count can be read at a glance
const Pips = ({ n, max, color }) => (
  <span style={{ display: "inline-flex", gap: 2, verticalAlign: "middle" }}>
    {Array.from({ length: Math.max(1, Math.min(14, Math.round((n / Math.max(max, 1)) * 14))) }, (_, i) => <i key={i} style={{ width: 7, height: 9, background: color, border: `1.5px solid ${INK}`, display: "block" }} />)}
  </span>
)

export default function CaseBook({ events, chain, scopeLabel = "", onClose }) {
  // entities are grouped by log source, worked out from the events in this book so a scoped book lists only its own
  const entities = useMemo(() => {
    const map = {}
    events.forEach(e => {
      let name = "Unknown"
      try { name = JSON.parse(e.raw_data || "{}").SourceName || e.source || "Unknown" } catch { name = e.source || "Unknown" }
      const m = (map[name] ||= { entity: name, event_count: 0, max_tier: 0, total: 0 })
      m.event_count++; m.max_tier = Math.max(m.max_tier, e.threat_tier || 1); m.total += e.anomaly_score || 0
    })
    return Object.values(map).map(m => ({ ...m, avg_score: Math.round((m.total / m.event_count) * 100) }))
      .sort((x, y) => y.max_tier - x.max_tier || y.avg_score - x.avg_score)
  }, [events])
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const pages = useMemo(() => {
    const total = events.length
    const tc = tierCounts(events)
    const r = riskOf(events)
    const sorted = [...events].sort((a, b) => (b.anomaly_score || 0) - (a.anomaly_score || 0))
    const worst = sorted.slice(0, 5)
    const timed = events.map(e => tsOf(e)).filter(t => t != null)
    const first = timed.length ? Math.min(...timed) : null, last = timed.length ? Math.max(...timed) : null
    const byDay = {}
    events.forEach(e => { const k = dayKey(e); if (k) byDay[k] = (byDay[k] || 0) + 1 })
    const days = Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6).reverse()
    const busiest = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0]
    const byHour = {}
    events.forEach(e => { const t = tsOf(e); if (t != null) { const h = new Date(t).getHours(); byHour[h] = (byHour[h] || 0) + 1 } })
    const busyHour = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0]
    const clusters = clusterCounts(events, 7)
    const common = commonEvents(events, 4)
    const phases = []
    ;[...events].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).forEach(e => {
      try { const p = JSON.parse(e.raw_data || "{}").phase; if (p && !phases.includes(p)) phases.push(p) } catch { /* skip */ }
    })
    const ents = entities.slice(0, 6)
    const level = r.risk < 0.25 ? "calm" : r.risk < 0.5 ? "watchful" : r.risk < 0.75 ? "dangerous" : "critical"
    const topEvent = worst[0]
    const verdict = !total ? "There are no events on file yet. Run a scan to start the case."
      : tc[4] ? `This case is ${level}. ${plural(tc[4], "event")} reached CRITICAL and ${tc[3]} more were flagged HIGH, out of ${total} stored.`
      : tc[3] ? `This case is ${level}. ${plural(tc[3], "event")} were flagged HIGH. None reached CRITICAL.`
      : `This case is ${level}. Nothing was flagged HIGH or CRITICAL across ${total} events.`

    const cover = (
      <div style={{ width: "100%", height: "100%", background: "#3d4d51", color: "#f8f4ec", position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", boxSizing: "border-box", padding: "8cqw" }}>
        <div style={{ position: "absolute", inset: "4cqw", border: `3px solid ${GOLD}` }} />
        <div style={{ position: "absolute", inset: "6.5cqw", border: `2px dashed rgba(253,207,81,.5)` }} />
        <PixelLuffy mood={tc[4] ? "angry" : tc[3] ? "alert" : "idle"} view="head" height={92} animate={false} />
        <div style={{ fontFamily: "var(--pxfont)", fontSize: "15.9cqw", lineHeight: 0.95, marginTop: "5cqw", color: GOLD, letterSpacing: ".04em" }}>CASE FILE</div>
        <div style={{ fontSize: "5.6cqw", marginTop: "3cqw", letterSpacing: ".2em", opacity: 0.85 }}>FORENSIC DETECTIVE</div>
        {scopeLabel && <div style={{ fontSize: "5cqw", marginTop: "4cqw", color: GOLD, lineHeight: 1.2, padding: "0 4cqw" }}>{scopeLabel}</div>}
        <div style={{ fontSize: "4.9cqw", marginTop: "6cqw", opacity: 0.7 }}>{plural(total, "event")} on file</div>
        <div style={{ position: "absolute", bottom: "9cqw", fontSize: "4.4cqw", opacity: 0.6 }}>Turn the corner</div>
      </div>
    )

    const glance = (
      <Page title="At a glance" icon="eye" no={1}>
        <div style={{ fontSize: "5.6cqw", lineHeight: 1.22, marginBottom: "3.5cqw" }}>{verdict}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2.5cqw" }}>
          <Stat label="EVENTS" value={total} color={INK} />
          <Stat label="TOP SCORE" value={topEvent ? `${Math.round(topEvent.anomaly_score * 100)}%` : "0%"} color={TIER[topEvent?.threat_tier || 1].dark} />
          <Stat label="CRITICAL" value={tc[4]} color={TIER[4].dark} />
          <Stat label="HIGH" value={tc[3]} color={TIER[3].dark} />
        </div>
        <div style={{ marginTop: "3.5cqw" }}>
          <Row label="Risk">{Math.round(r.risk * 100)}%</Row>
          <Row label="Entities">{entities.length}</Row>
        </div>
      </Page>
    )

    const levels = (
      <Page title="Threat levels" icon="warn" no={2}>
        {[4, 3, 2, 1].map(t => (
          <div key={t} style={{ display: "flex", gap: "3cqw", alignItems: "flex-start", marginBottom: "3.2cqw" }}>
            <div style={{ width: "11cqw", flexShrink: 0, textAlign: "center", background: "#fff", border: `3px solid ${INK}`, padding: "0.8cqw 0", color: t === 3 || t === 1 ? "#c0443b" : INK }}>
              <div style={{ fontFamily: "var(--pxfont)", fontSize: "7.3cqw", lineHeight: 1 }}>{TIER[t].rank}</div>
              <PxIcon suit={SUIT[t]} size={14} color={t === 3 || t === 1 ? "#c0443b" : INK} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div><b style={{ color: TIER[t].dark }}>{TIER[t].name}</b>: {tc[t]} <span style={{ color: MUTED }}>({pct(tc[t], total)}%)</span></div>
              <div style={{ fontSize: "4.4cqw", color: MUTED, lineHeight: 1.15 }}>{explainTier(t)}</div>
            </div>
          </div>
        ))}
      </Page>
    )

    const when = (
      <Page title="When it happened" icon="clock" no={3}>
        <Row label="First event">{first ? formatTimestamp(new Date(first).toISOString()) : "none"}</Row>
        <Row label="Latest event">{last ? formatTimestamp(new Date(last).toISOString()) : "none"}</Row>
        <Row label="Busiest day">{busiest ? `${busiest[0]} (${busiest[1]})` : "none"}</Row>
        <Row label="Busiest hour">{busyHour ? `${String(busyHour[0]).padStart(2, "0")}:00 (${busyHour[1]})` : "none"}</Row>
        <div style={{ marginTop: "4cqw", fontSize: "4.1cqw", color: MUTED, letterSpacing: ".1em" }}>EVENTS PER DAY</div>
        {days.map(([d, n]) => (
          <div key={d} style={{ display: "flex", alignItems: "center", gap: "2.5cqw", marginTop: "1.4cqw" }}>
            <span style={{ width: "19cqw", fontSize: "4.6cqw" }}>{d.slice(5)}</span>
            <Pips n={n} max={busiest?.[1] || 1} color="#e0803a" />
            <span style={{ fontSize: "4.6cqw" }}>{n}</span>
          </div>
        ))}
      </Page>
    )

    const behaviour = (
      <Page title="Behaviour" icon="ml" no={4}>
        <div style={{ fontSize: "4.6cqw", color: MUTED, marginBottom: "2.5cqw" }}>What the model thinks the events are doing.</div>
        {clusters.length ? clusters.map(([name, n]) => (
          <div key={name} style={{ marginBottom: "2.4cqw" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "2cqw" }}><b>{name}</b><span>{n}</span></div>
            <div style={{ fontSize: "4.3cqw", color: MUTED, lineHeight: 1.1 }}>{PATTERN_MEANING[name] || ""}</div>
          </div>
        )) : <div>No behaviour patterns found.</div>}
      </Page>
    )

    const who = (
      <Page title="Who is involved" icon="entities" no={5}>
        {!ents.length ? <div>No entities found.</div>
          : (
            <>
              <div style={{ fontSize: "4.6cqw", color: MUTED, marginBottom: "2.5cqw" }}>{plural(entities.length, "entity", "entities")} in all. The riskiest:</div>
              {ents.map(en => (
                <div key={en.entity} style={{ display: "flex", alignItems: "center", gap: "2.4cqw", marginBottom: "2cqw" }}>
                  <i style={{ width: "4cqw", height: "5.4cqw", flexShrink: 0, background: TIER[en.max_tier]?.color, border: `2.5px solid ${INK}` }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sanitizeField(en.entity)}</span>
                  <span style={{ fontSize: "4.6cqw", color: MUTED, whiteSpace: "nowrap" }}>{en.event_count} ev, {en.avg_score}%</span>
                </div>
              ))}
            </>
          )}
      </Page>
    )

    const worstPage = (
      <Page title="Worst events" icon="bolt" no={6}>
        {worst.length ? worst.map((e, i) => (
          <div key={e.id} style={{ display: "flex", gap: "2.4cqw", marginBottom: "2.6cqw", alignItems: "flex-start" }}>
            <b style={{ fontFamily: "var(--pxfont)", fontSize: "7.3cqw", lineHeight: 1, width: "6cqw", color: TIER[e.threat_tier]?.dark }}>{i + 1}</b>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><b>{shortTitle(e)}</b></div>
              <div style={{ fontSize: "4.3cqw", color: MUTED }}>{Math.round(e.anomaly_score * 100)}% {TIER[e.threat_tier]?.name}, {String(e.timestamp).slice(5, 16)}</div>
            </div>
          </div>
        )) : <div>No events yet.</div>}
      </Page>
    )

    const story = (
      <Page title="Attack story" icon="replay" no={7}>
        {phases.length ? (
          <>
            <div style={{ fontSize: "4.6cqw", color: MUTED, marginBottom: "2.5cqw" }}>The attack phases that were recorded, in order.</div>
            {phases.slice(0, 6).map((p, i) => <div key={p} style={{ marginBottom: "2cqw" }}><b style={{ color: TIER[4].dark }}>{i + 1}.</b> {sanitizeField(p)}</div>)}
          </>
        ) : (
          <>
            <div style={{ marginBottom: "3cqw" }}>No attack phases are recorded, so there is no single story to tell. These are the events that happen most:</div>
            {common.map(([name, n, note]) => (
              <div key={name} style={{ marginBottom: "2cqw" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "2cqw" }}><b>{name}</b><span>{n}</span></div>
                {note && <div style={{ fontSize: "4.1cqw", color: MUTED }}>{note}</div>}
              </div>
            ))}
          </>
        )}
      </Page>
    )

    const records = (
      <Page title="Records" icon="lock" no={8}>
        <div style={{ marginBottom: "3cqw" }}>
          Every event is stored with a fingerprint that includes the one before it. If anyone changes or deletes a record, the chain breaks.
        </div>
        <Row label="Chain" color={chain === false ? TIER[4].dark : chain ? "#459373" : MUTED}>{chain === null || chain === undefined ? "checking" : chain ? "intact" : "BROKEN"}</Row>
        <Row label="Events on file">{total}</Row>
        <Row label="Newest fingerprint">{events.length ? String([...events].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))[0].event_hash || "").slice(0, 10) + "..." : "none"}</Row>
        <div style={{ marginTop: "3cqw", fontSize: "4.5cqw", color: MUTED }}>
          {chain === false ? "The chain is broken. Treat the records as unreliable until you know why." : "Nothing has been altered since the events were stored."}
        </div>
      </Page>
    )

    const steps = []
    if (tc[4]) steps.push(`Look at the ${plural(tc[4], "CRITICAL event")} first, starting with ${topEvent ? shortTitle(topEvent) : "the top card"}.`)
    if (tc[3]) steps.push(`Go through the ${tc[3]} HIGH events and dismiss the ones you can explain.`)
    if (ents.length && ents[0].max_tier >= 3) steps.push(`Check ${sanitizeField(ents[0].entity)}. It is the riskiest entity.`)
    if (phases.length) steps.push("Replay the attack to see the order things happened in.")
    if (chain === false) steps.push("Find out why the record chain is broken before trusting anything.")
    if (!steps.length) steps.push("Nothing urgent. Run a scan now and then to keep the case up to date.")
    const next = (
      <Page title="Next steps" icon="check" no={9}>
        {steps.slice(0, 5).map((s, i) => (
          <div key={i} style={{ display: "flex", gap: "2.6cqw", marginBottom: "3cqw" }}>
            <b style={{ fontFamily: "var(--pxfont)", fontSize: "7.8cqw", lineHeight: 1, color: TIER[3].dark }}>{i + 1}</b>
            <span>{s}</span>
          </div>
        ))}
        <div style={{ fontSize: "4.4cqw", color: MUTED, marginTop: "3cqw" }}>Nothing runs on its own. Blocking an account or an IP always waits for you.</div>
      </Page>
    )

    const backCover = (
      <div style={{ width: "100%", height: "100%", background: "#3d4d51", color: "#f8f4ec", position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", boxSizing: "border-box", padding: "8cqw" }}>
        <div style={{ position: "absolute", inset: "4cqw", border: `3px solid ${GOLD}` }} />
        <PxIcon name="check" size={64} />
        <div style={{ fontFamily: "var(--pxfont)", fontSize: "11.0cqw", marginTop: "4cqw", color: GOLD }}>END OF FILE</div>
        <div style={{ fontSize: "4.9cqw", marginTop: "3cqw", opacity: 0.75, lineHeight: 1.25 }}>Doesn't it feel good to FIND them?</div>
      </div>
    )
    return [cover, glance, levels, when, behaviour, who, worstPage, story, records, next, backCover]
  }, [events, entities, chain, scopeLabel])

  return (
    <div role="dialog" aria-modal="true" aria-label="Case summary book" onClick={(e) => { e.stopPropagation(); onClose() }}
      style={{ position: "fixed", inset: 0, zIndex: 1300, background: "rgba(10,18,18,.94)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: "min(820px, 100%)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span className="pz-title" style={{ fontSize: 28 }}>{scopeLabel ? "Scoped report" : "Case summary"}</span>
          <span style={{ fontSize: 17, color: "#b5e8f2" }}>drag a corner, click a page or use the arrow keys</span>
          <button className="pz-btn red small" style={{ marginLeft: "auto" }} onClick={onClose} aria-label="Close the book">X</button>
        </div>
        <PageFlip pages={pages} />
      </div>
    </div>
  )
}
