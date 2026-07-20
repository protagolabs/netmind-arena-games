import { describe, it, expect } from 'vitest'
import { assertMatchSane, makeCtx, clampParams, runStrategyMatch } from '@arena/game-sdk'
import game from '../src/gomoku.game'

type Params = { aggression: number; defense: number; centerBias: number; threatDepth: number }

const cfg = { players: ['alice', 'bob'] }

const attacker = clampParams(game as never, { aggression: 0.9, defense: 0.2, centerBias: 0.6, threatDepth: 3 }) as Params
const defender = clampParams(game as never, { aggression: 0.3, defense: 0.9, centerBias: 0.4, threatDepth: 2 }) as Params

describe('gomoku · strategy pace', () => {
  it('runs a sane, deterministic match', () => {
    const r = assertMatchSane(game, cfg, [attacker, defender], 12345)
    expect(r.steps).toBeGreaterThan(0)
    // exactly one of: someone scored 1 (win) or both 0.5 (draw)
    const vals = Object.values(r.scores).sort()
    expect(vals).toSatisfy((v: number[]) => JSON.stringify(v) === JSON.stringify([0, 1]) || JSON.stringify(v) === JSON.stringify([0.5, 0.5]))
  })

  it('is deterministic across 100 seeds (no crash, always terminates)', () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = runStrategyMatch(game, cfg, [attacker, defender], seed)
      expect(game.terminal!(r.finalState).done).toBe(true)
      expect(r.steps).toBeLessThanOrEqual(game.meta.maxSteps!)
    }
  })

  it('emits a render frame per step', () => {
    const r = runStrategyMatch(game, cfg, [attacker, defender], 7)
    expect(r.frames.length).toBe(r.steps + 1) // initial + one per move
  })
})

describe('gomoku · turn-based pace', () => {
  it('applies a legal move and rejects illegal ones', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = { ...s, side: 0, black: 0 } // seat 0 is Black and to move
    const ctx = makeCtx({ seed: 1, actor: 'alice' })

    s = game.reduce!(s, { x: 7, y: 7 }, ctx)
    expect(s.board[7]![7]).toBe(1)
    expect(s.side).toBe(1)

    // wrong actor (still alice, but now white's turn)
    expect(() => game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/not-your-turn/)
    // occupied cell (bob's turn)
    expect(() => game.reduce!(s, { x: 7, y: 7 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/cell-occupied/)
    // out of bounds
    expect(() => game.reduce!(s, { x: 99, y: 0 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/out-of-bounds/)
  })

  it('detects five-in-a-row', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = { ...s, side: 0, black: 0 }
    // black plays (0..4, 0); white plays harmless cells on row 5
    for (let i = 0; i < 5; i++) {
      s = game.reduce!(s, { x: i, y: 0 }, makeCtx({ seed: 1, actor: 'alice' }))
      if (i < 4) s = game.reduce!(s, { x: i, y: 5 }, makeCtx({ seed: 1, actor: 'bob' }))
    }
    expect(game.terminal!(s).done).toBe(true)
    expect(game.terminal!(s).winner).toBe('alice')
  })
})
