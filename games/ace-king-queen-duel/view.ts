/**
 * Ace King Queen Duel author view (T2) — runs in a sandboxed Arena iframe and
 * draws each frame the platform posts in. Frames are this game's `render(state)`
 * output: `{ round, done, scores, played, roundResults, panels }` (see game.ts).
 *
 * Draws three round columns, each a face-off of two card faces (A/K/Q) stacked
 * vertically. A card not yet revealed (this round hasn't happened yet, or the
 * opponent hasn't played their side of it yet) shows a face-down "?" back —
 * the frame itself never contains an unrevealed card, so there's nothing to
 * accidentally leak here.
 */
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import { ARENA_THEME } from '@arena/game-sdk/theme'
import type { PlayerInfo } from '@arena/game-sdk'

type Card = 'A' | 'K' | 'Q'

interface RoundResult {
  a: Card
  b: Card
  winner: 0 | 1 | null
}

interface Frame {
  round: number
  done: boolean
  scores: [number, number]
  played: [Card[], Card[]]
  roundResults: RoundResult[]
}

let players: PlayerInfo[] = []
let lastFrame: Frame | null = null

let header: HTMLDivElement | null = null
let table: HTMLDivElement | null = null
let footer: HTMLDivElement | null = null

function ensureDom(root: HTMLElement): void {
  if (table) return
  root.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.style.cssText = `display:flex;flex-direction:column;gap:18px;padding:20px;background:${ARENA_THEME.bg};font-family:${ARENA_THEME.font};color:${ARENA_THEME.fg}`
  header = document.createElement('div')
  header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;font-size:14px;font-weight:600'
  table = document.createElement('div')
  table.style.cssText = 'display:flex;justify-content:center;gap:28px'
  footer = document.createElement('div')
  footer.style.cssText = `text-align:center;font-size:13px;color:${ARENA_THEME.fgSubtle}`
  wrap.append(header, table, footer)
  root.appendChild(wrap)
}

/** One playing-card face (or a face-down back when `card` is null). */
function cardEl(card: Card | null, state: 'win' | 'lose' | 'tie' | 'plain'): HTMLDivElement {
  const el = document.createElement('div')
  const known = card !== null
  const border = state === 'win' ? ARENA_THEME.accent : state === 'tie' ? ARENA_THEME.fgSubtle : ARENA_THEME.border
  el.style.cssText = `
    width:56px;height:80px;border-radius:8px;
    display:flex;align-items:center;justify-content:center;
    font-size:30px;font-weight:700;line-height:1;
    background:${known ? '#f8f5ec' : ARENA_THEME.surface};
    color:${known ? '#1c1917' : ARENA_THEME.fgSubtle};
    border:2px solid ${border};
    opacity:${state === 'lose' ? 0.55 : 1};
    box-shadow:${state === 'win' ? `0 0 12px ${ARENA_THEME.accent}` : 'none'};
    transition:opacity 120ms ease;
  `
  el.textContent = known ? card : '?'
  return el
}

function roundColumn(idx: number, frame: Frame): HTMLDivElement {
  const col = document.createElement('div')
  col.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px'

  const label = document.createElement('div')
  label.style.cssText = `font-size:12px;color:${ARENA_THEME.fgSubtle}`
  label.textContent = `Round ${idx + 1}`
  col.appendChild(label)

  const result = frame.roundResults[idx] ?? null
  const aCard = frame.played[0][idx] ?? null
  const bCard = frame.played[1][idx] ?? null
  const aState = result ? (result.winner === 0 ? 'win' : result.winner === null ? 'tie' : 'lose') : 'plain'
  const bState = result ? (result.winner === 1 ? 'win' : result.winner === null ? 'tie' : 'lose') : 'plain'

  const stack = document.createElement('div')
  stack.style.cssText = 'display:flex;flex-direction:column;gap:6px;align-items:center'
  stack.appendChild(cardEl(aCard, aState))
  const vs = document.createElement('div')
  vs.style.cssText = `font-size:11px;color:${ARENA_THEME.fgSubtle}`
  vs.textContent = 'vs'
  stack.appendChild(vs)
  stack.appendChild(cardEl(bCard, bState))
  col.appendChild(stack)

  const tag = document.createElement('div')
  tag.style.cssText = `font-size:11px;min-height:14px;color:${ARENA_THEME.fgSubtle}`
  tag.textContent = result ? (result.winner === null ? 'Tie +1 / +1' : 'Winner +2') : ''
  col.appendChild(tag)

  return col
}

function playerName(seat: 0 | 1): string {
  return players.find((p) => p.seat === seat)?.name ?? `Player ${seat + 1}`
}

function draw(): void {
  if (!lastFrame || !header || !table || !footer) return
  const f = lastFrame

  header.innerHTML = ''
  const left = document.createElement('span')
  left.textContent = `${playerName(0)} — ${f.scores[0]}`
  const right = document.createElement('span')
  right.textContent = `${playerName(1)} — ${f.scores[1]}`
  header.append(left, right)

  table.innerHTML = ''
  for (let i = 0; i < 3; i++) table.appendChild(roundColumn(i, f))

  footer.textContent = f.done
    ? f.scores[0] === f.scores[1]
      ? 'Draw — 3 / 3'
      : `${f.scores[0] > f.scores[1] ? playerName(0) : playerName(1)} wins`
    : `Round ${f.round + 1} of 3`
}

onFrame((frame, root) => {
  ensureDom(root)
  lastFrame = frame as Frame
  draw()
})

onPlayers((p) => {
  players = p
  draw()
})
