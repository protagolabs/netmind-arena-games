/**
 * The arithmetic online versus rests on, kept apart from the DOM so it can be
 * tested without one.
 *
 * ## Why lockstep at all
 *
 * The engine is deterministic per tick — `src/vendor/engine.js` calls
 * `Math.random` exactly zero times and draws everything from a seeded `rng()`
 * carried in the match state. So two browsers starting from one seed and taking
 * the SAME NUMBER OF STEPS, with the same orders applied at the same steps, play
 * the identical match down to the last bounce. Nothing about positions, scores
 * or possession ever has to cross the wire; only the orders do, and those are a
 * few dozen short messages across ninety minutes.
 *
 * That is the whole reason versus is feasible inside a world at all. A channel
 * that relays "at tick 137, the home coach ordered a high press" needs a
 * fraction of the bandwidth that streaming a match state would, and it degrades
 * into a replay rather than into a stutter.
 *
 * ## What has to be true, and how each is arranged
 *
 *  1. **Both sides take the same number of steps.** The source's own loop steps
 *     by wall clock — an accumulator over `requestAnimationFrame`, capped at 8
 *     ticks a frame — and two browsers do not agree on that: a background tab
 *     is throttled, a slow frame gets clamped, and the tick counts drift apart
 *     within a minute. So versus stops that loop (`__arenaVersus.pause`) and
 *     derives the tick from a SHARED ORIGIN instead: see {@link tickAt}.
 *  2. **Orders land on the same tick on both screens.** An order is not applied
 *     when it is typed; it is scheduled a fixed number of ticks ahead, far
 *     enough that the relay beats it there. See {@link INPUT_DELAY_TICKS}.
 *  3. **Divergence is noticed.** Floating point is deterministic within one
 *     engine, but a late order or a dropped frame is not, so both sides hash
 *     their state periodically and compare. See {@link checksumOf}.
 *  4. **Divergence is recoverable.** Every order is also written to storage, so
 *     a diverged — or freshly reloaded — client can replay the whole match from
 *     the seed. A half is 120 seconds of simulation, so a full replay is about
 *     15,000 steps: expensive enough to notice, cheap enough to do silently.
 *     The source itself replays a hundred matches for its own prediction button.
 */

/** The engine's fixed timestep, in seconds. `window.CFG.DT` at runtime. */
export const DT = 1 / 60

/**
 * How far ahead an order is scheduled.
 *
 * This is the whole latency budget, and it is spent on three things: the relay
 * (host → backend → Redis → backend → host, typically well under 200ms), the
 * gap between the two clients' clocks, and whatever the browser is doing
 * instead of running our frame.
 *
 * Half a second, and deliberately generous. The cost of too much delay is that
 * a coach's order takes effect half a second after they press enter — which
 * nobody notices, because they just typed a sentence at a football match. The
 * cost of too little is an order arriving after its own tick, which is a
 * desync and costs a full replay. The asymmetry is enormous, so this errs the
 * safe way.
 *
 * Note what this does NOT need to cover: rendering, or the other side's frame
 * rate. Both clients converge on the same tick from the same wall clock, so a
 * slow client is BEHIND IN TIME while playing the identical match — it catches
 * up by stepping faster, not by diverging.
 */
export const INPUT_DELAY_TICKS = Math.round(0.5 / DT)

/** How often the two sides compare hashes, in ticks (about four seconds). */
export const SYNC_EVERY_TICKS = 240

/**
 * Ticks that may be simulated in one animation frame while catching up.
 *
 * A tab in the background stops getting frames; when it returns it may be
 * thousands of ticks behind. Stepping all of them at once would freeze the page
 * for as long as it took, so catch-up is spread over frames — visibly fast, but
 * never a stall. 600 is ten seconds of match per frame.
 */
export const CATCHUP_BUDGET = 600

