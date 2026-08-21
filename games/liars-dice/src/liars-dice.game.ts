/**
 * Liar's Dice — 3-player, hidden-information bluffing dice game.
 *
 * Every player has a cup of 5 dice only they can see. On your turn you either
 * RAISE the standing bid (`{bid:{count,face}}` = "at least `count` dice across ALL
 * cups show `face`") or CHALLENGE it (`{challenge:true}`). A challenge opens every
 * cup: count all dice equal to the bid's face PLUS all dice showing 1 (WILD). If
 * the real count meets the bid, the challenger loses a die; otherwise the bidder
 * loses a die. Lose your last die and you're out. Last player standing wins.
 *
 * Both paces from one definition (like gomoku):
 *  - turn-based (the default): each agent submits one action and `reduce`
 *    advances one step. Illegal moves are rejected with `ctx.reject('code')`.
 *  - strategy: each agent submits `params` once and the match settles headless.
 *    `play` turns those knobs into a bid or a challenge; `apply` advances.
 * Both paces share ONE rule kernel (`step`) so a strategy match and a turn-based
 * match cannot drift apart on what is legal.
 *
 * Strategy pace and hidden information: `play` is handed the FULL State, every
 * cup included, and the engine does not mask it. So `play` reads a `View` built
 * by `maskFor(state, seat)` — the mover's own cup plus public knowledge — and
 * never the State itself. That indirection is the only thing standing between a
 * bluffing game and open dice; see the note above `View`.
 *
 * Hidden info (`meta.hiddenInfo`): `render(state, ctx)` is viewer-scoped — you see
 * only your own cup mid-game; the no-viewer public frame omits every living cup.
 * The just-opened cups from the last challenge are public (they were revealed),
 * and everything is revealed once the game is over. Author logic only ever sees
 * opaque agent ids; the view attaches names/avatars via `onPlayers`.
 *
 * All logic is deterministic — the only randomness is `ctx.random` (the rolls).
 */
import { defineGame, type Action, type Ctx, type RenderCtx, type RenderSpec } from '@arena/game-sdk'

const NUM = 3
const DICE_PER = 5
const WILD = 1 // 1s count as any face when a challenge is resolved
const FACES = [1, 2, 3, 4, 5, 6] as const

interface Bid {
  count: number
  face: number // 1..6
}

/** The outcome of the most recent challenge — public (cups were opened). */
interface Reveal {
  challenger: number
  bidder: number
  bid: Bid
  actual: number // real count of `bid.face` (+ wild 1s) across all living cups
  dice: number[][] // snapshot of every living cup at the moment it was opened
  loser: number
  eliminated: number | null // seat knocked out by this challenge, if any
}

interface State {
  phase: 'playing' | 'done'
  players: [string, string, string] // opaque agent ids; display identity is the view's job
  dice: number[][] // seat → die faces 1..6 (HIDDEN — filtered by render)
  alive: boolean[] // seat → still has dice
  bid: Bid | null // current standing bid (public)
  bidder: number // seat that set `bid`, -1 when the round is fresh
  lastBid: Array<Bid | null> // seat → their latest bid THIS round (for the UI), reset each round
  turn: number // whose move it is
  side: number // mirror of `turn` for SDK convention
  round: number // increments each time cups are re-rolled
  reveal: Reveal | null // most recent open-cup result (public)
  /**
   * A challenge has resolved and the next round has NOT been opened yet.
   *
   * The challenge used to do both at once, and the single state it returned
   * carried the opened cups AND the next round already under way — re-rolled,
   * `round` incremented, a new seat to act. Since the platform records one frame
   * per step, that made one frame mean three things, and a replay showed a seat
   * bid and then jumped to a different seat opening a later round, with the
   * "LIAR?" moment labelled as the round after the one it settled.
   *
   * So the challenge stops at its own outcome, and `openRound` starts the next
   * round on the next action. One step, one thing that happened.
   */
  pendingRoll: boolean
  eliminationOrder: number[] // seats in the order they were knocked out
  finisher: number // winning seat once done, -1 while unfinished
}

