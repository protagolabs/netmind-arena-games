/**
 * Divine Brush author view (T2) — runs in a sandboxed Arena iframe and draws each
 * frame the platform posts in.
 *
 * The declarative T1 fallback is a correct but flat strip of coloured squares.
 * This game is about a shared sky, so the view draws the thing the numbers mean:
 * a starfield whose brightness IS the frame's `sky` value, every planet floating
 * in it with a halo scaled to the lamps it has received, and VOID cells left
 * genuinely unpainted so the stars show straight through the negative space the
 * scoring rewards.
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
 * where they go: here, a caption under each planet.
 */
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import type { PlayerInfo } from '@arena/game-sdk'
import { ARENA_THEME } from '@arena/game-sdk/theme'

// Grid size is read off the frame rather than hardcoded, so retuning the board in
// the game logic never leaves this renderer drawing the wrong shape.
const SEPARATOR = 6
const VOID = 0
const GLOW = 5
const STAR_COUNT = 220

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
// Drawing
// ---------------------------------------------------------------------------

/** Stable pseudo-random in [0,1) — stars must not swim between frames. */
function jitter(i: number, salt: number): number {
  const v = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return v - Math.floor(v)
}

function drawSky(g: CanvasRenderingContext2D, w: number, h: number, sky: number): void {
  g.fillStyle = '#05070f'
  g.fillRect(0, 0, w, h)
  // A dead sky still has a few stars; a fed one is dense and warm.
  const lit = 0.12 + sky * 0.88
  for (let i = 0; i < STAR_COUNT; i++) {
    const x = jitter(i, 1) * w
    const y = jitter(i, 2) * h
    const size = 0.4 + jitter(i, 3) * 1.3
    const alpha = (0.12 + jitter(i, 4) * 0.55) * lit
    g.fillStyle = `rgba(255,247,230,${alpha.toFixed(3)})`
    g.beginPath()
    g.arc(x, y, size, 0, Math.PI * 2)
    g.fill()
  }
  // The horizon warms as the table gets more generous.
  const wash = g.createLinearGradient(0, h, 0, 0)
  wash.addColorStop(0, `rgba(255,196,120,${(0.05 + sky * 0.16).toFixed(3)})`)
  wash.addColorStop(1, 'rgba(255,196,120,0)')
  g.fillStyle = wash
  g.fillRect(0, 0, w, h)
}

function drawPlanet(
  g: CanvasRenderingContext2D,
  seat: Seat,
  cx: number,
  cy: number,
  cell: number,
  size: number,
  palette: Record<string, string>,
  highlight: { x: number; y: number } | null,
): void {
  const span = cell * size
  const left = cx - span / 2
  const top = cy - span / 2

  // Halo — how much light this planet has been given by everyone else.
  const halo = Math.min(1, seat.lamps / 4)
  if (halo > 0) {
    const glow = g.createRadialGradient(cx, cy, span * 0.3, cx, cy, span * 0.95)
    glow.addColorStop(0, `rgba(255,217,138,${(0.28 * halo).toFixed(3)})`)
    glow.addColorStop(1, 'rgba(255,217,138,0)')
    g.fillStyle = glow
    g.fillRect(left - span * 0.5, top - span * 0.5, span * 2, span * 2)
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const code = seat.cells[y]?.[x] ?? VOID
      // VOID is left unpainted on purpose: the negative space the scoring rewards
      // is the sky showing through, not a grey tile.
      if (code === VOID) continue
      const px = left + x * cell
      const py = top + y * cell
      g.fillStyle = palette[String(code)] ?? '#888'
      if (code === GLOW) {
        g.shadowColor = 'rgba(255,217,138,0.9)'
        g.shadowBlur = cell * 0.9
      }
      g.beginPath()
      g.roundRect(px + 0.5, py + 0.5, cell - 1, cell - 1, cell * 0.22)
      g.fill()
      g.shadowBlur = 0
    }
  }

  if (highlight) {
    g.strokeStyle = ARENA_THEME.lastMove
    g.lineWidth = Math.max(1.5, cell * 0.12)
    g.beginPath()
    g.roundRect(left + highlight.x * cell + 0.5, top + highlight.y * cell + 0.5, cell - 1, cell - 1, cell * 0.22)
    g.stroke()
  }

  // Burden sits on the planet as a dim smudge, so it is visible before settlement.
  if (seat.burden > 0) {
    g.fillStyle = 'rgba(10,8,20,0.30)'
    g.beginPath()
    g.roundRect(left, top, span, span, cell * 0.3)
    g.fill()
  }
}

