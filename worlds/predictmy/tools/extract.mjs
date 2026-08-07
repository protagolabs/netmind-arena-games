#!/usr/bin/env node
/**
 * Generate `src/original.ts` and `src/vendor/**` from a snapshot of predictmy.ai.
 *
 * The design IS the deployed build: its stylesheet, its markup, its engine. Any
 * of it re-typed by hand would drift into "close but wrong", so all of it is
 * copied verbatim and the world imports it. What this script does is the three
 * things the sandbox makes non-negotiable:
 *
 *   1. `connect-src 'none'` — every `fetch` is rewritten to `arenaFetch`, a local
 *      router in `src/shim.ts`. This is a rename, not an excision: the page keeps
 *      its loading states, its retry loop and its error branches, and they run
 *      against answers produced in-frame. Rewriting the ONE call site shape is
 *      also the only patch here robust against minification, since every other
 *      anchor in this build is a mangled identifier.
 *
 *   2. `localStorage` / `sessionStorage` throw on an opaque origin — rewritten to
 *      `arenaLS` / `arenaSS`, which `src/shim.ts` backs with `ctx.local` and an
 *      in-memory map respectively.
 *
 *   3. The document is loaded through `srcdoc`, so nothing may be fetched at
 *      runtime: chunks are copied in as real modules under `src/vendor/` (esbuild
 *      inlines them at build time) and Vite's modulepreload helper is defused, so
 *      it stops appending <link> elements for URLs that cannot resolve.
 *
 * Deliberately dropped, none of it part of the simulator:
 *
 *   - Google Tag Manager and Vercel Insights — head scripts, never copied. The
 *     CSP would block them anyway; leaving them in would only produce console
 *     noise that reads as a broken port.
 *   - `/api/ping` telemetry, and the invite-code funnel (`/api/session` gating,
 *     `/api/join`, `/api/request-invite`). Arena is not an acquisition surface
 *     for a third party, so the world opens ungated. `src/shim.ts` answers those
 *     routes rather than removing their call sites, which keeps this a port.
 *
 * Run: `node tools/extract.mjs <snapshot-dir>`
 * where <snapshot-dir> holds `index.html`, `assets/*.js` and `img/*`.
 */
