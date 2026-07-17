/**
 * Liar's Dice author view (T2) — runs in a sandboxed Arena iframe. Draws a
 * three-seat dice table from the game's viewer-scoped `render(state, ctx)` frames.
 *
 * Layout: the anchor seat sits at the bottom, the other two at top-left / top-
 * right. Each seat shows avatar (turn ring · 👑 winner) · name · its dice. A cup
 * whose faces the frame reveals (the viewer's own, or everyone once the game is
 * over) shows real pips; a hidden cup shows that many face-down dice.
 *
 * The centre holds the standing bid ("N × ⚄", with the bidder's name) and the
 * round. When a challenge has just resolved, the frame carries a `reveal`: we open
 * every cup from that snapshot, highlight the dice that counted (the bid face plus
 * wild 1s), and announce who lost / was eliminated.
 *
 * Hidden info stays hidden per the game's contract — the frame only reveals the
 * viewer's own cup mid-game. Identity (name/avatar) arrives via `onPlayers`;
 * author logic never sees it.
 */
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import type { PlayerInfo } from '@arena/game-sdk'
import { ARENA_THEME as T } from '@arena/game-sdk/theme'

interface SeatView {
  seat: number
  alive: boolean
  count: number
  isTurn: boolean
  isWinner: boolean
  dice?: number[] // present only when this cup is revealed to the viewer / at game end
}
interface Reveal {
  challenger: number
  bidder: number
  bid: { count: number; face: number }
  actual: number
  dice: number[][] // opened cups (public)
  loser: number
  eliminated: number | null
}
interface DiceFrame {
  phase?: string
  round?: number
  turn?: number
  bidder?: number
  bid?: { count: number; face: number } | null
  lastBid?: Array<{ count: number; face: number } | null> // seat → their latest bid this round
  reveal?: Reveal | null
  seats?: SeatView[]
  panels?: Array<{ type: string; text?: string }>
}

// —— identity helpers (mirrors the other example games) ——
function monogramUri(label: string): string {
  let h = 0
  for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) >>> 0
  const hue = h % 360
  const initials = (label.match(/[a-z0-9]/gi)?.slice(0, 2).join('') || '?').toUpperCase()
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
    `<rect width="64" height="64" rx="14" fill="hsl(${hue},55%,42%)"/>` +
    `<text x="32" y="43" font-family="system-ui,sans-serif" font-size="27" font-weight="600" fill="#fff" text-anchor="middle">${initials}</text>` +
    `</svg>`
  return 'data:image/svg+xml,' + encodeURIComponent(svg)
}

let host: HTMLElement | null = null
let root: HTMLElement | null = null
let players: PlayerInfo[] = []

const nameOf = (seat: number): string => players.find((p) => p.seat === seat)?.name ?? `Seat ${seat}`
const avatarOf = (seat: number): string => {
  const a = players.find((p) => p.seat === seat)?.avatar
  return a && a.length > 0 ? a : monogramUri(nameOf(seat))
}
const humanize = (text: string): string => {
  let out = text
  for (const p of players) out = out.split(`Seat ${p.seat}`).join(p.name)
  return out
}

// —— dice rendering ——
const DIE = 34 // px
// Pip positions on a 3×3 grid (index 0..8, row-major) per face 1..6.
const PIPS: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}