function redraw(): void {
  const frame = lastFrame
  if (!frame || !canvas || !caption || !ledger) return
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

  drawSky(g, w, h, sky)

  const size = seats[0]!.cells.length
  const column = w / seats.length
  const cell = Math.min((column * 0.7) / size, (h * 0.8) / size)
  // The packed strip is `size` columns per planet plus a 1-column gutter between.
  const marked = frame.board?.lastMove
  const markedSeat = marked ? Math.floor(marked.x / (size + 1)) : -1

  seats.forEach((seat, i) => {
    drawPlanet(
      g,
      seat,
      column * (i + 0.5),
      h * 0.5,
      cell,
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
    box.style.cssText = `flex:1 1 0;min-width:0;text-align:center;font:12px ${ARENA_THEME.font};color:${ARENA_THEME.fgSubtle}`
    const name = document.createElement('div')
    name.style.cssText = `color:${ARENA_THEME.fg};font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;justify-content:center;gap:6px`
    if (who?.avatar) {
      const img = document.createElement('img')
      img.src = who.avatar
      img.style.cssText = 'width:18px;height:18px;border-radius:50%;object-fit:cover'
      name.appendChild(img)
    }
    name.appendChild(document.createTextNode(who?.name ?? seat.agentId))
    if (seat.guardian) {
      const badge = document.createElement('span')
      badge.textContent = '守灯人'
      badge.style.cssText = `font-size:10px;padding:1px 5px;border-radius:999px;background:rgba(255,217,138,0.16);color:#ffd98a`
      name.appendChild(badge)
    }
    const stats = document.createElement('div')
    stats.style.marginTop = '3px'
    stats.textContent = `灯 ${seat.lamps.toFixed(1)} · 分 ${seat.score.toFixed(1)}${
      seat.burden > 0 ? ` · 执念 ${seat.burden}` : ''
    }`
    box.appendChild(name)
    box.appendChild(stats)
    caption!.appendChild(box)
  })

  const status = frame.panels?.find((p) => p.type === 'status')?.text ?? ''
  const timeline = frame.panels?.find((p) => p.type === 'timeline')?.items ?? []
  const recent = timeline.slice(-3).map((e) => `${e.label ?? ''} ${e.detail ?? ''}`.trim())
  ledger.innerHTML = ''
  const head = document.createElement('div')
  head.style.cssText = `color:${ARENA_THEME.fg};font-size:13px`
  head.textContent = status
  const tail = document.createElement('div')
  tail.style.cssText = `color:${ARENA_THEME.fgSubtle};font-size:11px;margin-top:4px`
  tail.textContent = recent.join('   ·   ')
  ledger.appendChild(head)
  ledger.appendChild(tail)
}

function mount(root: HTMLElement): void {
  if (canvas) return
  root.style.cssText = `margin:0;background:#05070f;font-family:${ARENA_THEME.font};display:flex;flex-direction:column;height:100vh;overflow:hidden`
  canvas = document.createElement('canvas')
  canvas.style.cssText = 'flex:1 1 auto;width:100%;min-height:0;display:block'
  caption = document.createElement('div')
  caption.style.cssText = 'display:flex;padding:2px 8px 8px'
  ledger = document.createElement('div')
  ledger.style.cssText = 'padding:0 12px 12px;text-align:center'
  root.appendChild(canvas)
  root.appendChild(caption)
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
