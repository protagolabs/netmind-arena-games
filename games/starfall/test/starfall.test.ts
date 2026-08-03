import { describe, it, expect } from 'vitest'
import { makeCtx, assertMatchSane, runStrategyMatch } from '@arena/game-sdk'
import type { Ctx } from '@arena/game-sdk'
import game from '../src/starfall.game'

type State = ReturnType<(typeof game)['init']>

const DEFAULTS = { expand: 0.65, aggression: 0.45, reinforce: 0.3, boldness: 0.5 }
const cfg2 = { players: ['alice', 'bob'] }

const ctxFor = (actor: string): Ctx => makeCtx({ seed: 1, actor })

/** Tiny hand-built map for exact combat arithmetic. */
function duelState(): State {
  const base = game.init(cfg2, makeCtx({ seed: 3 }))
  return {
    ...base,
    planets: [
      { id: 0, x: 10, y: 50, prod: 2, owner: 0, ships: 20, home: true },
      { id: 1, x: 45, y: 50, prod: 1, owner: 1, ships: 10, home: true },
      { id: 2, x: 24, y: 50, prod: 3, owner: -1, ships: 5, home: false },
    ],
    fleets: [],
    pending: [null, null],
    tick: 0,
    side: 0,
  }
}

function drive(s: State, orders: Array<Record<string, unknown>>): State {
  for (const o of orders) {
    s = game.reduce!(s, o, ctxFor(s.players[s.side]!))
  }
  return s
}

