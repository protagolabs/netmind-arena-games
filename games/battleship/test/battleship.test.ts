import { describe, it, expect } from 'vitest'
import { makeCtx } from '@arena/game-sdk'
import game from '../src/battleship.game'

const cfg = { players: ['alice', 'bob'] }

// A known-valid placement: 2x2 at (0,0)-(1,1), 1x3 horizontal at (0,4)-(2,4), 1x1 at (4,4).
const VALID_PLACEMENT = {
  ships: [
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [[0, 4], [1, 4], [2, 4]],
    [[4, 4]],
  ],
}
// A second, non-overlapping valid placement elsewhere on the board.
const VALID_PLACEMENT_B = {
  ships: [
    [[3, 3], [4, 3], [3, 4], [4, 4]],
    [[0, 0], [0, 1], [0, 2]],
    [[2, 0]],
  ],
}

function place(s: any, actor: string, placement: any) {
  return game.reduce!(s, placement, makeCtx({ seed: 1, actor }))
}

describe('battleship · placement phase', () => {
  it('starts in the placing phase with empty boards', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    expect(s.phase).toBe('placing')
    expect(s.boards[0].every((c: number) => c === 0)).toBe(true)
    expect(s.boards[1].every((c: number) => c === 0)).toBe(true)
    expect(s.placed).toEqual([false, false])
  })

  it('accepts a valid placement and writes exactly 8 ship cells for that seat', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = place(s, 'alice', VALID_PLACEMENT)
    expect(s.placed[0]).toBe(true)
    expect(s.boards[0].filter((c: number) => c === 1).length).toBe(8)
    expect(s.phase).toBe('placing') // bob hasn't placed yet
  })

  it('transitions to playing only once BOTH seats have placed', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = place(s, 'alice', VALID_PLACEMENT)
    expect(s.phase).toBe('placing')
    s = place(s, 'bob', VALID_PLACEMENT_B)
    expect(s.phase).toBe('playing')
    expect(s.side).toBe(0)
    expect(s.hitsRemaining).toEqual([8, 8])
  })

  it('placement order does not matter (bob can place first)', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = place(s, 'bob', VALID_PLACEMENT_B)
    expect(s.phase).toBe('placing')
    s = place(s, 'alice', VALID_PLACEMENT)
    expect(s.phase).toBe('playing')
  })

  it('rejects placing twice', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = place(s, 'alice', VALID_PLACEMENT)
    expect(() => place(s, 'alice', VALID_PLACEMENT_B)).toThrow(/already-placed/)
  })

  it('rejects wrong ship sizes (not 1+3+4)', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    const bad = { ships: [[[0, 0], [1, 0]], [[2, 0], [3, 0], [4, 0]], [[0, 2]]] } // 2+3+1, no valid 4
    expect(() => place(s, 'alice', bad)).toThrow(/invalid-placement/)
  })

  it('rejects overlapping ships', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    const bad = {
      ships: [
        [[0, 0], [1, 0], [0, 1], [1, 1]],
        [[1, 1], [2, 1], [3, 1]], // overlaps the 2x2 at (1,1)
        [[4, 4]],
      ],
    }
    expect(() => place(s, 'alice', bad)).toThrow(/invalid-placement/)
  })

  it('rejects a non-contiguous / non-rectangular shape (scattered cells)', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    // 4 scattered cells is NOT a valid 2x2 square
    const bad = { ships: [[[0, 0], [2, 0], [0, 2], [2, 2]], [[4, 0], [4, 1], [4, 2]], [[4, 4]]] }
    expect(() => place(s, 'alice', bad)).toThrow(/invalid-placement/)
  })

  it('rejects out-of-bounds coordinates', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    const bad = { ships: [[[0, 0], [1, 0], [0, 1], [1, 1]], [[0, 4], [1, 4], [2, 4]], [[5, 5]]] }
    expect(() => place(s, 'alice', bad)).toThrow(/invalid-placement/)
  })

  it('rejects firing before placement is complete', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = place(s, 'alice', VALID_PLACEMENT)
    // bob tries to "fire" mid-placement instead of placing — malformed for this phase
    expect(() => place(s, 'bob', { x: 0, y: 0 })).toThrow(/invalid-placement/)
  })
})

