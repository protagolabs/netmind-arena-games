/**
 * Sealed Duel — minimal HIDDEN-INFORMATION reference game.
 *
 * Two players each secretly pick a number 1–9; higher wins. A player's pick is
 * secret until both are in. This exists to prove Arena's viewer-scoping: the
 * platform renders the live view PER viewer, so mid-game player A can never see
 * B's pick. It's also the template a card author copies (hide opponents' hands).
 *
 * `render(state, ctx)` returns a viewer-specific frame: your own card is visible,
 * the opponent's is `?` until revealed. `render(state)` (no viewer) is the public
 * view — both hidden until the reveal. Because `meta.hiddenInfo` is true, Arena
 * only ever sends a viewer their own render.
 */
import { defineGame, type Action, type Ctx, type RenderCtx } from '@arena/game-sdk'

interface State {
  players: [string, string]
  side: 0 | 1
  picks: [number | null, number | null]
  revealed: boolean
  status: 'playing' | 'won' | 'draw'
  winner?: string
}

function card(state: State, seat: 0 | 1, viewer?: string): string {
  const p = state.picks[seat]
  if (p === null) return '·'
  const maySee = state.revealed || state.players[seat] === viewer
  return maySee ? String(p) : '?'
}

export default defineGame<State, Record<string, number>>({
  meta: {
    type: 'sealed',
    players: { min: 2, max: 2 },
    pace: 'turn-based',
    turnTimeoutSec: 60,
    maxSteps: 2,
    hiddenInfo: true,
  },

  init: (cfg): State => ({
    players: [cfg.players[0] ?? 'p0', cfg.players[1] ?? 'p1'],
    side: 0,
    picks: [null, null],
    revealed: false,
    status: 'playing',
  }),

  reduce: (s, action, ctx: Ctx): State => {
    if (s.status !== 'playing') ctx.reject('game-over')
    const seat = s.players.indexOf(ctx.actor) as 0 | 1 | -1
    if (seat < 0) ctx.reject('not-a-player')
    if (seat !== s.side) ctx.reject('not-your-turn')
    if (s.picks[seat as 0 | 1] !== null) ctx.reject('already-picked')
    const pick = Math.round((action as { pick: number }).pick)
    if (!Number.isInteger(pick) || pick < 1 || pick > 9) ctx.reject('pick-1-9')

    const picks: [number | null, number | null] = [...s.picks]
    picks[seat as 0 | 1] = pick
    const bothIn = picks[0] !== null && picks[1] !== null
    if (!bothIn) return { ...s, picks, side: (s.side ^ 1) as 0 | 1 }

    const [a, b] = picks as [number, number]
    const status: State['status'] = a === b ? 'draw' : 'won'
    const winner = a > b ? s.players[0] : b > a ? s.players[1] : undefined
    return { ...s, picks, revealed: true, status, winner }
  },

  terminal: (s) => (s.revealed ? { done: true, winner: s.winner ?? null } : { done: false }),

  score: (s): Record<string, number> => {
    if (s.status === 'won' && s.winner) {
      const loser = s.players.find((p) => p !== s.winner) ?? s.players[1]
      return { [s.winner]: 1, [loser]: 0 }
    }
    return { [s.players[0]]: 0.5, [s.players[1]]: 0.5 }
  },

  render: (s, ctx?: RenderCtx) => ({
    layout: 'list' as const,
    panels: [
      {
        type: 'scoreboard' as const,
        rows: [
          { label: s.players[0], value: card(s, 0, ctx?.viewer) },
          { label: s.players[1], value: card(s, 1, ctx?.viewer) },
        ],
      },
      {
        type: 'status' as const,
        text: s.revealed
          ? s.status === 'draw'
            ? 'Draw'
            : `Winner: ${s.winner}`
          : `Waiting for picks · ${s.side === 0 ? s.players[0] : s.players[1]} to move`,
      },
    ],
  }),
})

// exported for reference in the view/tests
export type { State }
export type { Action }
