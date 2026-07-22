/**
 * __NAME__ — a minimal, already-green TURN-BASED game to start from.
 *
 * A tiny Nim-style countdown: 12 stones sit in a pile; on your turn you take
 * 1–3, and whoever takes the LAST stone wins. Each agent submits one move at a
 * time via `reduce` (not a strategy knob). Replace the rules with your own —
 * but KEEP the actor check below: it is YOUR responsibility, not the engine's.
 *
 * Everything is DETERMINISTIC; the only randomness allowed is `ctx.random`.
 */
import { defineGame, type Action, type Ctx } from '@arena/game-sdk'

interface State {
  players: [string, string]
  side: 0 | 1 // seat to move next — validate ctx.actor against players[side]
  pile: number // stones remaining
  winner: string | null
}

export default defineGame<State, Record<string, never>>({
  meta: {
    type: '__SLUG__',
    players: { min: 2, max: 2 },
    pace: 'turn-based',
    turnTimeoutSec: 60,
    maxSteps: 12, // each move removes >=1 stone from a pile of 12
  },

  init: (cfg): State => ({
    players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
    side: 0,
    pile: 12,
    winner: null,
  }),

  reduce: (s, action, ctx: Ctx): State => {
    // MUST: only the seat whose turn it is may move. The engine tracks
    // ctx.actor but does NOT enforce turn ownership — if you drop this line,
    // any agent could play as whichever seat has the move.
    if (ctx.actor !== s.players[s.side]) ctx.reject('not-your-turn')

    // Treat the action as untrusted input: guard its shape before reading it, so
    // a malformed submission (e.g. null) becomes a clean ctx.reject rather than a
    // raw TypeError thrown out of the sandbox. A missing `take` then reads as
    // undefined and fails the numeric check below — also a clean reject.
    if (typeof action !== 'object' || action === null) ctx.reject('bad-action')
    const take = (action as { take: number }).take // 1..3
    if (!Number.isInteger(take) || take < 1 || take > 3) ctx.reject('bad-take')
    if (take > s.pile) ctx.reject('too-many')

    const pile = s.pile - take
    const winner = pile === 0 ? s.players[s.side] : null // took the last stone
    return { ...s, pile, side: (s.side ^ 1) as 0 | 1, winner }
  },

  terminal: (s) => ({ done: s.pile === 0, winner: s.winner ?? undefined }),

  score: (s): Record<string, number> => {
    if (!s.winner) return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
    const loser = s.players.find((p) => p !== s.winner) ?? s.players[1]
    return { [s.winner]: 1, [loser]: 0 }
  },

  // Optional but SHOULD: a weak heuristic lets `pnpm sim`/`preview` self-play
  // without a --script. Optimal Nim: leave the opponent a multiple of 4.
  play: (s): Action => {
    const max = Math.min(3, s.pile)
    const leave = s.pile % 4
    const take = leave === 0 ? 1 : Math.min(leave, max)
    return { take: Math.max(1, take) }
  },

  render: (s) => ({
    layout: 'list' as const,
    panels: [
      {
        type: 'status' as const,
        text: s.winner ? `${s.winner} took the last stone` : `${s.pile} left · ${s.players[s.side]} to move`,
      },
      {
        type: 'scoreboard' as const,
        rows: [
          { label: s.players[0], value: s.side === 0 && !s.winner ? '(to move)' : '' },
          { label: s.players[1], value: s.side === 1 && !s.winner ? '(to move)' : '' },
        ],
      },
    ],
  }),
})

export type { Ctx }
