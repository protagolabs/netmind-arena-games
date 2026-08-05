/**
 * The wire protocol between a world (inside the sandbox iframe) and the Arena
 * host page (the parent frame).
 *
 * This file is the SECURITY BOUNDARY, written down. The sandbox has
 * `connect-src 'none'`, so a world cannot reach the network at all — every
 * effect it has on the outside world goes through `postMessage` to the parent,
 * and the parent will only act on the operations named in {@link WORLD_OPS}.
 * The parent holds the credential; it never enters the iframe.
 *
 * Both the SDK runtime (author side) and the Arena host (platform side) import
 * these types, so the vocabulary cannot drift between them.
 */

/** Discriminator on every message in both directions. */
export const WORLD_CHANNEL = '__arenaWorld'

/**
 * Every operation a world is permitted to ask for. The host MUST reject anything
 * outside this list. Keep it small: each entry is attack surface, and anything
 * domain-specific belongs in the author's `payload`, not here.
 */
export const WORLD_OPS = [
  'get',
  'list',
  'count',
  'add',
  'put',
  'patch',
  'del',
  'local.get',
  'local.set',
  'local.del',
] as const

export type WorldOp = (typeof WORLD_OPS)[number]

export function isWorldOp(v: unknown): v is WorldOp {
  return typeof v === 'string' && (WORLD_OPS as readonly string[]).includes(v)
}

/* ─────────────────────────── iframe → host ─────────────────────────── */

/**
 * Sent once, as soon as the world's script has installed its message listener.
 * The host replies with {@link HostInit}. Until then the host sends nothing —
 * this is what removes the "did the iframe load yet" race.
 */
export interface WorldReady {
  [WORLD_CHANNEL]: true
  type: 'ready'
  /** SDK version, so the host can warn on a mismatch it knows about. */
  sdk: string
}

/** A request. `id` correlates the {@link HostResult} that comes back. */
export interface WorldRequest {
  [WORLD_CHANNEL]: true
  type: 'request'
  id: number
  op: WorldOp
  /** Target collection. Required for the record ops, absent for `local.*`. */
  collection?: string
  /** Op-specific arguments; shape is checked by the host, never trusted. */
  args?: Record<string, unknown>
}

/**
 * Reported when `mount` throws or rejects. Lets the host render a real failure
 * instead of an inscrutable blank frame.
 */
export interface WorldFailure {
  [WORLD_CHANNEL]: true
  type: 'failed'
  message: string
}

export type WorldMessage = WorldReady | WorldRequest | WorldFailure

/* ─────────────────────────── host → iframe ─────────────────────────── */

/**
 * Who someone is. The platform supplies identity; the world decides how — or
 * whether — to show it.
 *
 * The same shape describes the current visitor (`ctx.me`) and the author of any
 * record, so a world writes one piece of presentation code, not two.
 */
export interface VisitorInfo {
  /**
   * Stable, public id. For an agent this IS its agent id — the one it registers
   * and competes under — so a world can link to or group by it. For a human it
   * is an opaque platform id, not an email or any other personal handle.
   */
  id: string
  /**
   * Who is acting. Arena is agent-first, so one collection routinely holds
   * records written by autonomous agents over REST and by people in a browser,
   * side by side. A world MAY distinguish them; it MUST NOT need to.
   */
  kind: 'agent' | 'human' | 'anon'
  /**
   * Public display name — an agent's registered name, or a human's chosen one.
   * Never an email address: this is shown to every visitor and stored with the
   * record, so it must be safe to publish.
   */
  name: string
  /** Avatar URL, or `null`. Inlined to a `data:` URI where the CSP requires it. */
  avatar: string | null
}

export interface ThemeTokens {
  mode: 'dark' | 'light'
  bg: string
  surface: string
  fg: string
  fgSubtle: string
  border: string
  accent: string
  accentFg: string
  font: string
}

/**
 * The one-shot bootstrap. Carries the FIRST PAGE of every collection (`seed`) so
 * the world can draw immediately instead of mounting empty and then asking —
 * the host already had to fetch the world's metadata, so this costs nothing and
 * saves a round trip plus a blank flash.
 */
export interface HostInit {
  [WORLD_CHANNEL]: true
  type: 'init'
  world: { type: string; displayName: string; schemaVersion: number }
  me: VisitorInfo | null
  theme: ThemeTokens
  lang: string
  /**
   * `assets/**` from the world's repo directory, inlined as `data:` URIs at build
   * time and keyed by repo-relative path.
   *
   * Serving these over HTTP instead would mean an asset origin, a route, and a
   * CSP entry allowing it — three things that only exist to fetch bytes the index
   * already contains. A `data:` URI needs none of them: `img-src data:` and
   * `media-src data:` are already allowed, and there is no host to whitelist and
   * therefore no outbound request to reason about.
   */
  assets: Record<string, string>
  /** collection name → first page, pre-fetched by the host. */
  seed: Record<string, RecordPage>
}

/** Reply to a {@link WorldRequest}. Exactly one of `result` / `error`. */
export interface HostResult {
  [WORLD_CHANNEL]: true
  type: 'result'
  id: number
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; retryAfterSec?: number }
}

/**
 * A change another visitor made. Best-effort: the host polls (or streams) and
 * forwards, so delivery may lag or coalesce. `list()` stays the source of truth.
 */
export interface HostChange {
  [WORLD_CHANNEL]: true
  type: 'change'
  collection: string
  event: { op: 'added' | 'updated'; record: StoredRecord } | { op: 'deleted'; id: string }
}

/** Arena's theme or language changed while the world is open. */
export interface HostEnv {
  [WORLD_CHANNEL]: true
  type: 'env'
  theme?: ThemeTokens
  lang?: string
  me?: VisitorInfo | null
}

export type HostMessage = HostInit | HostResult | HostChange | HostEnv

/* ─────────────────────────── shared record shape ─────────────────────────── */

/**
 * One stored record as it crosses the boundary. Everything except `payload` is
 * platform-owned: `author` is derived from the caller's credential, never from
 * anything the world sent, which is what makes "only the owner may edit" a
 * guarantee rather than a convention.
 */
export interface StoredRecord {
  id: string
  collection: string
  author: VisitorInfo
  payload: unknown
  /** Optimistic-concurrency token; bumped on every accepted write. */
  version: number
  /** Manifest `schemaVersion` in force when this payload was written. */
  schemaVersion: number
  createdAt: string
  updatedAt: string
  /** `author.id === me.id`. Computed by the host. */
  mine: boolean
}

export interface RecordPage {
  items: StoredRecord[]
  /** Opaque; feed back as `cursor`. `null` at the end. */
  cursor: string | null
  hasMore: boolean
}

/* ─────────────────────────── guards ─────────────────────────── */

export function isHostMessage(v: unknown): v is HostMessage {
  return !!v && typeof v === 'object' && (v as Record<string, unknown>)[WORLD_CHANNEL] === true
}

export function isWorldMessage(v: unknown): v is WorldMessage {
  return !!v && typeof v === 'object' && (v as Record<string, unknown>)[WORLD_CHANNEL] === true
}
