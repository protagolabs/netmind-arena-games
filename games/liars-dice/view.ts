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
import { hold, onFrame, onPlayers } from '@arena/game-sdk/view'
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

// —— responsive metrics ——
// Dice keep their size at every width — a narrow screen buys room by STACKING
// the cup, not by shrinking it. The binding constraint is the top row: two
// stations sit side by side, so each gets at most half the stage, and whatever
// doesn't fit on one line there moves to a second (or third) line.
const DIE = 34 // px
const GAP = 5 // px between dice
const ROW_MAX = 5 * DIE + 4 * GAP // a full cup of 5 on one line
let TOP_MAX = ROW_MAX // width budget for each top station
let CENTER_MAX = 220 // width cap for the standing-bid / reveal block

function measure(stageW: number): void {
  // -14 keeps a visible gutter between the two top cups instead of letting them
  // meet in the middle at phone widths.
  TOP_MAX = Math.max(DIE, Math.min(ROW_MAX, Math.floor(stageW / 2) - 14))
  CENTER_MAX = Math.min(220, Math.max(160, stageW - 48))
}

/**
 * How to break `n` dice across lines inside `avail` px — balanced, not greedy:
 * a cup of 5 that can't fit on one line reads better as 3+2 than as 4+1. Rows
 * are ordered widest-first, and the count per row never exceeds what fits.
 */
function diceLines(n: number, avail: number): number[] {
  const perRow = Math.max(1, Math.min(5, Math.floor((avail + GAP) / (DIE + GAP))))
  const rows = Math.max(1, Math.ceil(n / perRow))
  const lines: number[] = []
  let left = n
  for (let r = rows; r > 0; r--) {
    const take = Math.ceil(left / r) // widest row first, then even out
    lines.push(take)
    left -= take
  }
  return lines
}

/** How many lines a seat's cup will take at `avail` — drives the stage height. */
function cupLines(sv: SeatView, f: DiceFrame, avail: number): number {
  const faces = f.reveal ? (f.reveal.dice[sv.seat] ?? null) : (sv.dice ?? null)
  const n = faces ? faces.length : sv.count
  return n <= 1 ? 1 : diceLines(n, avail).length
}

// —— dice rendering ——
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

/**
 * One seat's cup. `faces` (open cup) → pips; otherwise `count` face-down dice.
 * `avail` is how much width this station has, and decides how the cup stacks.
 */
function diceRow(
  sv: SeatView,
  faces: number[] | null,
  bidFace: number | null,
  isLoser: boolean,
  avail: number,
): HTMLDivElement {
  const box = document.createElement('div')
  box.style.cssText = `display:flex;flex-direction:column;gap:${GAP}px;align-items:center;min-height:${DIE + 6}px`
  if (sv.count === 0 && !faces) {
    const out = document.createElement('span')
    out.textContent = '☠ out'
    out.style.cssText = `font:600 12px ${T.font};color:${T.fgSubtle};line-height:${DIE + 6}px`
    box.appendChild(out)
    return box
  }
  // Build every die once, then deal them into balanced lines.
  const dice: HTMLDivElement[] = faces
    ? faces.map((f) => {
        const counts = bidFace !== null && (f === bidFace || (f === 1 && bidFace !== 1))
        const hl = counts ? (f === 1 && bidFace !== 1 ? 'wild' : 'match') : undefined
        return die(f, { dim: isLoser, highlight: hl })
      })
    : Array.from({ length: sv.count }, () => die(0, { faceDown: true }))
  let i = 0
  for (const n of diceLines(dice.length, avail)) {
    const line = document.createElement('div')
    line.style.cssText = `display:flex;gap:${GAP}px;justify-content:center;align-items:center`
    for (let k = 0; k < n; k++) line.appendChild(dice[i++]!)
    box.appendChild(line)
  }
  return box
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

/**
 * A seat station = badge + its dice, stacked. `order`: badge above dice or
 * below. `avail` is the width this station may use, which sets how its cup wraps.
 */
function station(sv: SeatView, f: DiceFrame, order: 'badge-top' | 'dice-top', avail: number): HTMLDivElement {
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px'
  const rev = f.reveal
  const faces = rev ? (rev.dice[sv.seat] ?? null) : (sv.dice ?? null)
  const bidFace = rev ? rev.bid.face : null
  const isLoser = !!rev && rev.loser === sv.seat
  const b = badge(sv)
  const chip = actionChip(sv, f)
  const d = diceRow(sv, faces, bidFace, isLoser, avail)
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
  c.style.cssText =
    `display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;max-width:${CENTER_MAX}px`

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
    // Sizes are baked in at draw time, so a rotation / pane resize has to redraw.
    let pending = 0
    addEventListener('resize', () => {
      if (pending) return
      pending = requestAnimationFrame(() => {
        pending = 0
        draw()
      })
    })
  }
  return root
}