/**
 * Which tick the match should be on now.
 *
 * The shared origin is the room's `startedAt`, a wall-clock instant both sides
 * read from the same stored record. Each client independently converges on the
 * tick that instant implies, which is what makes catching up a NON-EVENT: a
 * client that was throttled is behind in real time and simulates faster until
 * it agrees again, and at no point has it played a different match.
 *
 * Clock skew between the two machines does not change the simulation — the tick
 * an order lands on is an absolute number, not a local time. Skew only eats into
 * the budget in {@link INPUT_DELAY_TICKS}, because an order issued by a client
 * whose clock runs early is scheduled slightly sooner in the other's real time.
 */
export function tickAt(nowMs: number, startedAtMs: number, dt = DT): number {
  if (!Number.isFinite(startedAtMs) || nowMs <= startedAtMs) return 0
  return Math.floor((nowMs - startedAtMs) / 1000 / dt)
}

/** The tick an order typed now should take effect on, for both sides alike. */
export function scheduleAt(currentTick: number, delay = INPUT_DELAY_TICKS): number {
  return currentTick + delay
}

/* ────────────────────────────── room codes ────────────────────────────── */

/**
 * Letters and digits with the ambiguous pairs removed.
 *
 * A room code is read aloud or typed from a screenshot, so `O`/`0` and `I`/`1`
 * are not a cosmetic concern — they are the difference between joining and being
 * told the room does not exist, with nothing on screen to explain why.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** A four-character room code. `rand` is injected so tests are not random. */
export function makeRoomCode(rand: () => number = Math.random): string {
  let out = ''
  for (let i = 0; i < 4; i++) {
    out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)] ?? 'A'
  }
  return out
}

/** What a visitor typed, in the one shape the room collection accepts. */
export function normaliseCode(raw: string): string | null {
  const up = raw.trim().toUpperCase()
  return /^[A-Z0-9]{4}$/.test(up) ? up : null
}

/* ────────────────────────────── the order log ────────────────────────────── */

export interface Order {
  /** The tick this takes effect on, identical on both sides. */
  tick: number
  /** Which bench issued it. Also decides the order two same-tick orders apply in. */
  side: 0 | 1
  /** The engine's own parameter delta — see `window.AGENT.interpret`. */
  delta: Record<string, unknown>
  /**
   * Set when the order was aimed at one claimed player rather than the bench.
   * The id is the engine's, and both sides resolve it against their own copy of
   * the match — which is the same copy, or the whole design has already failed.
   */
  player?: string
  /**
   * Where this side thinks the attack is going. The source sets this BESIDE a
   * delta rather than inside it, so an order carrying only the delta would
   * leave the far side's players facing the wrong way.
   */
  belief?: Record<string, unknown>
  /**
   * A teammate's shirt number to feed, or null to clear it.
   *
   * Carried separately for the same reason as `belief`: the source applies it
   * through its own helper rather than folding it into the delta, so an order
   * without this field would leave one side passing to somebody the other side
   * is not.
   */
  feed?: number | null
  /**
   * An opponent's shirt number for `markPlayer` to mark, or null to stop.
   *
   * Always paired with `player`, because marking is something one footballer
   * does — it is set on the marker's own policy, not the team's.
   */
  mark?: number | null
  /** The marker, when `mark` is set. The engine's own player id. */
  markPlayer?: string
  /** What the coach typed, for the feed. Never used to compute anything. */
  text: string
}

/**
 * Every order either side has issued, in the one order both sides will apply
 * them.
 *
 * ## Why ordering has to be defined here rather than left to arrival
 *
 * Two orders can land on the same tick — one from each coach, or one coach
 * issuing twice. `applyToTeam` is not commutative in general, so "apply them as
 * they arrived" is a rule that gives two different answers on two machines,
 * which is precisely the failure lockstep exists to prevent. Sorting by
 * `(tick, side, sequence)` is a rule both sides can evaluate alone and agree on.
 */
export class OrderLog {
  private readonly byTick = new Map<number, Order[]>()
  /** Insertion order within one (tick, side), so a coach's two orders keep theirs. */
  private readonly seq = new Map<Order, number>()
  private counter = 0

