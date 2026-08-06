#!/usr/bin/env node
/**
 * Scaffold a new world: `pnpm new-world <slug> "Display Name"`.
 *
 * Writes a working, publishable world — one collection, one editable record per
 * visitor — rather than an empty skeleton, so the first thing an author does is
 * `pnpm validate` and see it pass. Everything after that is editing.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const slug = process.argv[2]
const displayName = process.argv[3] ?? slug

if (!slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
  console.error('usage: pnpm new-world <kebab-case-slug> "Display Name"')
  process.exit(1)
}

const dir = path.join(ROOT, 'worlds', slug)
if (existsSync(dir)) {
  console.error(`worlds/${slug} already exists`)
  process.exit(1)
}

// A world type shares a namespace with game types — `/worlds/x` and the game
// catalog cannot both mean `x`. CI checks this too; catching it here saves the
// author from finding out after they have written the thing.
const gamesDir = path.join(ROOT, 'games')
if (existsSync(path.join(gamesDir, slug))) {
  console.error(`'${slug}' collides with games/${slug}`)
  process.exit(1)
}

const manifest = {
  type: slug,
  kind: 'world',
  displayName,
  sdkVersion: '0.0.1',
  entry: 'src/world.ts',
  schemaVersion: 1,
  supportedSchemaVersions: [1],
  storage: {
    collections: {
      marks: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string', minLength: 1, maxLength: 200 } },
        },
        write: 'owner',
        maxRecordBytes: 512,
        maxRecordsPerAuthor: 1,
      },
    },
    quota: { totalRecords: 50000, writesPerHourPerAuthor: 60 },
  },
  presentation: { surface: 'fullscreen', cover: 'cover.svg', audio: false },
  about: 'about.md',
}

const world = `import { defineWorld } from '@arena/world-sdk'

interface Mark {
  text: string
}

export default defineWorld({
  meta: { type: '${slug}' },

  async mount(root, ctx) {
    const marks = ctx.collection<Mark>('marks')

    // The host pre-fetched the first page into \`init\`, so this resolves without
    // a round trip and the world is never blank on arrival.
    const { items } = await marks.list({ limit: 50, sort: ['-createdAt'] })

    root.style.cssText = \`margin:0;height:100%;overflow-y:auto;background:\${ctx.theme.bg};color:\${ctx.theme.fg};font-family:\${ctx.theme.font};padding:32px\`
    root.innerHTML = ''

    const title = document.createElement('h1')
    title.textContent = '${displayName}'
    title.style.cssText = 'margin:0 0 16px;font-size:20px'
    root.appendChild(title)

    const list = document.createElement('div')
    list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:24px'
    for (const mark of items) {
      const row = document.createElement('div')
      row.style.cssText = \`padding:10px 12px;border:1px solid \${ctx.theme.border};border-radius:8px;font-size:14px\`
      row.textContent = \`\${mark.author.name}: \${mark.payload.text}\`
      list.appendChild(row)
    }
    root.appendChild(list)

    if (!ctx.me) {
      const hint = document.createElement('p')
      hint.style.cssText = \`font-size:13px;color:\${ctx.theme.fgSubtle}\`
      hint.textContent = 'Sign in to leave a mark.'
      root.appendChild(hint)
      return
    }

    const input = document.createElement('input')
    input.placeholder = 'Leave a mark…'
    input.style.cssText = \`padding:10px;border-radius:8px;border:1px solid \${ctx.theme.border};background:\${ctx.theme.surface};color:\${ctx.theme.fg};font:inherit\`
    root.appendChild(input)

    // \`quota\`, \`rate-limited\` and \`conflict\` are ordinary outcomes in a shared
    // world, not exceptional ones — so a world must always show them.
    //
    // It must show them in its OWN DOM: the sandbox is \`allow-scripts\` without
    // \`allow-modals\`, so \`alert()\` / \`confirm()\` / \`prompt()\` are ignored by the
    // browser and an error reported that way is an error nobody ever sees.
    const status = document.createElement('p')
    status.style.cssText = \`font-size:13px;min-height:18px;color:\${ctx.theme.fgSubtle}\`
    root.appendChild(status)

    const say = (msg: string, bad = false) => {
      status.textContent = msg
      status.style.color = bad ? ctx.theme.accent : ctx.theme.fgSubtle
    }

    input.onkeydown = (e) => {
      if (e.key !== 'Enter' || !input.value.trim()) return
      void marks
        .add({ text: input.value.trim() })
        .then(() => {
          input.value = ''
          // Reloading is the simplest correct thing here; a real world would
          // append the returned record instead.
          location.reload()
        })
        .catch((err: Error) => say(err.message, true))
    }
  },
})
`

const cover = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 350">
  <rect width="800" height="350" fill="#0b0b0f"/>
  <circle cx="400" cy="150" r="60" fill="none" stroke="rgba(255,255,255,0.14)"/>
  <text x="60" y="285" fill="#f5f5f5" font-family="system-ui" font-size="30">${displayName}</text>
  <text x="60" y="315" fill="#a1a1aa" font-family="system-ui" font-size="15">A world in progress.</text>
</svg>
`

const about = `# ${displayName}

Describe the world here. This text is shown on its home-page card and on its own
page.

Worlds are unscored: no entry fee, no prize, no ranking. What they accumulate is
what visitors leave behind.
`

const pkg = {
  name: `@arena-worlds/${slug}`,
  version: '0.1.0',
  private: true,
  type: 'module',
  main: './src/world.ts',
  scripts: { typecheck: 'tsc --noEmit' },
  dependencies: { '@arena/world-sdk': 'workspace:*' },
  devDependencies: { typescript: '^5.6.3' },
}

const tsconfig = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    lib: ['ES2022', 'DOM'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
  },
  include: ['src/**/*'],
}

await mkdir(path.join(dir, 'src'), { recursive: true })
await writeFile(path.join(dir, 'world.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
await writeFile(path.join(dir, 'src/world.ts'), world)
await writeFile(path.join(dir, 'cover.svg'), cover)
await writeFile(path.join(dir, 'about.md'), about)
await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
await writeFile(path.join(dir, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`)

// Sanity: the workspace must include worlds/* or the SDK dependency won't link.
const workspace = await readFile(path.join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
if (!workspace.includes('worlds/*')) {
  console.warn("! pnpm-workspace.yaml is missing 'worlds/*' — add it before installing")
}

console.log(`created worlds/${slug}

  pnpm install
  pnpm validate     # manifest + storage + self-contained build
  pnpm build:bundles

Then edit src/world.ts and world.manifest.json.
See packages/world-sdk/src/types.ts for the full ctx contract.`)
