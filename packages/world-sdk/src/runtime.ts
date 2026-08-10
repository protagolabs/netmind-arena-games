/**
 * The author-side runtime: turns the {@link WorldCtx} contract into
 * `postMessage` traffic and boots the world once the host has handed over
 * identity, theme, language and the first page of every collection.
 *
 * An author never imports this file — `defineWorld` wires it up. It exists as a
 * separate module so the protocol handling is testable without a browser.
 */

import {
  WORLD_CHANNEL,
  isHostMessage,
  type HostInit,
  type HostMessage,
  type HostSignal,
  type RecordPage,
  type StoredRecord,
  type ThemeTokens,
  type VisitorInfo,
  type WorldOp,
} from './protocol.js'
import type {
  AiReply,
  AiRequest,
  ChangeEvent,
  Channel,
  ChannelMessage,
  Collection,
  Json,
  LocalStore,
  Peer,
  WorldAi,
  Page,
  Rec,
  Unsubscribe,
  Visitor,
  WorldCtx,
  WorldDefinition,
  WorldError,
  WorldErrorCode,
  WorldTheme,
} from './types.js'

const SDK_VERSION = '0.0.1'

/**
 * How long a request waits for the host before it gives up.
 *
 * The protocol says the host answers every request, and it does — but "the host
 * always replies" is an assumption about someone else's code, and the failure it
 * hides is the worst-shaped one available: a promise that never settles, a
 * spinner that never stops, and a `pending` entry that is never collected. A
 * world cannot even show its own error state, because nothing told it there was
 * one.
 *
 * `unavailable` is deliberate — it is the code the SDK already documents as
 * retryable, so a world that handles a transport failure at all handles this too.
 *
 * ## This is a backstop, so it must sit OUTSIDE every legitimate wait
 *
 * The host runs its own deadline per operation and answers with a typed error
 * when it expires. That is the timeout a world should normally see. This one
 * only exists for the case where no answer comes at all — a host that crashed, a
 * frame torn down mid-flight — so it has to be longer than anything the host
 * might honestly still be working on.
 *
 * Get that ordering wrong and the failure is not "a world waits too long", it is
 * a world giving up on work that then COMPLETES: for `ai.chat` the platform bills
 * the visitor for a reply nobody is listening for any more.
 */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * `ai.chat`'s backstop, which has to be much larger, for two reasons that
 * compound.
 *
 * A model call is slow by nature — Arena allows it a minute of its own. And the
 * host may spend part of the same request WAITING FOR A PERSON: the first time a
 * world asks for a model, the visitor is shown what it is for and asked whether
 * to spend their own credit on it. Reading that and deciding is not a transport
 * delay, and the people slowest to answer it are exactly the ones seeing it for
 * the first time.
 *
 * So this sits above the host's own ceiling for the op, not below it.
 */
const AI_REQUEST_TIMEOUT_MS = 120_000

/** Ordinary ops are fast and the host bounds them tightly; the model call is not. */
const timeoutFor = (op: WorldOp): number => (op === 'ai.chat' ? AI_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS)

function fail(code: WorldErrorCode, message: string, retryAfterSec?: number): WorldError {
  const err = new Error(message) as WorldError
  err.name = 'WorldError'
  err.code = code
  if (retryAfterSec !== undefined) err.retryAfterSec = retryAfterSec
  return err
}

/**
 * Content equality for the small, flat, JSON-only payloads the host sends.
 *
 * `!==` would compare object IDENTITY, and that is never the right question here:
 * a host's messages arrive through `postMessage` as a fresh structured clone every
 * time, so an identity check reports "changed" on every re-init even when nothing
 * did — and the world repaints, re-animates or re-sounds for nothing.
 *
 * Keys are sorted before serializing so a host that builds the same theme in a
 * different property order still counts as unchanged.
 */
function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const stable = (v: unknown): string =>
    JSON.stringify(v, (_k, val) =>
      val && typeof val === 'object' && !Array.isArray(val)
        ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)))
        : val,
    )
  return stable(a) === stable(b)
}

