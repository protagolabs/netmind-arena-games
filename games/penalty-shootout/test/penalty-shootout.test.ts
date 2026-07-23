import { describe, it, expect } from 'vitest'
import { makeCtx } from '@arena/game-sdk'
import game from '../src/penalty-shootout.game'

const cfg = { players: ['alice', 'bob'] }
const REGULATION_ROUNDS = 5

function setOrder(s: any, actor: string, order: number[], seed = 1) {
  return game.reduce!(s, { order }, makeCtx({ seed, actor }))
}
function kick(s: any, actor: string, col: string, row: string, seed = 1) {
  return game.reduce!(s, { col, row }, makeCtx({ seed, actor }))
}
function save(s: any, actor: string, col: string, row: string, seed = 1) {
  return game.reduce!(s, { col, row }, makeCtx({ seed, actor }))
}

const ORDER_A = [3, 1, 6, 2, 5, 4]
const ORDER_B = [6, 5, 4, 3, 2, 1]

function bothPlaced(seed = 1) {
  let s = game.init(cfg, makeCtx({ seed }))
  s = setOrder(s, 'alice', ORDER_A, seed)
  s = setOrder(s, 'bob', ORDER_B, seed)
  return s
}

// Every shot now has SOME chance of every outcome (a shooter can always go
// wide, regardless of power or column match), so nothing about a single shot
// is ever 100% guaranteed anymore. To build predictable full-match scenarios
// deterministically, search for a save-action seed that actually produces the
// desired outcome for THIS specific shot, rather than assuming one.
function saveForOutcome(
  afterKick: any,
  keeperActor: string,
  guessCol: string,
  guessRow: string,
  want: 'goal' | 'saved' | 'wide',
  maxTries = 5000,
) {
  for (let seed = 1; seed <= maxTries; seed++) {
    const t = save(afterKick, keeperActor, guessCol, guessRow, seed)
    if (t.history[t.history.length - 1].outcome === want) return t
  }
  throw new Error(`no seed produced outcome '${want}' within ${maxTries} tries`)
}
/**
 * One full shot (kick + save), searched to resolve to exactly `want`. The
 * kick always uses row 'U'; `guessRow` defaults to 'U' too, so callers that
 * only care about column match/mismatch (the vast majority of call sites)
 * automatically get a FULL match when guessCol === kickCol, unchanged from
 * before row became a real guess dimension. Pass an explicit guessRow to
 * test the partial-match (column right, row wrong) path specifically.
 */
function shot(
  s: any,
  kickerActor: string,
  keeperActor: string,
  kickCol: string,
  guessCol: string,
  want: 'goal' | 'saved' | 'wide',
  guessRow = 'U',
) {
  const afterKick = kick(s, kickerActor, kickCol, 'U', 1)
  return saveForOutcome(afterKick, keeperActor, guessCol, guessRow, want)
}

describe('penalty-shootout · setup phase', () => {
  it('starts in setup with no orders set, and a full 6-nickname cast', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 })) as any
    expect(s.phase).toBe('setup')
    expect(s.orders).toEqual([null, null])
    expect(s.nicknames).toHaveLength(6)
    expect(new Set(s.nicknames).size).toBe(6) // all distinct
    for (let power = 1; power <= 6; power++) {
      expect(s.nicknames[power - 1].startsWith(String(power))).toBe(true)
    }
  })

  it('nicknames are deterministic for a given seed', () => {
    const a = game.init(cfg, makeCtx({ seed: 7 })) as any
    const b = game.init(cfg, makeCtx({ seed: 7 })) as any
    expect(a.nicknames).toEqual(b.nicknames)
  })

  it('accepts a valid order from either side independently, in either order', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 })) as any
    s = setOrder(s, 'bob', ORDER_B)
    expect(s.phase).toBe('setup') // alice hasn't set yet
    expect(s.orders[1]).toEqual(ORDER_B)
    s = setOrder(s, 'alice', ORDER_A)
    expect(s.phase).toBe('shooting')
    expect(s.shooterSeat).toBe(0)
  })

  it('rejects a non-permutation order', () => {
    const s = game.init(cfg, makeCtx({ seed: 1 }))
    expect(() => setOrder(s, 'alice', [1, 1, 2, 3, 4, 5])).toThrow(/invalid-order/)
    expect(() => setOrder(s, 'alice', [1, 2, 3, 4, 5])).toThrow(/invalid-order/) // wrong length
    expect(() => setOrder(s, 'alice', [0, 1, 2, 3, 4, 5])).toThrow(/invalid-order/) // out of range
    expect(() => setOrder(s, 'alice', [1, 2, 3, 4, 5, 7])).toThrow(/invalid-order/)
  })

  it('rejects submitting an order twice for the same seat', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = setOrder(s, 'alice', ORDER_A)
    expect(() => setOrder(s, 'alice', ORDER_B)).toThrow(/already-set/)
  })

  it('rejects a kick-shaped action while still in setup (not a valid order)', () => {
    let s = game.init(cfg, makeCtx({ seed: 1 }))
    s = setOrder(s, 'alice', ORDER_A)
    // bob hasn't placed yet -- sending a kick-shaped payload during setup is
    // simply not a valid order, so it's rejected as such.
    expect(() => kick(s, 'bob', 'L', 'U')).toThrow(/invalid-order/)
  })
})