/** One die. `highlight`: 'match' = counted for the bid, 'wild' = a counting 1. */
function die(face: number, opts: { faceDown?: boolean; dim?: boolean; highlight?: 'match' | 'wild' } = {}): HTMLDivElement {
  const el = document.createElement('div')
  const base =
    `position:relative;width:${DIE}px;height:${DIE}px;flex:none;border-radius:8px;box-sizing:border-box;` +
    `box-shadow:0 2px 6px rgba(0,0,0,.55);` // trailing ';' matters — the next chunk is concatenated on
  if (opts.faceDown) {
    // A face-down cup: clearly "hidden", legible on both the black bg and the felt.
    el.style.cssText =
      base +
      `background:linear-gradient(145deg,#5a4a6e,#3a2f49);border:1.5px solid rgba(255,255,255,.35);` +
      `display:flex;align-items:center;justify-content:center`
    const q = document.createElement('div')
    q.textContent = '?'
    q.style.cssText = `font:800 17px ${T.font};color:#e6ddf2;opacity:.9`
    el.appendChild(q)
    return el
  }
  // Face-up dice are bright white with solid black pips so the count is obvious.
  // A counting die is ringed: red for the bid face, gold for a wild 1.
  const ring =
    opts.highlight === 'match'
      ? `border:2.5px solid ${T.accent};box-shadow:0 0 12px ${T.accent},0 2px 6px rgba(0,0,0,.55)`
      : opts.highlight === 'wild'
        ? `border:2.5px solid #f5b301;box-shadow:0 0 12px rgba(245,179,1,.9),0 2px 6px rgba(0,0,0,.55)`
        : `border:1.5px solid #64748b`
  el.style.cssText =
    base +
    `background:${opts.dim ? '#8b93a1' : '#ffffff'};${ring};` +
    `display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);padding:5px`
  const on = new Set(PIPS[face] ?? [])
  const wildPip = opts.highlight === 'wild' && face === 1
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('div')
    cell.style.cssText = 'display:flex;align-items:center;justify-content:center'
    if (on.has(i)) {
      const dot = document.createElement('div')
      dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${wildPip ? '#b45309' : '#0b0b0f'}`
      cell.appendChild(dot)
    }
    el.appendChild(cell)
  }
  return el
}

/** A row of dice for a seat. `faces` (open cups) → pips; otherwise `count` cups. */
function diceRow(sv: SeatView, faces: number[] | null, bidFace: number | null, isLoser: boolean): HTMLDivElement {
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;gap:5px;justify-content:center;align-items:center;min-height:40px;flex-wrap:wrap;max-width:220px'
  if (sv.count === 0 && !faces) {
    const out = document.createElement('span')
    out.textContent = '☠ out'
    out.style.cssText = `font:600 12px ${T.font};color:${T.fgSubtle}`
    row.appendChild(out)
    return row
  }
  if (faces) {
    for (const f of faces) {
      const counts = bidFace !== null && (f === bidFace || (f === 1 && bidFace !== 1))
      const hl = counts ? (f === 1 && bidFace !== 1 ? 'wild' : 'match') : undefined
      row.appendChild(die(f, { dim: isLoser, highlight: hl }))
    }
  } else {
    for (let i = 0; i < sv.count; i++) row.appendChild(die(0, { faceDown: true }))
  }
  return row
}

/** A pill under a seat showing what that player last did this round. */
function actionChip(sv: SeatView, f: DiceFrame): HTMLDivElement {
  const chip = document.createElement('div')
  const lb = f.lastBid?.[sv.seat] ?? null
  const isStanding = f.bidder === sv.seat && !!f.bid // this seat owns the current top bid
  const revChallenger = f.reveal && f.reveal.challenger === sv.seat
  let text: string
  let css: string
  if (revChallenger) {
    text = '“Liar!”'
    css = `color:${T.accentFg};background:${T.accent}`
  } else if (lb) {
    text = `bid ${lb.count} × ${lb.face}`
    css = isStanding ? `color:#111;background:#f5b301;font-weight:700` : `color:${T.fg};background:rgba(255,255,255,.10)`
  } else if (sv.isTurn) {
    text = 'thinking…'
    css = `color:${T.accent};background:rgba(229,72,77,.14)`
  } else {
    text = '·'
    css = `color:${T.fgSubtle};background:transparent`
  }
  chip.textContent = text
  chip.style.cssText = `font:600 11px ${T.font};padding:2px 9px;border-radius:9px;white-space:nowrap;${css}`
  return chip
}

