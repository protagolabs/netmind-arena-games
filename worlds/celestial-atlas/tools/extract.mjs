#!/usr/bin/env node
/**
 * Generate `src/original.ts` from the source page.
 *
 * The design IS the file: its CSS, its markup, its wording. Re-typing any of it
 * introduces drift that reads as "close but wrong", so this copies all three
 * verbatim and the world imports them. Only two things are removed, both
 * deliberate:
 *
 *   - `#offerNode` — the ¥1/3/6/9.9 payment plaques. Arena is not a payment
 *     surface for a third party, and the design already promises the free path
 *     is complete: 「安慰本身永远免费」.
 *   - the payment sentence inside the wishing star's chips and note.
 *   - the 中/EN/日 switchers. Language is a platform contract on Arena: the world
 *     reads `ctx.lang` and follows `ctx.onLangChange`, and two controls for one
 *     setting is one too many. The page keeps all three translations.
 *
 * Run: `node tools/extract.mjs <path-to-index.html>`
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const src = process.argv[2]
if (!src) {
  console.error('usage: node tools/extract.mjs <path-to-index.html>')
  process.exit(1)
}

const html = await readFile(src, 'utf8')

/* ── CSS ─────────────────────────────────────────────────────────────── */
let css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'))

/* ── markup ──────────────────────────────────────────────────────────── */
let body = html.slice(html.indexOf('</style>') + 8, html.indexOf('<script'))
body = body.replace(/^[\s\S]*?<body>/, '').trim()

/** Drop a whole `<div class="node island" id="x" ...> … </div>` block by id. */
function dropNode(markup, id) {
  const at = markup.indexOf(`id="${id}"`)
  if (at < 0) return markup
  const open = markup.lastIndexOf('<div', at)
  // Walk tags to find the matching close, so nested divs do not truncate early.
  let depth = 0
  const tag = /<\/?div\b[^>]*>/g
  tag.lastIndex = open
  let m
  while ((m = tag.exec(markup))) {
    depth += m[0].startsWith('</') ? -1 : 1
    if (depth === 0) {
      const commentStart = markup.lastIndexOf('<!--', open)
      const from = commentStart > open - 200 && commentStart >= 0 ? commentStart : open
      return markup.slice(0, from) + markup.slice(m.index + m[0].length)
    }
  }
  return markup
}

body = dropNode(body, 'offerNode')

// The wishing star keeps its ritual, minus the paid variants.
body = body.replace(/<button class="chip wstyle"[\s\S]*?<\/button>\s*/g, '')
body = body.replace(/<p class="wish-note"[\s\S]*?<\/p>\s*/, '')

/**
 * Both language switchers — the prologue's and the header's. Arena already has
 * one, and it is the one that follows the visitor across every world.
 */
for (const re of [
  /\n\s*<div id="proLangs" class="langs">[\s\S]*?<\/div>/,
  /\n\s*<div class="langs" id="hudLangs">[\s\S]*?<\/div>/,
]) {
  if (!re.test(body)) {
    console.error('\nLANGUAGE SWITCHER NOT FOUND — index.html changed shape:\n' + String(re))
    process.exit(1)
  }
  body = body.replace(re, '')
}

/**
 * Strip the payment styling too. Unused rules would not render, but leaving
 * `.plaque` in a stylesheet for a world with nothing to pay for invites the next
 * person to wire it back up.
 */
function dropRules(sheet, selectors) {
  let out = sheet
  for (const sel of selectors) {
    const re = new RegExp(`(^|\\n)[^\\n{}]*${sel.replace(/[.#]/g, '\\$&')}[^{}]*\\{[^{}]*\\}`, 'g')
    out = out.replace(re, '')
  }
  return out
}
css = dropRules(css, ['#offerNode', '.plaques', '.plaque', '.offer-foot', '.wish-note', '.langs', '#proLangs'])

/* ── I18N ────────────────────────────────────────────────────────────── */
const i18nStart = html.indexOf('I18N = {')
const i18nEnd = html.indexOf('\n};', i18nStart) + 2
let i18n = html.slice(html.indexOf('{', i18nStart), i18nEnd)
// Keys that only served the removed payment tier.
i18n = i18n.replace(/^\s*(ofLatin|ofH2|ofMuted|p1n|p1l|p2n|p2l|p3n|p3l|p4n|p4l|ofFoot|wFeather|wPetal|wishNote)\s*:.*$/gm, '')
i18n = i18n.replace(/\n{2,}/g, '\n')