import { readFile, writeFile, mkdir, readdir, copyFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORLD = path.join(HERE, '..')

const snapshot = process.argv[2]
if (!snapshot) {
  console.error('usage: node tools/extract.mjs <snapshot-dir>')
  process.exit(1)
}

const fail = (msg) => {
  console.error(`\n${msg}`)
  process.exit(1)
}

/* ── index.html → CSS + markup ─────────────────────────────────────────── */

const html = await readFile(path.join(snapshot, 'index.html'), 'utf8')

/**
 * Both <style> blocks, in document order. The second one (`id="metal-theme"`)
 * carries the broadcast chrome — the channel plate, the remote's brushed-metal
 * shell — so a port that took only the first would render the right layout in
 * the wrong skin.
 */
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
if (styles.length !== 2) fail(`expected 2 <style> blocks, found ${styles.length} — index.html changed shape`)
let css = styles.join('\n')

let markup = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
if (markup.length < 4000) fail('body markup looks truncated — index.html changed shape')

/**
 * Rewrite the three real images to asset tokens.
 *
 * They are re-encoded to WebP in `assets/` (the PNGs total 6.6MB against a 2MB
 * ceiling, since assets are inlined into `index.json`), and `src/world.ts`
 * swaps each token for the `data:` URI `ctx.asset()` returns.
 */
const IMAGES = {
  '/logo.png': 'assets/logo.webp',
  '/stadium-daytime.png': 'assets/stadium-daytime.webp',
  '/stadium-night.png': 'assets/stadium-night.webp',
}
const token = (rel) => `__ARENA_ASSET__${rel}__`

let swapped = 0
for (const [from, rel] of Object.entries(IMAGES)) {
  const re = new RegExp(from.replace(/[/.]/g, '\\$&'), 'g')
  const before = css + markup
  css = css.replace(re, token(rel))
  markup = markup.replace(re, token(rel))
  if (before === css + markup) fail(`image ${from} no longer referenced — index.html changed shape`)
  swapped++
}

/**
 * The nav's off-document links.
 *
 * `/wcmode/` is a second application page, `/predict/` and `/letter/` are static
 * prose. A world is ONE document with no navigation — `frame-src` and
 * `form-action` are `'none'` and there is nowhere for a link to go — so these
 * are neutralised rather than left to look clickable and do nothing.
 */
const OFF_DOCUMENT = ['/wcmode/', '/predict/', '/letter/']
for (const href of OFF_DOCUMENT) {
  markup = markup.replaceAll(`href="${href}"`, 'href="#" data-arena-offsite="1"')
}

// The chat pane's invite link has no id to hide by: it is built at runtime as
// the only `<a>` inside `.chat-empty`.
if (!css.includes('.chat-empty')) fail('.chat-empty rule not found — the chat pane changed shape')

/**
 * Controls hidden because the platform, not the page, now answers for them.
 *
 * Hidden and not cut out: `#waitlistBtn` is load-bearing — the build does
 * `document.getElementById("waitlistBtn")` at boot and dereferences the result a
 * few statements later, so removing the element replaces a stray button with a
 * blank world. The same is true of the others, so all of them stay in the DOM
 * and lose only their pixels.
 */
const HIDDEN = {
  /** Nothing is gated: `src/shim.ts` answers `/api/session` with `gated: false`. */
  '#waitlistBtn': 'the invite gate',
  /**
   * Arena owns language and theme (docs/worlds.md, "Language and theme"): a world
   * that follows `ctx.lang`/`ctx.theme` must not also ship its own switcher, or a
   * visitor gets two controls for one setting and they disagree.
   */
  '#langBtn': "Arena's language header",
  '#themeBtn': "Arena's theme header",
  /**
   * The small-screen menu is the third control for both — its `#lang` and
   * `#theme` entries reach the same functions the buttons above do. Its other
   * seven entries are `/wcmode/`, `/versus/`, `/letter/`, `/guide/`, `/roadmap/`
   * and the waitlist, so once those two are gone nothing in it can work at all.
   */
  '#mobileMenuBtn': 'a duplicate of both, plus off-document links',
}
for (const id of Object.keys(HIDDEN)) {
  if (!markup.includes(`id="${id.slice(1)}"`)) fail(`${id} not found — index.html changed shape`)
}
css += `

/* Added by tools/extract.mjs. ${Object.entries(HIDDEN)
  .map(([id, why]) => `${id}: ${why}`)
  .join('; ')}. */
${Object.keys(HIDDEN).join(', ')}, .chat-empty a { display: none !important; }
`

/* ── assets/*.js → src/vendor/**  ──────────────────────────────────────── */

const VENDOR = path.join(WORLD, 'src', 'vendor')
await rm(VENDOR, { recursive: true, force: true })
await mkdir(VENDOR, { recursive: true })

/**
 * `/wcmode/`'s entry is deliberately not vendored.
 *
 * It is a SECOND page of the application. It shares every chunk the home page
 * already loads and costs only 17KB more, so size is not the reason — the reason
 * is that a world is one document, and both entries bind listeners to `document`
 * at import time and run once. Hosting both would mean tearing `main.js` back
 * down to swap to it, which the source has no teardown for. The nav entry points
 * at it are neutralised in the markup instead.
 */
const SKIP = /^wc-/

const assetDir = path.join(snapshot, 'assets')
const files = (await readdir(assetDir)).filter((f) => f.endsWith('.js') && !SKIP.test(f))
if (!files.length) fail('no chunks in <snapshot>/assets')

/** `main-BHk1A6pJ.js` → `main.js`. Hashes churn on every deploy; names do not. */
const stable = (f) => f.replace(/-[A-Za-z0-9_-]{8}\.js$/, '.js')
const nameMap = new Map(files.map((f) => [f, stable(f)]))
for (const [from, to] of nameMap) {
  if (from === to) fail(`chunk '${from}' has no build hash to strip — naming scheme changed`)
}

const counts = { fetch: 0, local: 0, session: 0, preload: 0, specifier: 0, busy: 0, nav: 0, applyLang: 0 }

for (const [file, out] of nameMap) {
  let src = await readFile(path.join(assetDir, file), 'utf8')

  // Cross-chunk imports, static and dynamic, follow the rename.
  for (const [from, to] of nameMap) {
    const re = new RegExp(`\\./${from.replace(/[.\-]/g, '\\$&')}`, 'g')
    const hits = src.match(re)
    if (hits) {
      counts.specifier += hits.length
      src = src.replace(re, `./${to}`)
    }
  }

  // 1. The network. `arenaFetch` also collects Vite's preload polyfill, which is
  //    the one caller here that is not an /api/ route — the router answers it
  //    with an empty 200 rather than special-casing it at the call site.
  counts.fetch += (src.match(/\bfetch\s*\(/g) ?? []).length
  src = src.replace(/\bfetch\s*\(/g, 'arenaFetch(')

  // 2. Storage. Both throw on an opaque origin.
  counts.local += (src.match(/\blocalStorage\b/g) ?? []).length
  src = src.replace(/\blocalStorage\b/g, 'arenaLS')
  counts.session += (src.match(/\bsessionStorage\b/g) ?? []).length
  src = src.replace(/\bsessionStorage\b/g, 'arenaSS')

  // 3. Why the coach fell back to local parsing.
  //
  //    The page already HAS this path: when `/api/chat` answers 429 it prints
  //    this line and parses the order with its own bilingual rule engine (`Dt`
  //    in redeemCode). `src/shim.ts` returns 429 always, so the fallback becomes
  //    the only path — which is why the port needs no parser of its own.
  //
  //    Only the reason is wrong. Nobody's quota is full; an Arena world has no
  //    network. Saying so costs two strings and stops the world from blaming a
  //    limit that does not exist. The other seven locales hold this string in a
  //    minified variable rather than inline, and are left as they shipped.
  for (const [from, to] of [
    ['教练 AI 额度已满，已用本地解析（游戏照常）', '教练 AI 需要联网，Arena 世界里没有网络 —— 已用本地解析（游戏照常）'],
    [
      'Coach AI limit reached — used local parsing (game unaffected)',
      'Coach AI needs the network, and an Arena world has none — used local parsing (game unaffected)',
    ],
  ]) {
    if (src.includes(from)) {
      src = src.replace(from, to)
      counts.busy++
    }
  }

  // 4. Vite's modulepreload helper. esbuild inlines every dynamic import at
  //    build time, so the deps this walks are already in the document; left
  //    alone it appends <link rel="modulepreload"> for /assets/* URLs that
  //    cannot resolve from an opaque origin. Skipping the branch keeps the
  //    helper's contract (it still returns the factory's promise) and drops
  //    only the preloading.
  const defused = src.replace(
    'let e=Promise.resolve();if(a&&a.length>0){',
    'let e=Promise.resolve();if(false){',
  )
  if (defused !== src) counts.preload++
  src = defused

  /**
   * Publish the source's own apply-language function.
   *
   * The page reads `aa_lang` from storage exactly once, at boot, and thereafter
   * only re-renders when its own language button calls this. Arena owns language
   * here and that button is hidden, so without a handle on the function a switch
   * in Arena's header writes storage and changes nothing on screen.
   *
   * Anchored on the line where the source already invokes it. The identifiers
   * are minified and will be renamed on the next deploy, which is exactly why
   * this lives in the extractor with an assertion rather than as a hand-edit to
   * a vendored file — a hand-edit would simply stop applying, silently.
   */
  // 5. Navigation out of the document.
  //
  //    The two nav dropdowns and the small-screen menu answer a choice with
  //    `location.href = <path>`. A world is loaded through `srcdoc` onto an
  //    opaque origin, so those paths resolve against nothing and the click does
  //    nothing at all — a menu that opens, takes a selection, and silently
  //    ignores it. Routing them through the world lets it say where the page
  //    went, which is what the markup's own `<a href>` links already do.
  //    Both spellings: the menus assign a variable, and the remote's "predict
  //    this match" button assigns a LITERAL (`location.href="/wcmode/?guide=sim"`).
  //    Matching only `\w+` left that button reaching for a path that resolves
  //    against nothing — a control that looks alive, takes the click, and does
  //    nothing at all, which is the exact failure this rewrite exists to prevent.
  const NAV = /location\.href\s*=\s*(\w+|"[^"]*"|'[^']*'|`[^`]*`)/g
  const nav = (src.match(NAV) ?? []).length
  if (nav) {
    counts.nav = (counts.nav ?? 0) + nav
    src = src.replace(NAV, 'globalThis.__arenaOffsite($1)')
  }

  /**
   * 7. Let the phase banner fit the names it is given.
   *
   * `drawPhaseBanner` scales its whole layout by `min(1, cssW/1000)` — it clearly
   * MEANS to fit, it just never measures the text. The kickoff card draws each
   * team's full name outward from the centre at 46px, so a long one runs off the
   * edge of the picture: "Bosnia and Herzegovina" needs 577px against the 500px
   * the half-width allows, and arrives on screen as "Bosnia and Herzegovi".
   *
   * This is the source's own defect — the deployed site's canvas is the same
   * 990px and clips it identically — and it only shows for the handful of
   * fixtures with long names, which is why it survived. The rewrite hands the
   * scale to a function that finishes the calculation the source started; see
   * `__arenaFitBanner` in `src/world.ts`. The `??` keeps the original expression
   * as the answer if the world has not installed it.
   *
   * `Math.min(1,this.cssW/1e3)` appears twice — the goal celebration uses the
   * same figure — so the anchor includes the translate that precedes only this
   * one, and the `e.scale` that follows it.
   */
  {
    const before = src
    src = src.replace(
      /(e\.translate\(this\.cssW\/2,this\.cssH\/2\);const (\w+)=)Math\.min\(1,this\.cssW\/1e3\)(;e\.scale\(\2,\2\))/,
      (_m, head, _name, tail) =>
        `${head}(globalThis.__arenaFitBanner?.(this.cssW)??Math.min(1,this.cssW/1e3))${tail}`,
    )
    if (src !== before) counts.fitBanner = (counts.fitBanner ?? 0) + 1
  }

  if (out === 'main.js') {
    const before = src
    src = src.replace(
      /(arenaLS\.getItem\("aa_lang"\)[\s\S]{0,120}?\}catch\{\})(\w+)\(\w+\);/,
      (m, head, applyFn) => `${m}globalThis.__arenaApplyLang=${applyFn};`,
    )
    if (src === before) {
      fail(
        'could not publish the apply-language function in main.js — its boot ' +
          'sequence changed shape. Arena language switching is dead without it; ' +
          'find where the source calls its own apply function after reading ' +
          'aa_lang and re-anchor.',
      )
    }
    counts.applyLang = 1

    /**
     * 6. Publish read-only handles on the match state and the i18n table.
     *
     * Arena's scoreboard needs three things the source keeps module-private: the
     * live score, the team names, and the current language. The source never
     * shows a running score anywhere but inside the coach panel, so a visitor
     * watching a match has no idea what it is — `src/world.ts` draws a broadcast
     * score bar from these, which is the one place this port ADDS to the design
     * rather than carrying it across.
     *
     * Appended at the END of the module rather than injected at a call site.
     * Every top-level binding is still in scope there, so this needs no anchor
     * into the middle of minified code that a redeploy would move — the only
     * things that must be identified are the NAMES, and those are found from
     * shapes that survive minification (a template literal in the panel, and the
     * import list).
     *
     * `() => state` rather than the value: the source REASSIGNS the match state
     * on every reset, so a captured reference would go stale the first time
     * someone restarts the match and the bar would freeze on a finished game.
     */
    const state = src.match(/\$\{(\w+)\.score\[0\]\}[^$]*\$\{\1\.score\[1\]\}/)?.[1]
    const imports = src.match(/import\{([^}]*)\}from"\.\/navIcons\.js"/)?.[1] ?? ''
    const translate = imports.match(/\bt as (\w+)/)?.[1]
    const langOf = imports.match(/\ba as (\w+)/)?.[1]
    /**
     * The CURRENT match's team codes, which are not the same thing as the
     * default team names in the i18n table.
     *
     * `team0` / `team1` translate to whoever the demo match is between. Change
     * the channel to a real fixture and the engine plays USA v Bosnia while
     * those keys still say Portugal and Argentina — a scoreboard reading off the
     * i18n table announces the wrong two countries and looks authoritative doing
     * it. This getter is the source's own, reset with every fixture load, and
     * `main.js` builds its own team labels from it.
     */
    const redeem = src.match(/import\{([^}]*)\}from"\.\/redeemCode\.js"/)?.[1] ?? ''
    const teamCode = redeem.match(/\bb as (\w+)/)?.[1]
    /**
     * The colour each side's dots are drawn in, from the same store as the codes.
     *
     * A scoreboard that names two teams still leaves the question the pitch
     * actually asks — which of those two is the yellow one. The engine already
     * knows; this is the answer it draws with.
     */
    const teamFill = redeem.match(/\bt as (\w+)/)?.[1]
    /**
     * The fixture's full team name — what every banner in the source already
     * shows, and therefore what Arena's score bar shows too. Falls back to the
     * translated default when no fixture is loaded, so it is never blank.
     */
    const teamName = redeem.match(/\ba as (\w+)/)?.[1]

    if (!state || !translate || !langOf || !teamCode || !teamFill || !teamName) {
      fail(
        'could not publish the match handles in main.js — ' +
          `state=${state ?? 'MISSING'} translate=${translate ?? 'MISSING'} ` +
          `lang=${langOf ?? 'MISSING'} teamCode=${teamCode ?? 'MISSING'} ` +
          `teamFill=${teamFill ?? 'MISSING'} teamName=${teamName ?? 'MISSING'}. ` +
          'The score bar goes blank (or, worse, names the wrong teams) without these. ' +
          'Re-anchor: the state name comes from the coach panel\'s ' +
          '`${x.score[0]} : ${x.score[1]}` line, the translator and language reader ' +
          'from the navIcons import list (`t` and `a`), and the team code, fill ' +
          'colour and name from the redeemCode import list (`b`, `t` and `a`).',
      )
    }
    src +=
      `\n;globalThis.__arenaMatch=()=>${state};` +
      `globalThis.__arenaT=${translate};` +
      `globalThis.__arenaLang=${langOf};` +
      `globalThis.__arenaTeamCode=${teamCode};` +
      `globalThis.__arenaTeamFill=${teamFill};` +
      `globalThis.__arenaTeamName=${teamName};\n`
    counts.matchHandles = 1
  }

  await writeFile(path.join(VENDOR, out), src, 'utf8')
}