/** Roll `n` dice in 1..6. The ONLY source of randomness. */
function roll(n: number, ctx: Ctx): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(1 + Math.floor(ctx.random() * 6))
  return out
}

/** Total dice still on the table (across living cups). */
function livingDice(s: State): number {
  let t = 0
  for (let seat = 0; seat < NUM; seat++) if (s.alive[seat]) t += s.dice[seat]!.length
  return t
}

/** Next living seat strictly clockwise from `from`. */
function nextAlive(from: number, alive: boolean[]): number {
  for (let i = 1; i <= NUM; i++) {
    const seat = (from + i) % NUM
    if (alive[seat]) return seat
  }
  return from // unreachable while >1 alive
}

/** Real count of `face` across living cups, with 1s wild (1s don't double-count). */
function tally(s: State, face: number): number {
  let n = 0
  for (let seat = 0; seat < NUM; seat++) {
    if (!s.alive[seat]) continue
    for (const d of s.dice[seat]!) if (d === face || d === WILD) n++
  }
  return n
}

/** A bid is a legal raise iff it strictly exceeds the previous one (count, then face). */
function raises(prev: Bid | null, next: Bid): boolean {
  if (!prev) return true
  if (next.count > prev.count) return true
  return next.count === prev.count && next.face > prev.face
}

// ———————————————————————————————————————————————————————————————————————————
// Strategy pace — the masked view and the knob-driven policy
// ———————————————————————————————————————————————————————————————————————————

// A type alias, not an interface: only an alias of an object literal gets TS's
// implicit index signature, which is what lets these knobs satisfy the testkit's
// `P extends Record<string, number>` without a cast at every call.
type Params = {
  /** How many dice you'll invent when you raise. 0 = only claim what you can justify. */
  bluff: number
  /** How readily you call a lie. 1 = challenge any bid above your own estimate. */
  skepticism: number
  /** Pull toward bidding faces you actually hold, rather than the cheapest raise. */
  faceLoyalty: number
  /** How much you count other people's 1s as wild. 1 = the true 1/6; 0 = ignore them. */
  wildTrust: number
  /** How high you open a fresh round: 0 = under your estimate, 1 = over it. */
  openStrength: number
  /** How far running out of dice pushes you toward gambling (bluff + challenge both rise). */
  endgamePressure: number
}

/**
 * Everything ONE seat is allowed to know: its own cup, plus what every player
 * can see anyway (dice counts and the standing bid).
 *
 * This exists because the engine does not mask State for `play`. A policy handed
 * the raw State could read all three cups and would never lose a challenge —
 * strategy pace would be open dice with extra steps. So the policy takes a
 * `View`, and `maskFor` is the only place a cup is read. Keep it that way: if a
 * future heuristic reaches back into `State`, the game is quietly broken in a way
 * no test of the RULES would catch.
 */
interface View {
  me: number
  /** The mover's own cup. */
  mine: number[]
  /** Living dice under cups the mover cannot see. */
  unseen: number
  /** Seat → dice remaining (public; eliminated seats read 0). */
  counts: number[]
  /** Living dice on the table (public). */
  total: number
  /** The standing bid (public), or null on a fresh round. */
  bid: Bid | null
}

function maskFor(s: State, me: number): View {
  const counts = s.dice.map((d, seat) => (s.alive[seat] ? d.length : 0))
  const total = counts.reduce((a, b) => a + b, 0)
  return {
    me,
    mine: s.alive[me] ? [...s.dice[me]!] : [],
    unseen: total - counts[me]!,
    counts,
    total,
    bid: s.bid ? { ...s.bid } : null,
  }
}

/** Widest lie a fully trusting seat (`skepticism: 0`) lets stand, in dice (~2σ at a full table). */
const MAX_TOLERANCE = 3
/** Dice a fully bold seat (`bluff: 1`) will invent out of nothing to keep bidding. */
const MAX_OVERCLAIM = 3
/** Rounding room even an honest seat allows itself before folding to a challenge. */
const HONEST_SLACK = 0.75

