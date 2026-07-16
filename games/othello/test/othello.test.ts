import { describe, it, expect } from 'vitest'
import { assertMatchSane, makeCtx, clampParams, runStrategyMatch } from '@arena/game-sdk'
import game from '../src/othello.game'

type Params = { positional: number; corner: number; mobility: number; greedy: number }

const cfg = { players: ['alice', 'bob'] }

const positional = clampParams(game as never, { positional: 0.9, corner: 0.9, mobility: 0.6, greedy: 0.0 }) as Params
const greedy = clampParams(game as never, { positional: 0.1, corner: 0.2, mobility: 0.1, greedy: 1.0 }) as Params

describe('othello · strategy pace', () => {
  it('runs a sane, deterministic match', () => {
    const r = assertMatchSane(game, cfg, [positional, greedy], 12345)
    expect(r.steps).toBeGreaterThan(0)
    // exactly one of: someone scored 1 (win) or both 0.5 (draw)
    const vals = Object.values(r.scores).sort()
    expect(vals).toSatisfy(
      (v: number[]) =>
        JSON.stringify(v) === JSON.stringify([0, 1]) || JSON.stringify(v) === JSON.stringify([0.5, 0.5]),
    )
  })

  it('is deterministic across 100 seeds (no crash, always terminates)', () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = runStrategyMatch(game, cfg, [positional, greedy], seed)
      expect(game.terminal!(r.finalState).done).toBe(true)
      expect(r.steps).toBeLessThanOrEqual(game.meta.maxSteps!)
    }
  })

  it('emits a render frame per step', () => {
    const r = runStrategyMatch(game, cfg, [positional, greedy], 7)
    expect(r.frames.length).toBe(r.steps + 1) // initial + one per move
  })
})

describe('othello · turn-based pace', () => {
  it('flips discs on a legal move and rejects illegal ones', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) // black (seat 0) to move
    expect(s.side).toBe(0)

    // black plays d3 (x=3,y=2): flanks the white at (3,3), bracketed by black at (3,4)
    s = game.reduce!(s, { x: 3, y: 2 }, makeCtx({ seed: 1, actor: 'alice' }))
    expect(s.board[2]![3]).toBe(1) // new black disc
    expect(s.board[3]![3]).toBe(1) // flipped white → black
    expect(s.side).toBe(1) // white to move

    // wrong actor (alice again, but it's white's turn now)
    expect(() => game.reduce!(s, { x: 2, y: 2 }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/not-your-turn/)
    // occupied cell
    expect(() => game.reduce!(s, { x: 3, y: 3 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/cell-occupied/)
    // out of bounds
    expect(() => game.reduce!(s, { x: 99, y: 0 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/out-of-bounds/)
    // empty but flanks nothing
    expect(() => game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/illegal-move/)
  })

  it('has exactly four legal opening moves for black', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    let legal = 0
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if (s.board[y]![x] !== 0) continue
        try {
          game.reduce!(s, { x, y }, makeCtx({ seed: 1, actor: 'alice' }))
          legal++
        } catch {
          // illegal opening cell
        }
      }
    }
    expect(legal).toBe(4) // c4, d3, e6, f5
  })
})
