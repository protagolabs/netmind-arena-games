/**
 * `pnpm preview-world <slug>` — see a world exactly as Arena will run it, with
 * no Arena, no database and no account.
 *
 * The world equivalent of `pnpm preview` for games, and the same promise: the
 * page below is not an approximation of the host, it implements the SAME
 * protocol (`packages/world-sdk/src/protocol.ts`), loads the document the SAME
 * way (`iframe sandbox="allow-scripts"` + `srcdoc` + injected CSP), and enforces
 * the SAME rules the platform enforces — schema, ownership, size, uniqueness,
 * per-author quota. Storage is in-memory instead of Postgres; that is the only
 * difference that matters.
 *
 * Enforcing the rules locally is the point. A world that only meets them in
 * production is a world whose author discovers `quota` and `conflict` from a bug
 * report, and those are the paths most likely to be handled badly.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Ajv from 'ajv/dist/2020.js'
import type { WorldManifest } from '@arena/world-sdk'
import { bundleWorld, worldHtml, readAssets } from './build-worlds.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const slug = process.argv[2]
if (!slug) {
  console.error('usage: pnpm preview-world <slug>')
  process.exit(1)
}

const dir = path.join(ROOT, 'worlds', slug)
if (!existsSync(path.join(dir, 'world.manifest.json'))) {
  console.error(`worlds/${slug}/world.manifest.json not found`)
  process.exit(1)
}

const manifest = JSON.parse(await readFile(path.join(dir, 'world.manifest.json'), 'utf8')) as WorldManifest

// Fail here rather than in the browser: an uncompilable collection schema would
// otherwise present as "every write is rejected", which reads like broken storage.
const ajv = new Ajv({ allErrors: false, strict: false, allowUnionTypes: true })
for (const [name, spec] of Object.entries(manifest.storage?.collections ?? {})) {
  try {
    ajv.compile(spec.schema)
  } catch (err) {
    console.error(`collection '${name}': schema does not compile — ${(err as Error).message}`)
    console.error('(tuples use "prefixItems", not "items": [...])')
    process.exit(1)
  }
}

const doc = worldHtml(await bundleWorld(path.join(dir, manifest.entry)), manifest.displayName)

/**
 * The same `data:` URIs the host would hand over, so `ctx.asset()` resolves here
 * exactly as it does in production rather than throwing for every path.
 */
const assets = await readAssets(dir)

const PORT = Number(process.env.PORT ?? 4321)

