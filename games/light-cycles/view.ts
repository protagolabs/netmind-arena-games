/**
 * Light Cycles author view (T2) — runs in the sandboxed Arena iframe and draws
 * each frame the platform posts in. Frames are this game's `render(state)`
 * output: a T1-valid RenderSpec plus extra fields (heads, committed, crashes).
 *
 * Look: dark arena floor, faint grid, glowing neon trails (blue vs crimson),
 * bright rider heads, and a spark burst on every wreck. Player identity
 * (avatar · name per seat) arrives via `onPlayers` — game logic never sees it.
 *
 * The header is built ONCE per identity change and only its badges are
 * toggled per frame: rebuilding `<img>` elements every frame re-requests the
 * avatar URL (~2x/s) and any transient failure shows as a broken-image glyph.
 * Avatars that fail to load (dead URL, offline, iframe img policy) fall back
 * to a seat-coloured initial badge instead.
 */
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import { ARENA_THEME } from '@arena/game-sdk/theme'
import type { PlayerInfo } from '@arena/game-sdk'

interface CycleFrame {
  board?: { cols: number; rows: number; cells: number[][] }
  panels?: Array<{ type: string; text?: string }>
  heads?: { x: number; y: number }[]
  committed?: [boolean, boolean]
  status?: 'playing' | 'over'
  winner?: string
  crashes?: { seat: number; x: number; y: number; cause: string }[]
}

const SEAT_COLOR = ['#4c9aff', ARENA_THEME.accent] as const
const SEAT_NAME = ['Blue', 'Red'] as const

// Latest identity + frame; either can arrive first, so cache both and redraw.
let players: PlayerInfo[] = []
let lastFrame: CycleFrame | null = null

let header: HTMLDivElement | null = null
let canvas: HTMLCanvasElement | null = null
let status: HTMLDivElement | null = null

function ensureDom(root: HTMLElement): void {
  if (canvas) return
  root.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px'
  header = document.createElement('div')
  header.style.cssText = `display:flex;gap:24px;align-items:center;justify-content:center;min-height:40px;font:13px ${ARENA_THEME.font};color:${ARENA_THEME.fg}`
  canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 480
  canvas.style.cssText = 'width:min(100%,480px);height:auto;border-radius:10px'
  status = document.createElement('div')
  status.style.cssText = `font:13px ${ARENA_THEME.font};color:${ARENA_THEME.fgSubtle}`
  wrap.appendChild(header)
  wrap.appendChild(canvas)
  wrap.appendChild(status)
  root.appendChild(wrap)
}

