/**
 * Pure game logic: the daily island's terrain, decor that affects play,
 * building rules, scoring, and the draft ladder. No DOM, no three.js —
 * everything here must rebuild identically from a day seed in any browser,
 * because stored islands replay by re-running exactly this.
 */
import { ihash, makeRng, smooth, vnoise } from './seed.js'

export interface Island {
  seed: number
  terr(x: number, z: number): number
  slopeOk(x: number, z: number): boolean
  trees: { x: number; z: number }[]
  bushes: { x: number; z: number; s: number }[]
  rocks: { x: number; z: number; s: number }[]
}

export function makeIsland(seed: number): Island {
  const o1 = ihash(1, 1, seed) * 90
  const o2 = ihash(2, 1, seed) * 90
  const o3 = ihash(3, 1, seed) * 90
  const o4 = ihash(4, 1, seed) * 90
  const o5 = ihash(5, 1, seed) * 90
  const o6 = ihash(6, 1, seed) * 90
  const rBase = 11 + ihash(7, 1, seed) * 2.4

  const terr = (x: number, z: number): number => {
    const r = Math.hypot(x, z)
    const rr = r + (vnoise(x * 0.09 + o1, z * 0.09 + o2, seed, 11) - 0.5) * 4.2
    const inside = 1 - smooth(rBase - 1.6, rBase + 2.2, rr)
    const n =
      vnoise(x * 0.1 + o3, z * 0.1 + o4, seed, 12) * 0.62 +
      vnoise(x * 0.23 + o5, z * 0.23 + o6, seed, 13) * 0.38
    const lv = (n * 0.8 + Math.max(0, 1 - r / 12.5) * 0.55) * 3.15
    const f = Math.floor(lv)
    const fr = lv - f
    const land = 0.55 + (f + smooth(0.62, 0.94, fr)) * 1.12
    const raw = -1.7 + (land + 1.7) * inside + (vnoise(x * 0.9 + o1, z * 0.9 + o3, seed, 14) - 0.5) * 0.06
    if (raw > 0.02 && raw < 1.05) return 0.28 + (raw - 0.28) * 0.3
    return raw
  }

  const slopeOk = (x: number, z: number): boolean => {
    const e = 0.35
    return Math.max(Math.abs(terr(x + e, z) - terr(x - e, z)), Math.abs(terr(x, z + e) - terr(x, z - e))) < 0.42
  }

  const trees: Island['trees'] = []
  const bushes: Island['bushes'] = []
  const rocks: Island['rocks'] = []
  const rng = makeRng(seed ^ 0x51ab)
  for (let i = 0; i < 460 && (trees.length < 26 || bushes.length < 10 || rocks.length < 14); i++) {
    const rad = Math.sqrt(rng()) * 13.5
    const an = rng() * Math.PI * 2
    const x = Math.cos(an) * rad
    const z = Math.sin(an) * rad
    const h = terr(x, z)
    if (trees.length < 26 && h > 0.9 && slopeOk(x, z) && !trees.some((t) => Math.hypot(t.x - x, t.z - z) < 1.7)) {
      trees.push({ x, z })
    } else if (bushes.length < 10 && h > 0.4 && h < 3 && slopeOk(x, z)) {
      bushes.push({ x, z, s: 0.34 + rng() * 0.2 })
    } else if (rocks.length < 14 && h > -0.5 && h < 0.45) {
      rocks.push({ x, z, s: 0.22 + rng() * 0.35 })
    }
  }

  return { seed, terr, slopeOk, trees, bushes, rocks }
}

// ---------------------------------------------------------------------------
// Buildings

export const B_TYPES = ['house', 'fisher', 'mill', 'field', 'shrine', 'lighthouse', 'observatory'] as const
export type BType = (typeof B_TYPES)[number]

export interface Placed {
  t: BType
  x: number
  z: number
  rot: number
}

const near = (placed: Placed[], x: number, z: number, r: number, t?: BType) =>
  placed.filter((p) => (t ? p.t === t : true) && Math.hypot(p.x - x, p.z - z) <= r).length

const treeNear = (island: Island, x: number, z: number, r: number) =>
  island.trees.some((tr) => Math.hypot(tr.x - x, tr.z - z) < r)

export const SPACING = 1.7
export const TREE_CLEAR = 1.25

export function canPlaceAt(island: Island, placed: Placed[], x: number, z: number): boolean {
  const h = island.terr(x, z)
  if (h < 0.06 || h > 5.4) return false
  // The shore band is a compressed ramp: visually flat, numerically sloped.
  // A fixed slope gate blocked nearly the whole beach, so the limit adapts.
  const e = 0.35
  const slope = Math.max(
    Math.abs(island.terr(x + e, z) - island.terr(x - e, z)),
    Math.abs(island.terr(x, z + e) - island.terr(x, z - e)),
  )
  if (slope >= (h < 1.1 ? 0.62 : 0.42)) return false
  if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < SPACING)) return false
  if (island.trees.some((t) => Math.hypot(t.x - x, t.z - z) < TREE_CLEAR)) return false
  return true
}

const lvl = (h: number) => Math.max(0, Math.floor((h - 0.55) / 1.12))

/**
 * The whole balance table. Every rule is one line so tuning is a diff, and
 * the score preview shown on hover is exactly this function.
 */
