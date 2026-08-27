// Regenerate replay.json against the CURRENT rules, pinning both sides of the
// control: the default sky, and a stated one. A sample that states no control is
// the world before its platform has said anything — the state every world starts
// in and the one most likely to be left untested.
import { readFile, writeFile } from 'node:fs/promises'
import { transform } from 'esbuild'
const src = await readFile('src/rules.ts', 'utf8')
const { code } = await transform(src, { loader: 'ts', format: 'esm', target: 'es2020' })
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

const REST_ALL = { actions: [] }
const TEND_24 = { actions: Array.from({ length: 24 }, () => 'tend') }
const STORM = { seed: 'the-long-cold', label: '长寒 · The Long Cold', frostBase: 0.25, frostDeep: 0.45 }

const samples = [
  { submission: REST_ALL, expectedScore: mod.scoreOf(mod.simulate([], null)) },
  { submission: TEND_24, expectedScore: mod.scoreOf(mod.simulate(TEND_24.actions, null)) },
  { submission: TEND_24, control: STORM, expectedScore: mod.scoreOf(mod.simulate(TEND_24.actions, STORM)) },
]
await writeFile('replay.json', JSON.stringify(samples, null, 2) + '\n')
for (const s of samples) {
  console.log(String(s.expectedScore).padStart(6), s.control ? s.control.seed : '(default sky)', '·', s.submission.actions.length, 'hours')
}
