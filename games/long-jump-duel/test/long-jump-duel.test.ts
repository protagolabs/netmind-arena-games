import { describe, it, expect } from 'vitest'
import { makeCtx } from '@arena/game-sdk'
import game from '../src/long-jump-duel.game'

const cfg = { players: ['alice', 'bob'] }
const ATTEMPTS = 3
// Mirrors the module's internal SAFE_SPEED_THRESHOLD = MAX_SPEED(12) * SAFE_SPEED_RATIO(0.7).
const SAFE_THRESHOLD = 8.4
const MAX_SPEED = 12

function submit(s: any, actor: string, speed: number, angle: number, seed = 1) {
  return game.reduce!(s, { speed, angle }, makeCtx({ seed, actor }))
}

describe('long-jump-duel · init', () => {
  it('starts playing, round 0, nothing pending, best distances at 0', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 })) as any
    expect(s.phase).toBe('playing')
    expect(s.round).toBe(0)
    expect(s.pending).toEqual([null, null])
    expect(s.bestDistance).toEqual([0, 0])
    expect(s.history).toEqual([])
  })
})

describe('long-jump-duel · input validation', () => {
  it('rejects speed outside [0, 12]', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    expect(() => submit(s, 'alice', -1, 30)).toThrow(/invalid-parameters/)
    expect(() => submit(s, 'alice', 12.1, 30)).toThrow(/invalid-parameters/)
  })

  it('rejects angle outside [10, 60]', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    expect(() => submit(s, 'alice', 8, 9.9)).toThrow(/invalid-parameters/)
    expect(() => submit(s, 'alice', 8, 60.1)).toThrow(/invalid-parameters/)
  })

  it('rejects non-numeric speed/angle', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 })) as any
    expect(() => game.reduce!(s, { speed: 'fast', angle: 30 }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/invalid-parameters/)
    expect(() => game.reduce!(s, { speed: 8, angle: NaN }, makeCtx({ seed: 1, actor: 'alice' }))).toThrow(/invalid-parameters/)
  })

  it('accepts boundary values 0/12 speed and 10/60 angle', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    s = submit(s, 'alice', 0, 10)
    expect(s.pending[0]).toEqual({ speed: 0, angle: 10 })
    s = submit(s, 'bob', 12, 60)
    // both submitted -> round resolved
    expect(s.round).toBe(1)
  })

  it('rejects a non-seated actor', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    expect(() => submit(s, 'mallory', 8, 30)).toThrow(/not-your-turn/)
  })

  it('rejects submitting twice for the same round before it resolves', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    s = submit(s, 'alice', 8, 30)
    expect(() => submit(s, 'alice', 5, 20)).toThrow(/already-submitted/)
  })

  it('rejects any submission once the match is over', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    for (let r = 0; r < ATTEMPTS; r++) {
      s = submit(s, 'alice', 8, 30, r + 1)
      s = submit(s, 'bob', 8, 30, r + 1)
    }
    expect(s.phase).toBe('done')
    expect(() => submit(s, 'alice', 8, 30)).toThrow(/game-over/)
  })
})

describe('long-jump-duel · blind submission (either side first)', () => {
  it('either seat may submit first; the round only resolves once both are in', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    s = submit(s, 'bob', 8, 30) // bob first this time
    expect(s.phase).toBe('playing')
    expect(s.round).toBe(0)
    expect(s.pending[1]).toEqual({ speed: 8, angle: 30 })
    expect(s.pending[0]).toBeNull()
    s = submit(s, 'alice', 9, 40)
    expect(s.round).toBe(1)
    expect(s.pending).toEqual([null, null])
  })

  it('submission order does not affect the resolved outcome (fixed seat-0-then-1 resolution)', () => {
    const run = (firstActor: 'alice' | 'bob') => {
      let s = game.init(cfg, makeCtx({ seed: 42 })) as any
      if (firstActor === 'alice') {
        s = submit(s, 'alice', 9.5, 35, 42)
        s = submit(s, 'bob', 7, 50, 42)
      } else {
        s = submit(s, 'bob', 7, 50, 42)
        s = submit(s, 'alice', 9.5, 35, 42)
      }
      return s
    }
    const aFirst = run('alice')
    const bFirst = run('bob')
    expect(aFirst.history).toEqual(bFirst.history)
    expect(aFirst.bestDistance).toEqual(bFirst.bestDistance)
  })

  it("history entries for a resolved round are always ordered seat 0 then seat 1", () => {
    let s = game.init(cfg, makeCtx({ seed: 3 })) as any
    s = submit(s, 'bob', 8, 30, 3) // bob submits first
    s = submit(s, 'alice', 8, 30, 3)
    expect(s.history[0].seat).toBe(0)
    expect(s.history[1].seat).toBe(1)
  })
})