/** Seat-coloured initial badge — the avatar fallback (and the no-avatar look). */
function initialBadge(seat: number, name: string): HTMLSpanElement {
  const el = document.createElement('span')
  el.textContent = (name || SEAT_NAME[seat] || '?').slice(0, 1).toUpperCase()
  el.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:${SEAT_COLOR[seat]}26;border:1px solid ${SEAT_COLOR[seat]};color:${SEAT_COLOR[seat]};font:600 12px ${ARENA_THEME.font}`
  return el
}

// Per-seat badge slots, toggled in place each frame (see header comment).
let chipSlots: Array<{ lock: HTMLSpanElement; crown: HTMLSpanElement } | null> = [null, null]
let playersKey: string | null = null

/** One "swatch · avatar · name · badges" chip for one seat. */
function seatChip(seat: number): HTMLDivElement {
  const info = players.find((p) => p.seat === seat)
  const name = info?.name ?? SEAT_NAME[seat] ?? `Seat ${seat}`
  const chip = document.createElement('div')
  chip.style.cssText = 'display:flex;align-items:center;gap:8px'

  const swatch = document.createElement('span')
  swatch.style.cssText = `width:12px;height:12px;border-radius:3px;background:${SEAT_COLOR[seat]};box-shadow:0 0 8px ${SEAT_COLOR[seat]}`
  chip.appendChild(swatch)

  if (info?.avatar) {
    const img = document.createElement('img')
    img.src = info.avatar
    img.alt = ''
    img.style.cssText = `width:24px;height:24px;border-radius:50%;background:${ARENA_THEME.surface}`
    img.onerror = () => img.replaceWith(initialBadge(seat, name))
    chip.appendChild(img)
  } else {
    chip.appendChild(initialBadge(seat, name))
  }

  const label = document.createElement('span')
  label.textContent = name
  chip.appendChild(label)

  const lock = document.createElement('span')
  lock.textContent = 'LOCKED'
  lock.style.cssText = `display:none;font-size:10px;letter-spacing:1px;padding:2px 6px;border-radius:4px;border:1px solid ${ARENA_THEME.border};color:${ARENA_THEME.fgSubtle}`
  chip.appendChild(lock)

  const crown = document.createElement('span')
  crown.textContent = 'WINNER'
  crown.style.cssText = `display:none;font-size:10px;letter-spacing:1px;padding:2px 6px;border-radius:4px;background:${ARENA_THEME.accent};color:${ARENA_THEME.accentFg}`
  chip.appendChild(crown)

  chipSlots[seat] = { lock, crown }
  return chip
}

/** (Re)build the header only when identity actually changes. */
function ensureHeader(): void {
  if (!header) return
  const key = JSON.stringify(players.map((p) => [p.seat, p.agentId, p.name, p.avatar ?? '']))
  if (key === playersKey) return
  playersKey = key
  header.innerHTML = ''
  chipSlots = [null, null]
  header.appendChild(seatChip(0))
  const vs = document.createElement('span')
  vs.textContent = 'vs'
  vs.style.color = ARENA_THEME.fgSubtle
  header.appendChild(vs)
  header.appendChild(seatChip(1))
}

/** Toggle LOCKED / WINNER badges in place from the latest frame. */
function updateBadges(): void {
  for (const seat of [0, 1] as const) {
    const slot = chipSlots[seat]
    if (!slot) continue
    const playing = lastFrame?.status === 'playing'
    slot.lock.style.display = playing && lastFrame?.committed?.[seat] === true ? '' : 'none'
    const info = players.find((p) => p.seat === seat)
    const won =
      lastFrame?.status === 'over' && lastFrame.winner !== undefined && info?.agentId === lastFrame.winner
    slot.crown.style.display = won ? '' : 'none'
  }
}

function drawBurst(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string): void {
  g.save()
  g.strokeStyle = color
  g.shadowColor = color
  g.shadowBlur = 12
  g.lineWidth = 2
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 4) * i + Math.PI / 8
    g.beginPath()
    g.moveTo(cx + Math.cos(a) * r * 0.35, cy + Math.sin(a) * r * 0.35)
    g.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95)
    g.stroke()
  }
  g.restore()
}

function draw(): void {
  if (!canvas || !header || !status || !lastFrame?.board) return
  const { cols, rows, cells } = lastFrame.board
  const g = canvas.getContext('2d')
  if (!g) return

  ensureHeader()
  updateBadges()
  status.textContent = lastFrame.panels?.find((p) => p.type === 'status')?.text ?? ''

  const size = canvas.width
  const pad = 14
  const cell = Math.floor((size - pad * 2) / cols)
  const ox = Math.floor((size - cell * cols) / 2)
  const oy = Math.floor((size - cell * rows) / 2)

  // Arena floor + faint grid.
  g.clearRect(0, 0, size, size)
  g.fillStyle = ARENA_THEME.bg
  g.fillRect(0, 0, size, size)
  g.strokeStyle = 'rgba(255,255,255,0.05)'
  g.lineWidth = 1
  for (let x = 0; x <= cols; x++) {
    g.beginPath()
    g.moveTo(ox + x * cell + 0.5, oy)
    g.lineTo(ox + x * cell + 0.5, oy + rows * cell)
    g.stroke()
  }
  for (let y = 0; y <= rows; y++) {
    g.beginPath()
    g.moveTo(ox, oy + y * cell + 0.5)
    g.lineTo(ox + cols * cell, oy + y * cell + 0.5)
    g.stroke()
  }
  // Arena border glow.
  g.strokeStyle = ARENA_THEME.border
  g.strokeRect(ox + 0.5, oy + 0.5, cols * cell, rows * cell)

  // Trails (codes 1/2) as glowing inset squares; heads (3/4) drawn after.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const code = cells[y]?.[x] ?? 0
      if (code !== 1 && code !== 2) continue
      const color = SEAT_COLOR[code - 1]!
      const px = ox + x * cell
      const py = oy + y * cell
      g.save()
      g.shadowColor = color
      g.shadowBlur = 10
      g.globalAlpha = 0.75
      g.fillStyle = color
      const inset = Math.max(2, Math.floor(cell * 0.18))
      g.fillRect(px + inset, py + inset, cell - inset * 2, cell - inset * 2)
      g.restore()
    }
  }

  // Rider heads: bright orb + white core.
  for (const seat of [0, 1] as const) {
    const head = lastFrame.heads?.[seat]
    if (!head) continue
    const color = SEAT_COLOR[seat]
    const cx = ox + head.x * cell + cell / 2
    const cy = oy + head.y * cell + cell / 2
    g.save()
    g.shadowColor = color
    g.shadowBlur = 18
    g.fillStyle = color
    g.beginPath()
    g.arc(cx, cy, cell * 0.34, 0, Math.PI * 2)
    g.fill()
    g.shadowBlur = 0
    g.fillStyle = '#ffffff'
    g.beginPath()
    g.arc(cx, cy, cell * 0.13, 0, Math.PI * 2)
    g.fill()
    g.restore()
  }

  // Wreck bursts (crash cells may sit 1 off-grid on a wall hit — clamp).
  for (const c of lastFrame.crashes ?? []) {
    const x = Math.max(0, Math.min(cols - 1, c.x))
    const y = Math.max(0, Math.min(rows - 1, c.y))
    const cx = ox + x * cell + cell / 2
    const cy = oy + y * cell + cell / 2
    drawBurst(g, cx, cy, cell, '#fbbf24')
    drawBurst(g, cx, cy, cell * 0.7, SEAT_COLOR[c.seat] ?? '#ffffff')
  }
}

onPlayers((p) => {
  players = p
  draw()
})

onFrame((frame, root) => {
  ensureDom(root)
  lastFrame = frame as CycleFrame
  draw()
})
