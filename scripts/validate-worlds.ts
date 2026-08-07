/**
 * PR gate for world submissions.
 *
 * A world is trusted very differently from a game, so it is checked differently.
 * A game emits scores that become credits, so its gate is about DETERMINISM — no
 * clock, no entropy, no escape hatches. A world emits nothing scored, so none of
 * that applies; its risks are that the document does not load, that it opens an
 * unbounded write endpoint, or that it quietly breaks data written by an earlier
 * release.
 *
 * So this checks, per world:
 *   1. the manifest validates against `world.manifest.schema.json`
 *   2. every collection caps its record size, and `unique` paths are indexed
 *   3. `supportedSchemaVersions` includes `schemaVersion` (a build must be able
 *      to render what it writes)
 *   4. the entry bundles to ONE self-contained document, under the size ceiling
 *   5. the source makes no network calls of its own
 *   6. the cover exists
 *
 * Run: `pnpm validate` (worlds are validated alongside games).
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
// The 2020-12 build, not ajv's default draft-07 one: the SDK documents author
// schemas as draft 2020-12, and the default export rejects the `$schema` that
// implies with an unhelpful "no schema with key or ref" error.
import Ajv from 'ajv/dist/2020.js'
import type { WorldManifest } from '@arena/world-sdk'
// The publish caps come from the build step rather than being restated here: a
// second copy of a number is a second chance for CI to disagree with publish.
import { bundleWorldWithInputs, worldHtml, readAssets, MAX_HTML_BYTES, MAX_COVER_BYTES } from './build-worlds.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORLDS_DIR = path.join(ROOT, 'worlds')
const GAMES_DIR = path.join(ROOT, 'games')
const MANIFEST_SCHEMA = path.join(ROOT, 'packages/world-sdk/world.manifest.schema.json')

/**
 * Networking a world tries to do itself. All of it is already blocked at runtime
 * by `connect-src 'none'`, so the point of failing here is that the author finds
 * out in CI instead of debugging a silent no-op in a sandbox. Storage is reached
 * through `ctx.collection(...)`, which the host proxies.
 */
const NETWORK_PATTERNS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bnavigator\s*\.\s*sendBeacon\b/,
  /\bimportScripts\s*\(/,
]

/**
 * `localStorage` / `sessionStorage` throw in an opaque-origin iframe, so a world
 * using them is broken rather than dangerous — but broken in a way that only
 * shows up as a runtime exception in someone's browser. `ctx.local` is the
 * platform primitive that actually works.
 */
const STORAGE_PATTERNS = [/\blocalStorage\b/, /\bsessionStorage\b/]

/**
 * Scan the files the BUNDLE contains, not a directory.
 *
 * Two scopes were wrong before this. `worlds/<slug>/src/` made the gate opt-in:
 * `entry` is only required to exist, so a world with `main.ts` at its root — or
 * anything under `lib/` — was never checked at all, which is exactly the shape a
 * submission would take to avoid the check. The whole world directory then went
 * too far the other way and accused build tooling: `tools/extract.mjs` names
 * `localStorage` precisely because its job is to strip it out of vendored code,
 * and it runs in Node and never ships.
 *
 * esbuild's metafile is the answer to the question actually being asked — which
 * code ends up in the visitor's browser. Dependencies pulled into the bundle are
 * scanned too: they ship, so their `fetch` fails just as silently as the author's
 * would.
 */
