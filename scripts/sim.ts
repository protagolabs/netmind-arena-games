/**
 * Local match simulator — plays a full game with the author's own code (no
 * sandbox, no backend) and returns the frame log + player identity the platform
 * would produce. Powers `pnpm preview` and can be run standalone:
 *
 *   pnpm sim gomoku                 # self-play, print scores + frame count
 *   pnpm sim doudizhu --script m.json
 *   pnpm sim liars-dice --pace strategy --params '[{"bluff":1},{"skepticism":1}]'
 *
 * Auto-play uses your `play(state, params, ctx)` to choose every move (both/all
 * seats). Games that only implement `reduce` (no `play`) need `--script` (a JSON
 * array of actions) until they add a `play` heuristic — see AGENTS.md.
 *
 * `--params` gives each SEAT its own knobs, because one shared param set can only
 * ever show a game playing itself. A strategy competition is agents with
 * different knobs meeting on the same board, and that is the thing an author
 * needs to look at before publishing.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeCtx, clampParams } from '@arena/game-sdk'
import type { Action, Ctx, GameConfig, GameDefinition, PlayerInfo } from '@arena/game-sdk'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export interface SimResult {
  slug: string
  pace: 'strategy' | 'turn-based'
  viewMode: 'declarative' | 'sandboxed'
  viewEntry: string | null
  frames: unknown[]
  players: PlayerInfo[]
  scores: Record<string, number>
  steps: number
  /** The knobs each seat actually played, after clamping. Empty for a game with no `params`. */
  params: Record<string, number>[]
}

/** Per-seat knobs, as accepted from `--params` before clamping. */
export type SeatParams = Record<string, number>[]

interface Manifest {
  type: string
  entry: string
  players: { min: number; max: number }
  pace: string
  view?: string
}

/**
 * Reject knob names the game does not declare.
 *
 * `clampParams` fills a missing knob with its default, so a typo — or a knob
 * from a different game — is otherwise silently dropped and the sim runs on
 * defaults while APPEARING to run on what was asked for. That is a preview that
 * lies, which is worse than one that fails.
 */
function assertKnownKnobs(
  slug: string,
  def: GameDefinition<unknown, Record<string, number>>,
  params: SeatParams | undefined,
): void {
  if (!params) return
  const known = Object.keys(def.params ?? {})
  params.forEach((seat, i) => {
    if (seat == null) return
    if (typeof seat !== 'object' || Array.isArray(seat)) {
      throw new Error(`--params[${i}] must be an object of knobs, e.g. {"aggression":0.8}`)
    }
    const unknown = Object.keys(seat).filter((k) => !known.includes(k))
    if (unknown.length) {
      throw new Error(
        known.length
          ? `--params[${i}]: ${slug} has no knob '${unknown.join("', '")}'. Declared knobs: ${known.join(', ')}`
          : `--params[${i}]: ${slug} declares no params at all — nothing to tune`,
      )
    }
  })
}

/** whose turn it is: read the game State's `turn` (or `side`) index. */
function actorIndex(state: unknown, n: number): number {
  const s = state as { turn?: unknown; side?: unknown }
  const v = typeof s.turn === 'number' ? s.turn : typeof s.side === 'number' ? s.side : 0
  return v >= 0 && v < n ? v : 0
}

