/**
 * three.js access for this world, via a vendored subset bundle.
 *
 * A world submission may only touch worlds/<slug>/ (path-guard), so three
 * cannot be a package.json dependency — that would edit the root lockfile.
 * Instead, tools/three-entry.ts lists the ~45 three/src modules this world
 * renders with, and src/vendor/three-core.js is esbuild's unminified bundle
 * of exactly that graph (regeneration steps in its banner). The loader
 * modules — the only ones in three that name network APIs — are not in the
 * entry list, which `pnpm validate`'s bundle scan re-checks on every build.
 * Types are hand-declared in src/vendor/three-core.d.ts for the same reason.
 */
export * from './vendor/three-core.js'
