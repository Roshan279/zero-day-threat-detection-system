// ─────────────────────────────────────────────────────────────
// PIXEL LUFFY (sprite data)
// BASE is the mascot's reference art transcribed cell for cell: 26 x 35 pixels (plus one row closing the right foot)
// in its original palette, facing left. The idle mood shows it unchanged.
// Other moods paint small patches over it (eyes, brows, mouth) and add a mark
// above the hat. To tweak an expression, edit the tables below BASE.
// ─────────────────────────────────────────────────────────────

export const PALETTE = {
  K: "#2b2b2b",   // outline / hair
  S: "#ffcb92",   // skin
  s: "#cd853f",   // skin shade
  N: "#8b4513",   // hat brown
  Y: "#fed700",   // straw
  R: "#fe0000",   // hat band / vest
  r: "#a81818",   // vest shade
  B: "#00bfff",   // shorts
  b: "#0000cd",   // shorts shade
  W: "#ffffff",   // eye white / teeth / highlights
  M: "#7a1f22",   // mouth
  T: "#f27a86",   // tongue
  P: "#ff9d8a",   // blush
  Q: "#e8d5b0",   // marks
  A: "#fb923c",   // alert mark
  G: "rgba(232,213,176,0.38)",   // rim light around the silhouette
}

const BASE = [
  "..........KKKKKKKK........",  //  0
  "........KKYYYYYYKKKK......",  //  1
  ".......KNYYYKKKKYYKKK.....",  //  2
  ".....KKKKKKKRRRRKKYNKK....",  //  3
  "...KKNYYYYNNKKKKRRKKKK....",  //  4
  "..KNNYWWWYYYYYNNKKRRKKK...",  //  5
  ".KYYYNNNNNNNNNYYYNKKRKKK..",  //  6
  "KNYYNNNKKKKNNNNNNYYKKKKK..",  //  7
  "KNYNKKKKKKSKKKNNNNNYYKKK..",  //  8
  ".KNKKKKsKSSKKKKKKNNNNYNK..",  //  9
  "..KKKKsKKSSsKKsKKKKNNNYNK.",  // 10
  "..KsKKsKsSSSSKKsKKKKNNNYK.",  // 11
  "...KKKKKSSSSSKKsKKKKKNNNNK",  // 12
  "...KKSKWsSSSKsKKsKKKKNNNNK",  // 13
  "...KKWsKSSSSWWsKsKKKKKNNNK",  // 14
  "....KWKKSSSSsKWKSKKKKNKNNK",  // 15
  "....KSWWSSSSKKWSSKsKKNNNK.",  // 16
  "....KSSSSSSSWWSSSKSsKNKK..",  // 17
  "....KsSSSSSSSsssSSSsKK....",  // 18
  ".....KsSSSSSSSSSsSsK......",  // 19
  "......KsSSSSSSssKKK.......",  // 20
  ".......KKKKKKKKK..........",  // 21
  "........KrWKRrKsK.........",  // 22
  ".......KrRsRRrKSK.........",  // 23
  "......KKRRKRRrKSSK........",  // 24
  ".....KKrRrRRRrrKSK........",  // 25
  "....KSKrrRKRRRrKSKK.......",  // 26
  "....KSSKKrrrrrKsSSsK......",  // 27
  ".....KKbBBKKKKKSWSSK......",  // 28
  "......KWbBbBBbKsSSK.......",  // 29
  ".......KNBKKBBbKKK........",  // 30
  ".....KKKSK..KbWWK.........",  // 31
  "....KSSSSK...KSsK.........",  // 32
  "...KNYYSNK..KsSSK.........",  // 33
  "....KKKKK...KsSSSK........",  // 34
  "............KKKKKK........",  // 35 sole outline (the source art stops one row short)
]

// The sprite sits inside a bigger canvas so marks and the rim light have room.
const OX = 3, OY = 5
export const GRID_W = 32
export const GRID_H = 42
// Round head avatars show this part of the canvas
export const HEAD_BOX = { x: 2, y: 0, w: 28, h: 28 }

// Patches use sprite coordinates (0,0 = top-left of BASE). "." leaves the cell alone.
// Near eye is a 4 x 4 block at (5,13); far eye is a 5 x 4 block at (12,14), one row lower as in the art.
const L = { x: 5,  y: 13 }
const R = { x: 12, y: 14 }