/** Fan-out helper. A throwing subscriber must never break the others or the host. */
function emit<T>(listeners: Set<(v: T) => void>, value: T): void {
  for (const fn of [...listeners]) {
    try {
      fn(value)
    } catch {
      /* an author callback must not take down the world */
    }
  }
}

/* ─────────────────────────── transport ─────────────────────────── */

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
}

class Transport {
  private seq = 0
  private readonly pending = new Map<number, Pending>()
  private readonly changeListeners = new Map<string, Set<(e: ChangeEvent<never>) => void>>()
  private readonly signalListeners = new Map<string, Set<(e: HostSignal['event']) => void>>()

  readonly onInit: Promise<HostInit>
  private resolveInit!: (init: HostInit) => void

  readonly visitorListeners = new Set<(me: Visitor | null) => void>()
  readonly themeListeners = new Set<(t: WorldTheme) => void>()
  readonly langListeners = new Set<(l: string) => void>()

  /** Mutable env, kept in sync by `env` messages so `ctx.me`/`theme`/`lang` stay live. */
  env = {
    me: null as VisitorInfo | null,
    theme: null as ThemeTokens | null,
    lang: 'en',
  }

  constructor() {
    this.onInit = new Promise<HostInit>((resolve) => {
      this.resolveInit = resolve
    })
    window.addEventListener('message', this.receive)
  }

  /**
   * Only the parent talks to us. We do not check `origin`: the host loads this
   * document via `srcdoc`, which gives it an opaque origin, so the parent's
   * messages arrive as `"null"` and an origin allowlist would reject everything.
   * `e.source === window.parent` is the check that actually holds here — and the
   * parent independently validates every request we send, so a spoofed inbound
   * message can at worst lie to this world about its own state.
   */
  private receive = (e: MessageEvent): void => {
    if (e.source !== window.parent) return
    if (!isHostMessage(e.data)) return
    const msg = e.data as HostMessage

    switch (msg.type) {
      case 'init': {
        // A repeated `init` must behave like an `env` update, not a silent
        // overwrite.
        //
        // `resolveInit` is a one-shot promise, so a second init used to replace
        // `ctx.me` / `ctx.theme` / `ctx.lang` with nobody notified. A host that
        // re-posts init after a language change therefore left the world drawn in
        // the new language while `ctx.lang` had been rewound to the old one — and
        // the next callback that read it rendered one selection behind.
        //
        // Treating a re-init as an environment change makes the world correct
        // whatever the host does.
        // Compared by CONTENT, not identity: see {@link sameContent}. An identity
        // check passes only against a host that hands over the very same object
        // twice, which `postMessage` cannot do — so it announced a theme change on
        // every single re-init. Comparing `me` by `id` alone had the mirror-image
        // problem: a visitor who renamed themselves or changed their avatar was
        // reported as no change at all.
        //
        // What a re-init does NOT refresh: `seed`, `assets` and `capabilities`.
        // All three are bootstrap-only ON PURPOSE. The seed is a one-shot saving
        // of a round trip that `list()` has already superseded; assets are pinned
        // to the build; and `capabilities` is documented as a property of the
        // DEPLOYMENT rather than of the session precisely so `ctx.ai` cannot
        // appear and vanish under a running world (see HostInit). Only the three
        // fields below are live.
        const first = this.env.theme === null
        const changed = {
          theme: !sameContent(this.env.theme, msg.theme),
          lang: this.env.lang !== msg.lang,
          me: !sameContent(this.env.me, msg.me),
        }
        this.env = { me: msg.me, theme: msg.theme, lang: msg.lang }
        this.resolveInit(msg)

        if (!first) {
          if (changed.theme) emit(this.themeListeners, msg.theme)
          if (changed.lang) emit(this.langListeners, msg.lang)
          if (changed.me) emit(this.visitorListeners, msg.me)
        }
        return
      }

      case 'result': {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else {
          const err = msg.error
          p.reject(
            fail(
              (err?.code as WorldErrorCode) ?? 'unavailable',
              err?.message ?? 'request failed',
              err?.retryAfterSec,
            ),
          )
        }
        return
      }

      case 'change': {
        const set = this.changeListeners.get(msg.collection)
        if (!set) return
        const event =
          msg.event.op === 'deleted'
            ? { op: 'deleted' as const, id: msg.event.id }
            : { op: msg.event.op, record: toRec(msg.event.record) }
        emit(set as Set<(e: unknown) => void>, event)
        return
      }

      case 'signal': {
        const set = this.signalListeners.get(msg.channel)
        // A frame for a channel this world is not listening to is dropped in
        // silence. It happens legitimately: `leave()` unsubscribes locally
        // while a frame is already in flight from the host.
        if (!set) return
        emit(set as Set<(e: unknown) => void>, msg.event)
        return
      }

      case 'env':
        // Commit EVERY field before notifying anyone.
        //
        // One `env` message can carry several changes at once, and a world
        // routinely handles them with a single callback registered on more than
        // one of `onThemeChange` / `onLangChange` / `onVisitor` — then reads
        // `ctx.lang` and `ctx.theme` inside it. Interleaving assign-then-emit per
        // field meant the first callback observed a half-applied state: theme
        // already new, `ctx.lang` still the previous language. The world duly
        // rendered in the old language, and the later lang callback could not
        // always undo it.
        //
        // This is why a host that sends fields one at a time (the local preview
        // harness) looked correct while Arena, which sends theme and language
        // together, did not.
        if (msg.theme) this.env.theme = msg.theme
        if (msg.lang !== undefined) this.env.lang = msg.lang
        if (msg.me !== undefined) this.env.me = msg.me

        if (msg.theme) emit(this.themeListeners, msg.theme)
        if (msg.lang !== undefined) emit(this.langListeners, msg.lang)
        if (msg.me !== undefined) emit(this.visitorListeners, msg.me)
        return
    }
  }

