/**
 * Long Jump Duel — turn-based, hidden-information.
 *
 * Two runners, N attempts each (default 3), best distance wins. Every attempt
 * is a blind pair-submission, exactly like Battleship's `placing` phase:
 *   - Both seats privately submit {speed, angle} for the CURRENT round.
 *   - Either seat may submit first; the other does not have to wait.
 *   - While only one side has submitted, that side's {speed, angle} is
 *     stored in state but hidden from the OTHER seat and from spectators.
 *   - Once BOTH have submitted, `reduce()` resolves the round in one shot
 *     (fixed seat-0-then-seat-1 order, regardless of submission order, so
 *     the outcome never depends on who happened to submit first) and
 *     appends the result to the public `history`. Only the unresolved
 *     current round is ever secret — everything in `history` is public.
 *
 * There is no strict turn order (no "whose turn" concept within a round) —
 * `reduce` still validates that `ctx.actor` is one of the two seated agents,
 * rejecting anyone else with `not-your-turn` (the engine does not do this
 * for you — see AGENTS.md §3).
 *
 * Why there's a foul mechanic at all: a pure `v^2*sin(2*theta)/g` distance
 * formula has one dominant strategy (max speed + 45 degrees) once both sides
 * can freely pick both knobs, so nothing about the choice is a real
 * tradeoff. Speed above a "safe" threshold risks a foul (scored as 0 for
 * that attempt) with probability rising linearly from 0 at the threshold to
 * `MAX_FOUL_CHANCE` at max speed — mirrors a real long-jump take-off board
 * foul. Angle is checked only for hard range validity (10-60 degrees); it
 * never affects foul risk — the two risk dimensions (speed control vs. angle
 * choice) are kept independent so a player can always tell WHY an attempt
 * failed.
 *
 * A small per-round wind coefficient (+/- WIND_MAX_PCT%, via `ctx.random()`)
 * is applied to the resolved distance so identical inputs don't always
 * produce an identical number, while remaining fully deterministic for a
 * given seed + action sequence.
 *
 * NOTE on tunable constants: the design draft called these "build-time knobs
 * clamped via clampParams" — but in this SDK, `defineGame.params` +
 * `clampParams` are wired ONLY into the strategy-pace `play(state, params,
 * ctx)` loop (an AGENT's own per-match strategy dial, e.g. gomoku's
 * `aggression`), not a competition-creator-supplied config channel. No
 * turn-based game in this repo reads `cfg.options` either (it exists on
 * `GameConfig` but is unused everywhere). Since this game is turn-based only
 * (no `play`+`apply` strategy loop), there is no real wiring path for
 * "build-time knobs" to flow in. These are therefore fixed constants (set to
 * the design draft's documented defaults), the same pattern
 * penalty-shootout uses for its own tuning tables (SAVE_TABLE/MISS_TABLE/
 * REGULATION_ROUNDS are plain constants, not configurable params either).
 */
import { defineGame, type Ctx, type RenderCtx, type RenderSpec } from '@arena/game-sdk'

const ATTEMPTS = 3 // attempts per side; best (non-fouled) distance wins
const MAX_SPEED = 12 // m/s, stylised unit
const SAFE_SPEED_RATIO = 0.7 // fraction of MAX_SPEED below which a foul is impossible
const MAX_FOUL_CHANCE = 0.4 // foul chance at MAX_SPEED (linear ramp from the safe threshold)
const GRAVITY = 9.8
const WIND_MAX_PCT = 8 // per-attempt wind perturbs distance by up to +/- this percent
const MIN_ANGLE = 10 // degrees
const MAX_ANGLE = 60 // degrees

const SAFE_SPEED_THRESHOLD = MAX_SPEED * SAFE_SPEED_RATIO

interface Jump {
  speed: number
  angle: number
}

interface AttemptResult {
  round: number
  seat: 0 | 1
  speed: number
  angle: number
  fouled: boolean
  distance: number
  windPct: number // wind actually applied this attempt, e.g. +5.3 or -3.1; 0 when fouled
}

