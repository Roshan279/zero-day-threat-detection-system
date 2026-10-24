import { useEffect, useMemo, useRef, useState } from "react"
import { Hand } from "./px/Card"
import { Btn } from "./px/ui"
import PxIcon from "./px/PxIcon"
import Desk from "./Desk"
import CaseFile from "./CaseFile"
import { DeckPile } from "./px/Shell"
import { cardFace, tierOf } from "./px/cardModel"
import { getHumanDescription, formatTimestamp } from "./Humanlog"

// ─────────────────────────────────────────────────────────────
// EVENTS: every event is a card. You pick cards from your hand, see what the play
// is worth (chips x mult), then investigate them or dismiss them.
// ─────────────────────────────────────────────────────────────
const MAX_SELECTED = 5
const SUIT_ORDER = { spade: 0, club: 1, diamond: 2, heart: 3 }

export const playTotals = (events) => {
  const chips = events.reduce((s, e) => s + Math.round((e.anomaly_score || 0) * 100), 0)
  const mult  = events.reduce((m, e) => Math.max(m, tierOf(e.threat_tier).mult), 0)
  return { chips, mult }
}

function HoverTip({ event }) {
  if (!event) return null
  const f = cardFace(event)
  return (
    <div className="pz-tip" style={{ position: "absolute", top: 58, left: 20, width: 330, zIndex: 30, pointerEvents: "none" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <PxIcon name={f.art} size={34} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 22, lineHeight: 1 }}>{f.title}</div>
          <div style={{ fontSize: 15, color: "#6b7b78" }}>{formatTimestamp(event.timestamp)}</div>
        </div>
        <span className="pz-tag" style={{ background: f.tier.color, color: f.tier.name === "MEDIUM" ? "#1d2527" : "#fff", textShadow: f.tier.name === "MEDIUM" ? "none" : undefined }}>{f.tier.name}</span>
      </div>
      <div style={{ fontSize: 18, marginTop: 6, lineHeight: 1.2 }}>{getHumanDescription(event)}</div>
      <div style={{ fontSize: 15, marginTop: 6, display: "flex", justifyContent: "space-between", color: "#4b5a58", fontWeight: 600 }}>
        <span>Anomaly {f.score}%</span><span>{event.source}</span>
      </div>
    </div>
  )
}

