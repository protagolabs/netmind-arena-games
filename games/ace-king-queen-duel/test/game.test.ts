import { describe, it, expect } from 'vitest'
import { assertMatchSane, clampParams, runStrategyMatch } from '@arena/game-sdk'
import game from '../src/game'

type Params = { priorityA: number; priorityK: number; priorityQ: number }

describe('ace-king-queen-duel', () => {
  it('a decisive order-vs-order match: two rounds won beats one round won', () => {
    // a commits A, K, Q — b commits K, Q, A
    const a = clampParams(game as never, { priorityA: 0.9, priorityK: 0.6, priorityQ: 0.1 }) as Params
    const b = clampParams(game as never, { priorityK: 0.9, priorityQ: 0.6, priorityA: 0.1 }) as Params
    const r = assertMatchSane(game, { players: ['a', 'b'] }, [a, b], 1)
    // round1 a:A vs b:K -> a; round2 a:K vs b:Q -> a; round3 a:Q vs b:A -> b
    expect(r.scores['a']).toBe(4)
    expect(r.scores['b']).toBe(2)
    expect(game.terminal!(r.finalState).winner).toBe('a')
  })

  it('identical orders tie every round: 3-3 draw, no winner', () => {
    const same = clampParams(game as never, {}) as Params // both default to 0.5/0.5/0.5 → same order
    const r = runStrategyMatch(game, { players: ['a', 'b'] }, [same, same], 7)
    expect(r.scores).toEqual({ a: 3, b: 3 })
    expect(game.terminal!(r.finalState).winner).toBeNull()
  })

  it('total points always split 2 per round regardless of strategy (6 across 3 rounds)', () => {
    const seeds = [1, 2, 3, 4]
    const combos: [Record<string, number>, Record<string, number>][] = [
      [{ priorityA: 0.9, priorityK: 0.5, priorityQ: 0.1 }, { priorityQ: 0.9, priorityK: 0.5, priorityA: 0.1 }],
      [{ priorityA: 0.1, priorityK: 0.9, priorityQ: 0.5 }, { priorityA: 0.5, priorityK: 0.1, priorityQ: 0.9 }],
    ]
    for (const seed of seeds) {
      for (const [pa, pb] of combos) {
        const a = clampParams(game as never, pa) as Params
        const b = clampParams(game as never, pb) as Params
        const r = assertMatchSane(game, { players: ['a', 'b'] }, [a, b], seed)
        expect(r.scores['a']! + r.scores['b']!).toBe(6)
      }
    }
  })

  it('priority ties break in fixed A, K, Q order', () => {
    // all three priorities equal → order must be A, K, Q (stable-sort tie-break)
    const flat = clampParams(game as never, { priorityA: 0.5, priorityK: 0.5, priorityQ: 0.5 }) as Params
    // beats an opponent who plays Q first — first round must be A (rank 3) vs Q (rank 1)
    const qFirst = clampParams(game as never, { priorityQ: 0.9, priorityK: 0.5, priorityA: 0.1 }) as Params
    const r = runStrategyMatch(game, { players: ['a', 'b'] }, [flat, qFirst], 3)
    const round1 = (r.finalState as { roundResults: { a: string; b: string }[] }).roundResults[0]!
    expect(round1.a).toBe('A')
    expect(round1.b).toBe('Q')
  })
})