interface State {
  players: [string, string]
  phase: 'playing' | 'done'
  round: number // 0-based current round index; round === ATTEMPTS once every round has resolved
  pending: [Jump | null, Jump | null] // this round's blind submissions; cleared once both are in
  bestDistance: [number, number]
  history: AttemptResult[] // resolved attempts only — fully public, never hidden
  winner?: string
  moves: number
  side: 0 | 1 // hint for sim/preview: a seat that has not yet submitted THIS round
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Linear ramp: 0 at/below the safe threshold, MAX_FOUL_CHANCE at MAX_SPEED. */
function foulChance(speed: number): number {
  const ratio = clamp((speed - SAFE_SPEED_THRESHOLD) / (MAX_SPEED - SAFE_SPEED_THRESHOLD), 0, 1)
  return ratio * MAX_FOUL_CHANCE
}

export default defineGame<State, Record<string, never>>({
  meta: {
    type: 'long-jump-duel',
    players: { min: 2, max: 2 },
    pace: 'turn-based',
    hiddenInfo: true,
    // 2 submissions per round (one per seat) x ATTEMPTS rounds, plus a small
    // margin — matches the exact worst case since ATTEMPTS is a fixed constant.
    maxSteps: 2 * ATTEMPTS + 2,
    turnTimeoutSec: 60,
  },

  init: (cfg): State => ({
    players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
    phase: 'playing',
    round: 0,
    pending: [null, null],
    bestDistance: [0, 0],
    history: [],
    moves: 0,
    side: 0,
  }),

  // Weak heuristic for `pnpm sim` / `pnpm preview` self-play only — prefers a
  // speed near (but not always at) the safe threshold, with a random legal
  // angle, kept deterministic via ctx.random(). Never used by real matches
  // (agents submit their own {speed, angle}).
  play(_state, _params, ctx) {
    const speed = clamp(SAFE_SPEED_THRESHOLD * (0.85 + ctx.random() * 0.3), 0, MAX_SPEED)
    const angle = MIN_ANGLE + ctx.random() * (MAX_ANGLE - MIN_ANGLE)
    return { speed, angle }
  },

  reduce(s, action, ctx: Ctx): State {
    if (s.phase === 'done') return ctx.reject('game-over')

    const seatIdx = s.players.indexOf(ctx.actor)
    if (seatIdx < 0) return ctx.reject('not-your-turn') // not one of the two seated agents
    const seat = seatIdx as 0 | 1
    if (s.pending[seat] !== null) return ctx.reject('already-submitted')

    const { speed, angle } = action as { speed?: unknown; angle?: unknown }
    if (!isFiniteNumber(speed) || speed < 0 || speed > MAX_SPEED) return ctx.reject('invalid-parameters')
    if (!isFiniteNumber(angle) || angle < MIN_ANGLE || angle > MAX_ANGLE) return ctx.reject('invalid-parameters')

    const pending: [Jump | null, Jump | null] = [s.pending[0], s.pending[1]]
    pending[seat] = { speed, angle }

    const bothIn = pending[0] !== null && pending[1] !== null
    if (!bothIn) {
      const waitingSeat: 0 | 1 = seat === 0 ? 1 : 0
      return { ...s, pending, side: waitingSeat, moves: s.moves + 1 }
    }

    // Both submitted this round -- resolve in FIXED seat order (0 then 1),
    // regardless of which seat physically submitted first, so the sequence
    // of ctx.random() draws (and therefore the outcome) never depends on
    // submission order -- only on (seed, the two submitted actions).
    const results: AttemptResult[] = []
    const bestDistance: [number, number] = [...s.bestDistance]
    for (const sIdx of [0, 1] as const) {
      const jump = pending[sIdx]!
      const fouled = ctx.random() < foulChance(jump.speed)
      let distance = 0
      let windPct = 0
      if (!fouled) {
        const windFactor = 1 + (ctx.random() * 2 - 1) * (WIND_MAX_PCT / 100)
        windPct = (windFactor - 1) * 100
        const raw = (jump.speed * jump.speed * Math.sin(2 * toRadians(jump.angle))) / GRAVITY
        distance = raw * windFactor
      }
      results.push({ round: s.round, seat: sIdx, speed: jump.speed, angle: jump.angle, fouled, distance, windPct })
      bestDistance[sIdx] = Math.max(bestDistance[sIdx], distance)
    }

    const round = s.round + 1
    const history = [...s.history, ...results]
    let phase: State['phase'] = 'playing'
    let winner: string | undefined
    if (round >= ATTEMPTS) {
      phase = 'done'
      winner = bestDistance[0] === bestDistance[1] ? undefined : bestDistance[0] > bestDistance[1] ? s.players[0] : s.players[1]
    }

    return {
      ...s,
      pending: [null, null],
      bestDistance,
      history,
      round,
      phase,
      winner,
      side: 0,
      moves: s.moves + 1,
    }
  },

  terminal: (s) => (s.phase === 'done' ? { done: true, winner: s.winner ?? null } : { done: false }),

  score(s): Record<string, number> {
    if (s.phase !== 'done') return { [s.players[0]]: 0, [s.players[1]]: 0 }
    if (!s.winner) return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
    const loser = s.players.find((p) => p !== s.winner) ?? s.players[1]
    return { [s.winner]: 1, [loser]: 0 }
  },

  render(s, ctx?: RenderCtx): RenderSpec {
    const viewer = ctx?.viewer
    const viewerSeat = s.players.indexOf(viewer ?? '') as 0 | 1 | -1
    const isParticipant = viewerSeat === 0 || viewerSeat === 1

    // Hidden-info contract for the CURRENT (unresolved) round only:
    //  - a participant sees their OWN pending submission (if they've made
    //    one) and NOTHING about the other seat's status at all -- true blind
    //    simultaneity, matching the "waiting for opponent" suspense in the
    //    design (my own screen never leaks to the opponent's screen, and the
    //    reverse: I don't learn anything from the opponent's screen either).
    //  - a spectator/replay viewer sees no values, but DOES get an aggregate
    //    "who has submitted" status for both seats (no competitive stake, so
    //    it's safe to expose as a waiting-room indicator).
    const myPending: Jump | null = isParticipant ? s.pending[viewerSeat] : null
    const submittedThisRound: [boolean, boolean] | null = isParticipant ? null : [s.pending[0] !== null, s.pending[1] !== null]

    const frame = {
      layout: 'custom' as const,
      game: 'long-jump-duel',
      phase: s.phase,
      viewerSeat,
      players: s.players,
      round: s.round,
      attempts: ATTEMPTS,
      myPending,
      submittedThisRound,
      bestDistance: s.bestDistance,
      history: s.history,
      winner: s.winner,
      moves: s.moves,
    }
    return frame as unknown as RenderSpec
  },
})

export type { State, Jump, AttemptResult }
