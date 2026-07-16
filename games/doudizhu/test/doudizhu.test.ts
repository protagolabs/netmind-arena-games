import { describe, it, expect } from 'vitest'
import { makeCtx } from '@arena/game-sdk'
import game, { type State } from '../src/doudizhu.game'
import { classify, beats } from '../src/combos'

const CFG = { players: ['A', 'B', 'C'] }
const ctxFor = (actor: string) => makeCtx({ seed: 1, actor })

/** Start from a real init, then override fields for a controlled scenario. */
function base(overrides: Partial<State>): State {
  const s = game.init(CFG, makeCtx({ seed: 1 }))
  return { ...s, ...overrides }
}

// ————————————————————————————————————————————————————————————————
describe('combos · classify', () => {
  it('identifies fixed shapes', () => {
    expect(classify([9])).toMatchObject({ type: 'single', key: 9 })
    expect(classify([9, 9])).toMatchObject({ type: 'pair', key: 9 })
    expect(classify([9, 9, 9])).toMatchObject({ type: 'triple', key: 9 })
    expect(classify([9, 9, 9, 3])).toMatchObject({ type: 'triple_single', key: 9 })
    expect(classify([9, 9, 9, 3, 3])).toMatchObject({ type: 'triple_pair', key: 9 })
    expect(classify([9, 9, 9, 9])).toMatchObject({ type: 'bomb', key: 9 })
    expect(classify([16, 17])).toMatchObject({ type: 'rocket' })
    expect(classify([9, 9, 9, 9, 3, 5])).toMatchObject({ type: 'four_two_single', key: 9 })
    expect(classify([9, 9, 9, 9, 3, 3, 5, 5])).toMatchObject({ type: 'four_two_pair', key: 9 })
  })

  it('identifies sequences with length', () => {
    expect(classify([3, 4, 5, 6, 7])).toMatchObject({ type: 'straight', key: 7, len: 5 })
    expect(classify([3, 3, 4, 4, 5, 5])).toMatchObject({ type: 'pairs_seq', key: 5, len: 3 })
    // airplane: two consecutive triples, no wings
    expect(classify([7, 7, 7, 8, 8, 8])).toMatchObject({ type: 'airplane', key: 8, len: 2 })
    // airplane + single wings (2 triples + 2 singles)
    expect(classify([7, 7, 7, 8, 8, 8, 3, 4])).toMatchObject({ type: 'airplane', key: 8, len: 2 })
    // airplane + pair wings (2 triples + 2 pairs)
    expect(classify([7, 7, 7, 8, 8, 8, 3, 3, 4, 4])).toMatchObject({ type: 'airplane', key: 8, len: 2 })
  })

  it('rejects illegal shapes', () => {
    expect(classify([3, 9])).toBeNull() // two different singles
    expect(classify([3, 4, 5, 6])).toBeNull() // straight too short (<5)
    expect(classify([13, 14, 15, 3, 4])).toBeNull() // straight may not wrap through 2
    expect(classify([15, 15, 15, 15, 15])).toBeNull() // 5 of a kind impossible
    expect(classify([7, 7, 7, 9, 9, 9])).toBeNull() // triples not consecutive
    expect(classify([7, 7, 7, 8, 8, 8, 3])).toBeNull() // airplane wings count mismatch
  })
})

describe('combos · beats', () => {
  const c = (xs: number[]) => classify(xs)!
  it('same type: higher key wins, sequences must match length', () => {
    expect(beats(c([5]), c([9]))).toBe(true)
    expect(beats(c([9]), c([5]))).toBe(false)
    expect(beats(c([5, 5]), c([9]))).toBe(false) // single can't beat a pair
    expect(beats(c([3, 4, 5, 6, 7]), c([4, 5, 6, 7, 8]))).toBe(true)
    expect(beats(c([3, 4, 5, 6, 7]), c([4, 5, 6, 7, 8, 9]))).toBe(false) // different length
  })
  it('bombs and rocket', () => {
    expect(beats(c([3, 4, 5, 6, 7]), c([9, 9, 9, 9]))).toBe(true) // bomb tops non-bomb
    expect(beats(c([5, 5, 5, 5]), c([9, 9, 9, 9]))).toBe(true) // higher bomb
    expect(beats(c([9, 9, 9, 9]), c([5, 5, 5, 5]))).toBe(false)
    expect(beats(c([9, 9, 9, 9]), c([16, 17]))).toBe(true) // rocket tops bomb
    expect(beats(c([16, 17]), c([9, 9, 9, 9]))).toBe(false) // nothing tops rocket
  })
})

