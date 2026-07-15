/**
 * @arena/game-sdk/testkit — in-memory harness for authoring & CI.
 *
 * Lets an author run their game locally (no Arena backend) and lets CI verify
 * determinism / termination / score-bounds. The `ctx` here is a mock that
 * mirrors what the real sandbox injects.
 *
 * Convention (strategy pace): the game State MUST expose a numeric `side` field
 * = index (into seats/players) of the mover to act next. The engine reads it to
 * pick which side's params to pass into `play`. Gomoku's `state.side: 0|1` is
 * the canonical example.
 */

import type { Action, Ctx, GameConfig, GameDefinition } from './types.js'

/** Deterministic PRNG (mulberry32). Same seed → same stream. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface MockCtxOptions {
  seed: number
  side?: number
  actor?: string
  oracle?: (key: string) => unknown
  judge?: (prompt: string) => Promise<string>
}

/** Build a mock Ctx backed by a seeded RNG. */
export function makeCtx(opts: MockCtxOptions): Ctx {
  const rng = createRng(opts.seed)
  return {
    random: () => rng(),
    side: opts.side ?? 0,
    actor: opts.actor ?? '',
    oracle: opts.oracle ?? (() => undefined),
    judge: opts.judge ?? (async () => ''),
    reject: (code: string) => {
      throw new Error(`REJECT:${code}`)
    },
  }
}

/** Clamp an agent's raw params to the game's declared [min,max], filling defaults. */
export function clampParams(
  def: GameDefinition<unknown, Record<string, number>>,
  raw: Record<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, spec] of Object.entries(def.params ?? {})) {
    const v = raw?.[key]
    out[key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(spec.max, Math.max(spec.min, v)) : spec.default
  }
  return out
}

export interface MatchResult<S> {
  scores: Record<string, number>
  frames: unknown[]
  steps: number
  finalState: S
}

/**
 * Run a full strategy-pace match headless (mirrors the backend settle loop).
 * `paramsBySeat[i]` is seat i's clamped params.
 */
export function runStrategyMatch<S, P extends Record<string, number>>(
  def: GameDefinition<S, P>,
  cfg: GameConfig,
  paramsBySeat: P[],
  seed: number,
): MatchResult<S> {
  if (!def.play || !def.apply || !def.terminal) {
    throw new Error('strategy match requires play + apply + terminal')
  }
  const ctx = makeCtx({ seed })
  let state = def.init(cfg, ctx)
  const frames: unknown[] = []
  const maxSteps = def.meta.maxSteps ?? 10_000
  let steps = 0
  if (def.render) frames.push(def.render(state))

  while (!def.terminal(state).done && steps < maxSteps) {
    const side = readSide(state)
    const seatCtx: Ctx = { ...ctx, side }
    const action: Action = def.play(state, paramsBySeat[side] ?? paramsBySeat[0]!, seatCtx)
    state = def.apply(state, action, seatCtx)
    if (def.render) frames.push(def.render(state))
    steps++
  }
  return { scores: def.score(state), frames, steps, finalState: state }
}

function readSide(state: unknown): number {
  const s = (state as { side?: unknown }).side
  return typeof s === 'number' && s >= 0 ? s : 0
}

/**
 * CI smoke: run a match and assert the SDK contract invariants.
 * Throws on violation; returns the result on success.
 */
export function assertMatchSane<S, P extends Record<string, number>>(
  def: GameDefinition<S, P>,
  cfg: GameConfig,
  paramsBySeat: P[],
  seed: number,
): MatchResult<S> {
  const r1 = runStrategyMatch(def, cfg, paramsBySeat, seed)
  // 1) terminated within maxSteps
  if (!def.terminal!(r1.finalState).done) {
    throw new Error(`did not terminate within maxSteps (${r1.steps})`)
  }
  // 2) scores are finite and defined for every player
  for (const p of cfg.players) {
    const v = r1.scores[p]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`score for ${p} is not a finite number: ${String(v)}`)
    }
  }
  // 3) determinism: same (seed, params) → identical scores
  const r2 = runStrategyMatch(def, cfg, paramsBySeat, seed)
  if (JSON.stringify(r1.scores) !== JSON.stringify(r2.scores)) {
    throw new Error('non-deterministic: same seed/params produced different scores')
  }
  return r1
}
