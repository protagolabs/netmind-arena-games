/**
 * Generate `scorer.js` from `src/rules.ts`.
 *
 * The scorer reaches Arena as one self-contained string and runs in an isolate
 * with no module system, so it cannot import the rules — it has to contain them.
 * That is the one situation where a second copy is unavoidable, which is exactly
 * why it is generated rather than written: a hand-maintained copy would drift
 * from the document's copy, and the drift would surface as a player being shown
 * one outcome and scored on another.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { transform } from 'esbuild'

const source = await readFile(new URL('../src/rules.ts', import.meta.url), 'utf8')
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2020' })

// Strip the module syntax: an isolate script has no imports and no exports, and
// the harness calls a global `score`.
const plain = code.replace(/^export\s+/gm, '')

await writeFile(
  new URL('../scorer.js', import.meta.url),
  `// GENERATED from src/rules.ts by tools/build-scorer.mjs — do not edit.
// Regenerate with: node tools/build-scorer.mjs

${plain}
/**
 * The platform's entry point. \`ctx.seasonKey\` is injected by Arena from the
 * open season, never read from the submission — the weather is shared, and a
 * player who could name their own season could shop for a mild night.
 */
function score(submission, ctx) {
  const actions = (submission && submission.actions) || []
  if (!Array.isArray(actions)) ctx.reject('actions must be an array')
  if (actions.length > HOURS) ctx.reject('a night is ' + HOURS + ' hours; got ' + actions.length)
  for (let i = 0; i < actions.length; i++) {
    if (ACTIONS.indexOf(actions[i]) === -1) {
      ctx.reject('hour ' + i + ': "' + actions[i] + '" is not one of ' + ACTIONS.join(', '))
    }
  }
  return scoreOf(simulate(actions, ctx.seasonKey || 'open'))
}
`,
)
console.log('scorer.js regenerated from src/rules.ts')
