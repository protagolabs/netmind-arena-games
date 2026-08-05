/**
 * @arena/world-sdk — public contract for authoring Arena **worlds**.
 *
 * A world is the second kind of artifact this repo publishes, beside `games/`.
 * The difference is not size or ambition, it is MONEY:
 *
 *   games/   emit a `score` → rank → credits. Author logic must therefore be
 *            deterministic and run in a backend `isolated-vm`, because a cheat is
 *            worth real money.
 *   worlds/  emit nothing scored. No prize, no ledger, no ranking. With nothing
 *            to cheat FOR, the whole authoritative-simulation apparatus is
 *            unnecessary — a world is author code running in the same locked-down
 *            sandbox iframe a game's T2 view already uses.
 *
 * So a world has NO backend logic layer. There is one entry, it runs in the
 * iframe, and every capability it needs is injected as {@link WorldCtx}. The
 * author never sees a credential, never calls `fetch` (the sandbox CSP sets
 * `connect-src 'none'`), and never touches storage directly — `ctx` proxies
 * through the host page, which owns auth, validation, quota and moderation.
 *
 * ## Persistence is a CONTAINER, not a domain model
 *
 * The platform provides collections of records with generic CRUD and knows
 * nothing about what a record MEANS. `payload` is author-shaped JSON, validated
 * only against the JSON Schema declared in `world.manifest.json`.
 *
 * This is the same split as games (author emits `score` numbers, platform owns
 * payout), and it has a consequence worth internalising: **domain features are
 * not platform features.** "Other visitors can light up my planet" is not a
 * `reactions` API — it is a second collection whose records happen to hold a
 * target id:
 *
 * ```ts
 * const planets = ctx.collection<Planet>('planets')  // write: 'owner'
 * const lamps   = ctx.collection<Lamp>('lamps')      // { target: string }
 *
 * await planets.add({ strokes, x: 120, y: -40 })
 * await lamps.add({ target: somePlanetId })          // unique per (author, target)
 * ```
 *
 * The platform only owns what cannot be delegated safely: identity, ownership,
 * schema validation, size caps, uniqueness, quota, rate limits, pagination,
 * moderation state, and concurrency versions.
 *
 * ```ts
 * import { defineWorld } from '@arena/world-sdk'
 *
 * export default defineWorld({
 *   meta: { type: 'celestial-atlas' },
 *   async mount(root, ctx) {
 *     const planets = ctx.collection<Planet>('planets')
 *     const { items } = await planets.list({ limit: 50, sort: ['-createdAt'] })
 *     items.forEach(draw)
 *     planets.onChange((e) => { if (e.op === 'added') draw(e.record) })
 *   },
 * })
 * ```
 */

import type { ThemeTokens, VisitorInfo } from './protocol.js'

export type { ThemeTokens, VisitorInfo } from './protocol.js'

/** JSON the platform will store verbatim. Must survive `JSON.stringify`. */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

/**
 * Who is looking, and who wrote any given record — the same shape for both.
 *
 * Supplied by the platform; a world never authenticates anyone and never sees a
 * credential. What it gets is enough to decide presentation for itself:
 *
 * ```ts
 * const label = (v: Visitor) =>
 *   v.kind === 'agent' ? `${v.name} · agent ${v.id}` : v.name
 * ```
 *
 * The platform deliberately does not decide that for you — one world wants a
 * byline, another wants an avatar and nothing else, a third wants to show
 * nothing at all and let the work speak.
 */
export type Visitor = VisitorInfo

/** Design tokens pushed in by the platform so a world can follow light/dark. */
export type WorldTheme = ThemeTokens

/**
 * One stored item. Everything outside `payload` is platform-owned and unwritable
 * by author code — that is what makes ownership and moderation credible.
 */
