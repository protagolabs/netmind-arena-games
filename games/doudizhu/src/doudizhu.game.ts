/**
 * Doudizhu (Fight the Landlord) — 3-player, hidden-information, team card game.
 *
 * One player becomes the LANDLORD, the other two are PEASANTS who
 * cooperate. Turn-based pace: each agent submits one action (`{bid}` during the
 * call, then `{cards}` / `{pass}` during play) and `reduce` advances one step.
 *
 * Hidden info (`meta.hiddenInfo`): `render(state, ctx)` is viewer-scoped — you
 * see your own hand, opponents show only a card count. The no-viewer public
 * render omits every hand. Author logic only ever sees opaque agent ids; the
 * view attaches names/avatars from the platform via `onPlayers`.
 *
 * All logic is deterministic — the only randomness is `ctx.random` (the shuffle).
 */
import { defineGame, type Action, type Ctx, type RenderCtx, type RenderSpec } from '@arena/game-sdk'
import { classify, beats, rankLabel, SMALL_JOKER, BIG_JOKER, type Combo } from './combos'

interface TablePlay {
  seat: number
  cards: number[]
  combo: Combo
}

interface State {
  phase: 'bidding' | 'playing' | 'done'
  players: [string, string, string] // opaque agent ids; display identity is the view's job (onPlayers)
  hands: number[][] // seat → sorted rank multiset
  bottom: number[] // the 3 bottom cards
  bottomRevealed: boolean
  bids: number[] // seat → bid (0..3), -1 = not yet acted
  turn: number
  side: number // mirror of `turn` for SDK convention
  landlord: number // -1 until decided
  multiplier: number // stake: bid value, doubled by each bomb/rocket
  table: TablePlay | null // current play others must beat; null = free lead
  trick: Array<number[] | 'pass' | null> // each seat's latest action THIS trick (for "in front of you" display)
  passes: number // consecutive passes since the last real play
  peasantPlayed: boolean // did any peasant ever play? (spring detection)
  landlordPlays: number // how many times the landlord played (anti-spring)
  finisher: number // seat that emptied its hand; -1 while unfinished
}

const NUM = 3

function buildDeck(): number[] {
  const d: number[] = []
  for (let r = 3; r <= 15; r++) for (let i = 0; i < 4; i++) d.push(r)
  d.push(SMALL_JOKER, BIG_JOKER)
  return d
}

function shuffle(deck: number[], ctx: Ctx): number[] {
  const a = [...deck]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.random() * (i + 1))
    const t = a[i]!
    a[i] = a[j]!
    a[j] = t
  }
  return a
}

const sortRanks = (xs: number[]): number[] => [...xs].sort((a, b) => a - b)

/** Does `hand` contain every card in `cards` (as a multiset)? */
function ownsAll(hand: number[], cards: number[]): boolean {
  const c = new Map<number, number>()
  for (const r of hand) c.set(r, (c.get(r) ?? 0) + 1)
  for (const r of cards) {
    const left = (c.get(r) ?? 0) - 1
    if (left < 0) return false
    c.set(r, left)
  }
  return true
}

/** Remove one occurrence of each card in `cards` from `hand`; returns a new sorted hand. */
function removeCards(hand: number[], cards: number[]): number[] {
  const out = [...hand]
  for (const r of cards) {
    const i = out.indexOf(r)
    if (i >= 0) out.splice(i, 1)
  }
  return sortRanks(out)
}

const cardsLabel = (cards: number[]): string => sortRanks(cards).map(rankLabel).join(' ')

/** Resolve the bidding phase into a landlord + stake and start play. Pure. */
function startPlay(s: State): State {
  let landlord = 0
  let bid = 1 // default when everyone passes: seat 0 farms at stake 1
  let high = 0
  for (let seat = 0; seat < NUM; seat++) {
    const b = s.bids[seat]!
    if (b > high) {
      high = b
      landlord = seat
      bid = b
    }
  }
  const hands = s.hands.map((h, seat) => (seat === landlord ? sortRanks([...h, ...s.bottom]) : h))
  return {
    ...s,
    phase: 'playing',
    hands,
    bottomRevealed: true,
    landlord,
    multiplier: bid,
    turn: landlord,
    side: landlord,
    table: null,
    trick: [null, null, null],
    passes: 0,
  }
}

