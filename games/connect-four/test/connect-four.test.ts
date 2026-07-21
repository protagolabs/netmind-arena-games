import { describe, it, expect } from 'vitest'
import { makeCtx } from '@arena/game-sdk'
import game from '../src/connect-four.game'

const cfg = { players: ['alice', 'bob'] }

describe('connect-four · turn-based', () => {
  it('drops a disc and rejects illegal moves', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    const aliceCtx = makeCtx({ seed: 1, actor: 'alice' })

    s = game.reduce!(s, { col: 3 }, aliceCtx)
    expect(s.board[3]).toBe(1) // row0 col3
    expect(s.side).toBe(1)

    // wrong actor: alice again, but it's bob's turn now
    expect(() => game.reduce!(s, { col: 4 }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/not-your-turn/)
    // out of bounds
    expect(() => game.reduce!(s, { col: 7 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/out-of-bounds/)
    expect(() => game.reduce!(s, { col: -1 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/out-of-bounds/)
  })

  it('rejects a full column', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    for (let i = 0; i < 6; i++) {
      const actor = i % 2 === 0 ? 'alice' : 'bob'
      s = game.reduce!(s, { col: 0 }, makeCtx({ seed: 1, actor }))
    }
    const nextActor = s.side === 0 ? 'alice' : 'bob'
    expect(() => game.reduce!(s, { col: 0 }, makeCtx({ seed: 1, actor: nextActor }))).toThrow(/column-full/)
  })

  it('detects a horizontal four-in-a-row and scores correctly', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    // alice(seat0) plays cols 0,1,2,3 row0; bob(seat1) plays col 0,1,2 row1 (harmless)
    const moves: Array<[string, number]> = [
      ['alice', 0],
      ['bob', 0],
      ['alice', 1],
      ['bob', 1],
      ['alice', 2],
      ['bob', 2],
      ['alice', 3],
    ]
    for (const [actor, col] of moves) {
      s = game.reduce!(s, { col }, makeCtx({ seed: 1, actor }))
    }
    const t = game.terminal!(s)
    expect(t.done).toBe(true)
    expect(t.winner).toBe('alice')
    const sc = game.score(s)
    expect(sc['alice']).toBe(1)
    expect(sc['bob']).toBe(0)
  })

  it('rejects any move once the game is over', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    const moves: Array<[string, number]> = [
      ['alice', 0],
      ['bob', 0],
      ['alice', 1],
      ['bob', 1],
      ['alice', 2],
      ['bob', 2],
      ['alice', 3],
    ]
    for (const [actor, col] of moves) s = game.reduce!(s, { col }, makeCtx({ seed: 1, actor }))
    expect(() => game.reduce!(s, { col: 4 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/game-over/)
  })

  it('is deterministic: same move sequence -> identical state', () => {
    const play = () => {
      let s = game.init(cfg, makeCtx({ seed: 1 }))
      const cols = [3, 3, 4, 2, 4, 4, 2, 2, 5, 3]
      for (let i = 0; i < cols.length; i++) {
        const actor = i % 2 === 0 ? 'alice' : 'bob'
        s = game.reduce!(s, { col: cols[i] }, makeCtx({ seed: 1, actor }))
      }
      return s
    }
    const a = play()
    const b = play()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
