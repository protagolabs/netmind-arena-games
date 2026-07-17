/**
 * __NAME__ — a minimal, already-green strategy game to start from.
 *
 * A one-round "number duel": each seat submits a `strength` knob; the higher
 * number wins. Replace init/play/apply/terminal/score with your real rules.
 * Keep everything DETERMINISTIC — the only randomness allowed is `ctx.random`.
 */
import { defineGame, type Action, type Ctx } from '@arena/game-sdk'

interface State {
  players: [string, string]
  side: 0 | 1 // seat to act next (the SDK reads this to route params)
  picks: [number | null, number | null]
  done: boolean
}

interface Params {
  strength: number
}

export default defineGame<State, Params>({
  meta: {
    type: '__SLUG__',
    players: { min: 2, max: 2 },
    pace: 'strategy',
    submitWindowSec: 600,
    maxSteps: 2,
  },

  params: {
    strength: { min: 0, max: 1, default: 0.5 },
  },

  init: (cfg): State => ({
    players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
    side: 0,
    picks: [null, null],
    done: false,
  }),

  play: (_s, p): Action => ({ value: p.strength }),

  apply: (s, action): State => {
    const value = (action as { value: number }).value
    const picks: [number | null, number | null] = [...s.picks]
    picks[s.side] = value
    const done = picks[0] !== null && picks[1] !== null
    return { ...s, picks, side: (s.side ^ 1) as 0 | 1, done }
  },

  terminal: (s) => ({ done: s.done }),

  score: (s): Record<string, number> => {
    const [a, b] = s.picks
    if (a === b) return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
    const winner = (a ?? 0) > (b ?? 0) ? s.players[0] : s.players[1]
    const loser = winner === s.players[0] ? s.players[1] : s.players[0]
    return { [winner]: 1, [loser]: 0 }
  },

  render: (s) => ({
    layout: 'list' as const,
    panels: [
      { type: 'status' as const, text: s.done ? 'Resolved' : 'Awaiting picks' },
      {
        type: 'scoreboard' as const,
        rows: [
          { label: s.players[0], value: s.picks[0] ?? '—' },
          { label: s.players[1], value: s.picks[1] ?? '—' },
        ],
      },
    ],
  }),
})

// `Ctx` is imported for reference — your real game will use ctx.random / ctx.reject.
export type { Ctx }
