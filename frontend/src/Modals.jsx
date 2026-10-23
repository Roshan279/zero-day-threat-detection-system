import { useEffect } from "react"
import PixelLuffy from "./px/PixelLuffy"
import PxIcon from "./px/PxIcon"
import { Btn } from "./px/ui"
import { API } from "./api"

// ─────────────────────────────────────────────────────────────
// CASE INFO: the "game over" style summary of the whole case so far
// ─────────────────────────────────────────────────────────────
function Row({ label, children, tone }) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 8, marginBottom: 5 }}>
      <div style={{ flex: "0 0 150px", background: "#26373b", border: "3px solid var(--ink)", borderRadius: 8, padding: "2px 10px", fontSize: 19, fontWeight: 600, display: "flex", alignItems: "center" }}>{label}</div>
      <div style={{ flex: 1, minWidth: 0, background: "#1b2829", border: "3px solid var(--ink)", borderRadius: 8, padding: "2px 12px", fontSize: 25, fontWeight: 700, textAlign: "right", color: tone || "#fff", textShadow: "0 2px 0 rgba(0,0,0,.6)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{children}</div>
    </div>
  )
}

export function CaseInfoModal({ stats, mood, onClose, onScan }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const line =
    stats.critical > 0 ? "Doesn't it feel good to FIND them?" :
    stats.total === 0  ? "Nothing yet. Let's go look." :
                         "All quiet. Want to go again?"

  return (
    <div role="dialog" aria-modal="true" aria-label="Case info" style={{ position: "fixed", inset: 0, zIndex: 1200 }} onClick={onClose}>
      <div className="pz-runbg">
        {Array.from({ length: 9 }, (_, i) => (
          <div key={i} className="row" style={{ top: i * 104 - 20 }}>ONE MORE SCAN   ONE MORE SCAN   ONE MORE SCAN   ONE MORE SCAN</div>
        ))}
      </div>
      <div onClick={e => e.stopPropagation()} style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 40, padding: 20, flexWrap: "wrap", overflowY: "auto" }}>
        <div className="pz-panel pz-bounce-in" style={{ width: 440, padding: 12, background: "#3a4f55" }}>
          <div className="pz-title" style={{ fontSize: 46, textAlign: "center", color: "var(--red)", letterSpacing: ".08em", textShadow: "0 4px 0 var(--ink), 3px 0 0 var(--ink), -3px 0 0 var(--ink), 0 -3px 0 var(--ink)", marginBottom: 12 }}>CASE FILE</div>
          <Row label="Top anomaly" tone="var(--red)">{stats.top}%</Row>
          <Row label="Most common">{stats.common || "none yet"}</Row>
          <Row label="Events stored" tone="var(--blue)">{stats.total}</Row>
          <Row label="Reviewed" tone="var(--blue)">{stats.seen}</Row>
          <Row label="Critical" tone="var(--red)">{stats.critical}</Row>
          <Row label="High" tone="var(--orange)">{stats.high}</Row>
          <Row label="Entities" tone="var(--gold)">{stats.entities}</Row>
          <Row label="Case score" tone="var(--gold)">{stats.caseScore.toLocaleString()}</Row>
          <Row label="Chain" tone={stats.chain === false ? "var(--red)" : "var(--green)"}>{stats.chain === null ? "checking" : stats.chain ? "intact" : "broken"}</Row>
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <Btn color="red" className="big" style={{ flex: 1 }} onClick={() => { onScan(); onClose() }}>New Scan</Btn>
            <Btn color="red" className="big" style={{ flex: 1 }} onClick={() => window.open(`${API}/report/pdf`, "_blank")}>Report</Btn>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
            <Btn color="red" className="big" style={{ flex: 1 }} onClick={() => window.open(`${API}/report/management`, "_blank")}>Summary</Btn>
            <Btn color="gold" className="big" style={{ flex: 1 }} onClick={onClose}>Back</Btn>
          </div>
        </div>

        <div className="pz-bounce-in" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 18, animationDelay: ".15s" }}>
          <div className="pz-card pz-wobble" style={{ position: "relative", "--cw": "170px", "--x": "0px", "--y": "0px", "--r": "0deg", animation: undefined, cursor: "default", background: "linear-gradient(180deg,#f7f2e6,#e9e2d0)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <PixelLuffy mood={mood === "sleepy" ? "idle" : mood} height={150} />
          </div>
          <div className="pz-panel paper" style={{ padding: "12px 16px", maxWidth: 260, textAlign: "center", fontWeight: 700, fontSize: 23, lineHeight: 1.15 }}>{line}</div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────
// OPTIONS
// ─────────────────────────────────────────────────────────────
function Toggle({ label, hint, on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} role="switch" aria-checked={on} style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", textAlign: "left", background: "none", border: 0, color: "#fff", padding: "8px 0", cursor: "pointer" }}>
      <span style={{ width: 52, height: 28, borderRadius: 14, border: "3px solid var(--ink)", background: on ? "var(--green)" : "#566c6a", position: "relative", flexShrink: 0, transition: "background .15s" }}>
        <span style={{ position: "absolute", top: 1, left: on ? 24 : 1, width: 20, height: 20, background: "#fff", border: "3px solid var(--ink)", borderRadius: "50%", transition: "left .15s" }} />
      </span>
      <span>
        <span style={{ display: "block", fontWeight: 700, fontSize: 20 }}>{label}</span>
        <span style={{ display: "block", fontSize: 17, color: "#9fb4b2" }}>{hint}</span>
      </span>
    </button>
  )
}

export function OptionsModal({ options, setOptions, onResetSeen, onResetScore, onClose, seenCount }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])
  return (
    <div role="dialog" aria-modal="true" aria-label="Options" style={{ position: "fixed", inset: 0, zIndex: 1200, background: "rgba(10,18,18,.72)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div className="pz-panel pz-bounce-in" onClick={e => e.stopPropagation()} style={{ width: 420, padding: 18 }}>
        <div className="pz-title" style={{ fontSize: 38, textAlign: "center", marginBottom: 8 }}>OPTIONS</div>
        <Toggle label="Animated table" hint="The slow swirl behind the cards" on={options.bg} onChange={v => setOptions(o => ({ ...o, bg: v }))} />
        <Toggle label="Luffy speech bubbles" hint="Comments on what you are doing" on={options.bubbles} onChange={v => setOptions(o => ({ ...o, bubbles: v }))} />
        <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
          <Btn color="blue" style={{ flex: 1 }} disabled={!seenCount} onClick={onResetSeen}>Bring back {seenCount} reviewed</Btn>
          <Btn color="red" style={{ flex: 1 }} onClick={onResetScore}>Reset case score</Btn>
        </div>
        <Btn color="gold" className="big" style={{ width: "100%", marginTop: 14 }} onClick={onClose}>Back</Btn>
      </div>
    </div>
  )
}

export { PxIcon }
