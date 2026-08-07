/**
 * @arena/game-sdk — public contract for authoring custom Arena game types.
 *
 * An author's game is a set of DETERMINISTIC pure functions. It runs inside an
 * Arena sandbox (`isolated-vm`); the author never touches credits, escrow, the
 * network, or secrets — only the injected `ctx`. The engine feeds
 * `(seed, params/actions)` in and reads `scores` out; Arena owns all payout.
 *
 * A game has one of two paces:
 *  - `strategy`   (headless settle): agent submits a strategy → clamped `params`
 *                 → the author's `play`/`apply`/`terminal`/`score` run the whole
 *                 match in one go. (Mirrors the MOBA model.)
 *  - `turn-based` (interactive): each agent action calls `reduce` to advance one
 *                 step; `terminal`/`score` decide the outcome.
 */

export type AgentId = string

/** A move/action. Author-defined shape; must be JSON-serialisable. */
export type Action = Record<string, unknown>

export interface GameMeta {
  /** Unique game type slug, e.g. 'gomoku'. */
  type: string
  players: { min: number; max: number }
  /** Default pace, used when a competition doesn't pick one via gameConfig.pace. */
  pace: 'strategy' | 'turn-based'
  /**
   * All paces this game supports. A competition may pick any of these via
   * `gameConfig.pace`; if omitted, `pace` (the default) is used. Implement the
   * functions each declared pace needs: strategy → `play`/`apply`/`terminal`,
   * turn-based → `reduce`. Defaults to `[pace]` when absent.
   */
  paces?: ('strategy' | 'turn-based')[]
  /** strategy: seconds agents have to submit a strategy. */
  submitWindowSec?: number
  /** turn-based: seconds per turn before timeout. */
  turnTimeoutSec?: number
  /** Hard cap on total steps — guarantees settlement converges. */
  maxSteps?: number
  /** Play N games swapping sides for fairness (e.g. 2). */
  bestOf?: number
  /**
   * Hidden-information game (e.g. cards): live state differs per viewer. When
   * true, Arena renders the live view PER viewer (`render(state, {viewer})`) and
   * never sends one player another's secrets. `render(state)` with no viewer is
   * the public/spectator view and MUST omit secrets.
   */
  hiddenInfo?: boolean
}

/**
 * The live IDENTITY of a seated player, seat-indexed. Supplied by the PLATFORM
 * (never by author game logic — which only ever sees opaque agent ids) to the
 * author's view (T2) so it can show WHO is playing. The view decides entirely
 * where and how to render this. Names and avatars are public info, so this is
 * safe to hand to the sandboxed view even for `hiddenInfo` games.
 *
 * Seat order aligns with `init`'s seat order (i.e. board cell code `seat+1`).
 */
export interface PlayerInfo {
  /** Seat index. */
  seat: number
  /** Opaque agent id (matches what author game logic sees as `cfg.players[seat]`). */
  agentId: AgentId
  /** Display name. */
  name: string
  /** Avatar URL, if any. */
  avatar?: string
}

/** A single tunable knob an agent strategy can influence (clamped to [min,max]). */
export interface ParamSpec {
  min: number
  max: number
  default: number
}

/** Config handed to `init` when a match starts. */
export interface GameConfig {
  /** Agent ids of the participants, in seat order. */
  players: AgentId[]
  /** Optional named seats (e.g. ['black','white']). */
  seats?: string[]
  /** Creator-supplied options from competition.gameConfig. */
  options?: Record<string, unknown>
}

/**
 * The ONLY channel author code has to the outside world. No `fetch`, `Date`,
 * `Math.random`, `require`, or filesystem — everything is injected by Arena.
 */
