/**
 * Online versus — two coaches, one match, neither machine authoritative.
 *
 * predictmy.ai has this as a separate page backed by a server: rooms live in
 * Redis and a relay pushes each side's tactics to the other. None of that can be
 * ported. A world runs in an iframe with `connect-src 'none'` and has no server
 * of its own, so the whole apparatus had to be rebuilt on what Arena does offer:
 * `ctx.channel` for live relay, `ctx.collection` for anything that must survive
 * a reload. This file is therefore ARENA'S, not the site's — `about.md` says so.
 *
 * ## The shape of it
 *
 * Nothing about the match crosses the wire. The engine is deterministic per tick
 * (`vendor/engine.js` calls `Math.random` zero times), so both sides run the
 * whole simulation locally from one seed and exchange only ORDERS — a few dozen
 * short messages across a match. See `src/lockstep.ts` for the arithmetic and
 * why each piece is the way it is.
 *
 * Two primitives, each doing what only it can:
 *
 *   channel  — live delivery. Fast, unordered across senders, and forgets
 *              everything. Carries the orders while the match is running.
 *   storage  — the room, the seats, and a durable copy of every order. Survives
 *              a reload, which is what makes reconnecting a replay rather than a
 *              forfeit.
 *
 * A world built on the channel alone would lose a match to a refresh. One built
 * on storage alone would be a database polled every ten seconds. Neither is a
 * football match.
 *
 * ## One coach, one team
 *
 * The page was built for a visitor who is the only coach in the room: claim any
 * dot, sit on either bench, order either side. That is exactly wrong once
 * somebody else has the other bench, and it broke versus in two ways at once —
 * one visitor could drive both teams, and every order given through the page's
 * own UI changed the simulation on ONE machine, desyncing the match instantly.
 *
 * Both are fixed at the single choke point every whole-team order passes
 * through, `control.applyToTeam`, which `Session.interceptOrders` replaces while
 * a match runs. An order for your own side is queued and relayed like any other;
 * an order for the opponent's is dropped, because it was never yours to give.
 * Selection is corrected on the next frame for the same reason, since the click
 * handler itself lives in minified code with nothing to anchor to.
 *
 * The point of patching rather than disabling: the source's whole coaching
 * surface — preset buttons, tactics box, AI coach, sliders — keeps working and
 * now relays. What travels is the DELTA, never the sentence: re-interpreting
 * text on the far side would produce a different delta and split the match, and
 * a delta the model produced relays exactly as well as one the rule parser did.
 *
 * ## Four paths, not one
 *
 * A tactical order is not only a delta. The source spreads its effects across
 * four places, and an order relaying any three of them desyncs on the first
 * instruction that uses the fourth:
 *
 *   applyToTeam    the strategy parameters — a bench order
 *   applyToPlayer  the same, aimed at one claimed player
 *   setBelief      where this side thinks the attack is coming
 *   feedTarget     which teammate to look for
 *   markTarget     which opponent one player shadows
 *
 * The first three are METHODS on the control object, so versus captures them by
 * replacement. The last two are plain module-local functions, unreachable from
 * here, so `tools/extract.mjs` reroutes their call sites through
 * `__arenaFeedHook` / `__arenaMarkHook` — the same technique the nav's
 * `location.href` assignments get, and for the same reason: there was nothing
 * else to hold on to.
 *
 * The list was arrived at by enumeration rather than by inspection, because
 * inspection missed `markTarget` and a real match came apart on it. Every
 * mutation of the simulation is either `w.<method>(…)` or an assignment to
 * `.policy.<field>`, and both are greppable in the vendored chunk. If a future
 * extraction adds either, it belongs here too — a path that is not relayed is
 * not a small bug, it is a match that diverges and cannot be replayed back
 * together, because the log it would replay from never saw the order.
 */
import type { WorldCtx } from '@arena/world-sdk'
import type { VersusMatch } from './shim.js'
import {
  CATCHUP_BUDGET,
  DT,
  OrderLog,
  SYNC_EVERY_TICKS,
  checksumOf,
  makeRoomCode,
  mergeLogs,
  normaliseCode,
  scheduleAt,
  tickAt,
  type Order,
} from './lockstep.js'

/** How long after pressing start before the first tick. */
const COUNTDOWN_MS = 3000

/** The half length the source uses for its demo match, in seconds. */
const HALF_LENGTH = 120

type Side = 0 | 1

/** What `setBelief` carries: where this side thinks the attack is going. */
export interface Belief extends Record<string, unknown> {
  channel?: number | null
  inBehind?: number | null
}

interface RoomPayload {
  code: string
  seed: number
  halfLength: number
  startedAt?: number
}

interface SeatPayload {
  room: string
  side: Side
}

interface LogPayload {
  room: string
  side: Side
  orders: Array<{ tick: number; delta: Record<string, unknown>; text?: string }>
}

/** What travels on the channel. Kept short — `maxMessageBytes` is 512. */
type Wire =
  | { t: 'order'; k: number; s: Side; d: Record<string, unknown>; x: string; p?: string; b?: Belief; f?: number | null; m?: number | null; mp?: string }
  | { t: 'sync'; k: number; h: number }
  | { t: 'go'; at: number }

/* ────────────────────────────── copy ────────────────────────────── */

interface Copy {
  title: string
  lead: string
  create: string
  joinPh: string
  join: string
  room: string
  waiting: string
  you: string
  home: string
  away: string
  start: string
  counting: string
  live: string
  orderPh: string
  send: string
  signIn: string
  unavailable: string
  full: string
  noRoom: string
  resyncing: string
  lost: string
  close: string
  hide: string
  control: string
  chip: string
  chipWaiting: string
  notParsed: string
}