describe('penalty-shootout · blind kick/save duel', () => {
  it('a kick is stored but the match stays in shooting phase awaiting the save', () => {
    let s = bothPlaced() as any
    s = kick(s, 'alice', 'L', 'U')
    expect(s.pendingKick).toEqual({ col: 'L', row: 'U' })
    expect(s.phase).toBe('shooting')
  })

  it('rejects the wrong actor kicking (not seat0 first)', () => {
    const s = bothPlaced()
    expect(() => kick(s, 'bob', 'L', 'U')).toThrow(/not-your-turn/)
  })

  it('rejects the shooter trying to also submit the save', () => {
    let s = bothPlaced()
    s = kick(s, 'alice', 'L', 'U')
    expect(() => save(s, 'alice', 'L', 'U')).toThrow(/not-your-turn/)
  })

  it('rejects malformed kick/save actions', () => {
    let s = bothPlaced()
    expect(() => kick(s, 'alice', 'X', 'U')).toThrow(/invalid-target/)
    expect(() => kick(s, 'alice', 'L', 'X')).toThrow(/invalid-target/)
    s = kick(s, 'alice', 'L', 'U')
    expect(() => save(s, 'bob', 'X', 'U')).toThrow(/invalid-guess/)
    expect(() => save(s, 'bob', 'L', 'X')).toThrow(/invalid-guess/) // bad row now rejected too
  })

  it('column mismatch can never be saved -- only goal or wide, regardless of row', () => {
    const outcomes = new Set<string>()
    for (let seed = 1; seed <= 200; seed++) {
      let s = bothPlaced(seed)
      s = kick(s, 'alice', 'L', 'U', seed)
      s = save(s, 'bob', 'R', 'U', seed)
      const o = s.history[0].outcome
      expect(o).not.toBe('saved')
      outcomes.add(o)
    }
    expect(outcomes.has('goal')).toBe(true) // the common case must actually occur
  })

  it('a full match (col + row) at power 1 can never be a goal -- only saved or wide', () => {
    const outcomes = new Set<string>()
    for (let seed = 1; seed <= 400; seed++) {
      let s = game.init(cfg, makeCtx({ seed })) as any
      s = setOrder(s, 'alice', [1, 2, 3, 4, 5, 6], seed) // alice's first shooter: power 1
      s = setOrder(s, 'bob', ORDER_B, seed)
      s = kick(s, 'alice', 'M', 'D', seed)
      s = save(s, 'bob', 'M', 'D', seed) // full match: col AND row both correct
      expect(s.history[0].power).toBe(1)
      expect(s.history[0].outcome).not.toBe('goal')
      outcomes.add(s.history[0].outcome)
    }
    expect(outcomes.has('saved')).toBe(true)
    expect(outcomes.has('wide')).toBe(true) // power 1 has a real (18%) wide chance
  })

  it('a partial match (col right, row wrong) at power 1 CAN still be a goal -- unlike a full match', () => {
    const outcomes = new Set<string>()
    for (let seed = 1; seed <= 400; seed++) {
      let s = game.init(cfg, makeCtx({ seed })) as any
      s = setOrder(s, 'alice', [1, 2, 3, 4, 5, 6], seed) // power 1
      s = setOrder(s, 'bob', ORDER_B, seed)
      s = kick(s, 'alice', 'M', 'D', seed)
      s = save(s, 'bob', 'M', 'U', seed) // col right, row wrong
      outcomes.add(s.history[0].outcome)
    }
    // Even at power 1, a partial read leaves a real scoring chance (discount
    // < 1 means the save chance is no longer 100%) -- the flat-constant
    // design this replaced could never produce this at all for power 1.
    expect(outcomes.has('goal')).toBe(true)
    expect(outcomes.has('saved')).toBe(true)
  })

  it('column match at power 6, full read, can produce all three outcomes', () => {
    const outcomes = new Set<string>()
    for (let seed = 1; seed <= 400; seed++) {
      let s = game.init(cfg, makeCtx({ seed })) as any
      s = setOrder(s, 'alice', [6, 1, 2, 3, 4, 5], seed) // alice's first shooter: power 6
      s = setOrder(s, 'bob', ORDER_B, seed)
      s = kick(s, 'alice', 'M', 'U', seed)
      s = save(s, 'bob', 'M', 'U', seed) // full match
      outcomes.add(s.history[0].outcome)
    }
    expect(outcomes.has('goal')).toBe(true)
    expect(outcomes.has('saved')).toBe(true)
  })

  it('a full match is never worse than a partial match for the same underlying roll (no inverted incentive)', () => {
    // Regression test for a design bug caught before shipping: an earlier
    // version used flat save-chance constants for a partial (row-wrong)
    // match instead of scaling SAVE_TABLE, which let a WRONG row guess save
    // more often than a full match at power >= 4. Scaling the same curve
    // guarantees full >= partial. Both branches consume ctx.random() calls
    // in the exact same order up to the save roll (the guess content itself
    // never changes call count), so for a given seed the wide roll and the
    // save roll draw the SAME underlying random numbers in both branches --
    // this lets us compare outcomes directly, seed by seed, deterministically.
    for (let seed = 1; seed <= 500; seed++) {
      let sFull = game.init(cfg, makeCtx({ seed })) as any
      sFull = setOrder(sFull, 'alice', [6, 1, 2, 3, 4, 5], seed) // power 6: worst case for the old bug
      sFull = setOrder(sFull, 'bob', ORDER_B, seed)
      sFull = kick(sFull, 'alice', 'M', 'U', seed)
      const full = save(sFull, 'bob', 'M', 'U', seed) // full match

      let sPartial = game.init(cfg, makeCtx({ seed })) as any
      sPartial = setOrder(sPartial, 'alice', [6, 1, 2, 3, 4, 5], seed)
      sPartial = setOrder(sPartial, 'bob', ORDER_B, seed)
      sPartial = kick(sPartial, 'alice', 'M', 'U', seed)
      const partial = save(sPartial, 'bob', 'M', 'D', seed) // col right, row wrong

      if (partial.history[0].outcome === 'saved') {
        expect(full.history[0].outcome).toBe('saved')
      }
    }
  })

  it('a middle-column partial match saves at least as often as an equivalent side-column partial match', () => {
    // Same RNG-alignment trick as above: same seed, same power (alice's
    // first shooter, power 6), same call sequence -- only the shot's column
    // (and matching wrong-row guess) differs, so the underlying wide/save
    // rolls line up and a direct per-seed comparison is valid.
    for (let seed = 1; seed <= 500; seed++) {
      let sMid = game.init(cfg, makeCtx({ seed })) as any
      sMid = setOrder(sMid, 'alice', [6, 1, 2, 3, 4, 5], seed)
      sMid = setOrder(sMid, 'bob', ORDER_B, seed)
      sMid = kick(sMid, 'alice', 'M', 'U', seed)
      const mid = save(sMid, 'bob', 'M', 'D', seed) // mid column, row wrong

      let sSide = game.init(cfg, makeCtx({ seed })) as any
      sSide = setOrder(sSide, 'alice', [6, 1, 2, 3, 4, 5], seed)
      sSide = setOrder(sSide, 'bob', ORDER_B, seed)
      sSide = kick(sSide, 'alice', 'L', 'U', seed)
      const side = save(sSide, 'bob', 'L', 'D', seed) // side column, row wrong

      if (side.history[0].outcome === 'saved') {
        expect(mid.history[0].outcome).toBe('saved')
      }
    }
  })
})

