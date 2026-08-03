/**
 * Divine Brush author view (T2) — 绢本星图 / silk-scroll star atlas.
 *
 * Runs in a sandboxed Arena iframe and draws each frame the platform posts in.
 * The declarative T1 fallback is a correct but flat strip of coloured squares;
 * this renderer is the game's real face, and it is a deliberate reproduction of
 * the atlas the game was designed from: silk paper, ink, indigo, moss, vermilion
 * and gold; planets as round scrolls hung under one sky whose gold dust thickens
 * as the table lights each other's worlds.
 *
 * Every brush mark here is the same geometry as the source atlas — 山 a triangular
 * ridge with a weighted left edge, 水 three drawn curves, 苔 a scatter of six, 灯 a
 * vermilion halo around a hot centre, 光 a soft gold bloom. The one change is that
 * the source jitters each mark with `Math.random`; frames here are REPLAYED, so
 * every jitter is derived from the cell's own coordinates instead. The same state
 * always paints the same planet.
 *
 * Frames are this game's `render(state)` output — a RenderSpec whose board packs
 * every planet into one strip separated by SEPARATOR (code 6) gutter columns, and
 * whose panels carry the readouts. The two shapes this view depends on are stated
 * in the game's `render` docblock and parsed defensively below:
 *   status     "天空 42% · <agent> 执笔"
 *   scoreboard { label: <agentId>, value: "灯 3.0 · 执念 2 · 分 18.4[ · 守灯人]" }
 * Anything unparseable degrades to a sensible default rather than breaking a draw.
 *
 * Identity (`onPlayers`) is separate from game logic, which only ever sees opaque
 * agent ids — the view is the only place a name or avatar exists, and it decides
 * where they go: here, under each planet, beside a vermilion 守灯人 seal.
 */
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import type { PlayerInfo } from '@arena/game-sdk'

const SEPARATOR = 6
const VOID = 0
const MOUNTAIN = 1
const WATER = 2
const MOSS = 3
const LAMP = 4
const GLOW = 5

// 绢本 palette, lifted from the atlas.
const PAPER = '#f2ede1'
const PAPER_HI = '#faf6ea'
const PAPER_MID = '#efe8d4'
const PAPER_LO = '#e2d8bf'
const INK = '#322d26'
const INK_SOFT = 'rgba(50,45,38,.62)'
const INK_FAINT = 'rgba(50,45,38,.34)'
const ZHU = '#b23a26'
const ZHU_SOFT = 'rgba(178,58,38,.75)'
const GOLD = '#a8802f'
const DAI = '#4a5578'
const SERIF = '"Kaiti SC","STKaiti","KaiTi","Noto Serif SC",serif'
const LATIN = '"Optima","Avenir Next","Futura",serif'

/** The atlas grain: fractal noise, multiplied over the paper. */
const GRAIN =
  "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"240\" height=\"240\">" +
  '<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7"/>' +
  '<feColorMatrix type="matrix" values="0 0 0 0 0.30 0 0 0 0 0.26 0 0 0 0 0.18 0 0 0 0.05 0"/></filter>' +
  '<rect width="240" height="240" filter="url(%23n)"/></svg>\')'

/** The sky's own voice, by how much light the table has fed it. */
const WHISPERS = [
  '最近天空有点安静了，要不要为谁点一盏灯？',
  '有人在点灯，有人在漫游——尘金正在变多。',
  '这段时间，天空格外亮。',
]

interface Panel {
  type: string
  text?: string
  rows?: { label?: string; value?: string }[]
  items?: { label?: string; detail?: string }[]
}
interface Frame {
  board?: {
    cols: number
    rows: number
    cells: number[][]
    palette?: Record<string, string>
    lastMove?: { x: number; y: number }
  }
  panels?: Panel[]
}

interface Seat {
  agentId: string
  cells: number[][]
  lamps: number
  burden: number
  score: number
  guardian: boolean
}

let players: PlayerInfo[] = []
let lastFrame: Frame | null = null
let canvas: HTMLCanvasElement | null = null
let caption: HTMLDivElement | null = null
let moodFill: HTMLElement | null = null
let whisperEl: HTMLElement | null = null
let ledger: HTMLDivElement | null = null

// ---------------------------------------------------------------------------
// Reading the frame
// ---------------------------------------------------------------------------