  request<T>(op: WorldOp, collection?: string, args?: Record<string, unknown>): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const limit = timeoutFor(op)
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(fail('unavailable', `the host did not answer '${op}' within ${limit}ms`))
      }, limit)

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })

      window.parent.postMessage(
        { [WORLD_CHANNEL]: true, type: 'request', id, op, collection, args },
        '*',
      )
    })
  }

  subscribe(collection: string, cb: (e: ChangeEvent<never>) => void): Unsubscribe {
    let set = this.changeListeners.get(collection)
    if (!set) {
      set = new Set()
      this.changeListeners.set(collection, set)
    }
    set.add(cb)
    return () => set!.delete(cb)
  }

  subscribeSignal(channel: string, cb: (e: HostSignal['event']) => void): Unsubscribe {
    let set = this.signalListeners.get(channel)
    if (!set) {
      set = new Set()
      this.signalListeners.set(channel, set)
    }
    set.add(cb)
    return () => {
      set!.delete(cb)
      // Unlike collections, a channel's listener set is removed when it empties:
      // a world may open a room per match, and a map that only ever grows would
      // keep every code anyone ever typed for the life of the page.
      if (set!.size === 0) this.signalListeners.delete(channel)
    }
  }

  announceReady(): void {
    window.parent.postMessage({ [WORLD_CHANNEL]: true, type: 'ready', sdk: SDK_VERSION }, '*')
  }

  reportFailure(message: string): void {
    window.parent.postMessage({ [WORLD_CHANNEL]: true, type: 'failed', message }, '*')
  }
}

/* ─────────────────────────── shape mapping ─────────────────────────── */

function toRec<T>(r: StoredRecord): Rec<T> {
  return { ...r, payload: r.payload as T }
}

function toPage<T>(p: RecordPage): Page<T> {
  return { items: p.items.map((r) => toRec<T>(r)), cursor: p.cursor, hasMore: p.hasMore }
}

/* ─────────────────────────── collection handle ─────────────────────────── */