/* ── prove the rewrites landed ─────────────────────────────────────────── */

if (!counts.fetch) fail('no fetch call sites found — the build changed shape and the router is now unreachable')
if (!counts.preload) fail('modulepreload helper not defused — its anchor moved; check navIcons')
if (counts.busy !== 2) fail(`expected 2 inline llmBusy strings, rewrote ${counts.busy} — the i18n table changed shape`)
if (!counts.specifier) fail('no cross-chunk import specifiers rewritten — chunk naming changed')
if (!counts.applyLang) fail('apply-language function never published — main.js was not processed')
if (!counts.matchHandles) fail('match handles never published — the score bar has nothing to read')
if (!counts.fitBanner) fail('phase-banner scale not rewritten — a long team name will run off the kickoff card')
if (counts.nav < 3) fail(`expected 3 location.href navigations to reroute (two nav menus + the predict button), found ${counts.nav} — the nav changed shape`)

/**
 * The source scan in `scripts/validate-worlds.ts` reads these files as TEXT, so a
 * surviving literal fails the PR gate. Re-checking here means the failure names
 * the chunk instead of arriving as a regex from CI.
 */
const BANNED = [/\bfetch\s*\(/, /\blocalStorage\b/, /\bsessionStorage\b/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bEventSource\b/, /\bnavigator\s*\.\s*sendBeacon\b/, /\bimportScripts\s*\(/]
for (const out of nameMap.values()) {
  const text = await readFile(path.join(VENDOR, out), 'utf8')
  for (const re of BANNED) {
    if (re.test(text)) fail(`src/vendor/${out} still contains ${re.source} — the world would fail validate`)
  }
  if (/from"\.\/[^"]*-[A-Za-z0-9_-]{8}\.js"/.test(text)) {
    fail(`src/vendor/${out} still imports a hashed chunk name`)
  }
}

/* ── images ────────────────────────────────────────────────────────────── */

await mkdir(path.join(WORLD, 'assets'), { recursive: true })
for (const rel of Object.values(IMAGES)) {
  await copyFile(path.join(snapshot, 'img', path.basename(rel)), path.join(WORLD, rel))
}

/* ── write src/original.ts ─────────────────────────────────────────────── */

const original = `/* eslint-disable */
/**
 * GENERATED — do not edit by hand. Run \`node tools/extract.mjs <snapshot-dir>\`.
 *
 * The deployed design's stylesheet and markup, verbatim, with image URLs replaced
 * by asset tokens. See tools/extract.mjs for what was changed and why.
 */

/** Both <style> blocks, joined in document order. */
export const CSS = ${JSON.stringify(css)}

/** Everything between <body> and </body>. */
export const MARKUP = ${JSON.stringify(markup)}

/** \`assets/…\` paths referenced by CSS and markup, as \`__ARENA_ASSET__<path>__\`. */
export const ASSET_TOKEN = /__ARENA_ASSET__(.+?)__/g
`
await writeFile(path.join(WORLD, 'src', 'original.ts'), original, 'utf8')

console.log('src/original.ts + src/vendor/ written')
console.log(`  css        ${css.length} bytes`)
console.log(`  markup     ${markup.length} bytes`)
console.log(`  chunks     ${nameMap.size}`)
console.log(`  specifiers ${counts.specifier} rewritten`)
console.log(`  fetch      ${counts.fetch} → arenaFetch`)
console.log(`  storage    ${counts.local} localStorage, ${counts.session} sessionStorage → shims`)
console.log(`  preload    defused in ${counts.preload} chunk(s)`)
console.log(`  llmBusy    ${counts.busy} locale string(s) retold`)
console.log(`  nav        ${counts.nav} off-document navigation(s) rerouted`)
console.log(`  hidden     ${Object.keys(HIDDEN).length} control(s) the platform now owns`)
console.log(`  images     ${swapped} tokenised`)
