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
 * Turn-based pace: each agent submits one action and `reduce` advances one step.
 * Illegal moves are rejected with `ctx.reject('code')`.
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

export default defineGame<State, Record<string, number>>({
  meta: {
    type: 'liars-dice',
    players: { min: NUM, max: NUM },
    pace: 'turn-based',
    paces: ['turn-based'],
    turnTimeoutSec: 45,
    maxSteps: 500,
    hiddenInfo: true,
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
    eliminationOrder: [],
    finisher: -1,
  }),

  reduce: (s, action, ctx: Ctx): State => {
    if (s.phase === 'done') ctx.reject('game-over')
    const seat = s.players.indexOf(ctx.actor)
    if (seat < 0) ctx.reject('not-a-player')
    if (!s.alive[seat]) ctx.reject('not-alive')
    if (seat !== s.turn) ctx.reject('not-your-turn')

    const a = action as { bid?: { count?: unknown; face?: unknown }; challenge?: unknown }

    // —— raise the bid ——
    if (a.bid !== undefined) {
      const count = a.bid.count
      const face = a.bid.face
      if (!Number.isInteger(count) || !Number.isInteger(face)) ctx.reject('bad-bid')
      const c = count as number
      const f = face as number
      if (f < 1 || f > 6 || c < 1) ctx.reject('bad-bid')
      if (c > livingDice(s)) ctx.reject('impossible-bid') // can't claim more dice than exist
      const next: Bid = { count: c, face: f }
      if (!raises(s.bid, next)) ctx.reject('bad-bid') // must strictly out-bid the standing bid
      const turn = nextAlive(seat, s.alive)
      const lastBid = [...s.lastBid]
      lastBid[seat] = next
      return { ...s, bid: next, bidder: seat, lastBid, turn, side: turn, reveal: null }
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

      // Next round: re-roll every living cup; the loser leads (or the next living
      // seat if the loser was just knocked out).
      const rolled = dice.map((d, i) => (alive[i] ? roll(d.length, ctx) : d))
      const turn = alive[loser] ? loser : nextAlive(loser, alive)
      return {
        ...s,
        dice: rolled,
        alive,
        eliminationOrder,
        reveal,
        bid: null,
        bidder: -1,
        lastBid: [null, null, null], // fresh round → clear each seat's shown bid
        turn,
        side: turn,
        round: s.round + 1,
      }
    }

    return ctx.reject('bad-action')
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
   * A weak, fully deterministic heuristic so `pnpm sim`/`preview` can self-play
   * (AGENTS.md SHOULD). It reads ONLY the mover's own cup + public state — never
   * `ctx.random` — so it can't desync the re-roll RNG shared by `reduce`.
   */
  play: (s, _p, _ctx): Action => {
    const seat = s.turn
    const mine = s.dice[seat]!
    const others = livingDice(s) - mine.length

    // How many of `face` I can see in my own cup (my 1s are wild for non-1 faces).
    const mineOf = (face: number): number => mine.filter((d) => d === face || d === WILD).length
    // Expected total of `face` on the table: my known dice + others' share.
    const expected = (face: number): number => mineOf(face) + others * (face === WILD ? 1 / 6 : 2 / 6)

    // My strongest face (most in hand); tie-break to the lower face for determinism.
    let fav = 2
    for (const f of FACES) if (mineOf(f) > mineOf(fav)) fav = f

    if (s.bid) {
      // Challenge when the standing bid clearly exceeds what we'd expect to exist.
      if (s.bid.count > expected(s.bid.face) + 1) return { challenge: true }
      const total = livingDice(s)
      // Prefer a same-count bump onto a higher face we like; else raise the count;
      // else nudge the face up at the (already max) count; else nothing legal → challenge.
      if (fav > s.bid.face) return { bid: { count: s.bid.count, face: fav } }
      if (s.bid.count < total) return { bid: { count: s.bid.count + 1, face: fav } }
      if (s.bid.face < 6) return { bid: { count: s.bid.count, face: s.bid.face + 1 } }
      return { challenge: true }
    }

    // Opening bid: claim a modest, defensible count on our strongest face.
    const count = Math.max(1, Math.min(Math.floor(expected(fav)), livingDice(s)))
    return { bid: { count, face: fav } }
  },

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
      lastBid: s.lastBid,
      reveal: s.reveal,
      seats,
      panels: [{ type: 'status' as const, text: status }],
    }
    return frame as unknown as RenderSpec
  },
})

// Re-exported for tests.
export type { State, Bid, Reveal }
export type { Action }