/** How many `face` the mover can see in its own cup (own 1s are wild). */
function mineOf(v: View, face: number): number {
  return v.mine.filter((d) => d === face || d === WILD).length
}

/**
 * Expected total of `face` on the table = what I hold + a share of what I can't
 * see. A non-1 face lands on an unseen die 1/6 of the time as itself and 1/6 as a
 * wild 1, so `wildTrust` slides the per-die share between 1/6 and 2/6.
 */
function expected(v: View, face: number, p: Params): number {
  const share = face === WILD ? 1 / 6 : (1 + p.wildTrust) / 6
  return mineOf(v, face) + v.unseen * share
}

/** 0 = holding my own against the table; →1 = down to scraps while a rival is stacked. */
function desperation(v: View): number {
  const mine = v.mine.length
  let rival = 0
  for (let seat = 0; seat < NUM; seat++) {
    if (seat !== v.me && v.counts[seat]! > rival) rival = v.counts[seat]!
  }
  if (rival <= 0 || mine >= rival) return 0
  return (rival - mine) / rival
}

/** Lift a knob toward 1 as the short stack runs out of dice (see `endgamePressure`). */
function pressured(base: number, v: View, p: Params): number {
  return base + (1 - base) * p.endgamePressure * desperation(v)
}

/** Dice-worth of lie the mover lets stand before calling it. */
const tolerance = (v: View, p: Params): number => MAX_TOLERANCE * (1 - pressured(p.skepticism, v, p))
/** Dice-worth of lie the mover is willing to tell. */
const boldness = (v: View, p: Params): number => pressured(p.bluff, v, p)

/**
 * Every legal raise worth considering: same count on a higher face, or up to two
 * counts higher on any face. Two is enough to jump a face you like without
 * opening a ladder that never converges — and the window is what bounds a round.
 */
function legalRaises(v: View): Bid[] {
  const b = v.bid!
  const out: Bid[] = []
  for (let face = b.face + 1; face <= 6; face++) out.push({ count: b.count, face })
  for (let count = b.count + 1; count <= Math.min(b.count + 2, v.total); count++) {
    for (const face of FACES) out.push({ count, face })
  }
  return out
}

/** Score a candidate raise: hold what you bid, don't invent more than you dare. */
function rankBid(v: View, p: Params, cand: Bid): number {
  const over = Math.max(0, cand.count - expected(v, cand.face, p))
  const bold = boldness(v, p)
  return (
    p.faceLoyalty * mineOf(v, cand.face) - // bid a face you actually hold
    (2 - bold) * over - // inventing dice costs less the bolder you are
    (1 - bold) * 0.5 * (cand.count - v.bid!.count) // so does burning bidding space
  )
}

/** The face with the highest expected total — folds in `wildTrust`, so 1s must be earned. */
function favouriteFace(v: View, p: Params): number {
  let fav: number = FACES[0]
  let best = -Infinity
  for (const face of FACES) {
    const e = expected(v, face, p)
    if (e > best + 1e-9) {
      best = e
      fav = face
    }
  }
  return fav
}

/** Opening claim on a fresh round: `openStrength` slides it ±1 around the honest estimate. */
function openingBid(v: View, p: Params): Bid {
  const face = favouriteFace(v, p)
  const count = Math.round(expected(v, face, p) - 1 + 2 * p.openStrength)
  return { count: Math.max(1, Math.min(v.total, count)), face }
}

/**
 * The policy. Reads a `View` — never a `State` — and never `ctx.random`, so it
 * cannot shift the re-roll stream `step` draws from.
 *
 * Terminates by construction: a raise strictly increases `(count, face)`, count
 * is capped at the dice in play, and once no legal raise is left the only move
 * returned is a challenge — which always removes a die.
 */