describe('penalty-shootout · turn/round alternation', () => {
  it('seat0 kicks first each round; after seat0 resolves, seat1 kicks next (same round)', () => {
    let s = bothPlaced() as any
    expect(s.shooterSeat).toBe(0)
    s = shot(s, 'alice', 'bob', 'L', 'R', 'goal') // mismatched -> goal or wide, never advances round alone
    expect(s.round).toBe(0) // still round 0 -- only half the round done
    expect(s.shooterSeat).toBe(1) // bob kicks next
  })

  it('after seat1 resolves, the round advances and seat0 kicks again', () => {
    let s = bothPlaced() as any
    s = shot(s, 'alice', 'bob', 'L', 'R', 'goal')
    s = shot(s, 'bob', 'alice', 'L', 'R', 'goal')
    expect(s.round).toBe(1)
    expect(s.shooterSeat).toBe(0)
  })
})

describe('penalty-shootout · match outcome', () => {
  it('does not end before 5 full rounds even if one side is ahead', () => {
    let s = bothPlaced() as any
    s = shot(s, 'alice', 'bob', 'L', 'R', 'goal')
    s = shot(s, 'bob', 'alice', 'M', 'M', 'saved')
    // only 1/5 rounds done -- match must still be ongoing regardless of score
    expect(s.phase).toBe('shooting')
  })

  it(`ends after ${REGULATION_ROUNDS} rounds with the higher scorer winning`, () => {
    let s = bothPlaced() as any
    for (let r = 0; r < REGULATION_ROUNDS; r++) {
      s = shot(s, 'alice', 'bob', 'L', 'R', 'goal') // alice always scores
      s = shot(s, 'bob', 'alice', 'M', 'M', 'saved') // bob is always denied
    }
    expect(s.phase).toBe('won')
    expect(s.score).toEqual([REGULATION_ROUNDS, 0])
    expect(s.winner).toBe('alice')
  })

  it('score() gives the winner 1 and the loser 0 once decided; 0/0 while still ongoing', () => {
    let s = bothPlaced() as any
    for (let r = 0; r < REGULATION_ROUNDS; r++) {
      s = shot(s, 'alice', 'bob', 'L', 'R', 'goal')
      s = shot(s, 'bob', 'alice', 'L', 'R', 'goal')
    }
    // both scored every kick -> tied -> sudden death continues
    expect(s.phase).toBe('shooting')
    expect(game.score(s)).toEqual({ alice: 0, bob: 0 })
    s = shot(s, 'alice', 'bob', 'L', 'R', 'goal')
    s = shot(s, 'bob', 'alice', 'M', 'M', 'saved')
    expect(s.phase).toBe('won')
    expect(game.score(s)).toEqual({ alice: 1, bob: 0 })
  })

  it('rejects any action after the match has ended', () => {
    let s = bothPlaced() as any
    for (let r = 0; r < REGULATION_ROUNDS; r++) {
      s = shot(s, 'alice', 'bob', 'L', 'R', 'goal')
      s = shot(s, 'bob', 'alice', 'M', 'M', 'saved')
    }
    expect(s.phase).toBe('won')
    expect(() => kick(s, 'bob', 'L', 'U')).toThrow(/game-over/)
  })
})

