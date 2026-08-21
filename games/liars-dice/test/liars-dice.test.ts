import { describe, it, expect } from 'vitest'
import { assertMatchSane, clampParams, makeCtx, runStrategyMatch } from '@arena/game-sdk'
import type { Action, Ctx } from '@arena/game-sdk'
import game, { __policy, type Params, type State } from '../src/liars-dice.game'

const CFG = { players: ['A', 'B', 'C'] }
const ctxFor = (actor: string) => makeCtx({ seed: 1, actor })

/** Knobs, clamped exactly as Arena clamps an agent's submission. */
const knobs = (raw: Partial<Params>): Params => clampParams(game as never, raw as Record<string, number>) as Params
const DEFAULTS = knobs({})

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
  it('bid holds (with wild 1s counted) → challenger loses a die', () => {
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

    // The challenge stops at its own outcome: this state is the open cups, and
    // the next round has NOT begun. Both used to happen in this one step, which
    // is why a replay jumped from a bid straight past the seat who called it.
    expect(n.round).toBe(1)
    expect(n.pendingRoll).toBe(true)
  })

  it('opens the next round on the first action after a challenge, not on the challenge', () => {
    const settled = base({
      dice: [[5, 5], [5, 1], [2, 2]],
      bid: { count: 3, face: 5 },
      bidder: 0,
      turn: 1,
      round: 1,
    })
    const revealed = game.reduce!(settled, { challenge: true }, ctxFor('B'))
    const faces = revealed.dice.map((d) => [...d])

    const opened = game.reduce!(revealed, { bid: { count: 1, face: 2 } }, ctxFor('B'))
    expect(opened.round).toBe(2)
    expect(opened.pendingRoll).toBe(false)
    expect(opened.reveal).toBeNull() // the settled challenge is behind us now
    // Re-rolled: same number of dice per seat, drawn again.
    expect(opened.dice.map((d) => d.length)).toEqual(faces.map((d) => d.length))
    expect(opened.lastBid[1]).toEqual({ count: 1, face: 2 })
    expect(opened.lastBid[0]).toBeNull() // the ended round's bids are cleared
  })

  it('does not consume randomness when the action that would open the round is illegal', () => {
    // A re-roll draws from ctx.random. Drawing it before a reject would advance
    // the stream on an action that never happened, so replaying the same match
    // would deal different dice from that point on.
    const revealed = base({
      dice: [[5, 5], [5, 1], [2, 2]],
      bid: null,
      bidder: -1,
      turn: 1,
      round: 1,
      pendingRoll: true,
      reveal: { challenger: 1, bidder: 0, bid: { count: 3, face: 5 }, actual: 4, dice: [], loser: 1, eliminated: null },
    })
    let draws = 0
    const counting = (id: string) => ({ ...ctxFor(id), random: () => ((draws += 1), 0.5) })

    expect(() => game.reduce!(revealed, { bid: { count: 99, face: 3 } }, counting('B'))).toThrow('impossible-bid')
    expect(() => game.reduce!(revealed, { challenge: true }, counting('B'))).toThrow('nothing-to-challenge')
    expect(draws).toBe(0)

    game.reduce!(revealed, { bid: { count: 1, face: 3 } }, counting('B'))
    expect(draws).toBeGreaterThan(0) // a legal action does re-roll
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
        const action: Action = game.play!(s, DEFAULTS, ctx)
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

// ————————————————————————————————————————————————————————————————
// Strategy pace. The rules above are shared with turn-based pace (one `step`
// kernel); what is new here is the masked view, the knobs, and `apply`.
// ————————————————————————————————————————————————————————————————
describe('liars-dice · strategy pace', () => {
  it('runs a sane, deterministic match on the declared defaults', () => {
    const r = assertMatchSane(game, CFG, [DEFAULTS, DEFAULTS, DEFAULTS], 12345)
    expect(r.steps).toBeGreaterThan(0)
    expect(Object.values(r.scores).sort((a, b) => a - b)).toEqual([0, 1, 2])
  })

  it('declares both paces, with turn-based as the default', () => {
    expect(game.meta.pace).toBe('turn-based')
    expect(game.meta.paces).toEqual(['strategy', 'turn-based'])
    expect(game.apply).toBeTypeOf('function')
    expect(game.reduce).toBeTypeOf('function')
  })

  it('converges on a real winner — not the step cap — across 60 seeds', () => {
    // If this ever fails, a policy has stalled into an endless bid ladder. Fix
    // `decide`; do not just raise maxSteps.
    for (let seed = 0; seed < 60; seed++) {
      const r = runStrategyMatch(game, CFG, [DEFAULTS, DEFAULTS, DEFAULTS], seed)
      const s = r.finalState as State
      expect(game.terminal!(s).done).toBe(true)
      expect(s.finisher).toBeGreaterThanOrEqual(0)
      expect(r.steps).toBeLessThan(game.meta.maxSteps!)
    }
  })

  it('never plays an illegal action, at any corner of the knob space', () => {
    // `apply` throws REJECT:* on an illegal action, so a match that finishes is
    // a match where every action `play` produced was legal.
    const corners: Params[] = [0, 1].flatMap((bluff) =>
      [0, 1].flatMap((skepticism) =>
        [0, 1].flatMap((endgamePressure) =>
          [0, 1].map((wildTrust) =>
            knobs({ bluff, skepticism, endgamePressure, wildTrust, faceLoyalty: bluff, openStrength: skepticism }),
          ),
        ),
      ),
    )
    for (const p of corners) {
      for (let seed = 0; seed < 6; seed++) {
        // Mixed table: the corner policy against two defaults, then all three
        // on the corner (mirrored policies are where ladders would run long).
        for (const seats of [[p, DEFAULTS, DEFAULTS], [p, p, p]]) {
          const r = runStrategyMatch(game, CFG, seats, seed)
          expect(game.terminal!(r.finalState as State).done).toBe(true)
        }
      }
    }
  })

  it('keeps `side` mirrored on `turn` — the engine routes params by `side`', () => {
    const r = runStrategyMatch(game, CFG, [DEFAULTS, DEFAULTS, DEFAULTS], 9)
    const s = r.finalState as State
    expect(s.side).toBe(s.turn)
    // and at every step along the way
    const ctx = makeCtx({ seed: 9 })
    let cur = game.init(CFG, ctx)
    while (!game.terminal!(cur).done) {
      expect(cur.side).toBe(cur.turn)
      cur = game.apply!(cur, game.play!(cur, DEFAULTS, { ...ctx, side: cur.side }), { ...ctx, side: cur.side })
    }
  })

  it('emits a render frame per step', () => {
    const r = runStrategyMatch(game, CFG, [DEFAULTS, DEFAULTS, DEFAULTS], 7)
    expect(r.frames.length).toBe(r.steps + 1) // initial + one per action
  })
})

// ————————————————————————————————————————————————————————————————
describe('liars-dice · apply (strategy pace)', () => {
  it('acts for `state.turn`, not for whoever `ctx.actor` says', () => {
    // In strategy pace the action comes from `play`, so there is no submitter to
    // authenticate — but it must still land on the seat holding the move.
    const s = base({ turn: 1, bid: null })
    const n = game.apply!(s, { bid: { count: 2, face: 3 } }, makeCtx({ seed: 1, actor: 'A' }))
    expect(n.bidder).toBe(1) // seat 1 had the move; 'A' is seat 0
    expect(n.turn).toBe(2)
  })

  it('rejects the same illegal actions `reduce` does', () => {
    const s = base({ turn: 0, bid: { count: 3, face: 4 }, bidder: 2 })
    expect(() => game.apply!(s, { bid: { count: 3, face: 4 } }, ctxFor('A'))).toThrow('bad-bid')
    expect(() => game.apply!(s, { bid: { count: 99, face: 4 } }, ctxFor('A'))).toThrow('impossible-bid')
    expect(() => game.apply!(s, { shout: true } as never, ctxFor('A'))).toThrow('bad-action')
    expect(() => game.apply!(base({ phase: 'done' }), { challenge: true }, ctxFor('A'))).toThrow('game-over')
  })

  it('agrees with `reduce` action for action — one rule kernel, two paces', () => {
    const s = base({ dice: [[5, 5], [5, 1], [2, 2]], turn: 1, bid: { count: 3, face: 5 }, bidder: 0 })
    const viaApply = game.apply!(s, { challenge: true }, makeCtx({ seed: 4 }))
    const viaReduce = game.reduce!(s, { challenge: true }, makeCtx({ seed: 4, actor: 'B' }))
    expect(JSON.stringify(viaApply)).toBe(JSON.stringify(viaReduce))
  })
})

// ————————————————————————————————————————————————————————————————
describe('liars-dice · masked view', () => {
  const s = base({ dice: [[5, 5, 5, 2, 3], [6, 6, 6, 6, 6], [4, 4, 4, 4, 4]], turn: 0, bid: null })

  it('carries the mover’s own cup and nobody else’s', () => {
    const v = __policy.maskFor(s, 0)
    expect(v.mine).toEqual([5, 5, 5, 2, 3])
    expect(v.unseen).toBe(10)
    expect(v.counts).toEqual([5, 5, 5]) // dice counts are public
    expect(JSON.stringify(v)).not.toContain('6') // seat 1's cup is nowhere in here
  })

  it('counts only living dice as unseen', () => {
    const v = __policy.maskFor(base({ ...s, dice: [[5, 5], [6], []], alive: [true, true, false] }), 0)
    expect(v.total).toBe(3)
    expect(v.unseen).toBe(1)
    expect(v.counts).toEqual([2, 1, 0])
  })

  it('plays the same move however the other cups fall — the policy cannot peek', () => {
    // Same public state, same own cup, opponents' faces rerolled. If `play` ever
    // reads State directly instead of the mask, these diverge.
    const mine = [5, 5, 5, 2, 3]
    const action = (others: number[][]) =>
      game.play!(base({ dice: [mine, others[0]!, others[1]!], turn: 0, bid: { count: 6, face: 5 }, bidder: 2 }), DEFAULTS, ctxFor('A'))
    const a = action([[6, 6, 6, 6, 6], [4, 4, 4, 4, 4]])
    const b = action([[1, 1, 1, 1, 1], [5, 5, 5, 5, 5]]) // 10 wild-ish dice: an omniscient policy would bid huge
    const c = action([[2, 3, 4, 6, 2], [3, 6, 2, 4, 3]]) // nothing for it there at all
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).toBe(JSON.stringify(c))
  })
})

// ————————————————————————————————————————————————————————————————
describe('liars-dice · knobs', () => {
  /** Seat 0 holds three 5s and no wilds; 10 dice unseen. Expected 5s ≈ 6 at wildTrust 0.8. */
  const table = (bid: { count: number; face: number } | null, mine = [5, 5, 5, 2, 3]) =>
    base({ dice: [mine, [1, 1, 1, 1, 1], [1, 1, 1, 1, 1]], turn: 0, bid, bidder: bid ? 1 : -1 })

  const act = (p: Partial<Params>, state: State) => game.play!(state, knobs(p), ctxFor('A')) as {
    bid?: { count: number; face: number }
    challenge?: boolean
  }

  it('skepticism decides whether an inflated bid gets called', () => {
    const inflated = table({ count: 8, face: 5 }) // claims 8 where ~6 is expected
    expect(act({ skepticism: 1, bluff: 1 }, inflated).challenge).toBe(true)
    expect(act({ skepticism: 0, bluff: 1 }, inflated).bid).toBeTruthy()
  })

  it('bluff decides whether you keep bidding or fold to a challenge', () => {
    const steep = table({ count: 8, face: 5 })
    expect(act({ skepticism: 0, bluff: 0 }, steep).challenge).toBe(true) // won't invent 3 dice
    expect(act({ skepticism: 0, bluff: 1 }, steep).bid).toBeTruthy()
  })

  it('openStrength slides the opening claim around the honest estimate', () => {
    const low = act({ openStrength: 0 }, table(null)).bid!
    const mid = act({ openStrength: 0.5 }, table(null)).bid!
    const high = act({ openStrength: 1 }, table(null)).bid!
    expect([low.face, mid.face, high.face]).toEqual([5, 5, 5]) // the face it actually holds
    expect(low.count).toBeLessThan(mid.count)
    expect(mid.count).toBeLessThan(high.count)
  })

  it('wildTrust decides how much of other people’s 1s you bank on', () => {
    const trusting = act({ wildTrust: 1 }, table(null)).bid!
    const paranoid = act({ wildTrust: 0 }, table(null)).bid!
    expect(paranoid.count).toBeLessThan(trusting.count)
    // and it moves the estimate itself, not just the opening
    const v = __policy.maskFor(table(null), 0)
    expect(__policy.expected(v, 5, knobs({ wildTrust: 0 }))).toBeCloseTo(3 + 10 / 6, 6)
    expect(__policy.expected(v, 5, knobs({ wildTrust: 1 }))).toBeCloseTo(3 + 20 / 6, 6)
  })

  it('faceLoyalty picks the face you hold over the cheapest legal raise', () => {
    const held = table({ count: 3, face: 2 }, [6, 6, 6, 6, 3])
    expect(act({ faceLoyalty: 0 }, held).bid!.face).toBe(3) // cheapest raise: next face up
    expect(act({ faceLoyalty: 1 }, held).bid!.face).toBe(6) // the four 6s it is actually holding
  })

  it('endgamePressure makes a short stack trigger-happy', () => {
    // One die left against a full cup: the same bid, the same skepticism: 0.
    const cornered = base({
      dice: [[4], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1]], // dice lengths are the public counts
      turn: 0,
      bid: { count: 5, face: 4 },
      bidder: 1,
    })
    expect(act({ skepticism: 0, bluff: 1, endgamePressure: 0 }, cornered).bid).toBeTruthy()
    expect(act({ skepticism: 0, bluff: 1, endgamePressure: 1 }, cornered).challenge).toBe(true)
  })

  it('only ever offers legal raises', () => {
    const v = __policy.maskFor(table({ count: 3, face: 4 }), 0)
    for (const cand of __policy.legalRaises(v)) {
      expect(cand.count).toBeLessThanOrEqual(v.total)
      expect(cand.face).toBeGreaterThanOrEqual(1)
      expect(cand.face).toBeLessThanOrEqual(6)
      expect(cand.count > 3 || cand.face > 4).toBe(true)
    }
  })

  it('challenges when the bid is maxed out and no raise exists', () => {
    const maxed = base({ dice: [[4, 4], [4, 4], [4, 4]], turn: 0, bid: { count: 6, face: 6 }, bidder: 1 })
    expect(act({ skepticism: 0, bluff: 1 }, maxed).challenge).toBe(true)
  })
})
