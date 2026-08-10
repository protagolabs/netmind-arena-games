/**
 * Tests for the arithmetic online versus rests on.
 *
 * None of this can be checked in a browser without two of them and a backend, so
 * everything that CAN be decided by pure reasoning is decided here — the tick a
 * wall clock implies, the order two coaches' instructions are applied in, and
 * whether a hash notices a divergence. What remains for a real end-to-end run is
 * the part that genuinely needs one: that the engine handles are still where the
 * extractor put them.
 */
import { describe, it, expect } from 'vitest'
import {
  DT,
  INPUT_DELAY_TICKS,
  OrderLog,
  checksumOf,
  makeRoomCode,
  mergeLogs,
  normaliseCode,
  scheduleAt,
  tickAt,
  type Order,
} from '../src/lockstep'

function order(over: Partial<Order> = {}): Order {
  return { tick: 100, side: 0, delta: { press: 0.2 }, text: 'press high', ...over }
}

describe('tickAt', () => {
  it('derives the tick from the shared origin, not from local frames', () => {
    // One second of wall clock is exactly 1/DT ticks, whatever the frame rate.
    expect(tickAt(1_000_000 + 1000, 1_000_000)).toBe(60)
    expect(tickAt(1_000_000 + 5000, 1_000_000)).toBe(300)
  })

  /**
   * The property that makes catching up a non-event: a client that missed ten
   * seconds computes the tick it SHOULD be on, not the tick it would have
   * reached by counting its own frames. Both are then playing one match.
   */
  it('gives a throttled client the same tick as a smooth one', () => {
    const started = 1_000_000
    const now = started + 90_000
    expect(tickAt(now, started)).toBe(tickAt(now, started))
    expect(tickAt(now, started)).toBe(Math.floor(90 / DT))
  })

  it('is zero before kickoff rather than negative', () => {
    expect(tickAt(999_000, 1_000_000)).toBe(0)
  })

  it('is zero when the room has no start instant yet', () => {
    expect(tickAt(1_000_000, Number.NaN)).toBe(0)
  })
})

describe('scheduleAt', () => {
  it('puts an order far enough ahead for the relay to beat it there', () => {
    expect(scheduleAt(1000)).toBe(1000 + INPUT_DELAY_TICKS)
    // Half a second at 60Hz. Stated as a number so a change to DT that silently
    // shrank the latency budget fails here rather than in a desync report.
    expect(INPUT_DELAY_TICKS).toBe(30)
  })
})

describe('room codes', () => {
  it('avoids the characters that get misread aloud', () => {
    // Every index of a deterministic "random" sequence, so the whole alphabet
    // is exercised rather than four arbitrary letters of it.
    const letters = new Set<string>()
    for (let i = 0; i < 32; i++) {
      letters.add(makeRoomCode(() => i / 32)[0]!)
    }
    for (const bad of ['O', '0', 'I', '1']) {
      expect(letters.has(bad), `'${bad}' is ambiguous when read out or typed from a screenshot`).toBe(false)
    }
  })

  it('is four characters and matches what the collection accepts', () => {
    const code = makeRoomCode(() => 0.5)
    expect(code).toMatch(/^[A-Z0-9]{4}$/)
  })

  it('accepts what a visitor actually types', () => {
    expect(normaliseCode('  7qk4 ')).toBe('7QK4')
    expect(normaliseCode('7qk')).toBeNull()
    expect(normaliseCode('7qk45')).toBeNull()
    expect(normaliseCode('7q k4')).toBeNull()
  })
})