export function scoreAt(island: Island, placed: Placed[], t: BType, x: number, z: number): number {
  const h = island.terr(x, z)
  const coastal = h < 1.1
  switch (t) {
    case 'house': {
      let s = 2 + Math.min(3, near(placed, x, z, 2.8, 'house')) * 2
      if (treeNear(island, x, z, 2.6)) s += 1
      return s
    }
    case 'fisher': {
      let s = 2 + (coastal ? 5 : 0) + Math.min(2, near(placed, x, z, 3, 'fisher')) * 2
      s -= near(placed, x, z, 5, 'mill') * 3
      return s
    }
    case 'mill': {
      let s = 2 + lvl(h)
      s += Math.min(4, near(placed, x, z, 4.5, 'field')) * 3
      s += Math.min(3, near(placed, x, z, 4.2, 'house')) * 2
      s -= near(placed, x, z, 6.5, 'mill') * 4
      return s
    }
    case 'field': {
      let s = 2 + Math.min(3, near(placed, x, z, 2.6, 'field')) * 2
      if (h > 3.4) s -= 2
      return s
    }
    case 'shrine': {
      let s = 3 + (h >= 3.3 ? 3 : 0) + Math.min(3, island.trees.filter((tr) => Math.hypot(tr.x - x, tr.z - z) < 3).length) * 2
      s -= near(placed, x, z, 4, undefined) * 3
      return s
    }
    case 'lighthouse': {
      return (coastal ? 10 : 2) - near(placed, x, z, 4.5, undefined) * 3
    }
    case 'observatory': {
      let s = 4 + lvl(h) * 2
      if (h > 4.2) s += 3
      s -= near(placed, x, z, 7, 'lighthouse') * 4
      return s
    }
  }
}

/**
 * The gold guide: the KIND of ground this building loves, independent of the
 * strict per-spot placement check — the whole shore band glows for a fisher
 * hut even where one vertex is too steep; the ghost settles exact validity.
 */
export function bonusZoneAt(island: Island, placed: Placed[], t: BType, x: number, z: number): boolean {
  const h = island.terr(x, z)
  if (h < 0.06 || h > 5.4) return false
  switch (t) {
    case 'fisher':
    case 'lighthouse':
      return h < 1.1
    case 'mill':
      return h >= 1.67
    case 'shrine':
      return h >= 3.3
    case 'observatory':
      return h >= 3.9
    case 'house':
      return island.trees.some((tr) => Math.hypot(tr.x - x, tr.z - z) < 2.6)
    case 'field':
      return placed.some((p) => p.t === 'field' && Math.hypot(p.x - x, p.z - z) < 2.6)
  }
}

// ---------------------------------------------------------------------------
// Draft ladder

export interface Pack {
  id: string
  items: BType[]
}

export interface Round {
  unlock: number
  a: Pack
  b: Pack
}

export const ROUNDS: Round[] = [
  {
    unlock: 0,
    a: { id: 'fishing-start', items: ['fisher', 'fisher', 'house', 'house'] },
    b: { id: 'farm-start', items: ['field', 'field', 'field', 'house', 'house'] },
  },
  {
    unlock: 10,
    a: { id: 'workshop', items: ['mill', 'field', 'field'] },
    b: { id: 'neighbors', items: ['house', 'house', 'house'] },
  },
  {
    unlock: 18,
    a: { id: 'fish-run', items: ['fisher', 'fisher', 'house'] },
    b: { id: 'wheat-wave', items: ['field', 'field', 'mill'] },
  },
  {
    unlock: 28,
    a: { id: 'shrine-pack', items: ['shrine'] },
    b: { id: 'lighthouse-pack', items: ['lighthouse'] },
  },
  {
    unlock: 36,
    a: { id: 'stargazer', items: ['observatory'] },
    b: { id: 'devotion', items: ['shrine', 'house'] },
  },
]

export type Phase = 'draft' | 'place' | 'settled'

export interface GameState {
  phase: Phase
  round: number
  tray: BType[]
  placed: Placed[]
  score: number
}

export function newGame(): GameState {
  return { phase: 'draft', round: 0, tray: [], placed: [], score: 0 }
}

export function draftPick(state: GameState, pack: Pack): void {
  if (state.phase !== 'draft') return
  state.tray.push(...pack.items)
  state.phase = 'place'
}

export interface PlaceResult {
  ok: boolean
  gained: number
  next: 'place' | 'draft' | 'settled'
}

export function placeAt(state: GameState, island: Island, t: BType, x: number, z: number, rot: number): PlaceResult {
  if (state.phase !== 'place' || !state.tray.includes(t) || !canPlaceAt(island, state.placed, x, z)) {
    return { ok: false, gained: 0, next: 'place' }
  }
  const gained = scoreAt(island, state.placed, t, x, z)
  state.placed.push({ t, x, z, rot })
  state.tray.splice(state.tray.indexOf(t), 1)
  state.score += gained
  if (state.tray.length > 0) return { ok: true, gained, next: 'place' }
  const nextRound = state.round + 1
  if (nextRound < ROUNDS.length && state.score >= ROUNDS[nextRound]!.unlock) {
    state.round = nextRound
    state.phase = 'draft'
    return { ok: true, gained, next: 'draft' }
  }
  state.phase = 'settled'
  return { ok: true, gained, next: 'settled' }
}

/** How far through the day we are, for the sky: afternoon → dusk as you build. */
export function dayProgress(state: GameState): number {
  const expected = ROUNDS.reduce((n, r) => n + Math.max(r.a.items.length, r.b.items.length), 0)
  return Math.min(0.78, (state.placed.length / expected) * 0.78)
}
