/**
 * Penalty Shootout (simplified) — turn-based, hidden-information.
 *
 * Two phases:
 *   1. `setup`   — each side privately submits a shooting order: a permutation
 *      of powers 1..6, one power per shooter. {action:'turn', parameters:{order}}
 *      — either seat may submit first, independently.
 *   2. `shooting` — alternating shots, seat0 always kicks first each round.
 *      Each shot is a two-step commit-reveal so the keeper genuinely guesses
 *      blind (the whole point of the game):
 *        a) the shooter submits a target {col, row} — stored in state but
 *           hidden from the keeper/spectators until resolved.
 *        b) the keeper submits a guess {col, row} — blind, cannot see (a).
 *        reduce() then resolves both at once with ctx.random().
 *
 * `row` (up/down) is a real second guessing dimension — the keeper must read
 * both column AND height to fully stop a shot. Every shot resolves to one of
 * three outcomes:
 *   1. `wide`  — the shot misses the goal outright, independent of the
 *      keeper's guess. Rolled first, via MISS_TABLE (higher power = more
 *      power behind the shot = LESS control = more likely to go wide).
 *   2. `saved` — only possible when not wide AND the keeper's column guess
 *      matches. SAVE_TABLE gives a progressive per-power save chance on a
 *      FULL match (column AND row both correct) — higher power is harder to
 *      stop even when read perfectly. When only the column matches (row
 *      guessed wrong), the save chance is SAVE_TABLE scaled down by
 *      PARTIAL_SAVE_DISCOUNT: a middle-column shot only needs a small
 *      positional adjustment (discount 0.85, keeper is already central), a
 *      side-column shot needs a fully committed dive in the wrong height
 *      (discount 0.6, harder to correct mid-dive). Scaling the SAME power
 *      curve (rather than using flat constants) guarantees a full match is
 *      never worse than a partial match at any power level — an earlier flat
 *      design (mid=70%, side=50%) inverted this at power >=4, where guessing
 *      the wrong row was BETTER than guessing right. See design notes.
 *   3. `goal`  — not wide, and either the column didn't match or the save
 *      roll failed.
 *
 * After REGULATION_ROUNDS rounds (each side's first N shooters from their
 * fixed 1..6 order), a tied score goes to sudden death: every following
 * shooter is forced power 1, checked after each completed round, capped by
 * SUDDEN_DEATH_ROUND_CAP to guarantee termination (draw if still tied then).
 */
import { defineGame, type Ctx, type RenderCtx, type RenderSpec } from '@arena/game-sdk'

type Col = 'L' | 'M' | 'R'
type Row = 'U' | 'D'
type Outcome = 'goal' | 'saved' | 'wide'

interface ShotRecord {
  round: number
  shooterSeat: 0 | 1
  power: number
  col: Col
  row: Row
  keeperCol: Col
  keeperRow: Row
  outcome: Outcome
}

interface State {
  players: [string, string]
  phase: 'setup' | 'shooting' | 'won'
  orders: [number[] | null, number[] | null] // each side's power permutation, 1..6
  nicknames: string[] // index i = power (i+1)'s nickname, e.g. nicknames[2] = power 3's nickname
  round: number // 0-based; round >= REGULATION_ROUNDS is sudden death (power forced to 1)
  shooterSeat: 0 | 1 // who kicks the CURRENT shot
  pendingKick: { col: Col; row: Row } | null // set once the shooter has committed, cleared on resolve
  score: [number, number]
  history: ShotRecord[] // resolved shots only — fully public, never hidden
  winner?: string
  moves: number
  side: 0 | 1 // whose action is expected next (sim/preview heuristic hint)
}

const REGULATION_ROUNDS = 5 // 5 shots each decide it; 6th+ only happens tied (sudden death)
const SUDDEN_DEATH_ROUND_CAP = 25 // 5 regulation + 20 sudden-death rounds, then force a draw

// power 1..6 -> save chance on a FULL match (column AND row both correct)
const SAVE_TABLE: Record<number, number> = { 1: 1.0, 2: 0.9, 3: 0.8, 4: 0.7, 5: 0.6, 6: 0.5 }
// power 1..6 -> chance the shot goes wide (misses the goal outright), rolled
// before any save check -- weaker shooters have far less control.
const MISS_TABLE: Record<number, number> = { 1: 0.18, 2: 0.15, 3: 0.12, 4: 0.09, 5: 0.06, 6: 0.03 }

// Discount applied to SAVE_TABLE when the keeper's column guess is correct
// but the row guess is wrong (a partial read). Middle-column shots only need
// a small positional adjustment to still get a hand on the ball (keeper is
// already centered); side-column shots require a fully committed dive, so
// guessing the wrong height there is much costlier. Multiplying the SAME
// SAVE_TABLE curve (instead of using flat constants) keeps a full match
// strictly >= a partial match at every power level -- see file header.
const PARTIAL_SAVE_DISCOUNT_MID = 0.85
const PARTIAL_SAVE_DISCOUNT_SIDE = 0.6
function partialSaveDiscount(col: Col): number {
  return col === 'M' ? PARTIAL_SAVE_DISCOUNT_MID : PARTIAL_SAVE_DISCOUNT_SIDE
}

