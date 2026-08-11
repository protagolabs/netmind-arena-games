/**
 * The three globals `tools/extract.mjs` rewrites the vendored build to call.
 *
 * The port keeps every call site the deployed page has and changes only what is
 * on the other end of them. That is deliberate: excising the network code would
 * also excise the pending bubbles, the retry loop, the 402/429 branches and the
 * heartbeat's own kill switch, and each of those would then have to be
 * reimplemented to make the page behave. Answering in-frame keeps the page's
 * logic intact and puts the whole substitution in one file.
 *
 *   arenaFetch — a router over the site's own /api surface
 *   arenaLS    — the persistent key/value the page expects, on ctx.local
 *   arenaSS    — its per-session sibling, in memory
 *
 * Both storage globals exist because an Arena world runs in an iframe sandboxed
 * WITHOUT allow-same-origin. Its origin is opaque, and the Web Storage APIs
 * throw there rather than returning null — so a single untouched call would take
 * the whole page down at boot.
 */
/** What the page reads back. `Response` needs no network to construct. */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export interface ShimOptions {
  /** Hydrated snapshot of the persistent store, and a sink for changes. */
  persisted: Record<string, string>
  save: (all: Record<string, string>) => void
  /**
   * Ask the platform's model, or `null` when there is none to ask.
   *
   * Kept as a narrow callback rather than the whole `ctx`: this file's job is to
   * answer the page's own `/api` surface, and handing it the platform context
   * would invite the rest of the port to reach through it.
   */
  chat: ((body: ChatRequest) => Promise<ChatResponse>) | null
}

/** What the page posts to `/api/chat` (built by `Kn()` + its own message log). */
export interface ChatRequest {
  messages: unknown[]
  context: unknown
}

/** What it expects back: Anthropic content blocks, which it walks looking for `tool_use`. */
export interface ChatResponse {
  content: unknown[]
  stop_reason: string | null
}

/* ────────────────────────────── storage ────────────────────────────── */

/**
 * A `Storage`-shaped object over a plain map.
 *
 * The page reads these synchronously during boot, so an async platform call
 * cannot sit behind `getItem`. The persistent one is therefore hydrated ONCE
 * before the vendored code runs and written back whole on every change —
 * the page stores a handful of short preferences (language, theme, seed), so
 * rewriting the whole map is cheaper than tracking dirty keys.
 */
function makeStore(initial: Record<string, string>, onChange?: (all: Record<string, string>) => void) {
  const map = new Map<string, string>(Object.entries(initial))
  const flush = (): void => onChange?.(Object.fromEntries(map))
  return {
    getItem: (k: string): string | null => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string): void => {
      map.set(k, String(v))
      flush()
    },
    removeItem: (k: string): void => {
      map.delete(k)
      flush()
    },
    clear: (): void => {
      map.clear()
      flush()
    },
    key: (i: number): string | null => [...map.keys()][i] ?? null,
    get length(): number {
      return map.size
    },
  }
}

/* ────────────────────────────── router ────────────────────────────── */

/**
 * Exported for `test/shim.test.ts`.
 *
 * Every answer here is load-bearing on a branch inside minified vendor code that
 * no type checker sees: 429 selects the local-parse fallback, `gated: false`
 * keeps the invite gate shut, `ok: false` stops the heartbeat. Get one wrong and
 * the world still builds, still passes validate, and misbehaves only once
 * someone opens it.
 */
