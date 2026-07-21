/**
 * Battleship (simplified) — 2-player, hidden-information, turn-based.
 *
 * Two phases:
 *  - 'placing': each seat submits their own ship layout (1x1 + 1x3 + 2x2 = 8
 *    cells) independently, in either order — {action:'turn', parameters:{ships}}
 *    where `ships` is an array of 3 cell-groups, each a list of [x,y] pairs.
 *    Once BOTH have placed, the phase flips to 'playing'.
 *  - 'playing': seats alternate firing at the opponent's sea.
 *
 * Hidden info (`meta.hiddenInfo`): `render(state, ctx)` is viewer-scoped. A
 * player's own ships (placed or not yet placed) are never secret to them; an
 * opponent's un-hit ship cells are ALWAYS masked, for every other viewer
 * (including the no-viewer public/spectator frame) — during BOTH phases.
 *
 * Design note (documented, not hidden): T1's RenderSpec has a single `board`
 * field, so both seas can't be drawn as two full grids without a T2 view.ts.
 * During 'playing' this renders the board the viewer is firing at (masked)
 * plus a scoreboard panel. During 'placing' it renders the viewer's OWN board
 * (so they can confirm their placement); the public/spectator frame shows a
 * neutral empty grid, since neither side's layout is public yet.
 */
import { defineGame, type Action, type Ctx, type RenderCtx, type RenderSpec } from '@arena/game-sdk'

const SIZE = 5
type Cell = 0 | 1 | 2 | 3 // 0 water(untouched) | 1 ship(intact,SECRET) | 2 ship(hit) | 3 water(miss)

interface State {
  players: [string, string]
  phase: 'placing' | 'playing' | 'won'
  side: 0 | 1 // whose turn to fire (meaningful only once phase === 'playing')
  boards: [Cell[], Cell[]] // boards[i] = seat i's OWN sea; all-water until they place
  placed: [boolean, boolean]
  hitsRemaining: [number, number] // un-hit ship cells left on boards[i]; 0 until playing starts, then 8
  winner?: string
  moves: number
  lastShot: { x: number; y: number; hit: boolean; targetSeat: 0 | 1 } | null
}

const idx = (x: number, y: number): number => y * SIZE + x
const emptyBoard = (): Cell[] => new Array(SIZE * SIZE).fill(0) as Cell[]

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

const canon = (cells: number[]): string => [...cells].sort((a, b) => a - b).join(',')
const CANDIDATES_BY_SIZE: Record<number, Set<string>> = {
  4: new Set(allPlacements2x2().map(canon)),
  3: new Set(allPlacements1x3().map(canon)),
  1: new Set(allPlacements1x1().map(canon)),
}

/** Validate + apply an agent-submitted placement. Returns the built board, or
 * null if the submission isn't exactly {1x1, 1x3, 2x2}, non-overlapping, valid. */
function tryBuildBoard(raw: unknown): Cell[] | null {
  const ships = raw as [number, number][][] | undefined
  if (!Array.isArray(ships) || ships.length !== 3) return null
  let groups: number[][]
  try {
    groups = ships.map((grp) => {
      if (!Array.isArray(grp) || grp.length === 0) throw new Error('bad group')
      return grp.map(([x, y]) => {
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= SIZE || y < 0 || y >= SIZE) {
          throw new Error('out of bounds')
        }
        return idx(x, y)
      })
    })
  } catch {
    return null
  }
  const sizes = groups.map((g) => g.length).sort((a, b) => a - b)
  if (sizes[0] !== 1 || sizes[1] !== 3 || sizes[2] !== 4) return null
  for (const g of groups) {
    const cand = CANDIDATES_BY_SIZE[g.length]!
    if (!cand.has(canon(g))) return null // not a real contiguous ship shape
  }
  const all = groups.flat()
  if (new Set(all).size !== 8) return null // overlap across groups
  const board = emptyBoard()
  for (const c of all) board[c] = 1
  return board
}

/** Mask a board for an external viewer: un-hit ships (1) look like water (0). */
function maskBoard(board: Cell[]): Cell[] {
  return board.map((c) => (c === 1 ? 0 : c)) as Cell[]
}

function boardToCells(board: Cell[]): number[][] {
  const cells: number[][] = []
  for (let y = SIZE - 1; y >= 0; y--) {
    const row: number[] = []
    for (let x = 0; x < SIZE; x++) row.push(board[idx(x, y)]!)
    cells.push(row)
  }
  return cells
}