export default function EventsPage({
  events, filterTier, onFilterTier, selectedIds, onToggle, onClearSelection, seenIds,
  onScore, onMarkSeen, focusEvent, onFocus, onAskLuffy, onBlockEntity, onResetSeen, onScan, onReload,
  pinId = null, onUnpin,
  rail = 150,
}) {
  const [sortMode, setSortMode] = useState("score")
  const [offset, setOffset]     = useState(0)
  const [dealKey, setDealKey]   = useState(0)
  const [hover, setHover]       = useState(null)
  const [leaving, setLeaving]   = useState(new Set())
  const [desk, setDesk]         = useState(null)
  const [width, setWidth]       = useState(1000)
  const [height, setHeight]     = useState(700)
  const wrap = useRef(null)

  useEffect(() => {
    if (!wrap.current) return
    const ro = new ResizeObserver(([e]) => { setWidth(e.contentRect.width); setHeight(e.contentRect.height) })
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  const cardW = height < 640 || width < 760 ? 92 : height < 720 ? 102 : height < 780 ? 118 : height < 860 ? 130 : 146
  const handSize = Math.max(4, Math.min(11, Math.floor((width - rail - 60) / (cardW * 0.62))))

  const pool = useMemo(() => {
    const onDesk = new Set((desk?.cards || []).map(c => c.id))
    const unseen = events.filter(e => (e.threat_tier || 1) >= filterTier && !seenIds.has(e.id) && !onDesk.has(e.id))
    const by = {
      score: (a, b) => (b.anomaly_score || 0) - (a.anomaly_score || 0),
      rank:  (a, b) => (b.threat_tier || 0) - (a.threat_tier || 0) || (b.anomaly_score || 0) - (a.anomaly_score || 0),
      suit:  (a, b) => (SUIT_ORDER[cardFace(a).suit] - SUIT_ORDER[cardFace(b).suit]) || (b.threat_tier || 0) - (a.threat_tier || 0),
      time:  (a, b) => String(b.timestamp).localeCompare(String(a.timestamp)),
    }[sortMode]
    return unseen.sort(by)
  }, [events, filterTier, seenIds, sortMode, desk])

  // A card sent here from another page stays in the hand until you draw, sort or filter
  const baseStart = offset >= pool.length ? 0 : offset
  const pinIdx = pinId == null ? -1 : pool.findIndex(e => e.id === pinId)
  const start = pinIdx >= 0 && (pinIdx < baseStart || pinIdx >= baseStart + handSize) ? Math.floor(pinIdx / handSize) * handSize : baseStart
  const hand = pool.slice(start, start + handSize)
  const remaining = Math.max(0, pool.length - hand.length)

  const selected = hand.filter(e => selectedIds.has(e.id))
  const totals = playTotals(selected)

  const redeal = () => setDealKey(k => k + 1)
  const sortBy = (m) => { onUnpin?.(); setSortMode(m); setOffset(0); redeal() }
  const draw = () => {
    onUnpin?.()
    if (pool.length <= handSize) { setOffset(0); redeal(); return }
    const next = start + handSize
    setOffset(next >= pool.length ? 0 : next)
    onClearSelection()
    redeal()
  }
  const filter = (t) => { onUnpin?.(); onFilterTier(t); setOffset(0); redeal() }

  // Investigate: the cards move to the desk and stay there until each one is decided
  const investigate = () => {
    if (!selected.length || desk) return
    const { chips, mult } = totals
    const cards = [...selected].sort((a, b) => (b.anomaly_score || 0) - (a.anomaly_score || 0))
    onScore(chips * mult, selected)
    onClearSelection()
    onFocus(null)
    setDesk({ cards, chips, mult, points: chips * mult })
  }
  const dismiss = () => {
    if (!selected.length || desk) return
    const ids = new Set(selected.map(e => e.id))
    setLeaving(ids)
    setTimeout(() => { onMarkSeen([...ids]); onClearSelection(); setLeaving(new Set()) }, 520)
  }

  const filters = [[0, "ALL"], [3, "HIGH+"], [4, "CRITICAL"]]

  return (
    <div ref={wrap} style={{ position: "relative", height: "100%", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", position: "relative", zIndex: 5, padding: `4px ${rail}px 0 20px` }}>
        <span className="pz-label">Show</span>
        {filters.map(([v, l]) => (
          <Btn key={v} size="small" color={filterTier === v ? "gold" : "gray"} onClick={() => filter(v)}>{l}</Btn>
        ))}
      </div>

      {!desk && <HoverTip event={hover} />}

      {/* Case file when another page sends you here with an event in focus */}
      {focusEvent && !desk && (
        <div style={{ position: "absolute", right: rail, top: 0, bottom: 0, display: "flex", alignItems: "flex-start", zIndex: 8 }}>
          <CaseFile event={focusEvent} onAskLuffy={onAskLuffy} onBlockEntity={onBlockEntity} onClose={() => onFocus(null)} />
        </div>
      )}

      {/* The hand, its buttons and a hint, kept together in the middle of the table */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {!hand.length && !desk ? (
          <div className="pz-panel pz-bounce-in" style={{ alignSelf: "center", padding: 22, textAlign: "center", maxWidth: 380, marginBottom: 40 }}>
            <PxIcon name="check" size={52} style={{ margin: "0 auto 8px" }} />
            <div className="pz-title" style={{ fontSize: 28 }}>Your hand is empty</div>
            <div style={{ color: "#b5e8f2", margin: "6px 0 14px" }}>
              {seenIds.size ? "Every card here has been reviewed." : "No events match this filter yet."}
            </div>
            {seenIds.size > 0 && <Btn color="blue" onClick={onResetSeen}>Bring back reviewed cards</Btn>}
          </div>
        ) : (
          <div className="pz-title" style={{ textAlign: "center", fontSize: 24, opacity: .9, marginBottom: 10, padding: `0 ${rail}px 0 20px`, textShadow: "0 3px 0 rgba(0,0,0,.55)" }}>
            Pick up to {MAX_SELECTED} cards. Hover one to read it.
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-end", gap: 18, padding: `6px ${rail}px 0 20px`, position: "relative", zIndex: 6 }}>
          <Btn color="blue" className="big" disabled={!selected.length || !!desk} onClick={investigate} style={{ minWidth: 150 }}>Investigate</Btn>
          <div className="pz-panel" style={{ padding: "6px 12px 10px", textAlign: "center" }}>
            <div className="pz-label" style={{ fontSize: 14, marginBottom: 4 }}>Sort hand</div>
            <div style={{ display: "flex", gap: 6 }}>
              {[["score", "Score"], ["rank", "Rank"], ["suit", "Suit"], ["time", "Time"]].map(([m, l]) => (
                <Btn key={m} size="small" color={sortMode === m ? "gold" : "orange"} onClick={() => sortBy(m)}>{l}</Btn>
              ))}
            </div>
          </div>
          <Btn color="red" className="big" disabled={!selected.length || !!desk} onClick={dismiss} style={{ minWidth: 150 }}>Dismiss</Btn>
        </div>

        <div style={{ padding: `34px ${rail}px 0 20px`, position: "relative", zIndex: 4 }}>
          <Hand
            events={hand}
            cardWidth={cardW}
            dealKey={`${dealKey}-${sortMode}-${filterTier}`}
            selectedIds={selectedIds}
            leavingIds={leaving}
            onToggle={(ev) => {
              if (desk) return
              if (!selectedIds.has(ev.id) && selectedIds.size >= MAX_SELECTED) return
              onToggle(ev)
            }}
            onHover={setHover}
            from={{ x: Math.max(300, width - rail - 120), y: 60 }}
          />
        </div>
      </div>

      {desk && (
        <Desk
          cards={desk.cards} chips={desk.chips} mult={desk.mult} points={desk.points} rail={rail}
          cardW={height >= 800 ? 124 : 104}
          onResolve={(ev) => onMarkSeen([ev.id])}
          onClose={() => setDesk(null)}
          onAskLuffy={onAskLuffy} onBlockEntity={onBlockEntity}
        />
      )}

      <DeckPile remaining={remaining} total={pool.length} onDraw={draw} onScan={onScan} onReload={onReload} />
    </div>
  )
}