describe('starfall', () => {
  it('generates a symmetry-fair map, deterministic per seed', () => {
    for (const players of [cfg2.players, ['a', 'b', 'c'], ['a', 'b', 'c', 'd']]) {
      const s = game.init({ players }, makeCtx({ seed: 9 }))
      const homes = s.planets.filter((p) => p.home)
      expect(homes.length).toBe(players.length)
      // every seat owns exactly one home with identical stats
      for (let seat = 0; seat < players.length; seat++) {
        const h = homes.find((p) => p.owner === seat)!
        expect(h).toBeTruthy()
        expect(h.ships).toBe(homes[0]!.ships)
        expect(h.prod).toBe(homes[0]!.prod)
      }
      // neutral wedge replicas: every seat sees the same sorted (prod, dist)
      // multiset relative to its home. Garrisons deliberately carry a ±2
      // anti-mirror wobble, so assert their spread separately.
      const neutrals = s.planets.filter((p) => p.owner === -1 && !(p.x === 50 && p.y === 50))
      const profile = (seat: number) => {
        const h = homes.find((p) => p.owner === seat)!
        return neutrals
          .map((p) => `${p.prod}:${Math.round(Math.hypot(p.x - h.x, p.y - h.y))}`)
          .sort()
          .join('|')
      }
      for (let seat = 1; seat < players.length; seat++) {
        expect(profile(seat)).toBe(profile(0))
      }
      // wobble bound: replicas of one wedge star (same prod, same radius from
      // centre) stay within the ±2 band of each other
      const groups = new Map<string, number[]>()
      for (const p of neutrals) {
        const key = `${p.prod}:${Math.round(Math.hypot(p.x - 50, p.y - 50))}`
        groups.set(key, [...(groups.get(key) ?? []), p.ships])
      }
      for (const ships of groups.values()) {
        expect(Math.max(...ships) - Math.min(...ships)).toBeLessThanOrEqual(4)
      }
    }
    const a = game.init(cfg2, makeCtx({ seed: 9 }))
    const b = game.init(cfg2, makeCtx({ seed: 9 }))
    expect(a.planets).toEqual(b.planets)
  })

  it('rejects out-of-turn, malformed, foreign-star and post-game orders', () => {
    const s = duelState()
    expect(() => game.reduce!(s, { pass: true }, ctxFor('bob'))).toThrow(/not-your-turn/)
    expect(() => game.reduce!(s, null as never, ctxFor('alice'))).toThrow(/bad-action/)
    expect(() => game.reduce!(s, { from: 0, to: 0, ratio: 0.5 }, ctxFor('alice'))).toThrow(/invalid-order/)
    expect(() => game.reduce!(s, { from: 99, to: 1, ratio: 0.5 }, ctxFor('alice'))).toThrow(/invalid-order/)
    expect(() => game.reduce!(s, { from: 1, to: 0, ratio: 0.5 }, ctxFor('alice'))).toThrow(/not-your-star/)
  })

  it('keeps sealed orders secret until the tick resolves', () => {
    let s = duelState()
    s = game.reduce!(s, { from: 0, to: 2, ratio: 0.5 }, ctxFor('alice'))
    const pub = game.render!(s) as unknown as { committed: boolean[]; myPending: unknown }
    expect(pub.committed).toEqual([true, false])
    expect(pub.myPending).toBeNull()
    const mine = game.render!(s, { viewer: 'alice' }) as unknown as { myPending: { from: number } }
    expect(mine.myPending.from).toBe(0)
    const theirs = game.render!(s, { viewer: 'bob' }) as unknown as { myPending: unknown }
    expect(theirs.myPending).toBeNull()
  })

  it('resolves launch, production and combat arithmetic exactly', () => {
    let s = duelState()
    // alice sends 10 of 20 at the neutral (5 ships, prod 3, distance 14 → 2 ticks)
    s = drive(s, [{ from: 0, to: 2, ratio: 0.5 }, { pass: true }])
    expect(s.tick).toBe(1)
    expect(s.planets[0]!.ships).toBe(12) // 20 - 10 launched + 2 prod
    expect(s.fleets.length).toBe(1)
    expect(s.fleets[0]!.ships).toBe(10)
    // tick 2: fleet arrives — neutral does not grow: 10 vs 5 → capture with 5
    s = drive(s, [{ pass: true }, { pass: true }])
    expect(s.tick).toBe(2)
    expect(s.fleets.length).toBe(0)
    expect(s.planets[2]!.owner).toBe(0)
    expect(s.planets[2]!.ships).toBe(5)
    // repelled: bob throws 4 of 12 (floor) at alice's captured star (5 + prod 3 = 8 on arrival tick... )
    const before = s.planets[2]!.ships
    s = drive(s, [{ pass: true }, { from: 1, to: 2, ratio: 0.34 }])
    const sent = Math.floor((10 + 2) * 0.34) // bob home grew by prod 1 per tick
    void before
    void sent
    // fleet takes 3 ticks (distance 21); let it land
    s = drive(s, [{ pass: true }, { pass: true }])
    s = drive(s, [{ pass: true }, { pass: true }])
    expect(s.planets[2]!.owner).toBe(0) // repelled — defender grew faster than the strike
  })

  it('annihilation ends the match and scores placement points', () => {
    let s = duelState()
    // alice overruns bob's home: 18 ships, distance 35 → arrives tick 5; defence 10 + 4×prod = 14 < 18
    s = drive(s, [{ from: 0, to: 1, ratio: 0.9 }, { pass: true }])
    for (let i = 0; i < 4; i++) s = drive(s, [{ pass: true }, { pass: true }])
    expect(s.status).toBe('over')
    expect(s.winnerSeat).toBe(0)
    expect(game.terminal!(s)).toEqual({ done: true, winner: 'alice' })
    expect(game.score(s)).toEqual({ alice: 1, bob: 0.5 })
  })

  it('hits the tick cap and ranks by empire size', () => {
    let s = duelState()
    let guard = 0
    while (s.status === 'playing' && guard++ < 200) {
      s = drive(s, [{ pass: true }, { pass: true }])
    }
    expect(s.status).toBe('over')
    expect(s.tick).toBe(80)
    // alice: prod 2 home vs bob: prod 1 home → alice's empire is bigger
    expect(s.winnerSeat).toBe(0)
    const sc = game.score(s)
    expect(sc['alice']).toBe(1)
    expect(sc['bob']).toBe(0.5)
  })

  it('strategy pace: deterministic, terminating, fair scores for 2-4 players', () => {
    for (const players of [['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']]) {
      for (let seed = 0; seed < 8; seed++) {
        const r = assertMatchSane(
          game,
          { players },
          players.map(() => DEFAULTS),
          seed,
        )
        const final = r.finalState as { status: string; tick: number }
        expect(final.status).toBe('over')
        expect(r.steps).toBeLessThanOrEqual(game.meta.maxSteps!)
        const total = players.reduce((acc, p) => acc + r.scores[p]!, 0)
        expect(total).toBeGreaterThan(0.9) // placement points always land
      }
    }
  })

  it('mirrored defaults do not lock into rotational lock-step', () => {
    // salt + per-seat tie-breaks must desynchronise equal policies (light-cycles lesson)
    let identical = 0
    for (let seed = 0; seed < 10; seed++) {
      const r = runStrategyMatch(game, cfg2, [DEFAULTS, DEFAULTS], seed)
      const s = r.finalState as { planets: { owner: number; ships: number }[] }
      const e0 = s.planets.filter((p) => p.owner === 0).reduce((a, p) => a + p.ships, 0)
      const e1 = s.planets.filter((p) => p.owner === 1).reduce((a, p) => a + p.ships, 0)
      if (e0 === e1) identical++
    }
    expect(identical).toBeLessThan(10)
  })
})
