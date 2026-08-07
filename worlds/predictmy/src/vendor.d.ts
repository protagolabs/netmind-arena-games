/**
 * The vendored build has no types and needs none.
 *
 * `src/vendor/**` is predictmy.ai's own minified output, copied in by
 * `tools/extract.mjs`. Nothing imports a value from it — `src/world.ts` imports
 * the entry purely for its side effect of building the page — so a module
 * declaration is the whole contract. Generating types for a minified bundle
 * would describe mangled identifiers that change on the source's next deploy.
 */
declare module '*/vendor/main.js'
