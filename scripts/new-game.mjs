#!/usr/bin/env node
/**
 * Scaffold a new game from a template under templates/.
 * Usage: node scripts/new-game.mjs <slug> "<Display Name>" [--pace strategy|turn-based]
 *   e.g. node scripts/new-game.mjs connect-four "Connect Four" --pace turn-based
 *
 * --pace strategy   (default) copies templates/basic-game       (number-duel)
 * --pace turn-based           copies templates/basic-turn-game  (Nim, actor-check)
 */
import { cp, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
let pace = 'strategy'
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--pace') pace = argv[++i]
  else if (argv[i].startsWith('--pace=')) pace = argv[i].slice('--pace='.length)
  else positional.push(argv[i])
}
const [slug, name] = positional

if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
  console.error('Usage: node scripts/new-game.mjs <kebab-slug> "<Display Name>" [--pace strategy|turn-based]')
  process.exit(1)
}
if (pace !== 'strategy' && pace !== 'turn-based') {
  console.error(`--pace must be "strategy" or "turn-based" (got "${pace}")`)
  process.exit(1)
}
const displayName = name || slug

const template = pace === 'turn-based' ? 'basic-turn-game' : 'basic-game'
const src = path.join(ROOT, 'templates', template)
const dst = path.join(ROOT, 'games', slug)
if (existsSync(dst)) {
  console.error(`games/${slug} already exists`)
  process.exit(1)
}

await cp(src, dst, { recursive: true })

async function substitute(dir) {
  for (const e of await readdir(dir)) {
    const full = path.join(dir, e)
    if ((await stat(full)).isDirectory()) await substitute(full)
    else {
      const text = (await readFile(full, 'utf8')).replaceAll('__SLUG__', slug).replaceAll('__NAME__', displayName)
      await writeFile(full, text, 'utf8')
    }
  }
}
await substitute(dst)

console.log(`Created games/${slug} (${pace}, from templates/${template}). Next:`)
console.log('  pnpm install')
console.log(`  # edit games/${slug}/src/game.ts + rules.md`)
console.log(`  pnpm --filter @arena-games/${slug} test`)
console.log('  pnpm validate')