  /** @returns false when this exact order is already known (a replayed duplicate). */
  add(order: Order): boolean {
    const bucket = this.byTick.get(order.tick)
    if (bucket?.some((o) => same(o, order))) return false
    const list = bucket ?? []
    list.push(order)
    this.seq.set(order, this.counter++)
    list.sort((a, b) => a.side - b.side || this.seq.get(a)! - this.seq.get(b)!)
    this.byTick.set(order.tick, list)
    return true
  }

  /** Orders that take effect on `tick`, in the agreed order. */
  due(tick: number): readonly Order[] {
    return this.byTick.get(tick) ?? []
  }

  /** Everything, sorted — the form a replay consumes and storage holds. */
  all(): Order[] {
    return [...this.byTick.keys()]
      .sort((a, b) => a - b)
      .flatMap((t) => this.byTick.get(t)!)
  }

  /** Orders this side issued, for its own durable log. */
  mine(side: 0 | 1): Order[] {
    return this.all().filter((o) => o.side === side)
  }

  get size(): number {
    return this.byTick.size
  }
}

function same(a: Order, b: Order): boolean {
  return (
    a.tick === b.tick &&
    a.side === b.side &&
    a.text === b.text &&
    a.player === b.player &&
    // NOT `?? null` on both sides: `null` means "stop feeding anyone" and is a
    // real instruction, while `undefined` means the order was never about
    // feeding at all. Folding them together made every clear-the-feed order
    // look like a duplicate of the order before it and silently vanish.
    a.feed === b.feed &&
    a.mark === b.mark &&
    a.markPlayer === b.markPlayer &&
    JSON.stringify(a.delta) === JSON.stringify(b.delta) &&
    JSON.stringify(a.belief ?? null) === JSON.stringify(b.belief ?? null)
  )
}

/**
 * Merge two logs, keeping one copy of anything in both.
 *
 * Used on reconnect: the durable log in storage and whatever this page already
 * has in memory are both incomplete in different ways. Storage lags the channel
 * by a write, and memory starts empty after a reload.
 */
export function mergeLogs(...logs: readonly Order[][]): OrderLog {
  const out = new OrderLog()
  for (const log of logs) for (const order of log) out.add(order)
  return out
}

/* ────────────────────────────── divergence ────────────────────────────── */

/** Just enough of the match state to notice two simulations parting company. */
interface HashableMatch {
  players?: Array<{ pos?: { x?: number; y?: number } }>
  ball?: { pos?: { x?: number; y?: number } }
  score?: readonly number[]
}

/**
 * A cheap 32-bit hash of everything that would differ if the two sides had
 * diverged.
 *
 * Positions are quantised to a centimetre before hashing. Not to paper over a
 * real difference — the engine is deterministic and two correct runs agree
 * exactly — but because the alternative is hashing raw doubles, where a
 * difference in the last bit of a coordinate nobody can see would report a
 * desync and trigger a replay for nothing. A genuine divergence moves players
 * metres apart within a second or two, so a centimetre of tolerance costs
 * essentially no detection latency.
 *
 * The score is folded in unquantised: it is the one field where a difference of
 * any size is total.
 */
export function checksumOf(match: HashableMatch | null | undefined): number {
  if (!match) return 0
  let h = 0x811c9dc5
  const fold = (n: number): void => {
    h ^= n | 0
    // FNV-ish mixing via Math.imul, which stays in 32-bit territory.
    h = Math.imul(h, 0x01000193)
  }
  const cm = (v: number | undefined): number => Math.round((v ?? 0) * 100)

  for (const p of match.players ?? []) {
    fold(cm(p.pos?.x))
    fold(cm(p.pos?.y))
  }
  fold(cm(match.ball?.pos?.x))
  fold(cm(match.ball?.pos?.y))
  for (const s of match.score ?? []) fold(s)
  return h >>> 0
}
