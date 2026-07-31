/**
 * Chinese Checkers — a two-seat race across the classic 121-hole hex star.
 *
 * Each seat owns 10 pegs sitting in one point of the star and must land all ten
 * in the directly opposite point. A move is either a single step to an adjacent
 * empty hole or a chain of jumps over adjacent pegs. Nothing is ever captured;
 * the whole game is a race.
 *
 * Strategy pace only. A legal move here is a path of hole indices through a
 * 121-hole board, which is far too fiddly to ask an agent to submit move by
 * move — so the agent tunes the mover instead. It submits its knobs once,
 * `play` scores every legal path with them, and `apply` advances the state
 * until the race settles, all headless.
 *
 * `State.side` is the numeric seat to move, as the strategy pace requires.
 *
 * Everything is deterministic; the only randomness allowed is `ctx.random`.
 */
import { defineGame, type Action, type RenderSpec } from '@arena/game-sdk'

// —— geometry ————————————————————————————————————————————————————————
//
// Cube coordinates (x + y + z === 0). The whole star is one predicate:
// a hole exists iff max(x,y,z) <= 4 (one big triangle) OR min(x,y,z) >= -4
// (the other, pointing the opposite way). Their union is the hexagram:
// 61 holes in the central hexagon + 6 points of 10 = 121.

type Cube = readonly [number, number, number]

/** The six neighbour directions on a hex grid. */
const DIRS: readonly Cube[] = [
  [1, -1, 0],
  [1, 0, -1],
  [0, 1, -1],
  [-1, 1, 0],
  [-1, 0, 1],
  [0, -1, 1],
]

const SPAN = 8 // coordinates run -8..8 on every axis
const STRIDE = 2 * SPAN + 1 // 17

const isHole = (x: number, y: number, z: number): boolean =>
  Math.max(x, y, z) <= 4 || Math.min(x, y, z) >= -4

/** All 121 holes, ordered top row to bottom row (ascending z, then x). */
const HOLES: readonly Cube[] = (() => {
  const out: Cube[] = []
  for (let z = -SPAN; z <= SPAN; z++) {
    for (let x = -SPAN; x <= SPAN; x++) {
      const y = -x - z
      if (isHole(x, y, z)) out.push([x, y, z])
    }
  }
  return out
})()

const N = HOLES.length // 121

/** (x,z) -> hole index, or -1. Flat array keyed by (x+8)*17 + (z+8). */
const INDEX: readonly number[] = (() => {
  const out = new Array<number>(STRIDE * STRIDE).fill(-1)
  HOLES.forEach(([x, , z], i) => {
    out[(x + SPAN) * STRIDE + (z + SPAN)] = i
  })
  return out
})()

const at = (x: number, z: number): number =>
  x < -SPAN || x > SPAN || z < -SPAN || z > SPAN ? -1 : INDEX[(x + SPAN) * STRIDE + (z + SPAN)]!

/** NEIGHBOURS[i][d] — hole one step from i in direction d, or -1. */
const NEIGHBOURS: readonly (readonly number[])[] = HOLES.map(([x, , z]) =>
  DIRS.map(([dx, , dz]) => at(x + dx, z + dz)),
)

/** LANDINGS[i][d] — hole two steps from i in direction d (the jump target), or -1. */
const LANDINGS: readonly (readonly number[])[] = HOLES.map(([x, , z]) =>
  DIRS.map(([dx, , dz]) => at(x + 2 * dx, z + 2 * dz)),
)

/**
 * Seat 0 starts in the point at z >= 5 and races to z <= -5; seat 1 mirrors it.
 * The four unused points stay open — standard rules let pegs travel through
 * them, and the progress metric already punishes detours.
 */
const IS_HOME: readonly (readonly boolean[])[] = [
  HOLES.map(([, , z]) => z >= 5),
  HOLES.map(([, , z]) => z <= -5),
]
const IS_TARGET: readonly (readonly boolean[])[] = [IS_HOME[1]!, IS_HOME[0]!]