/** Avatar · name · "N dice" badge for one seat. */
function badge(sv: SeatView): HTMLDivElement {
  const box = document.createElement('div')
  box.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;width:88px;text-align:center'
  const avWrap = document.createElement('div')
  avWrap.style.cssText = 'position:relative;width:44px;height:44px'
  const img = document.createElement('img')
  img.src = avatarOf(sv.seat)
  img.width = 44
  img.height = 44
  img.alt = ''
  const ring = sv.isWinner ? '#fcd34d' : sv.isTurn ? T.accent : 'rgba(255,255,255,.12)'
  img.style.cssText =
    `width:44px;height:44px;border-radius:50%;object-fit:cover;background:${T.bg};` +
    `outline:3px solid ${ring};outline-offset:2px;` +
    (sv.alive ? '' : 'filter:grayscale(1) opacity(.5)')
  avWrap.appendChild(img)
  if (sv.isWinner) {
    const crown = document.createElement('div')
    crown.textContent = '👑'
    crown.style.cssText = 'position:absolute;top:-14px;left:50%;transform:translateX(-50%);font-size:18px'
    avWrap.appendChild(crown)
  }
  const nm = document.createElement('div')
  nm.textContent = nameOf(sv.seat)
  nm.style.cssText = `font:600 12px ${T.font};color:${T.fg};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:88px`
  const cnt = document.createElement('div')
  cnt.textContent = sv.count > 0 ? `${sv.count} dice` : 'eliminated'
  cnt.style.cssText = `font:11px ${T.font};color:${T.fg};background:rgba(0,0,0,.4);padding:1px 8px;border-radius:9px`
  box.appendChild(avWrap)
  box.appendChild(nm)
  box.appendChild(cnt)
  return box
}

/** A seat station = badge + its dice, stacked. `order`: badge above dice or below. */
function station(sv: SeatView, f: DiceFrame, order: 'badge-top' | 'dice-top'): HTMLDivElement {
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px'
  const rev = f.reveal
  const faces = rev ? (rev.dice[sv.seat] ?? null) : (sv.dice ?? null)
  const bidFace = rev ? rev.bid.face : null
  const isLoser = !!rev && rev.loser === sv.seat
  const b = badge(sv)
  const chip = actionChip(sv, f)
  const d = diceRow(sv, faces, bidFace, isLoser)
  // Chip always sits next to the avatar; dice sit toward the felt centre.
  if (order === 'badge-top') {
    wrap.appendChild(b)
    wrap.appendChild(chip)
    wrap.appendChild(d)
  } else {
    wrap.appendChild(d)
    wrap.appendChild(chip)
    wrap.appendChild(b)
  }
  return wrap
}

/** The centre of the felt: the standing bid, or the just-resolved challenge. */
function center(f: DiceFrame): HTMLDivElement {
  const c = document.createElement('div')
  c.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;max-width:220px'

  const round = document.createElement('div')
  round.textContent = `Round ${f.round ?? 1}`
  round.style.cssText = `font:600 11px ${T.font};color:${T.fgSubtle};letter-spacing:.08em;text-transform:uppercase`
  c.appendChild(round)

  if (f.reveal) {
    const r = f.reveal
    const title = document.createElement('div')
    title.textContent = 'LIAR?'
    title.style.cssText = `font:800 22px ${T.font};color:${T.accent};text-shadow:0 1px 3px rgba(0,0,0,.6)`
    c.appendChild(title)
    const claim = document.createElement('div')
    claim.textContent = `${nameOf(r.bidder)} bid ${r.bid.count} × ${r.bid.face}`
    claim.style.cssText = `font:13px ${T.font};color:${T.fg}`
    c.appendChild(claim)
    const found = document.createElement('div')
    found.textContent = `actually ${r.actual} on the table`
    found.style.cssText = `font:600 13px ${T.font};color:${r.actual >= r.bid.count ? '#22c55e' : T.accent}`
    c.appendChild(found)
    const verdict = document.createElement('div')
    verdict.textContent = r.eliminated !== null ? `${nameOf(r.loser)} loses last die — OUT` : `${nameOf(r.loser)} loses a die`
    verdict.style.cssText =
      `font:700 12px ${T.font};color:${T.accentFg};background:${T.accent};padding:3px 10px;border-radius:9px`
    c.appendChild(verdict)
    return c
  }

  if (f.bid) {
    const big = document.createElement('div')
    big.style.cssText = 'display:flex;align-items:center;gap:8px'
    const n = document.createElement('span')
    n.textContent = `${f.bid.count} ×`
    n.style.cssText = `font:800 26px ${T.font};color:${T.fg}`
    big.appendChild(n)
    big.appendChild(die(f.bid.face))
    c.appendChild(big)
    const who = document.createElement('div')
    who.textContent = `${nameOf(f.bidder ?? 0)} bids`
    who.style.cssText = `font:12px ${T.font};color:${T.fgSubtle}`
    c.appendChild(who)
  } else if (f.phase !== 'done') {
    const open = document.createElement('div')
    open.textContent = `${nameOf(f.turn ?? 0)} opens the round`
    open.style.cssText = `font:13px ${T.font};color:${T.fgSubtle}`
    c.appendChild(open)
  }
  return c
}