function makeCollection<T>(
  name: string,
  transport: Transport,
  seed: RecordPage | undefined,
): Collection<T> {
  // The host pre-fetched the first page into `init`. Hand it to the first
  // `list()` with no cursor so a world can draw without a round trip, then drop
  // it — any later call must see live data, not a stale bootstrap.
  let pristine = seed

  return {
    name,

    async get(id) {
      const r = await transport.request<StoredRecord | null>('get', name, { id })
      return r ? toRec<T>(r) : null
    },

    async list(query) {
      // `limit` belongs in this guard as much as the rest of the query does.
      //
      // The host pre-fetches the seed at ITS OWN page size, so answering
      // `list({ limit: 10 })` from it returned whatever the host had decided —
      // fifty records for a world that asked for ten — without a round trip that
      // could have corrected it. Local preview seeds the same way, so the world
      // was over-served identically in both places and there was nothing to
      // notice.
      if (
        pristine &&
        !query?.cursor &&
        !query?.where &&
        !query?.mine &&
        !query?.sort &&
        (query?.limit === undefined || query.limit >= pristine.items.length)
      ) {
        const page = pristine
        pristine = undefined
        return toPage<T>(page)
      }
      return toPage<T>(await transport.request<RecordPage>('list', name, { ...query }))
    },

    count(query) {
      return transport.request<number>('count', name, { ...query })
    },

    async add(payload) {
      return toRec<T>(await transport.request<StoredRecord>('add', name, { payload }))
    },

    async put(id, payload, opts) {
      return toRec<T>(
        await transport.request<StoredRecord>('put', name, { id, payload, version: opts?.version }),
      )
    },

    async patch(id, partial, opts) {
      return toRec<T>(
        await transport.request<StoredRecord>('patch', name, {
          id,
          partial,
          version: opts?.version,
        }),
      )
    },

    async del(id) {
      await transport.request<void>('del', name, { id })
    },

    onChange(cb) {
      return transport.subscribe(name, cb as (e: ChangeEvent<never>) => void)
    },
  }
}

/* ─────────────────────────── audio ─────────────────────────── */

/**
 * Resolve an `AudioContext` that can actually play.
 *
 * A sandboxed iframe has no inherited user activation, so the context starts
 * suspended and `resume()` is a no-op until a real gesture lands INSIDE this
 * document. We therefore wait for one rather than returning a silent context that
 * looks fine and produces nothing.
 */
function makeAudio(): () => Promise<AudioContext> {
  let promise: Promise<AudioContext> | null = null

  return () => {
    if (promise) return promise

    promise = new Promise<AudioContext>((resolve, reject) => {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) {
        reject(fail('unavailable', 'WebAudio is not available in this browser'))
        return
      }
      const ac = new Ctor()

      const unlock = () => {
        // `.catch` is not politeness. An unhandled rejection here is caught by
        // boot's `unhandledrejection` handler and forwarded to the host as a
        // world FAILURE — so a browser that refuses to resume (or a gesture that
        // does not count as activation) made the host render "this world crashed"
        // when the only thing that actually happened is that there is no sound.
        // Swallow it and wait for the next gesture instead.
        void ac
          .resume()
          .then(() => {
            if (ac.state === 'running') {
              for (const type of GESTURES) window.removeEventListener(type, unlock, true)
              resolve(ac)
            }
          })
          .catch(() => {
            /* not unlocked yet; the next gesture gets another go */
          })
      }

      const GESTURES = ['pointerdown', 'touchend', 'keydown'] as const
      // Already allowed (a gesture happened before the first `audio()` call).
      if (ac.state === 'running') {
        resolve(ac)
        return
      }
      for (const type of GESTURES) window.addEventListener(type, unlock, true)
    })

    return promise
  }
}

/* ─────────────────────────── boot ─────────────────────────── */

/**
 * The model handle, or `null` when the host says this deployment cannot serve
 * one.
 *
 * Built from `init.capabilities` rather than attempted-and-caught: a world that
 * has no model should be able to draw itself differently at mount, not discover
 * it when a visitor presses something.
 */
function makeAi(transport: Transport, available: boolean): WorldAi | null {
  if (!available) return null
  return {
    chat: (request: AiRequest) => transport.request<AiReply>('ai.chat', undefined, { ...request }),
  }
}

/* ─────────────────────────── channel handle ─────────────────────────── */

