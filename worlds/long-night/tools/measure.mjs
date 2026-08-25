/**
 * Re-measure every claim in agent.md's "what is actually hard" section.
 *
 * Written because those numbers were first taken under season-seeded weather and
 * kept after the weather moved to a control record — a claim about the game that
 * is no longer true of the game is worse than no claim, because an agent plans
 * against it.
 */
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'
const src = await readFile('src/rules.ts', 'utf8')
const { code } = await transform(src, { loader: 'ts', format: 'esm', target: 'es2020' })
const R = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))

const SKIES = [
  null,
  { seed: 'the-long-cold', frostBase: 0.25, frostDeep: 0.45 },
  { seed: 'thaw', frostBase: 0.04, frostDeep: 0.1 },
  { seed: 'wind-year', windUpTo: 0.85 },
]

const beam = (sky, width = 60) => {
  let live = [{ line: [], s: { warmth: 60, fuel: 8, flame: 3 } }]
  const forecast = R.forecast(sky)
  for (let h = 0; h < 24; h++) {
    const next = []
    for (const b of live) for (const a of R.ACTIONS) {
      const r = R.simulate([...b.line, a], sky)
      if (r.hoursSurvived > h) next.push({ line: [...b.line, a], s: r.trace[h] })
    }
    if (!next.length) break
    next.sort((x, y) => (y.s.warmth + y.s.fuel * 6 + y.s.flame * 14) - (x.s.warmth + x.s.fuel * 6 + x.s.flame * 14))
    live = next.slice(0, width)
  }
  return live.map((b) => R.scoreOf(R.simulate(b.line, sky))).sort((a, b) => b - a)[0] ?? 0
}

const rows = []
for (const sky of SKIES) {
  const name = sky ? sky.seed : 'first-light (default)'
  const singles = {}
  for (const a of R.ACTIONS) {
    const r = R.simulate(Array.from({ length: 24 }, () => a), sky)
    singles[a] = { hours: r.hoursSurvived, survived: r.survived, score: R.scoreOf(r) }
  }
  const best = beam(sky)
  rows.push({ name, singles, best })
}

console.log('每种天气下,单一动作重复 24 小时:')
for (const r of rows) {
  console.log('  ' + r.name)
  for (const [a, v] of Object.entries(r.singles)) {
    console.log(`    ${a.padEnd(8)} ${v.survived ? '撑到天亮' : '死于第 ' + v.hours + ' 小时'}  ${v.score} 分`)
  }
  console.log(`    最佳搜索线 ${r.best} 分  (差距 ${r.best - Math.max(...Object.values(r.singles).map((v) => v.score))})`)
}