export default defineGame<State, Record<string, number>>({
  meta: {
    type: 'doudizhu',
    players: { min: 3, max: 3 },
    pace: 'turn-based',
    paces: ['turn-based'],
    turnTimeoutSec: 60,
    maxSteps: 300,
    hiddenInfo: true,
  },

  init: (cfg, ctx): State => {
    const deck = shuffle(buildDeck(), ctx)
    return {
      phase: 'bidding',
      players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1', cfg.players[2] ?? 'p2'],
      hands: [sortRanks(deck.slice(0, 17)), sortRanks(deck.slice(17, 34)), sortRanks(deck.slice(34, 51))],
      bottom: deck.slice(51, 54),
      bottomRevealed: false,
      bids: [-1, -1, -1],
      turn: 0,
      side: 0,
      landlord: -1,
      multiplier: 0,
      table: null,
      trick: [null, null, null],
      passes: 0,
      peasantPlayed: false,
      landlordPlays: 0,
      finisher: -1,
    }
  },

  // Self-play heuristic — used ONLY by `pnpm sim` / `pnpm preview` for a local
  // demo match. This is a turn-based game: the platform advances it via `reduce`
  // and NEVER calls `play`, so this affects nothing in production. It just needs
  // to return a LEGAL move every turn so a full match can be simulated.
  play: (s) => {
    const seat = s.turn
    if (s.phase === 'bidding') return { bid: 0 } // all pass → seat 0 farms at stake 1
    const hand = s.hands[seat] ?? []
    if (!s.table) return { cards: [hand[0]!] } // leading: play the lowest single
    for (const r of hand) {
      const combo = classify([r]) // following: lowest single that beats, else pass
      if (combo && beats(s.table.combo, combo)) return { cards: [r] }
    }
    return { pass: true }
  },

  reduce: (s, action, ctx: Ctx): State => {
    if (s.phase === 'done') ctx.reject('game-over')
    const seat = s.players.indexOf(ctx.actor)
    if (seat < 0) ctx.reject('not-a-player')
    if (seat !== s.turn) ctx.reject('not-your-turn')

    // —— bidding ——
    if (s.phase === 'bidding') {
      const bid = (action as { bid?: number }).bid
      if (!Number.isInteger(bid) || bid! < 0 || bid! > 3) ctx.reject('bad-bid')
      const high = Math.max(0, ...s.bids.filter((b) => b >= 0))
      if (bid !== 0 && bid! <= high) ctx.reject('bad-bid') // a non-pass bid must raise
      const bids = [...s.bids]
      bids[seat] = bid!
      const next: State = { ...s, bids }
      const acted = bids.filter((b) => b >= 0).length
      if (bid === 3 || acted === NUM) return startPlay(next)
      const turn = (seat + 1) % NUM
      return { ...next, turn, side: turn }
    }

    // —— playing ——
    const a = action as { cards?: number[]; pass?: boolean }
    const isPass = a.pass === true || (Array.isArray(a.cards) && a.cards.length === 0)

    if (isPass) {
      if (!s.table) ctx.reject('must-lead') // the leader must play something
      const trick = [...(s.trick ?? [null, null, null])]
      trick[seat] = 'pass'
      const passes = s.passes + 1
      if (passes >= NUM - 1) {
        // everyone else passed → the last player to play leads a fresh trick.
        // Keep `trick` (so the finished trick + who passed stays on the table)
        // until the leader actually plays again — it is cleared on the next lead.
        const lead = s.table!.seat
        return { ...s, trick, table: null, passes: 0, turn: lead, side: lead }
      }
      const turn = (seat + 1) % NUM
      return { ...s, trick, passes, turn, side: turn }
    }

    const cards = a.cards
    if (!Array.isArray(cards) || !cards.every((c) => Number.isInteger(c))) ctx.reject('invalid-combo')
    if (!ownsAll(s.hands[seat]!, cards!)) ctx.reject('dont-own-cards')
    const combo = classify(cards!)
    if (!combo) ctx.reject('invalid-combo')
    if (s.table && !beats(s.table.combo, combo!)) ctx.reject('cant-beat')

    const hands = s.hands.map((h, i) => (i === seat ? removeCards(h, cards!) : h))
    const multiplier = combo!.type === 'bomb' || combo!.type === 'rocket' ? s.multiplier * 2 : s.multiplier
    const emptied = hands[seat]!.length === 0
    const turn = (seat + 1) % NUM
    const played = sortRanks(cards!)
    // A fresh lead (nothing on the table) clears the previous trick's cards/passes.
    const trick = s.table ? [...(s.trick ?? [null, null, null])] : [null, null, null]
    trick[seat] = played
    return {
      ...s,
      hands,
      table: { seat, cards: played, combo: combo! },
      trick,
      passes: 0,
      multiplier,
      peasantPlayed: s.peasantPlayed || seat !== s.landlord,
      landlordPlays: s.landlordPlays + (seat === s.landlord ? 1 : 0),
      phase: emptied ? 'done' : 'playing',
      finisher: emptied ? seat : s.finisher,
      turn: emptied ? seat : turn,
      side: emptied ? seat : turn,
    }
  },

  terminal: (s) => (s.phase === 'done' ? { done: true, winner: s.players[s.finisher] ?? null } : { done: false }),

  score: (s): Record<string, number> => {
    const landlordWon = s.finisher === s.landlord
    let stake = s.multiplier
    if (landlordWon && !s.peasantPlayed) stake *= 2 // spring: peasants never played
    if (!landlordWon && s.landlordPlays <= 1) stake *= 2 // anti-spring: landlord only led once
    const out: Record<string, number> = {}
    for (let seat = 0; seat < NUM; seat++) {
      const id = s.players[seat]!
      const isLandlord = seat === s.landlord
      const win = landlordWon === isLandlord
      const magnitude = isLandlord ? 2 * stake : stake // landlord stakes double (1 v 2)
      out[id] = win ? magnitude : -magnitude
    }
    return out
  },

  render: (s, ctx?: RenderCtx): RenderSpec => {
    const viewer = ctx?.viewer
    const roleOf = (seat: number): string =>
      s.landlord < 0 ? 'bidding' : seat === s.landlord ? 'landlord' : 'peasant'

    const revealAll = s.phase === 'done' // game over → show everyone's remaining cards
    const landlordWon = s.finisher === s.landlord // the finisher's side wins
    const seats = s.hands.map((h, seat) => {
      // Be robust to older persisted states that predate a field: any seat-indexed
      // array (trick/…) may be absent when an old settled gameState is re-rendered
      // by a newer bundle, so never assume it exists.
      const t = s.trick?.[seat]
      const base = {
        seat,
        role: roleOf(seat),
        count: h.length,
        isLandlord: seat === s.landlord,
        isTurn: seat === s.turn && s.phase !== 'done',
        // Winning side once the game is over; the finisher (last to play) is on it.
        won: revealAll ? (seat === s.landlord ? landlordWon : !landlordWon) : undefined,
        isFinisher: revealAll && seat === s.finisher,
        // This trick's latest action, shown in front of the seat (public info).
        played: Array.isArray(t) ? t : undefined,
        passed: t === 'pass',
      }
      // Reveal a hand to its owner during play; reveal ALL hands once the game is
      // over so the losers' leftover cards are shown. Public mid-game view hides all.
      return revealAll || s.players[seat] === viewer ? { ...base, hand: h } : base
    })

    let status: string
    if (s.phase === 'bidding') {
      status = `Bidding — Seat ${s.turn} to bid`
    } else if (s.phase === 'done') {
      const landlordWon = s.finisher === s.landlord
      status = `${landlordWon ? 'Landlord' : 'Peasants'} win · ×${s.multiplier}`
    } else {
      status = s.table
        ? `×${s.multiplier} · last [${cardsLabel(s.table.cards)}] · Seat ${s.turn} to play`
        : `×${s.multiplier} · Seat ${s.turn} to lead`
    }

    // Custom frame consumed by view.ts. RenderSpec has no free-form data slot, so
    // we attach our fields and cast; the platform delivers the whole object as the
    // frame. `panels` is a declarative fallback for renderers without our view.
    const frame = {
      layout: 'custom' as const,
      game: 'doudizhu',
      phase: s.phase,
      turn: s.turn,
      landlord: s.landlord,
      multiplier: s.multiplier,
      table: s.table ? { seat: s.table.seat, cards: s.table.cards } : null,
      bottom: { cards: s.bottomRevealed ? s.bottom : [], revealed: s.bottomRevealed },
      seats,
      panels: [{ type: 'status' as const, text: status }],
    }
    return frame as unknown as RenderSpec
  },
})

// Re-exported for tests.
export type { State }
export type { Action }