export interface Rec<T = Json> {
  id: string
  collection: string
  /** Trustworthy: derived from the caller's credential, not from request input. */
  author: Visitor
  /** Author-shaped, validated against the collection's declared schema. */
  payload: T
  /**
   * Optimistic-concurrency token, bumped on every accepted write. Pass it back to
   * `put`/`patch` to make a write conditional; a stale token fails `conflict`
   * instead of silently clobbering whoever got there first.
   */
  version: number
  /**
   * Which manifest `schemaVersion` this payload was written under. A world is
   * PERPETUAL — unlike a game match it accumulates data across code releases, so
   * a renderer must expect payloads older than itself. See
   * {@link WorldManifest.supportedSchemaVersions}.
   */
  schemaVersion: number
  createdAt: string
  updatedAt: string
  /** `author.id === ctx.me?.id`. */
  mine: boolean
}

/* ────────────────────────────── queries ────────────────────────────── */

/** Comparison on a single indexed field. Exactly one key. */
export type Filter =
  | { eq: Json }
  | { ne: Json }
  | { gt: number | string }
  | { gte: number | string }
  | { lt: number | string }
  | { lte: number | string }
  | { in: Json[] }

export interface Query {
  /** Opaque cursor from a previous {@link Page}. Omit for the first page. */
  cursor?: string
  /** Default 50, capped by the platform. */
  limit?: number
  /**
   * Filter by field path. Only paths declared in the manifest's `indexes` are
   * filterable — `payload` is opaque storage, so anything queryable must be
   * declared up front and promoted to an indexed column. `createdAt` and
   * `updatedAt` are always available.
   */
  where?: Record<string, Filter>
  /** Declared index paths, `createdAt` or `updatedAt`; `-` prefix = descending. */
  sort?: string[]
  /** Restrict to the current visitor's own records. */
  mine?: boolean
}

export interface Page<T = Json> {
  items: Rec<T>[]
  /** Feed to the next `list()`. `null` when the end is reached. */
  cursor: string | null
  hasMore: boolean
}

/* ────────────────────────────── collections ────────────────────────────── */

export type Unsubscribe = () => void

export type ChangeEvent<T = Json> =
  | { op: 'added'; record: Rec<T> }
  | { op: 'updated'; record: Rec<T> }
  | { op: 'deleted'; id: string }

/**
 * A container of records: six primitives and a subscription. Nothing
 * domain-specific, by design.
 *
 * Every method rejects with a {@link WorldError}. Authors SHOULD handle at least
 * `conflict` (someone wrote first), `quota` and `rate-limited` — in a shared
 * world those are normal outcomes, not bugs.
 */
export interface Collection<T = Json> {
  readonly name: string

  /** Read one. `null` when absent, deleted, or hidden by moderation. */
  get(id: string): Promise<Rec<T> | null>

  /** Read a page. A boundless world never fits in one response — always paginate. */
  list(query?: Query): Promise<Page<T>>

  /** Count matching records. Ignores `cursor` / `limit` / `sort`. */
  count(query?: Pick<Query, 'where' | 'mine'>): Promise<number>

  /** Create. The platform assigns `id`, `author`, `version` and timestamps. */
  add(payload: T): Promise<Rec<T>>

  /** Replace the whole payload. Pass `version` to make it conditional. */
  put(id: string, payload: T, opts?: { version?: number }): Promise<Rec<T>>

  /** Shallow-merge into the existing payload. Pass `version` to make it conditional. */
  patch(id: string, partial: Partial<T>, opts?: { version?: number }): Promise<Rec<T>>

  /** Delete. Allowed on your own records; `forbidden` otherwise. */
  del(id: string): Promise<void>

  /**
   * Subscribe to other visitors' changes. Best-effort and possibly delayed or
   * coalesced: the sandbox has `connect-src 'none'`, so this rides on the host
   * page's polling/stream rather than a socket the world opens. Treat it as
   * "eventually you will see it" and keep `list()` as the source of truth.
   */
  onChange(cb: (event: ChangeEvent<T>) => void): Unsubscribe
}

/* ────────────────────────────── errors ────────────────────────────── */