const EYES = {
  // Eyes are white with a thin lid line and a pupil, no dark box around them.
  blink: { l: ["SSSS", "SSSS", "SKKS", "SSSS"], r: ["SSSSS", "SSSSS", "SKKKS", "SSSSS"] },
  happy: { l: ["SSSS", "SKKS", "KSSK", "SSSS"], r: ["SSSSS", "SKKKS", "KSSSK", "SSSSS"] },
  wide:  { l: ["SKKS", "WWKW", "WWKW", "SWWS"], r: ["SKKKS", "WWKKW", "WWKKW", "SWWWS"] },
  up:    { l: ["SKKS", "WKKW", "WWWW", "SSSS"], r: ["SKKKS", "WKKKW", "WWWWW", "SSSSS"] },
  glare: { l: ["KKKK", "WWKS", "SWSS", "SSSS"], r: ["SSKKK", "SKWWS", "SSWSS", "SSSSS"] },
  wink:  { l: ["SKKS", "WWKW", "SWKS", "SSSS"], r: ["SSSSS", "SSSSS", "SKKKS", "SSSSS"] },
}

const MOOD_EYES = { alert: "wide", thinking: "up", happy: "happy", angry: "glare", goofy: "wink", sleepy: "blink" }

// Mouths: { x, y, rows } in sprite coordinates
const MOUTHS = {
  happy:    { x: 9,  y: 18, rows: ["KKKKKK", "KWWWWK", ".KMMK."] },
  alert:    { x: 10, y: 18, rows: ["KKKK", "KMMK", "KKKK"] },
  angry:    { x: 9,  y: 18, rows: ["KKKKKK", "KWKWWK", "KKKKKK"] },
  thinking: { x: 10, y: 19, rows: ["KKKK"] },
  goofy:    { x: 9,  y: 18, rows: ["KKKKKK", "KMMMMK", "KTTTTK", ".KTTK.", "..TT.."] },
  sleepy:   { x: 10, y: 18, rows: [".KK.", "K..K", ".KK."] },
}

// Marks float above the hat, top-right (sprite coordinates, y is negative = above the sprite)
const MARKS = {
  alert:    { x: 21, y: -5, rows: ["..AA..", "..AA..", "..AA..", "......", "..AA.."] },
  thinking: { x: 21, y: -5, rows: [".QQQQ.", "Q....Q", "....QQ", "...Q..", "...Q.."] },
  angry:    { x: 21, y: -5, rows: ["R...R.", ".R.R..", "..R...", ".R.R..", "R...R."] },
  happy:    { x: 21, y: -5, rows: ["..Q...", "..Q...", "QQQQQ.", "..Q...", "..Q..."] },
  goofy:    { x: 21, y: -5, rows: ["..Q...", "..Q...", "QQQQQ.", "..Q...", "..Q..."] },
  sleepy:   { x: 21, y: -5, rows: ["QQQQ..", "...Q..", "..Q...", ".Q....", "QQQQ.."] },
}

const blank = () => Array.from({ length: GRID_H }, () => Array(GRID_W).fill("."))

function put(g, x, y, rows) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const ch = row[dx]
      const gx = OX + x + dx, gy = OY + y + dy
      if (ch === "." || gx < 0 || gy < 0 || gx >= GRID_W || gy >= GRID_H) continue
      g[gy][gx] = ch
    }
  })
}

// A 1px translucent ring around the silhouette keeps the dark outline readable on a dark UI
function addRim(g) {
  const add = []
  for (let y = 0; y < GRID_H; y++) for (let x = 0; x < GRID_W; x++) {
    if (g[y][x] !== ".") continue
    const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const c = g[y + dy]?.[x + dx]
      return c && c !== "." && c !== "G"
    })
    if (touches) add.push([x, y])
  }
  for (const [x, y] of add) g[y][x] = "G"
}

// Returns GRID_H rows of GRID_W palette letters ("." = empty)
export function buildGrid(mood = "idle", blink = false) {
  const g = blank()
  put(g, 0, 0, BASE)

  let eyes = MOOD_EYES[mood] && EYES[MOOD_EYES[mood]]
  if (blink && (mood === "idle" || mood === "alert" || mood === "thinking" || mood === "angry")) eyes = EYES.blink
  if (eyes) { put(g, L.x, L.y, eyes.l); put(g, R.x, R.y, eyes.r) }

  const m = MOUTHS[mood]
  if (m) put(g, m.x, m.y, m.rows)
  const mk = MARKS[mood]
  if (mk) put(g, mk.x, mk.y, mk.rows)

  addRim(g)
  return g
}

// Merge horizontal runs of one color into rects: [{x, y, w, color}]
export function gridToRects(grid) {
  const out = []
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x]
      if (ch === ".") { x++; continue }
      let w = 1
      while (x + w < row.length && row[x + w] === ch) w++
      out.push({ x, y, w, color: PALETTE[ch] })
      x += w
    }
  })
  return out
}

export const MOODS = ["idle", "alert", "thinking", "happy", "angry", "goofy", "sleepy"]