const COPY: Record<string, Copy> = {
  en: {
    title: 'Online versus',
    lead: 'Two benches, one match. Create a room and pass the code to the other coach, or enter theirs.',
    create: 'Create room',
    joinPh: 'Room code',
    join: 'Join',
    room: 'Room',
    waiting: 'Waiting for the other coach…',
    you: 'You',
    home: 'Home',
    away: 'Away',
    start: 'Kick off',
    counting: 'Kicking off…',
    live: 'Live',
    orderPh: 'Order your side — "press high", "sit deep", "mark 9"',
    send: 'Send',
    signIn: 'Sign in to play a versus match — a room needs an identity on both sides.',
    unavailable: 'Versus is unavailable on this deployment.',
    full: 'That room already has two coaches.',
    noRoom: 'No room with that code.',
    resyncing: 'Re-syncing…',
    lost: 'Connection lost — reconnecting…',
    close: 'Back to the match',
    hide: 'Hide panel',
    control: 'You coach {team}. Share the room code with your opponent.',
    chip: 'VERSUS',
    chipWaiting: 'VERSUS · WAITING',
    notParsed: 'Not understood — try "press high", "sit deep", "mark 9".',
  },
  zh: {
    title: '联网对战',
    lead: '两条替补席，一场比赛。创建房间把房间码给对方，或者输入对方的房间码。',
    create: '创建房间',
    joinPh: '房间码',
    join: '加入',
    room: '房间',
    waiting: '等待另一位教练…',
    you: '你',
    home: '主队',
    away: '客队',
    start: '开球',
    counting: '即将开球…',
    live: '进行中',
    orderPh: '给你这边下令 —— “压上逼抢”“守后场”“盯防 9 号”',
    send: '发送',
    signIn: '对战需要登录 —— 房间的两边都得有身份。',
    unavailable: '当前部署没有开启对战。',
    full: '这个房间已经有两位教练了。',
    noRoom: '没有这个房间码。',
    resyncing: '正在重新同步…',
    lost: '连接断开，正在重连…',
    close: '回到比赛',
    hide: '收起面板',
    control: '你控制 {team}。把房间码分享给对手加入。',
    chip: '联网对战',
    chipWaiting: '联网对战 · 等待中',
    notParsed: '没听懂 —— 试试“压上逼抢”“守后场”“盯防 9 号”。',
  },
}

const copyFor = (lang: string): Copy => COPY[lang] ?? COPY.en!

/* ────────────────────────────── the world's versus screen ────────────────────────────── */

export interface Versus {
  /** Open the panel. The only entry point; the nav calls this. */
  open: () => void
}

export function mountVersus(ctx: WorldCtx): Versus {
  const ui = buildPanel()
  let session: Session | null = null

  const render = (): void => paint(ui, ctx, session)

  ui.close.addEventListener('click', () => {
    ui.root.hidden = true
    paintChip(ui, ctx, session)
  })

  ui.chip.addEventListener('click', () => {
    ui.root.hidden = false
    render()
    paintChip(ui, ctx, session)
  })

  ui.create.addEventListener('click', () => {
    void guard(() => createRoom(ctx), render).then((made) => {
      if (made) session = made
      render()
      paintChip(ui, ctx, session)
    })
  })

  ui.join.addEventListener('click', () => {
    const code = normaliseCode(ui.codeInput.value)
    if (!code) return
    void guard(() => joinRoom(ctx, code), render).then((made) => {
      if (made) session = made
      render()
      paintChip(ui, ctx, session)
    })
  })

  ui.start.addEventListener('click', () => {
    void session?.kickOff().then(render)
  })

  const submit = (): void => {
    const text = ui.orderInput.value.trim()
    if (!text || !session) return
    ui.orderInput.value = ''
    const said = session.order(text)
    if (!said) {
      say(copyFor(ctx.lang).notParsed)
      render()
    }
  }
  ui.send.addEventListener('click', submit)
  ui.orderInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  })

  ctx.onLangChange(render)
  // The roster, the clock and the desync banner all change without anyone
  // clicking, so the panel repaints on a timer rather than on every event.
  window.setInterval(() => {
    if (!ui.root.hidden) render()
    // Outside the `hidden` check on purpose: the chip's whole job is to be
    // right while the panel is not on screen.
    paintChip(ui, ctx, session)
  }, 500)

  return {
    open() {
      ui.root.hidden = false
      render()
    },
  }
}

/**
 * Run one storage/channel action and turn a typed failure into a line the
 * visitor can act on.
 *
 * Every code here is an ordinary outcome of a shared world rather than a bug:
 * signed out, room full, realtime switched off. The SDK makes them typed
 * precisely so a world can phrase them in its own voice.
 */
async function guard(fn: () => Promise<Session>, after: () => void): Promise<Session | null> {
  try {
    return await fn()
  } catch (err) {
    const code = (err as { code?: string }).code
    lastError = code ?? 'unavailable'
    after()
    return null
  }
}

let lastError: string | null = null

/**
 * The one line the panel uses to say anything, and how long it stays.
 *
 * It needs an expiry because the panel repaints on a timer — the roster, the
 * clock and the desync banner all change with nobody clicking. Without one, a
 * message either vanished on the next 500ms tick before it could be read, or
 * (the first version's bug) was written once and outlived its own cause,
 * telling a visitor to sign in while their match ran.
 */
let notice = ''
let noticeUntil = 0
const NOTICE_MS = 6000

function say(text: string): void {
  notice = text
  noticeUntil = Date.now() + NOTICE_MS
}

/* ────────────────────────────── a match in progress ────────────────────────────── */

/**
 * One versus match, from the moment a room exists to the final whistle.
 *
 * Holds the two things that must not be rebuilt while a match runs — the channel
 * and the tick loop — and everything that decides what the engine is told.
 */
class Session {
  readonly log = new OrderLog()
  /** Ticks already simulated. The only mutable truth about where we are. */
  private current = 0
  /** The newest hash this side computed, for the panel's diagnostic line. */
  ourLatest = 0
  private theirSum = new Map<number, number>()
  private ourSum = new Map<number, number>()
  private frame = 0
  desynced = false
  connected = true

  constructor(
    private readonly ctx: WorldCtx,
    readonly room: RoomPayload,
    readonly side: Side,
    private readonly channel: ReturnType<WorldCtx['channel']>,
    public peers: number,
  ) {}

  get code(): string {
    return this.room.code
  }

  get startedAt(): number | undefined {
    return this.room.startedAt
  }

  get tick(): number {
    return this.current
  }

  /**
   * Wire the channel up and start the clock.
   *
   * Subscribing happens BEFORE `join()` resolves, or the first frames — which
   * include the roster — arrive with nobody listening.
   */
  async begin(): Promise<void> {
    this.channel.onMessage<Wire>((m) => this.receive(m.data))
    this.channel.onPresence((peers) => {
      this.peers = peers.length
      this.connected = true
    })
    this.channel.onClosed(() => {
      this.connected = false
    })
    await this.channel.join()

    /**
     * Joining a match already in progress.
     *
     * The room record carries `startedAt`, so this side knows the clock is
     * running — but its order log is empty, because every order so far was
     * relayed on a channel that keeps no history. Stepping from here would
     * replay the match with NO orders in it, which cannot agree with the one
     * the other coach is watching.
     *
     * `desynced` is therefore the correct state to begin in, not an error: it
     * routes straight into the replay path, which reads both sides' durable
     * logs and rebuilds from the seed. Arriving late and recovering from a
     * divergence are the same problem, so they share the one mechanism.
     */
    if (this.room.startedAt !== undefined) {
      this.takeTheClock()
      if (Date.now() >= this.room.startedAt) this.desynced = true
    }

    this.loop()
  }

