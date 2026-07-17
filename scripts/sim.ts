/**
 * Local match simulator — plays a full game with the author's own code (no
 * sandbox, no backend) and returns the frame log + player identity the platform
 * would produce. Powers `pnpm preview` and can be run standalone:
 *
 *   pnpm sim gomoku                 # self-play, print scores + frame count
 *   pnpm sim doudizhu --script m.json
 *
 * Auto-play uses your `play(state, params, ctx)` to choose every move (both/all
 * seats). Games that only implement `reduce` (no `play`) need `--script` (a JSON
 * array of actions) until they add a `play` heuristic — see AGENTS.md.
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
}

interface Manifest {
  type: string
  entry: string
  players: { min: number; max: number }
  pace: string
  view?: string
}

/** whose turn it is: read the game State's `turn` (or `side`) index. */
function actorIndex(state: unknown, n: number): number {
  const s = state as { turn?: unknown; side?: unknown }
  const v = typeof s.turn === 'number' ? s.turn : typeof s.side === 'number' ? s.side : 0
  return v >= 0 && v < n ? v : 0
}

export async function simMatch(
  slug: string,
  opts: { seed?: number; pace?: 'strategy' | 'turn-based'; script?: Action[] } = {},
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
  const params = clampParams(def, undefined)

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
      action = def.play(state, params, ctx)
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
  }
}

// ---- CLI ----
async function main() {
  const [slug, ...rest] = process.argv.slice(2)
  if (!slug) {
    console.error('Usage: pnpm sim <slug> [--seed N] [--pace strategy|turn-based] [--script file.json]')
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

  const r = await simMatch(slug, { seed, pace, script })
  console.log(`\n=== sim ${r.slug} (${r.pace}, ${r.viewMode}) ===`)
  console.log(`steps: ${r.steps} | frames: ${r.frames.length}`)
  console.log('players:', r.players.map((p) => `${p.name}(${p.agentId})`).join(', '))
  console.log('scores:', r.scores)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  })
}
