import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const source = readFileSync(new URL('../scorer.js', import.meta.url), 'utf8')
const rules = runInNewContext(source + '\n({ score, simulate, scoreOf, forecast, skyForPeriod })')
const context = (periodKey, control = null) => ({ periodKey, control, reject(reason) { throw new Error(reason) } })

test('daily forecasts are shared, reproducible, and change on rollover', () => {
  const first = rules.skyForPeriod(null, '2026-09-23:default')
  assert.equal(first.seed, 'first-light:2026-09-23:default')
  assert.equal(JSON.stringify(rules.forecast(first)), JSON.stringify(rules.forecast(first)))
  assert.notEqual(JSON.stringify(rules.forecast(first)), JSON.stringify(rules.forecast(rules.skyForPeriod(null, '2026-09-24:default'))))
})

test('the scorer agrees with the rendered simulation for both default and controlled daily weather', () => {
  for (const period of ['2026-09-23:default', '2026-09-24:wr_weather:2']) {
    for (const control of [null, { seed: 'cold', frostBase: 0.25, frostDeep: 0.45 }]) {
      const actions = Array.from({ length: 24 }, (_, i) => i % 4 === 0 ? 'gather' : 'tend')
      const expected = rules.scoreOf(rules.simulate(actions, rules.skyForPeriod(control, period)))
      assert.equal(rules.score({ actions, period }, context(period, control)), expected)
    }
  }
})

test('old, missing and forged challenge ids are rejected instead of silently rescored', () => {
  for (const period of [undefined, '', '2026-09-22:default', '2026-09-23:wr_weather:1']) {
    assert.throws(() => rules.score({ actions: [], period }, context('2026-09-23:wr_weather:2')), /challenge changed/)
  }
})

test('published replay samples still match the generated scorer', () => {
  const samples = JSON.parse(readFileSync(new URL('../replay.json', import.meta.url), 'utf8'))
  for (const sample of samples) assert.equal(rules.score(sample.submission, context('', sample.control)), sample.expectedScore)
})