  /**
   * Set the shared origin, a few seconds out.
   *
   * Both sides need it before the first tick, and storage is the thing that
   * survives a reload — so it is written there AND announced on the channel. The
   * channel is the fast copy; storage is the true one, which is what a client
   * that reloads mid-match reads.
   */
  async kickOff(): Promise<void> {
    const at = Date.now() + COUNTDOWN_MS
    this.room.startedAt = at
    await this.ctx
      .collection<RoomPayload>('rooms')
      .put(this.roomId, { ...this.room, startedAt: at })
      .catch(() => {})
    await this.channel.send<Wire>({ t: 'go', at }).catch(() => {})
    this.takeTheClock()
  }

  /**
   * Stop the source stepping and rebuild the match on the shared seed.
   *
   * From here the wall clock decides the tick and nothing else does. Drawing is
   * outside the source's paused branch, so the picture keeps updating — it is
   * only the stepping that changes hands.
   */
  private takeTheClock(): void {
    globalThis.__arenaVersus?.pause(true)
    globalThis.__arenaVersus?.start(this.room.seed)
    this.current = 0
    this.interceptOrders()
  }

  /** The source's own `applyToTeam`, kept so relayed orders can reach the engine. */
  private applyDirect: ((match: unknown, side: number, delta: unknown) => void) | null = null

  /**
   * Route the SOURCE's own tactics UI through the relay.
   *
   * This is the fix for the defect that made versus not really versus. The page
   * keeps its whole coaching surface while a match runs — the preset buttons,
   * the tactics box, the AI coach, the ability sliders — and every one of them
   * ends at `control.applyToTeam`. Left alone that call changed the simulation
   * on ONE machine, so any order given the normal way desynced the match
   * instantly; and since the page lets you sit on either bench, one visitor
   * could coach both teams.
   *
   * Patching the single choke point fixes both at once and keeps the source's
   * UI intact, which is much better than disabling it: an order aimed at your
   * own side is queued and relayed like any other, and one aimed at the
   * opponent's is refused because it was never yours to give.
   *
   * `applyDirect` holds the original, which is what `advance()` calls when an
   * order's tick actually arrives — otherwise applying a relayed order would
   * relay it again, forever.
   */
  private playerDirect: ((player: unknown, delta: unknown, flip?: unknown) => void) | null = null
  private beliefDirect: ((match: unknown, side: number, belief: unknown) => void) | null = null

  private interceptOrders(): void {
    const control = globalThis.AGENT?.control
    if (!control || this.applyDirect) return

    this.applyDirect = control.applyToTeam.bind(control)
    control.applyToTeam = (match: unknown, side: number, delta: unknown): void => {
      if (this.applying) return this.applyDirect!(match, side, delta)
      if (side !== this.side) return
      this.issue({ delta: delta as Record<string, unknown> })
    }

    /**
     * The single-player path. `Ue(player, delta, false)` — the function behind
     * every order given to a claimed dot — is a two-line wrapper that calls
     * exactly this, so patching the method catches that route too without
     * needing an anchor into minified code for the wrapper itself.
     */
    this.playerDirect = control.applyToPlayer.bind(control)
    control.applyToPlayer = (player: unknown, delta: unknown, flip?: unknown): void => {
      if (this.applying) return this.playerDirect!(player, delta, flip)
      const p = player as { id?: string; team?: number } | null
      if (!p?.id || p.team !== this.side) return
      this.issue({ delta: delta as Record<string, unknown>, player: p.id })
    }

    /**
     * Where this side believes the attack is going. Set BESIDE a delta rather
     * than inside it, so a relay carrying only the delta would leave the far
     * side's players looking the wrong way — a divergence that grows.
     */
    this.beliefDirect = control.setBelief.bind(control)
    control.setBelief = (match: unknown, side: number, belief: unknown): void => {
      if (this.applying) return this.beliefDirect!(match, side, belief)
      if (side !== this.side) return
      this.issue({ delta: {}, belief: belief as Belief })
    }

    /**
     * The one order path that is not a method and so cannot be replaced.
     *
     * `tools/extract.mjs` reroutes the source's own calls here instead; the
     * fallback in that rewrite (`?? jt`) means an ordinary match never notices
     * this exists. Returning null costs the confirmation chip the source would
     * have appended to its summary — the versus feed still shows the order —
     * which is the price of not applying it half a second early on one screen.
     */
    globalThis.__arenaFeedHook = (team: number, number: number | null): string | null => {
      if (team !== this.side) return null
      this.issue({ delta: {}, feed: number ?? null })
      return null
    }

    /**
     * Marking, the second rerouted helper — and the one that actually broke a
     * match in testing.
     *
     * It is set on ONE player's policy rather than a team's, so the relayed
     * order has to name the marker as well as the number being marked. It also
     * fires only when a coach has one of their own players selected, which is
     * why it survived the first pass: coaching from the bench never reaches it.
     */
    globalThis.__arenaMarkHook = (player: unknown, number: number | null): string | null => {
      const p = player as { id?: string; team?: number } | null
      if (!p?.id || p.team !== this.side) return null
      this.issue({ delta: {}, mark: number ?? null, markPlayer: p.id })
      return null
    }

    this.stopUnrelayed()
  }

  /**
   * The three remaining control methods.
   *
   * Only `window.AGENT` calls these today — no button or text order reaches
   * them — so a human coach cannot desync a match through one. They are stopped
   * anyway, because "unreachable from the UI" is a property of this week's
   * build, and an autonomous agent sitting on a bench in a versus room reaches
   * all three directly. Refusing beats relaying here: zones and waypoints are
   * positional instructions the relay has no shape for yet, and a silent no-op
   * is better than a divergence nobody can replay away.
   */
  private stopUnrelayed(): void {
    const control = globalThis.AGENT?.control as unknown as Record<string, unknown> | undefined
    if (!control) return
    for (const name of ['setZone', 'setPolicy', 'moveTo'] as const) {
      const original = control[name]
      if (typeof original !== 'function') continue
      this.unrelayed.set(name, original as (...args: unknown[]) => unknown)
      control[name] = () => undefined
    }
  }