/* ── script ──────────────────────────────────────────────────────────── */
/**
 * The page's own logic, verbatim except for the payment handler. It is vanilla
 * and self-contained, so porting it means wiring persistence in — not rewriting
 * it. The markers below are where the world substitutes Arena's storage:
 *
 *   PLANET_SPOTS.forEach(...)   → load everyone's saved planets
 *   addPlanetNode()             → save this visitor's strokes, then hang it
 *   prologue                    → shown once, via ctx.local
 *
 * The one thing the source cannot supply is a serialisable planet: it paints
 * straight to a canvas and keeps no stroke log, so replaying someone else's
 * planet is impossible without adding one. That addition is the remaining work.
 */
let script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
const offerAt = script.indexOf('/* ═════════ 心意')
const afterOffer = script.indexOf('/* 初始化语言 */', offerAt)
script = script.slice(0, offerAt) + script.slice(afterOffer)

/**
 * Wire Arena's storage into the page's own logic.
 *
 * Each patch is anchored on an exact line from the source and asserted below, so
 * a future edit to index.html fails loudly here instead of silently producing a
 * world that looks right and saves nothing.
 */
const patches = [
  // 1. A stroke log. The source paints straight to canvas and keeps no record of
  //    what was painted, so nobody else's planet could ever be redrawn. These two
  //    lines are the whole addition — no visual behaviour changes.
  [
    `STAMPS[brush](p.x,p.y);noteFromPos(p);lastStamp=p;strokeCount++;`,
    `STAMPS[brush](p.x,p.y);noteFromPos(p);lastStamp=p;strokeCount++;__arena.rec(brush,color,p.x,p.y);`,
  ],
  [
    `    STAMPS[brush](p.x,p.y);\n    if(Math.random()<.3)noteFromPos(p);\n    lastStamp=p;`,
    `    STAMPS[brush](p.x,p.y);__arena.rec(brush,color,p.x,p.y);\n    if(Math.random()<.3)noteFromPos(p);\n    lastStamp=p;`,
  ],
  // 2. 重来 clears the log with the canvas.
  [
    `  resetPlanet();say(T('tBlank'));`,
    `  resetPlanet();__arena.clear();say(T('tBlank'));`,
  ],
  // 3. The decorative fixed spots become everyone's real, saved planets.
  [
    `PLANET_SPOTS.forEach(s=>world.appendChild(makePlanetNode(s)));`,
    `__arena.load(makePlanetNode,world,STAMPS,pctx,resetPlanet,pc);`,
  ],
  // 4. Hanging a planet persists it first; the node is placed at the saved spot.
  [
    `  world.appendChild(makePlanetNode(spot,pc));\n}`,
    `  __arena.save(makePlanetNode,world,pc,spot);\n}`,
  ],
  // 5. Language comes from Arena. `localStorage` throws in an opaque-origin
  //    iframe anyway, but the reason this is not swapped for `ctx.local` is the
  //    contract: the platform already remembers the visitor's language and
  //    already offers the control, so the page reads it and stops storing it.
  [`localStorage.getItem('brush_lang') || 'zh'`, `__arena.lang`],
  [`\n  localStorage.setItem('brush_lang', l);`, ``],
  //    With no switcher left, the selected-state bookkeeping has nothing to mark,
  //    and `setLang` becomes a seam the world calls on `ctx.onLangChange`.
  [
    `  document.querySelectorAll('.langs button').forEach(b => b.classList.toggle('sel', b.dataset.lang===LANG));\n`,
    ``,
  ],
  [
    `document.querySelectorAll('.langs button').forEach(b =>\n  b.addEventListener('click', e => { e.stopPropagation(); setLang(b.dataset.lang); }));`,
    `__arena.onLang = setLang;`,
  ],
  // 6. The melody is not derivable from the strokes: a drag only sounds a note
  //    about a third of the time, and each note carries its own timing and
  //    instrument. Recording it is what lets anyone hear anyone else's planet.
  [
    `  melody.push({deg,dt,inst:currentInst});`,
    `  melody.push({deg,dt,inst:currentInst});__arena.note(deg,dt,currentInst);`,
  ],
  // 7. Lamp counts are a local variable in the source (and random for its demo
  //    planets). Real ones arrive with the planet.
  [
    `  let lamps=customCanvas?0:3+Math.floor(Math.random()*60);`,
    `  let lamps=(spot&&spot.lamps!=null)?spot.lamps:(customCanvas?0:3+Math.floor(Math.random()*60));`,
  ],
  // 8. Hand out the audio engine and the brush colour.
  //
  //    Exposed at the point they are DECLARED, not at the end of the script:
  //    `__arena.load()` runs mid-file to restore saved planets, and anything
  //    published after that point is still undefined when it needs it. The
  //    stamps read `color` from module scope, so a replay cannot set a stroke's
  //    colour without this.
  [
    `let brush='terrain',color='#3a352c';`,
    `let brush='terrain',color='#3a352c';\n__arena.ink={get:()=>color,set:c=>{color=c}};\n__arena.audio={playNote,getInst:()=>currentInst,setInst:v=>{currentInst=v},unlock:audio};`,
  ],
  // 9. A real planet has a real author. The source only has demo planets and
  //    "yours", so it names them from I18N — and `applyLang()` re-applies that on
  //    load and on every language switch, painting over anything set from
  //    outside. So the author has to live ON the registry entry. Your own planet
  //    keeps the source's 你的星球 rather than showing you your own email.
  [
    `  reg.h3.textContent = reg.idx==null ? T('yoursName') : T('planetNames')[reg.idx];\n  reg.mood.textContent = reg.idx==null ? T('yoursMood') : T('planetMoods')[reg.idx];`,
    `  reg.who = spot && spot.authorName; reg.whoMood = spot && spot.authorMood;\n  reg.h3.textContent = reg.who || (reg.idx==null ? T('yoursName') : T('planetNames')[reg.idx]);\n  reg.mood.textContent = reg.who ? (reg.whoMood || '') : (reg.idx==null ? T('yoursMood') : T('planetMoods')[reg.idx]);`,
  ],
  [
    `    r.h3.textContent = r.idx==null ? T('yoursName') : T('planetNames')[r.idx];\n    r.mood.textContent = r.idx==null ? T('yoursMood') : T('planetMoods')[r.idx];`,
    `    r.h3.textContent = r.who || (r.idx==null ? T('yoursName') : T('planetNames')[r.idx]);\n    r.mood.textContent = r.who ? (r.whoMood || '') : (r.idx==null ? T('yoursMood') : T('planetMoods')[r.idx]);`,
  ],
]