// ————————————————————————————————————————————————————————————————
describe('doudizhu · dealing', () => {
  it('deals 17/17/17 + 3 with a complete 54-card deck', () => {
    const s = game.init(CFG, makeCtx({ seed: 5 }))
    expect(s.hands.map((h) => h.length)).toEqual([17, 17, 17])
    expect(s.bottom.length).toBe(3)
    const all = [...s.hands.flat(), ...s.bottom]
    expect(all.length).toBe(54)
    const c = new Map<number, number>()
    for (const r of all) c.set(r, (c.get(r) ?? 0) + 1)
    for (let r = 3; r <= 15; r++) expect(c.get(r)).toBe(4)
    expect(c.get(16)).toBe(1)
    expect(c.get(17)).toBe(1)
  })

  it('is deterministic per seed', () => {
    const a = game.init(CFG, makeCtx({ seed: 42 }))
    const b = game.init(CFG, makeCtx({ seed: 42 }))
    expect(JSON.stringify(a.hands)).toBe(JSON.stringify(b.hands))
  })
})

describe('doudizhu · bidding', () => {
  it('highest bidder becomes landlord and takes the bottom (20 cards)', () => {
    let s = game.init(CFG, makeCtx({ seed: 1 }))
    s = game.reduce!(s, { bid: 1 }, ctxFor('A'))
    s = game.reduce!(s, { bid: 2 }, ctxFor('B'))
    s = game.reduce!(s, { bid: 0 }, ctxFor('C'))
    expect(s.phase).toBe('playing')
    expect(s.landlord).toBe(1)
    expect(s.hands[1]!.length).toBe(20)
    expect(s.bottomRevealed).toBe(true)
    expect(s.multiplier).toBe(2)
    expect(s.turn).toBe(1)
  })

  it('a bid of 3 ends bidding immediately', () => {
    let s = game.init(CFG, makeCtx({ seed: 1 }))
    s = game.reduce!(s, { bid: 3 }, ctxFor('A'))
    expect(s.phase).toBe('playing')
    expect(s.landlord).toBe(0)
    expect(s.multiplier).toBe(3)
  })

  it('rejects non-raising bids and out-of-turn actions', () => {
    let s = game.init(CFG, makeCtx({ seed: 1 }))
    expect(() => game.reduce!(s, { bid: 1 }, ctxFor('B'))).toThrow(/not-your-turn/)
    s = game.reduce!(s, { bid: 1 }, ctxFor('A'))
    expect(() => game.reduce!(s, { bid: 1 }, ctxFor('B'))).toThrow(/bad-bid/) // must exceed current high
    expect(() => game.reduce!(s, { bid: 9 }, ctxFor('B'))).toThrow(/bad-bid/)
  })
})

describe('doudizhu · play flow', () => {
  const playing = (h: State['hands']) =>
    base({ phase: 'playing', landlord: 0, turn: 0, side: 0, table: null, multiplier: 2, hands: h, bottomRevealed: true })

  it('lead → beat → cant-beat → double-pass resets lead → win', () => {
    let s = playing([
      [3, 3, 9],
      [4, 4, 10],
      [5, 5, 11],
    ])
    // A leads a pair
    s = game.reduce!(s, { cards: [3, 3] }, ctxFor('A'))
    expect(s.table?.combo.type).toBe('pair')
    expect(s.turn).toBe(1)
    // B beats with a higher pair
    s = game.reduce!(s, { cards: [4, 4] }, ctxFor('B'))
    // C beats again
    s = game.reduce!(s, { cards: [5, 5] }, ctxFor('C'))
    expect(s.turn).toBe(0)
    // A (holding only [9]) cannot beat a pair with a single
    expect(() => game.reduce!(s, { cards: [9] }, ctxFor('A'))).toThrow(/cant-beat/)
    // A passes, then B passes → trick resets to C (last to play)
    s = game.reduce!(s, { pass: true }, ctxFor('A'))
    s = game.reduce!(s, { pass: true }, ctxFor('B'))
    expect(s.table).toBeNull()
    expect(s.turn).toBe(2)
    // C leads its last card and wins for the peasants
    s = game.reduce!(s, { cards: [11] }, ctxFor('C'))
    expect(s.phase).toBe('done')
    expect(game.terminal!(s).winner).toBe('C')
  })

  it('rejects illegal plays', () => {
    const s = playing([[3, 3, 9], [4], [5]])
    expect(() => game.reduce!(s, { pass: true }, ctxFor('A'))).toThrow(/must-lead/) // can't pass on a free lead
    expect(() => game.reduce!(s, { cards: [8] }, ctxFor('A'))).toThrow(/dont-own-cards/)
    expect(() => game.reduce!(s, { cards: [3, 9] }, ctxFor('A'))).toThrow(/invalid-combo/)
    expect(() => game.reduce!(s, { cards: [3] }, ctxFor('B'))).toThrow(/not-your-turn/)
  })

  it('a bomb doubles the multiplier', () => {
    let s = playing([[9, 9, 9, 9, 3], [4], [5]])
    s = game.reduce!(s, { cards: [9, 9, 9, 9] }, ctxFor('A'))
    expect(s.table?.combo.type).toBe('bomb')
    expect(s.multiplier).toBe(4) // 2 → 4
  })
})

