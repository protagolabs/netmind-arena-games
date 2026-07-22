/**
 * Gomoku (five-in-a-row) — reference Arena custom game.
 *
 * Supports BOTH paces from one definition:
 *  - strategy   : each side submits knobs (aggression/defense/centerBias/threatDepth);
 *                 the deterministic `play` heuristic plays out the whole match.
 *  - turn-based : each agent submits an actual move {x,y} via `reduce`.
 *
 * State exposes `side` (0|1) = index of the seat to move next — the SDK convention
 * the engine uses to route params (strategy). For turn-based, `reduce` itself is
 * responsible for validating `ctx.actor` against it (the engine does NOT).
 */
import { defineGame, type Action, type Ctx } from '@arena/game-sdk'

const N = 15
type Cell = 0 | 1 | 2 // 0 empty, 1 black, 2 white

interface State {
  board: Cell[][]
  players: [string, string]
  // `players[i]` is always seat i (join order) — the engine routes strategy params
  // by seat, and `reduce` validates turn actors against it, so this MUST stay
  // aligned with seat index.
  // `black` is the seat that holds Black, chosen by the seeded coin flip; it is
  // NOT always seat 0. Black moves first, so a match opens with `side === black`.
  black: 0 | 1
  side: 0 | 1
  status: 'playing' | 'won' | 'draw'
  winner?: string
  moves: number
  lastMove?: { x: number; y: number }
}

interface Params {
  aggression: number
  defense: number
  centerBias: number
  threatDepth: number
}

// Colour of the stone the given seat places: Black (1) if that seat holds Black,
// else White (2). Driven by `black`, NOT by seat index — so the coin flip decides
// who is Black, matching the published rules.
const colorOf = (side: 0 | 1, black: 0 | 1): Cell => (side === black ? 1 : 2)
const inBounds = (x: number, y: number): boolean => x >= 0 && x < N && y >= 0 && y < N
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]

/** Longest run of `color` through (x,y) if a `color` stone were placed there. */
function runThrough(board: Cell[][], x: number, y: number, color: Cell): number {
  let best = 1
  for (const [dx, dy] of DIRS) {
    let count = 1
    for (const sgn of [1, -1]) {
      let cx = x + dx * sgn
      let cy = y + dy * sgn
      while (inBounds(cx, cy) && board[cy]![cx] === color) {
        count++
        cx += dx * sgn
        cy += dy * sgn
      }
    }
    if (count > best) best = count
  }
  return best
}

function wins(board: Cell[][], x: number, y: number, color: Cell): boolean {
  return runThrough(board, x, y, color) >= 5
}

function emptyBoard(): Cell[][] {
  return Array.from({ length: N }, () => Array<Cell>(N).fill(0))
}

/** Place a stone for `side` at (x,y), returning the next state. Pure. */
function place(state: State, x: number, y: number): State {
  const board = state.board.map((r) => [...r]) as Cell[][]
  const color = colorOf(state.side, state.black)
  board[y]![x] = color
  const won = wins(board, x, y, color)
  const moves = state.moves + 1
  return {
    ...state,
    board,
    moves,
    lastMove: { x, y },
    side: (state.side ^ 1) as 0 | 1,
    status: won ? 'won' : moves === N * N ? 'draw' : 'playing',
    winner: won ? state.players[state.side] : state.winner,
  }
}

export default defineGame<State, Params>({
  meta: {
    type: 'gomoku',
    players: { min: 2, max: 2 },
    pace: 'strategy',
    paces: ['strategy', 'turn-based'],
    submitWindowSec: 600,
    turnTimeoutSec: 60,
    maxSteps: N * N,
    bestOf: 2,
  },

  params: {
    aggression: { min: 0, max: 1, default: 0.5 },
    defense: { min: 0, max: 1, default: 0.5 },
    centerBias: { min: 0, max: 1, default: 0.3 },
    threatDepth: { min: 1, max: 3, default: 2 },
  },

  init: (cfg, ctx): State => {
    // Seeded coin flip picks which SEAT is Black (fair first-move advantage). Black
    // always moves first, so `side` opens equal to `black` — this matches the rules
    // ("Black moves first, chosen by a seeded coin flip") without swapping the
    // seat-aligned `players` array.
    const black: 0 | 1 = ctx.random() < 0.5 ? 0 : 1
    return {
      board: emptyBoard(),
      players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
      black,
      side: black,
      status: 'playing',
      moves: 0,
    }
  },

  // —— strategy pace ——
  play: (s, p, ctx): Action => {
    const mine = colorOf(s.side, s.black)
    const opp: Cell = mine === 1 ? 2 : 1
    const c = (N - 1) / 2
    const maxDist = Math.hypot(c, c)
    let best = { x: c, y: c }
    let bestV = -Infinity
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (s.board[y]![x] !== 0) continue
        const atk = Math.pow(runThrough(s.board, x, y, mine), p.threatDepth)
        const def = Math.pow(runThrough(s.board, x, y, opp), p.threatDepth)
        const ctr = 1 - Math.hypot(x - c, y - c) / maxDist
        const v = atk * p.aggression + def * p.defense + ctr * p.centerBias + ctx.random() * 1e-9
        if (v > bestV) {
          bestV = v
          best = { x, y }
        }
      }
    }
    return best
  },

  apply: (s, action): State => {
    const { x, y } = action as { x: number; y: number }
    return place(s, x, y)
  },

  terminal: (s) =>
    s.status === 'won'
      ? { done: true, winner: s.winner ?? null }
      : s.status === 'draw'
        ? { done: true, winner: null }
        : { done: false },

  // —— turn-based pace ——
  reduce: (s, action, ctx: Ctx): State => {
    if (s.status !== 'playing') ctx.reject('game-over')
    if (ctx.actor !== s.players[s.side]) ctx.reject('not-your-turn')
    const { x, y } = action as { x: number; y: number }
    if (!Number.isInteger(x) || !Number.isInteger(y) || !inBounds(x, y)) ctx.reject('out-of-bounds')
    if (s.board[y]![x] !== 0) ctx.reject('cell-occupied')
    return place(s, x, y)
  },

  // —— common ——
  score: (s): Record<string, number> => {
    if (s.status === 'won' && s.winner) {
      const loser = s.players.find((p) => p !== s.winner) ?? s.players[1]
      return { [s.winner]: 1, [loser]: 0 }
    }
    return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
  },

  render: (s) => ({
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
          { label: 'Black', value: s.players[s.black] },
          { label: 'White', value: s.players[s.black ^ 1] },
        ],
      },
      {
        type: 'status' as const,
        text:
          s.status === 'playing'
            ? `${s.moves} moves · ${s.side === s.black ? 'Black' : 'White'} to move`
            : s.status === 'won'
              ? `Winner: ${s.winner}`
              : 'Draw',
      },
    ],
  }),
})
