import { useEffect, useMemo, useState } from "react"
import axios from "axios"
import { API } from "./api"
import { TIER } from "./px/cardModel"
import { Btn } from "./px/ui"
import CaseBook from "./CaseBook"
import { getDataMode } from "./dataMode"

// ─────────────────────────────────────────────────────────────
// REPORT BUILDER: pick the circumstance first, then the report. Any mix of four filters:
//   threat level, behaviour pattern, one entity, and a date range.
// The count shows how many events match before you commit. Then: read it as a book, or download the
// technical or management PDF. The book and the PDFs use the same filter on the backend, so they describe
// the same events. In Demo data mode only the book is available (the PDFs are built from the real database).
// ─────────────────────────────────────────────────────────────
const PATTERNS = ["Normal System Activity", "Brute Force Pattern", "Credential Access Pattern", "Privilege Escalation Pattern", "Persistence Pattern", "Data Exfiltration Pattern", "Unknown Pattern"]
const INK = "#1d2527"
const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return day(d) }

const field = { font: "inherit", fontSize: 18, padding: "4px 8px", border: `3px solid ${INK}`, borderRadius: 6, background: "var(--paper)", color: INK, boxSizing: "border-box" }
const Label = ({ children }) => <div className="pz-label" style={{ margin: "10px 0 4px" }}>{children}</div>