describe('long-jump-duel · foul mechanic', () => {
  it('speed at/below the safe threshold never fouls, across many seeds', () => {
    for (let seed = 1; seed <= 100; seed++) {
      let s = game.init(cfg, makeCtx({ seed })) as any
      s = submit(s, 'alice', SAFE_THRESHOLD, 45, seed)
      s = submit(s, 'bob', SAFE_THRESHOLD, 45, seed)
      expect(s.history[0].fouled).toBe(false)
      expect(s.history[1].fouled).toBe(false)
    }
  })

  it('speed at max produces both fouled and non-fouled outcomes across many seeds (~40% chance)', () => {
    const outcomes = new Set<boolean>()
    for (let seed = 1; seed <= 300; seed++) {
      let s = game.init(cfg, makeCtx({ seed })) as any
      s = submit(s, 'alice', MAX_SPEED, 45, seed)
      s = submit(s, 'bob', 0, 45, seed) // bob stays safe so we isolate alice's roll
      outcomes.add(s.history[0].fouled)
    }
    expect(outcomes.has(true)).toBe(true)
    expect(outcomes.has(false)).toBe(true)
  })

  it('a fouled attempt always scores distance 0 and never raises bestDistance', () => {
    // Search a seed that fouls alice's first (max-speed) attempt.
    for (let seed = 1; seed <= 500; seed++) {
      let s = game.init(cfg, makeCtx({ seed })) as any
      s = submit(s, 'alice', MAX_SPEED, 45, seed)
      s = submit(s, 'bob', 0, 45, seed)
      if (s.history[0].fouled) {
        expect(s.history[0].distance).toBe(0)
        expect(s.bestDistance[0]).toBe(0)
        return
      }
    }
    throw new Error('expected at least one foul within 500 seeds at max speed')
  })

  it('angle never affects foul chance -- only speed does', () => {
    // At max speed, sweep across the legal angle range; foul chance should
    // be driven purely by speed, so both foul and non-foul must still occur
    // for a fixed extreme angle just as they do at 45 degrees.
    const outcomes = new Set<boolean>()
    for (let seed = 1; seed <= 300; seed++) {
      let s = game.init(cfg, makeCtx({ seed })) as any
      s = submit(s, 'alice', MAX_SPEED, 10, seed) // extreme low angle
      s = submit(s, 'bob', 0, 10, seed)
      outcomes.add(s.history[0].fouled)
    }
    expect(outcomes.has(true)).toBe(true)
    expect(outcomes.has(false)).toBe(true)
  })
})

describe('long-jump-duel · wind perturbation', () => {
  it('non-fouled distance varies across seeds within +/-8% of the raw (no-wind) distance', () => {
    const speed = 8 // below safe threshold -> never fouls
    const angle = 45 // sin(90deg) = 1, simplest raw distance to check against
    const raw = (speed * speed * Math.sin((2 * angle * Math.PI) / 180)) / 9.8
    const seen = new Set<number>()
    for (let seed = 1; seed <= 50; seed++) {
      let s = game.init(cfg, makeCtx({ seed })) as any
      s = submit(s, 'alice', speed, angle, seed)
      s = submit(s, 'bob', speed, angle, seed)
      const rec = s.history[0]
      expect(rec.fouled).toBe(false)
      expect(rec.windPct).toBeGreaterThanOrEqual(-8.0001)
      expect(rec.windPct).toBeLessThan(8.0001)
      expect(rec.distance).toBeCloseTo(raw * (1 + rec.windPct / 100), 6)
      seen.add(Math.round(rec.distance * 1000))
    }
    expect(seen.size).toBeGreaterThan(1) // not the same number every time
  })
})