/**
 * Backoff between reconnect attempts, in ms.
 *
 * A channel dies for two very different reasons and the same schedule has to
 * serve both: a blip that is over before the first retry, and a backend that is
 * down and will stay down for minutes. Growing steps handle the first quickly
 * without a world hammering the second. It stops growing rather than stopping —
 * a match interrupted for five minutes should still reconnect if the visitor
 * left the tab open.
 */
const RECONNECT_MS = [500, 1_000, 2_000, 5_000, 10_000, 20_000] as const

/**
 * One channel handle, with reconnection.
 *
 * The reconnect loop lives here rather than in the host on purpose. The host
 * knows a stream ended; only this side knows whether the WORLD still wants the
 * channel — a world that called `leave()` must not be dragged back into a room
 * it left, and one whose stream died mid-match must not have to write its own
 * retry loop to survive a deploy.
 */
function makeChannel(transport: Transport, name: string, available: boolean): Channel {
  const messageListeners = new Set<(m: ChannelMessage<never>) => void>()
  const presenceListeners = new Set<(peers: Peer[]) => void>()
  const closedListeners = new Set<(reason: 'error' | 'evicted' | 'unavailable') => void>()

  /** What the WORLD wants, as opposed to what the connection is doing. */
  let wanted = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * The transport subscription, established on `join` and dropped on `leave`.
   *
   * It used to be taken once when the handle was built and dropped for good by
   * `leave()` — while `ctx.channel(name)` caches handles forever. So the second
   * match in one room went silently deaf: `join()` resolved, the host really did
   * put the visitor back in, presence came through on the join result, and not
   * one message ever arrived, because the transport no longer routed that name
   * anywhere. Playing again in the same room is the ordinary thing to do with
   * this primitive, and the failure is the worst shape there is — everything
   * reports success.
   *
   * Tying the subscription to what the world WANTS, rather than to when the
   * handle happened to be built, makes the handle reusable. Which it has to be:
   * evicting it from the cache would still leave a stale one in the hands of
   * anyone who kept `const room = ctx.channel(...)` across the two matches.
   */
  let unsubscribe: Unsubscribe | null = null

  const listen = (): void => {
    if (unsubscribe) return
    unsubscribe = transport.subscribeSignal(name, onFrame)
  }

  const onFrame = (event: HostSignal['event']): void => {
    switch (event.op) {
      case 'message':
        // Any frame proves the link is up, so the next outage starts its backoff
        // from the beginning. Presence alone missed a busy room whose roster
        // never changes — it would carry the last outage's delay for the rest of
        // the match.
        attempt = 0
        emit(messageListeners as Set<(m: unknown) => void>, {
          from: event.from,
          data: event.data,
          seq: event.seq,
          at: event.at,
          // Resolved here rather than by the host: `me` changes when someone
          // signs in mid-session, and the frame was addressed to a channel, not
          // to a person.
          mine: transport.env.me?.id === event.from.id,
        })
        return
      case 'presence':
        // A frame arriving proves the connection works, so the next failure
        // starts its backoff from the beginning rather than from wherever the
        // last outage left it.
        attempt = 0
        emit(presenceListeners, event.peers)
        return
      case 'closed':
        emit(closedListeners, event.reason)
        if (wanted) scheduleRetry()
        return
    }
  }

  function scheduleRetry(): void {
    if (retryTimer !== null) return
    const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]!
    attempt++
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!wanted) return
      void transport
        .request<{ peers: Peer[] }>('channel.join', undefined, { name })
        .then(() => {
          attempt = 0
          // No `emit` here. The host writes the roster as the FIRST frame of
          // every stream, including a reconnected one, so `onPresence` fires
          // through the ordinary path — announcing it again from the join result
          // gave subscribers the same roster twice, and only on reconnects,
          // which is exactly the kind of difference between two paths that a
          // world ends up working around.
        })
        .catch(() => {
          // Still down. `closed` was already reported for this outage, so the
          // world is not told again on every attempt — it would turn one
          // disconnection into a stream of identical events.
          if (wanted) scheduleRetry()
        })
    }, delay)
  }

  return {
    name,

    async join(): Promise<Peer[]> {
      if (!available) {
        // Matches `ctx.ai`: a capability the deployment cannot serve fails as a
        // typed, drawable outcome rather than as a request that hangs.
        throw fail('unavailable', 'this deployment does not serve realtime channels')
      }
      wanted = true
      // Before the request, not after: the host writes the roster as the first
      // frame of the stream, and a subscription taken afterwards could miss it.
      listen()
      try {
        const result = await transport.request<{ peers: Peer[] }>('channel.join', undefined, { name })
        attempt = 0
        return result?.peers ?? []
      } catch (err) {
        // A refusal is final — an undeclared namespace or a signed-out visitor
        // will not fix itself — so this does NOT start the retry loop. Only a
        // stream that opened and then died does.
        wanted = false
        unsubscribe?.()
        unsubscribe = null
        throw err
      }
    },

    send<T = Json>(data: T): Promise<void> {
      // Same reasoning as `join`: a capability this deployment cannot serve
      // should fail as something a world can draw, not as a request the host
      // will refuse a moment later for a reason it has to translate.
      if (!available) {
        return Promise.reject(fail('unavailable', 'this deployment does not serve realtime channels'))
      }
      return transport.request<void>('channel.send', undefined, { name, data })
    },

    onMessage<T = Json>(cb: (m: ChannelMessage<T>) => void): Unsubscribe {
      const fn = cb as (m: ChannelMessage<never>) => void
      messageListeners.add(fn)
      return () => messageListeners.delete(fn)
    },

    onPresence(cb): Unsubscribe {
      presenceListeners.add(cb)
      return () => presenceListeners.delete(cb)
    },

    onClosed(cb): Unsubscribe {
      closedListeners.add(cb)
      return () => closedListeners.delete(cb)
    },

    async leave(): Promise<void> {
      wanted = false
      attempt = 0
      if (retryTimer !== null) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      unsubscribe?.()
      unsubscribe = null
      /**
       * The author's callbacks are NOT cleared.
       *
       * They belong to whoever registered them, and this handle is reusable —
       * clearing them would mean `onMessage(fn); await leave(); await join()`
       * quietly stopped calling `fn`, which is the same silent deafness that
       * dropping the subscription used to cause, just by another route. Nothing
       * reaches them while the channel is left, because the subscription above
       * is gone.
       */
      if (!available) return
      await transport.request<void>('channel.leave', undefined, { name })
    },
  }
}

