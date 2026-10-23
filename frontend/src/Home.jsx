import { useMemo } from "react"
import { CardStack, PixelCard } from "./px/Card"
import { LuffyAvatar } from "./px/PixelLuffy"
import { MOOD_CONFIG } from "./LuffyOverlay"
import { Btn } from "./px/ui"
import { TIER } from "./px/cardModel"
import ThreatCube from "./ThreatCube"

// ─────────────────────────────────────────────────────────────
// HOME: the case at a glance. One card pile per threat level, the worst cards
// on top, and Luffy's briefing.
// ─────────────────────────────────────────────────────────────

const STEPS = [
  ["1", "COLLECT", "Windows Event Log, journald or the macOS log, in real time."],
  ["2", "SCORE", "Machine learning gives every event a threat level."],
  ["3", "CHAIN", "Each record is hash-chained, so tampering shows."],
  ["4", "INVESTIGATE", "Luffy explains what happened and cites the evidence."],
  ["5", "RESPOND", "Block accounts or IPs once you approve it."],
]

export default function Home({ events = [], seenIds, mood = "idle", online = true, onNavigate, onDemo }) {
  const stats = useMemo(() => {
    const by = { 1: [], 2: [], 3: [], 4: [] }
    events.forEach(e => { if (by[e.threat_tier]) by[e.threat_tier].push(e) })
    Object.values(by).forEach(l => l.sort((a, b) => (b.anomaly_score || 0) - (a.anomaly_score || 0)))
    const top = events.filter(e => (e.threat_tier || 1) >= 3 && !seenIds.has(e.id))
      .sort((a, b) => (b.anomaly_score || 0) - (a.anomaly_score || 0)).slice(0, 6)
    return { by, top }
  }, [events, seenIds])

  const total = events.length
  const critical = stats.by[4].length
  const high = stats.by[3].length
  const topScore = events.reduce((m, e) => Math.max(m, Math.round((e.anomaly_score || 0) * 100)), 0)
  const color = (MOOD_CONFIG[mood] || MOOD_CONFIG.idle).color

  const briefing = !online
    ? "I can't reach the backend, so I can't see any events. Start it and I'll get back to work."
    : !total ? "No events yet. Hit scan and I'll go look around."
    : critical ? `${critical} critical and ${high} high-risk events are waiting. Start with the red pile.`
    : high ? `${high} high-risk events need a look. Nothing critical, which is good.`
    : `All quiet. I've checked ${total} events and nothing worries me.`

  const piles = [4, 3, 2, 1]

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "14px 160px 30px 20px" }}>
      {/* Threat layers + everything that explains them */}
      <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: "1 1 420px", minWidth: 320 }}>
          <div className="pz-fade-up" style={{ marginBottom: 6 }}>
            <div className="pz-label" style={{ color: "var(--gold)" }}>Threat layers</div>
            <div className="pz-title" style={{ fontSize: 34, margin: "2px 0 10px", textShadow: "0 3px 0 rgba(0,0,0,.55)" }}>Every event, stacked by risk.</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {[
                ["EVENTS", total, "#4a6a72"],
                ["CRITICAL", critical, TIER[4].color],
                ["HIGH", high, TIER[3].color],
                ["TOP SCORE", `${topScore}%`, "#7d5fb0"],
              ].map(([k, v, c], i) => (
                <div key={k} className="pz-panel pz-bounce-in" style={{ padding: 0, overflow: "hidden", minWidth: 96, animationDelay: `${i * 0.07}s` }}>
                  <div style={{ background: c, color: "#fff", fontSize: 13, letterSpacing: ".12em", padding: "2px 8px", textShadow: "0 2px 0 rgba(0,0,0,.4)" }}>{k}</div>
                  <div style={{ fontSize: 28, fontWeight: 700, padding: "2px 8px 4px" }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
          <ThreatCube events={events} onOpen={t => onNavigate("dashboard", { filter: t >= 3 ? t : 0 })} />
        </div>

        <div style={{ flex: "1 1 500px", minWidth: 300 }}>
    <div className="pz-panel paper pz-bounce-in" style={{ padding: 14, marginBottom: 16, maxWidth: 520 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
        <LuffyAvatar mood={mood} size={58} color={color} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 22, letterSpacing: ".06em" }}>LUFFY'S BRIEFING</div>
          <div style={{ fontSize: 17, color: "#6b7b78" }}>live from the left panel</div>
        </div>
      </div>
      <div style={{ fontSize: 22, lineHeight: 1.25 }}>{briefing}</div>
      <div style={{ marginTop: 12 }}>
        <Btn color={critical || high ? "red" : "blue"} onClick={() => onNavigate(critical || high ? "dashboard" : "luffy", critical || high ? { filter: critical ? 4 : 3 } : undefined)}>
          {critical || high ? "Show me" : "Ask Luffy"}
        </Btn>
      </div>
    </div>
          <div className="pz-label" style={{ marginBottom: 6 }}>Threat piles. Click one to open it. Hover a layer on the left to lift it.</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {piles.map((t, i) => (
              <div key={t} className="pz-fade-up" style={{ animationDelay: `${i * 0.08}s` }}>
                <CardStack
                  tier={TIER[t]} count={stats.by[t].length} events={stats.by[t]} width={78}
                  onPick={ev => onNavigate("dashboard", { focus: ev })}
                  onClick={() => onNavigate("dashboard", { filter: t >= 3 ? t : 0 })}
                />
              </div>
            ))}
          </div>

          <div className="pz-label" style={{ margin: "6px 0 4px" }}>Worst cards right now</div>
          {stats.top.length ? (
            <div style={{ position: "relative", height: 150, marginBottom: 12 }}>
              {stats.top.map((ev, i) => (
                <PixelCard key={ev.id} event={ev} width={88} x={i * 62} y={8} rot={(i - 2.5) * 2} z={i + 1} delay={i * 0.06}
                  onClick={() => onNavigate("dashboard", { focus: ev })} />
              ))}
            </div>
          ) : (
            <div className="pz-panel" style={{ padding: 16, maxWidth: 420, marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 23 }}>No high-risk cards.</div>
              <div style={{ color: "#9fb4b2", margin: "4px 0 10px" }}>You can inject a demo attack to see how the cards look.</div>
              <Btn color="purple" onClick={onDemo}>Inject demo attack</Btn>
            </div>
          )}

          <div className="pz-label" style={{ margin: "6px 0 6px" }}>How it works</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {STEPS.map(([n, t, d], i) => (
              <div key={n} className="pz-panel paper pz-fade-up" style={{ width: 148, padding: "8px 10px", animationDelay: `${i * 0.07}s`, transition: "transform .15s" }}
                onMouseEnter={e => { e.currentTarget.style.transform = "translateY(-6px) rotate(-1deg)" }}
                onMouseLeave={e => { e.currentTarget.style.transform = "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 24, height: 24, border: "3px solid var(--ink)", borderRadius: "50%", background: "var(--gold)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>{n}</span>
                  <span style={{ fontWeight: 700, fontSize: 18 }}>{t}</span>
                </div>
                <div style={{ fontSize: 16, marginTop: 4, lineHeight: 1.15, color: "#3e4d4b" }}>{d}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