describe('battleship · placement hidden information', () => {
  it("a viewer's render during placing shows ONLY their own board (frame.you)", () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = place(s, 'alice', VALID_PLACEMENT)
    const aliceFrame = game.render!(s, { viewer: 'alice' }) as any
    const flat = (aliceFrame.you.board as number[][]).flat()
    expect(flat.filter((c: number) => c === 1).length).toBe(8) // alice sees her own 8 ships
  })

  it("a viewer's render during placing never shows the OPPONENT's ships, even after the opponent places", () => {
    // Mid-placement state where only bob has placed, viewed as alice:
    let mid = game.init(cfg, makeCtx({ seed: 1 }))
    mid = place(mid, 'bob', VALID_PLACEMENT_B)
    const aliceFrame = game.render!(mid, { viewer: 'alice' }) as any
    const flat = (aliceFrame.you.board as number[][]).flat()
    // alice hasn't placed yet -> her own (empty) board is shown, not bob's ships
    expect(flat.filter((c: number) => c === 1).length).toBe(0)
  })

  it('the public (no-viewer) render during placing never leaks either ship layout', () => {
    let mid = game.init(cfg, makeCtx({ seed: 1 }))
    mid = place(mid, 'alice', VALID_PLACEMENT)
    const publicFrame = game.render!(mid) as any // no viewer
    const flatYou = (publicFrame.you.board as number[][]).flat()
    const flatOpp = (publicFrame.opponent.board as number[][]).flat()
    expect(flatYou).not.toContain(1)
    expect(flatOpp).not.toContain(1)
  })
})

describe('battleship · playing-phase hidden information (two-board frame)', () => {
  function placed(): any {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = place(s, 'alice', VALID_PLACEMENT)
    s = place(s, 'bob', VALID_PLACEMENT_B)
    return s
  }

  it("alice's frame shows her OWN intact ships but never bob's un-hit ships", () => {
    const s = placed()
    const frame = game.render!(s, { viewer: 'alice' }) as any
    expect((frame.you.board as number[][]).flat().filter((c: number) => c === 1).length).toBe(8)
    expect((frame.opponent.board as number[][]).flat()).not.toContain(1)
  })

  it("bob's frame is the mirror image -- his own ships visible, alice's hidden", () => {
    const s = placed()
    const frame = game.render!(s, { viewer: 'bob' }) as any
    expect((frame.you.board as number[][]).flat().filter((c: number) => c === 1).length).toBe(8)
    expect((frame.opponent.board as number[][]).flat()).not.toContain(1)
  })

  it('the public (no-viewer) render during play masks BOTH boards -- a spectator never sees any un-hit ship', () => {
    const s = placed()
    const frame = game.render!(s) as any // no viewer
    expect((frame.you.board as number[][]).flat()).not.toContain(1)
    expect((frame.opponent.board as number[][]).flat()).not.toContain(1)
  })

  it('after a shot, hits/misses become visible on the TARGETED board for every viewer, but ship identity stays hidden', () => {
    let s = placed()
    s = game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'alice' })) // alice fires at bob's (0,0)
    const bobFrame = game.render!(s, { viewer: 'bob' }) as any
    // bob sees the shot against his OWN board (frame.you here, since bob owns boards[1])
    const bobOwnFlat = (bobFrame.you.board as number[][]).flat()
    expect(bobOwnFlat.some((c: number) => c === 2 || c === 3)).toBe(true) // a hit or miss is now visible
    const spectatorFrame = game.render!(s) as any
    const specFlatOfBob = (spectatorFrame.opponent.board as number[][]).flat() // spectator's default opponent = seat 1 = bob
    expect(specFlatOfBob.some((c: number) => c === 2 || c === 3)).toBe(true)
    expect(specFlatOfBob).not.toContain(1) // still no leaked un-hit ships
  })
})