function makeLocal(transport: Transport): LocalStore {
  return {
    get: <T = Json>(key: string) => transport.request<T | null>('local.get', undefined, { key }),
    set: <T = Json>(key: string, value: T) =>
      transport.request<void>('local.set', undefined, { key, value }),
    del: (key: string) => transport.request<void>('local.del', undefined, { key }),
  }
}

/**
 * Announce readiness, wait for the host's `init`, build `ctx`, then `mount`.
 * Called once per document by `defineWorld`.
 */
export async function boot(def: WorldDefinition): Promise<void> {
  const transport = new Transport()

  // Report uncaught errors, not just a rejected `mount`.
  //
  // A world runs in an opaque-origin iframe, so its console is effectively
  // invisible: a handler that throws leaves a UI that simply stops responding,
  // with nothing for the author or the host to go on. Forwarding these is the
  // difference between "the button does nothing" and a message naming the line.
  window.addEventListener('error', (e) => {
    transport.reportFailure(`${e.message} (${e.filename ?? '?'}:${e.lineno ?? 0})`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason as { message?: string } | undefined
    transport.reportFailure(`unhandled rejection: ${reason?.message ?? String(reason)}`)
  })

  transport.announceReady()

  const init = await transport.onInit

  if (init.world.type !== def.meta.type) {
    // A mismatch means the host loaded the wrong bundle for this slug; failing
    // loudly beats rendering someone else's world against this one's data.
    transport.reportFailure(
      `world type mismatch: host says '${init.world.type}', bundle declares '${def.meta.type}'`,
    )
    return
  }

  const collections = new Map<string, Collection<never>>()
  const declared = new Set(Object.keys(init.seed))
  const audio = makeAudio()
  const local = makeLocal(transport)
  const ai = makeAi(transport, init.capabilities?.ai === true)
  const channels = new Map<string, Channel>()
  const realtimeAvailable = init.capabilities?.realtime === true

  const ctx: WorldCtx = {
    get me() {
      return transport.env.me
    },
    onVisitor(cb) {
      transport.visitorListeners.add(cb)
      return () => transport.visitorListeners.delete(cb)
    },

    world: init.world,

    collection<T>(name: string): Collection<T> {
      const existing = collections.get(name)
      if (existing) return existing as unknown as Collection<T>
      if (!declared.has(name)) {
        // Collections are part of the reviewed manifest, so an unknown name is an
        // author bug, not a runtime condition worth a rejected promise later.
        throw fail(
          'not-found',
          `collection '${name}' is not declared in world.manifest.json (declared: ${[...declared].join(', ') || 'none'})`,
        )
      }
      const made = makeCollection<T>(name, transport, init.seed[name])
      collections.set(name, made as unknown as Collection<never>)
      return made
    },

    local,

    ai,

    /**
     * One handle per channel name, cached.
     *
     * Two calls with the same name MUST give the same object, or a world that
     * asks for its room in two places gets two handles, two listener sets and
     * two independent reconnect loops racing to rejoin the same room.
     *
     * The name is normalised the way the platform normalises it, so
     * `versus/AB` and `versus/ab` are one cache entry rather than two handles
     * onto one room.
     */
    channel(name: string): Channel {
      const key = name.trim().toLowerCase()
      const existing = channels.get(key)
      if (existing) return existing
      // Shape only. WHICH namespaces are allowed is the manifest's business and
      // the host's to enforce — checking it here would need the manifest inside
      // the sandbox, and would be a second copy of the rule to drift.
      if (!/^[a-z][a-z0-9_-]{0,31}\/[a-z0-9_-]{1,64}$/.test(key)) {
        throw fail('invalid', `channel '${name}' must be '<namespace>/<room>'`)
      }
      const made = makeChannel(transport, key, realtimeAvailable)
      channels.set(key, made)
      return made
    },

    asset(path) {
      const key = path.replace(/^\.?\/+/, '')
      const uri = init.assets[key] ?? init.assets[`assets/${key}`]
      if (!uri) {
        // Assets are inlined at build time from the world's own directory, so a
        // miss is always a wrong path rather than a load failure worth retrying.
        throw fail('not-found', `asset '${path}' was not published with this world`)
      }
      return uri
    },

    audio,

    get theme() {
      return transport.env.theme as WorldTheme
    },
    onThemeChange(cb) {
      transport.themeListeners.add(cb)
      return () => transport.themeListeners.delete(cb)
    },

    get lang() {
      return transport.env.lang
    },
    onLangChange(cb) {
      transport.langListeners.add(cb)
      return () => transport.langListeners.delete(cb)
    },
  }

  /**
   * Run the author's teardown when the document goes away.
   *
   * The browser destroys this document's timers, audio and observers when the
   * host removes the iframe, so this is not what stops a leak — it is the hook
   * the contract promises an author, for the things only they know about
   * (flushing a draft, stopping a sound cleanly). It has never fired until now,
   * which is precisely the kind of quiet nothing worth removing.
   *
   * `pagehide` rather than `unload`: it fires for frame removal and navigation,
   * and does not disqualify the page from the back/forward cache.
   */
  if (def.unmount) {
    let done = false
    window.addEventListener('pagehide', () => {
      if (done) return
      done = true
      try {
        def.unmount!()
      } catch {
        /* a teardown error must not be the last thing that happens */
      }
    })
  }

  try {
    await def.mount(document.body, ctx)
  } catch (err) {
    // Without this the host sees a blank iframe and cannot tell a crash from a
    // world that legitimately draws nothing.
    transport.reportFailure((err as Error)?.message ?? String(err))
  }
}
