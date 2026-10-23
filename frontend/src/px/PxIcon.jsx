import { useMemo } from "react"
import { ICONS, SUITS, ICON_SIZE, SUIT_SIZE, iconRects } from "./art"

// <PxIcon name="gear" size={48} />   or   <PxIcon suit="spade" size={20} color="#1d2527" />
export default function PxIcon({ name, suit, size = 48, color = "#1d2527", style, className }) {
  const grid = suit ? SUITS[suit] : ICONS[name]
  const dim  = suit ? SUIT_SIZE : ICON_SIZE
  const rects = useMemo(() => (grid ? iconRects(grid, color) : []), [grid, color])
  return (
    <svg
      viewBox={`0 0 ${dim} ${dim}`}
      width={size} height={size}
      shapeRendering="crispEdges"
      className={className}
      style={{ display: "block", imageRendering: "pixelated", flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      {rects.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height="1" fill={r.color} />)}
    </svg>
  )
}