describe('battleship · turn-based firing (after placement)', () => {
  function placed(): any {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = place(s, 'alice', VALID_PLACEMENT)
    s = place(s, 'bob', VALID_PLACEMENT_B)
    return s
  }

  it('fires a shot and rejects illegal actions', () => {
    let s = placed()
    s = game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'alice' }))
    expect(s.side).toBe(1)
    expect([2, 3]).toContain(s.boards[1][0])
    expect(() => game.reduce!(s, { x: 1, y: 0 }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/not-your-turn/)
    expect(() => game.reduce!(s, { x: 5, y: 0 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/out-of-bounds/)
    s = game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'bob' }))
    expect(() => game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/already-targeted/)
  })

  it('lastShot.targetSeat correctly identifies which board was fired at (fixes a real view.ts bug found via preview screenshot)', () => {
    let s = placed()
    // alice (seat0) fires at bob's board (seat1) -- lastShot must target seat 1
    s = game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'alice' }))
    expect(s.lastShot.targetSeat).toBe(1)
    // now bob fires at alice's board (seat0) -- lastShot must target seat 0
    s = game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'bob' }))
    expect(s.lastShot.targetSeat).toBe(0)
  })

  it('wins when all 8 opponent ship cells are hit, and rejects further moves', () => {
    let s = placed()
    // alice fires at every ship cell of bob's board (boards[1]) until win
    const shipCells = s.boards[1].reduce((acc: number[], c: number, i: number) => (c === 1 ? [...acc, i] : acc), [] as number[])
    expect(shipCells.length).toBe(8)
    for (const cellIdx of shipCells) {
      const x = cellIdx % 5
      const y = Math.floor(cellIdx / 5)
      while (s.side !== 0) {
        const water = s.boards[0].findIndex((c: number) => c === 0)
        s = game.reduce!(s, { x: water % 5, y: Math.floor(water / 5) }, makeCtx({ seed: 1, actor: 'bob' }))
      }
      s = game.reduce!(s, { x, y }, makeCtx({ seed: 1, actor: 'alice' }))
    }
    const t = game.terminal!(s)
    expect(t.done).toBe(true)
    expect(t.winner).toBe('alice')
    expect(game.score(s)).toEqual({ alice: 1, bob: 0 })
    expect(() => game.reduce!(s, { x: 0, y: 0 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(/game-over/)
  })
})

describe('battleship · end-to-end determinism (placement + firing, self-play)', () => {
  it('is deterministic across 30 seeds (self-play always terminates)', () => {
    for (let seed = 0; seed < 30; seed++) {
      let s = game.init(cfg, makeCtx({ seed }))
      let guard = 0
      while (!game.terminal!(s).done && guard < 60) {
        // whoever hasn't placed yet acts first during 'placing'; then side-based during 'playing'
        let actor: string
        if (s.phase === 'placing') {
          const seat = s.placed[0] ? 1 : 0
          actor = s.players[seat]
        } else {
          actor = s.players[s.side]
        }
        const move = game.play!(s, {}, makeCtx({ seed, actor }))
        s = game.reduce!(s, move, makeCtx({ seed, actor }))
        guard++
      }
      expect(game.terminal!(s).done).toBe(true)
      expect(guard).toBeLessThanOrEqual(game.meta.maxSteps!)
    }
  })

  it('same seed -> identical full-match outcome', () => {
    const run = (seed: number) => {
      let s = game.init(cfg, makeCtx({ seed }))
      let guard = 0
      while (!game.terminal!(s).done && guard < 60) {
        let actor: string
        if (s.phase === 'placing') {
          const seat = s.placed[0] ? 1 : 0
          actor = s.players[seat]
        } else {
          actor = s.players[s.side]
        }
        const move = game.play!(s, {}, makeCtx({ seed, actor }))
        s = game.reduce!(s, move, makeCtx({ seed, actor }))
        guard++
      }
      return s
    }
    const a = run(99)
    const b = run(99)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
