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
  type RecordPage,
  type StoredRecord,
  type ThemeTokens,
  type VisitorInfo,
  type WorldOp,
} from './protocol.js'
import type {
  ChangeEvent,
  Collection,
  Json,
  LocalStore,
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

function fail(code: WorldErrorCode, message: string, retryAfterSec?: number): WorldError {
  const err = new Error(message) as WorldError
  err.name = 'WorldError'
  err.code = code
  if (retryAfterSec !== undefined) err.retryAfterSec = retryAfterSec
  return err
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
      case 'init':
        this.env = { me: msg.me, theme: msg.theme, lang: msg.lang }
        this.resolveInit(msg)
        return

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
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
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
      if (pristine && !query?.cursor && !query?.where && !query?.mine && !query?.sort) {
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
        void ac.resume().then(() => {
          if (ac.state === 'running') {
            for (const type of GESTURES) window.removeEventListener(type, unlock, true)
            resolve(ac)
          }
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
