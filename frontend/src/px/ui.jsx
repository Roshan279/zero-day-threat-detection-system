import { useEffect, useRef, useState } from "react"

// A number that counts up or down to its new value (like a score ticking in a card game)
export function Counter({ value, duration = 600, format, style, className }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)
  useEffect(() => {
    const start = performance.now()
    const a = from.current, b = Number(value) || 0
    if (a === b) { setShown(b); return }
    let raf
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setShown(Math.round(a + (b - a) * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
      else from.current = b
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(raf); from.current = b }
  }, [value, duration])
  return <span className={className} style={style}>{format ? format(shown) : shown.toLocaleString()}</span>
}

// Chunky pixel button. color: orange (default) | blue | red | green | gold | gray | purple
export function Btn({ color = "", size = "", children, className = "", ...rest }) {
  return <button className={`pz-btn ${color} ${size} ${className}`} {...rest}>{children}</button>
}

export function Panel({ paper = false, className = "", style, children, ...rest }) {
  return <div className={`pz-panel ${paper ? "paper" : ""} ${className}`} style={style} {...rest}>{children}</div>
}

export function Inset({ className = "", style, children, ...rest }) {
  return <div className={`pz-inset ${className}`} style={style} {...rest}>{children}</div>
}

// Small floating "+N" that rises and fades (used when scoring)
export function ScorePop({ x, y, text, color = "#fff" }) {
  return <span className="pz-score-pop" style={{ left: x, top: y, color }}>{text}</span>
}