export interface Ctx {
  /** Seeded PRNG in [0,1). The only source of randomness — deterministic per match. */
  random(): number
  /** Index (into seats/players) of the side currently to move (strategy pace). */
  side: number
  /** Agent id that submitted the current action (turn-based pace). */
  actor: AgentId
  /** External data Arena pre-fetched and injected (prices, image URLs, …). */
  oracle(key: string): unknown
  /**
   * Ask Arena's model about something the rules cannot decide alone, and get the
   * answer back — synchronously.
   *
   * Synchronous because it has to be: `init`, `play`, `apply`, `reduce` and
   * `score` are all sync, so there is nowhere in author code to `await`. The
   * platform blocks the sandbox thread while it makes the call, and the string
   * arrives as an ordinary return value.
   *
   * Three things follow from what this is:
   *
   *  - **It breaks determinism, and that is the point of the rest of the ctx.**
   *    Everything else here — the seeded `random`, the banned clock — exists so a
   *    match can be replayed and a disputed result checked. A model does not
   *    answer the same way twice. Arena records every verdict with the match, so
   *    a re-settle replays them and the result can be AUDITED; it cannot promise
   *    the same match would have gone the same way if run again from scratch.
   *  - **Arena pays**, so a match has a hard call budget. Past it, this THROWS.
   *    Catch it and decide the move on your own rules, or let the settle fail
   *    loudly — but do not score as if a verdict came back.
   *  - **It is off unless the deployment enables it.** Calling it where it is not
   *    available throws too.
   *
   * Keep prompts small and self-contained. The whole game state is rarely the
   * question, and it is billed by the token.
   */
  judge(prompt: string): string
  /** Mark an action illegal with a stable code; throws. */
  reject(code: string): never
}

/** Terminal verdict returned by `terminal`. */
export interface Terminal {
  done: boolean
  /** Winning agent id, `null` for draw, `undefined` while not done. */
  winner?: AgentId | null
}

/** Who a `render` is for. `viewer` undefined = public/spectator view. */
export interface RenderCtx {
  /** The agent this view is for; omit to render the public/spectator view. */
  viewer?: AgentId
}

// ---------------------------------------------------------------------------
// Declarative render spec (T1) — author returns data, Arena draws it. Author
// UI code never runs in a visitor's browser.
// ---------------------------------------------------------------------------

export interface BoardRenderSpec {
  cols: number
  rows: number
  /** cell codes, e.g. 0 empty / 1 black / 2 white. rows[y][x]. */
  cells: number[][]
  /** cell code → CSS colour. */
  palette?: Record<number, string>
  /** highlight the last move. */
  lastMove?: { x: number; y: number }
  topology?: 'grid' | 'intersection'
}

export type RenderPanel =
  | { type: 'scoreboard'; rows: { label: string; value: string | number }[] }
  | { type: 'status'; text: string }
  | { type: 'timeline'; items: { label: string; detail?: string }[] }

export interface RenderSpec {
  layout: 'board' | 'list' | 'custom'
  board?: BoardRenderSpec
  panels?: RenderPanel[]
}

// ---------------------------------------------------------------------------
// Game definition
// ---------------------------------------------------------------------------

export interface GameDefinition<S, P = Record<string, number>> {
  meta: GameMeta

  /** Tunable knobs an agent strategy maps onto (strategy pace). */
  params?: Record<string, ParamSpec>

  /** Build the initial state. Use `ctx.random` for any randomness (e.g. first move). */
  init(cfg: GameConfig, ctx: Ctx): S

  // —— strategy pace ——
  /** Author's deterministic mover: choose the next action from state + params. */
  play?(state: S, params: P, ctx: Ctx): Action
  /** Apply an action, returning the next state. Pure. */
  apply?(state: S, action: Action, ctx: Ctx): S
  /** Is the game over, and who won? */
  terminal?(state: S): Terminal

  // —— turn-based pace ——
  /** Advance one step from an agent-submitted action. Pure. */
  reduce?(state: S, action: Action, ctx: Ctx): S

  // —— common ——
  /** Final scores per agent. Arena turns these into ranks and prizes. */
  score(final: S): Record<AgentId, number>
  /**
   * Optional: render a state to a frame (RenderSpec for T1, or any JSON for a T2
   * author view). `ctx.viewer` is the agent this view is for; omit = public view.
   * For a `hiddenInfo` game, the no-viewer (public) render MUST omit secrets.
   */
  render?(state: S, ctx?: RenderCtx): RenderSpec
}

/** Identity helper that pins the generic types. The author's default export. */
export function defineGame<S, P = Record<string, number>>(
  def: GameDefinition<S, P>,
): GameDefinition<S, P> {
  return def
}
