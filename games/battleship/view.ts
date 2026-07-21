/**
 * Battleship author view (T2) — runs in a sandboxed Arena iframe. Draws TWO
 * side-by-side 5x5 grids from the game's viewer-scoped `render(state, ctx)`
 * frames: "Your fleet" (own ships + incoming shots) and "Enemy waters" (masked
 * -- only your own hits/misses against them are ever visible).
 *
 * Legend (dark blue empty = untouched water; steel-gray block = your own
 * intact ship, never shown to the opponent/spectator; red X = hit; small
 * white dot = miss; orange border = the board currently being fired at;
 * orange ring = where the last shot landed):
 *   - untouched water            -> plain dark-blue cell, no mark
 *   - your own intact ship       -> steel-gray rounded block (own board only)
 *   - hit                        -> red X
 *   - miss                       -> small white dot
 *   - board currently being fired at -> orange outline on that panel
 *   - last shot's cell           -> orange ring
 *
 * During the 'placing' phase only "Your fleet" is shown (the enemy board is
 * meaningless before firing starts) plus a status line naming who's still
 * placing. Identity (name/avatar) arrives via `onPlayers`; author logic never
 * sees it.
 */
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import type { PlayerInfo } from '@arena/game-sdk'

interface Side {
  seat: number
  board: number[][] // 5x5, row 0 = top (matches render()'s top-to-bottom order)
  shipsLeft?: number
  placed?: boolean
}
interface BSFrame {
  phase?: 'placing' | 'playing' | 'won'
  viewerSeat?: number
  you?: Side
  opponent?: Side
  players?: [string, string]
  side?: number
  lastShot?: { x: number; y: number; hit: boolean; targetSeat: number } | null
  panels?: Array<{ type: string; text?: string }>
}

let host: HTMLElement | null = null
let root: HTMLElement | null = null
let players: PlayerInfo[] = []
let lastFrame: BSFrame | null = null

