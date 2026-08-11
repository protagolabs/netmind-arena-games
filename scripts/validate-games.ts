/**
 * PR gate for game submissions. Runs WITHOUT isolated-vm (imports each game
 * directly + the SDK testkit), so it's fast and reproducible on any CI runner.
 * The heavier sandbox smoke (bundle → isolate) runs in the Arena backend CI.
 *
 * Per game it checks:
 *   1. manifest ↔ meta.type agreement + required manifest fields
 *   2. the code that actually SHIPS (esbuild's module graph from `entry`, not a
 *      directory) has no disallowed patterns (eval/require/globalThis/Date/…)
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
import { validateWorlds } from './validate-worlds.js'
import { bundleGameWithInputs, MAX_GAME_COVER_BYTES, MAX_GAME_DESCRIPTION_CHARS } from './build-bundles.js'

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
  description?: string
  presentation?: { cover: string }
}

/**
 * Scan the files the BUNDLE contains, not a directory.
 *
 * `games/<slug>/src/` made this gate opt-in: `manifest.entry` is only required to
 * exist, so a game with its logic at the package root — or under `lib/` — was
 * never scanned at all, which is exactly the shape a submission would take to
 * dodge the check. A game's scores become credits, so that hole was the more
 * expensive of the two; `validate-worlds` closed the identical one first and this
 * follows it.
 *
 * `packages/` is skipped: the SDK is maintainer code, reviewed on its own, and it
 * legitimately contains things this list forbids in author logic. Anything an
 * author vendors lives under `games/<slug>/` and IS scanned.
 */
async function scanBundleInputs(inputs: string[]): Promise<void> {
  for (const full of inputs) {
    if (!/\.(ts|tsx|js|mjs)$/.test(full) || full.includes('.test.')) continue
    if (full.includes(`${path.sep}node_modules${path.sep}`)) continue
    if (full.startsWith(path.join(ROOT, 'packages') + path.sep)) continue

    // Strip comments first. A comment explaining WHY a game must not reach for
    // `Math.random` is the documentation this rule wants to exist, and failing
    // the build for it teaches authors to delete the explanation. (Worlds have
    // stripped comments since their scanner was written; games did not, so the
    // two gates disagreed about the same sentence.)
    const src = (await readFile(full, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const p of DANGEROUS) {
      if (p.test(src)) throw new Error(`${path.relative(ROOT, full)}: disallowed pattern ${p.source}`)
    }
  }
}

/**
 * The blurb and the logo — how the game reaches anyone who has not already
 * decided to play it.
 *
 * Required rather than optional because the Arena catalog has no fallback worth
 * shipping: a card with no artwork and no sentence is a slug in a grid, and the
 * one game that skips them is the one that looks broken next to the others.
 */
async function validatePresentation(dir: string, manifest: Manifest): Promise<void> {
  const description = manifest.description
  if (!description) {
    throw new Error(`${dir}: manifest missing 'description' (one line, shown on the game's card)`)
  }
  if (/[\r\n]/.test(description)) throw new Error(`${dir}: description must be a single line`)
  if (description.length > MAX_GAME_DESCRIPTION_CHARS) {
    throw new Error(
      `${dir}: description is ${description.length} chars; max ${MAX_GAME_DESCRIPTION_CHARS} (cards clamp it to two lines)`,
    )
  }

  const cover = manifest.presentation?.cover
  if (!cover) throw new Error(`${dir}: manifest missing 'presentation.cover' (an SVG logo, e.g. "cover.svg")`)
  if (!cover.toLowerCase().endsWith('.svg')) {
    throw new Error(`${dir}: cover '${cover}' must be an .svg — it is inlined into index.json and scales to every card size`)
  }
  if (!existsSync(path.join(dir, cover))) throw new Error(`${dir}: cover '${cover}' not found`)
  const svg = await readFile(path.join(dir, cover))
  if (svg.byteLength > MAX_GAME_COVER_BYTES) {
    throw new Error(
      `${dir}: cover is ${(svg.byteLength / 1024).toFixed(0)}kb; max ${(MAX_GAME_COVER_BYTES / 1024).toFixed(0)}kb ` +
        `(it is inlined into index.json, which every visitor fetches with the game catalog)`,
    )
  }
  assertCoverRatio(dir, cover, svg.toString('utf8'))
}

/** Cards render at 16:7; the gate owns the frame, the author owns the drawing. */
const COVER_ASPECT = 16 / 7

/**
 * The one thing about a cover that is not the author's call.
 *
 * Style is deliberately unconstrained — a wall of covers looks better for the
 * variety, not worse. Shape is not: every card in the catalog is the same box,
 * so a cover drawn square or 4:3 is either letterboxed into grey bars or cropped
 * through its own subject, and it is the neighbouring games that look broken.
 * Any 16:7 viewBox passes, so 320x140 and 640x280 are both fine.
 */
function assertCoverRatio(dir: string, rel: string, svg: string): void {
  const match = svg.match(/\bviewBox\s*=\s*["']\s*([-\d.eE\s,]+?)\s*["']/)
  if (!match) throw new Error(`${dir}: cover '${rel}' has no viewBox (needs a 16:7 one, e.g. "0 0 320 140")`)

  const nums = match[1]!.split(/[\s,]+/).map(Number)
  if (nums.length !== 4 || nums.some((n) => !Number.isFinite(n))) {
    throw new Error(`${dir}: cover '${rel}' viewBox="${match[1]}" is not four numbers`)
  }
  const [, , width, height] = nums as [number, number, number, number]
  if (width <= 0 || height <= 0) throw new Error(`${dir}: cover '${rel}' viewBox has no size`)

  // Loose enough to accept a rounded viewBox, tight enough to catch a wrong one.
  if (Math.abs(width / height - COVER_ASPECT) > 0.02) {
    throw new Error(
      `${dir}: cover '${rel}' is ${width}x${height} (${(width / height).toFixed(2)}:1); ` +
        `must be 16:7, e.g. "0 0 320 140" — every card in the catalog is that box, and another ratio gets cropped or letterboxed`,
    )
  }
}

async function validateGame(dir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(dir, 'game.manifest.json'), 'utf8')) as Manifest
  for (const field of ['type', 'entry', 'players', 'pace'] as const) {
    if (manifest[field] == null) throw new Error(`${dir}: manifest missing '${field}'`)
  }
  if (!/^[a-z0-9-]+$/.test(manifest.type)) throw new Error(`${dir}: type must be kebab-case`)

  await validatePresentation(dir, manifest)

  if (!existsSync(path.join(dir, manifest.entry))) throw new Error(`${dir}: entry '${manifest.entry}' not found`)
  const { inputs } = await bundleGameWithInputs(path.join(dir, manifest.entry))
  await scanBundleInputs(inputs)

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
  let ok = 0
  const failures: string[] = []
  // `continue`-style guard rather than an early return: worlds are validated
  // below and must still run in a checkout that has no games/ directory.
  const dirs = existsSync(GAMES_DIR)
    ? (await readdir(GAMES_DIR, { withFileTypes: true })).filter((d) => d.isDirectory())
    : []
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

  // Worlds are the other artifact kind this repo publishes. They are gated on
  // different things (self-contained build, storage caps, schema-version
  // continuity) rather than determinism, but they share one `pnpm validate` so a
  // PR cannot pass by only being a valid half.
  const worldFailures = await validateWorlds()

  if (failures.length || worldFailures) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