  private readonly unrelayed = new Map<string, (...args: unknown[]) => unknown>()

  private releaseOrders(): void {
    const control = globalThis.AGENT?.control
    if (!control) return
    if (this.applyDirect) control.applyToTeam = this.applyDirect
    if (this.playerDirect) control.applyToPlayer = this.playerDirect
    if (this.beliefDirect) control.setBelief = this.beliefDirect
    globalThis.__arenaFeedHook = undefined
    globalThis.__arenaMarkHook = undefined
    const bag = globalThis.AGENT?.control as unknown as Record<string, unknown> | undefined
    if (bag) for (const [name, fn] of this.unrelayed) bag[name] = fn
    this.unrelayed.clear()
    this.applyDirect = null
    this.playerDirect = null
    this.beliefDirect = null
  }

  /**
   * Keep the visitor on their own bench.
   *
   * The source lets you claim any dot and sit on either side — correct for a
   * world where you are the only coach, wrong for one where somebody else has
   * the other bench. Rather than blocking the click (which lives inside minified
   * code with no anchor), the selection is corrected on the next frame: a click
   * on the far bench simply does not take.
   */
  private enforceSide(): void {
    const versus = globalThis.__arenaVersus
    if (!versus?.sel) return
    const [player, coach] = versus.sel()

    // The far bench is not yours. Correcting rather than blocking, because the
    // click handler is minified with nothing to anchor a guard into.
    if (coach !== null && coach !== this.side) {
      versus.pick(null, this.side)
      return
    }
    if (player !== null) {
      const owner = globalThis.GAME?.()?.players?.find((p) => p.id === player)
      if (owner && owner.team !== this.side) versus.pick(null, coach)
    }
    // Nothing selected at all: sit this coach on their own bench, which is where
    // a versus coach belongs and what the original does — you are given a team,
    // not an empty pitch to pick from.
    if (player === null && coach === null) versus.pick(null, this.side)
  }

  /** Set by whoever created or found the room record. */
  roomId = ''

  /**
   * Take an order from this side's coach.
   *
   * The DELTA is what travels, never the sentence: the far side must apply the
   * identical parameter change, and re-parsing text there would produce its own.
   * @returns false when the parser made nothing of it.
   */
  order(text: string): boolean {
    const parsed = globalThis.AGENT?.interpret(text)
    if (!parsed || !parsed.delta || Object.keys(parsed.delta).length === 0) return false
    this.issue({ delta: parsed.delta, text })
    return true
  }

  /**
   * Queue and relay one parameter change for this side.
   *
   * The single path every order takes, whether it came from the versus panel or
   * from the source's own tactics UI. Nothing is applied here: the order is
   * scheduled a fixed distance ahead and takes effect when its tick arrives, on
   * both machines, so the two run one sequence rather than two similar ones.
   */
  private issue(part: {
    delta: Record<string, unknown>
    player?: string
    belief?: Belief
    feed?: number | null
    mark?: number | null
    markPlayer?: string
    text?: string
  }): void {
    const order: Order = {
      tick: scheduleAt(this.current),
      side: this.side,
      delta: part.delta,
      text: (part.text ?? '').slice(0, 60),
      ...(part.player ? { player: part.player } : {}),
      ...(part.belief ? { belief: part.belief } : {}),
      ...(part.feed !== undefined ? { feed: part.feed } : {}),
      ...(part.mark !== undefined ? { mark: part.mark, markPlayer: part.markPlayer } : {}),
    }
    this.log.add(order)
    void this.channel
      .send<Wire>({
        t: 'order',
        k: order.tick,
        s: order.side,
        d: order.delta,
        x: order.text,
        ...(order.player ? { p: order.player } : {}),
        ...(order.belief ? { b: order.belief } : {}),
        ...(order.feed !== undefined ? { f: order.feed } : {}),
        ...(order.mark !== undefined ? { m: order.mark, mp: order.markPlayer } : {}),
      })
      .catch(() => {})
    void this.persist()
  }

  private receive(m: Wire): void {
    if (m.t === 'go') {
      if (this.room.startedAt === m.at) return
      this.room.startedAt = m.at
      this.takeTheClock()
      return
    }
    if (m.t === 'order') {
      const order: Order = {
        tick: m.k,
        side: m.s,
        delta: m.d,
        text: m.x,
        ...(m.p ? { player: m.p } : {}),
        ...(m.b ? { belief: m.b } : {}),
        ...(m.f !== undefined ? { feed: m.f } : {}),
        ...(m.m !== undefined ? { mark: m.m, markPlayer: m.mp } : {}),
      }
      if (!this.log.add(order)) return
      // Its tick has already been simulated: this side ran a match the other did
      // not. Nothing local can repair that — only replaying from the seed with
      // the full log can, so say so and do it.
      if (order.tick <= this.current) this.desynced = true
      return
    }
    // A hash from the other side. Compared only against the same tick, since the
    // two clients pass any given tick at different real-world instants.
    this.theirSum.set(m.k, m.h)
    const ours = this.ourSum.get(m.k)
    if (ours !== undefined && ours !== m.h) this.desynced = true
  }

  /**
   * The clock.
   *
   * Wall-clock derived rather than frame-counted — see `tickAt`. A client that
   * was throttled simulates faster until it agrees again, and has not at any
   * point played a different match.
   */
  private loop = (): void => {
    this.frame = requestAnimationFrame(this.loop)

    if (this.desynced) {
      this.replay()
      return
    }
    this.enforceSide()

    const started = this.room.startedAt
    if (!started) return

    const target = tickAt(Date.now(), started)
    let budget = CATCHUP_BUDGET
    while (this.current < target && budget-- > 0) {
      this.advance()
    }
  }

  /**
   * Put one order into the engine, through the source's OWN functions.
   *
   * Always the saved originals, never the patched methods — those exist to
   * capture an order on its way out, and calling one here would relay a relayed
   * order back onto the channel, forever.
   */
  /**
   * True only while a due order is being pushed into the engine.
   *
   * The guard exists because the source's own methods CALL EACH OTHER:
   * `applyToTeam` filters the side's players and then invokes
   * `this.applyToPlayer` on each of them. `this` is the control object, so that
   * inner call lands on the patched method, not the original — and the patch's
   * job is to relay rather than apply.
   *
   * The effect was total. Every bench order was swallowed eleven times and
   * re-emitted as eleven player orders half a second later, asymmetrically,
   * because the patch also refuses anything belonging to the far side — so the
   * two screens applied different things at different ticks and drifted apart
   * within a minute of the first tactical instruction.
   *
   * The top-level call was already safe: `applyOrder` holds the originals. What
   * was missing is that the originals re-enter through the object, and only a
   * flag on the instance can tell "the world is issuing an order" apart from
   * "the engine is carrying one out".
   */
  private applying = false