const at = (el: HTMLElement, css: string): HTMLElement => {
  el.style.cssText += ';position:absolute;' + css
  return el
}

/**
 * Centre horizontally by spanning the stage, NOT by `left:50%;transform`. An
 * absolutely positioned box shrink-to-fits against the room from its `left` edge
 * to the containing block's right edge — `left:50%` caps it at HALF the stage,
 * and the transform comes too late to help. On a phone that squeezed the anchor
 * seat's cup to ~183px and stacked it even though the stage had room for one line.
 */
const centred = (el: HTMLElement): HTMLElement => {
  const box = document.createElement('div')
  box.style.cssText = 'display:flex;justify-content:center'
  box.appendChild(el)
  return box
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

  // Size everything off the stage's real width (root is padded 12px a side).
  const stageW = Math.min(600, Math.max(200, (root.clientWidth || 624) - 24))
  measure(stageW)

  root.innerHTML = ''

  // A stacked cup makes its station taller — the top ones grow down toward the
  // felt, the anchor grows up. The stage height is FIXED (the platform hands the
  // view a 560px iframe; growing it just clips the status line), so the felt
  // gives the room up instead: it flattens by exactly the overflow, and the
  // centre rides with it. A 3+2 or 2+2+1 cup then never lands on the bid.
  const botAvail = stageW - 16
  const LINE = DIE + GAP
  const extraTop = (Math.max(oppL ? cupLines(oppL, f, TOP_MAX) : 1, oppR ? cupLines(oppR, f, TOP_MAX) : 1) - 1) * LINE
  const extraBot = (cupLines(mine, f, botAvail) - 1) * LINE

  const stage = document.createElement('div')
  stage.style.cssText = 'position:relative;width:100%;max-width:600px;height:460px;margin:0 auto'

  const felt = document.createElement('div')
  felt.style.cssText =
    `position:absolute;top:${96 + extraTop}px;left:16px;right:16px;bottom:${104 + extraBot}px;border-radius:48%/44%;` +
    `background:radial-gradient(ellipse at center,#241a2e,#0b0b0f);border:8px solid #3a2b1e;` +
    `box-shadow:inset 0 0 40px rgba(0,0,0,.6),0 8px 22px rgba(0,0,0,.6)`
  stage.appendChild(felt)

  // 212px sits a touch above the felt's midpoint; keep that relation as it moves.
  stage.appendChild(
    at(centred(center(f)), `top:${212 + Math.round((extraTop - extraBot) / 2)}px;left:0;right:0;transform:translateY(-50%)`),
  )

  // Two opponents across the top, the anchor seat at the bottom. Each top
  // station only gets half the stage, so on a phone its cup stacks (5 → 3+2)
  // instead of the two of them colliding. The anchor seat has the full width.
  if (oppL) stage.appendChild(at(station(oppL, f, 'badge-top', TOP_MAX), `top:0;left:2%`))
  if (oppR) stage.appendChild(at(station(oppR, f, 'badge-top', TOP_MAX), `top:0;right:2%`))
  stage.appendChild(at(centred(station(mine, f, 'dice-top', botAvail)), 'bottom:0;left:0;right:0'))

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

onFrame((frame, h) => {
  ensureRoot(h)
  const f = frame as DiceFrame
  lastFrame = f
  draw()
  // A reveal is the moment the whole game turns on, and it needs far longer than
  // an ordinary bid. The SDK reports each frame as finished only when this
  // resolves, so a host that waits gives the cups time to open instead of
  // pushing the next bid over the top of them.
  return hold(f.reveal ? REVEAL_MS : HOLD_MS)
}, { paceMs: HOLD_MS })
onPlayers((p) => {
  players = p
  draw() // identity applies immediately to the current frame
})
