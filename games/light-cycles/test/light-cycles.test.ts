import { describe, it, expect } from 'vitest'
import { makeCtx, assertMatchSane } from '@arena/game-sdk'
import type { Ctx } from '@arena/game-sdk'
import game from '../src/light-cycles.game'

type Dir = 'U' | 'D' | 'L' | 'R'

const cfg = { players: ['alice', 'bob'] }
const DEFAULTS = { space: 0.7, aggression: 0.35, hug: 0.25, caution: 0.6 }

const ctxFor = (actor: string): Ctx => makeCtx({ seed: 1, actor })

type State = ReturnType<(typeof game)['init']>

function fresh(seed = 7): State {
  return game.init(cfg, makeCtx({ seed }))
}

/**
 * Hand-built board for scripted duels. init() deliberately never produces
 * symmetric spawns any more, but reduce() doesn't care where riders start —
 * so collision scripts pin the rows they need (including same-row setups).
 */
function makeState(r0: number, r1: number): State {
  const grid = Array.from({ length: 13 }, () => Array<number>(13).fill(0))
  grid[r0]![2] = 1
  grid[r1]![10] = 2
  return {
    players: ['alice', 'bob'],
    w: 13,
    h: 13,
    grid,
    heads: [
      { x: 2, y: r0 },
      { x: 10, y: r1 },
    ],
    pending: [null, null],
    tick: 0,
    status: 'playing',
    crashes: [],
    moves: 0,
    side: 0,
    salt: 42,
  }
}

/** Drive scripted ticks: per entry, seat 0 commits first, then seat 1. */
function drive(s: State, ticks: Array<[Dir, Dir]>) {
  for (const [d0, d1] of ticks) {
    s = game.reduce!(s, { dir: d0 }, ctxFor('alice'))
    s = game.reduce!(s, { dir: d1 }, ctxFor('bob'))
  }
  return s
}

