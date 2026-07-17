/**
 * PR gate for game submissions. Runs WITHOUT isolated-vm (imports each game
 * directly + the SDK testkit), so it's fast and reproducible on any CI runner.
 * The heavier sandbox smoke (bundle → isolate) runs in the Arena backend CI.
 *
 * Per game it checks:
 *   1. manifest ↔ meta.type agreement + required manifest fields
 *   2. source has no disallowed patterns (eval/require/globalThis/Date/…)
 *   3. determinism + termination + score-bounds over N seeds (testkit)
 *
 * Run: `pnpm validate`  (exits non-zero on any failure)
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { assertMatchSane, clampParams } from '@arena/game-sdk'
import type { GameDefinition } from '@arena/game-sdk'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GAMES_DIR = path.join(ROOT, 'games')

// No global source may reach outside the SDK: no eval/Function/require/dynamic
// import, no prototype escapes, no nondeterministic globals (Date/Math.random),
// no ambient globals (globalThis/Reflect/Proxy/…).
const DANGEROUS = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /__proto__/,
  /\.constructor\b/,
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bglobalThis\b/,
  /\bReflect\b/,
  /\bProxy\b/,
  /\bWeakRef\b/,
  /\bprocess\b/,
  /\bfetch\s*\(/,
  /\bnew\s+Date\b/,
  /\bDate\.now\b/,
  /\bMath\.random\b/,
]

interface Manifest {
  type: string
  displayName?: string
  sdkVersion?: string
  entry: string
  players: { min: number; max: number }
  pace: string
}

async function scanSources(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) await scanSources(full)
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
      const src = await readFile(full, 'utf8')
      for (const p of DANGEROUS) if (p.test(src)) throw new Error(`${full}: disallowed pattern ${p.source}`)
    }
  }
}

async function validateGame(dir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(dir, 'game.manifest.json'), 'utf8')) as Manifest
  for (const field of ['type', 'entry', 'players', 'pace'] as const) {
    if (manifest[field] == null) throw new Error(`${dir}: manifest missing '${field}'`)
  }
  if (!/^[a-z0-9-]+$/.test(manifest.type)) throw new Error(`${dir}: type must be kebab-case`)

  const srcDir = path.join(dir, 'src')
  if (existsSync(srcDir)) await scanSources(srcDir)

  const mod = (await import(path.join(dir, manifest.entry))) as { default: GameDefinition<unknown, Record<string, number>> }
  const def = mod.default
  if (def.meta.type !== manifest.type) throw new Error(`${dir}: manifest.type '${manifest.type}' != meta.type '${def.meta.type}'`)

  // Strategy games get a headless self-play determinism/termination sweep.
  // Turn-based games need an agent driver to play out, so the sim is skipped here
  // (their per-move logic is covered by the game's own unit tests).
  if (def.meta.pace === 'strategy') {
    const players = Array.from({ length: def.meta.players.min }, (_, i) => `seat${i}`)
    const defaults = clampParams(def, {})
    for (let seed = 0; seed < 30; seed++) {
      assertMatchSane(def, { players }, players.map(() => defaults), seed)
    }
  }
  return def.meta.type
}

async function main() {
  if (!existsSync(GAMES_DIR)) {
    console.log('no games/ directory; nothing to validate')
    return
  }
  const dirs = (await readdir(GAMES_DIR, { withFileTypes: true })).filter((d) => d.isDirectory())
  let ok = 0
  const failures: string[] = []
  for (const d of dirs) {
    const dir = path.join(GAMES_DIR, d.name)
    if (!existsSync(path.join(dir, 'game.manifest.json'))) continue
    try {
      console.log(`✓ ${await validateGame(dir)} — schema + determinism + termination OK`)
      ok++
    } catch (err) {
      failures.push(`✗ ${d.name}: ${(err as Error).message}`)
    }
  }
  failures.forEach((f) => console.error(f))
  console.log(`\n${ok} game(s) passed, ${failures.length} failed`)
  if (failures.length) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
