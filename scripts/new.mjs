#!/usr/bin/env node
/**
 * `pnpm new <game|world> <slug> "Display Name"` — scaffold a product.
 *
 * One command for both kinds, because a slug is a **product** slug: `games/x`
 * and `worlds/x` cannot both exist, the build puts both kinds in one index, and
 * the catalog shows them in one list. Two scaffolding commands made that look
 * like two namespaces.
 *
 * This is a DISPATCHER. `new-game.mjs` copies a template directory and
 * `new-world.mjs` writes its files from inline literals — two working
 * implementations with nothing in common, and merging them would mean rewriting
 * 8KB of scaffolding to save a `spawn`. So the kind-specific work stays where it
 * is and keeps its own flags (`--pace` is games-only); both remain directly
 * invocable.
 *
 * What DOES belong here is the part that is true of both, and was previously
 * true of neither consistently:
 *
 *   1. One slug rule. `new-game.mjs` accepted `-foo`, `foo-` and `a--b`;
 *      `new-world.mjs` did not. Under one command, a slug that is legal for one
 *      kind and rejected by the other is a bug report.
 *   2. Collision checked BOTH ways. `new-world.mjs` refuses a slug that collides
 *      with a game; `new-game.mjs` never checked worlds. The shared namespace was
 *      enforced in one direction only — a game could take a world's name and the
 *      author would not hear about it until `pnpm validate`.
 *
 * Spawn rather than import: both targets are top-level-await scripts that call
 * `process.exit()`, so importing one would end this process on its first error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The two kinds, and the directory each lives in. */
const KINDS = { game: 'games', world: 'worlds' }

/** The stricter of the two historical rules: no leading, trailing or doubled hyphen. */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

const [kind, slug, ...rest] = process.argv.slice(2)

function die(message) {
  console.error(message)
  process.exit(1)
}

if (!kind || !(kind in KINDS)) {
  die(
    `usage: pnpm new <${Object.keys(KINDS).join('|')}> <kebab-case-slug> "Display Name"\n\n` +
      '  pnpm new game  connect-four "Connect Four"   # scored, deterministic, pays credits\n' +
      '  pnpm new world drift-bottle "Drift Bottle"   # unscored, runs in the browser\n\n' +
      'Not sure which? See AGENTS.md §0.'
  )
}

if (!slug || !SLUG.test(slug)) {
  die(
    `'${slug ?? ''}' is not a valid slug.\n` +
      'Lowercase letters and digits, single hyphens between them: `drift-bottle`, not `-drift`, `drift-` or `drift--bottle`.'
  )
}

// Both directions. A product has one slug across both kinds.
for (const [otherKind, dir] of Object.entries(KINDS)) {
  if (existsSync(path.join(ROOT, dir, slug))) {
    die(
      otherKind === kind
        ? `${dir}/${slug} already exists.`
        : `'${slug}' is taken by ${dir}/${slug}.\n` +
            'Games and worlds share one slug namespace — the build puts both in one index.'
    )
  }
}

const result = spawnSync('node', [path.join(ROOT, 'scripts', `new-${kind}.mjs`), slug, ...rest], {
  stdio: 'inherit',
  cwd: ROOT,
})

// Surface a killed child as a failure rather than as success — `status` is null
// when the process died on a signal.
process.exit(result.status ?? 1)
