/**
 * Gomoku author view (T2) — runs in a sandboxed Arena iframe and draws each
 * frame the platform posts in. Frames are this game's `render(state)` output
 * (a RenderSpec: { board:{cols,rows,cells,lastMove,palette}, panels }).
 *
 * This is the "author draws it themselves" proof: a real wood board with grid
 * lines, star points, stones, and a last-move marker — richer than the platform
 * default. The platform never runs this on its own origin (iframe-isolated).
 *
 * It ALSO shows how to use the player identity the platform exposes: `onPlayers`
 * hands the view seat → { agentId, name, avatar }. Author game logic only ever
 * sees opaque agent ids; the view is where identity gets rendered, and the view
 * decides entirely where — here, a header row of "avatar · name" per side.
 */
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import type { PlayerInfo } from '@arena/game-sdk'

interface BoardFrame {
  board?: {
    cols: number
    rows: number
    cells: number[][]
    palette?: Record<number, string>
    lastMove?: { x: number; y: number }
  }
  panels?: Array<{ type: string; text?: string }>
}

const STAR_POINTS_15 = [
  [3, 3], [3, 11], [11, 3], [11, 11], [7, 7],
]
// Seat 0 = Black, seat 1 = White (cell code = seat + 1).
const SEAT_LABELS = ['Black', 'White']
const SEAT_COLORS = ['#111827', '#f8fafc']

// Latest identity + frame the platform posted. Either can arrive first, so we
// cache both and redraw whenever one changes.
let players: PlayerInfo[] = []
let lastFrame: unknown = null

let header: HTMLDivElement | null = null
let canvas: HTMLCanvasElement | null = null
let status: HTMLDivElement | null = null

function ensureDom(root: HTMLElement): void {
  if (canvas) return
  root.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px'
  header = document.createElement('div')
  header.style.cssText = 'display:flex;gap:24px;align-items:center;justify-content:center;min-height:40px;font:13px system-ui;color:#e2e8f0'
  canvas = document.createElement('canvas')
  canvas.width = 480
  canvas.height = 480
  canvas.style.cssText = 'width:min(100%,480px);height:auto;border-radius:8px'
  status = document.createElement('div')
  status.style.cssText = 'font:13px system-ui;color:#cbd5e1'
  wrap.appendChild(header)
  wrap.appendChild(canvas)
  wrap.appendChild(status)
  root.appendChild(wrap)
}

/** A "stone swatch · avatar · name" chip for one seat. */
function playerChip(p: PlayerInfo): HTMLDivElement {
  const chip = document.createElement('div')
  chip.style.cssText = 'display:flex;align-items:center;gap:8px'
  const swatch = document.createElement('span')
  const color = SEAT_COLORS[p.seat] ?? '#888'
  swatch.style.cssText = `width:14px;height:14px;border-radius:50%;background:${color};border:1px solid rgba(0,0,0,0.4);flex:none`
  chip.appendChild(swatch)
  if (p.avatar) {
    const img = document.createElement('img')
    img.src = p.avatar
    img.alt = ''
    img.width = 24
    img.height = 24
    img.style.cssText = 'width:24px;height:24px;border-radius:50%;object-fit:cover'
    chip.appendChild(img)
  }
  const label = document.createElement('span')
  const role = SEAT_LABELS[p.seat] ?? `Seat ${p.seat}`
  label.textContent = `${role} · ${p.name}`
  chip.appendChild(label)
  return chip
}

function drawHeader(): void {
  if (!header) return
  header.innerHTML = ''
  for (const p of [...players].sort((a, b) => a.seat - b.seat)) {
    header.appendChild(playerChip(p))
  }
}

/** Show names instead of raw agent ids in the status line (e.g. "Winner: …"). */
function humanizeStatus(text: string): string {
  let out = text
  for (const p of players) out = out.split(p.agentId).join(p.name)
  return out
}

function drawBoard(root: HTMLElement): void {
  const f = lastFrame as BoardFrame | null
  const b = f?.board
  if (!b || !canvas || !status) return
  const c = canvas
  const s = status
  const ctx = c.getContext('2d')
  if (!ctx) return

  const N = b.cols
  const size = c.width
  const pad = size / (N + 1) // one cell of margin; lines run through cell centers
  const step = (size - 2 * pad) / (N - 1)
  const pos = (i: number) => pad + i * step

  // wood
  ctx.fillStyle = '#c8a06a'
  ctx.fillRect(0, 0, size, size)

  // grid lines (through intersections)
  ctx.strokeStyle = 'rgba(40,25,10,0.7)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i < N; i++) {
    ctx.moveTo(pos(0), pos(i)); ctx.lineTo(pos(N - 1), pos(i))
    ctx.moveTo(pos(i), pos(0)); ctx.lineTo(pos(i), pos(N - 1))
  }
  ctx.stroke()

  // star points (15x15)
  if (N === 15) {
    ctx.fillStyle = 'rgba(40,25,10,0.85)'
    for (const [sx, sy] of STAR_POINTS_15) {
      ctx.beginPath(); ctx.arc(pos(sx), pos(sy), 3, 0, Math.PI * 2); ctx.fill()
    }
  }

  // stones
  const r = step * 0.45
  const palette = b.palette ?? { 1: '#111827', 2: '#f8fafc' }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = b.cells[y]?.[x] ?? 0
      if (v === 0) continue
      const cx = pos(x), cy = pos(y)
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.fillStyle = palette[v] ?? '#888'
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke()
    }
  }

  // last move marker
  if (b.lastMove) {
    ctx.beginPath(); ctx.arc(pos(b.lastMove.x), pos(b.lastMove.y), r * 0.4, 0, Math.PI * 2)
    ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 2; ctx.stroke()
  }

  const st = f?.panels?.find((p) => p.type === 'status')?.text
  s.textContent = st ? humanizeStatus(st) : ''
}

function render(root: HTMLElement): void {
  ensureDom(root)
  drawHeader()
  drawBoard(root)
}

onFrame((frame, root) => {
  lastFrame = frame
  render(root)
})

onPlayers((p) => {
  players = p
  render(document.body)
})