describe('OrderLog', () => {
  /**
   * The case that decides whether lockstep holds: two orders on one tick.
   * "Apply them as they arrived" gives two different answers on two machines,
   * because the two machines see them arrive in opposite orders.
   */
  it('orders same-tick instructions by side, not by arrival', () => {
    const a = new OrderLog()
    a.add(order({ side: 1, text: 'away first' }))
    a.add(order({ side: 0, text: 'home second' }))

    const b = new OrderLog()
    b.add(order({ side: 0, text: 'home second' }))
    b.add(order({ side: 1, text: 'away first' }))

    expect(a.due(100).map((o) => o.text)).toEqual(['home second', 'away first'])
    expect(a.due(100).map((o) => o.text)).toEqual(b.due(100).map((o) => o.text))
  })

  it('keeps one coach’s two orders in the order they issued them', () => {
    const log = new OrderLog()
    log.add(order({ text: 'first' }))
    log.add(order({ text: 'second' }))
    expect(log.due(100).map((o) => o.text)).toEqual(['first', 'second'])
  })

  /**
   * `send` is echoed to the sender as well as to everyone else, so a client sees
   * its own order twice — once locally if it queued it, once off the channel.
   * Replay adds a third route. All of them must collapse to one application.
   */
  it('refuses a duplicate of an order it already has', () => {
    const log = new OrderLog()
    expect(log.add(order())).toBe(true)
    expect(log.add(order())).toBe(false)
    expect(log.due(100)).toHaveLength(1)
  })

  it('treats a different tick or side as a different order', () => {
    const log = new OrderLog()
    log.add(order())
    expect(log.add(order({ tick: 101 }))).toBe(true)
    expect(log.add(order({ side: 1 }))).toBe(true)
  })

  it('has nothing due on a tick nobody scheduled', () => {
    expect(new OrderLog().due(7)).toEqual([])
  })

  it('yields everything in tick order for a replay', () => {
    const log = new OrderLog()
    log.add(order({ tick: 300 }))
    log.add(order({ tick: 100 }))
    log.add(order({ tick: 200 }))
    expect(log.all().map((o) => o.tick)).toEqual([100, 200, 300])
  })

  it('separates out this side’s own orders for its durable log', () => {
    const log = new OrderLog()
    log.add(order({ side: 0, text: 'mine' }))
    log.add(order({ side: 1, text: 'theirs' }))
    expect(log.mine(0).map((o) => o.text)).toEqual(['mine'])
  })
})

describe('mergeLogs', () => {
  /**
   * Reconnect reads two incomplete pictures: storage lags the channel by a
   * write, and memory is empty after a reload. Neither is authoritative alone.
   */
  it('unions two partial logs without double-applying the overlap', () => {
    const stored = [order({ tick: 100 }), order({ tick: 200 })]
    const inMemory = [order({ tick: 200 }), order({ tick: 300 })]
    expect(mergeLogs(stored, inMemory).all().map((o) => o.tick)).toEqual([100, 200, 300])
  })

  it('is empty for a match nobody has played yet', () => {
    expect(mergeLogs([], []).all()).toEqual([])
  })
})

describe('checksumOf', () => {
  const match = () => ({
    players: [{ pos: { x: 1.234, y: 5.678 } }, { pos: { x: 9, y: 3 } }],
    ball: { pos: { x: 0.5, y: 0.25 } },
    score: [1, 0],
  })

  it('agrees for two identical states', () => {
    expect(checksumOf(match())).toBe(checksumOf(match()))
  })

  it('notices a player who has moved', () => {
    const moved = match()
    moved.players[0]!.pos.x = 1.5
    expect(checksumOf(moved)).not.toBe(checksumOf(match()))
  })

  it('notices a goal', () => {
    const scored = match()
    scored.score = [2, 0]
    expect(checksumOf(scored)).not.toBe(checksumOf(match()))
  })

  /**
   * Tolerance is deliberate. Two correct runs agree exactly, so this is not
   * papering over a real difference — it is refusing to order a full replay
   * because a coordinate differs in a digit below what anyone can see. A real
   * divergence separates players by metres within seconds.
   */
  it('ignores a difference far below a pixel', () => {
    const jittered = match()
    jittered.players[0]!.pos.x = 1.234_000_1
    expect(checksumOf(jittered)).toBe(checksumOf(match()))
  })

  it('is a 32-bit unsigned number, so it survives JSON intact', () => {
    const sum = checksumOf(match())
    expect(Number.isInteger(sum)).toBe(true)
    expect(sum).toBeGreaterThanOrEqual(0)
    expect(sum).toBeLessThanOrEqual(0xffffffff)
  })

  it('answers for a match that has not been built yet', () => {
    expect(checksumOf(null)).toBe(0)
    expect(checksumOf({})).toBeTypeOf('number')
  })
})