// Flavor nicknames: "<power><suffix>", e.g. "3lot" -- one per power level,
// randomized once per match (seeded, deterministic) so re-simming the same
// seed always gives the same cast, but different matches feel different.
const NICK_SUFFIXES = ['ker', 'mar', 'lot', 'yar', 'box', 'str', 'fox', 'jet', 'ace', 'rex', 'vex', 'zip']
function pickNicknames(ctx: Ctx): string[] {
  const pool = [...NICK_SUFFIXES]
  const out: string[] = []
  for (let power = 1; power <= 6; power++) {
    const i = Math.floor(ctx.random() * pool.length)
    out.push(`${power}${pool[i]}`)
    pool.splice(i, 1)
  }
  return out
}

function isOrder(raw: unknown): raw is number[] {
  if (!Array.isArray(raw) || raw.length !== 6) return false
  const seen = new Set<number>()
  for (const v of raw) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 6 || seen.has(v)) return false
    seen.add(v)
  }
  return true
}

function isCol(v: unknown): v is Col {
  return v === 'L' || v === 'M' || v === 'R'
}

function isRow(v: unknown): v is Row {
  return v === 'U' || v === 'D'
}

function powerAt(s: State, shooterSeat: 0 | 1): number {
  if (s.round >= REGULATION_ROUNDS) return 1 // sudden death: everyone shoots at power 1
  return s.orders[shooterSeat]![s.round]!
}