const harness = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><title>preview · ${manifest.displayName}</title>
<style>
  html,body{margin:0;height:100%;background:#0b0b0f;color:#f5f5f5;font:13px system-ui}
  #bar{position:fixed;top:0;left:0;right:0;height:38px;display:flex;align-items:center;gap:10px;padding:0 12px;background:#16161a;border-bottom:1px solid rgba(255,255,255,.1);z-index:5}
  #bar b{font-weight:600}
  #bar select,#bar button{background:#0b0b0f;color:#f5f5f5;border:1px solid rgba(255,255,255,.18);border-radius:6px;padding:4px 9px;font:inherit;cursor:pointer}
  #log{margin-left:auto;color:#a1a1aa;font-size:12px;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  iframe{position:fixed;top:38px;left:0;width:100%;height:calc(100% - 38px);border:none}
</style></head>
<body>
<div id="bar">
  <b>${manifest.displayName}</b>
  <span style="color:#a1a1aa">as</span>
  <select id="who">
    <option value="hu_you|human|You">You (human)</option>
    <option value="ag_bot|agent|Painter Bot">Painter Bot (agent)</option>
    <option value="hu_mei|human|Mei">Mei (human)</option>
    <option value="|anon|anonymous">signed out</option>
  </select>
  <button id="theme">light / dark</button>
  <select id="lang" title="Arena language">
    <option value="zh">中文</option>
    <option value="en">English</option>
    <option value="ja">日本語</option>
    <option value="ko">한국어</option>
    <option value="es">Español</option>
    <option value="ru">Русский</option>
    <option value="fr">Français</option>
    <option value="de">Deutsch</option>
    <option value="pt">Português</option>
  </select>
  <button id="wipe">wipe store</button>
  <span id="log"></span>
</div>
<iframe id="frame" sandbox="allow-scripts" srcdoc="__DOC__"></iframe>
<script>
const CH = '__arenaWorld'
const MANIFEST = __MANIFEST__
const ASSETS = __ASSETS__
const COLLECTIONS = (MANIFEST.storage && MANIFEST.storage.collections) || {}

// ── in-memory store, same shape as world_records
let rows = JSON.parse(localStorage.getItem('preview:' + MANIFEST.type) || '[]')
const save = () => localStorage.setItem('preview:' + MANIFEST.type, JSON.stringify(rows))
let seq = rows.reduce((m, r) => Math.max(m, Number(r.id.slice(3)) || 0), 0)
const local = JSON.parse(localStorage.getItem('preview-local:' + MANIFEST.type) || '{}')
const saveLocal = () => localStorage.setItem('preview-local:' + MANIFEST.type, JSON.stringify(local))

let me = { id: 'hu_you', kind: 'human', name: 'You', avatar: null }
let theme = dark()
let lang = 'zh'

function dark() {
  return { mode:'dark', bg:'#0b0b0f', surface:'#16161a', fg:'#f5f5f5', fgSubtle:'#a1a1aa',
           border:'rgba(255,255,255,0.10)', accent:'#e5484d', accentFg:'#ffffff',
           font:'system-ui, -apple-system, "Segoe UI", sans-serif' }
}
function light() {
  return { mode:'light', bg:'#ffffff', surface:'#f7f7f8', fg:'#111827', fgSubtle:'#6b7280',
           border:'rgba(0,0,0,0.10)', accent:'#e5484d', accentFg:'#ffffff',
           font:'system-ui, -apple-system, "Segoe UI", sans-serif' }
}

function log(msg, bad) {
  const el = document.getElementById('log')
  el.textContent = msg
  el.style.color = bad ? '#e5484d' : '#a1a1aa'
}

function fail(code, message, retryAfterSec) { return { code, message, retryAfterSec } }

function readPath(rec, p) {
  const parts = p.split('.')
  let cur = parts[0] === 'author' ? rec.author : rec.payload
  for (const k of parts.slice(1)) { if (cur == null) return undefined; cur = cur[k] }
  return cur
}

function uniqueKey(spec, rec) {
  const tuples = spec.unique || []
  if (!tuples.length) return null
  const parts = []
  for (const t of tuples) for (const p of t) {
    const v = readPath(rec, p)
    if (v === undefined || v === null) return null
    parts.push(p + '=' + String(v))
  }
  return JSON.stringify(parts)
}

const validators = {}
function validate(name, spec, payload) {
  if (!validators[name]) validators[name] = window.__ajv(spec.schema)
  const v = validators[name]
  if (!v(payload)) throw fail('invalid', "payload does not match the schema of '" + name + "': " + (v.errors && v.errors[0] ? (v.errors[0].instancePath || '/') + ' ' + v.errors[0].message : ''))
}

function view(r) { return Object.assign({}, r, { mine: !!me.id && r.author.id === me.id }) }

function live(name) { return rows.filter(r => r.collection === name && !r.deletedAt && r.moderationStatus === 'approved') }

function cmp(op, a, b) {
  switch (op) {
    case 'eq': return a === b
    case 'ne': return a !== b
    case 'gt': return a > b
    case 'gte': return a >= b
    case 'lt': return a < b
    case 'lte': return a <= b
    case 'in': return Array.isArray(b) && b.includes(a)
  }
  return false
}

function ops(name, op, args) {
  const spec = COLLECTIONS[name]
  if (op.indexOf('local.') !== 0 && !spec) throw fail('not-found', "collection '" + name + "' is not declared")

  switch (op) {
    case 'get': {
      const r = live(name).find(r => r.id === args.id)
      return r ? view(r) : null
    }
    case 'list': {
      let items = live(name)
      if (args.mine) { if (!me.id) throw fail('unauthenticated', 'mine=true needs an identity'); items = items.filter(r => r.author.id === me.id) }
      for (const [p, f] of Object.entries(args.where || {})) {
        // Same rule as the platform: only declared index paths are queryable.
        if (p !== 'createdAt' && p !== 'updatedAt' && !(spec.indexes || []).includes(p)) {
          throw fail('invalid', "'" + p + "' is not an indexed field (declare it in the manifest's indexes)")
        }
        for (const [o, v] of Object.entries(f)) items = items.filter(r => cmp(o, p === 'createdAt' ? r.createdAt : readPath(r, p), v))
      }
      const raw = (args.sort && args.sort[0]) || '-createdAt'
      const desc = raw[0] === '-'
      const key = desc ? raw.slice(1) : raw
      items = items.slice().sort((a, b) => {
        const av = key === 'createdAt' || key === 'updatedAt' ? a[key] : readPath(a, key)
        const bv = key === 'createdAt' || key === 'updatedAt' ? b[key] : readPath(b, key)
        return (av < bv ? -1 : av > bv ? 1 : a.id < b.id ? -1 : 1) * (desc ? -1 : 1)
      })
      const start = args.cursor ? items.findIndex(r => r.id === args.cursor) + 1 : 0
      const limit = Math.min(args.limit || 50, 200)
      const page = items.slice(start, start + limit)
      const hasMore = start + limit < items.length
      return { items: page.map(view), cursor: hasMore && page.length ? page[page.length - 1].id : null, hasMore }
    }
    case 'count': {
      let items = live(name)
      if (args.mine) items = items.filter(r => r.author.id === me.id)
      for (const [p, f] of Object.entries(args.where || {}))
        for (const [o, v] of Object.entries(f)) items = items.filter(r => cmp(o, readPath(r, p), v))
      return items.length
    }
    case 'add': {
      if (!me.id && !spec.anonymousCanWrite) throw fail('unauthenticated', "collection '" + name + "' requires an identity")
      const bytes = new Blob([JSON.stringify(args.payload ?? null)]).size
      if (bytes > spec.maxRecordBytes) throw fail('too-large', 'payload is ' + bytes + ' bytes; max ' + spec.maxRecordBytes)
      validate(name, spec, args.payload)
      if (spec.maxRecordsPerAuthor != null && live(name).filter(r => r.author.id === me.id).length >= spec.maxRecordsPerAuthor)
        throw fail('quota', 'you already have ' + spec.maxRecordsPerAuthor + " record(s) in '" + name + "'")
      const now = new Date().toISOString()
      const rec = { id: 'wr_' + (++seq), collection: name, author: Object.assign({}, me), payload: args.payload,
                    version: 1, schemaVersion: MANIFEST.schemaVersion, moderationStatus: 'approved',
                    createdAt: now, updatedAt: now }
      const k = uniqueKey(spec, rec)
      if (k && live(name).some(r => uniqueKey(spec, r) === k)) throw fail('unique', "this violates a uniqueness rule of '" + name + "'")
      rows.push(rec); save()
      return view(rec)
    }
    case 'put':
    case 'patch': {
      if (spec.write === 'none') throw fail('forbidden', "collection '" + name + "' is append-only")
      const rec = live(name).find(r => r.id === args.id)
      if (!rec) throw fail('not-found', 'record not found')
      if (!me.id) throw fail('unauthenticated', 'this action requires an identity')
      if (spec.write !== 'anyone' && rec.author.id !== me.id) throw fail('forbidden', 'you can only modify your own records')
      if (args.version != null && args.version !== rec.version)
        throw fail('conflict', 'record was modified by someone else (expected version ' + args.version + ')')
      const payload = op === 'put' ? args.payload : Object.assign({}, rec.payload, args.partial)
      const bytes = new Blob([JSON.stringify(payload ?? null)]).size
      if (bytes > spec.maxRecordBytes) throw fail('too-large', 'payload is ' + bytes + ' bytes; max ' + spec.maxRecordBytes)
      validate(name, spec, payload)
      rec.payload = payload; rec.version++; rec.updatedAt = new Date().toISOString(); save()
      return view(rec)
    }
    case 'del': {
      const rec = live(name).find(r => r.id === args.id)
      if (!rec) throw fail('not-found', 'record not found')
      if (spec.write !== 'anyone' && rec.author.id !== me.id) throw fail('forbidden', 'you can only modify your own records')
      rec.deletedAt = new Date().toISOString(); save()
      return null
    }
    case 'local.get': return local[me.id + ':' + args.key] ?? null
    case 'local.set': local[me.id + ':' + args.key] = args.value; saveLocal(); return null
    case 'local.del': delete local[me.id + ':' + args.key]; saveLocal(); return null
  }
  throw fail('forbidden', 'operation not permitted')
}

const frame = document.getElementById('frame')

function post(msg) { frame.contentWindow.postMessage(Object.assign({ [CH]: true }, msg), '*') }

function sendInit() {
  const seed = {}
  for (const name of Object.keys(COLLECTIONS)) seed[name] = ops(name, 'list', { limit: 50 })
  post({ type: 'init',
         world: { type: MANIFEST.type, displayName: MANIFEST.displayName, schemaVersion: MANIFEST.schemaVersion },
         me: me.id ? me : null, theme, lang, assets: ASSETS, seed })
}

window.addEventListener('message', (e) => {
  if (e.source !== frame.contentWindow) return
  const d = e.data
  if (!d || d[CH] !== true) return

  if (d.type === 'ready') { log('world ready'); sendInit(); return }
  if (d.type === 'failed') { log('WORLD ERROR: ' + d.message, true); console.error('world error:', d.message); return }
  if (d.type !== 'request') return

  try {
    const result = ops(d.collection, d.op, d.args || {})
    log(d.op + ' ' + (d.collection || '') + ' ok')
    post({ type: 'result', id: d.id, ok: true, result: result ?? null })
  } catch (err) {
    const e2 = err && err.code ? err : { code: 'unavailable', message: String((err && err.message) || err) }
    log(d.op + ' ' + (d.collection || '') + ' → ' + e2.code + ': ' + e2.message, true)
    post({ type: 'result', id: d.id, ok: false, error: e2 })
  }
})

document.getElementById('who').onchange = (e) => {
  const [id, kind, name] = e.target.value.split('|')
  me = { id, kind, name: name || 'anonymous', avatar: null }
  // Identity changes what 'mine' means on every record, so reload the world
  // rather than trying to patch its state from outside.
  frame.contentWindow.location.reload()
  setTimeout(() => log('now acting as ' + me.name), 100)
}
document.getElementById('theme').onclick = () => { theme = theme.mode === 'dark' ? light() : dark(); post({ type: 'env', theme }) }
// A two-way toggle could only ever exercise two of the nine languages a real
// visitor can pick, which is not enough to find a world that only handles those.
const langSel = document.getElementById('lang')
langSel.value = lang
langSel.onchange = () => { lang = langSel.value; post({ type: 'env', lang }) }
document.getElementById('wipe').onclick = () => { rows = []; save(); for (const k of Object.keys(local)) delete local[k]; saveLocal(); frame.contentWindow.location.reload() }
</script>
<script src="/ajv.js"></script>
</body></html>`

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0]!

  if (url === '/ajv.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(await buildAjvShim())
    return
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(
    harness
      .replace('__DOC__', doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;'))
      // Function replacers: a `$&` or `$1` inside a schema or a base64 payload is
      // a substitution pattern to `String.replace`, and would corrupt the value.
      .replace('__MANIFEST__', () => JSON.stringify(manifest))
      .replace('__ASSETS__', () => JSON.stringify(assets)),
  )
})

/**
 * Ajv is a Node library, so the harness needs a browser copy. esbuild is already
 * a dependency and bundles it in one step — more robust than ajv's standalone
 * codegen, whose `standaloneCode(ajv, validate)` signature is easy to get wrong
 * and fails only at request time.
 */
let ajvBundle: string | null = null
async function buildAjvShim(): Promise<string> {
  if (ajvBundle) return ajvBundle
  const esbuild = await import('esbuild')
  const out = await esbuild.build({
    stdin: {
      contents: `
        import Ajv from 'ajv/dist/2020'
        const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })
        const cache = new Map()
        window.__ajv = (schema) => {
          const key = JSON.stringify(schema)
          if (!cache.has(key)) cache.set(key, ajv.compile(schema))
          return cache.get(key)
        }
      `,
      resolveDir: ROOT,
      loader: 'js',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'silent',
  })
  ajvBundle = out.outputFiles?.[0]?.text ?? ''
  if (!ajvBundle) throw new Error('failed to bundle ajv for the harness')
  return ajvBundle
}

server.listen(PORT, () => {
  console.log(`\n  ${manifest.displayName}  →  http://localhost:${PORT}\n`)
  console.log('  Same protocol, same sandbox, same CSP as production; storage is in-memory')
  console.log('  (persisted to localStorage so a reload keeps what you made).')
  console.log('  Switch identity in the top bar to see another visitor’s view.\n')
})