  private applyOrder(order: Order): void {
    const match = globalThis.GAME?.()
    this.applying = true
    try {
      this.applyInto(match, order)
    } finally {
      this.applying = false
    }
  }

  private applyInto(match: VersusMatch | undefined, order: Order): void {
    if (order.belief) this.beliefDirect?.(match, order.side, order.belief)
    // `null` for the player argument: a versus coach is always on a bench, so a
    // feed order is a whole-team instruction, which is the shape the source uses
    // when its own bench is selected.
    if (order.feed !== undefined) globalThis.__arenaVersus?.feed(order.side, order.feed, null)
    if (order.mark !== undefined) {
      const marker = match?.players?.find((x) => x.id === order.markPlayer)
      if (marker) globalThis.__arenaVersus?.mark(marker, order.mark)
    }
    if (order.player) {
      const p = match?.players?.find((x) => x.id === order.player)
      if (p) this.playerDirect?.(p, order.delta, (match as { sideFlip?: unknown })?.sideFlip)
    } else if (Object.keys(order.delta).length > 0) {
      this.applyDirect?.(match, order.side, order.delta)
    }
    // An order may legitimately carry no delta at all — "feed 9" and "they are
    // going down the left" both change the simulation without touching a single
    // strategy parameter, and dropping them for having an empty delta was how
    // the two screens parted company.
  }

  /** One tick: apply what is due, then step the engine exactly once. */
  private advance(): void {
    for (const order of this.log.due(this.current)) this.applyOrder(order)
    globalThis.STEP?.(1)
    this.current++

    /**
     * Hash on an ABSOLUTE grid — every SYNC_EVERY_TICKS-th tick — not every
     * SYNC_EVERY_TICKS ticks since the last one.
     *
     * The difference is the whole mechanism. A relative counter starts wherever
     * that client happened to be: at 0 for a coach who was here at kick-off, at
     * whatever tick a replay finished on for one who reconnected. The two then
     * hash tick 240 and tick 317 and compare them against nothing, so
     * `theirSum.get()` misses forever and divergence is never detected at all.
     * Two screens drift apart in silence, which is the worst available failure
     * — the recovery path exists and is simply never triggered.
     */
    if (this.current % SYNC_EVERY_TICKS === 0) {
      const h = checksumOf(globalThis.GAME?.())
      this.ourLatest = h
      this.ourSum.set(this.current, h)
      const theirs = this.theirSum.get(this.current)
      if (theirs !== undefined && theirs !== h) this.desynced = true
      void this.channel.send<Wire>({ t: 'sync', k: this.current, h }).catch(() => {})
    }
  }

  /**
   * Rebuild the match from the seed.
   *
   * The single recovery path, and it serves three different failures: a hash
   * mismatch, an order that arrived after its own tick, and a page that was
   * reloaded mid-match with nothing in memory. All three have the same fix and
   * the same cost — a half is 120 seconds of simulation, so this is roughly
   * 15,000 steps, which the source itself does a hundred times over for its own
   * prediction button.
   *
   * Storage is read as well as memory because neither is complete: storage lags
   * the channel by a write, and memory is empty after a reload.
   */
  private replaying = false
  private replay(): void {
    if (this.replaying) return
    this.replaying = true

    void (async () => {
      const stored = await this.fetchLogs().catch(() => [] as Order[])
      const merged = mergeLogs(stored, this.log.all())

      globalThis.__arenaVersus?.start(this.room.seed)
      const target = this.room.startedAt ? tickAt(Date.now(), this.room.startedAt) : 0
      for (let t = 0; t < target; t++) {
        for (const order of merged.due(t)) this.applyOrder(order)
        globalThis.STEP?.(1)
      }

      for (const order of merged.all()) this.log.add(order)
      this.current = target
      this.ourSum.clear()
      this.theirSum.clear()
      this.desynced = false
      this.replaying = false
    })()
  }

  /** Both sides' durable order logs for this room. */
  private async fetchLogs(): Promise<Order[]> {
    const page = await this.ctx
      .collection<LogPayload>('logs')
      .list({ where: { 'payload.room': { eq: this.code } }, limit: 10 })
    return page.items.flatMap((rec) =>
      (rec.payload.orders ?? []).map((o) => ({
        tick: o.tick,
        side: rec.payload.side,
        delta: o.delta,
        text: o.text ?? '',
      })),
    )
  }

  /**
   * Mirror this side's orders into storage.
   *
   * One record per coach per room, rewritten whole rather than appended to:
   * a match produces a few dozen short orders, so the whole log fits well inside
   * `maxRecordBytes`, and one record per ORDER would exhaust a visitor's record
   * quota within a couple of matches.
   */
  private logId: string | null = null
  private async persist(): Promise<void> {
    const logs = this.ctx.collection<LogPayload>('logs')
    const payload: LogPayload = {
      room: this.code,
      side: this.side,
      orders: this.log.mine(this.side).map((o) => ({ tick: o.tick, delta: o.delta, text: o.text })),
    }
    try {
      if (this.logId) {
        await logs.put(this.logId, payload)
      } else {
        const rec = await logs.add(payload)
        this.logId = rec.id
      }
    } catch (err) {
      // `conflict` means another tab of ours wrote first; `quota` means this
      // visitor has too many logs. Neither should stop a match that is running —
      // the durable copy exists for reconnection, and the live one is the
      // channel. Losing it costs a replay, not the game.
      if ((err as { code?: string }).code === 'unique') {
        // The unique tuple is (author, room): a record already exists from an
        // earlier session. Adopt it rather than giving up on persistence.
        const page = await logs.list({ where: { 'payload.room': { eq: this.code } }, mine: true, limit: 1 }).catch(() => null)
        this.logId = page?.items[0]?.id ?? null
      }
    }
  }

  stop(): void {
    cancelAnimationFrame(this.frame)
    // Give the source its loop back, or the pitch stays frozen on whatever tick
    // versus stopped at — a world that looks broken for the rest of the visit.
    globalThis.__arenaVersus?.pause(false)
    this.releaseOrders()
    void this.channel.leave().catch(() => {})
  }
}

/* ────────────────────────────── joining and creating ────────────────────────────── */

