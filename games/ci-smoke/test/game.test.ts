import { describe, it, expect } from 'vitest'
import { assertMatchSane, clampParams } from '@arena/game-sdk'
import game from '../src/game'

describe('ci-smoke', () => {
  it('runs a sane, deterministic match', () => {
    const strong = clampParams(game as never, { strength: 0.9 }) as { strength: number }
    const weak = clampParams(game as never, { strength: 0.1 }) as { strength: number }
    const r = assertMatchSane(game, { players: ['a', 'b'] }, [strong, weak], 1)
    expect(r.scores['a']).toBe(1)
    expect(r.scores['b']).toBe(0)
  })
})