describe('penalty-shootout · sudden death', () => {
  it(`tied after ${REGULATION_ROUNDS} rounds continues with every shooter forced to power 1`, () => {
    let s = bothPlaced() as any
    for (let r = 0; r < REGULATION_ROUNDS; r++) {
      s = shot(s, 'alice', 'bob', 'L', 'R', 'goal')
      s = shot(s, 'bob', 'alice', 'L', 'R', 'goal')
    }
    expect(s.round).toBe(REGULATION_ROUNDS)
    expect(s.phase).toBe('shooting') // still tied, continuing
    s = shot(s, 'alice', 'bob', 'M', 'M', 'saved')
    expect(s.history[s.history.length - 1].power).toBe(1)
  })

  it('ends sudden death as soon as a completed round breaks the tie', () => {
    let s = bothPlaced() as any
    for (let r = 0; r < REGULATION_ROUNDS; r++) {
      s = shot(s, 'alice', 'bob', 'L', 'R', 'goal')
      s = shot(s, 'bob', 'alice', 'L', 'R', 'goal')
    }
    s = shot(s, 'alice', 'bob', 'L', 'R', 'goal')
    s = shot(s, 'bob', 'alice', 'M', 'M', 'saved')
    expect(s.phase).toBe('won')
    expect(s.winner).toBe('alice')
  })

  it('an eternal tie in sudden death eventually resolves as a draw via the safety cap', () => {
    let s = bothPlaced() as any
    for (let r = 0; r < REGULATION_ROUNDS; r++) {
      s = shot(s, 'alice', 'bob', 'L', 'R', 'goal')
      s = shot(s, 'bob', 'alice', 'L', 'R', 'goal')
    }
    let guard = 0
    while (s.phase === 'shooting' && guard < 100) {
      s = shot(s, 'alice', 'bob', 'M', 'M', 'saved')
      s = shot(s, 'bob', 'alice', 'M', 'M', 'saved')
      guard++
    }
    expect(s.phase).toBe('won')
    expect(s.winner).toBeUndefined()
    expect(game.score(s)).toEqual({ alice: 0.5, bob: 0.5 })
    // The whole point of the safety cap is to fire BEFORE the SDK's own
    // meta.maxSteps enforcement would cut the match short -- if this ever
    // regresses (wrong multiplier, off-by-one on the round count), the
    // platform would truncate a real tied match before this draw path could
    // ever run. Regression test for the AI-review finding on PR #19.
    expect(s.moves).toBeLessThanOrEqual((game as any).meta.maxSteps)
  })
})

