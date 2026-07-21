/**
 * Battleship (simplified) — 2-player, hidden-information, turn-based.
 *
 * Each side has a 5x5 sea with three ships (1x1, 1x3, 2x2 = 8 cells), placed
 * automatically at `init` via a seeded random enumeration (no placement phase
 * / no retry-loop risk — every candidate position is enumerated and filtered
 * for overlap, then one is picked with `ctx.random()`).
 *
 * Hidden info (`meta.hiddenInfo`): `render(state, ctx)` is viewer-scoped. A
 * player's own ships are never secret to them; an opponent's un-hit ship
 * cells are ALWAYS masked to look like plain water, for every viewer
 * (including the no-viewer public/spectator frame).
 *
 * Design note: T1's RenderSpec has a single `board` field, so both seas can't
 * be drawn as two full grids in one frame without a custom T2 view. This
 * simplified version renders the board the viewer is currently firing at
 * (masked), plus a scoreboard panel with both sides' remaining ship-cell
 * counts (public-safe — it never reveals cell positions).
 */
import { defineGame, type Action, type Ctx, type RenderCtx, type RenderSpec } from '@arena/game-sdk'

const SIZE = 5
type Cell = 0 | 1 | 2 | 3 // 0 water(untouched) | 1 ship(intact,SECRET) | 2 ship(hit) | 3 water(miss)

interface State {
  players: [string, string]
  side: 0 | 1
  boards: [Cell[], Cell[]] // boards[i] = seat i's OWN sea (their ships + shots fired at them)
  hitsRemaining: [number, number] // un-hit ship cells left on boards[i]; starts at 8
  status: 'playing' | 'won'
  winner?: string
  moves: number
  lastShot: { x: number; y: number; hit: boolean } | null
}

const idx = (x: number, y: number): number => y * SIZE + x

function allPlacements2x2(): number[][] {
  const out: number[][] = []
  for (let y = 0; y <= SIZE - 2; y++) {
    for (let x = 0; x <= SIZE - 2; x++) {
      out.push([idx(x, y), idx(x + 1, y), idx(x, y + 1), idx(x + 1, y + 1)])
    }
  }
  return out
}

function allPlacements1x3(): number[][] {
  const out: number[][] = []
  for (let y = 0; y < SIZE; y++) for (let x = 0; x <= SIZE - 3; x++) out.push([idx(x, y), idx(x + 1, y), idx(x + 2, y)])
  for (let x = 0; x < SIZE; x++) for (let y = 0; y <= SIZE - 3; y++) out.push([idx(x, y), idx(x, y + 1), idx(x, y + 2)])
  return out
}

function allPlacements1x1(): number[][] {
  const out: number[][] = []
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) out.push([idx(x, y)])
  return out
}

/** Place all 3 ships on an empty 5x5 board. Deterministic given ctx.random(). */
function placeOneBoard(ctx: Ctx): Cell[] {
  const board: Cell[] = new Array(SIZE * SIZE).fill(0) as Cell[]
  const pickAndOccupy = (candidates: number[][]): void => {
    const valid = candidates.filter((cells) => cells.every((c) => board[c] === 0))
    const pick = valid[Math.floor(ctx.random() * valid.length)]!
    for (const c of pick) board[c] = 1
  }
  pickAndOccupy(allPlacements2x2()) // biggest first
  pickAndOccupy(allPlacements1x3())
  pickAndOccupy(allPlacements1x1())
  return board
}

/** Mask a board for an external viewer: un-hit ships (1) look like water (0). */
function maskBoard(board: Cell[]): Cell[] {
  return board.map((c) => (c === 1 ? 0 : c)) as Cell[]
}