for (const [from, to] of patches) {
  if (!script.includes(from)) {
    console.error('\nPATCH ANCHOR NOT FOUND — index.html changed shape:\n' + from.slice(0, 120))
    process.exit(1)
  }
  script = script.replace(from, to)
}

const out = `/* eslint-disable */
/**
 * GENERATED — do not edit by hand. Run \`node tools/extract.mjs <index.html>\`.
 *
 * The source design's stylesheet, markup and copy, verbatim. See tools/extract.mjs
 * for what is removed and why.
 */

export const CSS = ${JSON.stringify(css)}

export const MARKUP = ${JSON.stringify(body)}

export const I18N: Record<string, Record<string, string | string[]>> = ${i18n}

/**
 * The source page's script, verbatim minus the payment handler. NOT yet executed
 * by the world — see the note in tools/extract.mjs about the missing stroke log.
 */
export const SCRIPT = ${JSON.stringify(script)}
`

await mkdir(path.join(HERE, '..', 'src'), { recursive: true })
await writeFile(path.join(HERE, '..', 'src', 'original.ts'), out, 'utf8')

/**
 * Prove each patch is actually present in the output.
 *
 * `String.replace` with a missing anchor is a silent no-op, and three patches
 * once shipped that way: the melody was never recorded, lamp counts never read,
 * and planet authors never shown — all while the build reported success.
 */
const MARKERS = ['__arena.rec(', '__arena.clear()', '__arena.load(', '__arena.save(', '__arena.lang', '__arena.onLang =', '__arena.note(', 'spot.lamps', '__arena.audio=', '__arena.ink=', 'reg.who', 'r.who']
const missing = MARKERS.filter((m) => !script.includes(m))
if (missing.length) {
  console.error(`\nPATCHES DID NOT APPLY: ${missing.join(', ')}`)
  process.exit(1)
}

// Nothing may remain that reads or writes a language of its own.
const LEFTOVER = ['.langs', 'brush_lang'].filter((s) => script.includes(s) || body.includes(s) || css.includes(s))
if (LEFTOVER.length) {
  console.error(`\nLANGUAGE CONTROL SURVIVED: ${LEFTOVER.join(', ')}`)
  process.exit(1)
}

console.log(`src/original.ts written`)
console.log(`  css    ${css.length} bytes`)
console.log(`  markup ${body.length} bytes`)
console.log(`  i18n   ${i18n.length} bytes`)
console.log(`  offerNode removed: ${!body.includes('offerNode')}`)
console.log(`  paid wish chips removed: ${!body.includes('心意三元')}`)
