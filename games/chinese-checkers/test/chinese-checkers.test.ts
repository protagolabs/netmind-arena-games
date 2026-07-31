import { describe, it, expect } from 'vitest'
import { assertMatchSane, clampParams, makeCtx, runStrategyMatch } from '@arena/game-sdk'
import game, { __geometry as G } from '../src/chinese-checkers.game'

const cfg = { players: ['alice', 'bob'] }

type State = ReturnType<(typeof game)['init']>
type Params = { laggard: number; jumpBias: number; homing: number }

const racer = clampParams(game as never, { laggard: 0.2, jumpBias: 1.2, homing: 3 }) as Params
const plodder = clampParams(game as never, { laggard: 1.6, jumpBias: 0.1, homing: 0.5 }) as Params

/** Hole index for a cube coordinate, addressed by its (x, z) pair. */
const idx = (x: number, z: number): number => G.HOLES.findIndex((h) => h[0] === x && h[2] === z)

/** A blank board with the given pegs placed — for pinning down one rule at a time. */
const boardWith = (pegs: [number, number, 0 | 1][]): number[] => {
  const cells = new Array<number>(G.N).fill(-1)
  for (const [x, z, seat] of pegs) cells[idx(x, z)] = seat
  return cells
}

/** Does `seat` have a legal move ending on `to`? */
const canReach = (cells: number[], seat: 0 | 1, to: number): boolean =>
  G.legalPaths(cells, seat).some((p) => p[p.length - 1] === to)

describe('chinese-checkers · geometry', () => {
  it('builds the classic 121-hole star', () => {
    expect(G.N).toBe(121)
    const hexagon = G.HOLES.filter(([x, y, z]) => Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) <= 4)
    expect(hexagon.length).toBe(61) // 121 = 61 centre + 6 points of 10
  })

  it('gives each seat a 10-hole point, and each seat targets the other', () => {
    expect(G.IS_HOME[0]!.filter(Boolean).length).toBe(10)
    expect(G.IS_HOME[1]!.filter(Boolean).length).toBe(10)
    expect(G.IS_TARGET[0]).toEqual(G.IS_HOME[1])
    expect(G.IS_TARGET[1]).toEqual(G.IS_HOME[0])
    // No hole belongs to both seats' points.
    expect(G.IS_HOME[0]!.some((h, i) => h && G.IS_HOME[1]![i])).toBe(false)
  })

  it('has symmetric neighbours — d and d+3 are opposite directions', () => {
    for (let i = 0; i < G.N; i++) {
      for (let d = 0; d < 6; d++) {
        const j = G.NEIGHBOURS[i]![d]!
        if (j >= 0) expect(G.NEIGHBOURS[j]![(d + 3) % 6]).toBe(i)
      }
    }
  })

  it('lands jumps exactly two steps out in the same direction', () => {
    for (let i = 0; i < G.N; i++) {
      for (let d = 0; d < 6; d++) {
        const over = G.NEIGHBOURS[i]![d]!
        const to = G.LANDINGS[i]![d]!
        if (to >= 0) expect(G.NEIGHBOURS[over]![d]).toBe(to)
      }
    }
  })

  it('reaches the distance floor exactly when a point is full', () => {
    // The ten target holes are the ten closest to the tip, so MIN_DIST is only
    // attainable by filling the point — that is what makes it a win condition.
    const full = new Array<number>(G.N).fill(-1)
    G.IS_TARGET[0]!.forEach((isTarget, i) => {
      if (isTarget) full[i] = 0
    })
    expect(G.totalDist(full, 0)).toBe(G.MIN_DIST)
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    expect(G.totalDist(s.cells, 0)).toBeGreaterThan(G.MIN_DIST)
  })
})

