/**
 * Doudizhu author view (T2) — runs in a sandboxed Arena iframe. Draws a clean
 * three-seat card table from the game's viewer-scoped `render(state, ctx)` frames.
 *
 * Layout: the anchor seat sits at the bottom, the other two at top-left / top-right.
 * Each seat shows avatar · name · 👑(landlord) and a SINGLE stacked card with the
 * remaining count ("N left"); an empty hand shows nothing but a 🏆 tag. Whatever a
 * seat played this trick is laid out IN FRONT of that seat (facing the table
 * centre); a pass shows a "Pass" chip. The centre holds the stake multiplier and,
 * once revealed, the bottom cards.
 *
 * Hands stay hidden per the game's hidden-info contract (the frame only reveals
 * the viewer's own hand, which we still render as a single stack for a tidy table).
 * Identity (name/avatar) arrives via `onPlayers`; author logic never sees it.
 */
import { dwell, onFrame, onPlayers } from '@arena/game-sdk/view'
import type { PlayerInfo } from '@arena/game-sdk'

interface SeatView {
  seat: number
  role: string
  count: number
  isLandlord: boolean
  isTurn: boolean
  won?: boolean // set once the game is over: winning side = true, losing = false
  isFinisher?: boolean // the player who played the last card
  played?: number[]
  passed?: boolean
  hand?: number[]
}
interface DouFrame {
  phase?: string
  turn?: number
  landlord?: number
  multiplier?: number
  table?: { seat: number; cards: number[] } | null // current top play (present even in pre-`trick` states)
  bottom?: { cards: number[]; revealed: boolean }
  seats?: SeatView[]
  panels?: Array<{ type: string; text?: string }>
}

const LABELS: Record<number, string> = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: 'SJ', 17: 'BJ',
}
const rankLabel = (r: number): string => LABELS[r] ?? String(r)
const SUITS = ['♠', '♥', '♣', '♦'] // spade / heart / club / diamond
const suitRed = (s: number): boolean => s === 1 || s === 3 // ♥ ♦ are red

/**
 * Suits are cosmetic in Doudizhu (logic ignores them), so we assign one per card
 * deterministically. Using `(rank + copyIndex) % 4` means different ranks get
 * different suits (so a hand isn't all spades) while the copies of one rank still
 * differ — a bomb shows all four suits, a pair two. Jokers get none.
 */
function faces(cards: number[]): Array<{ rank: number; suit?: number }> {
  const occ = new Map<number, number>()
  return [...cards]
    .sort((a, b) => a - b)
    .map((r) => {
      if (r >= 16) return { rank: r } // joker: no suit
      const k = occ.get(r) ?? 0
      occ.set(r, k + 1)
      return { rank: r, suit: (r + k) % 4 }
    })
}

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
let lastFrame: DouFrame | null = null

const nameOf = (seat: number): string => players.find((p) => p.seat === seat)?.name ?? `Seat ${seat}`
const avatarOf = (seat: number): string => {
  const a = players.find((p) => p.seat === seat)?.avatar
  return a && a.length > 0 ? a : monogramUri(nameOf(seat))
}

const CARD_W = 34
const CARD_H = 48

/** A playing card with a top-left index (rank+suit) so it stays readable when fanned. */
function faceCard(rank: number, suit?: number): HTMLDivElement {
  const el = document.createElement('div')
  const joker = rank >= 16
  const red = joker ? rank === 17 : suit !== undefined && suitRed(suit)
  el.style.cssText =
    `position:relative;width:${CARD_W}px;height:${CARD_H}px;flex:none;border-radius:6px;background:#fff;` +
    `color:${red ? '#dc2626' : '#111827'};border:1px solid #cbd5e1;box-shadow:0 1px 3px rgba(0,0,0,.4);overflow:hidden`
  if (joker) {
    const c = document.createElement('div')
    c.textContent = rank === 16 ? 'SJ' : 'BJ'
    c.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:800 13px system-ui'
    el.appendChild(c)
    return el
  }
  // A single top-left index (rank over suit) — clean and readable even when fanned.
  const idx = document.createElement('div')
  idx.style.cssText = 'position:absolute;top:3px;left:5px;display:flex;flex-direction:column;align-items:center;line-height:1.05'
  const r = document.createElement('span')
  r.textContent = rankLabel(rank)
  r.style.cssText = 'font:800 14px system-ui'
  const s = document.createElement('span')
  s.textContent = suit !== undefined ? SUITS[suit]! : ''
  s.style.cssText = 'font:13px system-ui'
  idx.appendChild(r)
  idx.appendChild(s)
  el.appendChild(idx)
  return el
}

