import { useEffect, useRef, useState } from "react"
import { PixelCard } from "./px/Card"
import { Btn, Counter } from "./px/ui"
import CaseFile from "./CaseFile"
import { cardFace } from "./px/cardModel"

// ─────────────────────────────────────────────────────────────
// DESK: the investigation. The played cards stay on the table until you decide about each one.
// Click a card to read its full case file. Slide it left to clear it (nothing to see here),
// or right to escalate it (this needs attention). Drag it, or use the two buttons.
// ─────────────────────────────────────────────────────────────
const THRESHOLD = 110
const EXIT_MS = 520

function Banner({ chips, mult, points, total, left }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div className="pz-title pz-bounce-in" style={{ fontSize: 31 }}>Investigation</div>
      <div className="pz-chipbox pz-bounce-in" style={{ minWidth: 70, animationDelay: ".1s" }}>{chips}</div>
      <span className="pz-title" style={{ fontSize: 26, color: "var(--red)" }}>x</span>
      <div className="pz-multbox pz-bounce-in" style={{ minWidth: 60, animationDelay: ".2s" }}>{mult}</div>
      <div className="pz-title pz-bounce-in" style={{ fontSize: 36, color: "var(--gold)", animationDelay: ".4s" }}>
        <Counter value={points} duration={1400} format={v => `+${v.toLocaleString()}`} />
      </div>
      <span className="pz-pill" style={{ marginLeft: "auto" }}>{total - left} of {total} decided</span>
    </div>
  )
}