/** Cut the packed strip back into one grid per seat on the gutter columns. */
function splitPlanets(cells: number[][]): number[][][] {
  const out: number[][][] = []
  if (cells.length === 0) return out
  const width = cells[0]!.length
  let start = 0
  for (let x = 0; x <= width; x++) {
    const isGutter = x === width || cells[0]![x] === SEPARATOR
    if (!isGutter) continue
    if (x > start) out.push(cells.map((row) => row.slice(start, x)))
    start = x + 1
  }
  return out
}

const firstNumber = (text: string, after: string): number => {
  const at = text.indexOf(after)
  if (at < 0) return 0
  const match = /-?\d+(\.\d+)?/.exec(text.slice(at + after.length))
  return match ? Number(match[0]) : 0
}

function readSeats(frame: Frame): Seat[] {
  const planets = splitPlanets(frame.board?.cells ?? [])
  const rows = frame.panels?.find((p) => p.type === 'scoreboard')?.rows ?? []
  return planets.map((cells, i) => {
    const value = rows[i]?.value ?? ''
    return {
      agentId: rows[i]?.label ?? `seat ${i + 1}`,
      cells,
      lamps: firstNumber(value, '灯'),
      burden: firstNumber(value, '执念'),
      score: firstNumber(value, '分'),
      guardian: value.includes('守灯人'),
    }
  })
}

const readSky = (frame: Frame): number => {
  const status = frame.panels?.find((p) => p.type === 'status')?.text ?? ''
  return Math.max(0, Math.min(1, firstNumber(status, '天空') / 100))
}

const identityOf = (seat: number, agentId: string): PlayerInfo | undefined =>
  players.find((p) => p.agentId === agentId) ?? players.find((p) => p.seat === seat)

// ---------------------------------------------------------------------------
// Ink
// ---------------------------------------------------------------------------

/**
 * Deterministic jitter in [0,1). The source atlas calls `Math.random()` inside
 * every stamp; frames here are replayed, so the wobble has to be a function of
 * where the mark IS, not of when it was drawn.
 */
function jitter(x: number, y: number, salt: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + salt * 74.7) * 43758.5453
  return v - Math.floor(v)
}

function alpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`
}

/** 山 — a ridge: soft wash under a weighted left edge. */
function stampMountain(g: CanvasRenderingContext2D, x: number, y: number, s: number, ink: string, j: number): void {
  const w = s * (0.9 + jitter(x, y, 1) * 0.7)
  const h = w * (0.7 + jitter(x, y, 2) * 0.5)
  const peak = x + (jitter(x, y, 3) - 0.5) * w * 0.3
  g.beginPath()
  g.moveTo(x - w / 2, y + h / 2)
  g.lineTo(peak, y - h / 2)
  g.lineTo(x + w / 2, y + h / 2)
  g.closePath()
  g.fillStyle = alpha(ink, 0.14 + j * 0.12)
  g.fill()
  g.beginPath()
  g.moveTo(x - w / 2, y + h / 2)
  g.lineTo(peak, y - h / 2)
  g.strokeStyle = alpha(ink, 0.7)
  g.lineWidth = Math.max(1.2, s * 0.055)
  g.lineCap = 'round'
  g.stroke()
}

/** 水 — three drawn currents. */
function stampWater(g: CanvasRenderingContext2D, x: number, y: number, s: number, ink: string): void {
  g.strokeStyle = alpha(ink, 0.3)
  g.lineWidth = Math.max(1, s * 0.05)
  g.lineCap = 'round'
  for (let i = 0; i < 3; i++) {
    const len = s * (1.2 + jitter(x, y, 10 + i) * 1.2)
    const yy = y + (i - 1) * s * 0.22
    g.beginPath()
    g.moveTo(x - len / 2, yy)
    g.quadraticCurveTo(x, yy + (jitter(x, y, 20 + i) - 0.5) * s * 0.3, x + len / 2, yy)
    g.stroke()
  }
}

/** 苔 — a scatter of six. */
function stampMoss(g: CanvasRenderingContext2D, x: number, y: number, s: number, ink: string): void {
  for (let i = 0; i < 6; i++) {
    const dx = (jitter(x, y, 30 + i) - 0.5) * s * 1.05
    const dy = (jitter(x, y, 40 + i) - 0.5) * s * 1.05
    g.beginPath()
    g.arc(x + dx, y + dy, s * (0.04 + jitter(x, y, 50 + i) * 0.09), 0, Math.PI * 2)
    g.fillStyle = alpha(ink, 0.25 + jitter(x, y, 60 + i) * 0.35)
    g.fill()
  }
}

/** 灯 — a vermilion halo around a hot centre. */
function stampLamp(g: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  const r = s * 0.55
  const halo = g.createRadialGradient(x, y, 0, x, y, r)
  halo.addColorStop(0, 'rgba(178,58,38,.85)')
  halo.addColorStop(0.3, 'rgba(168,128,47,.35)')
  halo.addColorStop(1, 'rgba(168,128,47,0)')
  g.fillStyle = halo
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  g.fill()
  g.beginPath()
  g.arc(x, y, Math.max(1.4, s * 0.055), 0, Math.PI * 2)
  g.fillStyle = ZHU
  g.fill()
}

/** 光 — a soft gold bloom, the backlight the scoring keeps scarce. */
function stampGlow(g: CanvasRenderingContext2D, x: number, y: number, s: number, ink: string, j: number): void {
  const r = s * (0.85 + j * 0.5)
  const bloom = g.createRadialGradient(x, y, 0, x, y, r)
  bloom.addColorStop(0, alpha(ink, 0.16))
  bloom.addColorStop(1, alpha(ink, 0))
  g.fillStyle = bloom
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  g.fill()
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** Gold dust over the whole sheet — the atlas's living measure of connection. */
function drawGoldDust(g: CanvasRenderingContext2D, w: number, h: number, sky: number): void {
  const motes = Math.round(sky * 190)
  for (let i = 0; i < motes; i++) {
    const x = jitter(i, 1, 7) * w
    const y = jitter(i, 2, 9) * h
    const r = 0.4 + jitter(i, 3, 11) * 1.3
    g.fillStyle = alpha(GOLD, 0.12 + jitter(i, 4, 13) * 0.35)
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fill()
  }
}

function drawPlanet(
  g: CanvasRenderingContext2D,
  seat: Seat,
  cx: number,
  cy: number,
  radius: number,
  size: number,
  palette: Record<string, string>,
  highlight: { x: number; y: number } | null,
): void {
  // The scroll itself: lit from the upper left, like the atlas.
  const silk = g.createRadialGradient(
    cx - radius * 0.28,
    cy - radius * 0.36,
    radius * 0.1,
    cx,
    cy,
    radius * 1.12,
  )
  silk.addColorStop(0, PAPER_HI)
  silk.addColorStop(0.65, PAPER_MID)
  silk.addColorStop(1, PAPER_LO)
  g.fillStyle = silk
  g.beginPath()
  g.arc(cx, cy, radius, 0, Math.PI * 2)
  g.fill()

  g.save()
  g.beginPath()
  g.arc(cx, cy, radius - 1, 0, Math.PI * 2)
  g.clip()

  // Latitudes.
  g.strokeStyle = 'rgba(50,45,38,.07)'
  g.lineWidth = 1.2
  for (let i = 1; i < 5; i++) {
    g.beginPath()
    g.ellipse(cx, cy, radius * 0.96, radius * 0.18 * i, 0, 0, Math.PI * 2)
    g.stroke()
  }

  // The grid lives in the circle's inscribed square, so no cell falls off the rim.
  const side = radius * Math.SQRT2
  const cell = side / size
  const left = cx - side / 2
  const top = cy - side / 2

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const code = seat.cells[y]?.[x] ?? VOID
      if (code === VOID) continue
      const j = jitter(x, y, code)
      // A hand-laid mark never sits dead centre in its square.
      const px = left + (x + 0.5) * cell + (jitter(x, y, 71) - 0.5) * cell * 0.22
      const py = top + (y + 0.5) * cell + (jitter(x, y, 73) - 0.5) * cell * 0.22
      const ink = palette[String(code)] ?? INK
      const s = cell * 1.25
      if (code === MOUNTAIN) stampMountain(g, px, py, s, ink, j)
      else if (code === WATER) stampWater(g, px, py, s, ink)
      else if (code === MOSS) stampMoss(g, px, py, s, ink)
      else if (code === LAMP) stampLamp(g, px, py, s)
      else if (code === GLOW) stampGlow(g, px, py, s, ink, j)
    }
  }

  // 执念 — the smudge of everything painted over and not yet let go of.
  if (seat.burden > 0) {
    g.fillStyle = `rgba(58,53,44,${Math.min(0.22, seat.burden * 0.05).toFixed(3)})`
    g.beginPath()
    g.arc(cx, cy, radius, 0, Math.PI * 2)
    g.fill()
  }

  if (highlight) {
    g.strokeStyle = ZHU_SOFT
    g.lineWidth = Math.max(1.2, cell * 0.07)
    g.beginPath()
    g.arc(left + (highlight.x + 0.5) * cell, top + (highlight.y + 0.5) * cell, cell * 0.62, 0, Math.PI * 2)
    g.stroke()
  }
  g.restore()

  // Received lamps warm the rim from outside.
  const warmth = Math.min(1, seat.lamps / 4)
  if (warmth > 0) {
    const halo = g.createRadialGradient(cx, cy, radius * 0.92, cx, cy, radius * 1.5)
    halo.addColorStop(0, alpha(GOLD, 0.3 * warmth))
    halo.addColorStop(1, alpha(GOLD, 0))
    g.fillStyle = halo
    g.beginPath()
    g.arc(cx, cy, radius * 1.5, 0, Math.PI * 2)
    g.fill()
  }

  // The scroll's edge, and one dashed orbit outside it.
  g.strokeStyle = 'rgba(50,45,38,.22)'
  g.lineWidth = 1
  g.beginPath()
  g.arc(cx, cy, radius, 0, Math.PI * 2)
  g.stroke()
  g.save()
  g.setLineDash([2, 7])
  g.strokeStyle = 'rgba(50,45,38,.18)'
  g.beginPath()
  g.arc(cx, cy, radius * 1.14, 0, Math.PI * 2)
  g.stroke()
  g.restore()
}

function redraw(): void {
  const frame = lastFrame
  if (!frame || !canvas || !caption || !ledger || !moodFill || !whisperEl) return
  const seats = readSeats(frame)
  if (seats.length === 0) return
  const sky = readSky(frame)
  const palette = frame.board?.palette ?? {}

  const ratio = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  canvas.width = Math.round(w * ratio)
  canvas.height = Math.round(h * ratio)
  const g = canvas.getContext('2d')
  if (!g) return
  g.setTransform(ratio, 0, 0, ratio, 0, 0)
  g.clearRect(0, 0, w, h)
  drawGoldDust(g, w, h, sky)

  const size = seats[0]!.cells.length
  const column = w / seats.length
  const radius = Math.min(column * 0.36, h * 0.4)
  const marked = frame.board?.lastMove
  const markedSeat = marked ? Math.floor(marked.x / (size + 1)) : -1

  seats.forEach((seat, i) => {
    drawPlanet(
      g,
      seat,
      column * (i + 0.5),
      h * 0.5,
      radius,
      size,
      palette,
      marked && markedSeat === i ? { x: marked.x % (size + 1), y: marked.y } : null,
    )
  })

  // Caption row — identity lives only here, never in game logic.
  caption.innerHTML = ''
  seats.forEach((seat, i) => {
    const who = identityOf(i, seat.agentId)
    const box = document.createElement('div')
    box.style.cssText =
      `flex:1 1 0;min-width:0;text-align:center;font-family:${SERIF};color:${INK_FAINT};font-size:.72rem;letter-spacing:.14em`
    const name = document.createElement('div')
    name.style.cssText =
      `color:${INK};font-size:.95rem;letter-spacing:.24em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
      'display:flex;align-items:center;justify-content:center;gap:.5em'
    if (who?.avatar) {
      const img = document.createElement('img')
      img.src = who.avatar
      img.style.cssText = 'width:17px;height:17px;border-radius:50%;object-fit:cover;opacity:.9'
      name.appendChild(img)
    }
    name.appendChild(document.createTextNode(who?.name ?? seat.agentId))
    if (seat.guardian) {
      // 朱印 — the atlas's seal, for the one who lit every other world.
      const seal = document.createElement('span')
      seal.textContent = '守灯'
      seal.style.cssText =
        `display:inline-flex;align-items:center;justify-content:center;width:1.6rem;height:1.6rem;` +
        `border:1px solid ${ZHU_SOFT};color:${ZHU};font-family:${SERIF};font-size:.56rem;line-height:1.1;` +
        'letter-spacing:0;writing-mode:vertical-rl;padding:.1rem;transform:rotate(-2.5deg);flex:0 0 auto'
      name.appendChild(seal)
    }
    const stats = document.createElement('div')
    stats.style.marginTop = '.45rem'
    stats.textContent = `灯 ${seat.lamps.toFixed(1)}　分 ${seat.score.toFixed(1)}${
      seat.burden > 0 ? `　执念 ${seat.burden}` : ''
    }`
    box.appendChild(name)
    box.appendChild(stats)
    caption!.appendChild(box)
  })

  // The shared sky, as a filling measure and a voice.
  moodFill.style.transform = `scaleX(${sky.toFixed(3)})`
  whisperEl.textContent = WHISPERS[sky < 0.25 ? 0 : sky < 0.6 ? 1 : 2]!

  const status = frame.panels?.find((p) => p.type === 'status')?.text ?? ''
  const timeline = frame.panels?.find((p) => p.type === 'timeline')?.items ?? []
  ledger.innerHTML = ''
  const head = document.createElement('div')
  head.style.cssText = `color:${INK};font-family:${SERIF};font-size:.92rem;letter-spacing:.24em`
  head.textContent = status
  const tail = document.createElement('div')
  tail.style.cssText = `color:${INK_FAINT};font-size:.7rem;letter-spacing:.12em;margin-top:.5rem`
  tail.textContent = timeline
    .slice(-3)
    .map((e) => `${e.label ?? ''} ${e.detail ?? ''}`.trim())
    .join('　·　')
  ledger.appendChild(head)
  ledger.appendChild(tail)
}

