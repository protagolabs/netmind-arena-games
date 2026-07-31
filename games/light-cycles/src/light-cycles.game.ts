/**
 * Light Cycles — simultaneous snake-trail survival duel (Tron-style).
 *
 * Two cycles ride a 13x13 arena leaving permanent light trails. Every tick
 * BOTH riders pick a direction; the moves resolve at the same instant. Riding
 * into a wall, any trail (yours or theirs), or head-on into the other rider
 * wrecks you. Last rider moving wins; a mutual wreck is a draw.
 *
 * Simultaneity is implemented with the sealed-commit pattern established by
 * `games/penalty-shootout`: within a tick, seat 0 submits a direction first
 * (stored in `state.pending`, hidden from everyone else), then seat 1 submits
 * blind, and `commit()` resolves both at once. The pending direction is the
 * ONLY secret in the game (`meta.hiddenInfo`) — the board itself is public.
 * Commit order carries no advantage because the first commit is sealed.
 *
 * Termination is structural: every completed tick paints two fresh cells (or
 * ends the game), and the arena has 169 cells, so a wreck is forced long
 * before `MAX_TICKS`; that cap plus `meta.maxSteps` are belt-and-braces.
 *
 * Both paces from one definition (like gomoku):
 *  - strategy   : `play` is a deterministic heuristic driven by three knobs
 *                 (space / aggression / hug); the match settles headless.
 *  - turn-based : each agent submits `{dir}` per tick via `reduce`, which
 *                 validates `ctx.actor` (the engine does NOT do it for us).
 *
 * `play` deliberately never reads `state.pending`: when choosing for the seat
 * that commits second, the opponent's sealed direction is already in state,
 * and peeking would break the blind duel. The heuristic sees only the public
 * board. (Agents can only tune numeric knobs, so nobody else can peek either.)
 */
import { defineGame, type RenderCtx, type RenderSpec } from '@arena/game-sdk'

type Dir = 'U' | 'D' | 'L' | 'R'
type Cause = 'wall' | 'trail' | 'head-on'

const W = 13
const H = 13
/** Unreachable safety cap (see header) — guarantees `terminal` converges. */
const MAX_TICKS = W * H

const DIRS: readonly Dir[] = ['U', 'D', 'L', 'R']
const DELTA: Record<Dir, readonly [number, number]> = {
  U: [0, -1],
  D: [0, 1],
  L: [-1, 0],
  R: [1, 0],
}

interface Crash {
  seat: 0 | 1
  /** The cell the rider tried to enter (may be 1 off-grid for a wall hit). */
  x: number
  y: number
  cause: Cause
}

interface State {
  players: [string, string]
  w: number
  h: number
  /** 0 empty, 1 seat-0 trail, 2 seat-1 trail. Heads are painted into it. */
  grid: number[][]
  heads: [{ x: number; y: number }, { x: number; y: number }]
  /** This tick's sealed commits — SECRET until the tick resolves. */
  pending: [Dir | null, Dir | null]
  tick: number
  status: 'playing' | 'over'
  /** Set when status is 'over' and the wreck wasn't mutual. */
  winner?: string
  /** How the game ended — resolved wrecks only, fully public. */
  crashes: Crash[]
  moves: number
  /** Seat expected to commit next (SDK routing convention). */
  side: 0 | 1
  /**
   * Per-match noise seed for the built-in policy's tie-breaks (seeded in
   * `init`, so replays stay deterministic). Not a secret — just decorrelation.
   */
  salt: number
}

interface Params {
  space: number
  aggression: number
  hug: number
  caution: number
}

// T1 palette. Hexes mirror ARENA_THEME (stones[3] blue / accent crimson) —
// the game module keeps its bundle dependency-light by inlining them.
const PALETTE: Record<number, string> = {
  0: '#101014', // arena floor
  1: 'rgba(76, 154, 255, 0.45)', // seat-0 trail (blue)
  2: 'rgba(229, 72, 77, 0.45)', // seat-1 trail (crimson)
  3: '#4c9aff', // seat-0 head
  4: '#e5484d', // seat-1 head
}

function isDir(v: unknown): v is Dir {
  return v === 'U' || v === 'D' || v === 'L' || v === 'R'
}

function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < W && y >= 0 && y < H
}

/**
 * Count the empty region reachable from (x,y), the cell included. Iterative
 * flood fill — `pop()` makes the traversal DFS-order, which is irrelevant for
 * a pure reachable-cell count.
 */