describe('chinese-checkers · strategy pace', () => {
  it('runs a sane, deterministic match', () => {
    const r = assertMatchSane(game, cfg, [racer, plodder], 12345)
    expect(r.steps).toBeGreaterThan(0)
    const vals = Object.values(r.scores).sort()
    expect(vals[0]! + vals[1]!).toBeCloseTo(1, 10)
  })

  it('always terminates within maxSteps across 100 seeds', () => {
    for (let seed = 0; seed < 100; seed++) {
      const r = runStrategyMatch(game, cfg, [racer, plodder], seed)
      expect(game.terminal!(r.finalState).done).toBe(true)
      expect(r.steps).toBeLessThanOrEqual(game.meta.maxSteps!)
    }
  })

  it('converges on a real win, not the step cap, across 100 seeds', () => {
    // If this ever fails the heuristic has stalled — fix `play`, do not just
    // raise maxSteps.
    for (let seed = 0; seed < 100; seed++) {
      const r = runStrategyMatch(game, cfg, [racer, plodder], seed)
      expect((r.finalState as State).status).toBe('won')
      expect(r.steps).toBeLessThan(G.MAX_PLIES)
    }
  })

  it('emits a render frame per step', () => {
    const r = runStrategyMatch(game, cfg, [racer, plodder], 7)
    expect(r.frames.length).toBe(r.steps + 1) // initial + one per move
  })
})

describe('chinese-checkers · move generation', () => {
  const opening = (): State => ({ ...game.init(cfg, makeCtx({ seed: 1 })), side: 0 })

  it('applies a legal single step', () => {
    const s = opening()
    const step = G.legalPaths(s.cells, 0).find((p) => p.length === 2)!
    const next = game.apply!(s, { path: step }, makeCtx({ seed: 1 }))
    expect(next.cells[step[0]!]).toBe(-1)
    expect(next.cells[step[1]!]).toBe(0)
    expect(next.side).toBe(1)
    expect(next.ply).toBe(1)
  })

  it('applies a chained jump, landing only on the final hole', () => {
    // A ladder down the z axis: hop (0,0) -> (0,2) -> (0,4) over two pegs.
    const s: State = { ...opening(), cells: boardWith([[0, 0, 0], [0, 1, 1], [0, 3, 1]]) }
    const path = [idx(0, 0), idx(0, 2), idx(0, 4)]
    expect(G.legalPaths(s.cells, 0)).toContainEqual(path)

    const next = game.apply!(s, { path }, makeCtx({ seed: 1 }))
    expect(next.cells[idx(0, 0)]).toBe(-1)
    expect(next.cells[idx(0, 2)]).toBe(-1) // merely passed through
    expect(next.cells[idx(0, 4)]).toBe(0)
    expect(next.cells[idx(0, 1)]).toBe(1) // nothing is ever captured
    expect(next.cells[idx(0, 3)]).toBe(1)
  })

  it('offers a stop at every hop of a chain, not just the end', () => {
    const s: State = { ...opening(), cells: boardWith([[0, 0, 0], [0, 1, 1], [0, 3, 1]]) }
    expect(canReach(s.cells, 0, idx(0, 2))).toBe(true) // stop after one hop
    expect(canReach(s.cells, 0, idx(0, 4))).toBe(true) // or carry on
  })

  it('never generates a jump over an empty hole or onto an occupied one', () => {
    // Nothing at (0,1) to hop over, so (0,2) is unreachable from (0,0).
    const bare: State = { ...opening(), cells: boardWith([[0, 0, 0]]) }
    expect(canReach(bare.cells, 0, idx(0, 2))).toBe(false)

    // Correct hop, but the landing hole is taken.
    const blocked: State = { ...opening(), cells: boardWith([[0, 0, 0], [0, 1, 1], [0, 2, 1]]) }
    expect(canReach(blocked.cells, 0, idx(0, 2))).toBe(false)
  })

  it('never revisits a hole within a chain, so chains cannot loop', () => {
    // A peg ringed by hoppable neighbours is where a cycle would show up.
    const ring: [number, number, 0 | 1][] = [
      [0, 0, 0],
      [1, 0, 1],
      [1, -1, 1],
      [0, -1, 1],
      [-1, 0, 1],
      [-1, 1, 1],
      [0, 1, 1],
    ]
    const states = [opening().cells, boardWith(ring)]
    for (const cells of states) {
      for (const seat of [0, 1] as const) {
        for (const p of G.legalPaths(cells, seat)) {
          expect(new Set(p).size).toBe(p.length)
        }
      }
    }
  })

  it('only ever moves the mover’s own pegs', () => {
    const s = opening()
    for (const p of G.legalPaths(s.cells, 0)) expect(s.cells[p[0]!]).toBe(0)
  })
})