export default function ReportBuilder({ chain, onClose }) {
  const demo = getDataMode() === "demo"
  const [tier, setTier] = useState(0)
  const [cluster, setCluster] = useState("")
  const [entity, setEntity] = useState("")
  const [start, setStart] = useState("")
  const [end, setEnd] = useState("")
  const [entities, setEntities] = useState([])
  const [matches, setMatches] = useState(null)       // the events that match (the highest scoring ones), or null while loading
  const [total, setTotal] = useState(0)               // how many match in all
  const [book, setBook] = useState(false)

  useEffect(() => {
    let live = true
    axios.get(`${API}/entities`).then(r => { if (live) setEntities((r.data.entities || []).map(e => e.entity).sort()) }).catch(() => {})
    return () => { live = false }
  }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && !book) onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose, book])

  const scope = useMemo(() => {
    const s = {}
    if (tier) s.tier = tier
    if (cluster) s.cluster = cluster
    if (entity) s.entity = entity
    if (start) s.start = start
    if (end) s.end = end
    return s
  }, [tier, cluster, entity, start, end])
  const label = useMemo(() => {
    const bits = []
    if (scope.tier) bits.push(TIER[scope.tier].name)
    if (scope.cluster) bits.push(scope.cluster)
    if (scope.entity) bits.push(scope.entity)
    if (scope.start || scope.end) bits.push(`${scope.start || "start"} to ${scope.end || "now"}`)
    return bits.length ? bits.join(", ") : "Whole case"
  }, [scope])

  // how many events match, refreshed shortly after any change
  useEffect(() => {
    let live = true
    const t = setTimeout(() => {
      axios.get(`${API}/events`, { params: { ...scope, limit: 1000 } })
        .then(r => { if (live) { setMatches(r.data.events || []); setTotal(r.data.total ?? (r.data.events || []).length) } })
        .catch(() => { if (live) { setMatches([]); setTotal(0) } })
    }, 250)
    return () => { live = false; clearTimeout(t) }
  }, [scope])
  const loading = matches === null
  const count = loading ? 0 : total
  const clear = () => { setTier(0); setCluster(""); setEntity(""); setStart(""); setEnd(""); setMatches(null) }
  const preset = (a, b) => { setStart(a); setEnd(b); setMatches(null) }
  const [busy, setBusy] = useState("")
  const [pdfError, setPdfError] = useState("")
  const pdf = async (kind) => {
    setPdfError("")
    if (!demo) {                          // real data: the backend reads its own database with the same filter
      const q = new URLSearchParams(scope).toString()
      window.open(`${API}/report/${kind}${q ? "?" + q : ""}`, "_blank")
      return
    }
    // demo data: the events only exist here, so send them to the backend to be typeset (plain fetch: the app's
    // axios is rerouted to the fabricated data in this mode)
    setBusy(kind)
    try {
      const res = await fetch(`${API}/report/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: matches, scope }) })
      if (!res.ok) throw new Error(String(res.status))
      window.open(URL.createObjectURL(await res.blob()), "_blank")
    } catch { setPdfError("Could not build the PDF. Is the backend running?") }
    setBusy("")
  }
  const touch = (fn) => (v) => { fn(v); setMatches(null) }

  return (
    <div role="dialog" aria-modal="true" aria-label="Build a report" onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex: 1250, background: "rgba(10,18,18,.8)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      <div className="pz-panel pz-bounce-in" onClick={e => e.stopPropagation()} style={{ width: 540, maxWidth: "100%", padding: 16 }}>
        <div className="pz-title" style={{ fontSize: 32, textAlign: "center" }}>BUILD A REPORT</div>
        <div style={{ textAlign: "center", fontSize: 17, color: "#b5e8f2", marginBottom: 4 }}>Pick the circumstance. Leave a filter on "any" to ignore it.</div>

        <Label>Threat level</Label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {[[0, "Any"], [4, "CRITICAL"], [3, "HIGH"], [2, "MEDIUM"], [1, "LOW"]].map(([t, name]) => (
            <Btn key={t} size="small" color={tier === t ? "gold" : "gray"} onClick={() => touch(setTier)(t)}>{name}</Btn>
          ))}
        </div>

        <Label>Behaviour pattern</Label>
        <select value={cluster} onChange={e => touch(setCluster)(e.target.value)} style={{ ...field, width: "100%" }} aria-label="Behaviour pattern">
          <option value="">Any pattern</option>
          {PATTERNS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>

        <Label>Entity (one account, host or service)</Label>
        <select value={entity} onChange={e => touch(setEntity)(e.target.value)} style={{ ...field, width: "100%" }} aria-label="Entity">
          <option value="">Any entity</option>
          {entities.map(n => <option key={n} value={n}>{n}</option>)}
        </select>

        <Label>Date range</Label>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input type="date" value={start} max={end || undefined} onChange={e => touch(setStart)(e.target.value)} style={{ ...field, flex: 1, minWidth: 130 }} aria-label="From date" />
          <span>to</span>
          <input type="date" value={end} min={start || undefined} onChange={e => touch(setEnd)(e.target.value)} style={{ ...field, flex: 1, minWidth: 130 }} aria-label="To date" />
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          <Btn size="small" color="gray" onClick={() => preset(day(new Date()), day(new Date()))}>Today</Btn>
          <Btn size="small" color="gray" onClick={() => preset(ago(1), ago(1))}>Yesterday</Btn>
          <Btn size="small" color="gray" onClick={() => preset(ago(6), day(new Date()))}>Last 7 days</Btn>
          <Btn size="small" color="gray" onClick={() => preset("", "")}>Any time</Btn>
        </div>

        <div className="pz-inset" style={{ marginTop: 14, padding: "8px 12px", display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ fontFamily: "var(--pxfont)", fontSize: 40, lineHeight: 1, minWidth: 64, color: count ? "var(--gold)" : "#dcdcdc" }}>{loading ? "..." : count}</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{loading ? "counting events" : count === 1 ? "event matches" : "events match"}</div>
            <div style={{ fontSize: 15, color: "#b5e8f2", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
          </div>
          <button className="pz-btn gray small" style={{ marginLeft: "auto" }} onClick={clear}>Clear</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <Btn color="blue" className="big" style={{ flex: 1 }} disabled={loading || !count} onClick={() => setBook(true)}>Read as book</Btn>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <Btn color="red" style={{ flex: 1 }} disabled={!!busy || loading || !count} onClick={() => pdf("pdf")}>{busy ? "Building..." : "Download PDF report"}</Btn>
        </div>
        {demo && <div style={{ fontSize: 15, color: "#dcdcdc", marginTop: 6 }}>Demo data is on: the book and the PDF are built from the demo events. Your real database is not touched.</div>}
        {pdfError && <div style={{ fontSize: 15, color: "#fe5f55", marginTop: 6 }}>{pdfError}</div>}
        {!loading && !count && <div style={{ fontSize: 15, color: "#fe5f55", marginTop: 6 }}>Nothing matches these filters. Loosen one of them.</div>}

        <Btn color="gold" className="big" style={{ width: "100%", marginTop: 12 }} onClick={onClose}>Back</Btn>
      </div>

      {book && <CaseBook events={matches || []} chain={chain} scopeLabel={label === "Whole case" ? "" : label} onClose={() => setBook(false)} />}
    </div>
  )
}
