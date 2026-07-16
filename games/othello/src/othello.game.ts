/**
 * Othello / Reversi — an Arena custom game.
 *
 * Two players place discs on an 8×8 board. A legal move must FLANK at least one
 * straight line of opponent discs (bracketed by one of your own); every flanked
 * disc flips to your colour. Most discs at the end wins.
 *
 * Supports BOTH paces from one definition:
 *  - strategy   : each side submits knobs (positional/corner/mobility/greedy);
 *                 the deterministic `play` heuristic plays out the whole match.
 *  - turn-based : each agent submits an actual move {x,y} via `reduce`.
 *
 * Passing is implicit: after every move, `side` is advanced to whichever seat
 * still has a legal move. If neither side can move, the game is over — so agents
 * never submit a "pass"; the seat to move always has something to play.
 *
 * State exposes `side` (0|1) = index of the seat to move next — the SDK
 * convention the engine reads to route params (strategy) / validate the actor
 * (turn-based).
 */
import { defineGame, type Action, type Ctx } from '@arena/game-sdk'

const N = 8
type Cell = 0 | 1 | 2 // 0 empty, 1 black (seat 0), 2 white (seat 1)

interface State {
  board: Cell[][]
  players: [string, string] // opaque agent ids; display names/avatars are the view's job (onPlayers)
  side: 0 | 1
  status: 'playing' | 'done'
  moves: number
  lastMove?: { x: number; y: number }
}

interface Params {
  positional: number // trust the static square-weight table
  corner: number // extra value on the four corners
  mobility: number // value having more moves than the opponent
  greedy: number // value raw disc count (usually good only late)
}

const colorOf = (side: 0 | 1): Cell => (side === 0 ? 1 : 2)
const oppColor = (c: Cell): Cell => (c === 1 ? 2 : 1)
const inBounds = (x: number, y: number): boolean => x >= 0 && x < N && y >= 0 && y < N

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

// Classic positional weights: corners are gold, the squares next to them are
// poison (they hand the opponent a corner), edges are mildly good.
const WEIGHTS: ReadonlyArray<ReadonlyArray<number>> = [
  [100, -20, 10, 5, 5, 10, -20, 100],
  [-20, -50, -2, -2, -2, -2, -50, -20],
  [10, -2, -1, -1, -1, -1, -2, 10],
  [5, -2, -1, -1, -1, -1, -2, 5],
  [5, -2, -1, -1, -1, -1, -2, 5],
  [10, -2, -1, -1, -1, -1, -2, 10],
  [-20, -50, -2, -2, -2, -2, -50, -20],
  [100, -20, 10, 5, 5, 10, -20, 100],
]
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, N - 1],
  [N - 1, 0],
  [N - 1, N - 1],
]

/** Discs that would flip if `color` were played at (x,y); empty ⇒ illegal move. */
function flips(board: Cell[][], x: number, y: number, color: Cell): Array<[number, number]> {
  if (board[y]![x] !== 0) return []
  const opp = oppColor(color)
  const out: Array<[number, number]> = []
  for (const [dx, dy] of DIRS) {
    const line: Array<[number, number]> = []
    let cx = x + dx
    let cy = y + dy
    while (inBounds(cx, cy) && board[cy]![cx] === opp) {
      line.push([cx, cy])
      cx += dx
      cy += dy
    }
    // bracketed by one of our own discs (and at least one opp in between)
    if (line.length > 0 && inBounds(cx, cy) && board[cy]![cx] === color) {
      for (const p of line) out.push(p)
    }
  }
  return out
}

/** All legal (x,y) placements for `color`, each with the discs it would flip. */
function legalMoves(board: Cell[][], color: Cell): Array<{ x: number; y: number; flips: Array<[number, number]> }> {
  const res: Array<{ x: number; y: number; flips: Array<[number, number]> }> = []
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (board[y]![x] !== 0) continue
      const f = flips(board, x, y, color)
      if (f.length > 0) res.push({ x, y, flips: f })
    }
  }
  return res
}

function hasMove(board: Cell[][], color: Cell): boolean {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (board[y]![x] === 0 && flips(board, x, y, color).length > 0) return true
    }
  }
  return false
}

function count(board: Cell[][], color: Cell): number {
  let n = 0
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (board[y]![x] === color) n++
  return n
}

function weightSum(board: Cell[][], color: Cell): number {
  let s = 0
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (board[y]![x] === color) s += WEIGHTS[y]![x]!
  return s
}

function cornerCount(board: Cell[][], color: Cell): number {
  let n = 0
  for (const [x, y] of CORNERS) if (board[y]![x] === color) n++
  return n
}

function emptyBoard(): Cell[][] {
  return Array.from({ length: N }, () => Array<Cell>(N).fill(0))
}

function startBoard(): Cell[][] {
  const b = emptyBoard()
  const m = N / 2 // 4
  b[m - 1]![m - 1] = 2 // white
  b[m - 1]![m] = 1 // black
  b[m]![m - 1] = 1 // black
  b[m]![m] = 2 // white
  return b
}