describe('order targets', () => {
  /**
   * A bench order and a player order can land on the same tick and are not the
   * same instruction, so the log must not collapse them into one.
   */
  it('tells a bench order apart from a player order', () => {
    const log = new OrderLog()
    log.add(order())
    expect(log.add(order({ player: 'p7' }))).toBe(true)
    expect(log.due(100)).toHaveLength(2)
  })

  it('tells two different players apart', () => {
    const log = new OrderLog()
    log.add(order({ player: 'p7' }))
    expect(log.add(order({ player: 'p9' }))).toBe(true)
  })

  /**
   * Belief travels beside the delta rather than inside it, so two orders that
   * differ only there are different orders — collapsing them would leave one
   * side's players facing the wrong way for the rest of the match.
   */
  it('tells two orders apart by belief alone', () => {
    const log = new OrderLog()
    log.add(order({ belief: { channel: -1 } }))
    expect(log.add(order({ belief: { channel: 1 } }))).toBe(true)
    expect(log.add(order({ belief: { channel: -1 } }))).toBe(false)
  })

  it('still refuses an exact duplicate carrying a target', () => {
    const log = new OrderLog()
    log.add(order({ player: 'p7', belief: { inBehind: 1 } }))
    expect(log.add(order({ player: 'p7', belief: { inBehind: 1 } }))).toBe(false)
  })
})

describe('orders that carry no delta', () => {
  /**
   * "Feed 9" and "they are coming down the left" both change the simulation
   * without touching a single strategy parameter — the source applies them
   * through its own helpers instead. An order log that treated an empty delta as
   * nothing to say would drop them, and the two screens would part company on
   * the first one.
   */
  it('keeps a feed order apart from the order that cleared it', () => {
    const log = new OrderLog()
    log.add(order({ delta: {}, feed: 9 }))
    expect(log.add(order({ delta: {}, feed: null }))).toBe(true)
    expect(log.due(100)).toHaveLength(2)
  })

  it('refuses a duplicate feed order', () => {
    const log = new OrderLog()
    log.add(order({ delta: {}, feed: 9 }))
    expect(log.add(order({ delta: {}, feed: 9 }))).toBe(false)
  })

  /**
   * `feed: null` means "stop feeding anyone" and is a real instruction;
   * `feed: undefined` means the order was never about feeding. Collapsing the
   * two would silently drop every clear-the-feed order.
   */
  it('tells "clear the feed" apart from "this was not about feeding"', () => {
    const log = new OrderLog()
    log.add(order({ delta: {}, feed: null }))
    expect(log.add(order({ delta: {} }))).toBe(true)
  })
})

describe('mark orders', () => {
  /**
   * The path that actually broke a live match. Marking is set on ONE player's
   * policy, so the relayed order has to name the marker as well as the number
   * being marked — two coaches ordering their own player to mark the same
   * opponent are giving two different instructions.
   */
  it('tells two markers apart when they mark the same number', () => {
    const log = new OrderLog()
    log.add(order({ delta: {}, mark: 9, markPlayer: 'p3' }))
    expect(log.add(order({ delta: {}, mark: 9, markPlayer: 'p4' }))).toBe(true)
    expect(log.due(100)).toHaveLength(2)
  })

  it('tells one marker’s two targets apart', () => {
    const log = new OrderLog()
    log.add(order({ delta: {}, mark: 9, markPlayer: 'p3' }))
    expect(log.add(order({ delta: {}, mark: 10, markPlayer: 'p3' }))).toBe(true)
  })

  it('treats "stop marking" as an instruction, not as an absent one', () => {
    const log = new OrderLog()
    log.add(order({ delta: {}, mark: null, markPlayer: 'p3' }))
    expect(log.add(order({ delta: {} }))).toBe(true)
  })

  it('refuses an exact duplicate', () => {
    const log = new OrderLog()
    log.add(order({ delta: {}, mark: 9, markPlayer: 'p3' }))
    expect(log.add(order({ delta: {}, mark: 9, markPlayer: 'p3' }))).toBe(false)
  })
})