export default function Desk({ cards, chips, mult, points, rail = 150, cardW = 124, onResolve, onClose, onAskLuffy, onBlockEntity }) {
  const [remaining, setRemaining] = useState(cards)
  const [activeId, setActiveId]   = useState(cards[0]?.id)
  const [verdicts, setVerdicts]   = useState({})
  const [drag, setDrag]           = useState({ id: null, dx: 0 })
  const [exit, setExit]           = useState({ id: null, dir: 0 })
  const start = useRef(null)

  // the active card is always one that is still on the table
  const active = remaining.find(c => c.id === activeId) || remaining[0] || null
  const done = remaining.length === 0

  const decide = (ev, dir) => {
    if (exit.id) return
    setDrag({ id: null, dx: 0 })
    setExit({ id: ev.id, dir })
    setTimeout(() => {
      const verdict = dir < 0 ? "cleared" : "escalated"
      setVerdicts(v => ({ ...v, [ev.id]: verdict }))
      onResolve(ev, verdict)
      setRemaining(r => r.filter(c => c.id !== ev.id))
      setExit({ id: null, dir: 0 })
    }, EXIT_MS)
  }

  useEffect(() => {
    const onKey = (e) => {
      if (exit.id || done || !active) return
      if (e.key === "ArrowLeft") decide(active, -1)
      if (e.key === "ArrowRight") decide(active, 1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  const down = (e, ev) => { start.current = { x: e.clientX, id: ev.id }; setDrag({ id: ev.id, dx: 0 }); e.currentTarget.setPointerCapture(e.pointerId) }
  const move = (e) => { if (start.current) setDrag({ id: start.current.id, dx: e.clientX - start.current.x }) }
  const up = (e, ev) => {
    const dx = start.current ? e.clientX - start.current.x : 0
    start.current = null
    if (Math.abs(dx) > THRESHOLD) decide(ev, dx < 0 ? -1 : 1)
    else { setDrag({ id: null, dx: 0 }); if (Math.abs(dx) < 6) setActiveId(ev.id) }
  }

  const escalated = Object.entries(verdicts).filter(([, v]) => v === "escalated").map(([id]) => cards.find(c => String(c.id) === id))
  const clearedCount = Object.values(verdicts).filter(v => v === "cleared").length

  return (
    <div className="pz-bounce-in" style={{
      position: "absolute", top: 0, bottom: 8, left: 8, right: rail, zIndex: 25, display: "flex", flexDirection: "column", padding: "10px 14px 12px 16px",
      background: "linear-gradient(180deg, rgba(14,28,34,.93), rgba(18,34,40,.9))", border: "3px solid var(--ink)", borderRadius: 14, boxShadow: "0 6px 0 rgba(0,0,0,.4)",
    }}>
      <Banner chips={chips} mult={mult} points={points} total={cards.length} left={remaining.length} />

      <div style={{ flex: 1, minHeight: 0, display: "flex", gap: 18, marginTop: 8 }}>
        <div style={{ position: "relative", flex: "0 0 clamp(320px, 36%, 440px)", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          {done ? (
            <div className="pz-panel pz-bounce-in" style={{ padding: 22, textAlign: "center", maxWidth: 420 }}>
              <div className="pz-title" style={{ fontSize: 34 }}>Case closed</div>
              <div style={{ display: "flex", justifyContent: "center", gap: 14, margin: "12px 0" }}>
                <div className="pz-inset" style={{ padding: "8px 16px" }}><div className="pz-label">Cleared</div><div className="pz-title" style={{ fontSize: 34, color: "var(--green)" }}>{clearedCount}</div></div>
                <div className="pz-inset" style={{ padding: "8px 16px" }}><div className="pz-label">Escalated</div><div className="pz-title" style={{ fontSize: 34, color: "var(--red)" }}>{escalated.length}</div></div>
              </div>
              <div style={{ color: "#9fb4b2", fontSize: 19, marginBottom: 14 }}>
                {escalated.length ? "Escalated cards stay in the case record. Ask Luffy for the next step." : "Everything was cleared. The hand is yours again."}
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                {escalated.length > 0 && <Btn color="blue" onClick={() => onAskLuffy && onAskLuffy(escalated[0])}>Ask Luffy</Btn>}
                <Btn color="gold" onClick={onClose}>Back to the hand</Btn>
              </div>
            </div>
          ) : (
            <>
              <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", flexWrap: "nowrap", minHeight: cardW * 1.4 * 1.16 + 30, padding: "26px 10px 0" }}>
                {remaining.map((ev, i) => {
                  const isActive = active && ev.id === active.id
                  const leaving = exit.id === ev.id
                  const dx = leaving ? exit.dir * 900 : drag.id === ev.id ? drag.dx : 0
                  const tilt = leaving ? exit.dir * 24 : dx / 22
                  const intent = !leaving && drag.id === ev.id ? Math.min(1, Math.abs(dx) / THRESHOLD) : 0
                  const dir = dx < 0 ? -1 : 1
                  return (
                    <div
                      key={ev.id}
                      onPointerDown={isActive ? (e) => down(e, ev) : undefined}
                      onPointerMove={isActive ? move : undefined}
                      onPointerUp={isActive ? (e) => up(e, ev) : undefined}
                      onClick={!isActive ? () => setActiveId(ev.id) : undefined}
                      className="pz-bounce-in"
                      style={{
                        position: "relative", width: cardW, height: cardW * 1.4, flex: "0 0 auto", marginLeft: i === 0 ? 0 : remaining.length > 3 ? -cardW * 0.42 : remaining.length > 1 ? -cardW * 0.1 : 0,
                        cursor: isActive ? "grab" : "pointer", touchAction: "none",
                        animationDelay: `${i * 0.12}s`,
                        translate: `${dx}px ${isActive ? -14 : 0}px`,
                        rotate: `${tilt}deg`, scale: isActive ? 1.16 : .9,
                        opacity: leaving ? 0 : isActive ? 1 : .72,
                        zIndex: isActive ? 5 : 1,
                        transition: drag.id === ev.id ? "none" : `translate ${EXIT_MS}ms ease-in, rotate ${EXIT_MS}ms ease-in, scale .25s cubic-bezier(.3,1.5,.5,1), opacity ${EXIT_MS}ms`,
                      }}
                      role="button" aria-label={`Open the case file for ${cardFace(ev).title}`}
                    >
                      <PixelCard event={ev} width={cardW} interactive={false} style={{ animation: "none", "--lift": "0px", boxShadow: isActive ? "0 0 0 4px var(--gold), 0 16px 0 rgba(0,0,0,.3)" : undefined }} />
                      <span className="pz-score-pop" style={{ left: cardW / 2 - 24, top: 8, animationDelay: `${0.35 + i * 0.25}s`, opacity: 0, animationFillMode: "forwards" }}>+{cardFace(ev).score}</span>
                      {/* what the swipe will do */}
                      {isActive && intent > 0.15 && (
                        <div style={{
                          position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 8, opacity: intent,
                          background: dir < 0 ? "rgba(75,194,146,.55)" : "rgba(254,95,85,.55)", pointerEvents: "none",
                        }}>
                          <span className="pz-title" style={{ fontSize: 30, rotate: dir < 0 ? "-12deg" : "12deg", border: "4px solid #fff", padding: "0 8px", borderRadius: 6 }}>{dir < 0 ? "CLEAR" : "ESCALATE"}</span>
                        </div>
                      )}
                      {leaving && (
                        <div className="pz-tag" style={{ position: "absolute", left: "50%", top: "42%", translate: "-50% 0", fontSize: 24, background: exit.dir < 0 ? "var(--green-d)" : "var(--red-d)", rotate: "-8deg" }}>
                          {exit.dir < 0 ? "CLEARED" : "ESCALATED"}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="pz-fade-up" style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 18, animationDelay: ".5s" }}>
                <Btn color="green" className="big" disabled={!!exit.id} onClick={() => active && decide(active, -1)}>{"<"} Clear</Btn>
                <div style={{ textAlign: "center", fontSize: 18, color: "#cfe0dd", maxWidth: 210, lineHeight: 1.15 }}>
                  Slide the card left to clear it, right to escalate it.
                </div>
                <Btn color="red" className="big" disabled={!!exit.id} onClick={() => active && decide(active, 1)}>Escalate {">"}</Btn>
              </div>
              <button className="pz-btn gray small" style={{ marginTop: 12 }} onClick={onClose}>Put the rest back in my hand</button>
            </>
          )}
        </div>

        {active && !done && (
          <div style={{ flex: 1, minWidth: 0, maxHeight: "100%" }}>
            <CaseFile key={active.id} event={active} wide inlineLuffy onAskLuffy={onAskLuffy} onBlockEntity={onBlockEntity} />
          </div>
        )}
      </div>
    </div>
  )
}
