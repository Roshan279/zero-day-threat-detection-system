import { useEffect, useMemo, useState } from "react"
import { buildGrid, gridToRects, GRID_W, GRID_H, HEAD_BOX } from "../luffySprite"

// ─────────────────────────────────────────────────────────────
// PixelLuffy: the project mascot. Pure SVG, no image files.
//   <PixelLuffy mood="angry" height={200} />
//   <LuffyAvatar mood="happy" size={44} color="#4ade80" />   (round head badge)
// Sprite data lives in luffySprite.js.
// ─────────────────────────────────────────────────────────────

const MOTION = {
  idle:     "px-bob",
  thinking: "px-bob",
  alert:    "px-twitch",
  angry:    "px-shake",
  happy:    "px-hop",
  goofy:    "px-hop",
  sleepy:   "px-sleep",
}

// scale: whole screen pixels per sprite pixel. Use it for the big sprite so every pixel is the same size.
export default function PixelLuffy({ mood = "idle", height = 200, scale, view = "full", animate = true, style }) {
  const [blink, setBlink] = useState(false)

  // Random blinks every few seconds
  useEffect(() => {
    if (!animate) return
    let t1, t2
    const schedule = () => {
      t1 = setTimeout(() => {
        setBlink(true)
        t2 = setTimeout(() => { setBlink(false); schedule() }, 140)
      }, 2400 + Math.random() * 3000)
    }
    schedule()
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [animate])

  const rects = useMemo(() => gridToRects(buildGrid(mood, blink)), [mood, blink])
  const head  = view === "head"
  const vb    = head ? `${HEAD_BOX.x} ${HEAD_BOX.y} ${HEAD_BOX.w} ${HEAD_BOX.h}` : `0 0 ${GRID_W} ${GRID_H}`
  const ratio = head ? HEAD_BOX.w / HEAD_BOX.h : GRID_W / GRID_H

  return (
    <svg
      viewBox={vb}
      role="img"
      aria-label={`Luffy, ${mood}`}
      shapeRendering="crispEdges"
      className={animate ? (MOTION[mood] || "px-bob") : undefined}
      style={{ overflow: "visible", height: scale ? (head ? HEAD_BOX.h : GRID_H) * scale : height, width: "auto", aspectRatio: `${ratio}`, display: "block", imageRendering: "pixelated", ...style }}
    >
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w} height="1" fill={r.color} />
      ))}
    </svg>
  )
}

// Rounded-square badge showing just the head, framed in the mood color (a circle would clip the hat brim)
export function LuffyAvatar({ mood = "idle", size = 44, color = "#4ade80", style }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: Math.round(size * 0.22), background: "#111",
      border: `1.5px solid ${color}`, display: "flex", alignItems: "center", justifyContent: "center",
      overflow: "hidden", flexShrink: 0, transition: "border-color 0.5s", ...style,
    }}>
      <PixelLuffy mood={mood} view="head" height={Math.round(size * 0.8)} animate={false} />
    </div>
  )
}