async function createRoom(ctx: WorldCtx): Promise<Session> {
  requireIdentity(ctx)
  const code = makeRoomCode()
  const room: RoomPayload = {
    code,
    // Not `Math.random()` folded into the seed by each side — the seed is stored
    // once, by the creator, and both sides read it. Two independently generated
    // seeds would be two matches.
    seed: Math.floor(Math.random() * 0xffffffff) >>> 0,
    halfLength: HALF_LENGTH,
  }

  const rooms = ctx.collection<RoomPayload>('rooms')
  // One room per visitor (`maxRecordsPerAuthor: 1`), so creating another reuses
  // the record rather than failing on quota.
  const mineNow = await rooms.list({ mine: true, limit: 1 }).catch(() => null)
  const existing = mineNow?.items[0]
  const rec = existing ? await rooms.put(existing.id, room) : await rooms.add(room)

  await ctx.collection<SeatPayload>('seats').add({ room: code, side: 0 })
  const session = await open(ctx, room, 0)
  session.roomId = rec.id
  return session
}

async function joinRoom(ctx: WorldCtx, code: string): Promise<Session> {
  requireIdentity(ctx)
  const rooms = ctx.collection<RoomPayload>('rooms')
  const found = await rooms.list({ where: { 'payload.code': { eq: code } }, limit: 1 })
  const rec = found.items[0]
  if (!rec) throw Object.assign(new Error('no such room'), { code: 'not-found' })

  const seats = ctx.collection<SeatPayload>('seats')
  const taken = await seats.list({ where: { 'payload.room': { eq: code } }, limit: 4 })
  const mine = taken.items.find((s) => s.mine)
  let side: Side
  if (mine) {
    // Rejoining a room this visitor already sat down in — after a reload, say.
    side = mine.payload.side
  } else {
    const free = ([0, 1] as Side[]).find((s) => !taken.items.some((t) => t.payload.side === s))
    if (free === undefined) throw Object.assign(new Error('room is full'), { code: 'quota' })
    side = free
    await seats.add({ room: code, side })
  }

  const session = await open(ctx, rec.payload, side)
  session.roomId = rec.id
  return session
}

async function open(ctx: WorldCtx, room: RoomPayload, side: Side): Promise<Session> {
  const channel = ctx.channel(`versus/${room.code.toLowerCase()}`)
  const session = new Session(ctx, room, side, channel, 0)

  /**
   * Deliberately NOT pausing the source's loop here.
   *
   * Versus owns the clock only once there IS one — that is, from kick-off. The
   * first version stopped the loop the moment a room existed, while the tick
   * loop still returns early until `startedAt` is set: between creating a room
   * and pressing kick off, nothing advanced the match at all. A visitor who
   * made a room and closed the panel was left staring at a frozen pitch with no
   * way to tell what they had broken.
   *
   * So the demo match keeps running normally while the room fills up, and
   * `takeTheClock` runs at kick-off — from both the button and the far side's
   * `go`, since either can be the first to know.
   */
  await session.begin()
  return session
}

function requireIdentity(ctx: WorldCtx): void {
  if (!ctx.me) throw Object.assign(new Error('sign in first'), { code: 'unauthenticated' })
}

/* ────────────────────────────── the panel ────────────────────────────── */

interface Panel {
  root: HTMLElement
  chip: HTMLButtonElement
  title: HTMLElement
  lead: HTMLElement
  lobby: HTMLElement
  create: HTMLButtonElement
  codeInput: HTMLInputElement
  join: HTMLButtonElement
  match: HTMLElement
  roomLine: HTMLElement
  code: HTMLElement
  seats: HTMLElement
  status: HTMLElement
  start: HTMLButtonElement
  orderInput: HTMLInputElement
  send: HTMLButtonElement
  feed: HTMLElement
  close: HTMLButtonElement
  noteLine: HTMLElement
}

/**
 * Built in the broadcast chrome's own vocabulary — the same translucent panel,
 * hairline border and amber the source uses for its remote — so this reads as
 * another control on the same television rather than as a dialog from a
 * different application pasted over one.
 */