function floodSize(grid: number[][], x: number, y: number): number {
  const seen = new Set<number>([y * W + x])
  const queue = [y * W + x]
  let count = 0
  while (queue.length > 0) {
    const k = queue.pop()!
    count++
    const cx = k % W
    const cy = (k - cx) / W
    for (const d of DIRS) {
      const nx = cx + DELTA[d][0]
      const ny = cy + DELTA[d][1]
      const nk = ny * W + nx
      if (inBounds(nx, ny) && grid[ny]![nx] === 0 && !seen.has(nk)) {
        seen.add(nk)
        queue.push(nk)
      }
    }
  }
  return count
}

/**
 * Deterministic tie-break epsilon in [0,1), unique per (match, seat, tick,
 * dir). Two failure modes it exists to kill, discovered the hard way:
 *
 * 1. Jitter alone → mirror dances. At a mirror-symmetric position the two
 *    seats' deterministic scores are EXACTLY equal, both hit the tie on the
 *    same tick, and independent jitter draws break it the same way ~50% of
 *    the time — which keeps the position symmetric and re-flips the same coin
 *    next tick. Some seeds locked into a full-match mirror dance ending in a
 *    guaranteed mutual wreck (seed 12345 mirrored all 78 ticks). Keying the
 *    epsilon by seat decorrelates the riders by construction.
 * 2. Seat+tick hash alone → seat bias. Without the per-match `salt`, the
 *    epsilon pattern is IDENTICAL in every match, and whatever direction
 *    leans it bakes in repeat across all matches — a 200-seed sweep showed
 *    seat 1 winning nearly 2x as often. Salting by a per-match seeded draw
 *    gives every match a fresh pattern, so no seat is favoured on average.
 *
 * Pure integer hash — same inputs, same epsilon, so replays stay
 * deterministic.
 */