const hexDist = (a: Cube, b: Cube): number =>
  (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 2

/** The tip of each seat's target point — the anchor for the progress metric. */
const TARGET_APEX: readonly Cube[] = [
  [4, 4, -8],
  [-4, -4, 8],
]

/** DIST[seat][hole] — hex distance from that hole to the seat's target tip. */
const DIST: readonly (readonly number[])[] = TARGET_APEX.map((apex) =>
  HOLES.map((h) => hexDist(h, apex)),
)

/**
 * Sum of DIST over a full camp — the floor of the progress metric. The ten camp
 * holes are provably the ten closest to the tip (everything outside the point
 * is at least 4 away), so hitting this floor is exactly "all ten are home".
 */
const MIN_DIST = (() => {
  let sum = 0
  for (let i = 0; i < N; i++) if (IS_TARGET[0]![i]) sum += DIST[0]![i]!
  return sum
})()

/** Hard cap on plies; on reaching it the match is settled on progress. */
const MAX_PLIES = 200

/**
 * How far a seat has to travel from its opening position — the full span of the
 * race. Renderers use it to turn "distance remaining" into a progress bar.
 */
const START_EXCESS = (() => {
  let sum = 0
  for (let i = 0; i < N; i++) if (IS_HOME[0]![i]) sum += DIST[0]![i]!
  return sum - MIN_DIST
})()

/** Hole coordinates flattened to [x0, z0, x1, z1, ...] for the sandboxed view. */
const FLAT_XZ: readonly number[] = HOLES.flatMap(([x, , z]) => [x, z])

// —— state ——————————————————————————————————————————————————————————

interface State {
  /** 121 holes: -1 empty, else the seat owning the peg. */
  cells: number[]
  /** Seat-aligned agent ids — index === seat, per the engine's join order. */
  players: [string, string]
  /** Seat to move. The strategy pace requires a numeric `side`. */
  side: 0 | 1
  ply: number
  status: 'playing' | 'won' | 'adjudicated' | 'draw'
  winner?: string
  /** Hole indices of the last move, from origin to final landing. */
  lastPath?: number[]
}

interface Params {
  /** Weight on advancing whichever peg trails furthest behind. */
  laggard: number
  /** Bonus per extra hop in a jump chain — favours long ladders. */
  jumpBias: number
  /** Bonus for a move that settles a peg into the target point. */
  homing: number
}

// —— movement ————————————————————————————————————————————————————————

/**
 * Two standing rules keep the race converging:
 *   1. a peg that has left its own point may not move back into it, and
 *   2. a peg that has reached the target point may not leave it.
 * Both still permit shuffling *within* a point, which pegs need in order to
 * unpack. Together they make stalling pointless.
 */
const allowed = (seat: 0 | 1, from: number, to: number): boolean => {
  if (IS_HOME[seat]![to] && !IS_HOME[seat]![from]) return false
  if (IS_TARGET[seat]![from] && !IS_TARGET[seat]![to]) return false
  return true
}

/** Every legal move for `seat`, each a path of hole indices [from, ...landings]. */
function legalPaths(cells: readonly number[], seat: 0 | 1): number[][] {
  const out: number[][] = []
  for (let from = 0; from < N; from++) {
    if (cells[from] !== seat) continue

    for (let d = 0; d < 6; d++) {
      const to = NEIGHBOURS[from]![d]!
      if (to >= 0 && cells[to] === -1 && allowed(seat, from, to)) out.push([from, to])
    }

    // Chained jumps. The peg has vacated `from`, so it can never be hopped over.
    const seen = new Set<number>([from])
    const walk = (cur: number, trail: number[]): void => {
      for (let d = 0; d < 6; d++) {
        const over = NEIGHBOURS[cur]![d]!
        const to = LANDINGS[cur]![d]!
        if (over < 0 || to < 0 || over === from) continue
        if (cells[over] === -1 || cells[to] !== -1 || seen.has(to)) continue
        seen.add(to)
        const next = [...trail, to]
        if (allowed(seat, from, to)) out.push(next)
        walk(to, next)
      }
    }
    walk(from, [from])
  }
  return out
}

/** Sum of every peg's distance to its target tip. Lower is further along. */
function totalDist(cells: readonly number[], seat: 0 | 1): number {
  let sum = 0
  for (let i = 0; i < N; i++) if (cells[i] === seat) sum += DIST[seat]![i]!
  return sum
}

/** Step cap reached: whoever has advanced further takes it. */
function settleOnProgress(s: State): State {
  const d0 = totalDist(s.cells, 0)
  const d1 = totalDist(s.cells, 1)
  if (d0 === d1) return { ...s, status: 'draw', winner: undefined }
  return { ...s, status: 'adjudicated', winner: s.players[d0 < d1 ? 0 : 1] }
}

/** The one state transition. Its input always comes from our own `legalPaths`. */
function applyPath(s: State, path: readonly number[]): State {
  const seat = s.side
  const cells = s.cells.slice()
  cells[path[0]!] = -1
  cells[path[path.length - 1]!] = seat

  const ply = s.ply + 1
  const next: State = {
    ...s,
    cells,
    side: (seat ^ 1) as 0 | 1,
    ply,
    lastPath: [...path],
  }

  if (totalDist(cells, seat) === MIN_DIST) {
    next.status = 'won'
    next.winner = s.players[seat]
    return next
  }
  if (ply >= MAX_PLIES) return settleOnProgress(next)
  return next
}

/** A seat with no legal move forfeits the turn — vanishingly rare, but total. */
function passTurn(s: State): State {
  const ply = s.ply + 1
  const next: State = { ...s, side: (s.side ^ 1) as 0 | 1, ply, lastPath: [] }
  return ply >= MAX_PLIES ? settleOnProgress(next) : next
}

// —— definition ——————————————————————————————————————————————————————

export default defineGame<State, Params>({
  meta: {
    type: 'chinese-checkers',
    players: { min: 2, max: 2 },
    pace: 'strategy',
    submitWindowSec: 600,
    // One ply per step, plus headroom so `terminal` reports done before the
    // engine's own cap trips.
    maxSteps: MAX_PLIES + 10,
    bestOf: 2,
  },

  params: {
    laggard: { min: 0, max: 2, default: 0.8 },
    jumpBias: { min: 0, max: 2, default: 0.5 },
    homing: { min: 0, max: 4, default: 1.5 },
  },

  init: (cfg, ctx): State => {
    const cells = new Array<number>(N).fill(-1)
    for (let i = 0; i < N; i++) {
      if (IS_HOME[0]![i]) cells[i] = 0
      else if (IS_HOME[1]![i]) cells[i] = 1
    }
    return {
      cells,
      players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
      side: ctx.random() < 0.5 ? 0 : 1,
      ply: 0,
      status: 'playing',
    }
  },

  play: (s, p, ctx): Action => {
    const seat = s.side
    const moves = legalPaths(s.cells, seat)
    if (moves.length === 0) return { path: [] }

    let best = moves[0]!
    let bestScore = -Infinity
    for (const path of moves) {
      const from = path[0]!
      const to = path[path.length - 1]!

      let v = DIST[seat]![from]! - DIST[seat]![to]! // raw progress
      v += p.laggard * (DIST[seat]![from]! / 16) // nudge the rearmost peg forward
      v += p.jumpBias * (path.length - 2) * 0.25 // reward long ladders
      if (IS_TARGET[seat]![to] && !IS_TARGET[seat]![from]) v += p.homing
      v += ctx.random() * 1e-9 // deterministic tiebreak

      if (v > bestScore) {
        bestScore = v
        best = path
      }
    }
    return { path: best }
  },

  apply: (s, action): State => {
    const { path } = action as { path: number[] }
    if (!path || path.length < 2) return passTurn(s)
    return applyPath(s, path)
  },

  terminal: (s) =>
    s.status === 'won' || s.status === 'adjudicated'
      ? { done: true, winner: s.winner ?? null }
      : s.status === 'draw'
        ? { done: true, winner: null }
        : { done: false },

  score: (s): Record<string, number> => {
    const [a, b] = s.players
    if (s.status === 'won' && s.winner) {
      const loser = s.players.find((p) => p !== s.winner) ?? b
      return { [s.winner]: 1, [loser]: 0 }
    }
    if (s.status === 'draw') return { [a]: 0.5, [b]: 0.5 }

    // Adjudicated, or cut short by the engine's step cap: grade on how much of
    // the race each seat still has left. Clamped so a settled result never
    // outranks an outright win or undercuts an outright loss.
    const e0 = totalDist(s.cells, 0) - MIN_DIST
    const e1 = totalDist(s.cells, 1) - MIN_DIST
    const raw = e0 + e1 === 0 ? 0.5 : e1 / (e0 + e1)
    const share = Math.min(0.85, Math.max(0.15, raw))
    return { [a]: share, [b]: 1 - share }
  },

  render: (s): RenderSpec => {
    const d0 = totalDist(s.cells, 0) - MIN_DIST
    const d1 = totalDist(s.cells, 1) - MIN_DIST

    // T1 fallback: shear the star into a 17x17 grid so the platform's built-in
    // board renderer still shows something coherent. 0 = off-board, 1/2 = pegs,
    // 3 = an empty hole.
    const grid: number[][] = Array.from({ length: STRIDE }, () => new Array<number>(STRIDE).fill(0))
    HOLES.forEach(([x, , z], i) => {
      const occupant = s.cells[i]!
      grid[z + SPAN]![x + SPAN] = occupant === -1 ? 3 : occupant + 1
    })

    const text =
      s.status === 'won'
        ? `${s.winner} is home`
        : s.status === 'adjudicated'
          ? `step cap — ${s.winner} led on progress`
          : s.status === 'draw'
            ? 'step cap — dead level'
            : `${s.players[s.side]} to move · ply ${s.ply}`

    // RenderSpec has no free-form data slot, so we attach the fields our own
    // view.ts needs and cast — the same trick doudizhu and battleship use.
    const frame = {
      layout: 'custom' as const,
      board: {
        cols: STRIDE,
        rows: STRIDE,
        cells: grid,
        palette: { 1: '#4c9aff', 2: '#e5484d', 3: 'rgba(255,255,255,0.10)' },
        topology: 'grid' as const,
      },
      panels: [
        { type: 'status' as const, text },
        {
          type: 'scoreboard' as const,
          rows: [
            { label: s.players[0]!, value: `${d0} to go` },
            { label: s.players[1]!, value: `${d1} to go` },
          ],
        },
      ],
      // —— consumed by view.ts ——
      holes: FLAT_XZ,
      pegs: s.cells,
      side: s.side,
      ply: s.ply,
      status: s.status,
      winner: s.winner ?? null,
      lastPath: s.lastPath ?? [],
      remaining: [d0, d1],
      span: START_EXCESS,
      seats: s.players,
    }
    return frame as unknown as RenderSpec
  },
})

/** Internals exposed for the test suite's geometry self-check. */
export const __geometry = {
  HOLES,
  N,
  NEIGHBOURS,
  LANDINGS,
  IS_HOME,
  IS_TARGET,
  DIST,
  MIN_DIST,
  MAX_PLIES,
  legalPaths,
  totalDist,
}
