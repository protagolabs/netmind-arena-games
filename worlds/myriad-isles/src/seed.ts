/**
 * Deterministic randomness for the daily island.
 *
 * Everything that affects gameplay or record replay (terrain, trees) must
 * rebuild identically in every visitor's browser, so all noise here is
 * integer-hash based (imul/xor/shift are exact int32 everywhere) — no
 * Math.sin-style hashing, whose low bits differ across engines.
 */

export function dayString(d = new Date()): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function hashStr(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Uniform [0,1) from three integers. */
export function ihash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/** Sequential rng for sampling loops. */
export function makeRng(seed: number): () => number {
  let n = 0
  return () => ihash(n++, 0x9e37, seed)
}

export function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** Smoothed value noise over a unit grid, salted so layers decorrelate. */
export function vnoise(x: number, y: number, seed: number, salt: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const s = (seed ^ Math.imul(salt, 0x85ebca6b)) | 0
  const a = ihash(xi, yi, s)
  const b = ihash(xi + 1, yi, s)
  const c = ihash(xi, yi + 1, s)
  const d = ihash(xi + 1, yi + 1, s)
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
}