export default defineGame<State, Record<string, never>>({
  meta: {
    type: 'battleship',
    players: { min: 2, max: 2 },
    pace: 'turn-based',
    turnTimeoutSec: 60,
    maxSteps: 55, // 2 placement actions + up to ~49 shots + margin
    hiddenInfo: true,
  },

  init: (cfg): State => ({
    players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
    phase: 'placing',
    side: 0,
    boards: [emptyBoard(), emptyBoard()],
    placed: [false, false],
    hitsRemaining: [0, 0],
    moves: 0,
    lastShot: null,
  }),

  // Weak heuristic for `pnpm sim` / `pnpm preview` self-play only — places
  // ships randomly during 'placing', fires at a random untried cell during
  // 'playing'. Never used by real matches (agents submit their own actions).
  play: (s, _p, ctx): Action => {
    if (s.phase === 'placing') {
      const board = emptyBoard()
      const toXY = (i: number): [number, number] => [i % SIZE, Math.floor(i / SIZE)]
      const pick = (candidates: number[][]): number[] => {
        const valid = candidates.filter((cells) => cells.every((c) => board[c] === 0))
        const chosen = valid[Math.floor(ctx.random() * valid.length)]!
        for (const c of chosen) board[c] = 1
        return chosen
      }
      const big = pick(allPlacements2x2())
      const mid = pick(allPlacements1x3())
      const one = pick(allPlacements1x1())
      return { ships: [big.map(toXY), mid.map(toXY), one.map(toXY)] }
    }
    const targetIdx = s.side === 0 ? 1 : 0
    const board = s.boards[targetIdx]!
    const legal: number[] = []
    for (let i = 0; i < board.length; i++) if (board[i] === 0 || board[i] === 1) legal.push(i)
    const cell = legal[Math.floor(ctx.random() * legal.length)]!
    return { x: cell % SIZE, y: Math.floor(cell / SIZE) }
  },

  reduce: (s, action, ctx: Ctx): State => {
    const seat = s.players.indexOf(ctx.actor)
    if (seat < 0) ctx.reject('not-a-player')

    if (s.phase === 'placing') {
      if (s.placed[seat as 0 | 1]) ctx.reject('already-placed')
      const board = tryBuildBoard((action as { ships?: unknown }).ships)
      if (!board) ctx.reject('invalid-placement')
      const boards: [Cell[], Cell[]] = [s.boards[0], s.boards[1]]
      boards[seat as 0 | 1] = board!
      const placed: [boolean, boolean] = [...s.placed]
      placed[seat as 0 | 1] = true
      if (placed[0] && placed[1]) {
        return { ...s, boards, placed, phase: 'playing', side: 0, hitsRemaining: [8, 8] }
      }
      // Still waiting on one side. `side` is advisory during placing (real
      // submissions are accepted in either order, gated only by `placed`), but
      // sim/preview tooling reads it as "who to act next" -- point it at
      // whichever seat has not yet placed, regardless of submission order.
      const nextSide: 0 | 1 = placed[0] ? 1 : 0
      return { ...s, boards, placed, side: nextSide }
    }

    if (s.phase !== 'playing') ctx.reject('game-over')
    if (seat !== s.side) ctx.reject('not-your-turn')
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
      lastShot: { x, y, hit, targetSeat: targetIdx as 0 | 1 },
      side: won ? s.side : ((s.side ^ 1) as 0 | 1),
      phase: won ? 'won' : 'playing',
      winner: won ? s.players[s.side] : s.winner,
    }
  },

  terminal: (s) => (s.phase === 'won' ? { done: true, winner: s.winner ?? null } : { done: false }),

  score: (s): Record<string, number> => {
    if (s.phase === 'won' && s.winner) {
      const loser = s.players.find((p) => p !== s.winner) ?? s.players[1]
      return { [s.winner]: 1, [loser]: 0 }
    }
    return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
  },

  render: (s, ctx?: RenderCtx): RenderSpec => {
    const viewer = ctx?.viewer
    const viewerSeat = s.players.indexOf(viewer ?? '')

    // Two-board layout for the T2 view (view.ts): "your fleet" (own ships +
    // incoming hits/misses) and "enemy waters" (masked -- only hits/misses
    // visible). A non-participant (public/spectator) sees BOTH boards masked --
    // during 'placing' that means all-empty; during 'playing'/'won' it means
    // hits/misses only on both sides, no un-hit ship ever revealed to a
    // spectator either.
    const own = viewerSeat >= 0 ? s.boards[viewerSeat as 0 | 1]! : emptyBoard()
    const oppIdx = viewerSeat === 1 ? 0 : 1
    const enemy = maskBoard(s.boards[oppIdx]!)
    const publicOwn = viewerSeat >= 0 ? own : maskBoard(own) // spectator: mask BOTH boards

    const waitingOn = s.players.filter((_, i) => !s.placed[i as 0 | 1])
    const status =
      s.phase === 'placing'
        ? waitingOn.length
          ? `Setup \u00b7 waiting on: ${waitingOn.join(', ')}`
          : 'Both placed \u2014 starting!'
        : s.phase === 'won'
          ? `Winner: ${s.winner}`
          : `${s.moves} shots \u00b7 seat ${s.side} to fire`

    const frame = {
      layout: 'custom' as const,
      game: 'battleship',
      phase: s.phase,
      viewerSeat,
      you: {
        seat: viewerSeat,
        board: boardToCells(publicOwn),
        shipsLeft: viewerSeat >= 0 ? s.hitsRemaining[viewerSeat as 0 | 1] : undefined,
        placed: viewerSeat >= 0 ? s.placed[viewerSeat as 0 | 1] : undefined,
      },
      opponent: {
        seat: oppIdx,
        board: boardToCells(enemy),
        shipsLeft: s.hitsRemaining[oppIdx],
        placed: s.placed[oppIdx],
      },
      players: s.players,
      side: s.side,
      lastShot: s.lastShot,
      panels: [{ type: 'status' as const, text: status }],
    }
    return frame as unknown as RenderSpec
  },
})


export type { State }