export default defineGame<State, Record<string, never>>({
  meta: {
    type: 'penalty-shootout',
    players: { min: 2, max: 2 },
    pace: 'turn-based',
    hiddenInfo: true,
    // 2 setup actions + 4 reduce() calls per round (2 shots/round, each shot
    // is 2 calls: kick then save). The draw-by-safety-cap branch in reduce()
    // fires once `round > SUDDEN_DEATH_ROUND_CAP`, i.e. only after round
    // INDICES 0..SUDDEN_DEATH_ROUND_CAP have all completed -- that's
    // (SUDDEN_DEATH_ROUND_CAP + 1) full rounds, not SUDDEN_DEATH_ROUND_CAP.
    // The original formula (2 + 2*CAP) was wrong on two counts: x2 instead
    // of x4 per round, AND missing that +1 round. Either mistake alone would
    // let the SDK's own maxSteps enforcement cut a match short before the
    // safety-cap draw could ever fire, making that whole path unreachable in
    // practice. Caught by AI review on PR #19.
    maxSteps: 2 + 4 * (SUDDEN_DEATH_ROUND_CAP + 1),
    turnTimeoutSec: 60,
  },

  init(cfg, ctx): State {
    const players = cfg.players as [string, string]
    return {
      players,
      phase: 'setup',
      orders: [null, null],
      nicknames: pickNicknames(ctx),
      round: 0,
      shooterSeat: 0,
      pendingKick: null,
      score: [0, 0],
      history: [],
      moves: 0,
      side: 0,
    }
  },

  play(state, _params, ctx) {
    // NOTE: whatever this returns is passed straight through to reduce() as
    // its `action` argument (see sim.ts) -- return the bare payload, not an
    // {action,parameters} envelope.
    if (state.phase === 'setup') {
      const order = [1, 2, 3, 4, 5, 6]
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(ctx.random() * (i + 1))
        ;[order[i], order[j]] = [order[j]!, order[i]!]
      }
      return { order }
    }
    // Both the shooter's kick and the keeper's blind guess are now {col, row}
    // shaped -- the keeper must read height as well as direction.
    const cols: Col[] = ['L', 'M', 'R']
    const rows: Row[] = ['U', 'D']
    return { col: cols[Math.floor(ctx.random() * 3)], row: rows[Math.floor(ctx.random() * 2)] }
  },

  reduce(s, action, ctx): State {
    if (s.phase === 'won') return ctx.reject('game-over')

    if (s.phase === 'setup') {
      const idx = s.players.indexOf(ctx.actor)
      if (idx < 0) return ctx.reject('not-your-turn')
      const seat = idx as 0 | 1
      if (s.orders[seat] !== null) return ctx.reject('already-set')
      const order = (action as { order?: unknown }).order
      if (!isOrder(order)) return ctx.reject('invalid-order')

      const orders = [...s.orders] as [number[] | null, number[] | null]
      orders[seat] = order
      const bothSet = orders[0] !== null && orders[1] !== null
      return {
        ...s,
        orders,
        phase: bothSet ? 'shooting' : 'setup',
        side: bothSet ? 0 : seat === 0 ? 1 : 0,
        moves: s.moves + 1,
      }
    }

    // phase === 'shooting'
    if (s.pendingKick === null) {
      // awaiting the kick from s.shooterSeat
      if (ctx.actor !== s.players[s.shooterSeat]) return ctx.reject('not-your-turn')
      const { col, row } = action as { col?: unknown; row?: unknown }
      if (!isCol(col) || !isRow(row)) return ctx.reject('invalid-target')
      const keeperSeat: 0 | 1 = s.shooterSeat === 0 ? 1 : 0
      return { ...s, pendingKick: { col, row }, side: keeperSeat, moves: s.moves + 1 }
    }

    // awaiting the blind save guess from the other seat
    const keeperSeat: 0 | 1 = s.shooterSeat === 0 ? 1 : 0
    if (ctx.actor !== s.players[keeperSeat]) return ctx.reject('not-your-turn')
    const { col, row } = action as { col?: unknown; row?: unknown }
    if (!isCol(col) || !isRow(row)) return ctx.reject('invalid-guess')

    const power = powerAt(s, s.shooterSeat)

    // 1) does the shot even reach the goal? Rolled first, independent of the
    //    keeper's guess -- a wide shot can never be saved OR scored off a
    //    lucky guess, it just misses.
    const wide = ctx.random() < MISS_TABLE[power]!
    let outcome: Outcome
    if (wide) {
      outcome = 'wide'
    } else {
      // 2) on target -- column match is required for ANY save chance. Given
      //    a column match, a full match (row also correct) uses the plain
      //    SAVE_TABLE; a partial match (row wrong) uses that same curve
      //    scaled down by partialSaveDiscount() -- see file header for why
      //    this must be a scale of SAVE_TABLE and not a flat constant.
      const colMatched = col === s.pendingKick.col
      const rowMatched = row === s.pendingKick.row
      const saveChance = !colMatched ? 0 : rowMatched ? SAVE_TABLE[power]! : SAVE_TABLE[power]! * partialSaveDiscount(s.pendingKick.col)
      const saved = saveChance > 0 && ctx.random() < saveChance
      outcome = saved ? 'saved' : 'goal'
    }

    const score: [number, number] = [...s.score]
    if (outcome === 'goal') score[s.shooterSeat] += 1

    const history: ShotRecord[] = [
      ...s.history,
      {
        round: s.round,
        shooterSeat: s.shooterSeat,
        power,
        col: s.pendingKick.col,
        row: s.pendingKick.row,
        keeperCol: col,
        keeperRow: row,
        outcome,
      },
    ]

    let round = s.round
    let shooterSeat: 0 | 1 = keeperSeat // the other seat kicks next
    let phase: State['phase'] = 'shooting'
    let winner: string | undefined

    if (s.shooterSeat === 1) {
      // second half of the round just resolved -> round complete
      round = s.round + 1
      shooterSeat = 0
      if (round >= REGULATION_ROUNDS) {
        if (score[0] !== score[1]) {
          phase = 'won'
          winner = score[0] > score[1] ? s.players[0] : s.players[1]
        } else if (round > SUDDEN_DEATH_ROUND_CAP) {
          phase = 'won' // still tied past the safety cap -> draw
          winner = undefined
        }
      }
    }

    return {
      ...s,
      pendingKick: null,
      score,
      history,
      round,
      shooterSeat,
      side: shooterSeat,
      phase,
      winner,
      moves: s.moves + 1,
    }
  },

  terminal: (s) => (s.phase === 'won' ? { done: true, winner: s.winner ?? null } : { done: false }),

  score(s): Record<string, number> {
    if (s.phase !== 'won') return { [s.players[0]]: 0, [s.players[1]]: 0 }
    if (!s.winner) return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
    const loser = s.players.find((p) => p !== s.winner) ?? s.players[1]
    return { [s.winner]: 1, [loser]: 0 }
  },

  render(s, ctx?: RenderCtx): RenderSpec {
    const viewer = ctx?.viewer
    const viewerSeat = s.players.indexOf(viewer ?? '') as 0 | 1 | -1

    // The pending (uncommitted) kick target is a secret: only the shooter who
    // just chose it may see it in their own frame. Everyone else (the keeper
    // who must guess blind, and any spectator) never sees it until resolved.
    const myPendingTarget = s.pendingKick && viewerSeat === s.shooterSeat ? s.pendingKick : null

    const frame = {
      layout: 'custom' as const,
      game: 'penalty-shootout',
      phase: s.phase,
      viewerSeat,
      players: s.players,
      orderSet: [s.orders[0] !== null, s.orders[1] !== null] as [boolean, boolean],
      nicknames: s.nicknames, // flavor only, never secret
      round: s.round,
      isSuddenDeath: s.round >= REGULATION_ROUNDS,
      shooterSeat: s.shooterSeat,
      awaitingSave: s.pendingKick !== null,
      myPendingTarget,
      score: s.score,
      history: s.history,
      winner: s.winner,
      moves: s.moves,
    }
    return frame as unknown as RenderSpec
  },
})