function buildPanel(): Panel {
  const css = document.createElement('style')
  css.textContent = `
    /**
     * Two shapes, because the panel is answering two different questions.
     *
     * Setting up a room is a modal moment: there is nothing to watch yet, and a
     * centred card over a dimmed pitch is the right way to ask for a code.
     *
     * Coaching a live match is the opposite. The first version stayed modal
     * once the match started, which meant the thing you were coaching — and
     * every control the source ships — sat behind a blur while you gave orders
     * to it. So a seated panel docks to the corner instead: no backdrop, no
     * blur, nothing swallowing clicks meant for the pitch.
     */
    #arena-versus { position: fixed; inset: 0; z-index: 480; display: flex;
      align-items: center; justify-content: center; padding: 20px;
      background: rgba(4,6,10,0.72); backdrop-filter: blur(3px); }
    #arena-versus[hidden] { display: none; }
    /* Docked: the element still spans the viewport for positioning, so it must
       stop intercepting pointer events — only the card takes them back.
       Bottom LEFT, not right. Arena draws a world's attribution chip — "based on
       PredictMy.ai" — in the bottom-right corner of a fullscreen world, OUTSIDE
       this frame, so anything parked there is covered by platform chrome this
       document cannot see or measure. The source pins nothing along the bottom
       (its stadium sits at z-index -2), so the left corner is free. */
    #arena-versus.docked { background: none; backdrop-filter: none;
      align-items: flex-end; justify-content: flex-start; pointer-events: none; }
    #arena-versus.docked .card { width: min(330px, 100%); padding: 16px; pointer-events: auto;
      box-shadow: 0 12px 32px rgba(0,0,0,0.55); }
    #arena-versus.docked h3, #arena-versus.docked p.lead { display: none; }
    #arena-versus.docked .code { font-size: 17px; letter-spacing: 4px; padding: 7px 9px; margin-bottom: 9px; }
    #arena-versus.docked .feed { max-height: 92px; }
    /* On a phone the pitch owns the screen; a corner card would cover a third of
       it, so the docked panel becomes a strip along the bottom instead. */
    /* On a phone the pitch owns the screen; a corner card would cover a third of
       it, so the docked panel becomes a strip along the bottom instead. The
       extra bottom padding keeps it clear of the platform's corner chip, which
       a full-width strip would otherwise sit straight on top of. */
    @media (max-width: 720px) {
      #arena-versus.docked { padding: 8px 8px 52px; }
      #arena-versus.docked .card { width: 100%; }
      #arena-versus.docked .feed { display: none; }
    }
    #arena-versus .card { width: min(460px, 100%); border-radius: 14px; padding: 22px;
      background: linear-gradient(178deg, #262a31 0%, #16181d 60%, #101115 100%);
      border: 1px solid rgba(255,255,255,0.14); box-shadow: 0 24px 60px rgba(0,0,0,0.6);
      font: 14px/1.6 ui-sans-serif, system-ui; color: #e6edf3; }
    #arena-versus h3 { margin: 0 0 8px; font-size: 17px; font-weight: 700; color: #ffd23f; }
    #arena-versus p.lead { margin: 0 0 16px; color: #adbac7; }
    #arena-versus .row { display: flex; gap: 9px; margin-bottom: 10px; }
    #arena-versus input { flex: 1; min-width: 0; padding: 9px 11px; border-radius: 9px;
      background: rgba(0,0,0,0.42); border: 1px solid rgba(255,255,255,0.16);
      color: inherit; font: inherit; }
    #arena-versus button { padding: 9px 14px; border-radius: 9px; font: 600 13px inherit;
      cursor: pointer; border: 1px solid rgba(255,255,255,0.18); background: none; color: #d7dbe0; }
    #arena-versus button.go { border-color: #f5b73a; background: linear-gradient(180deg,#ffe071,#f5b73a); color: #12151a; }
    #arena-versus button[disabled] { opacity: 0.45; cursor: default; }
    #arena-versus .code { display: block; user-select: all; margin-bottom: 12px; padding: 11px 13px;
      border-radius: 9px; background: rgba(0,0,0,0.42); border: 1px solid rgba(255,210,63,0.35);
      font: 700 22px ui-monospace, monospace; letter-spacing: 6px; text-align: center; color: #ffe071; }
    #arena-versus .seats { display: flex; gap: 8px; margin-bottom: 12px; }
    #arena-versus .seat { flex: 1; padding: 8px 10px; border-radius: 8px; text-align: center;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.28);
      font: 600 12px ui-monospace, monospace; letter-spacing: 1px; color: #9aa4b1; }
    #arena-versus .seat.you { border-color: rgba(255,210,63,0.5); color: #ffe071; }
    /* Sized and ringed like the players' dots, matching the score bar's swatch. */
    #arena-versus .seat .sw { width: 8px; height: 8px; border-radius: 50%; flex: none;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.55); }
    #arena-versus .roomLine { margin-bottom: 10px; color: #adbac7; font-size: 12px; }
    #arena-versus .status { margin-bottom: 12px; font: 600 12px ui-monospace, monospace;
      letter-spacing: 1px; color: #9aa4b1; }
    #arena-versus .status.warn { color: #ffb454; }
    #arena-versus .feed { max-height: 132px; overflow-y: auto; margin-bottom: 12px;
      font: 12px/1.7 ui-monospace, monospace; color: #8b97a5; }
    #arena-versus .feed div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #arena-versus .note { min-height: 18px; margin-bottom: 10px; font-size: 12px; color: #ffb454; }
    #arena-versus [hidden] { display: none; }

    /* Left, for the same reason as the docked panel: the opposite corner belongs
       to Arena's attribution chip. */
    #arena-versus-chip { position: fixed; left: 16px; bottom: 16px; z-index: 479;
      display: inline-flex; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 8px;
      border: 1px solid rgba(255,210,63,0.45); background: rgba(0,0,0,0.62);
      backdrop-filter: blur(4px); cursor: pointer; white-space: nowrap;
      font: 600 11px ui-monospace, monospace; letter-spacing: 1.4px; color: #ffe071; }
    #arena-versus-chip[hidden] { display: none; }
    #arena-versus-chip:hover { border-color: #ffd23f; background: rgba(0,0,0,0.78); }
    /* A live dot, the same idea as the on-air light a broadcast keeps in shot. */
    #arena-versus-chip .dot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.35); flex: none; }
    #arena-versus-chip.warn { border-color: rgba(255,180,84,0.6); color: #ffb454; }
    #arena-versus-chip.warn .dot { background: #ffb454; }
    @media (max-width: 720px) { #arena-versus-chip { left: 8px; bottom: 8px; } }
  `
  document.head.appendChild(css)

  const root = document.createElement('div')
  root.id = 'arena-versus'
  root.hidden = true
  root.innerHTML =
    `<div class="card">` +
    `<h3></h3><p class="lead"></p>` +
    `<div class="lobby">` +
    `<div class="row"><button class="go create"></button></div>` +
    `<div class="row"><input class="codeInput" maxlength="4" autocomplete="off"><button class="join"></button></div>` +
    `</div>` +
    `<div class="match" hidden>` +
    `<div class="roomLine"></div><code class="code"></code>` +
    `<div class="seats"></div>` +
    `<div class="status"></div>` +
    `<div class="row"><button class="go start"></button></div>` +
    `<div class="row"><input class="orderInput" autocomplete="off"><button class="send"></button></div>` +
    `<div class="feed"></div>` +
    `</div>` +
    `<div class="note"></div>` +
    `<div class="row"><button class="close"></button></div>` +
    `</div>`
  document.body.appendChild(root)

  /**
   * The panel's own door back in, and the only sign a visitor has that this
   * match is not the ordinary one.
   *
   * Both problems are the same problem. Hiding the panel used to leave versus
   * reachable only through the nav menu — three clicks into a dropdown that
   * says "online versus", which reads as "start one" rather than "return to the
   * one you are in". And nothing on screen distinguished a versus match from
   * the demo running by itself, so a coach who hid the panel had no way to know
   * the other bench was still there.
   *
   * Deliberately NOT inside `root`: that element is the panel, and the whole
   * point is to be visible when the panel is not.
   */
  const chip = document.createElement('button')
  chip.id = 'arena-versus-chip'
  chip.hidden = true
  document.body.appendChild(chip)

  const q = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T
  return {
    root,
    title: q('h3'),
    lead: q('p.lead'),
    lobby: q('.lobby'),
    create: q('.create'),
    codeInput: q('.codeInput'),
    join: q('.join'),
    match: q('.match'),
    roomLine: q('.roomLine'),
    code: q('.code'),
    seats: q('.seats'),
    status: q('.status'),
    start: q('.start'),
    orderInput: q('.orderInput'),
    send: q('.send'),
    feed: q('.feed'),
    close: q('.close'),
    noteLine: q('.note'),
    chip,
  }
}



