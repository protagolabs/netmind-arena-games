/**
 * Flatten dist/ into release/ for GitHub Release assets.
 *
 * Release assets are a FLAT list of files (no subdirs), so we copy each artifact
 * to release/<basename> and rewrite index.json's bundle/rules/view paths to those
 * basenames. The backend then loads from
 *   ARENA_GAMES_INDEX=https://github.com/<owner>/<repo>/releases/latest/download/index.json
 * and resolves each `bundle:"gomoku.js"` as a sibling flat asset. Only filenames
 * change — bundle bytes are untouched, so contentHash/viewContentHash still verify.
 *
 * Run after `pnpm build:bundles`:  pnpm pack:release
 */
import { readFile, writeFile, copyFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(ROOT, 'release')

interface IndexEntry {
  type: string
  bundle: string
  rules: string | null
  view?: string | null
  [k: string]: unknown
}

async function main() {
  const index = JSON.parse(await readFile(path.join(DIST, 'index.json'), 'utf8')) as {
    version: number
    games: IndexEntry[]
  }

  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  const seen = new Set<string>()
  const flatten = async (rel: string): Promise<string> => {
    const base = path.basename(rel)
    if (seen.has(base) && rel !== base) throw new Error(`flat filename collision: ${base} (from ${rel})`)
    seen.add(base)
    await copyFile(path.join(DIST, rel), path.join(OUT, base))
    return base
  }

  for (const g of index.games) {
    g.bundle = await flatten(g.bundle)
    if (g.rules) g.rules = await flatten(g.rules)
    if (g.view) g.view = await flatten(g.view)
  }

  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 2), 'utf8')
  console.log(`packed ${index.games.length} game(s) → release/ (${seen.size + 1} flat assets + index.json)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