describe('long-jump-duel · best-distance and match outcome', () => {
  it('bestDistance keeps the max across attempts, never overwritten by a worse later attempt', () => {
    let s = game.init(cfg, makeCtx({ seed: 7 })) as any
    s = submit(s, 'alice', 8, 45, 7) // decent attempt
    s = submit(s, 'bob', 0, 45, 7)
    const firstBest = s.bestDistance[0]
    expect(firstBest).toBeGreaterThan(0)
    s = submit(s, 'alice', 8, 10, 7) // worse angle -> smaller raw distance
    s = submit(s, 'bob', 0, 10, 7)
    expect(s.bestDistance[0]).toBeGreaterThanOrEqual(firstBest)
  })

  it(`ends after ${ATTEMPTS} attempts with the higher bestDistance winning`, () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    for (let r = 0; r < ATTEMPTS; r++) {
      s = submit(s, 'alice', 8, 45, r + 1) // always a real jump
      s = submit(s, 'bob', 8, 10, r + 1) // always a much shorter jump
    }
    expect(s.phase).toBe('done')
    expect(s.winner).toBe('alice')
    expect(s.bestDistance[0]).toBeGreaterThan(s.bestDistance[1])
  })

  it('a tied bestDistance (both foul every attempt) is a draw: 0.5/0.5', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    for (let r = 0; r < ATTEMPTS; r++) {
      // Both submit identical inputs every round with the SAME seed -- fixed
      // seat-0-then-1 resolution order means both draw from the same
      // underlying stream shape, but to make this deterministic without
      // depending on luck, just assert the draw path structurally: equal
      // bestDistance at the end (0 speed -> 0 distance, never fouls, but
      // sin(2*10deg) is identical and small -> both exactly 0 raw is not
      // guaranteed at angle 10, so use speed 0 which is always distance 0
      // regardless of wind).
      s = submit(s, 'alice', 0, 30, r + 1)
      s = submit(s, 'bob', 0, 30, r + 1)
    }
    expect(s.phase).toBe('done')
    expect(s.bestDistance).toEqual([0, 0])
    expect(s.winner).toBeUndefined()
    expect(game.score(s)).toEqual({ alice: 0.5, bob: 0.5 })
  })

  it('score() gives 0/0 while ongoing, then winner=1/loser=0 once decided', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    expect(game.score(s)).toEqual({ alice: 0, bob: 0 })
    for (let r = 0; r < ATTEMPTS; r++) {
      s = submit(s, 'alice', 8, 45, r + 1)
      s = submit(s, 'bob', 8, 10, r + 1)
    }
    expect(game.score(s)).toEqual({ alice: 1, bob: 0 })
  })

  it('terminal() reflects done + winner (null for a draw)', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    expect(game.terminal!(s)).toEqual({ done: false })
    for (let r = 0; r < ATTEMPTS; r++) {
      s = submit(s, 'alice', 0, 30, r + 1)
      s = submit(s, 'bob', 0, 30, r + 1)
    }
    expect(game.terminal!(s)).toEqual({ done: true, winner: null })
  })
})

describe('long-jump-duel · hidden information', () => {
  it("the submitter's own frame shows their pending jump while awaiting the other side", () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    s = submit(s, 'alice', 8, 30)
    const frame = game.render!(s, { viewer: 'alice' }) as any
    expect(frame.myPending).toEqual({ speed: 8, angle: 30 })
  })

  it('the OTHER seat never sees the pending jump, nor even that a submission happened', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    s = submit(s, 'alice', 8, 30)
    const frame = game.render!(s, { viewer: 'bob' }) as any
    expect(frame.myPending).toBeNull()
    expect(frame.submittedThisRound).toBeNull() // participants get no cross-seat status either
  })

  it('a spectator sees aggregate submitted-status booleans but never the values', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    s = submit(s, 'alice', 8, 30)
    const spectatorFrame = game.render!(s) as any
    expect(spectatorFrame.submittedThisRound).toEqual([true, false])
    expect(spectatorFrame.myPending).toBeNull()
    expect(JSON.stringify(spectatorFrame)).not.toContain('"speed":8')
  })

  it('once a round resolves, both attempts become fully public in history for everyone', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    s = submit(s, 'alice', 8, 30)
    s = submit(s, 'bob', 5, 20)
    const spectatorFrame = game.render!(s) as any
    expect(spectatorFrame.history[0]).toMatchObject({ seat: 0, speed: 8, angle: 30 })
    expect(spectatorFrame.history[1]).toMatchObject({ seat: 1, speed: 5, angle: 20 })
  })
})

describe('long-jump-duel · determinism', () => {
  it('the same seed and action sequence always produces the same result', () => {
    const seeds = [1, 2, 3, 4, 5]
    for (const seed of seeds) {
      const run = () => {
        let s = game.init(cfg, makeCtx({ seed })) as any
        for (let r = 0; r < ATTEMPTS; r++) {
          s = submit(s, 'alice', 8 + r, 30 + r * 5, seed)
          s = submit(s, 'bob', 6 + r, 20 + r * 3, seed)
        }
        return s
      }
      const a = run()
      const b = run()
      expect(a).toEqual(b)
    }
  })
})
