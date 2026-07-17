import { describe, it, expect } from 'vitest'
import { makeCtx } from '@arena/game-sdk'
import type { Action, Ctx } from '@arena/game-sdk'
import game, { type State } from '../src/liars-dice.game'

const CFG = { players: ['A', 'B', 'C'] }
const ctxFor = (actor: string) => makeCtx({ seed: 1, actor })

/** Start from a real init, then override fields for a controlled scenario. */
function base(overrides: Partial<State>): State {
  const s = game.init(CFG, makeCtx({ seed: 1 }))
  return { ...s, ...overrides }
}

// ————————————————————————————————————————————————————————————————
describe('liars-dice · dealing', () => {
  it('gives 3 players 5 dice each, all in 1..6', () => {
    const s = game.init(CFG, makeCtx({ seed: 5 }))
    expect(s.dice.map((d) => d.length)).toEqual([5, 5, 5])
    for (const d of s.dice.flat()) {
      expect(d).toBeGreaterThanOrEqual(1)
      expect(d).toBeLessThanOrEqual(6)
    }
    expect(s.alive).toEqual([true, true, true])
    expect(s.phase).toBe('playing')
    expect(s.bid).toBeNull()
  })

  it('is deterministic per seed and differs across seeds', () => {
    const a = game.init(CFG, makeCtx({ seed: 42 }))
    const b = game.init(CFG, makeCtx({ seed: 42 }))
    const c = game.init(CFG, makeCtx({ seed: 43 }))
    expect(JSON.stringify(a.dice)).toBe(JSON.stringify(b.dice))
    expect(JSON.stringify(a.dice)).not.toBe(JSON.stringify(c.dice))
  })
})

// ————————————————————————————————————————————————————————————————
describe('liars-dice · bidding', () => {
  it('a legal opening bid advances to the next seat', () => {
    const s = base({ turn: 0, bid: null })
    const n = game.reduce!(s, { bid: { count: 2, face: 3 } }, ctxFor('A'))
    expect(n.bid).toEqual({ count: 2, face: 3 })
    expect(n.bidder).toBe(0)
    expect(n.turn).toBe(1)
  })

  it('a raise must strictly out-bid (higher count, or same count + higher face)', () => {
    const s = base({ turn: 1, bid: { count: 2, face: 3 }, bidder: 0 })
    // same count, higher face — legal
    expect(game.reduce!(s, { bid: { count: 2, face: 4 } }, ctxFor('B')).bid).toEqual({ count: 2, face: 4 })
    // higher count — legal
    expect(game.reduce!(s, { bid: { count: 3, face: 1 } }, ctxFor('B')).bid).toEqual({ count: 3, face: 1 })
    // same bid — illegal
    expect(() => game.reduce!(s, { bid: { count: 2, face: 3 } }, ctxFor('B'))).toThrow('bad-bid')
    // same count, lower face — illegal
    expect(() => game.reduce!(s, { bid: { count: 2, face: 2 } }, ctxFor('B'))).toThrow('bad-bid')
    // lower count — illegal
    expect(() => game.reduce!(s, { bid: { count: 1, face: 6 } }, ctxFor('B'))).toThrow('bad-bid')
  })

  it('rejects out-of-range, impossible, out-of-turn, and empty-round challenges', () => {
    const s = base({ turn: 0, bid: null })
    expect(() => game.reduce!(s, { bid: { count: 1, face: 7 } }, ctxFor('A'))).toThrow('bad-bid')
    expect(() => game.reduce!(s, { bid: { count: 0, face: 3 } }, ctxFor('A'))).toThrow('bad-bid')
    expect(() => game.reduce!(s, { bid: { count: 16, face: 3 } }, ctxFor('A'))).toThrow('impossible-bid') // 15 dice exist
    expect(() => game.reduce!(s, { bid: { count: 2, face: 3 } }, ctxFor('B'))).toThrow('not-your-turn')
    expect(() => game.reduce!(s, { challenge: true }, ctxFor('A'))).toThrow('nothing-to-challenge')
  })
})