function monogramUri(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0
  const hue = h % 360
  const initials = (label.match(/[a-z0-9]/gi)?.slice(0, 2).join('') || '?').toUpperCase()
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">` +
    `<rect width="40" height="40" rx="9" fill="hsl(${hue},55%,42%)"/>` +
    `<text x="20" y="27" font-family="system-ui,sans-serif" font-size="17" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text>` +
    `</svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

const nameOf = (seat: number | undefined, fallback: string): string =>
  (seat !== undefined && players.find((p) => p.seat === seat)?.name) || fallback
const avatarOf = (seat: number | undefined, label: string): string => {
  const a = seat !== undefined ? players.find((p) => p.seat === seat)?.avatar : undefined
  return a && a.length > 0 ? a : monogramUri(label)
}

const CELL = 38

function cellEl(v: number, isLastShot: boolean): HTMLDivElement {
  const c = document.createElement('div')
  c.style.cssText =
    `width:${CELL}px;height:${CELL}px;display:flex;align-items:center;justify-content:center;` +
    'background:#1e3a5f;border:1px solid rgba(255,255,255,.08);border-radius:4px;position:relative'
  if (v === 1) {
    // your own intact ship: steel-gray rounded block (own board only --
    // maskBoard() already guarantees an opponent/spectator never sees a '1').
    const ship = document.createElement('div')
    ship.style.cssText = 'width:64%;height:64%;background:#94a3b8;border-radius:6px'
    c.appendChild(ship)
  } else if (v === 2) {
    // hit: red X
    const x = document.createElement('div')
    x.textContent = '✕'
    x.style.cssText = 'font:800 20px system-ui;color:#dc2626;line-height:1'
    c.appendChild(x)
  } else if (v === 3) {
    // miss: small white dot -- deliberately distinct from a hit (X) and from
    // untouched water (nothing at all), so "already tried, no ship" is never
    // confused with either "already tried, hit" or "never tried".
    const dot = document.createElement('div')
    dot.style.cssText = 'width:26%;height:26%;border-radius:50%;background:#f8fafc'
    c.appendChild(dot)
  }
  // v === 0 (untouched water): no mark at all, just the dark-blue cell.
  if (isLastShot) {
    const ring = document.createElement('div')
    ring.style.cssText =
      'position:absolute;inset:2px;border-radius:50%;border:3px solid #f97316;pointer-events:none'
    c.appendChild(ring)
  }
  return c
}

function grid(board: number[][], lastShot?: { x: number; y: number } | null, boardSeat?: number, lastShotTargetSeat?: number): HTMLDivElement {
  const g = document.createElement('div')
  g.style.cssText = `display:grid;grid-template-columns:repeat(5,${CELL}px);gap:3px;padding:8px;` + 'background:#0f2440;border-radius:10px'
  board.forEach((row, ry) => {
    // frame's board rows are top-to-bottom already (row 0 = y=4 .. row 4 = y=0);
    // recover the real y for lastShot matching: y = (rows.length - 1 - ry)
    const y = board.length - 1 - ry
    row.forEach((v, x) => {
      const isLast =
        !!lastShot && lastShot.x === x && lastShot.y === y && boardSeat !== undefined && boardSeat === lastShotTargetSeat
      g.appendChild(cellEl(v, isLast))
    })
  })
  return g
}

function boardPanel(
  title: string,
  avatarSeat: number | undefined,
  fallbackName: string,
  shipsLeft: number | undefined,
  board: number[][],
  lastShot: { x: number; y: number; targetSeat: number } | null | undefined,
  isCurrentTarget: boolean,
  boardSeat: number | undefined,
): HTMLDivElement {
  const wrap = document.createElement('div')
  // Orange outline on whichever board is the one currently being fired at.
  wrap.style.cssText =
    'display:flex;flex-direction:column;align-items:center;gap:8px;padding:6px;border-radius:14px;' +
    (isCurrentTarget ? 'outline:2px solid #f97316;outline-offset:2px' : 'outline:2px solid transparent')
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;gap:8px'
  const img = document.createElement('img')
  img.src = avatarOf(avatarSeat, fallbackName)
  img.width = 28
  img.height = 28
  img.style.cssText = 'width:28px;height:28px;border-radius:50%;object-fit:cover;background:#0b0b0f'
  const nm = document.createElement('span')
  nm.textContent = title + (shipsLeft !== undefined ? ` · ${shipsLeft}/8` : '')
  nm.style.cssText = 'font:700 14px system-ui;color:#e2e8f0'
  header.appendChild(img)
  header.appendChild(nm)
  wrap.appendChild(header)
  wrap.appendChild(grid(board, lastShot, boardSeat, lastShot?.targetSeat))
  return wrap
}

function ensureRoot(h: HTMLElement): HTMLElement {
  if (!root) {
    host = h
    host.innerHTML = ''
    root = document.createElement('div')
    root.style.cssText = 'padding:14px;max-width:640px;margin:0 auto;font-family:system-ui'
    host.appendChild(root)
  }
  return root
}

function draw(): void {
  if (!root || !lastFrame) return
  const f = lastFrame
  root.innerHTML = ''

  const title = document.createElement('div')
  title.textContent = 'Battleship'
  title.style.cssText = 'font:700 18px system-ui;color:#60a5fa;text-align:center;margin-bottom:10px'
  root.appendChild(title)

  const youSeat = f.you?.seat
  const oppSeat = f.opponent?.seat
  const isParticipant = youSeat !== undefined && youSeat >= 0
  const youName = isParticipant ? 'You' : nameOf(0, f.players?.[0] ?? 'Player 1')
  const oppName = nameOf(oppSeat, f.players?.[oppSeat === 0 ? 0 : 1] ?? 'Opponent')

  if (f.phase === 'placing') {
    root.appendChild(boardPanel(youName, youSeat, youName, undefined, f.you?.board ?? [], null, false, youSeat))
    const status = document.createElement('div')
    status.textContent = f.panels?.find((p) => p.type === 'status')?.text ?? ''
    status.style.cssText = 'font:13px system-ui;color:#cbd5e1;text-align:center;margin-top:10px'
    root.appendChild(status)
    return
  }

  // Which board is "currently being fired at"? If it's your turn (side ===
  // youSeat), you're about to fire at the opponent's board. Otherwise the
  // opponent is about to fire at yours. For a spectator (not a participant),
  // highlight whichever board `f.side` owns as the ATTACKER's target -- i.e.
  // the OTHER board from the mover's seat.
  const moverSeat = f.side
  const youAreTargeted = isParticipant ? moverSeat !== youSeat : moverSeat === oppSeat
  const oppIsTargeted = !youAreTargeted

  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:22px;justify-content:center;flex-wrap:wrap'
  row.appendChild(boardPanel(youName, youSeat, youName, f.you?.shipsLeft, f.you?.board ?? [], f.lastShot, f.phase === 'playing' && youAreTargeted, youSeat))
  row.appendChild(boardPanel(oppName, oppSeat, oppName, f.opponent?.shipsLeft, f.opponent?.board ?? [], f.lastShot, f.phase === 'playing' && oppIsTargeted, oppSeat))
  root.appendChild(row)

  const legend = document.createElement('div')
  legend.style.cssText = 'display:flex;gap:14px;justify-content:center;margin-top:10px;font:11px system-ui;color:#94a3b8;flex-wrap:wrap'
  legend.innerHTML =
    '<span style="color:#dc2626">✕ hit</span>' +
    '<span>⚪ miss</span>' +
    '<span>🟦 unexplored</span>' +
    '<span style="color:#94a3b8">⬛ your ship</span>' +
    '<span style="color:#f97316">🟧 board under fire</span>'
  root.appendChild(legend)

  const status = document.createElement('div')
  status.textContent = f.panels?.find((p) => p.type === 'status')?.text ?? ''
  status.style.cssText = 'font:13px system-ui;color:#cbd5e1;text-align:center;margin-top:8px'
  root.appendChild(status)
}

// —— playback pacing (same convention as doudizhu's view) ——
const HOLD_MS = 1200
const frameQueue: BSFrame[] = []
let busy = false
function pump(): void {
  if (busy || frameQueue.length === 0) return
  lastFrame = frameQueue.shift()!
  draw()
  if (frameQueue.length > 0) {
    busy = true
    setTimeout(() => {
      busy = false
      pump()
    }, HOLD_MS)
  }
}

onFrame((frame, h) => {
  ensureRoot(h)
  frameQueue.push(frame as BSFrame)
  pump()
})
onPlayers((p) => {
  players = p
  draw()
})
