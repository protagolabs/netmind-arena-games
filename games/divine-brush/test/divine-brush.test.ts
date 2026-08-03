import { describe, it, expect } from 'vitest'
import { assertMatchSane, makeCtx, runStrategyMatch } from '@arena/game-sdk'
import game from '../src/divine-brush.game'
import type { Params } from '../src/divine-brush.game'

const duo = { players: ['alice', 'bob'] }
const quartet = { players: ['a', 'b', 'c', 'd'] }
/** Board shape and match length, asserted here so a retune has to update the tests. */
const GRID = 5
const TURNS = 14

const knobs = (over: Partial<Params> = {}): Params => ({
  generosity: 0.4,
  contrast: 0.5,
  restraint: 0.5,
  release: 0.5,
  ...over,
})

/**
 * Drive a turn-based match by hand with the built-in mover. One ctx is created for
 * the whole match and re-tagged per seat — the same RNG regime the engine's settle
 * loop uses, so this path is directly comparable to `runStrategyMatch`.
 */
function selfPlay(cfg: { players: string[] }, params: Params, seed: number) {
  const base = makeCtx({ seed })
  let s = game.init(cfg, base)
  let steps = 0
  while (!game.terminal!(s).done && steps < game.meta.maxSteps!) {
    const turn = { ...base, side: s.side, actor: s.players[s.side]! }
    s = game.reduce!(s, game.play!(s, params, turn), turn)
    steps++
  }
  return { state: s, steps }
}