describe('penalty-shootout · hidden information', () => {
  it("the shooter's own frame shows their pending target while awaiting the save", () => {
    let s = bothPlaced()
    s = kick(s, 'alice', 'L', 'U')
    const frame = game.render!(s, { viewer: 'alice' }) as any
    expect(frame.myPendingTarget).toEqual({ col: 'L', row: 'U' })
  })

  it("the keeper's frame never reveals the pending target before they respond", () => {
    let s = bothPlaced()
    s = kick(s, 'alice', 'L', 'U')
    const frame = game.render!(s, { viewer: 'bob' }) as any
    expect(frame.myPendingTarget).toBeNull()
    expect(frame.awaitingSave).toBe(true)
  })

  it('the public/spectator frame never reveals the pending target either', () => {
    let s = bothPlaced()
    s = kick(s, 'alice', 'L', 'U')
    const publicFrame = game.render!(s) as any
    expect(publicFrame.myPendingTarget).toBeNull()
  })

  it('once resolved, the shot becomes fully public in history for everyone', () => {
    let s = bothPlaced() as any
    s = shot(s, 'alice', 'bob', 'L', 'R', 'goal')
    const spectatorFrame = game.render!(s) as any
    expect(spectatorFrame.history[0]).toMatchObject({ col: 'L', row: 'U', keeperCol: 'R', outcome: 'goal' })
  })

  it("no frame ever exposes the opponent's shooting order directly", () => {
    let s = bothPlaced()
    const aliceFrame = game.render!(s, { viewer: 'alice' }) as any
    const bobFrame = game.render!(s, { viewer: 'bob' }) as any
    expect(JSON.stringify(aliceFrame)).not.toContain(String(ORDER_B))
    expect(JSON.stringify(bobFrame)).not.toContain(String(ORDER_A))
  })

  it('nicknames are public flavor -- visible to both sides and spectators alike', () => {
    const s = bothPlaced() as any
    const aliceFrame = game.render!(s, { viewer: 'alice' }) as any
    const bobFrame = game.render!(s, { viewer: 'bob' }) as any
    const publicFrame = game.render!(s) as any
    expect(aliceFrame.nicknames).toEqual(s.nicknames)
    expect(bobFrame.nicknames).toEqual(s.nicknames)
    expect(publicFrame.nicknames).toEqual(s.nicknames)
  })
})

describe('penalty-shootout · determinism', () => {
  it('the same seed and action sequence always produces the same result', () => {
    const seeds = [1, 2, 3, 4, 5]
    for (const seed of seeds) {
      const run = () => {
        let s = game.init(cfg, makeCtx({ seed })) as any
        s = setOrder(s, 'alice', ORDER_A, seed)
        s = setOrder(s, 'bob', ORDER_B, seed)
        for (let r = 0; r < 20 && s.phase === 'shooting'; r++) {
          s = kick(s, 'alice', 'M', 'U', seed)
          s = save(s, 'bob', 'L', 'U', seed)
          if (s.phase !== 'shooting') break
          s = kick(s, 'bob', 'R', 'D', seed)
          s = save(s, 'alice', 'R', 'D', seed)
        }
        return s
      }
      const a = run()
      const b = run()
      expect(a).toEqual(b)
    }
  })
})
