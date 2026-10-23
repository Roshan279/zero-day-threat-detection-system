import { useEffect, useRef } from "react"
import { LuffyAvatar } from "./px/PixelLuffy"
import { MOOD_CONFIG } from "./LuffyOverlay"
import { Btn } from "./px/ui"
import { parseCitations } from "./sanitize"

// Turns [1] style markers into small clickable citations
function CitedText({ text, onCitationClick }) {
  if (!text) return null
  const { cleanText, citations } = parseCitations(text)
  const parts = cleanText.split(/(\[\d+\])/)
  return (
    <span>
      {parts.map((part, i) => {
        const match = part.match(/^\[(\d+)\]$/)
        if (match) {
          const cit = citations[parseInt(match[1]) - 1]
          return (
            <sup
              key={i}
              onClick={() => cit && onCitationClick && onCitationClick(cit)}
              title={cit ? `${cit.type === "db_id" ? "DB" : "EventID"}: ${cit.id}` : ""}
              style={{ color: "var(--blue-d)", cursor: cit ? "pointer" : "default", fontWeight: 700, marginLeft: 1 }}
            >[{match[1]}]</sup>
          )
        }
        return <span key={i}>{part}</span>
      })}
    </span>
  )
}

const QUICK = ["Run a scan", "Show critical", "Who is suspicious?", "Replay the attack", "Explain this event"]

export default function ChatPage({ history, input, setInput, send, loading, mood, onQuick }) {
  const end = useRef(null)
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth" }) }, [history, loading])
  const color = (MOOD_CONFIG[mood] || MOOD_CONFIG.idle).color

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", padding: "0 160px 16px 20px" }}>
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, padding: "6px 6px 10px" }}>
        {history.length === 0 && (
          <div className="pz-panel paper pz-bounce-in" style={{ alignSelf: "center", marginTop: 30, padding: 18, maxWidth: 460, textAlign: "center" }}>
            <div className="pz-float" style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}><LuffyAvatar mood={mood} size={64} color={color} /></div>
            <div style={{ fontWeight: 700, fontSize: 28 }}>Luffy is watching your system.</div>
            <div style={{ fontSize: 19, margin: "6px 0 0", color: "#4b5a58" }}>Ask a question or give an order. Try one of the quick commands below.</div>
          </div>
        )}

        {history.map((msg, i) => (
          msg.role === "user" ? (
            <div key={i} className="pz-bounce-in" style={{ alignSelf: "flex-end", maxWidth: "70%" }}>
              <div className="pz-panel" style={{ background: "var(--blue)", padding: "8px 14px", fontSize: 20, textShadow: "0 2px 0 rgba(0,0,0,.4)", fontWeight: 600 }}>{msg.content}</div>
            </div>
          ) : (
            <div key={i} className="pz-bounce-in" style={{ alignSelf: "flex-start", maxWidth: "78%", display: "flex", gap: 10, alignItems: "flex-end" }}>
              <LuffyAvatar mood={mood} size={46} color={color} />
              <div className="pz-panel paper" style={{ padding: "10px 14px", fontSize: 20, lineHeight: 1.25 }}>
                <div style={{ fontSize: 14, letterSpacing: ".14em", fontWeight: 700, color: "#6b7b78", marginBottom: 2 }}>LUFFY</div>
                <CitedText text={msg.content} onCitationClick={() => {}} />
              </div>
            </div>
          )
        ))}

        {loading && (
          <div style={{ alignSelf: "flex-start", display: "flex", gap: 10, alignItems: "flex-end" }}>
            <LuffyAvatar mood="thinking" size={46} color="#ffc83a" />
            <div className="pz-panel paper" style={{ padding: "12px 16px", display: "flex", gap: 6 }} aria-label="Luffy is thinking">
              {[0, 1, 2].map(i => <span key={i} style={{ width: 10, height: 10, background: "var(--ink)", display: "block", animation: `pz-dots .8s ${i * 0.15}s infinite` }} />)}
            </div>
          </div>
        )}
        <div ref={end} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {QUICK.map(q => <Btn key={q} size="small" color="gray" disabled={loading} onClick={() => onQuick(q)}>{q}</Btn>)}
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={loading}
          placeholder='Ask anything: "block this", "explain the attack", "show critical events"...'
          aria-label="Message Luffy"
          className="pz-inset"
          style={{ flex: 1, padding: "10px 14px", color: "#fff", fontFamily: "var(--pxfont)", fontSize: 20, outline: "none", minWidth: 0 }}
        />
        <Btn color="blue" className="big" disabled={loading || !input.trim()} onClick={() => send()}>Send</Btn>
      </div>
    </div>
  )
}