export type WorldErrorCode =
  /** Anonymous visitor, and this collection requires an identity to write. */
  | 'unauthenticated'
  /** Write policy denies it (not the owner, or the collection is append-only). */
  | 'forbidden'
  | 'not-found'
  /** `version` was stale — re-read and retry. */
  | 'conflict'
  /** Payload failed the collection's declared JSON Schema. */
  | 'invalid'
  /** Payload exceeded `maxRecordBytes`. */
  | 'too-large'
  /** `maxRecordsPerAuthor` or the world's total-record quota is exhausted. */
  | 'quota'
  /** Slow down; see `retryAfterSec`. */
  | 'rate-limited'
  /** Violates a declared `unique` constraint. */
  | 'unique'
  /** Hidden by moderation. */
  | 'moderated'
  /** Transport or platform failure. Retryable. */
  | 'unavailable'

export interface WorldError extends Error {
  code: WorldErrorCode
  retryAfterSec?: number
}

/* ────────────────────────────── other capabilities ────────────────────────────── */

/**
 * Per-visitor PRIVATE key/value — a language choice, a dismissed hint. Not
 * shared, not listable, not part of the world's content.
 *
 * This is a platform primitive because `localStorage` is unusable here: the view
 * runs in an `iframe sandbox` WITHOUT `allow-same-origin`, so its origin is
 * opaque and storage access throws or is discarded. Routing through the platform
 * also lets the value follow a signed-in visitor across devices.
 */
export interface LocalStore {
  get<T = Json>(key: string): Promise<T | null>
  set<T = Json>(key: string, value: T): Promise<void>
  del(key: string): Promise<void>
}

/**
 * Everything a world can do. Injected — mirroring the games SDK's `ctx`, where
 * the only route to the outside is a capability the platform handed you.
 */
export interface WorldCtx {
  /** The current visitor, or `null` when anonymous. */
  readonly me: Visitor | null
  /** Fires when identity resolves or changes (e.g. sign-in mid-session). */
  onVisitor(cb: (me: Visitor | null) => void): Unsubscribe

  readonly world: {
    type: string
    displayName: string
    /** The manifest `schemaVersion` this build writes. */
    schemaVersion: number
  }

  /**
   * Handle for a collection declared in `world.manifest.json`. An undeclared name
   * throws immediately — collections are part of the reviewed contract, not
   * created at runtime.
   */
  collection<T = Json>(name: string): Collection<T>

  readonly local: LocalStore

  /**
   * Resolve a path under the world's `assets/` directory to a usable URL.
   *
   * Files there are inlined as `data:` URIs at build time, so this is a lookup,
   * not a fetch — which is why real images and audio work inside a sandbox whose
   * `connect-src` is `'none'`. Throws for a path that was not published.
   */
  asset(path: string): string

  /**
   * An `AudioContext` that is actually allowed to make sound.
   *
   * Browsers start it suspended until a genuine user gesture, and a sandboxed
   * iframe cannot borrow the parent's activation. This resolves after the first
   * real gesture inside the world, so a world MUST render its own "enable sound"
   * affordance and MUST stay usable if the visitor never touches it.
   *
   * Synthesis (`OscillatorNode`, or `atob` + `decodeAudioData` over inlined
   * bytes) needs no network and always works. `<audio>` and fetched samples need
   * the asset origin — go through {@link WorldCtx.asset}.
   */
  audio(): Promise<AudioContext>

  readonly theme: WorldTheme
  onThemeChange(cb: (theme: WorldTheme) => void): Unsubscribe

  /** Arena's active UI language, e.g. `'zh'` | `'en'`. */
  readonly lang: string
  onLangChange(cb: (lang: string) => void): Unsubscribe
}

/* ────────────────────────────── definition ────────────────────────────── */

export interface WorldMeta {
  /** Must equal `world.manifest.json`'s `type`. Kebab-case. */
  type: string
}

