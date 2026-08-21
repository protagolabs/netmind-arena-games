/**
 * Othello author view (T2) — runs in a sandboxed Arena iframe and draws each
 * frame the platform posts in. Frames are this game's `render(state)` output
 * (a RenderSpec: { board:{cols,rows,cells,lastMove,palette}, panels }).
 *
 * PLAYBACK PACING. The platform controls *when* it pushes frames; during a
 * replay it can burst the whole match in at once, which flashes by unwatchably.
 * We don't control that cadence, but we do control drawing — so we BUFFER the
 * incoming frames and play them out at a fixed, watchable pace, animating each
 * disc flip. Live matches (frames minutes apart) never fill the queue, so they
 * are unaffected. A rewind/reset (fewer discs than shown) snaps instantly.
 *
 * PLAYER IDENTITY. Author game logic only ever sees opaque agent ids. The
 * platform posts seat → { agentId, name, avatar } separately via `onPlayers`;
 * the view is the only place identity is rendered. Here: a per-seat card with
 * avatar + colour swatch + role + name + live disc count, highlighting whose
 * turn it is. The sandbox CSP is `img-src data:` — a remote `https:` avatar would
 * be blocked — but the host inlines every avatar as a `data:` URI before posting
 * it in, so rendering `info.avatar` directly is safe. When a seat has no avatar
 * (or inlining failed) we fall back to a generated `data:` SVG monogram.
 */
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import type { PlayerInfo } from '@arena/game-sdk'

// —— pacing knobs (ms) — tune these if replays still feel too fast/slow ——
const FLIP_MS = 500 // disc-flip / place animation duration
const HOLD_MS = 1500 // dwell on the finished move before the next one
// → each move is visible for ~2s regardless of how fast frames arrive.

const BLACK = '#111827'
const WHITE = '#f8fafc'
const SEAT_LABELS = ['Black', 'White']
const SEAT_COLORS = [BLACK, WHITE]

interface Board {
  cols: number
  rows: number
  cells: number[][]
  palette?: Record<number, string>
  lastMove?: { x: number; y: number }
}
interface Panel {
  type: string
  text?: string
  rows?: Array<{ label: string; value: string | number }>
}
interface Frame {
  board?: Board
  panels?: Panel[]
}

