/**
 * Ace King Queen Duel — 2-player sealed-order card duel.
 *
 * Before the match, each side privately commits an order to play their three
 * cards (A, K, Q) — one card per round, three rounds. A round is won by the
 * higher card (A > K > Q); a win scores 2, a tie scores 1 each, a loss scores
 * 0. After three rounds the higher total wins.
 *
 * `strategy` pace fits this exactly: an agent's whole commitment is a single
 * one-shot decision, so it is expressed as `params` (three priority knobs, one
 * per card) rather than a sequence of turn-based actions. `play` derives the
 * full order fresh from `params` every call and just reads `order[state.round]`
 * — the order is never written into `State`, so a not-yet-revealed card can
 * never leak through the public/spectator render; no `hiddenInfo` needed.
 *
 * Deterministic — the only randomness allowed is `ctx.random` (unused here,
 * the game has none).
 */
import { defineGame, type Action, type Ctx, type RenderSpec } from '@arena/game-sdk'

type Card = 'A' | 'K' | 'Q'

const CARDS: Card[] = ['A', 'K', 'Q']
const RANK: Record<Card, number> = { A: 3, K: 2, Q: 1 }
const PRIORITY_KEY: Record<Card, 'priorityA' | 'priorityK' | 'priorityQ'> = {
  A: 'priorityA',
  K: 'priorityK',
  Q: 'priorityQ',
}

interface RoundResult {
  a: Card
  b: Card
  winner: 0 | 1 | null
}

interface State {
  players: [string, string]
  side: 0 | 1 // seat to act next (the SDK reads this to route params)
  round: number // 0..2, current round index
  played: [Card[], Card[]] // cards each seat has revealed so far
  roundResults: RoundResult[]
  scores: [number, number]
  done: boolean
}

interface Params {
  priorityA: number
  priorityK: number
  priorityQ: number
}

/**
 * The seat's full play order, highest priority first. Ties keep `CARDS`'
 * order (A, K, Q) — Array#sort is stable, so equal priorities never need an
 * explicit tie-break rule.
 */
function deriveOrder(params: Params): Card[] {
  return [...CARDS].sort((a, b) => params[PRIORITY_KEY[b]] - params[PRIORITY_KEY[a]])
}

export default defineGame<State, Params>({
  meta: {
    type: 'ace-king-queen-duel',
    players: { min: 2, max: 2 },
    pace: 'strategy',
    submitWindowSec: 600,
    maxSteps: 6, // 2 seats x 3 rounds
  },

  params: {
    priorityA: { min: 0, max: 1, default: 0.5 },
    priorityK: { min: 0, max: 1, default: 0.5 },
    priorityQ: { min: 0, max: 1, default: 0.5 },
  },

  init: (cfg): State => ({
    players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
    side: 0,
    round: 0,
    played: [[], []],
    roundResults: [],
    scores: [0, 0],
    done: false,
  }),

  play: (state, params): Action => {
    const order = deriveOrder(params)
    return { card: order[state.round] }
  },

  apply: (state, action): State => {
    const card = (action as { card: Card }).card
    const played: [Card[], Card[]] = [
      state.side === 0 ? [...state.played[0], card] : state.played[0],
      state.side === 1 ? [...state.played[1], card] : state.played[1],
    ]

    let round = state.round
    let scores = state.scores
    let roundResults = state.roundResults
    let done = false

    if (state.side === 1) {
      // both seats have now revealed their card for this round — settle it
      const a = played[0][round]!
      const b = played[1][round]!
      let winner: 0 | 1 | null
      if (RANK[a] > RANK[b]) {
        winner = 0
        scores = [state.scores[0] + 2, state.scores[1]]
      } else if (RANK[b] > RANK[a]) {
        winner = 1
        scores = [state.scores[0], state.scores[1] + 2]
      } else {
        winner = null
        scores = [state.scores[0] + 1, state.scores[1] + 1]
      }
      roundResults = [...state.roundResults, { a, b, winner }]
      round += 1
      done = round >= 3
    }

    return { ...state, side: (state.side ^ 1) as 0 | 1, round, played, scores, roundResults, done }
  },

  terminal: (state) => {
    if (!state.done) return { done: false }
    const [a, b] = state.scores
    const winner = a > b ? state.players[0] : b > a ? state.players[1] : null
    return { done: true, winner }
  },

  score: (state): Record<string, number> => ({
    [state.players[0]]: state.scores[0],
    [state.players[1]]: state.scores[1],
  }),

  // Custom frame consumed by view.ts (draws real card faces). RenderSpec has no
  // free-form data slot, so we attach our fields and cast; the platform delivers
  // the whole object as the frame. `panels` is a declarative fallback for
  // renderers without our view.
  render: (state): RenderSpec => {
    const frame = {
      layout: 'custom' as const,
      game: 'ace-king-queen-duel',
      round: state.round,
      done: state.done,
      scores: state.scores,
      played: state.played,
      roundResults: state.roundResults,
      panels: [
        {
          type: 'status' as const,
          text: state.done ? 'Match over' : `Round ${state.round + 1} of 3`,
        },
        {
          type: 'scoreboard' as const,
          rows: [
            { label: state.players[0], value: state.scores[0] },
            { label: state.players[1], value: state.scores[1] },
          ],
        },
      ],
    }
    return frame as unknown as RenderSpec
  },
})

export type { Ctx }