function decide(v: View, p: Params): Action {
  if (!v.bid) return { bid: openingBid(v, p) }

  const raiseOptions = legalRaises(v)
  if (raiseOptions.length === 0) return { challenge: true } // count and face both maxed

  // Does the standing bid claim more dice than I think exist?
  if (v.bid.count - expected(v, v.bid.face, p) > tolerance(v, p)) return { challenge: true }

  let best = raiseOptions[0]!
  let bestScore = -Infinity
  for (const cand of raiseOptions) {
    const score = rankBid(v, p, cand)
    if (score > bestScore) {
      // Candidates are generated in ascending (count, face), so `>` breaks ties
      // toward the cheapest raise — deterministically, with no RNG.
      bestScore = score
      best = cand
    }
  }

  // Even my best raise would mean inventing more dice than I'm willing to lie
  // about. An honest seat calls here instead of talking itself into a bad bid.
  const cost = Math.max(0, best.count - expected(v, best.face, p))
  if (cost > HONEST_SLACK + MAX_OVERCLAIM * boldness(v, p)) return { challenge: true }

  return { bid: best }
}

/**
 * Open the round a resolved challenge left pending: re-roll every living cup,
 * count the round, and clear the challenge that ended the last one.
 *
 * The ONLY caller is `step`, and only after the incoming action has been found
 * legal. That order matters: `roll` draws from `ctx.random`, and drawing before a
 * `ctx.reject` would advance the random stream on an action that never happened,
 * so a replay of the same match would deal different dice.
 */
function openRound(s: State, ctx: Ctx): State {
  if (!s.pendingRoll) return s
  return {
    ...s,
    dice: s.dice.map((d, i) => (s.alive[i] ? roll(d.length, ctx) : d)),
    pendingRoll: false,
    reveal: null,
    round: s.round + 1,
    lastBid: [null, null, null], // fresh round → clear each seat's shown bid
  }
}

/**
 * The rule kernel both paces run on. `seat` is the mover — resolved from
 * `ctx.actor` in turn-based pace, from `state.turn` in strategy pace — and is
 * already known to be the seat whose turn it is.
 */
function step(s: State, seat: number, action: Action, ctx: Ctx): State {
  const a = action as { bid?: { count?: unknown; face?: unknown }; challenge?: unknown }

  // —— raise the bid ——
  if (a.bid !== undefined) {
    const count = a.bid.count
    const face = a.bid.face
    if (!Number.isInteger(count) || !Number.isInteger(face)) ctx.reject('bad-bid')
    const c = count as number
    const f = face as number
    if (f < 1 || f > 6 || c < 1) ctx.reject('bad-bid')
    // Every check here reads dice COUNTS and the standing bid, never a face, so
    // it gives the same answer before and after a pending re-roll — which is what
    // lets the whole action be validated before any randomness is drawn.
    if (c > livingDice(s)) ctx.reject('impossible-bid') // can't claim more dice than exist
    const next: Bid = { count: c, face: f }
    if (!raises(s.bid, next)) ctx.reject('bad-bid') // must strictly out-bid the standing bid

    const open = openRound(s, ctx)
    const turn = nextAlive(seat, open.alive)
    const lastBid = [...open.lastBid]
    lastBid[seat] = next
    return { ...open, bid: next, bidder: seat, lastBid, turn, side: turn, reveal: null }
  }

  // —— challenge the standing bid ——
  if (a.challenge === true) {
    if (!s.bid) ctx.reject('nothing-to-challenge')
    const bid = s.bid
    const bidder = s.bidder
    const actual = tally(s, bid.face)
    const held = actual >= bid.count // did the bid hold up?
    const loser = held ? seat : bidder // challenger loses if the bid held; else the bidder
    const snapshot = s.dice.map((d, i) => (s.alive[i] ? [...d] : []))

    const dice = s.dice.map((d, i) => (i === loser ? d.slice(1) : d)) // loser drops one die
    const alive = [...s.alive]
    const eliminationOrder = [...s.eliminationOrder]
    let eliminated: number | null = null
    if (dice[loser]!.length === 0) {
      alive[loser] = false
      eliminationOrder.push(loser)
      eliminated = loser
    }

    const reveal: Reveal = { challenger: seat, bidder, bid, actual, dice: snapshot, loser, eliminated }

    const remaining = alive.filter(Boolean).length
    if (remaining <= 1) {
      const finisher = alive.indexOf(true)
      return { ...s, phase: 'done', dice, alive, eliminationOrder, reveal, finisher, bid: null, bidder: -1 }
    }

    /**
     * Stop at the outcome. The cups are open, a die is gone, and this round is
     * over — but the next one has not started: no re-roll, `round` unchanged, and
     * `lastBid` still holding what each seat claimed, so the frame this produces
     * can show what was bid alongside what was actually on the table.
     *
     * `openRound` does the rest on the leader's next action. The loser leads, or
     * the next living seat if the loser was just knocked out.
     */
    const turn = alive[loser] ? loser : nextAlive(loser, alive)
    return {
      ...s,
      dice,
      alive,
      eliminationOrder,
      reveal,
      pendingRoll: true,
      bid: null,
      bidder: -1,
      turn,
      side: turn,
    }
  }

  return ctx.reject('bad-action')
}