/** Lay cards in a single fanned row, overlapping as needed to fit `maxWidth`. */
function cardFan(cards: number[], maxWidth: number): HTMLDivElement {
  const row = document.createElement('div')
  row.style.cssText = 'display:inline-flex;align-items:center'
  const fs = faces(cards)
  const n = fs.length
  const full = CARD_W + 4 // ideal spacing when there's room
  const step = n <= 1 ? full : Math.min(full, (maxWidth - CARD_W) / (n - 1))
  fs.forEach((f, i) => {
    const c = faceCard(f.rank, f.suit)
    if (i > 0) c.style.marginLeft = `${step - CARD_W}px` // negative → overlap
    row.appendChild(c)
  })
  return row
}

function playedRow(played: number[] | undefined, passed: boolean | undefined, maxWidth: number): HTMLDivElement {
  const row = document.createElement('div')
  row.style.cssText = 'display:flex;justify-content:center;align-items:center;min-height:48px'
  if (played && played.length > 0) {
    row.appendChild(cardFan(played, maxWidth))
  } else if (passed) {
    const chip = document.createElement('span')
    chip.textContent = 'Pass'
    chip.style.cssText = 'font:12px system-ui;color:#94a3b8;background:rgba(0,0,0,.45);padding:3px 8px;border-radius:8px'
    row.appendChild(chip)
  }
  return row
}

/** What to lay on the table in front of a seat. Once the game is over, reveal the
 *  seat's remaining hand (losers' leftover cards). Otherwise prefer this trick's
 *  `trick` data, falling back to the current top play for pre-`trick` states. */
function actionOf(sv: SeatView, f: DouFrame): { played?: number[]; passed?: boolean } {
  if (f.phase === 'done' && sv.hand && sv.hand.length > 0) return { played: sv.hand }
  if (sv.played && sv.played.length > 0) return { played: sv.played }
  if (sv.passed) return { passed: true }
  if (f.table && f.table.seat === sv.seat && f.table.cards.length > 0) return { played: f.table.cards }
  return {}
}

/** A player badge that sits at the table edge: avatar (turn ring + 👑) · name · "N left". */
function playerBadge(sv: SeatView): HTMLDivElement {
  const box = document.createElement('div')
  box.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;width:78px;text-align:center'
  // Avatar in a relative wrapper so the end-of-game result can overlay it as a
  // nameplate — that way it never grows the column or collides with the cards.
  const avWrap = document.createElement('div')
  avWrap.style.cssText = 'position:relative;width:42px;height:42px'
  const img = document.createElement('img')
  img.src = avatarOf(sv.seat)
  img.width = 42
  img.height = 42
  img.alt = ''
  img.style.cssText =
    'width:42px;height:42px;border-radius:50%;object-fit:cover;background:#0b0b0f;' +
    `outline:${sv.isTurn ? '3px solid #22c55e' : '3px solid rgba(255,255,255,.12)'};outline-offset:2px`
  avWrap.appendChild(img)
  if (sv.won !== undefined) {
    const res = document.createElement('div')
    res.textContent = sv.won ? 'WIN' : 'LOSE'
    res.style.cssText =
      'position:absolute;bottom:0;left:50%;transform:translateX(-50%);white-space:nowrap;' +
      'font:800 10px system-ui;padding:1px 6px;border-radius:8px;border:1px solid rgba(0,0,0,.55);' +
      (sv.won ? 'color:#052e16;background:#22c55e' : 'color:#e5e7eb;background:#4b5563')
    avWrap.appendChild(res)
  }
  const nm = document.createElement('div')
  nm.textContent = (sv.isLandlord ? '👑 ' : '') + nameOf(sv.seat)
  nm.style.cssText =
    'font:600 12px system-ui;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:78px'
  const cnt = document.createElement('div')
  cnt.textContent = sv.count > 0 ? `${sv.count} left` : '🏆' // finisher emptied their hand → 🏆
  cnt.style.cssText = 'font:11px system-ui;color:#e2e8f0;background:rgba(0,0,0,.45);padding:1px 7px;border-radius:9px'
  box.appendChild(avWrap)
  box.appendChild(nm)
  box.appendChild(cnt)
  return box
}

