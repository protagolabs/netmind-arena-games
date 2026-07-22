import { describe, it, expect } from 'vitest'
import { makeCtx } from '@arena/game-sdk'
import game from '../src/game'

const cfg = { players: ['alice', 'bob'] }

describe('__SLUG__', () => {
  it('rejects out-of-turn and illegal moves', () => {
    const s = game.init!(cfg, makeCtx({ seed: 1 }))
    // alice is seat 0 and moves first; bob playing now is not his turn.
    expect(() => game.reduce!(s, { take: 1 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/not-your-turn/)
    // alice's turn, but illegal amounts are rejected.
    expect(() => game.reduce!(s, { take: 0 }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/bad-take/)
    expect(() => game.reduce!(s, { take: 4 }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/bad-take/)
  })

  it('plays a deterministic match to a winner', () => {
    const run = () => {
      let s = game.init!(cfg, makeCtx({ seed: 7 }))
      let steps = 0
      while (!game.terminal!(s).done && steps < (game.meta.maxSteps ?? 100)) {
        const actor = s.players[s.side]
        const action = game.play!(s, {}, makeCtx({ seed: 7, side: s.side, actor }))
        s = game.reduce!(s, action, makeCtx({ seed: 7, actor }))
        steps++
      }
      return game.score!(s)
    }
    const a = run()
    const b = run()
    expect(a).toEqual(b) // determinism
    expect(a['alice']! + a['bob']!).toBe(1) // exactly one winner
  })
})