export default defineGame<State, Params>({
  meta: {
    type: 'liars-dice',
    players: { min: NUM, max: NUM },
    pace: 'turn-based', // the native mode; a competition can pick 'strategy' instead
    paces: ['strategy', 'turn-based'],
    turnTimeoutSec: 45,
    submitWindowSec: 600,
    // Above the structural worst case, so hitting it means a policy stalled
    // rather than a match being cut off: a round's bid ladder is bounded by the
    // 6 faces times the counts a bid can climb before every seat challenges
    // (~12 at a full table), and there are at most 13 dice to lose.
    maxSteps: 1000,
    hiddenInfo: true,
  },

  params: {
    bluff: { min: 0, max: 1, default: 0.4 },
    skepticism: { min: 0, max: 1, default: 0.5 },
    faceLoyalty: { min: 0, max: 1, default: 0.5 },
    wildTrust: { min: 0, max: 1, default: 0.8 },
    openStrength: { min: 0, max: 1, default: 0.5 },
    endgamePressure: { min: 0, max: 1, default: 0.4 },
  },

  init: (cfg, ctx): State => ({
    phase: 'playing',
    players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1', cfg.players[2] ?? 'p2'],
    dice: [roll(DICE_PER, ctx), roll(DICE_PER, ctx), roll(DICE_PER, ctx)],
    alive: [true, true, true],
    bid: null,
    bidder: -1,
    lastBid: [null, null, null],
    turn: 0,
    side: 0,
    round: 1,
    reveal: null,
    pendingRoll: false,
    eliminationOrder: [],
    finisher: -1,
  }),

  // —— turn-based pace ——
  // The engine does NOT check `ctx.actor` for us: without the seat checks below,
  // any registered agent could act as whichever seat holds the move.
  reduce: (s, action, ctx: Ctx): State => {
    if (s.phase === 'done') ctx.reject('game-over')
    const seat = s.players.indexOf(ctx.actor)
    if (seat < 0) ctx.reject('not-a-player')
    if (!s.alive[seat]) ctx.reject('not-alive')
    if (seat !== s.turn) ctx.reject('not-your-turn')
    return step(s, seat, action, ctx)
  },

  // —— strategy pace ——
  // The mover is `state.turn` (kept identical to `state.side`, which is what the
  // engine reads to route this seat's params into `play`). There is no submitter
  // to authenticate here — the action came from `play` — so the only checks left
  // are the ones about the action itself, inside `step`.
  apply: (s, action, ctx: Ctx): State => {
    if (s.phase === 'done') ctx.reject('game-over')
    if (!s.alive[s.turn]) ctx.reject('not-alive')
    return step(s, s.turn, action, ctx)
  },

  terminal: (s) => (s.phase === 'done' ? { done: true, winner: s.players[s.finisher] ?? null } : { done: false }),

  score: (s): Record<string, number> => {
    // Elimination-rank gradient in 0..NUM-1: outlasting more players scores higher.
    // Robust to a non-terminal state (maxSteps cap): survivors rank above everyone
    // eliminated, ordered by dice remaining. When done there's exactly one survivor
    // (the finisher), so it collapses to elimination order with the winner top.
    const survivors: number[] = []
    for (let seat = 0; seat < NUM; seat++) if (s.alive[seat]) survivors.push(seat)
    survivors.sort((a, b) => s.dice[a]!.length - s.dice[b]!.length || a - b) // fewer dice = worse
    const worstToBest = [...s.eliminationOrder, ...survivors]
    const out: Record<string, number> = {}
    worstToBest.forEach((seat, rank) => {
      out[s.players[seat]!] = rank
    })
    return out
  },

  /**
   * The mover's action under its own knobs. This is the whole of strategy pace,
   * and it also drives `pnpm sim` / `pnpm preview` for the turn-based build.
   *
   * `maskFor` first, on purpose: the State it is handed contains all three cups,
   * and everything after this line can only see one.
   */
  play: (s, p): Action => decide(maskFor(s, s.turn), p),

  render: (s, ctx?: RenderCtx): RenderSpec => {
    const viewer = ctx?.viewer
    const revealAll = s.phase === 'done' // game over → open every cup

    const seats = s.dice.map((d, seat) => {
      const base = {
        seat,
        alive: s.alive[seat]!,
        count: d.length,
        isTurn: seat === s.turn && s.phase !== 'done',
        isWinner: revealAll && seat === s.finisher,
      }
      // Reveal a cup to its owner mid-game; reveal ALL cups once the game is over.
      return revealAll || s.players[seat] === viewer ? { ...base, dice: [...d] } : base
    })

    let status: string
    if (s.phase === 'done') {
      status = `Seat ${s.finisher} wins`
    } else if (s.pendingRoll && s.reveal) {
      // The round that just ENDED — this frame is the challenge being settled,
      // not the next round. It used to read "Round <next> · Seat N to open",
      // which named the wrong round and said nothing about the challenge that
      // was on screen.
      const r = s.reveal
      const fate = r.eliminated !== null ? `Seat ${r.loser} loses last die — out` : `Seat ${r.loser} loses a die`
      status =
        `Round ${s.round} · Seat ${r.challenger} challenges ${r.bid.count}×${r.bid.face} · ` +
        `${r.actual} on the table · ${fate}`
    } else if (s.bid) {
      status = `Round ${s.round} · Seat ${s.bidder} bids ${s.bid.count}×${s.bid.face} · Seat ${s.turn} to act`
    } else {
      status = `Round ${s.round} · Seat ${s.turn} to open`
    }

    // Custom frame consumed by view.ts. RenderSpec has no free-form data slot, so
    // we attach our fields and cast; the platform delivers the whole object as the
    // frame. `panels` is a declarative fallback for renderers without our view.
    const frame = {
      layout: 'custom' as const,
      game: 'liars-dice',
      phase: s.phase,
      round: s.round,
      turn: s.turn,
      bidder: s.bidder,
      bid: s.bid,
      // Lets the view hold the open-cup beat on its own, rather than inferring
      // it from `reveal` being present on a frame that had already moved on.
      pendingRoll: s.pendingRoll,
      lastBid: s.lastBid,
      reveal: s.reveal,
      seats,
      panels: [{ type: 'status' as const, text: status }],
    }
    return frame as unknown as RenderSpec
  },
})

// Re-exported for tests.
export type { State, Bid, Reveal, Params, View }
export type { Action }

/**
 * Internals the tests pin directly. Exported so the masking rule can be checked
 * as a rule — `maskFor` must not carry another seat's cup — instead of being left
 * to a comment.
 */
export const __policy = { maskFor, decide, expected, legalRaises, favouriteFace }