export default defineGame<State, Record<string, never>>({
  meta: {
    type: 'battleship',
    players: { min: 2, max: 2 },
    pace: 'turn-based',
    turnTimeoutSec: 60,
    maxSteps: 50,
    hiddenInfo: true,
  },

  init: (cfg, ctx): State => ({
    players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
    side: 0,
    boards: [placeOneBoard(ctx), placeOneBoard(ctx)],
    hitsRemaining: [8, 8],
    status: 'playing',
    moves: 0,
    lastShot: null,
  }),

  // Weak heuristic for `pnpm sim` / `pnpm preview` self-play only — fires at a
  // random not-yet-targeted cell on the opponent's board.
  play: (s, _p, ctx): Action => {
    const targetIdx = s.side === 0 ? 1 : 0
    const board = s.boards[targetIdx]!
    const legal: number[] = []
    for (let i = 0; i < board.length; i++) if (board[i] === 0 || board[i] === 1) legal.push(i)
    const cell = legal[Math.floor(ctx.random() * legal.length)]!
    return { x: cell % SIZE, y: Math.floor(cell / SIZE) }
  },

  reduce: (s, action, ctx: Ctx): State => {
    if (s.status !== 'playing') ctx.reject('game-over')
    if (ctx.actor !== s.players[s.side]) ctx.reject('not-your-turn')
    const { x, y } = action as { x: number; y: number }
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE) {
      ctx.reject('out-of-bounds')
    }
    const targetIdx = s.side === 0 ? 1 : 0
    const cellIdx = idx(x, y)
    const cell = s.boards[targetIdx]![cellIdx]
    if (cell === 2 || cell === 3) ctx.reject('already-targeted')

    const hit = cell === 1
    const boards: [Cell[], Cell[]] = [s.boards[0].slice() as Cell[], s.boards[1].slice() as Cell[]]
    boards[targetIdx]![cellIdx] = hit ? 2 : 3
    const hitsRemaining: [number, number] = [...s.hitsRemaining]
    if (hit) hitsRemaining[targetIdx] -= 1
    const won = hitsRemaining[targetIdx] === 0

    return {
      ...s,
      boards,
      hitsRemaining,
      moves: s.moves + 1,
      lastShot: { x, y, hit },
      side: won ? s.side : ((s.side ^ 1) as 0 | 1),
      status: won ? 'won' : 'playing',
      winner: won ? s.players[s.side] : s.winner,
    }
  },

  terminal: (s) => (s.status === 'won' ? { done: true, winner: s.winner ?? null } : { done: false }),

  score: (s): Record<string, number> => {
    if (s.status === 'won' && s.winner) {
      const loser = s.players.find((p) => p !== s.winner) ?? s.players[1]
      return { [s.winner]: 1, [loser]: 0 }
    }
    return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
  },

  render: (s, ctx?: RenderCtx): RenderSpec => {
    const viewer = ctx?.viewer
    const viewerSeat = s.players.indexOf(viewer ?? '')
    // Show the board the viewer is firing at (their opponent's), masked.
    // No-viewer / non-participant viewer defaults to seat 0's target (boards[1]).
    const targetIdx = viewerSeat === 1 ? 0 : 1
    const masked = maskBoard(s.boards[targetIdx]!)
    const cells: number[][] = []
    for (let y = SIZE - 1; y >= 0; y--) {
      const row: number[] = []
      for (let x = 0; x < SIZE; x++) row.push(masked[idx(x, y)]!)
      cells.push(row)
    }
    const status = s.status === 'won' ? `Winner: ${s.winner}` : `${s.moves} shots · seat ${s.side} to fire`
    return {
      layout: 'board',
      board: {
        cols: SIZE,
        rows: SIZE,
        cells,
        palette: { 0: '#1e3a5f', 2: '#dc2626', 3: '#94a3b8' },
        topology: 'grid',
      },
      panels: [
        {
          type: 'scoreboard',
          rows: [
            { label: s.players[0], value: `${s.hitsRemaining[0]}/8 ships left` },
            { label: s.players[1], value: `${s.hitsRemaining[1]}/8 ships left` },
          ],
        },
        { type: 'status', text: status },
      ],
    }
  },
})

export type { State }
