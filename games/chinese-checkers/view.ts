/**
 * Chinese Checkers — sandboxed renderer (T2).
 *
 * Runs in an opaque-origin iframe with `default-src 'none'` and, notably,
 * `img-src data:` only — so avatars are inlined SVG monograms, never fetched.
 *
 * Four concerns, in order:
 *   1. layout   — the host gives us a fixed-height frame (560px on the current
 *      viewer), so the board is sized to whatever is left after the HUD rather
 *      than assuming it can have a square canvas all to itself;
 *   2. geometry — the frame carries the 121 hole coordinates, so this file
 *      never re-derives the star and drifts out of step with the rules;
 *   3. pacing   — the host may burst every replay frame at once, so frames are
 *      queued and played out one move at a time;
 *   4. identity — names and avatars arrive separately via `onPlayers`, and may
 *      land before or after the first frame.
 */
import { hold, onFrame, playbackSpeed, onPlayers } from '@arena/game-sdk/view'
import { ARENA_THEME as T } from '@arena/game-sdk/theme'
import type { PlayerInfo } from '@arena/game-sdk'

const HOP_MS = 320 // per leg of a jump chain
const HOLD_MS = 1050 // pause on the settled position before the next move

interface SeatSkin {
  base: string
  light: string
  dark: string
  tint: string
  label: string
}

const SEATS: readonly SeatSkin[] = [
  { base: '#4c9aff', light: '#bcd9ff', dark: '#1a56c4', tint: 'rgba(76,154,255,', label: 'Blue' },
  { base: T.accent, light: '#ffb4b6', dark: '#9c1b20', tint: 'rgba(229,72,77,', label: 'Red' },
]

// Canvas is drawn at a fixed internal resolution and scaled by CSS. Its aspect
// matches the star: 20.78 wide by 24 tall in hole-spacings.
const SCALE = 20
const PAD = 15 // how far the board surface extends past the outermost holes
const W = 460
const H = 520
const CX = W / 2
const CY = H / 2
// Holes sit sqrt(3)*SCALE = 34.6px apart, so this fills ~72% of the gap —
// chunky marbles rather than dots.
const PEG_R = 12.4
const SOCKET_R = 6

/**
 * The star's outline as a single 12-gon, alternating tip and inner corner
 * clockwise from the top. Drawing the union in one path (rather than two
 * overlapping triangles) is what keeps the interior free of seams.
 * Vertices are (x, z) cube pairs — fixed properties of the 121-hole board.
 */
const STAR_OUTLINE: readonly (readonly [number, number])[] = [
  [4, -8], // top tip
  [4, -4],
  [8, -4], // upper-right tip
  [4, 0],
  [4, 4], // lower-right tip
  [0, 4],
  [-4, 8], // bottom tip
  [-4, 4],
  [-8, 4], // lower-left tip
  [-4, 0],
  [-4, -4], // upper-left tip
  [0, -4],
]
/** Camp outlines, indexed by the seat that must FILL them. */
const GOAL_TRIANGLES: readonly (readonly [number, number][])[] = [
  [
    [4, -8],
    [4, -5],
    [1, -5],
  ], // z <= -5, seat 0's goal
  [
    [-4, 8],
    [-4, 5],
    [-1, 5],
  ], // z >= 5, seat 1's goal
]

/** The frame is whatever `render()` returned — declared loosely and cast. */
interface Frame {
  holes?: number[] // flat [x0, z0, x1, z1, ...]
  pegs?: number[] // per hole: -1 empty, else seat
  side?: number
  ply?: number
  status?: string
  winner?: string | null
  lastPath?: number[]
  remaining?: number[]
  span?: number
  seats?: string[]
}

// —— identity ————————————————————————————————————————————————————————

let players: PlayerInfo[] = []

