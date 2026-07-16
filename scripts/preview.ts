/**
 * Local visual preview — see EXACTLY what Arena will render for your game,
 * without the platform. Sims a full match, then drives your renderer with the
 * same contract the platform uses:
 *   - T2 (you ship view.ts) → your view runs in a sandboxed iframe (same CSP),
 *     fed frames + players via postMessage (onFrame / onPlayers).
 *   - T1 (declarative)      → the platform's board/panel renderer draws frames.
 * Both paths use `@arena/game-sdk/preview` — the same renderer the React app
 * wraps — so the preview can't drift from production.
 *
 *   pnpm preview gomoku            # open http://localhost:4321
 *   pnpm preview doudizhu --script m.json --port 4321
 *
 * Note: editing your game LOGIC needs a restart (ESM import cache); editing
 * view.ts is picked up on reload (re-bundled each request).
 */
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import esbuild from 'esbuild'
import type { Action } from '@arena/game-sdk'
import { simMatch } from './sim.js'
import { bundleView, viewHtml } from './build-bundles.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const BROWSER_ENTRY = `
import { drawRenderSpec, replayFrames, hostSandboxedView } from '@arena/game-sdk/preview'
const S = window.__SIM__
const app = document.getElementById('app')
document.getElementById('meta').textContent =
  S.slug + ' · ' + S.pace + ' · ' + S.viewMode + ' · ' + S.frames.length + ' frames · scores ' + JSON.stringify(S.scores)
if (S.viewMode === 'sandboxed') {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.srcdoc = S.viewHtml
  iframe.style.cssText = 'width:100%;max-width:540px;height:620px;border:none;border-radius:8px;background:#0b0b0f'
  app.appendChild(iframe)
  hostSandboxedView(iframe, { frames: S.frames, players: S.players, ended: true, frameMs: S.frameMs })
} else {
  replayFrames({ frames: S.frames, ended: true, frameMs: S.frameMs, onFrame: (f) => drawRenderSpec(app, f) })
}
`

async function bundleBrowserEntry(): Promise<string> {
  const out = await esbuild.build({
    stdin: { contents: BROWSER_ENTRY, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  })
  return out.outputFiles?.[0]?.text ?? ''
}

async function page(slug: string, opts: { pace?: 'strategy' | 'turn-based'; seed?: number; script?: Action[] }): Promise<string> {
  const sim = await simMatch(slug, opts)
  const html = sim.viewEntry ? viewHtml(await bundleView(sim.viewEntry)) : ''
  const data = {
    slug: sim.slug,
    pace: sim.pace,
    viewMode: sim.viewMode,
    frames: sim.frames,
    players: sim.players,
    scores: sim.scores,
    viewHtml: html,
    frameMs: 1200,
  }
  const entry = await bundleBrowserEntry()
  return `<!doctype html><html><head><meta charset="utf-8"><title>preview · ${sim.slug}</title>
<style>body{margin:0;background:#0b0b0f;color:#f5f5f5;font:14px system-ui;display:flex;flex-direction:column;align-items:center;gap:14px;padding:28px}#meta{color:#a1a1aa;font-size:12px}a{color:#e5484d}</style>
</head><body>
<div id="meta"></div>
<div id="app"></div>
<div style="color:#71717a;font-size:11px">reload to replay · edit view.ts and reload · restart after editing game logic</div>
<script>window.__SIM__=${JSON.stringify(data)}</script>
<script>${entry}</script>
</body></html>`
}

async function main() {
  const [slug, ...rest] = process.argv.slice(2)
  if (!slug) {
    console.error('Usage: pnpm preview <slug> [--port N] [--pace strategy|turn-based] [--seed N] [--script file.json]')
    process.exit(1)
  }
  const flag = (name: string) => {
    const i = rest.indexOf(name)
    return i >= 0 ? rest[i + 1] : undefined
  }
  const port = Number(flag('--port') ?? 4321)
  const pace = flag('--pace') as 'strategy' | 'turn-based' | undefined
  const seed = flag('--seed') ? Number(flag('--seed')) : undefined
  const scriptPath = flag('--script')
  const script = scriptPath ? (JSON.parse(await readFile(scriptPath, 'utf8')) as Action[]) : undefined

  const server = http.createServer(async (req, res) => {
    if (req.url && req.url !== '/' && !req.url.startsWith('/?')) {
      res.writeHead(404).end('not found')
      return
    }
    try {
      const body = await page(slug, { pace, seed, script })
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(e instanceof Error ? e.stack ?? e.message : String(e))
    }
  })
  server.listen(port, () => {
    console.log(`\npreview ${slug} → http://localhost:${port}\n(Ctrl-C to stop)`)
  })
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