function tieBreak(salt: number, seat: number, tick: number, dirIndex: number): number {
  let h = salt ^ Math.imul(seat + 1, 0x9e3779b9)
  h = (h + Math.imul(tick + 1, 0x85ebca6b)) | 0
  h = (h + Math.imul(dirIndex + 1, 0xc2b2ae35)) | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** How many of (x,y)'s 4 neighbours are wall or trail — the "hug" signal. */
function blockedNeighbours(grid: number[][], x: number, y: number): number {
  let n = 0
  for (const d of DIRS) {
    const nx = x + DELTA[d][0]
    const ny = y + DELTA[d][1]
    if (!inBounds(nx, ny) || grid[ny]![nx] !== 0) n++
  }
  return n
}

/**
 * Seal `dir` for the seat whose commit is due (`state.side`); once both seats
 * are in, resolve the tick. Pure — callers validated the direction already.
 */
function commit(s: State, dir: Dir): State {
  const pending: State['pending'] = [...s.pending]
  pending[s.side] = dir
  if (s.side === 0) {
    return { ...s, pending, side: 1, moves: s.moves + 1 }
  }
  return resolveTick({ ...s, pending, moves: s.moves + 1 })
}

/** Both commits are in: move both riders at the same instant. */
function resolveTick(s: State): State {
  const targets = ([0, 1] as const).map((i) => {
    const d = DELTA[s.pending[i]!]
    return { x: s.heads[i].x + d[0], y: s.heads[i].y + d[1] }
  })

  const crashes: Crash[] = []
  const dead: [boolean, boolean] = [false, false]
  for (const i of [0, 1] as const) {
    const t = targets[i]!
    if (!inBounds(t.x, t.y)) {
      dead[i] = true
      crashes.push({ seat: i, x: t.x, y: t.y, cause: 'wall' })
    } else if (s.grid[t.y]![t.x] !== 0) {
      // Any trail kills — including the cell the opponent's head just left
      // (a "swap" is two trail deaths) and your own first cell on a reverse.
      dead[i] = true
      crashes.push({ seat: i, x: t.x, y: t.y, cause: 'trail' })
    }
  }
  // Head-on: both otherwise safe, racing into the same empty cell.
  if (!dead[0] && !dead[1] && targets[0]!.x === targets[1]!.x && targets[0]!.y === targets[1]!.y) {
    for (const i of [0, 1] as const) {
      dead[i] = true
      crashes.push({ seat: i, x: targets[i]!.x, y: targets[i]!.y, cause: 'head-on' })
    }
  }

  const grid = s.grid.map((r) => [...r])
  const heads: State['heads'] = [...s.heads]
  for (const i of [0, 1] as const) {
    if (!dead[i]) {
      grid[targets[i]!.y]![targets[i]!.x] = i + 1
      heads[i] = targets[i]!
    }
  }

  const tick = s.tick + 1
  let status: State['status'] = 'playing'
  let winner: string | undefined
  if (dead[0] || dead[1]) {
    status = 'over'
    if (dead[0] !== dead[1]) winner = s.players[dead[0] ? 1 : 0]
  } else if (tick >= MAX_TICKS) {
    status = 'over' // unreachable belt-and-braces draw (see header)
  }

  return {
    ...s,
    grid,
    heads,
    pending: [null, null],
    tick,
    status,
    winner,
    crashes: [...s.crashes, ...crashes],
    side: 0,
  }
}

export default defineGame<State, Params>({
  meta: {
    type: 'light-cycles',
    players: { min: 2, max: 2 },
    pace: 'strategy',
    paces: ['strategy', 'turn-based'],
    hiddenInfo: true,
    submitWindowSec: 600,
    turnTimeoutSec: 60,
    // Spawn rows are randomised per game (see init), so pair games with a
    // seat swap to cancel any per-game spawn luck.
    bestOf: 2,
    // 2 sealed commits per tick. Real matches wreck within ~(W*H)/2 ticks
    // (each completed tick paints 2 fresh cells); this bounds even the
    // unreachable MAX_TICKS draw path.
    maxSteps: 2 * W * H,
  },

  params: {
    /** Weight on keeping a large reachable region after the move. */
    space: { min: 0, max: 1, default: 0.7 },
    /** Weight on closing distance to the opponent's head (pressure). */
    aggression: { min: 0, max: 1, default: 0.35 },
    /** Weight on riding tight along walls/trails (conserves open space). */
    hug: { min: 0, max: 1, default: 0.25 },
    /**
     * Penalty on cells the opponent's head could enter this same tick (a
     * potential mutual head-on wreck). 0 = pure chicken; 1 = full matador.
     * Without it, two mirrored default riders charge and draw at tick 4.
     */
    caution: { min: 0, max: 1, default: 0.6 },
  },

  init(cfg, ctx): State {
    const players = cfg.players as [string, string]
    // Columns mirrored, rows drawn independently (2..H-3, so every rider has
    // >= 2 safe cells straight up or down). Seat 1's row is then forced off
    // BOTH symmetry axes of seat 0's spawn — never the same row (mirror
    // symmetry) and never the rotated row H-1-r0 (point symmetry). With no
    // symmetric start, two equal default policies can't lock into the
    // deterministic lock-step dance that a symmetric board sustains (see
    // tieBreak) — matches diverge structurally, not by luck. Per-game row
    // luck is cancelled by meta.bestOf seat-swapped pairing.
    const r0 = 2 + Math.floor(ctx.random() * (H - 4))
    const banned = new Set([r0, H - 1 - r0])
    const allowed: number[] = []
    for (let r = 2; r <= H - 3; r++) if (!banned.has(r)) allowed.push(r)
    const r1 = allowed[Math.floor(ctx.random() * allowed.length)]!
    const salt = Math.floor(ctx.random() * 4294967296)
    const grid = Array.from({ length: H }, () => Array<number>(W).fill(0))
    grid[r0]![2] = 1
    grid[r1]![W - 3] = 2
    return {
      players,
      w: W,
      h: H,
      grid,
      heads: [
        { x: 2, y: r0 },
        { x: W - 3, y: r1 },
      ],
      pending: [null, null],
      tick: 0,
      status: 'playing',
      crashes: [],
      moves: 0,
      side: 0,
      salt,
    }
  },

  play(state, params, ctx) {
    // Sealed-duel discipline: no `state.pending` reads here (see header).
    const me = state.side
    const opp = (me ^ 1) as 0 | 1
    const head = state.heads[me]
    const oppHead = state.heads[opp]

    let bestDir: Dir = 'U'
    let bestScore = -Infinity
    for (let i = 0; i < DIRS.length; i++) {
      const dir = DIRS[i]!
      const x = head.x + DELTA[dir][0]
      const y = head.y + DELTA[dir][1]
      const lethal = !inBounds(x, y) || state.grid[y]![x] !== 0
      let sc: number
      if (lethal) {
        // Doomed candidates still need a stable ordering — a rider boxed in
        // on all four sides must submit SOMETHING.
        sc = -1000 + ctx.random()
      } else {
        const area = floodSize(state.grid, x, y)
        const dist = Math.abs(x - oppHead.x) + Math.abs(y - oppHead.y)
        // dist === 1: the opponent's head can enter this exact cell on the
        // same tick — a live head-on risk, dodged in proportion to `caution`.
        const headOnRisk = dist === 1 ? params.caution * 0.25 : 0
        // Two noise terms, both small enough never to override a real signal
        // (the per-cell aggression step is ~0.027): seeded jitter varies play
        // across matches; the seat-keyed tie-break kills mirror dances.
        sc =
          params.space * (area / (W * H)) +
          params.hug * (blockedNeighbours(state.grid, x, y) / 4) +
          params.aggression * (1 - dist / (W + H)) -
          headOnRisk +
          ctx.random() * 0.01 +
          tieBreak(state.salt, me, state.tick, i) * 0.01
      }
      if (sc > bestScore) {
        bestScore = sc
        bestDir = dir
      }
    }
    return { dir: bestDir }
  },

  apply(s, action, ctx): State {
    if (s.status === 'over') return ctx.reject('game-over')
    const dir = (action as { dir?: unknown }).dir
    if (!isDir(dir)) return ctx.reject('invalid-direction')
    return commit(s, dir)
  },

  reduce(s, action, ctx): State {
    if (s.status === 'over') return ctx.reject('game-over')
    if (typeof action !== 'object' || action === null) return ctx.reject('bad-action')
    if (ctx.actor !== s.players[s.side]) return ctx.reject('not-your-turn')
    const dir = (action as { dir?: unknown }).dir
    if (!isDir(dir)) return ctx.reject('invalid-direction')
    return commit(s, dir)
  },

  terminal: (s) => (s.status === 'over' ? { done: true, winner: s.winner ?? null } : { done: false }),

  score(s): Record<string, number> {
    if (s.status !== 'over') return { [s.players[0]]: 0, [s.players[1]]: 0 }
    if (!s.winner) return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
    const loser = s.players.find((p) => p !== s.winner) ?? s.players[1]
    return { [s.winner]: 1, [loser]: 0 }
  },

  render(s, rctx?: RenderCtx): RenderSpec {
    const viewer = rctx?.viewer
    const viewerSeat = s.players.indexOf(viewer ?? '') as 0 | 1 | -1

    // Board is public: trails 1/2, heads brightened to 3/4.
    const cells = s.grid.map((r) => [...r])
    for (const i of [0, 1] as const) {
      cells[s.heads[i].y]![s.heads[i].x] = i + 3
    }

    // The sealed commit is the ONLY secret: shown to its owner alone. The
    // public/spectator frame (no viewer) carries just the committed flags.
    const myPending = viewerSeat === 0 || viewerSeat === 1 ? s.pending[viewerSeat] : null

    let statusText: string
    if (s.status === 'over') {
      if (!s.winner) {
        statusText =
          s.crashes.length > 0 ? `Tick ${s.tick} — mutual wreck, draw` : `Tick ${s.tick} — time out, draw`
      } else {
        const winnerSeat = s.players.indexOf(s.winner)
        const cause = s.crashes[s.crashes.length - 1]?.cause ?? 'wreck'
        statusText = `Tick ${s.tick} — ${winnerSeat === 0 ? 'Blue' : 'Red'} wins (${cause})`
      }
    } else {
      statusText =
        s.side === 0 ? `Tick ${s.tick + 1} — riders committing…` : `Tick ${s.tick + 1} — Blue locked in, Red to commit`
    }

    const frame = {
      layout: 'board' as const,
      board: { cols: s.w, rows: s.h, cells, palette: PALETTE, topology: 'grid' as const },
      panels: [
        {
          type: 'scoreboard' as const,
          rows: [
            { label: 'Blue', value: s.players[0] },
            { label: 'Red', value: s.players[1] },
            { label: 'Tick', value: s.tick },
          ],
        },
        { type: 'status' as const, text: statusText },
      ],
      // Extra fields for the T2 view (the platform's T1 renderer ignores them).
      game: 'light-cycles',
      tick: s.tick,
      heads: s.heads,
      committed: [s.pending[0] !== null, s.pending[1] !== null] as [boolean, boolean],
      myPending,
      viewerSeat,
      status: s.status,
      winner: s.winner,
      crashes: s.crashes,
    }
    return frame as unknown as RenderSpec
  },
})