/**
 * The badge shown when the panel is put away.
 *
 * Visible only while a session exists AND the panel is hidden — with the panel
 * open it would be a second copy of what is already on screen. It carries the
 * room code because that is the one thing a coach needs to read out while the
 * panel is closed, and it turns amber when the match needs attention, so
 * "hidden" never means "unaware".
 */
function paintChip(ui: Panel, ctx: WorldCtx, session: Session | null): void {
  if (!session || !ui.root.hidden) {
    ui.chip.hidden = true
    return
  }
  const c = copyFor(ctx.lang)
  const running = session.startedAt !== undefined && Date.now() >= session.startedAt
  const trouble = session.desynced || !session.connected

  ui.chip.hidden = false
  ui.chip.classList.toggle('warn', trouble)

  const dot = document.createElement('span')
  dot.className = 'dot'
  // The engine's own fill for this coach's side, so the badge answers "which
  // team am I" without opening anything.
  const fill = globalThis.__arenaTeamFill?.(session.side)
  if (fill && !trouble) dot.style.background = fill
  const label = document.createElement('span')
  // `textContent` per part: the room code is short and ours, but this element
  // sits outside the panel and the same rule should not have two answers.
  label.textContent = trouble
    ? `${c.chip} · ${session.code} · ${!session.connected ? c.lost : c.resyncing}`
    : running
      ? `${c.chip} · ${session.code} · ${Math.floor(session.tick * DT)}s`
      : `${c.chipWaiting} · ${session.code}`
  ui.chip.replaceChildren(dot, label)
}

/**
 * Draw the panel for whatever state the session is in.
 *
 * Every string goes in through `textContent`. The feed shows what the OTHER
 * coach typed, which is another visitor's content arriving over a channel that
 * nothing moderates — `innerHTML` here would be an injection sink fed by a
 * stranger.
 */
function paint(ui: Panel, ctx: WorldCtx, session: Session | null): void {
  const c = copyFor(ctx.lang)
  ui.title.textContent = c.title
  ui.lead.textContent = c.lead
  ui.create.textContent = c.create
  ui.codeInput.placeholder = c.joinPh
  ui.join.textContent = c.join
  ui.orderInput.placeholder = c.orderPh
  ui.send.textContent = c.send
  ui.close.textContent = c.close

  /**
   * Assigned on EVERY paint, not only when there is something to say.
   *
   * Writing it only inside `if (lastError)` left the last failure on screen for
   * the rest of the session: a visitor who tried to join before signing in was
   * still being told to sign in while their match ran, and one whose first join
   * raced the backend read "versus is unavailable" over a live scoreboard. A
   * message that outlives its cause is worse than no message — it contradicts
   * what the panel beside it is showing.
   */
  if (lastError) {
    say(
      lastError === 'unauthenticated'
        ? c.signIn
        : lastError === 'not-found'
          ? c.noRoom
          : lastError === 'quota'
            ? c.full
            : c.unavailable,
    )
    lastError = null
  }
  ui.noteLine.textContent = Date.now() < noticeUntil ? notice : ''

  // Seated: get out of the way of the thing being coached. See the CSS.
  ui.root.classList.toggle('docked', session !== null)
  ui.lobby.hidden = session !== null
  ui.match.hidden = session === null
  if (!session) return

  // Docked, "back to the match" is no longer where you are going — the match is
  // already visible behind the card. It means put this away.
  ui.close.textContent = c.hide

  ui.code.textContent = session.code

  /**
   * The two benches, named the way the pitch names them.
   *
   * The source's own team names rather than "home"/"away" where a fixture
   * supplies them, and each behind the engine's OWN fill colour — the same value
   * it paints the dots with. A versus match is one coach per team, so "which of
   * those two is mine" is the single most load-bearing fact on this panel, and a
   * colour the visitor can match to the pitch answers it faster than a word.
   */
  const nameOf = (s: Side): string => globalThis.__arenaTeamName?.(s) ?? [c.home, c.away][s]!
  ui.seats.replaceChildren(
    ...([0, 1] as Side[]).map((s) => {
      const el = document.createElement('div')
      el.className = 'seat' + (s === session.side ? ' you' : '')
      const fill = globalThis.__arenaTeamFill?.(s)
      if (fill) {
        const dot = document.createElement('span')
        dot.className = 'sw'
        dot.style.background = fill
        el.appendChild(dot)
      }
      el.appendChild(document.createTextNode(s === session.side ? `${nameOf(s)} — ${c.you}` : nameOf(s)))
      return el
    }),
  )

  // The original says this in a line under the pitch; without it a coach has to
  // infer which side is theirs from a highlighted box.
  ui.roomLine.textContent = c.control.replace('{team}', nameOf(session.side))

  const bothHere = session.peers >= 2
  const running = session.startedAt !== undefined && Date.now() >= session.startedAt

  ui.status.classList.toggle('warn', session.desynced || !session.connected)
  /**
   * The live line carries the tick and this side's latest hash.
   *
   * Not decoration. Two coaches looking at two screens cannot otherwise tell
   * apart the three ways versus fails, and they need different fixes: a clock
   * stuck at 0s means the relay never delivered kick-off, two clocks running at
   * different times means one side is catching up (fine, it converges), and two
   * DIFFERENT hashes on the same tick means the simulations have parted company.
   * Without this the first and third look identical from the outside — both are
   * "the screens don't match".
   */
  ui.status.textContent = !session.connected
    ? c.lost
    : session.desynced
      ? c.resyncing
      : running
        ? `${c.live} · ${Math.floor(session.tick * DT)}s · #${session.ourLatest.toString(16).padStart(8, '0')}`
        : session.startedAt !== undefined
          ? c.counting
          : bothHere
            ? ''
            : c.waiting

  ui.start.textContent = c.start
  ui.start.hidden = session.startedAt !== undefined
  ui.start.disabled = !bothHere || session.side !== 0

  ui.orderInput.disabled = !running
  ui.send.disabled = !running

  ui.feed.replaceChildren(
    ...session.log
      .all()
      .slice(-8)
      .map((o) => {
        const el = document.createElement('div')
        // An order given through the source's own UI carries no sentence — it
        // was a preset button or a slider, not a typed instruction — so the feed
        // names the side and says an order was made rather than inventing words
        // for it.
        const said = o.text || '·'
        el.textContent = `${String(Math.floor(o.tick * DT)).padStart(3, ' ')}s  ${nameOf(o.side)}  ${said}`
        return el
      }),
  )
}