/** Fallback `data:` SVG avatar (used only when a seat has no avatar URL). */
function monogramUri(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0
  const hue = h % 360
  const initials = (label.match(/[a-z0-9]/gi)?.slice(0, 2).join('') || '?').toUpperCase()
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72">` +
    `<rect width="72" height="72" rx="16" fill="hsl(${hue},55%,42%)"/>` +
    `<text x="36" y="48" font-family="system-ui,sans-serif" font-size="30" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text>` +
    `</svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

// —— DOM refs (built once) ——
let canvas: HTMLCanvasElement | null = null
let statusLine: HTMLDivElement | null = null
interface SeatCard {
  card: HTMLDivElement
  avatar: HTMLImageElement
  name: HTMLDivElement
  count: HTMLDivElement
  dot: HTMLSpanElement
  lastAvatar: string
}
const cards: SeatCard[] = []

function makeSeatCard(seat: number): SeatCard {
  const card = document.createElement('div')
  card.style.cssText =
    'display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:8px 12px;border-radius:10px;' +
    'background:#161821;border:2px solid transparent;transition:border-color .2s,background .2s'

  const avatar = document.createElement('img')
  avatar.width = 34
  avatar.height = 34
  avatar.alt = ''
  avatar.style.cssText = 'width:34px;height:34px;border-radius:9px;flex:none;background:#0b0b0f;object-fit:cover'

  const meta = document.createElement('div')
  meta.style.cssText = 'display:flex;flex-direction:column;min-width:0;line-height:1.25'
  const roleRow = document.createElement('div')
  roleRow.style.cssText = 'display:flex;align-items:center;gap:5px'
  const sw = document.createElement('span')
  sw.style.cssText = `width:11px;height:11px;border-radius:50%;flex:none;background:${SEAT_COLORS[seat] ?? '#888'};box-shadow:0 0 0 1px rgba(255,255,255,.25)`
  const roleEl = document.createElement('span')
  roleEl.textContent = SEAT_LABELS[seat] ?? `Seat ${seat}`
  roleEl.style.cssText = 'font:11px system-ui;color:#94a3b8;letter-spacing:.04em;text-transform:uppercase'
  roleRow.appendChild(sw)
  roleRow.appendChild(roleEl)
  const name = document.createElement('div')
  name.style.cssText =
    'font:600 14px system-ui;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px'
  meta.appendChild(roleRow)
  meta.appendChild(name)

  const count = document.createElement('div')
  count.style.cssText = 'margin-left:auto;font:700 20px system-ui;color:#f8fafc;font-variant-numeric:tabular-nums'

  const dot = document.createElement('span')
  dot.textContent = '●'
  dot.style.cssText = 'font-size:12px;color:#22c55e;opacity:0;transition:opacity .2s;flex:none'

  card.appendChild(avatar)
  card.appendChild(meta)
  card.appendChild(count)
  card.appendChild(dot)
  return { card, avatar, name, count, dot, lastAvatar: '' }
}

function ensureDom(root: HTMLElement): HTMLCanvasElement {
  if (!canvas) {
    root.innerHTML = ''
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;gap:10px;padding:10px;max-width:480px;margin:0 auto'

    const bar = document.createElement('div')
    bar.style.cssText = 'display:flex;gap:10px'
    cards.push(makeSeatCard(0), makeSeatCard(1))
    bar.appendChild(cards[0]!.card)
    bar.appendChild(cards[1]!.card)

    canvas = document.createElement('canvas')
    canvas.width = 480
    canvas.height = 480
    canvas.style.cssText = 'width:100%;height:auto;border-radius:8px'

    statusLine = document.createElement('div')
    statusLine.style.cssText = 'font:13px system-ui;color:#cbd5e1;text-align:center;min-height:16px'

    wrap.appendChild(bar)
    wrap.appendChild(canvas)
    wrap.appendChild(statusLine)
    root.appendChild(wrap)
  }
  return canvas
}

// —— identity (onPlayers) + the frame the HUD currently reflects ——
let players: PlayerInfo[] = []
let hudFrame: Frame | null = null
/**
 * Seat to highlight while a move is animating. A frame's status names whoever
 * moves NEXT, but the board is still visibly playing the move that just
 * happened — so honouring the status during the animation highlights the wrong
 * card for ~2s and reads as inverted. While animating we pin the highlight to
 * the mover; `null` hands it back to the status line.
 */
let turnOverride: number | null = null

const playerAt = (seat: number): PlayerInfo | undefined => players.find((p) => p.seat === seat)

/** Replace agent ids with display names in a status string (e.g. "Winner: …"). */
function humanizeStatus(text: string): string {
  let out = text
  for (const p of players) out = out.split(p.agentId).join(p.name)
  return out
}

/** Redraw the HUD from the current identity + the current frame. Cheap; safe to spam. */
function renderHud(): void {
  if (cards.length < 2) return
  const sb = hudFrame?.panels?.find((p) => p.type === 'scoreboard')
  const statusText = hudFrame?.panels?.find((p) => p.type === 'status')?.text ?? ''
  const turn =
    turnOverride ?? (/Black to move/.test(statusText) ? 0 : /White to move/.test(statusText) ? 1 : -1)

  for (let seat = 0; seat < 2; seat++) {
    const c = cards[seat]!
    const info = playerAt(seat)
    const displayName = info?.name ?? SEAT_LABELS[seat] ?? `Seat ${seat}`
    c.name.textContent = displayName
    c.count.textContent = String(sb?.rows?.[seat]?.value ?? '')

    const wantAvatar = info?.avatar || monogramUri(displayName)
    if (wantAvatar !== c.lastAvatar) {
      c.avatar.src = wantAvatar
      c.lastAvatar = wantAvatar
    }

    const on = seat === turn
    c.card.style.borderColor = on ? '#22c55e' : 'transparent'
    c.card.style.background = on ? '#1b2436' : '#161821'
    c.dot.style.opacity = on ? '1' : '0'
  }

  if (statusLine) statusLine.textContent = humanizeStatus(statusText)
}

function discCount(b: Board): number {
  let n = 0
  for (const row of b.cells) for (const v of row) if (v) n++
  return n
}

/** Draw the felt + grid + every disc, optionally skipping cells drawn by the animator. */
function paint(
  ctx: CanvasRenderingContext2D,
  size: number,
  b: Board,
  palette: Record<number, string>,
  skip?: Set<number>,
): void {
  const N = b.cols
  const step = size / N
  const at = (i: number) => i * step + step / 2
  const r = step * 0.4

  ctx.fillStyle = '#1f7a45'
  ctx.fillRect(0, 0, size, size)

  ctx.strokeStyle = 'rgba(0,0,0,0.45)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let i = 0; i <= N; i++) {
    ctx.moveTo(i * step, 0)
    ctx.lineTo(i * step, size)
    ctx.moveTo(0, i * step)
    ctx.lineTo(size, i * step)
  }
  ctx.stroke()

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = b.cells[y]?.[x] ?? 0
      if (v === 0) continue
      if (skip && skip.has(y * N + x)) continue
      disc(ctx, at(x), at(y), r, r, palette[v] ?? '#888')
    }
  }
}

function disc(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, fill: string): void {
  if (rx < 0.3 || ry < 0.3) return
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'
  ctx.lineWidth = 1
  ctx.stroke()
}

function lastMoveRing(ctx: CanvasRenderingContext2D, size: number, b: Board): void {
  if (!b.lastMove) return
  const step = size / b.cols
  const at = (i: number) => i * step + step / 2
  const r = step * 0.4
  ctx.beginPath()
  ctx.arc(at(b.lastMove.x), at(b.lastMove.y), r * 0.55, 0, Math.PI * 2)
  ctx.strokeStyle = '#ef4444'
  ctx.lineWidth = 2
  ctx.stroke()
}

// —— animator ——
//
// The queue and `busy` flag this used to keep are the SDK's job now: it draws one
// frame at a time and waits for the promise below, so a move can never be
// overdrawn by the next frame arriving, and the host is told when we are ready
// for another instead of having to guess an interval.
let shown: Frame | null = null // last fully-rendered frame

function draw(frame: unknown, root: HTMLElement): void | Promise<void> {
  ensureDom(root)
  if (!canvas) return
  const next = frame as Frame
  const to = next.board
  const from = shown?.board
  const ctx = canvas.getContext('2d')
  if (!ctx || !to) {
    shown = next
    return
  }
  hudFrame = next

  // First frame, or a rewind/reset (board shrank) → snap, no animation.
  if (!from || from.cols !== to.cols || discCount(to) < discCount(from)) {
    turnOverride = null
    renderHud()
    paint(ctx, canvas.width, to, to.palette ?? { 1: BLACK, 2: WHITE }, undefined)
    lastMoveRing(ctx, canvas.width, to)
    shown = next
    return
  }

  return animate(ctx, canvas.width, from, to, next)
}

/** Animate the diff between two boards: new disc pops in, flipped discs turn over. */
function animate(
  ctx: CanvasRenderingContext2D,
  size: number,
  from: Board,
  to: Board,
  toFrame: Frame
): Promise<void> {
  const N = to.cols
  const palette = to.palette ?? { 1: BLACK, 2: WHITE }
  const step = size / N
  const at = (i: number) => i * step + step / 2
  const r = step * 0.4

  // Classify changed cells.
  const placed: Array<{ x: number; y: number; c: number }> = []
  const flipped: Array<{ x: number; y: number; a: number; b: number }> = []
  const skip = new Set<number>()
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const a = from.cells[y]?.[x] ?? 0
      const b = to.cells[y]?.[x] ?? 0
      if (a === b) continue
      skip.add(y * N + x)
      if (a === 0) placed.push({ x, y, c: b })
      else flipped.push({ x, y, a, b })
    }
  }

  // Highlight the seat whose disc is going down (colour 1 = seat 0, 2 = seat 1),
  // not the one the status line says moves next. Nothing placed (rare: a frame
  // that only flips) → fall back to the status line.
  turnOverride = placed[0] ? placed[0].c - 1 : null
  renderHud()

  return new Promise<void>((resolve) => {
    const start = performance.now()
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / FLIP_MS)
      // Static layer: everything that isn't animating.
      paint(ctx, size, to, palette, skip)
      // Placed discs grow in (ease-out).
      const grow = 1 - Math.pow(1 - t, 3)
      for (const p of placed) disc(ctx, at(p.x), at(p.y), r * grow, r * grow, palette[p.c] ?? '#888')
      // Flipped discs turn over: width collapses to a line at the halfway point,
      // colour swaps as it passes edge-on.
      const w = Math.abs(Math.cos(Math.PI * t))
      for (const f of flipped) {
        const col = t < 0.5 ? f.a : f.b
        disc(ctx, at(f.x), at(f.y), r * w, r, palette[col] ?? '#888')
      }
      lastMoveRing(ctx, size, to)

      if (t < 1) {
        requestAnimationFrame(frame)
      } else {
        // Move is fully on the board now — hand the highlight to whoever is next.
        shown = toFrame
        turnOverride = null
        renderHud()
        // The dwell is part of the frame, not something after it: resolving
        // before it elapsed would tell the host we are ready while the move it
        // just drew is still the thing being looked at.
        setTimeout(resolve, HOLD_MS)
      }
    }
    requestAnimationFrame(frame)
  })
}

onFrame(draw, { paceMs: FLIP_MS + HOLD_MS })
// Identity can arrive before or after frames; refresh the HUD whenever it lands.
onPlayers((p) => {
  players = p
  renderHud()
})