const monogramUri = (name: string, color: string): string => {
  const ch = (name.trim()[0] ?? '?').toUpperCase()
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44">` +
    `<rect width="44" height="44" rx="22" fill="${color}"/>` +
    `<text x="22" y="30" font-family="system-ui,sans-serif" font-size="20" font-weight="600" ` +
    `fill="#fff" text-anchor="middle">${ch}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

// —— dom ——————————————————————————————————————————————————————————————

interface SeatCard {
  root: HTMLDivElement
  avatar: HTMLImageElement
  name: HTMLSpanElement
  detail: HTMLSpanElement
  bar: HTMLDivElement
  badge: HTMLSpanElement
}

let canvas: HTMLCanvasElement | null = null
let statusLine: HTMLDivElement | null = null
const cards: SeatCard[] = []

function makeSeatCard(seat: number): SeatCard {
  const skin = SEATS[seat]!
  const root = document.createElement('div')
  root.style.cssText =
    `display:flex;align-items:center;gap:10px;padding:7px 13px 7px 8px;border-radius:12px;` +
    `background:${T.surface};border:1px solid ${T.border};min-width:168px;` +
    `transition:border-color .2s,box-shadow .2s`

  const avatar = document.createElement('img')
  avatar.width = 30
  avatar.height = 30
  avatar.style.cssText = `border-radius:50%;display:block;box-shadow:0 0 0 2px ${skin.base}40`
  avatar.src = monogramUri(skin.label, skin.base)

  const stack = document.createElement('div')
  stack.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0;flex:1'

  const nameRow = document.createElement('div')
  nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0'

  const name = document.createElement('span')
  name.style.cssText =
    `font:600 13px ${T.font};color:${T.fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`
  name.textContent = skin.label

  const badge = document.createElement('span')
  badge.style.cssText =
    `display:none;flex:0 0 auto;font:700 9px ${T.font};letter-spacing:.7px;padding:2px 6px;` +
    `border-radius:5px;background:${skin.base};color:#fff`
  badge.textContent = 'WINNER'
  nameRow.append(name, badge)

  const detail = document.createElement('span')
  detail.style.cssText = `font:11px ${T.font};color:${T.fgSubtle}`

  // Progress rail — how much of the race this seat has run.
  const rail = document.createElement('div')
  rail.style.cssText = 'height:3px;border-radius:2px;background:rgba(255,255,255,0.09);overflow:hidden'
  const bar = document.createElement('div')
  bar.style.cssText = `height:100%;width:0%;border-radius:2px;background:${skin.base};transition:width .25s`
  rail.append(bar)

  stack.append(nameRow, detail, rail)
  root.append(avatar, stack)
  return { root, avatar, name, detail, bar, badge }
}

function ensureDom(root: HTMLElement): void {
  if (canvas) return

  document.body.style.margin = '0'

  const shell = document.createElement('div')
  // Fill the host frame exactly, then let the board take whatever the HUD
  // leaves. Without this the star's bottom point is clipped away.
  shell.style.cssText =
    `box-sizing:border-box;height:100vh;display:flex;flex-direction:column;align-items:center;` +
    `gap:8px;padding:10px;font:13px ${T.font};color:${T.fg};overflow:hidden`

  const bar = document.createElement('div')
  bar.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;justify-content:center;flex:0 0 auto'
  for (let seat = 0; seat < 2; seat++) {
    const card = makeSeatCard(seat)
    cards.push(card)
    bar.append(card.root)
  }

  const stage = document.createElement('div')
  stage.style.cssText =
    'flex:1 1 auto;min-height:0;width:100%;display:flex;align-items:center;justify-content:center'

  canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  // Intrinsic aspect is preserved: the browser shrinks to whichever bound bites.
  canvas.style.cssText = 'max-width:100%;max-height:100%;width:auto;height:auto;display:block'
  stage.append(canvas)

  statusLine = document.createElement('div')
  statusLine.style.cssText =
    `flex:0 0 auto;font:12px ${T.font};color:${T.fgSubtle};text-align:center;min-height:16px`

  shell.append(bar, stage, statusLine)
  root.append(shell)
}

/**
 * `activeSeat` overrides who is highlighted. Pass the seat whose peg is in
 * flight while a move animates; pass -1 to fall back to `frame.side`, the seat
 * due to move next.
 */
function renderHud(frame: Frame, activeSeat: number): void {
  const span = frame.span && frame.span > 0 ? frame.span : 1
  for (let seat = 0; seat < 2; seat++) {
    const card = cards[seat]
    const skin = SEATS[seat]
    if (!card || !skin) continue

    const info = players.find((p) => p.seat === seat)
    const label = info?.name ?? frame.seats?.[seat] ?? skin.label
    card.name.textContent = label
    // The CSP here is `img-src data:` — a remote avatar URL would simply fail
    // to load, so anything that is not already inlined becomes a monogram.
    card.avatar.src = info?.avatar?.startsWith('data:') ? info.avatar : monogramUri(label, skin.base)

    const left = frame.remaining?.[seat]
    const moving = activeSeat >= 0 && activeSeat === seat
    const toMove = activeSeat < 0 && frame.status === 'playing' && frame.side === seat
    const tag = moving ? ' · moving' : toMove ? ' · to move' : ''
    card.detail.textContent = left === undefined ? '' : `${left} to go${tag}`
    card.bar.style.width = `${left === undefined ? 0 : Math.round(100 * Math.max(0, 1 - left / span))}%`

    const over = frame.status !== undefined && frame.status !== 'playing'
    const won = over && winnerSeat(frame) === seat
    const lost = over && winnerSeat(frame) >= 0 && !won

    card.badge.style.display = won ? 'inline-block' : 'none'
    card.root.style.opacity = lost ? '0.5' : '1'

    const live = moving || toMove || won
    card.root.style.borderColor = live ? skin.base : T.border
    card.root.style.boxShadow = live ? `0 0 0 1px ${skin.base}55, 0 0 18px ${skin.base}22` : 'none'
  }
}

const nameOf = (frame: Frame, seat: number): string =>
  players.find((p) => p.seat === seat)?.name ?? frame.seats?.[seat] ?? SEATS[seat]?.label ?? '?'

const setStatus = (text: string): void => {
  if (statusLine) statusLine.textContent = text
}

/** Build the status line from structured fields — never parse ids out of text. */
function statusText(frame: Frame): string {
  switch (frame.status) {
    case 'won':
      return `${nameOf(frame, winnerSeat(frame))} got all ten home`
    case 'adjudicated':
      return `step cap reached — ${nameOf(frame, winnerSeat(frame))} led on progress`
    case 'draw':
      return 'step cap reached — dead level'
    default:
      return `${nameOf(frame, frame.side ?? 0)} to move · ply ${frame.ply ?? 0}`
  }
}

/** What the seat currently in flight is doing — shown while the peg animates. */
function moveText(frame: Frame, mover: number, path: number[]): string {
  const hops = path.length - 1
  const [ax, ay] = holeXY(frame, path[0]!)
  const [bx, by] = holeXY(frame, path[1]!)
  // A step covers one hole spacing; a jump covers two.
  const stepped = hops === 1 && Math.hypot(bx - ax, by - ay) < SCALE * 2.2
  const verb = stepped ? 'steps' : hops === 1 ? 'jumps' : `chains ${hops} jumps`
  return `${nameOf(frame, mover)} ${verb} · ply ${frame.ply ?? 0}`
}

// —— board drawing ————————————————————————————————————————————————————

/** Pointy-top axial layout: q = x, r = z. */
const xyOf = (q: number, r: number): [number, number] => [
  CX + SCALE * Math.sqrt(3) * (q + r / 2),
  CY + SCALE * 1.5 * r,
]

const holeXY = (frame: Frame, i: number): [number, number] =>
  xyOf(frame.holes?.[i * 2] ?? 0, frame.holes?.[i * 2 + 1] ?? 0)

/** Trace a cube-space polygon as the current path. */
function outlinePath(g: CanvasRenderingContext2D, verts: readonly (readonly [number, number])[]): void {
  g.beginPath()
  verts.forEach(([q, r], k) => {
    const [x, y] = xyOf(q, r)
    if (k === 0) g.moveTo(x, y)
    else g.lineTo(x, y)
  })
  g.closePath()
}

/**
 * Fill a cube-space polygon, inflated by `pad` with rounded corners. Stroking
 * with a fat round-joined pen is what gives the star its soft points.
 */
function fillShape(
  g: CanvasRenderingContext2D,
  verts: readonly (readonly [number, number])[],
  pad: number,
  fill: string | CanvasGradient,
): void {
  outlinePath(g, verts)
  g.fillStyle = fill
  g.strokeStyle = fill as string
  g.lineJoin = 'round'
  g.lineWidth = pad * 2
  g.stroke()
  g.fill()
}

function disc(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string | CanvasGradient): void {
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  g.fillStyle = fill
  g.fill()
}

/** A glossy marble: radial gradient body, rim shade, specular dot, contact shadow. */
function peg(g: CanvasRenderingContext2D, x: number, y: number, seat: number, lift = 0): void {
  const skin = SEATS[seat] ?? SEATS[0]!
  const r = PEG_R + (lift > 0 ? 0.8 : 0)

  g.save()
  g.beginPath()
  g.ellipse(x, y + r * 0.95 + lift * 0.35, r * (lift > 0 ? 0.7 : 0.86), r * 0.32, 0, 0, Math.PI * 2)
  g.fillStyle = `rgba(0,0,0,${lift > 0 ? 0.34 : 0.46})`
  g.filter = 'blur(1.5px)'
  g.fill()
  g.restore()

  const body = g.createRadialGradient(x - r * 0.34, y - r * 0.4, r * 0.12, x, y, r * 1.05)
  body.addColorStop(0, skin.light)
  body.addColorStop(0.45, skin.base)
  body.addColorStop(1, skin.dark)
  disc(g, x, y, r, body)

  g.beginPath()
  g.arc(x, y, r - 0.5, 0, Math.PI * 2)
  g.strokeStyle = 'rgba(0,0,0,0.28)'
  g.lineWidth = 1
  g.stroke()

  disc(g, x - r * 0.3, y - r * 0.34, r * 0.26, 'rgba(255,255,255,0.55)')
}

/** Which seat the winner id belongs to, or -1 for a draw. */
const winnerSeat = (frame: Frame): number =>
  frame.winner == null ? -1 : frame.seats?.[0] === frame.winner ? 0 : 1

/**
 * Draw the whole board. `skip` holds hole indices the animator owns, and
 * `trail` is the route to trace behind the peg in flight.
 */
function paint(frame: Frame, skip: Set<number>, trail: number[]): void {
  if (!canvas) return
  const g = canvas.getContext('2d')
  if (!g) return
  const count = Math.floor((frame.holes?.length ?? 0) / 2)

  g.fillStyle = T.bg
  g.fillRect(0, 0, W, H)

  // 1. The board itself — without this the pegs just float in the void.
  const surface = g.createLinearGradient(0, 0, 0, H)
  surface.addColorStop(0, '#2b3145')
  surface.addColorStop(0.5, '#212636')
  surface.addColorStop(1, '#171b28')
  g.save()
  g.shadowColor = 'rgba(0,0,0,0.55)'
  g.shadowBlur = 18
  g.shadowOffsetY = 4
  fillShape(g, STAR_OUTLINE, PAD, surface)
  g.restore()

  // A rim light along the edge lifts the board off the background.
  outlinePath(g, STAR_OUTLINE)
  g.strokeStyle = 'rgba(255,255,255,0.13)'
  g.lineJoin = 'round'
  g.lineWidth = PAD * 2 - 1.6
  g.stroke()

  // 2. Goal zones, tinted with the colour of whoever must fill them: blue is
  //    done when the blue zone is blue.
  GOAL_TRIANGLES.forEach((tri, seat) => {
    const skin = SEATS[seat]!
    fillShape(g, tri, PAD - 3, `${skin.tint}0.15)`)
  })

  // 3. Recessed sockets.
  for (let i = 0; i < count; i++) {
    const [x, y] = holeXY(frame, i)
    disc(g, x, y, SOCKET_R, 'rgba(0,0,0,0.45)')
    g.beginPath()
    g.arc(x, y - 0.35, SOCKET_R - 0.4, Math.PI * 1.15, Math.PI * 1.95)
    g.strokeStyle = 'rgba(255,255,255,0.10)'
    g.lineWidth = 1
    g.stroke()
  }

  // 4. The route just travelled.
  if (trail.length > 1) {
    g.beginPath()
    trail.forEach((h, k) => {
      const [x, y] = holeXY(frame, h)
      if (k === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    })
    const seat = frame.pegs?.[trail[trail.length - 1]!] ?? 0
    g.strokeStyle = `${SEATS[seat]?.tint ?? 'rgba(255,255,255,'}0.75)`
    g.lineWidth = 2
    g.lineCap = 'round'
    g.setLineDash([3, 5])
    g.stroke()
    g.setLineDash([])
  }

  // 5. Pegs.
  for (let i = 0; i < count; i++) {
    const seat = frame.pegs?.[i] ?? -1
    if (seat < 0 || skip.has(i)) continue
    const [x, y] = holeXY(frame, i)
    peg(g, x, y, seat)
  }
}

// —— frame handling ————————————————————————————————————————————————————
//
// The SDK owns the queue and the one-at-a-time discipline; a frame that takes
// time says so by returning a promise, which also tells the host when to send
// the next one. What is left here is what is specific to this board.

let shown: Frame | null = null
let lastKey: string | null = null

/** Identifies a position; consecutive frames sharing one are the same move. */
const frameKey = (f: Frame): string =>
  `${f.ply ?? -1}|${f.status ?? ''}|${(f.lastPath ?? []).join(',')}`

function draw(raw: unknown, root: HTMLElement): void | Promise<void> {
  ensureDom(root)
  if (!canvas) return
  const frame = raw as Frame
  // The host's replay timer clamps at the last index and then re-posts that
  // frame forever (see replayFrames in the SDK). Taking it at face value would
  // replay the winning move on a loop, so identical repeats are dropped. They
  // are still acked (by returning), so a host waiting on us is not left hanging.
  const key = frameKey(frame)
  if (key === lastKey) return
  lastKey = key

  const path = frame.lastPath ?? []

  // First frame, a pass, or a rewind — snap rather than animate.
  if (!shown || path.length < 2) {
    shown = frame
    renderHud(frame, -1)
    setStatus(statusText(frame))
    paint(frame, new Set(), [])
    return
  }

  // A frame carries `lastPath` (the move just made) but `side` (whoever is due
  // next). While the peg is in flight the HUD must follow the seat that owns
  // it, or the highlight reads as the wrong player for the whole animation.
  const mover = frame.pegs?.[path[path.length - 1]!] ?? 0
  renderHud(frame, mover)
  setStatus(moveText(frame, mover, path))
  return animate(frame, path)
}

function animate(frame: Frame, path: number[]): Promise<void> {
  const g = canvas?.getContext('2d')
  if (!g) return Promise.resolve()
  const dest = path[path.length - 1]!
  const seat = frame.pegs?.[dest] ?? 0
  const skip = new Set<number>([dest])
  const legs = path.length - 1
  const total = (legs * HOP_MS) / playbackSpeed()
  const jumping = legs > 1 || path.length > 2
  let started = -1

  return new Promise<void>((resolve) => {
    const tick = (now: number): void => {
      if (started < 0) started = now
      const t = Math.min(1, (now - started) / total)

      // Which leg we are on, and how far along it.
      const walked = t * legs
      const leg = Math.min(legs - 1, Math.floor(walked))
      const u = walked - leg
      const [ax, ay] = holeXY(frame, path[leg]!)
      const [bx, by] = holeXY(frame, path[leg + 1]!)
      const ease = u * u * (3 - 2 * u) // smoothstep within the leg
      const x = ax + (bx - ax) * ease
      const y = ay + (by - ay) * ease
      // A jump arcs over the peg it clears; a single step slides flat.
      const lift = jumping ? Math.sin(Math.PI * ease) * SCALE * 0.55 : 0

      paint(frame, skip, path.slice(0, leg + 2))
      peg(g, x, y - lift, seat, lift)

      if (t < 1) {
        requestAnimationFrame(tick)
        return
      }
      // The peg has landed: hand the highlight over to whoever is due next.
      shown = frame
      paint(frame, new Set(), path)
      renderHud(frame, -1)
      setStatus(statusText(frame))
      void hold(HOLD_MS).then(resolve)
    }

    requestAnimationFrame(tick)
  })
}

// —— wiring ——————————————————————————————————————————————————————————

// A hop chain's length varies per move, so this pace is the common case (a
// single hop plus the dwell) rather than a bound — the promise above is what
// actually tells the host when each move has landed.
onFrame(draw, { paceMs: HOP_MS + HOLD_MS })

// Identity can arrive before or after the frames; refresh whatever is on screen.
onPlayers((p) => {
  players = p
  if (shown) renderHud(shown, -1)
})
