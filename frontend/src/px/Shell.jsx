import { useState } from "react"
import PxIcon from "./PxIcon"
import { Counter, Btn } from "./ui"
import { CardBack } from "./Card"
import { tierOf } from "./cardModel"

// ─────────────────────────────────────────────────────────────
// LEFT PANEL: the "blind" column. Everything here is live data.
// ─────────────────────────────────────────────────────────────
export const LEFT_WIDTH = 290

function StatTile({ label, color, children }) {
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="pz-tag" style={{ display: "block", textAlign: "center", background: color, borderRadius: "6px 6px 0 0", fontSize: 14, letterSpacing: 0, padding: "3px 2px", whiteSpace: "nowrap", overflow: "hidden" }}>{label}</div>
      <div className="pz-inset" style={{ borderRadius: "0 0 8px 8px", borderTop: 0, height: 38, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 30, color: "#fe5f55", textShadow: "0 2px 0 rgba(0,0,0,.6)" }}>
        {children}
      </div>
    </div>
  )
}

export function LeftPanel({
  threat = 1, topScore = 0, caseScore = 0, chips = 0, mult = 0, selectedCount = 0,
  critical = 0, high = 0, total = 0, entities = 0, chain = null, online = true,
  onInfo, onOptions, reserve = 0,
}) {
  const t = tierOf(threat)
  const icon = !online ? "lock" : threat >= 4 ? "skull" : threat >= 3 ? "warn" : threat >= 2 ? "eye" : "check"
  const stars = threat >= 4 ? 5 : threat >= 3 ? 4 : threat >= 2 ? 3 : 1
  return (
    <aside
      className="pz-left"
      style={{
        position: "relative", zIndex: 2, width: LEFT_WIDTH, flexShrink: 0, height: "100%",
        padding: `10px 12px ${10 + reserve}px 12px`, display: "flex", flexDirection: "column", gap: 7,
        background: "linear-gradient(180deg, #2b5a45 0%, #234a38 100%)",
        borderRight: "4px solid var(--ink)", boxShadow: "6px 0 0 rgba(0,0,0,.25)",
        overflowY: "auto", overflowX: "hidden",
      }}
    >
      {/* Blind banner: how bad is it right now */}
      <div className="pz-panel" style={{ background: online ? t.color : "#6f8583", padding: "4px 8px 5px", textAlign: "center", color: online ? (t.name === "MEDIUM" ? "#1d2527" : "#fff") : "#fff" }}>
        <div className="pz-title" style={{ fontSize: 30, lineHeight: 1, textShadow: t.name === "MEDIUM" ? "none" : undefined }}>
          {online ? `${t.name} THREAT` : "OFFLINE"}
        </div>
        <div style={{ fontSize: 13, opacity: .85, letterSpacing: ".06em" }}>FORENSIC DETECTIVE</div>
      </div>

      {/* Score to beat */}
      <div className="pz-inset" style={{ padding: "6px 10px", display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ width: 50, height: 50, borderRadius: "50%", background: t.dark, border: "3px solid var(--ink)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }} className={threat >= 3 && online ? "pz-float" : ""}>
          <PxIcon name={icon} size={32} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pz-label" style={{ fontSize: 14 }}>Top anomaly</div>
          <div style={{ color: "#fe5f55", fontWeight: 700, fontSize: 34, lineHeight: 1, textShadow: "0 2px 0 rgba(0,0,0,.6)" }}><Counter value={topScore} format={v => `${v}%`} /></div>
          <div style={{ display: "flex", gap: 2, marginTop: 2 }}>
            {Array.from({ length: stars }, (_, i) => <PxIcon key={i} name="star" size={14} />)}
          </div>
        </div>
      </div>

      {/* Round score */}
      <div className="pz-inset" style={{ padding: "4px 10px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 54, lineHeight: 1.05, fontSize: 15, color: "#9fb4b2", letterSpacing: ".06em" }}>CASE<br />SCORE</div>
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, background: "#0f1819", border: "3px solid var(--ink)", borderRadius: 8, padding: "4px 8px", justifyContent: "flex-end" }}>
          <PxIcon name="chip" size={22} />
          <Counter value={caseScore} style={{ fontSize: 32, fontWeight: 700 }} />
        </div>
      </div>

      {/* Chips x Mult for the selected cards */}
      <div className="pz-inset" style={{ padding: "5px 8px", display: "flex", alignItems: "center", gap: 8 }}>
        <div className="pz-chipbox" style={{ flex: 1 }}><Counter value={chips} duration={350} /></div>
        <span style={{ fontSize: 33, fontWeight: 700, color: "#fe5f55", textShadow: "0 2px 0 rgba(0,0,0,.6)" }}>x</span>
        <div className="pz-multbox" style={{ flex: 1 }}><Counter value={mult} duration={350} /></div>
      </div>
      {selectedCount > 0 && (
        <div style={{ fontSize: 14, color: "#cfe0dd", textAlign: "center", marginTop: -3 }}>{selectedCount} card{selectedCount > 1 ? "s" : ""} selected</div>
      )}

      {/* Buttons + tiles */}
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: "0 0 104px" }}>
          <Btn className="big" style={{ flex: 1, lineHeight: 1.1, padding: "6px 4px", fontSize: 19 }} onClick={onInfo}>Case<br />Info</Btn>
          <Btn className="big" style={{ flex: 1, lineHeight: 1.1, padding: "6px 4px", fontSize: 19 }} color="gold" onClick={onOptions}>Options</Btn>
        </div>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <div style={{ display: "flex", gap: 8 }}>
            <StatTile label="CRITICAL" color="var(--red)"><Counter value={critical} /></StatTile>
            <StatTile label="HIGH" color="var(--orange)"><Counter value={high} /></StatTile>
          </div>
          <div className="pz-inset" style={{ flex: 1, minHeight: 40, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--gold)", fontWeight: 700, fontSize: 32, textShadow: "0 2px 0 rgba(0,0,0,.6)" }}>
            <PxIcon name="scroll" size={24} /><Counter value={total} />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <StatTile label="ENTITIES" color="var(--orange)"><span style={{ color: "#fff" }}><Counter value={entities} /></span></StatTile>
        <StatTile label="CHAIN" color={chain === false ? "var(--red)" : "var(--green-d)"}>
          <span style={{ color: chain === false ? "#fe5f55" : "#4bc292", fontSize: 28 }}>{chain === null ? "..." : chain ? "OK" : "BAD"}</span>
        </StatTile>
      </div>
    </aside>
  )
}

// ─────────────────────────────────────────────────────────────
// JOKER ROW: the tabs, drawn as joker cards with hover descriptions
// ─────────────────────────────────────────────────────────────
export const JOKERS = [
  { id: "home",      name: "HOME",      icon: "home",     bg: "#5d9fd0", rarity: "Common",   desc: "Your case at a glance: threat stacks, status and Luffy's briefing." },
  { id: "dashboard", name: "EVENTS",    icon: "events",   bg: "#d98b4b", rarity: "Common",   desc: "Every event as a card. Pick cards, size up the play, then investigate." },
  { id: "graphs",    name: "GRAPHS",    icon: "graphs",   bg: "#7bbf6a", rarity: "Common",   desc: "Threat levels, activity and behaviour clusters as charts." },
  { id: "entity",    name: "ENTITIES",  icon: "entities", bg: "#c46bd3", rarity: "Uncommon", desc: "Who is connected to what. Drag nodes, click one to inspect it." },
  { id: "features",  name: "ML SCORES", icon: "ml",       bg: "#8f7bff", rarity: "Uncommon", desc: "Why the model flagged each event, feature by feature." },
  { id: "response",  name: "RESPONSE",  icon: "response", bg: "#4fb0a8", rarity: "Rare",     desc: "What would happen at each threat level. Nothing runs without you." },
  { id: "replay",    name: "REPLAY",    icon: "replay",   bg: "#e8b13a", rarity: "Rare",     desc: "Play an incident back step by step, with Luffy narrating." },
  { id: "luffy",     name: "LUFFY",     icon: "chat",     bg: "#e0685c", rarity: "Legendary", desc: "Ask Luffy anything, or give him a command." },
]
const RARITY = { Common: "#0093ff", Uncommon: "#4bc292", Rare: "#fe5f55", Legendary: "#9b6bff" }

export function JokerRow({ active, onSelect, badges = {} }) {
  const [hover, setHover] = useState(null)
  const hovered = JOKERS.find(j => j.id === hover)
  return (
    <nav aria-label="Pages" style={{ position: "relative", display: "flex", justifyContent: "center", gap: 6, padding: "30px 150px 0 20px", flexWrap: "nowrap" }}>
      {JOKERS.map((j, i) => (
        <button
          key={j.id}
          className={`pz-joker ${active === j.id ? "active" : ""}`}
          style={{ "--d": `${i * -0.5}s`, "--jbg": j.bg, marginLeft: i ? -10 : 0 }}
          onClick={() => onSelect(j.id)}
          onMouseEnter={() => setHover(j.id)}
          onMouseLeave={() => setHover(null)}
          onFocus={() => setHover(j.id)}
          onBlur={() => setHover(null)}
          aria-label={j.name}
          aria-current={active === j.id ? "page" : undefined}
        >
          <div className="j-art"><PxIcon name={j.icon} size={52} /></div>
          <div className="j-name">{j.name}</div>
          {badges[j.id] > 0 && <div className="j-badge">{badges[j.id] > 99 ? "99+" : badges[j.id]}</div>}
        </button>
      ))}
      {hovered && (
        <div className="pz-tip up" style={{ position: "absolute", top: 196, left: "50%", translate: "-50% 0", width: 280, zIndex: 60, pointerEvents: "none", textAlign: "center" }}>
          <div style={{ fontWeight: 700, fontSize: 26 }}>{hovered.name}</div>
          <div style={{ fontSize: 18, margin: "4px 0 8px", lineHeight: 1.2 }}>{hovered.desc}</div>
          <span className="pz-tag" style={{ background: RARITY[hovered.rarity] }}>{hovered.rarity}</span>
        </div>
      )}
    </nav>
  )
}

// ─────────────────────────────────────────────────────────────
// RIGHT RAIL: the alert slot, the deck, and two utility dice
// ─────────────────────────────────────────────────────────────
export function AlertSlot({ alerts = [], max = 3, onClick }) {
  const latest = alerts[0]
  const t = latest ? tierOf(latest.threat_tier) : null
  return (
    <div style={{ position: "absolute", right: 22, top: 26, zIndex: 20, textAlign: "center" }}>
      <button
        onClick={() => latest && onClick && onClick(latest)}
        className={latest ? "pz-card" : "pz-card back"}
        style={{
          "--cw": "104px", "--x": "0px", "--y": "0px", "--r": latest ? "3deg" : "0deg", position: "relative",
          background: latest ? "linear-gradient(180deg,#f3e3a8,#e0c777)" : undefined, animation: latest ? "pz-bounce-in .5s" : "none",
          cursor: latest ? "pointer" : "default", display: "block",
        }}
        aria-label={latest ? "Open latest alert" : "No alerts"}
      >
        <div style={{ position: "absolute", inset: 8, border: `3px solid var(--ink)`, borderRadius: 6, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6 }}>
          {latest ? (
            <>
              <PxIcon name="warn" size={48} className="pz-float" />
              <div style={{ fontWeight: 700, fontSize: 18, color: t.dark }}>{t.name}</div>
            </>
          ) : (
            <PxIcon name="check" size={40} />
          )}
        </div>
      </button>
      <div style={{ marginTop: 8, fontSize: 18, fontWeight: 700, color: "#cfe0dd", textShadow: "0 2px 0 rgba(0,0,0,.6)" }}>{alerts.length}/{max}</div>
    </div>
  )
}

export function DeckPile({ remaining, total, onDraw, onScan, onReload }) {
  const [shake, setShake] = useState(false)
  const draw = () => { setShake(true); setTimeout(() => setShake(false), 400); onDraw && onDraw() }
  return (
    <div style={{ position: "absolute", right: 18, bottom: 24, zIndex: 20, width: 112, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <div style={{ display: "flex", flexDirection: "row", gap: 10 }}>
        <button className="pz-btn gray small" title="Scan the logs now" onClick={onScan} style={{ padding: 6 }}><PxIcon name="dice" size={26} /></button>
        <button className="pz-btn gray small" title="Reload data" onClick={onReload} style={{ padding: 6 }}><PxIcon name="dice" size={26} /></button>
      </div>
      <div style={{ textAlign: "center" }}>
        <div
          onClick={draw}
          style={{ position: "relative", width: 112, height: 150, cursor: "pointer" }}
          className={shake ? "pz-shake" : ""}
          title="Draw more cards"
          role="button"
          aria-label="Draw more cards"
        >
          {[3, 2, 1, 0].map(k => <CardBack key={k} width={98} x={k * 3} y={-k * 3 + 6} z={4 - k} />)}
        </div>
        <div style={{ fontWeight: 700, fontSize: 20, marginTop: 10, textShadow: "0 2px 0 rgba(0,0,0,.6)" }}>{remaining}/{total}</div>
      </div>
    </div>
  )
}