/** Place a disc for `side` at (x,y), flip the flanked discs, advance the turn. Pure. */
function place(state: State, x: number, y: number, toFlip: Array<[number, number]>): State {
  const color = colorOf(state.side)
  const board = state.board.map((r) => [...r]) as Cell[][]
  board[y]![x] = color
  for (const [fx, fy] of toFlip) board[fy]![fx] = color

  const other = (state.side ^ 1) as 0 | 1
  // Implicit pass: hand the turn to whoever can actually move.
  let side = state.side
  let status: State['status'] = 'playing'
  if (hasMove(board, colorOf(other))) side = other
  else if (hasMove(board, colorOf(state.side))) side = state.side // opponent passes
  else status = 'done' // neither can move → game over

  return { ...state, board, moves: state.moves + 1, lastMove: { x, y }, side, status }
}

export default defineGame<State, Params>({
  meta: {
    type: 'othello',
    players: { min: 2, max: 2 },
    pace: 'strategy',
    paces: ['strategy', 'turn-based'],
    submitWindowSec: 600,
    turnTimeoutSec: 60,
    maxSteps: N * N, // ≤ 60 real placements; N*N is a safe cap
    bestOf: 2,
  },

  params: {
    positional: { min: 0, max: 1, default: 0.6 },
    corner: { min: 0, max: 1, default: 0.8 },
    mobility: { min: 0, max: 1, default: 0.5 },
    greedy: { min: 0, max: 1, default: 0.1 },
  },

  init: (cfg): State => ({
    board: startBoard(),
    players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
    side: 0, // black always has legal moves from the symmetric opening; bestOf:2 swaps seats for fairness
    status: 'playing',
    moves: 0,
  }),

  // —— strategy pace ——
  play: (s, p, ctx: Ctx): Action => {
    const mine = colorOf(s.side)
    const opp = oppColor(mine)
    const moves = legalMoves(s.board, mine)
    // Invariant: while playing, the side to move always has ≥1 legal move.
    let best = { x: moves[0]!.x, y: moves[0]!.y }
    let bestV = -Infinity
    for (const m of moves) {
      const nb = s.board.map((r) => [...r]) as Cell[][]
      nb[m.y]![m.x] = mine
      for (const [fx, fy] of m.flips) nb[fy]![fx] = mine
      const posV = weightSum(nb, mine) - weightSum(nb, opp)
      const cornerV = cornerCount(nb, mine) - cornerCount(nb, opp)
      const mobV = moves.length - legalMoves(nb, opp).length
      const discV = count(nb, mine) - count(nb, opp)
      const v =
        p.positional * posV +
        p.corner * 25 * cornerV +
        p.mobility * 5 * mobV +
        p.greedy * discV +
        ctx.random() * 1e-9 // deterministic, seeded tiebreak
      if (v > bestV) {
        bestV = v
        best = { x: m.x, y: m.y }
      }
    }
    return best
  },

  apply: (s, action): State => {
    const { x, y } = action as { x: number; y: number }
    const toFlip = flips(s.board, x, y, colorOf(s.side))
    return place(s, x, y, toFlip)
  },

  terminal: (s) => (s.status === 'done' ? { done: true, winner: winnerOf(s) } : { done: false }),

  // —— turn-based pace ——
  reduce: (s, action, ctx: Ctx): State => {
    if (s.status !== 'playing') ctx.reject('game-over')
    if (ctx.actor !== s.players[s.side]) ctx.reject('not-your-turn')
    const { x, y } = action as { x: number; y: number }
    if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(x, y)) ctx.reject('out-of-bounds')
    if (s.board[y]![x] !== 0) ctx.reject('cell-occupied')
    const toFlip = flips(s.board, x, y, colorOf(s.side))
    if (toFlip.length === 0) ctx.reject('illegal-move') // must flank ≥1 opponent line
    return place(s, x, y, toFlip)
  },

  // —— common ——
  score: (s): Record<string, number> => {
    const w = winnerOf(s)
    if (w === null) return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
    const loser = s.players.find((p) => p !== w) ?? s.players[1]
    return { [w]: 1, [loser]: 0 }
  },

  render: (s) => {
    const black = count(s.board, 1)
    const white = count(s.board, 2)
    return {
      layout: 'board' as const,
      board: {
        cols: N,
        rows: N,
        cells: s.board,
        palette: { 1: '#111827', 2: '#f9fafb' },
        lastMove: s.lastMove,
        topology: 'grid' as const,
      },
      panels: [
        {
          type: 'scoreboard' as const,
          rows: [
            { label: 'Black', value: black },
            { label: 'White', value: white },
          ],
        },
        {
          type: 'status' as const,
          text:
            s.status === 'playing'
              ? `${s.moves} moves · ${s.side === 0 ? 'Black' : 'White'} to move`
              : black === white
                ? `Draw ${black}–${white}`
                : `Winner: ${black > white ? s.players[0] : s.players[1]} (${Math.max(black, white)}–${Math.min(black, white)})`,
        },
      ],
    }
  },
})

/** Winner by disc count once the game is over; `null` = draw. */
function winnerOf(s: State): string | null {
  const black = count(s.board, 1)
  const white = count(s.board, 2)
  if (black === white) return null
  return black > white ? s.players[0] : s.players[1]
}