describe('light-cycles', () => {
  it('spawns on mirrored columns with rows off both symmetry axes', () => {
    for (let seed = 0; seed < 20; seed++) {
      const s = fresh(seed)
      expect(s.heads[0].x).toBe(2)
      expect(s.heads[1].x).toBe(10)
      for (const i of [0, 1] as const) {
        expect(s.heads[i].y).toBeGreaterThanOrEqual(2)
        expect(s.heads[i].y).toBeLessThanOrEqual(10)
      }
      // never mirror-symmetric (same row) nor point-symmetric (rotated row):
      // a symmetric spawn is what lets equal policies lock into a dance.
      expect(s.heads[1].y).not.toBe(s.heads[0].y)
      expect(s.heads[1].y).not.toBe(12 - s.heads[0].y)
      expect(s.grid[s.heads[0].y]![2]).toBe(1)
      expect(s.grid[s.heads[1].y]![10]).toBe(2)
      expect(s.side).toBe(0)
    }
    // same seed -> same spawn (init randomness is seeded)
    expect(fresh(7).heads).toEqual(fresh(7).heads)
  })

  it('rejects out-of-turn, malformed, and post-game actions', () => {
    const s = fresh()
    // seat 0 commits first each tick; bob is not due yet.
    expect(() => game.reduce!(s, { dir: 'U' }, ctxFor('bob'))).toThrow(/not-your-turn/)
    expect(() => game.reduce!(s, { dir: 'X' }, ctxFor('alice'))).toThrow(/invalid-direction/)
    expect(() => game.reduce!(s, {}, ctxFor('alice'))).toThrow(/invalid-direction/)
    expect(() => game.reduce!(s, null as never, ctxFor('alice'))).toThrow(/bad-action/)
    // after seat 0 commits, alice may not commit again this tick.
    const mid = game.reduce!(s, { dir: 'R' }, ctxFor('alice'))
    expect(() => game.reduce!(mid, { dir: 'R' }, ctxFor('alice'))).toThrow(/not-your-turn/)
    // once over, everything is rejected.
    const over = drive(makeState(6, 6), [
      ['R', 'L'],
      ['R', 'L'],
      ['R', 'L'],
      ['R', 'L'],
    ])
    expect(over.status).toBe('over')
    expect(() => game.reduce!(over, { dir: 'U' }, ctxFor('alice'))).toThrow(/game-over/)
  })

  it('keeps the sealed commit secret from the opponent and spectators', () => {
    const s = fresh()
    const before = game.render!(s) as unknown as { board: { cells: number[][] } }
    const mid = game.reduce!(s, { dir: 'R' }, ctxFor('alice'))

    const pub = game.render!(mid) as unknown as {
      committed: [boolean, boolean]
      myPending: Dir | null
      board: { cells: number[][] }
    }
    expect(pub.committed).toEqual([true, false])
    expect(pub.myPending).toBeNull() // spectator never sees the direction
    // the sealed commit must not move anything on the public board
    expect(pub.board.cells).toEqual(before.board.cells)

    const mine = game.render!(mid, { viewer: 'alice' }) as unknown as { myPending: Dir | null }
    expect(mine.myPending).toBe('R')
    const theirs = game.render!(mid, { viewer: 'bob' }) as unknown as { myPending: Dir | null }
    expect(theirs.myPending).toBeNull()
  })

  it('head-on: both riders racing the same cell wreck together — draw', () => {
    // same-row duel, 8 cells apart; four straight ticks meet at x=6
    const s = drive(makeState(6, 6), [
      ['R', 'L'],
      ['R', 'L'],
      ['R', 'L'],
      ['R', 'L'],
    ])
    expect(s.status).toBe('over')
    expect(s.winner).toBeUndefined()
    expect(s.tick).toBe(4)
    expect(s.crashes.map((c) => c.cause)).toEqual(['head-on', 'head-on'])
    expect(game.terminal!(s)).toEqual({ done: true, winner: null })
    expect(game.score(s)).toEqual({ alice: 0.5, bob: 0.5 })
  })

  it('wall: riding off the arena wrecks you, opponent wins', () => {
    const s = drive(makeState(4, 8), [
      ['L', 'U'],
      ['L', 'R'],
      ['L', 'D'], // alice: x 1 -> 0 -> -1 (wall). bob rides a safe hook.
    ])
    expect(s.status).toBe('over')
    expect(s.winner).toBe('bob')
    expect(s.crashes).toEqual([{ seat: 0, x: -1, y: 4, cause: 'wall' }])
    expect(game.score(s)).toEqual({ alice: 0, bob: 1 })
  })

  it('trail: entering an opponent trail cell wrecks you', () => {
    // alice marches straight into bob's spawn cell (a trail forever);
    // bob rides an 8-tick survival loop that never re-enters his own trail.
    const s = drive(makeState(6, 6), [
      ['R', 'U'],
      ['R', 'R'],
      ['R', 'D'],
      ['R', 'D'],
      ['R', 'R'],
      ['R', 'U'],
      ['R', 'U'],
      ['R', 'U'], // alice: 3,4,...,9 then (10,6) = bob's origin -> wreck
    ])
    expect(s.status).toBe('over')
    expect(s.winner).toBe('bob')
    expect(s.crashes).toEqual([{ seat: 0, x: 10, y: 6, cause: 'trail' }])
  })

  it('reverse: doubling back into your own trail is suicide', () => {
    const s = drive(makeState(4, 8), [
      ['R', 'U'],
      ['L', 'U'], // alice reverses into her own spawn cell
    ])
    expect(s.status).toBe('over')
    expect(s.winner).toBe('bob')
    expect(s.crashes[0]).toMatchObject({ seat: 0, cause: 'trail' })
  })

  it('swap: adjacent riders exchanging cells both wreck on trails', () => {
    // odd row offset -> odd head distance is reachable; engineer adjacency:
    // after tick 1 heads sit at (3,5) and (9,6) ... run them toward each other
    // on their own rows, then bob steps up into alice's row ahead of her.
    let s = makeState(5, 6)
    s = drive(s, [
      ['R', 'L'], // (3,5) (9,6)
      ['R', 'L'], // (4,5) (8,6)
      ['R', 'L'], // (5,5) (7,6)
      ['R', 'U'], // (6,5) (7,5) — orthogonally adjacent, distance 1
    ])
    expect(s.status).toBe('playing')
    // both ride into the cell the other just vacated: trail deaths, not head-on
    s = drive(s, [['R', 'L']])
    expect(s.status).toBe('over')
    expect(s.winner).toBeUndefined()
    expect(s.crashes.map((c) => c.cause)).toEqual(['trail', 'trail'])
    expect(game.score(s)).toEqual({ alice: 0.5, bob: 0.5 })
  })

  it('strategy pace: deterministic, terminating, sane scores over many seeds', () => {
    for (let seed = 0; seed < 15; seed++) {
      const r = assertMatchSane(game, cfg, [DEFAULTS, DEFAULTS], seed)
      const final = r.finalState as { status: string }
      expect(final.status).toBe('over')
      expect(r.scores['alice']! + r.scores['bob']!).toBe(1)
      expect(r.steps).toBeLessThanOrEqual(game.meta.maxSteps!)
    }
  })

  it('mirrored defaults never lock into a full-match mirror dance', () => {
    // Regression: the seats' deterministic scores are exactly equal at any
    // mirror-symmetric position, and jitter alone breaks the tie the same way
    // ~50% of the time — some seeds used to mirror every single tick straight
    // into a guaranteed mutual wreck. The seat-keyed tie-break must prevent
    // any full-match mirror across many seeds.
    const MIRROR: Record<Dir, Dir> = { U: 'U', D: 'D', L: 'R', R: 'L' }
    for (let seed = 0; seed < 10; seed++) {
      const ctx = makeCtx({ seed })
      let s = game.init(cfg, ctx)
      const dirs: [Dir[], Dir[]] = [[], []]
      let steps = 0
      while (!game.terminal!(s).done && steps < game.meta.maxSteps!) {
        const side = s.side
        const seatCtx = { ...ctx, side }
        const action = game.play!(s, DEFAULTS, seatCtx) as { dir: Dir }
        dirs[side].push(action.dir)
        s = game.apply!(s, action, seatCtx)
        steps++
      }
      const n = Math.min(dirs[0].length, dirs[1].length)
      const mirrored = dirs[0].slice(0, n).filter((d, i) => MIRROR[d] === dirs[1][i]).length
      expect(mirrored, `seed ${seed} played a full mirror match`).toBeLessThan(n)
    }
  })

  it('turn-based pace: full self-play match is deterministic', () => {
    const run = () => {
      let s = fresh(11)
      let steps = 0
      while (!game.terminal!(s).done && steps < game.meta.maxSteps!) {
        const actor = s.players[s.side]!
        const action = game.play!(s, DEFAULTS, makeCtx({ seed: 11, side: s.side, actor }))
        s = game.reduce!(s, action, makeCtx({ seed: 11, actor }))
        steps++
      }
      return { scores: game.score(s), tick: s.tick }
    }
    const a = run()
    const b = run()
    expect(a).toEqual(b)
    expect(a.scores['alice']! + a.scores['bob']!).toBe(1)
    expect(a.tick).toBeGreaterThan(0)
  })
})