function overlay(css: string): HTMLDivElement {
  const el = document.createElement('div')
  el.style.cssText = `position:fixed;inset:0;pointer-events:none;${css}`
  return el
}

function mount(root: HTMLElement): void {
  if (canvas) return
  root.style.cssText =
    `margin:0;height:100vh;overflow:hidden;display:flex;flex-direction:column;color:${INK};` +
    `font-family:${SERIF};line-height:2;-webkit-font-smoothing:antialiased;` +
    'background:radial-gradient(120vw 120vh at 50% 40%, rgba(255,252,242,.9), transparent 70%),' +
    PAPER

  // Grain and vignette, exactly as the atlas layers them.
  root.appendChild(overlay(`z-index:9;opacity:.5;mix-blend-mode:multiply;background-image:${GRAIN}`))
  root.appendChild(
    overlay('z-index:8;background:radial-gradient(140% 120% at 50% 45%, transparent 55%, rgba(120,100,60,.10) 100%)'),
  )

  const header = document.createElement('div')
  header.style.cssText = 'padding:1.1rem 1.6rem .2rem;display:flex;align-items:baseline;gap:.8rem;z-index:10'
  const dot = document.createElement('span')
  dot.style.cssText = `width:6px;height:6px;border-radius:50%;background:${ZHU};box-shadow:0 0 9px rgba(178,58,38,.5)`
  const brand = document.createElement('span')
  brand.textContent = '神明的画笔'
  brand.style.cssText = `letter-spacing:.4em;font-size:.95rem;color:${INK}`
  const latin = document.createElement('span')
  latin.textContent = 'Celestial Atlas'
  latin.style.cssText = `font-family:${LATIN};font-size:.58rem;letter-spacing:.5em;color:${INK_FAINT};text-transform:uppercase`
  header.appendChild(dot)
  header.appendChild(brand)
  header.appendChild(latin)

  canvas = document.createElement('canvas')
  canvas.style.cssText = 'flex:1 1 auto;width:100%;min-height:0;display:block;position:relative;z-index:2'

  caption = document.createElement('div')
  caption.style.cssText = 'display:flex;padding:0 1rem .4rem;position:relative;z-index:10'

  // 共同的天空 — the indigo-to-gold measure from the atlas.
  const mood = document.createElement('div')
  mood.style.cssText =
    'margin:.2rem auto 0;width:min(380px,62%);height:2px;background:rgba(50,45,38,.12);position:relative;overflow:hidden;z-index:10'
  moodFill = document.createElement('i')
  moodFill.style.cssText =
    `position:absolute;inset:0;transform-origin:left;transform:scaleX(0);background:linear-gradient(90deg,${DAI},${GOLD})`
  mood.appendChild(moodFill)

  whisperEl = document.createElement('div')
  whisperEl.style.cssText =
    `text-align:center;margin-top:.7rem;font-size:.78rem;letter-spacing:.2em;color:${INK_SOFT};z-index:10;position:relative`

  ledger = document.createElement('div')
  ledger.style.cssText = 'padding:.5rem 1.4rem 1.1rem;text-align:center;position:relative;z-index:10'

  root.appendChild(header)
  root.appendChild(canvas)
  root.appendChild(caption)
  root.appendChild(mood)
  root.appendChild(whisperEl)
  root.appendChild(ledger)
  window.addEventListener('resize', redraw)
}

onFrame((frame, root) => {
  mount(root)
  lastFrame = frame as Frame
  redraw()
})

onPlayers((p) => {
  players = p
  redraw()
})
