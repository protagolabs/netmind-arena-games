#!/usr/bin/env node
/**
 * Scaffold a new game from templates/basic-game.
 * Usage: node scripts/new-game.mjs <slug> "<Display Name>"
 *   e.g. node scripts/new-game.mjs connect-four "Connect Four"
 */
import { cp, readdir, readFile, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [slug, name] = process.argv.slice(2)

if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
  console.error('Usage: node scripts/new-game.mjs <kebab-slug> "<Display Name>"')
  process.exit(1)
}
const displayName = name || slug

const src = path.join(ROOT, 'templates', 'basic-game')
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

console.log(`Created games/${slug}. Next:`)
console.log('  pnpm install')
console.log(`  # edit games/${slug}/src/game.ts + rules.md`)
console.log(`  pnpm --filter @arena-games/${slug} test`)
console.log('  pnpm validate')