// ————————————————————————————————————————————————————————————————
describe('liars-dice · challenge resolution', () => {
  it('bid holds (with wild 1s counted) → challenger loses a die, then re-rolls', () => {
    // face 5 across cups: seat0 [5,5]=2, seat1 [5,1]=2 (the 1 is wild), seat2 [2,2]=0 → actual 4
    const s = base({
      dice: [[5, 5], [5, 1], [2, 2]],
      bid: { count: 3, face: 5 },
      bidder: 0,
      turn: 1,
      round: 1,
    })
    const n = game.reduce!(s, { challenge: true }, ctxFor('B'))
    expect(n.reveal?.actual).toBe(4)
    expect(n.reveal?.loser).toBe(1) // bid held (4 ≥ 3) → challenger (seat 1) loses
    expect(n.reveal?.eliminated).toBeNull()
    expect(n.dice[1]!.length).toBe(1) // seat 1 dropped one die
    expect(n.dice[0]!.length).toBe(2)
    expect(n.alive).toEqual([true, true, true])
    expect(n.bid).toBeNull()
    expect(n.turn).toBe(1) // loser leads the next round
    expect(n.round).toBe(2)
  })

  it('bid is a lie → the bidder loses a die', () => {
    const s = base({
      dice: [[5, 5], [5, 1], [2, 2]],
      bid: { count: 5, face: 5 }, // actual is only 4
      bidder: 0,
      turn: 1,
    })
    const n = game.reduce!(s, { challenge: true }, ctxFor('B'))
    expect(n.reveal?.loser).toBe(0)
    expect(n.dice[0]!.length).toBe(1)
  })

  it('a bid on face 1 counts only actual 1s (not wild)', () => {
    const s = base({ dice: [[1, 1], [5, 5], [6, 6]], bid: { count: 2, face: 1 }, bidder: 0, turn: 1 })
    const n = game.reduce!(s, { challenge: true }, ctxFor('B'))
    expect(n.reveal?.actual).toBe(2) // only seat0's two 1s
    expect(n.reveal?.loser).toBe(1) // held (2 ≥ 2) → challenger loses
  })

  it('losing your last die eliminates you, and the last survivor ends the game', () => {
    // seat2 already out; seat0 bids an impossible 6 and gets challenged
    const s = base({
      dice: [[2], [2], []],
      alive: [true, true, false],
      eliminationOrder: [2],
      bid: { count: 1, face: 6 },
      bidder: 0,
      turn: 1,
    })
    const n = game.reduce!(s, { challenge: true }, ctxFor('B'))
    expect(n.reveal?.loser).toBe(0)
    expect(n.reveal?.eliminated).toBe(0)
    expect(n.phase).toBe('done')
    expect(n.finisher).toBe(1)
    expect(n.eliminationOrder).toEqual([2, 0])
    expect(game.terminal!(n)).toEqual({ done: true, winner: 'B' })
  })
})

// ————————————————————————————————————————————————————————————————
describe('liars-dice · scoring', () => {
  it('is an elimination-rank gradient (0..N-1) with the winner top', () => {
    const s = base({
      phase: 'done',
      alive: [false, false, true],
      dice: [[], [], [4, 4]],
      eliminationOrder: [0, 1], // seat 0 out first, then seat 1; seat 2 survives
      finisher: 2,
    })
    const scores = game.score(s)
    expect(scores).toEqual({ A: 0, B: 1, C: 2 })
    expect(Object.values(scores).sort()).toEqual([0, 1, 2])
  })
})

// ————————————————————————————————————————————————————————————————
describe('liars-dice · hidden info render', () => {
  it('shows only the viewer’s own cup mid-game', () => {
    const s = game.init(CFG, makeCtx({ seed: 7 }))
    const forA = game.render!(s, { viewer: 'A' }) as unknown as { seats: Array<{ dice?: number[] }> }
    expect(forA.seats[0]!.dice).toEqual(s.dice[0])
    expect(forA.seats[1]!.dice).toBeUndefined()
    expect(forA.seats[2]!.dice).toBeUndefined()
  })

  it('the public/spectator frame omits every living cup mid-game', () => {
    const s = game.init(CFG, makeCtx({ seed: 7 }))
    const pub = game.render!(s) as unknown as { seats: Array<{ dice?: number[] }>; reveal: unknown }
    expect(pub.seats.every((x) => x.dice === undefined)).toBe(true)
    expect(pub.reveal).toBeNull()
  })

  it('reveals every cup once the game is over', () => {
    const s = base({ phase: 'done', alive: [false, false, true], dice: [[], [], [4, 4]], finisher: 2 })
    const pub = game.render!(s) as unknown as { seats: Array<{ dice?: number[]; isWinner?: boolean }> }
    expect(pub.seats[2]!.dice).toEqual([4, 4])
    expect(pub.seats[2]!.isWinner).toBe(true)
  })
})

// ————————————————————————————————————————————————————————————————
describe('liars-dice · full match', () => {
  it('self-plays to a winner with a valid 0..N-1 score vector (deterministic)', () => {
    const run = (seed: number) => {
      const baseCtx = makeCtx({ seed })
      let s = game.init(CFG, baseCtx)
      let steps = 0
      const max = game.meta.maxSteps ?? 500
      while (!game.terminal!(s).done && steps < max) {
        const seat = s.turn
        const ctx: Ctx = { ...baseCtx, side: seat, actor: CFG.players[seat]! }
        const action: Action = game.play!(s, {}, ctx)
        s = game.reduce!(s, action, ctx)
        steps++
      }
      return { s, steps }
    }
    const { s, steps } = run(3)
    expect(game.terminal!(s).done).toBe(true)
    expect(steps).toBeLessThan(game.meta.maxSteps ?? 500)
    const scores = game.score(s)
    expect(Object.values(scores).sort((a, b) => a - b)).toEqual([0, 1, 2])
    // determinism: same seed → same length + winner
    expect(run(3).steps).toBe(steps)
    expect(run(3).s.finisher).toBe(s.finisher)
  })
})