describe('chinese-checkers · anti-stalling rules', () => {
  it('will not let a peg move back into its own point', () => {
    // (-1,4) sits just outside seat 0's point; (-1,5) is inside it.
    const cells = boardWith([[-1, 4, 0]])
    expect(G.IS_HOME[0]![idx(-1, 5)]).toBe(true)
    expect(G.IS_HOME[0]![idx(-1, 4)]).toBe(false)
    expect(canReach(cells, 0, idx(-1, 5))).toBe(false)
  })

  it('will not let a peg leave the point it has already reached', () => {
    // (1,-5) is inside seat 0's target point; (1,-4) is outside it.
    const cells = boardWith([[1, -5, 0]])
    expect(G.IS_TARGET[0]![idx(1, -5)]).toBe(true)
    expect(G.IS_TARGET[0]![idx(1, -4)]).toBe(false)
    expect(canReach(cells, 0, idx(1, -4))).toBe(false)
    // Every move it does have keeps it inside the point.
    for (const p of G.legalPaths(cells, 0)) expect(G.IS_TARGET[0]![p[p.length - 1]!]).toBe(true)
  })

  it('still allows shuffling within a point, so pegs can unpack', () => {
    // Two seat-0 pegs inside their own point with an empty hole between them.
    const s: State = { ...game.init(cfg, makeCtx({ seed: 1 })), side: 0, cells: boardWith([[-4, 5, 0]]) }
    const moves = G.legalPaths(s.cells, 0)
    expect(moves.some((p) => G.IS_HOME[0]![p[p.length - 1]!])).toBe(true)
  })
})

describe('chinese-checkers · settlement', () => {
  it('settles on progress at the step cap and hands it to the leader', () => {
    const base = game.init(cfg, makeCtx({ seed: 1 }))
    const s: State = { ...base, side: 0, ply: G.MAX_PLIES - 1 }
    const action = game.play!(s, racer, makeCtx({ seed: 1, side: 0 }))
    const done = game.apply!(s, action, makeCtx({ seed: 1 }))

    expect(done.status).toBe('adjudicated')
    expect(game.terminal!(done).done).toBe(true)
    // Seat 0 just advanced from a mirror-image start, so it leads.
    expect(done.winner).toBe('alice')

    const sc = game.score(done)
    expect(sc['alice']! + sc['bob']!).toBeCloseTo(1, 10)
    expect(sc['alice']!).toBeGreaterThan(0.5)
    expect(sc['alice']!).toBeLessThanOrEqual(0.85) // never outranks an outright win
  })

  it('calls a dead-level cap a draw', () => {
    const s: State = { ...game.init(cfg, makeCtx({ seed: 1 })), status: 'draw', winner: undefined }
    expect(game.terminal!(s)).toEqual({ done: true, winner: null })
    expect(game.score(s)).toEqual({ alice: 0.5, bob: 0.5 })
  })

  it('scores a completed race 1 / 0', () => {
    const s: State = { ...game.init(cfg, makeCtx({ seed: 1 })), status: 'won', winner: 'bob' }
    expect(game.terminal!(s)).toEqual({ done: true, winner: 'bob' })
    expect(game.score(s)).toEqual({ bob: 1, alice: 0 })
  })

  it('returns finite scores even mid-race', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    const sc = game.score(s)
    expect(Number.isFinite(sc['alice']!)).toBe(true)
    expect(Number.isFinite(sc['bob']!)).toBe(true)
  })
})
