/**
 * Connect Four — turn-based, deterministic, perfect-information reference game.
 *
 * State exposes `side` (0|1) = seat to move next, and `players` = [agentId0,
 * agentId1] in join order. `reduce` is responsible for validating the actor —
 * the engine does NOT auto-check whose turn it is.
 */
import { defineGame, type Action, type Ctx } from '@arena/game-sdk'

const COLS = 7
const ROWS = 6
const WIN = 4

type Cell = 0 | 1 | 2 // 0 empty, 1 = seat0's disc, 2 = seat1's disc

interface State {
  board: Cell[] // COLS*ROWS, row-major, y=0 is the BOTTOM row
  players: [string, string]
  side: 0 | 1
  status: 'playing' | 'won' | 'draw'
  winner?: string
  moves: number
  lastCol: number | null
}

function idx(x: number, y: number): number {
  return y * COLS + x
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < COLS && y >= 0 && y < ROWS
}

/** Lowest empty row in column x, or -1 if full. */
function dropRow(board: Cell[], x: number): number {
  for (let y = 0; y < ROWS; y++) if (board[idx(x, y)] === 0) return y
  return -1
}

function checkWin(board: Cell[], x: number, y: number, who: Cell): boolean {
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ]
  for (const [dx, dy] of dirs) {
    let count = 1
    for (const sign of [1, -1]) {
      let cx = x + dx * sign
      let cy = y + dy * sign
      while (inBounds(cx, cy) && board[idx(cx, cy)] === who) {
        count++
        cx += dx * sign
        cy += dy * sign
      }
    }
    if (count >= WIN) return true
  }
  return false
}

export default defineGame<State, Record<string, never>>({
  meta: {
    type: 'connect-four',
    players: { min: 2, max: 2 },
    pace: 'turn-based',
    turnTimeoutSec: 60,
    maxSteps: COLS * ROWS,
  },

  init: (cfg): State => ({
    board: new Array(COLS * ROWS).fill(0) as Cell[],
    players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
    side: 0,
    status: 'playing',
    moves: 0,
    lastCol: null,
  }),

  // Weak heuristic so `pnpm sim` / `pnpm preview` can self-play without a
  // --script file (AGENTS.md §3). Not used by real matches (turn-based agents
  // submit their own moves via `reduce`); only used for local dev tooling.
  play: (s, _p, ctx): Action => {
    const legal: number[] = []
    for (let x = 0; x < COLS; x++) if (dropRow(s.board, x) >= 0) legal.push(x)
    const col = legal[Math.floor(ctx.random() * legal.length)]
    return { col }
  },

  reduce: (s, action, ctx: Ctx): State => {
    if (s.status !== 'playing') ctx.reject('game-over')
    if (ctx.actor !== s.players[s.side]) ctx.reject('not-your-turn')
    const { col } = action as { col: number }
    if (typeof col !== 'number' || !Number.isInteger(col) || col < 0 || col >= COLS) {
      ctx.reject('out-of-bounds')
    }
    const y = dropRow(s.board, col)
    if (y < 0) ctx.reject('column-full')

    const who: Cell = s.side === 0 ? 1 : 2
    const board = s.board.slice()
    board[idx(col, y)] = who
    const moves = s.moves + 1
    const won = checkWin(board, col, y, who)
    return {
      ...s,
      board,
      moves,
      lastCol: col,
      side: (s.side ^ 1) as 0 | 1,
      status: won ? 'won' : moves === COLS * ROWS ? 'draw' : 'playing',
      winner: won ? s.players[s.side] : s.winner,
    }
  },

  terminal: (s) =>
    s.status === 'won'
      ? { done: true, winner: s.winner ?? null }
      : s.status === 'draw'
        ? { done: true, winner: null }
        : { done: false },

  score: (s): Record<string, number> => {
    if (s.status === 'won' && s.winner) {
      const loser = s.players.find((p) => p !== s.winner) ?? s.players[1]
      return { [s.winner]: 1, [loser]: 0 }
    }
    return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
  },

  render: (s) => {
    const cells: Cell[][] = []
    for (let y = ROWS - 1; y >= 0; y--) {
      const row: Cell[] = []
      for (let x = 0; x < COLS; x++) row.push(s.board[idx(x, y)])
      cells.push(row)
    }
    const status =
      s.status === 'playing'
        ? `${s.moves} moves · seat ${s.side} to move`
        : s.status === 'won'
          ? `Winner: ${s.winner}`
          : 'Draw'
    return {
      layout: 'board' as const,
      board: { cols: COLS, rows: ROWS, cells, topology: 'grid' as const },
      panels: [{ type: 'status' as const, text: status }],
    }
  },
})
