import { describe, it, expect } from 'vitest'
import { createRng, clampParams } from '../src/index'

describe('game-sdk testkit', () => {
  it('createRng is deterministic per seed', () => {
    const a = Array.from({ length: 5 }, createRng(42))
    const b = Array.from({ length: 5 }, createRng(42))
    const c = Array.from({ length: 5 }, createRng(43))
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    for (const v of a) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThan(1)
  })

  it('clampParams clamps to [min,max] and fills defaults', () => {
    const def = { params: { x: { min: 0, max: 1, default: 0.5 } } } as never
    expect(clampParams(def, { x: 5 })).toEqual({ x: 1 })
    expect(clampParams(def, { x: -5 })).toEqual({ x: 0 })
    expect(clampParams(def, {})).toEqual({ x: 0.5 })
  })
})
