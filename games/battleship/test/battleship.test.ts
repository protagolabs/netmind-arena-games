import { describe, it, expect } from 'vitest'
import { makeCtx } from '@arena/game-sdk'
import game from '../src/battleship.game'

const cfg = { players: ['alice', 'bob'] }

describe('battleship · setup', () => {
  it('places exactly 8 ship cells per side (1x1 + 1x3 + 2x2), no overlap', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    for (const board of s.boards) {
      const shipCells = board.filter((c) => c === 1).length
      expect(shipCells).toBe(8)
    }
  })

  it('is deterministic: same seed -> identical placement', () => {
    const a = game.init(cfg, makeCtx({ seed: 42 }))
    const b = game.init(cfg, makeCtx({ seed: 42 }))
    expect(JSON.stringify(a.boards)).toBe(JSON.stringify(b.boards))
  })

  it('different seeds usually produce different placements', () => {
    const a = game.init(cfg, makeCtx({ seed: 1 }))
    const b = game.init(cfg, makeCtx({ seed: 2 }))
    expect(JSON.stringify(a.boards)).not.toBe(JSON.stringify(b.boards))
  })
})

describe('battleship · turn-based', () => {
  it('fires a shot and rejects illegal actions', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    const aliceCtx = makeCtx({ seed: 1, actor: 'alice' })
    s = game.reduce!(s, { x: 0, y: 0 }, aliceCtx)
    expect(s.side).toBe(1)
    expect([2, 3]).toContain(s.boards[1][0])

    // wrong actor: alice again, but it's bob's turn
    expect(() => game.reduce!(s, { x: 1, y: 0 }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/not-your-turn/)
    // out of bounds
    expect(() => game.reduce!(s, { x: 5, y: 0 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/out-of-bounds/)
    expect(() => game.reduce!(s, { x: -1, y: 0 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/out-of-bounds/)
    // already-targeted (bob fires at 0,0 on alice's board — different board, should be fine)
    s = game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'bob' }))
    expect(() => game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/already-targeted/)
  })

  it('wins when all 8 of the opponent ship cells are hit', () => {
    let s = game.init(cfg, makeCtx({ seed: 7 }))
    // alice fires at every cell of bob's board (boards[1]) until all 8 ship cells are hit
    const shipCells = s.boards[1].reduce<number[]>((acc, c, i) => (c === 1 ? [...acc, i] : acc), [])
    expect(shipCells.length).toBe(8)
    for (const cellIdx of shipCells) {
      const x = cellIdx % 5
      const y = Math.floor(cellIdx / 5)
      // alternate actors correctly: it must be alice's turn each time we fire at bob
      while (s.side !== 0) {
        // bob takes a harmless shot at an untouched water cell on alice's board
        const water = s.boards[0].findIndex((c) => c === 0)
        s = game.reduce!(s, { x: water % 5, y: Math.floor(water / 5) }, makeCtx({ seed: 7, actor: 'bob' }))
      }
      s = game.reduce!(s, { x, y }, makeCtx({ seed: 7, actor: 'alice' }))
    }
    const t = game.terminal!(s)
    expect(t.done).toBe(true)
    expect(t.winner).toBe('alice')
    const sc = game.score(s)
    expect(sc['alice']).toBe(1)
    expect(sc['bob']).toBe(0)
  })

  it('rejects any move once the game is over', () => {
    let s = game.init(cfg, makeCtx({ seed: 7 }))
    const shipCells = s.boards[1].reduce<number[]>((acc, c, i) => (c === 1 ? [...acc, i] : acc), [])
    for (const cellIdx of shipCells) {
      const x = cellIdx % 5
      const y = Math.floor(cellIdx / 5)
      while (s.side !== 0) {
        const water = s.boards[0].findIndex((c) => c === 0)
        s = game.reduce!(s, { x: water % 5, y: Math.floor(water / 5) }, makeCtx({ seed: 7, actor: 'bob' }))
      }
      s = game.reduce!(s, { x, y }, makeCtx({ seed: 7, actor: 'alice' }))
    }
    expect(game.terminal!(s).done).toBe(true)
    expect(() => game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 7, actor: 'bob' }))).toThrow(/game-over/)
  })
})

describe('battleship · hidden information (the critical property)', () => {
  it('the public (no-viewer) render never exposes un-hit ship cells', () => {
    let s = game.init(cfg, makeCtx({ seed: 3 }))
    s = game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 3, actor: 'alice' }))
    const publicFrame = game.render!(s) as any // no ctx -> no viewer
    // The masked board must contain no "1" cells (unmasked intact ship) anywhere.
    expect(publicFrame.board.cells.flat()).not.toContain(1)
  })

  it("a viewer's render never leaks the OPPONENT's un-hit ship layout", () => {
    let s = game.init(cfg, makeCtx({ seed: 5 }))
    const aliceFrame = game.render!(s, { viewer: 'alice' })
    const bobFrame = game.render!(s, { viewer: 'bob' })
    // alice's frame renders bob's board (her firing target) — must be all-masked
    // at turn 0 (nothing hit yet), i.e. no '1' visible anywhere.
    expect((aliceFrame.board!.cells as number[][]).flat()).not.toContain(1)
    expect((bobFrame.board!.cells as number[][]).flat()).not.toContain(1)
  })

  it('scoreboard panel only reveals counts, never positions', () => {
    const s = game.init(cfg, makeCtx({ seed: 9 }))
    const frame = game.render!(s, { viewer: 'alice' })
    const panelText = JSON.stringify(frame.panels)
    // no coordinate-looking leakage in the panel text (no raw board arrays embedded)
    expect(panelText).not.toMatch(/\[\[.*\]\]/) // no nested arrays (a board grid) in panels
    expect(panelText).toContain('8/8 ships left')
  })

  it('is deterministic across 50 seeds (self-play always terminates)', () => {
    for (let seed = 0; seed < 50; seed++) {
      let s = game.init(cfg, makeCtx({ seed }))
      let guard = 0
      while (!game.terminal!(s).done && guard < 60) {
        const actor = s.players[s.side]
        const move = game.play!(s, {}, makeCtx({ seed, actor }))
        s = game.reduce!(s, move, makeCtx({ seed, actor }))
        guard++
      }
      expect(game.terminal!(s).done).toBe(true)
      expect(guard).toBeLessThanOrEqual(game.meta.maxSteps!)
    }
  })
})