export async function route(
  url: string,
  init?: RequestInit,
  chat?: ShimOptions['chat'],
): Promise<Response> {
  const path = url.split('?')[0]

  switch (path) {
    /**
     * The invite gate. `gated: false` opens the world to everyone, because the
     * funnel behind it — redeem a code, or leave an email — belongs to
     * predictmy.ai and not to a page embedded in Arena.
     */
    case '/api/session':
      return json({ gated: false })

    /**
     * The 60-second visitor heartbeat. `ok: false` is the page's OWN stop
     * signal: it clears the interval and never asks again. Using it beats
     * deleting the call, since the telemetry ends up off either way and this
     * way the code that turns it off is the code that shipped.
     */
    case '/api/ping':
      return json({ ok: false })

    /** Nothing is gated, so a code is unnecessary rather than wrong. */
    case '/api/join':
      return json({ ok: true })

    /** No waitlist here; accepting silently beats an error the visitor caused. */
    case '/api/request-invite':
      return json({ ok: true })

    /**
     * The assistant coach.
     *
     * The sandbox has `connect-src 'none'`, so the site's own server-side model
     * is out of reach — but the platform offers one through `ctx.ai`, billed to
     * the signed-in visitor's own account. `src/world.ts` wires it here.
     *
     * ## 429 is still the answer to everything that goes wrong
     *
     * No model configured, nobody signed in, the visitor declined, the rate
     * limit tripped, the request failed: all of it comes back as 429, because
     * the page already knows what to do with that. Its rate-limit branch calls
     * the bilingual rule parser it ships with (`Dt` in the redeem chunk —
     * marking, feeding, runs, zones, channels and every policy tendency, in nine
     * languages) and applies the result exactly as it applies the model's.
     *
     * That is worth being deliberate about. The fallback is not a degraded mode
     * bolted on here; it is the path the source itself wrote for an hour when
     * its model was busy, and it moves the same numbers through the same code.
     * A visitor who never signs in still has a working coach.
     *
     * The body must not carry `needCode`: that flag routes to the invite gate
     * instead, and nothing here is gated.
     */
    case '/api/chat': {
      if (!chat) return json({ error: 'offline' }, 429)
      try {
        const body = JSON.parse(String(init?.body ?? '{}')) as ChatRequest
        return json(await chat(body))
      } catch {
        // Deliberately opaque: whatever the reason — declined, signed out, rate
        // limited, malformed — the useful response is the one the page can act
        // on, and it has exactly one branch for "no model right now".
        return json({ error: 'offline' }, 429)
      }
    }

    /**
     * Everything else is Vite's modulepreload helper reaching for a chunk. esbuild
     * has already inlined every one of them into this document, so there is
     * nothing to fetch and nothing to report.
     */
    default:
      return json({}, 200)
  }
}

/* ────────────────────────────── install ────────────────────────────── */