async function scanBundleInputs(inputs: string[], report: (msg: string) => void): Promise<void> {
  for (const full of inputs) {
    if (!/\.(ts|tsx|js|mjs)$/.test(full) || full.includes('.test.')) continue
    // Strip comments first. A comment explaining WHY a world must not touch
    // `localStorage` is exactly the documentation this rule wants to exist,
    // and failing the build for it teaches authors to delete the explanation.
    const src = (await readFile(full, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const p of NETWORK_PATTERNS) {
      if (p.test(src)) {
        report(`${path.relative(ROOT, full)}: ${p.source} — a world cannot reach the network (connect-src 'none'); use ctx.collection(...)`)
      }
    }
    for (const p of STORAGE_PATTERNS) {
      if (p.test(src)) {
        report(`${path.relative(ROOT, full)}: ${p.source} — unavailable in an opaque-origin iframe; use ctx.local`)
      }
    }
  }
}

async function validateWorld(dir: string, gameTypes: Set<string>, validateManifest: ReturnType<Ajv['compile']>): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(dir, 'world.manifest.json'), 'utf8')) as WorldManifest

  if (!validateManifest(manifest)) {
    const e = validateManifest.errors?.[0]
    throw new Error(`manifest invalid: ${e?.instancePath || '/'} ${e?.message}`)
  }

  // A slug shared with a game type would make `/worlds/<x>` and the game catalog
  // disagree about what `<x>` is.
  if (gameTypes.has(manifest.type)) {
    throw new Error(`type '${manifest.type}' collides with a game type`)
  }

  // A build must be able to render everything it writes; without this a world
  // could ship a version that cannot read back its own newest records.
  if (!manifest.supportedSchemaVersions.includes(manifest.schemaVersion)) {
    throw new Error(`supportedSchemaVersions must include schemaVersion (${manifest.schemaVersion})`)
  }

  // Attribution is optional, but a declared link is one the platform will invite
  // visitors to click, so it is held to more than the schema's `^https://` shape.
  for (const [field, party] of Object.entries(manifest.credits ?? {})) {
    if (!party?.url) continue
    let url: URL
    try {
      url = new URL(party.url)
    } catch {
      throw new Error(`credits.${field}.url is not a URL: '${party.url}'`)
    }
    if (url.protocol !== 'https:') {
      throw new Error(`credits.${field}.url must be https (got '${url.protocol}')`)
    }
    // `https://example.com@evil.example` is a valid URL that reads as one site
    // and resolves to another. The host renders the hostname precisely so a
    // visitor can see where a link goes; embedded credentials defeat that.
    if (url.username || url.password) {
      throw new Error(`credits.${field}.url must not contain credentials — '${url.hostname}' is where it actually goes`)
    }
    if (!url.hostname.includes('.')) {
      throw new Error(`credits.${field}.url has no public hostname: '${url.hostname}'`)
    }
  }

  for (const [name, spec] of Object.entries(manifest.storage?.collections ?? {})) {
    // The JSON Schema already requires maxRecordBytes; restate the intent so the
    // failure explains itself rather than pointing at a schema path.
    if (!(spec.maxRecordBytes > 0)) {
      throw new Error(`collection '${name}': maxRecordBytes is required — an uncapped write endpoint is free storage`)
    }
    // Uniqueness is enforced through the generic `unique_key` column, which the
    // platform builds from these paths. A payload path that is not also indexed
    // would never participate in a query, so the mismatch is always a mistake.
    for (const tuple of spec.unique ?? []) {
      for (const p of tuple) {
        if (p.startsWith('payload.') && !(spec.indexes ?? []).includes(p)) {
          throw new Error(`collection '${name}': unique path '${p}' must also appear in indexes`)
        }
      }
    }
    if (typeof spec.schema !== 'object' || spec.schema === null) {
      throw new Error(`collection '${name}': schema must be a JSON Schema object`)
    }

    // Compile it, with the same 2020-12 Ajv the backend uses. Without this a
    // world ships happily and then rejects EVERY write at runtime, which reads to
    // the author as "storage is broken" rather than "my schema is wrong".
    //
    // The trap this exists for: draft-07 wrote tuples as `items: [a, b, c]`, and
    // 2020-12 renamed that to `prefixItems`. The old spelling is not an error in
    // the manifest — it is a valid-looking object — it only fails at compile.
    try {
      new Ajv({ allErrors: false, strict: false, allowUnionTypes: true }).compile(spec.schema)
    } catch (err) {
      throw new Error(
        `collection '${name}': schema does not compile as JSON Schema 2020-12 — ${(err as Error).message}` +
          `\n      (tuples use "prefixItems", not "items": [...])`,
      )
    }
  }

  if (!existsSync(path.join(dir, manifest.presentation.cover))) {
    throw new Error(`cover '${manifest.presentation.cover}' not found`)
  }
  if (!existsSync(path.join(dir, manifest.entry))) {
    throw new Error(`entry '${manifest.entry}' not found`)
  }

  // The cover and `assets/**` are inlined into index.json, so the build enforces
  // a ceiling on both. Check them HERE too, or an oversized cover passes review,
  // merges, and then fails the publish job on main — where the author who can fix
  // it no longer has the wheel.
  const coverBytes = (await readFile(path.join(dir, manifest.presentation.cover))).byteLength
  if (coverBytes > MAX_COVER_BYTES) {
    throw new Error(`cover is ${(coverBytes / 1024).toFixed(0)}kb; max ${(MAX_COVER_BYTES / 1024).toFixed(0)}kb (it is inlined into index.json)`)
  }
  // Throws with the byte count when `assets/**` exceeds its combined cap.
  await readAssets(dir)

  // Actually build it. This is the check that matters most: the host loads the
  // document through iframe `srcdoc`, whose opaque origin cannot resolve relative
  // imports, so anything that does not collapse to one file renders a blank frame
  // with no error to go on. The build also tells us which files shipped, which is
  // what the source scan below is entitled to complain about.
  const { js, inputs } = await bundleWorldWithInputs(path.join(dir, manifest.entry))

  const problems: string[] = []
  await scanBundleInputs(inputs, (m) => problems.push(m))
  if (problems.length) throw new Error(problems.join('\n    '))

  const html = worldHtml(js, manifest.displayName)
  const bytes = Buffer.byteLength(html, 'utf8')
  if (bytes > MAX_HTML_BYTES) {
    throw new Error(`built document is ${(bytes / 1024).toFixed(0)}kb; max ${(MAX_HTML_BYTES / 1024).toFixed(0)}kb (it is inlined into index.json, which the backend holds in memory)`)
  }
  if (/\bimport\s*[( ]/.test(js) && /from\s*['"]\.\.?\//.test(js)) {
    throw new Error('bundle still contains relative imports — the document must be self-contained')
  }

  return manifest.type
}

async function gameTypeSet(): Promise<Set<string>> {
  const types = new Set<string>()
  if (!existsSync(GAMES_DIR)) return types
  for (const d of await readdir(GAMES_DIR, { withFileTypes: true })) {
    const manifestPath = path.join(GAMES_DIR, d.name, 'game.manifest.json')
    if (d.isDirectory() && existsSync(manifestPath)) {
      types.add((JSON.parse(await readFile(manifestPath, 'utf8')) as { type: string }).type)
    }
  }
  return types
}

/** @returns number of failures. */
export async function validateWorlds(): Promise<number> {
  if (!existsSync(WORLDS_DIR)) {
    console.log('no worlds/ directory; nothing to validate')
    return 0
  }

  const ajv = new Ajv({ allErrors: false, strict: false })
  const validateManifest = ajv.compile(JSON.parse(await readFile(MANIFEST_SCHEMA, 'utf8')))
  const gameTypes = await gameTypeSet()

  const dirs = (await readdir(WORLDS_DIR, { withFileTypes: true })).filter((d) => d.isDirectory())
  let ok = 0
  const failures: string[] = []
  for (const d of dirs) {
    const dir = path.join(WORLDS_DIR, d.name)
    if (!existsSync(path.join(dir, 'world.manifest.json'))) continue
    try {
      console.log(`✓ ${await validateWorld(dir, gameTypes, validateManifest)} — manifest + storage + self-contained build OK`)
      ok++
    } catch (err) {
      failures.push(`✗ ${d.name}: ${(err as Error).message}`)
    }
  }
  failures.forEach((f) => console.error(f))
  if (ok || failures.length) console.log(`\n${ok} world(s) passed, ${failures.length} failed`)
  return failures.length
}

if (import.meta.url === `file://${process.argv[1]}`) {
  validateWorlds().then((failed) => {
    if (failed) process.exit(1)
  })
}