export interface WorldDefinition {
  meta: WorldMeta
  /**
   * Build the world into `root`. Called once, after identity, theme, language and
   * the first page of every collection are known. May be async; a rejection is
   * reported to the host and shown as a load failure rather than a blank frame.
   */
  mount(root: HTMLElement, ctx: WorldCtx): void | Promise<void>
  /**
   * Optional teardown, run when the document goes away.
   *
   * Not required for ordinary cleanup: the browser destroys this document's
   * timers, audio and observers when the host removes the frame. Use it for what
   * only you know about — flushing an unsaved draft, fading a sound out rather
   * than cutting it. Keep it synchronous and short; nothing awaits it.
   */
  unmount?(): void
}

/* ────────────────────────────── manifest ────────────────────────────── */

/** A JSON Schema (draft 2020-12) object. Deliberately not modelled further. */
export type JsonSchema = Record<string, unknown>

/**
 * One container's rules. Every field here is enforced by the PLATFORM — an author
 * cannot raise a cap by editing their own code, only by changing this file and
 * passing review.
 */
export interface CollectionSpec {
  /** Shape of `payload`. Records failing it are rejected with `invalid`. */
  schema: JsonSchema

  /**
   * Who may modify an existing record.
   *   `owner`  — only its author (the normal case)
   *   `anyone` — any identified visitor; only for genuinely shared documents, and
   *              expect `conflict` to be routine
   *   `none`   — append-only; `put` / `patch` always fail
   */
  write: 'owner' | 'anyone' | 'none'

  /** `public` (default) or `owner`-only reads, for private drafts. */
  read?: 'public' | 'owner'

  /** May an anonymous visitor create records here? Default `false`. */
  anonymousCanWrite?: boolean

  /** Serialized-payload cap. Required — an uncapped write endpoint is free storage. */
  maxRecordBytes: number

  /** Per-author cap. Omit only when the world is genuinely unbounded per person. */
  maxRecordsPerAuthor?: number

  /**
   * Payload paths promoted to indexed columns so they can appear in `where` and
   * `sort`. Undeclared paths are NOT queryable — `payload` is opaque storage.
   *
   * Order is significant: the platform copies these values, in order, into a
   * fixed set of pre-indexed slots (`idx_a`, `idx_b`, …). That is what lets ONE
   * set of indexes, created once, serve every world — publishing a world never
   * requires a database migration.
   *
   * Example: `['payload.x', 'payload.y']`.
   */
  indexes?: string[]

  /**
   * Uniqueness constraints, each a tuple of paths that must be collectively
   * unique. `[['author.id', 'payload.target']]` expresses "one lamp per visitor
   * per planet" without the platform knowing what a lamp is. Every `payload.*`
   * path used here must also appear in `indexes`.
   */
  unique?: string[][]
}

export interface WorldQuota {
  /** Hard ceiling on live records across the whole world. */
  totalRecords?: number
  writesPerHourPerAuthor?: number
}

export interface WorldPresentation {
  /**
   * `fullscreen` gets its own `/worlds/<type>` route — required for immersive,
   * pan/drag or `touch-action: none` experiences, which fight the page's own
   * scrolling when boxed into a card. `embed` may be rendered inline at `aspect`.
   */
  surface: 'fullscreen' | 'embed'
  /** In-repo cover image for the home-page card. Hash-pinned like everything else. */
  cover: string
  /** Only meaningful for `embed`, e.g. `'16:9'`. */
  aspect?: string
  /** Declares that this world makes sound, so the platform can label it. */
  audio?: boolean
}

export interface WorldManifest {
  type: string
  kind: 'world'
  displayName: string
  sdkVersion?: string
  /** Entry with `export default defineWorld(...)`. */
  entry: string

  /**
   * Version this build WRITES into new records. Bump whenever the payload shape
   * changes incompatibly.
   */
  schemaVersion: number
  /**
   * Every version this build can still RENDER, including `schemaVersion`. A world
   * outlives its own releases: data written months ago must keep drawing, so CI
   * rejects a release that drops support for a version already in the store.
   */
  supportedSchemaVersions: number[]

  /** Omit entirely for a read-only world — then there is nothing to store. */
  storage?: {
    collections: Record<string, CollectionSpec>
    quota?: WorldQuota
  }

  presentation: WorldPresentation
  /** Path to a markdown intro, published alongside the world. */
  about?: string
}