describe('doudizhu · scoring', () => {
  it('landlord win pays landlord +2·stake, peasants −stake', () => {
    const s = base({ phase: 'done', landlord: 0, finisher: 0, multiplier: 2, peasantPlayed: true, landlordPlays: 5 })
    expect(game.score(s)).toEqual({ A: 4, B: -2, C: -2 })
  })
  it('peasant win pays landlord −2·stake, peasants +stake', () => {
    const s = base({ phase: 'done', landlord: 0, finisher: 1, multiplier: 3, peasantPlayed: true, landlordPlays: 3 })
    expect(game.score(s)).toEqual({ A: -6, B: 3, C: 3 })
  })
  it('spring (peasants never played) doubles the stake', () => {
    const s = base({ phase: 'done', landlord: 0, finisher: 0, multiplier: 1, peasantPlayed: false, landlordPlays: 5 })
    expect(game.score(s)).toEqual({ A: 4, B: -2, C: -2 }) // stake 1→2
  })
})

describe('doudizhu · viewer-scoped render (hidden info)', () => {
  const s = base({ phase: 'playing', landlord: 0, turn: 0, hands: [[3, 4], [5, 6], [7, 8]] })

  it('reveals only the viewer’s own hand', () => {
    const forA = game.render!(s, { viewer: 'A' }) as unknown as { seats: Array<{ seat: number; hand?: number[]; count: number }> }
    expect(forA.seats[0]!.hand).toEqual([3, 4]) // A sees own hand
    expect(forA.seats[1]!.hand).toBeUndefined() // B/C hidden
    expect(forA.seats[2]!.hand).toBeUndefined()
    expect(forA.seats[1]!.count).toBe(2)

    const forB = game.render!(s, { viewer: 'B' }) as unknown as { seats: Array<{ seat: number; hand?: number[] }> }
    expect(forB.seats[1]!.hand).toEqual([5, 6])
    expect(forB.seats[0]!.hand).toBeUndefined()
  })

  it('public/spectator view reveals no hands mid-game', () => {
    const pub = JSON.stringify(game.render!(s))
    expect(pub).not.toContain('hand')
  })

  it('reveals every remaining hand once the game is over (losers shown)', () => {
    const done = base({ phase: 'done', landlord: 0, finisher: 0, hands: [[], [5, 6], [7]] })
    const pub = game.render!(done) as unknown as { seats: Array<{ seat: number; hand?: number[] }> }
    expect(pub.seats[1]!.hand).toEqual([5, 6]) // loser's leftover cards revealed to all
    expect(pub.seats[2]!.hand).toEqual([7])
  })

  it('renders an older settled state that predates `trick` without throwing', () => {
    // A gameState persisted by a pre-`trick` bundle has no trick field; a newer
    // bundle must still render it (hiddenInfo → renderFor runs on settled states).
    const old = base({ phase: 'done', landlord: 0, finisher: 0, hands: [[], [5], [6]] })
    delete (old as { trick?: unknown }).trick
    expect(() => game.render!(old)).not.toThrow()
    expect(() => game.render!(old, { viewer: 'A' })).not.toThrow()
  })

  it('hides the bottom until it is revealed', () => {
    const hidden = game.render!(base({ bottomRevealed: false, bottom: [15, 16, 17] })) as unknown as { bottom: { cards: number[] } }
    expect(hidden.bottom.cards).toEqual([])
    const shown = game.render!(base({ bottomRevealed: true, bottom: [15, 16, 17] })) as unknown as { bottom: { cards: number[] } }
    expect(shown.bottom.cards).toEqual([15, 16, 17])
  })
})