declare global {
  // eslint-disable-next-line no-var
  var arenaFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  // eslint-disable-next-line no-var
  var arenaLS: ReturnType<typeof makeStore>
  /**
   * The source's own apply-language function, published by `vendor/main.js` at
   * the point it already calls it itself. The page reads its stored language
   * once at boot and otherwise only re-renders when its own button fires, so
   * writing storage alone changes nothing on screen — this is how Arena's
   * language reaches every translated string. Absent until the source has
   * booted, so always call it optionally.
   */
  var __arenaApplyLang: ((lang: string) => void) | undefined
  // eslint-disable-next-line no-var
  var arenaSS: ReturnType<typeof makeStore>
  /**
   * Where the page's own menus try to navigate to.
   *
   * The two nav dropdowns and the small-screen menu answer a choice with
   * `location.href = <path>`, which `tools/extract.mjs` reroutes here. From an
   * opaque origin those paths resolve against nothing, so the untouched code
   * gives a menu that opens, takes a selection and silently ignores it.
   * `src/world.ts` installs a handler that says where the page actually lives.
   */
  // eslint-disable-next-line no-var
  var __arenaOffsite: (href: string) => void
  /**
   * The live match state, and the source's own i18n table — published at the end
   * of `main.js` by `tools/extract.mjs` so Arena's score bar can read what the
   * source keeps module-private.
   *
   * A GETTER, not the state: the source reassigns it on every reset, so a
   * captured reference would freeze the bar on a finished match.
   *
   * All three are absent until the vendored bundle has booted. Always call them
   * optionally — a score bar that throws would take the whole world down with it.
   */
  // eslint-disable-next-line no-var
  var __arenaMatch: (() => MatchState) | undefined
  /** Translate one of the source's own i18n keys into the current language. */
  // eslint-disable-next-line no-var
  var __arenaT: ((key: string) => string) | undefined
  /** The language the source believes it is in. */
  // eslint-disable-next-line no-var
  var __arenaLang: (() => string) | undefined
  /**
   * The CURRENT fixture's three-letter team code by side (0 = home).
   *
   * Not the same as `__arenaT('team0')`, which is the demo match's name and does
   * not change when the channel does.
   */
  // eslint-disable-next-line no-var
  var __arenaTeamCode: ((side: number) => string) | undefined
  /** The colour that side's players are drawn in — the same fill the engine paints. */
  // eslint-disable-next-line no-var
  var __arenaTeamFill: ((side: number) => string) | undefined
  /**
   * The fixture's full team name, which is what every banner in the source shows.
   * Falls back to the translated default when no fixture is loaded.
   */
  // eslint-disable-next-line no-var
  var __arenaTeamName: ((side: number) => string) | undefined
  /**
   * Installed by `src/world.ts` and called by the vendored phase banner, which
   * `tools/extract.mjs` rewrites to ask for its scale here. Returns the factor
   * that keeps both team names inside the picture.
   */
  // eslint-disable-next-line no-var
  var __arenaFitBanner: ((cssW: number) => number) | undefined

  /* ─────────────────────── the engine, for online versus ─────────────────────── */

  /**
   * The two levers versus needs that the source keeps module-private, published
   * by `tools/extract.mjs` (rule 8).
   *
   * Everything else versus drives is the source's OWN agent API below, which it
   * publishes under real names it chose. Depending on those beats depending on a
   * regex against minified code — they are the one part of this build that is
   * deliberately a contract.
   */
  // eslint-disable-next-line no-var
  var __arenaVersus:
    | {
        /**
         * Begin a match on an exact seed, with no fixture loaded.
         *
         * Clears the channel as well as setting the seed: two visitors sharing a
         * seed while one has a World Cup fixture loaded are watching different
         * matches that agree about nothing.
         */
        start: (seed: number) => void
        /** Stop (or restart) the source's own wall-clock stepping. Drawing continues. */
        pause: (paused: boolean) => void
        paused: () => boolean
        /**
         * The source's own feed-target helper, published so a RELAYED feed can
         * still be applied. Its call sites are rerouted through
         * `__arenaFeedHook`, so this is the only way left to actually run it.
         */
        feed: (team: number, number: number | null, player: unknown) => string | null
        /**
         * The source's own mark-target helper, published for the same reason as
         * `feed`: its call sites are rerouted, so this is the only way left to
         * actually run one.
         */
        mark: (player: unknown, number: number | null) => string | null
        /** `[selected player id, selected bench side]`, either possibly null. */
        sel: () => [string | null, number | null]
        /** Force the selection. Versus uses it to undo a click on the far bench. */
        pick: (player: string | null, coach: number | null) => void
        seed: () => number
      }
    | undefined

  /**
   * The source's own debug/agent API. Not extracted — these are the names
   * predictmy.ai publishes itself, on `window`, from `main.js`.
   */
  /**
   * Installed by `src/versus.ts` and called by the vendored tactics pipeline,
   * whose `feedTarget` calls `tools/extract.mjs` reroutes here.
   *
   * Absent outside a versus match, and the rewrite falls back to the source's
   * own function then (`?? jt`), so an ordinary match behaves exactly as it
   * shipped. Returns the label the source would have shown, or null for none.
   */
  // eslint-disable-next-line no-var
  var __arenaFeedHook: ((team: number, number: number | null, player: unknown) => string | null) | undefined
  /** As `__arenaFeedHook`, for marking. Absent outside a versus match. */
  // eslint-disable-next-line no-var
  var __arenaMarkHook: ((player: unknown, number: number | null) => string | null) | undefined

  // eslint-disable-next-line no-var
  var GAME: (() => VersusMatch) | undefined
  /** Engine constants. `DT` is the fixed timestep the whole design rests on. */
  // eslint-disable-next-line no-var
  var CFG: { DT: number; FIELD_W: number; FIELD_H: number } | undefined
  /** Advance exactly `n` deterministic ticks. The clock versus actually drives. */
  // eslint-disable-next-line no-var
  var STEP: ((n?: number) => void) | undefined
  // eslint-disable-next-line no-var
  var AGENT:
    | {
        /** The claim/tactics controller. `applyToTeam` is how a bench gives an order. */
        control: {
          applyToTeam: (match: unknown, side: number, delta: unknown) => void
          applyToPlayer: (player: unknown, delta: unknown, flip?: unknown) => void
          setBelief: (match: unknown, side: number, belief: unknown) => void
          claims: { clear: () => void }
          claimedIds?: () => string[]
        }
        /**
         * The source's bilingual rule parser: text in, parameter delta out.
         *
         * Pure and deterministic, which is what lets a delta be replayed. Note
         * that versus relays the DELTA and not the text: when the model is in
         * play the delta is the model's, and re-interpreting the sentence on the
         * other side would produce a different one and desync the match.
         */
        interpret: (text: string) => { delta: Record<string, unknown>; matched: string[]; matchedEn: string[] }
      }
    | undefined
}

/** Only the fields versus reads. The source's state carries far more. */
export interface VersusMatch {
  players: Array<{ id?: string; team?: number; pos?: { x?: number; y?: number } }>
  ball?: { pos?: { x?: number; y?: number } }
  score: [number, number]
  phase: string
}

/** Only the fields Arena reads. The source's state carries far more. */
export interface MatchState {
  score: [number, number]
  /** `INTRO` · `1H` · `HT` · `2H` · `FT`. */
  phase: string
  halfElapsed: number
  halfLength: number
}

/**
 * Publish the globals the vendored build closes over.
 *
 * They go on `window` because the vendored chunks are separate modules that
 * reference these as free identifiers — the same seam `tools/extract.mjs`
 * creates when it renames the call sites, and the reason the port stays a port.
 * Must run BEFORE the vendored entry is imported.
 */
export function installShims(opts: ShimOptions): void {
  globalThis.arenaFetch = (input, init) => route(String(input), init, opts.chat)
  globalThis.arenaLS = makeStore(opts.persisted, opts.save)
  globalThis.arenaSS = makeStore({})
}