describe('divine-brush', () => {
  it('rejects out-of-turn, malformed, and illegal actions', () => {
    const s = game.init(duo, makeCtx({ seed: 1 }))
    const asAlice = () => makeCtx({ seed: 1, actor: 'alice' })

    // alice holds seat 0 and the brush; bob painting now is not his turn.
    expect(() => game.reduce!(s, { act: 'paint', x: 0, y: 0, element: 1 }, makeCtx({ seed: 1, actor: 'bob' }))).toThrow(
      /not-your-turn/,
    )
    // malformed submissions reject cleanly instead of throwing a raw TypeError.
    expect(() => game.reduce!(s, null as never, asAlice())).toThrow(/bad-action/)
    expect(() => game.reduce!(s, {} as never, asAlice())).toThrow(/unknown-act/)
    // out of bounds / bad element.
    expect(() => game.reduce!(s, { act: 'paint', x: 7, y: 0, element: 1 }, asAlice())).toThrow(/out-of-bounds/)
    expect(() => game.reduce!(s, { act: 'paint', x: 0, y: -1, element: 1 }, asAlice())).toThrow(/out-of-bounds/)
    expect(() => game.reduce!(s, { act: 'paint', x: 0, y: 0, element: 9 }, asAlice())).toThrow(/bad-element/)
    // you cannot light your own planet, and there is no seat 4 at a duo table.
    expect(() => game.reduce!(s, { act: 'light', target: 0 }, asAlice())).toThrow(/cannot-light-own/)
    expect(() => game.reduce!(s, { act: 'light', target: 4 }, asAlice())).toThrow(/bad-target/)
    // nothing to let go of yet.
    expect(() => game.reduce!(s, { act: 'wish' }, asAlice())).toThrow(/nothing-to-release/)
  })

  it('charges burden for painting over yourself, and wish releases it into the sky', () => {
    let s = game.init(duo, makeCtx({ seed: 3 }))
    // find a cell alice has not touched, so the first stroke is free.
    const blank = { x: 0, y: 0 }
    outer: for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if (s.planets[0]!.cells[y]![x] === 0) {
          blank.x = x
          blank.y = y
          break outer
        }
      }
    }

    s = game.reduce!(s, { act: 'paint', ...blank, element: 1 }, makeCtx({ seed: 3, actor: 'alice' }))
    expect(s.planets[0]!.burden).toBe(0)
    expect(s.side).toBe(1) // brush passes on

    s = game.reduce!(s, { act: 'light', target: 0 }, makeCtx({ seed: 3, actor: 'bob' }))
    // repainting the same cell a different colour is the compromise that costs.
    s = game.reduce!(s, { act: 'paint', ...blank, element: 3 }, makeCtx({ seed: 3, actor: 'alice' }))
    expect(s.planets[0]!.burden).toBe(1)
    // repainting it the SAME colour is a no-op, not a free turn.
    s = game.reduce!(s, { act: 'light', target: 0 }, makeCtx({ seed: 3, actor: 'bob' }))
    expect(() => game.reduce!(s, { act: 'paint', ...blank, element: 3 }, makeCtx({ seed: 3, actor: 'alice' }))).toThrow(
      /no-change/,
    )

    const before = s.sky
    s = game.reduce!(s, { act: 'wish' }, makeCtx({ seed: 3, actor: 'alice' }))
    expect(s.planets[0]!.burden).toBe(0)
    expect(s.sky).toBeGreaterThan(before)
    expect(s.wishes[0]).toBe(1)
  })

  it('decays repeat lamps to the same planet', () => {
    let s = game.init(duo, makeCtx({ seed: 5 }))
    const pass = (actor: string) => makeCtx({ seed: 5, actor })
    // alice lights bob, bob lights alice, alice lights bob again.
    s = game.reduce!(s, { act: 'light', target: 1 }, pass('alice'))
    expect(s.planets[1]!.lamps).toBe(1)
    s = game.reduce!(s, { act: 'light', target: 0 }, pass('bob'))
    s = game.reduce!(s, { act: 'light', target: 1 }, pass('alice'))
    expect(s.planets[1]!.lamps).toBe(1.5) // second lamp from the same seat is worth 1/2
    expect(s.lit[0]![1]).toBe(2)
  })

  it('awards the guardian bonus only to a seat that lit every other planet', () => {
    const { state } = selfPlay(quartet, knobs({ generosity: 1 }), 9)
    const scores = game.score(state)
    // a generous table should produce at least one seat that reached everyone.
    const covered = state.players.filter((_, seat) =>
      state.players.every((__, j) => j === seat || state.lit[seat]![j]! > 0),
    )
    expect(covered.length).toBeGreaterThan(0)
    expect(Object.keys(scores).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('terminates and settles deterministically across seeds and table sizes', () => {
    const defaults = knobs()
    for (let seed = 0; seed < 12; seed++) {
      for (const cfg of [duo, quartet]) {
        const seats = cfg.players.map(() => defaults)
        const r = assertMatchSane(game, cfg, seats, seed)
        expect(r.steps).toBe(cfg.players.length * TURNS)
        expect(game.terminal!(r.finalState).done).toBe(true)
      }
    }
  })

  it('runs the same through reduce as through apply', () => {
    // The turn-based path and the strategy path must agree — same mover, same match.
    const params = knobs()
    const viaReduce = selfPlay(duo, params, 21)
    const viaApply = runStrategyMatch(game, duo, [params, params], 21)
    expect(game.score(viaReduce.state)).toEqual(viaApply.scores)
  })

  it('makes generosity the dial that feeds the shared sky', () => {
    const table = (generosity: number, seed: number) =>
      runStrategyMatch(game, quartet, quartet.players.map(() => knobs({ generosity })), seed)

    // The sky is fed by connection and nothing else, so it must rise monotonically
    // with how much of the table's time goes to each other.
    for (const seed of [4, 17, 33]) {
      const dark = table(0, seed)
      const some = table(0.35, seed)
      const bright = table(1, seed)
      expect(some.finalState.sky).toBeGreaterThan(dark.finalState.sky)
      expect(bright.finalState.sky).toBeGreaterThan(some.finalState.sky)
    }
  })

  it('pays a table that connects more than a table that only paints', () => {
    const total = (scores: Record<string, number>) => Object.values(scores).reduce((a, b) => a + b, 0)
    const table = (generosity: number, seed: number) =>
      total(runStrategyMatch(game, quartet, quartet.players.map(() => knobs({ generosity })), seed).scores)

    // Some connection beats none. (Total generosity is NOT the optimum — every lamp
    // costs a stroke — so this deliberately compares balanced against selfish.)
    for (const seed of [4, 17, 33]) {
      expect(table(0.35, seed)).toBeGreaterThan(table(0, seed))
    }
  })

  it('renders every planet under one sky', () => {
    const { state } = selfPlay(quartet, knobs(), 6)
    const frame = game.render!(state)
    expect(frame.layout).toBe('board')
    // 4 planets of GRID columns plus 3 dark gutters between them.
    expect(frame.board!.cols).toBe(4 * GRID + 3)
    expect(frame.board!.rows).toBe(GRID)
    expect(frame.board!.cells.every((row) => row.length === frame.board!.cols)).toBe(true)
    const scoreboard = frame.panels!.find((p) => p.type === 'scoreboard')
    expect(scoreboard && 'rows' in scoreboard ? scoreboard.rows.length : 0).toBe(4)
  })
})