export async function simMatch(
  slug: string,
  opts: { seed?: number; pace?: 'strategy' | 'turn-based'; script?: Action[]; params?: SeatParams } = {},
): Promise<SimResult> {
  const dir = path.join(ROOT, 'games', slug)
  const manifest = JSON.parse(await readFile(path.join(dir, 'game.manifest.json'), 'utf8')) as Manifest
  const mod = (await import(path.join(dir, manifest.entry))) as { default: GameDefinition<unknown, Record<string, number>> }
  const def = mod.default
  const pace = (opts.pace ?? manifest.pace) as 'strategy' | 'turn-based'
  const seed = opts.seed ?? 12345

  // Fabricate identities (what the platform supplies via observe()/onPlayers).
  const n = manifest.players.min
  const cfg: GameConfig = { players: Array.from({ length: n }, (_, i) => `agent_${i}`) }
  const players: PlayerInfo[] = cfg.players.map((agentId, seat) => ({
    seat,
    agentId,
    name: `Player ${seat + 1}`,
    avatar: `https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(`arena-p${seat + 1}`)}`,
  }))
  // One clamped set per seat: `--params '[{...},{...}]'` positionally, seats past
  // the end (and any knob left out) falling back to the declared defaults —
  // exactly what Arena does with a partial agent submission.
  assertKnownKnobs(slug, def, opts.params)
  const paramsBySeat = cfg.players.map((_, seat) => clampParams(def, opts.params?.[seat]))

  const advance = pace === 'turn-based' ? def.reduce : def.apply
  if (!advance) throw new Error(`${slug}: missing ${pace === 'turn-based' ? 'reduce' : 'apply'} for pace '${pace}'`)
  if (!def.terminal) throw new Error(`${slug}: missing terminal`)

  const baseCtx = makeCtx({ seed })
  let state = def.init(cfg, baseCtx)
  const frames: unknown[] = []
  if (def.render) frames.push(def.render(state))

  const maxSteps = def.meta.maxSteps ?? 10_000
  let steps = 0
  while (!def.terminal(state).done && steps < maxSteps) {
    const idx = actorIndex(state, n)
    const ctx: Ctx = { ...baseCtx, side: idx, actor: cfg.players[idx]! }
    let action: Action
    if (opts.script) {
      if (steps >= opts.script.length) break
      action = opts.script[steps]!
    } else if (def.play) {
      action = def.play(state, paramsBySeat[idx]!, ctx)
    } else {
      throw new Error(`${slug}: no play() — pass --script <actions.json> or add a play() heuristic (see AGENTS.md)`)
    }
    state = advance(state, action, ctx)
    if (def.render) frames.push(def.render(state))
    steps++
  }

  return {
    slug,
    pace,
    viewMode: manifest.view ? 'sandboxed' : 'declarative',
    viewEntry: manifest.view ? path.join(dir, manifest.view) : null,
    frames,
    players,
    scores: def.score(state),
    steps,
    params: def.params ? paramsBySeat : [],
  }
}

/**
 * `--params` takes inline JSON or a path to a .json file, and must be an ARRAY:
 * one entry per seat, positionally. A bare object is rejected rather than
 * broadcast to every seat — `{"bluff":1}` reads equally as "seat 0 bluffs" and
 * "everyone bluffs", and quietly picking one would misreport half the runs.
 */
export async function readSeatParams(value: string | undefined): Promise<SeatParams | undefined> {
  if (value === undefined) return undefined
  // Anything not starting with `[` or `{` is taken as a path, so a typo'd flag
  // value reports as the file it isn't rather than as broken JSON.
  const inline = /^\s*[[{]/.test(value)
  let text: string
  try {
    text = inline ? value : await readFile(value, 'utf8')
  } catch {
    throw new Error(`--params: no such file '${value}' (pass inline JSON starting with '[' instead)`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`--params: ${inline ? 'not valid JSON' : `'${value}' is not valid JSON`}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      '--params must be an array, one entry per seat — wrap it: ' +
        `'[${JSON.stringify(parsed)}]' for seat 0 only, or repeat it per seat to give every seat the same knobs`,
    )
  }
  return parsed as SeatParams
}

// ---- CLI ----
async function main() {
  const [slug, ...rest] = process.argv.slice(2)
  if (!slug) {
    console.error(
      'Usage: pnpm sim <slug> [--seed N] [--pace strategy|turn-based] [--script file.json]\n' +
        '                      [--params \'[{"knob":0.9},{}]\' | --params file.json]',
    )
    process.exit(1)
  }
  const flag = (name: string) => {
    const i = rest.indexOf(name)
    return i >= 0 ? rest[i + 1] : undefined
  }
  const seed = flag('--seed') ? Number(flag('--seed')) : undefined
  const pace = flag('--pace') as 'strategy' | 'turn-based' | undefined
  const scriptPath = flag('--script')
  const script = scriptPath ? (JSON.parse(await readFile(scriptPath, 'utf8')) as Action[]) : undefined
  const params = await readSeatParams(flag('--params'))

  const r = await simMatch(slug, { seed, pace, script, params })
  console.log(`\n=== sim ${r.slug} (${r.pace}, ${r.viewMode}) ===`)
  console.log(`steps: ${r.steps} | frames: ${r.frames.length}`)
  console.log('players:', r.players.map((p) => `${p.name}(${p.agentId})`).join(', '))
  // Print what each seat actually played, clamped — the knobs are half the
  // result in strategy pace, and a clamped value is not the one you typed.
  r.params.forEach((p, seat) => console.log(`  seat ${seat}:`, JSON.stringify(p)))
  console.log('scores:', r.scores)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