/** The stuff sitting in the middle of the felt: stake multiplier + bottom cards. */
function tableCenter(f: DouFrame): HTMLDivElement {
  const c = document.createElement('div')
  c.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center'
  const stake = document.createElement('div')
  stake.textContent = `×${f.multiplier ?? 0}`
  stake.style.cssText = 'font:800 20px system-ui;color:#fcd34d;text-shadow:0 1px 2px rgba(0,0,0,.5)'
  c.appendChild(stake)
  if (f.bottom?.revealed && f.bottom.cards.length > 0) {
    const brow = document.createElement('div')
    brow.style.cssText = 'display:flex;align-items:center;gap:5px;justify-content:center;flex-wrap:wrap'
    const lbl = document.createElement('span')
    lbl.textContent = 'Bottom'
    lbl.style.cssText = 'font:11px system-ui;color:#d1d5db'
    brow.appendChild(lbl)
    brow.appendChild(cardFan(f.bottom.cards, 200))
    c.appendChild(brow)
  }
  return c
}

function ensureRoot(h: HTMLElement): HTMLElement {
  if (!root) {
    host = h
    host.innerHTML = ''
    root = document.createElement('div')
    root.style.cssText = 'padding:12px;max-width:560px;margin:0 auto'
    host.appendChild(root)
  }
  return root
}

function humanize(text: string): string {
  let out = text
  for (const p of players) out = out.split(`Seat ${p.seat}`).join(p.name)
  return out
}

const at = (el: HTMLElement, css: string): HTMLElement => {
  el.style.cssText += ';position:absolute;' + css
  return el
}

function draw(): void {
  if (!root || !lastFrame) return
  const f = lastFrame
  const seats = f.seats ?? []
  if (seats.length < 3) return
  const me = seats.find((s) => Array.isArray(s.hand))?.seat ?? 0 // spectator anchors on seat 0
  const [oppL, oppR] = seats.filter((s) => s.seat !== me).sort((a, b) => a.seat - b.seat)
  const mine = seats.find((s) => s.seat === me)!

  root.innerHTML = ''

  // The table stage: a felt oval with three seats around it.
  const stage = document.createElement('div')
  stage.style.cssText = 'position:relative;width:100%;max-width:560px;height:440px;margin:0 auto'

  const felt = document.createElement('div')
  felt.style.cssText =
    'position:absolute;top:72px;left:14px;right:14px;bottom:96px;border-radius:48%/42%;' +
    'background:radial-gradient(ellipse at center,#1f7a45,#14532d);border:8px solid #6b4423;' +
    'box-shadow:inset 0 0 34px rgba(0,0,0,.45),0 6px 18px rgba(0,0,0,.55)'
  stage.appendChild(felt)

  // Centre of the felt: stake + bottom cards.
  stage.appendChild(at(tableCenter(f), 'top:42%;left:50%;transform:translate(-50%,-50%);max-width:70%'))

  // Seats around the table edge.
  stage.appendChild(at(playerBadge(oppL!), 'top:2px;left:3%'))
  stage.appendChild(at(playerBadge(oppR!), 'top:2px;right:3%'))
  stage.appendChild(at(playerBadge(mine), 'bottom:0;left:50%;transform:translateX(-50%)'))

  // Cards each seat played this trick, laid on the table in front of them.
  const aL = actionOf(oppL!, f)
  const aR = actionOf(oppR!, f)
  const aM = actionOf(mine, f)
  stage.appendChild(at(playedRow(aL.played, aL.passed, 210), 'top:86px;left:5%'))
  stage.appendChild(at(playedRow(aR.played, aR.passed, 210), 'top:86px;right:5%'))
  stage.appendChild(at(playedRow(aM.played, aM.passed, 480), 'bottom:90px;left:50%;transform:translateX(-50%)'))

  root.appendChild(stage)

  // Status line.
  const status = document.createElement('div')
  status.textContent = humanize(f.panels?.find((p) => p.type === 'status')?.text ?? '')
  status.style.cssText = 'font:13px system-ui;color:#cbd5e1;text-align:center;min-height:16px;margin-top:6px'
  root.appendChild(status)
}

// —— playback pacing ——
// The platform controls when it pushes frames; on replay it may push the whole
// match in at once, which flashes by. Each play stays up for HOLD_MS, and the
// SDK holds the next frame until then — which is also what tells the host we are
// ready for it, so a host that waits never builds a backlog.
//
// This used to buffer and drain on its own timer, and only held a frame when
// something was already queued behind it. Under a host that sends one frame at a
// time there is never anything queued, so that version would have stopped
// pausing on each play altogether.
const HOLD_MS = 1700 // minimum time each step (a play / pass / bid) is shown

onFrame((frame, h) => {
  ensureRoot(h)
  lastFrame = frame as DouFrame
  draw()
  return dwell(HOLD_MS)
}, { paceMs: HOLD_MS })
onPlayers((p) => {
  players = p
  draw() // identity applies immediately to the current frame
})