function ensureRoot(h: HTMLElement): HTMLElement {
  if (!root) {
    host = h
    host.innerHTML = ''
    host.style.background = T.bg
    root = document.createElement('div')
    root.style.cssText = `padding:12px;max-width:600px;margin:0 auto;font-family:${T.font}`
    host.appendChild(root)
  }
  return root
}

const at = (el: HTMLElement, css: string): HTMLElement => {
  el.style.cssText += ';position:absolute;' + css
  return el
}

let lastFrame: DiceFrame | null = null

function draw(): void {
  if (!root || !lastFrame) return
  const f = lastFrame
  const seats = f.seats ?? []
  if (seats.length < 3) return
  // Anchor: the viewer's own cup (only seat with revealed dice mid-game) sits at
  // the bottom; a spectator (no revealed cup) anchors on seat 0.
  const me = f.reveal ? 0 : seats.find((s) => Array.isArray(s.dice))?.seat ?? 0
  const others = seats.filter((s) => s.seat !== me).sort((a, b) => a.seat - b.seat)
  const [oppL, oppR] = others
  const mine = seats.find((s) => s.seat === me)!

  root.innerHTML = ''

  const stage = document.createElement('div')
  stage.style.cssText = 'position:relative;width:100%;max-width:600px;height:460px;margin:0 auto'

  const felt = document.createElement('div')
  felt.style.cssText =
    `position:absolute;top:96px;left:16px;right:16px;bottom:104px;border-radius:48%/44%;` +
    `background:radial-gradient(ellipse at center,#241a2e,#0b0b0f);border:8px solid #3a2b1e;` +
    `box-shadow:inset 0 0 40px rgba(0,0,0,.6),0 8px 22px rgba(0,0,0,.6)`
  stage.appendChild(felt)

  stage.appendChild(at(center(f), 'top:46%;left:50%;transform:translate(-50%,-50%)'))

  // Two opponents across the top, the anchor seat at the bottom.
  if (oppL) stage.appendChild(at(station(oppL, f, 'badge-top'), 'top:0;left:2%'))
  if (oppR) stage.appendChild(at(station(oppR, f, 'badge-top'), 'top:0;right:2%'))
  stage.appendChild(at(station(mine, f, 'dice-top'), 'bottom:0;left:50%;transform:translateX(-50%)'))

  root.appendChild(stage)

  const status = document.createElement('div')
  status.textContent = humanize(f.panels?.find((p) => p.type === 'status')?.text ?? '')
  status.style.cssText = `font:13px ${T.font};color:${T.fgSubtle};text-align:center;min-height:16px;margin-top:6px`
  root.appendChild(status)
}

// —— playback pacing ——
// On an ended replay the host posts frames back-to-back (~1s apart), which reads
// too fast to follow. We buffer them and drain ONE frame per HOLD_MS on our own
// timer, so each bid/challenge lingers no matter how quickly frames arrive; a
// reveal frame holds longer so the open-cup moment lands. A live match (frames
// far apart) still draws immediately, because the drain idles once the queue
// empties and restarts on the next arrival.
const HOLD_MS = 2400 // minimum time a bid / turn frame stays on screen
const REVEAL_MS = 6500 // the open-cup "LIAR?" reveal lingers so the result really lands
const frameQueue: DiceFrame[] = []
let draining = false

function drainNext(): void {
  const frame = frameQueue.shift()
  if (!frame) {
    draining = false // queue empty → go idle; the next arrival restarts the drain
    return
  }
  lastFrame = frame
  draw()
  setTimeout(drainNext, frame.reveal ? REVEAL_MS : HOLD_MS)
}

onFrame((frame, h) => {
  ensureRoot(h)
  frameQueue.push(frame as DiceFrame)
  if (!draining) {
    draining = true
    drainNext() // draws this frame now, then paces the rest
  }
})
onPlayers((p) => {
  players = p
  draw() // identity applies immediately to the current frame
})
