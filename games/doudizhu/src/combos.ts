/**
 * Doudizhu card-combination engine — the heart of the game, kept in its own
 * pure module so it can be unit-tested exhaustively (turn-based games get no
 * automatic self-play sweep from the validator; tests are the only safety net).
 *
 * Cards are represented purely by RANK (suits are irrelevant in Doudizhu):
 *   3..10 → 3..10,  J=11, Q=12, K=13, A=14, 2=15,  small joker=16 (SMALL_JOKER),  big joker=17 (BIG_JOKER)
 * Order low→high: 3 < 4 < … < A < 2 < small joker < big joker.
 *
 * `classify(ranks)` turns a played multiset into a typed `Combo` (or null if it
 * is not a legal shape). `beats(prev, cur)` decides whether `cur` legally tops
 * `prev` on the table. Everything here is deterministic and pure.
 */

export const SMALL_JOKER = 16
export const BIG_JOKER = 17
/** Sequences (straights / consecutive pairs / airplane spines) may not use 2 or the jokers. */
const MAX_SEQ_RANK = 14 // 'A'

export type ComboType =
  | 'single'
  | 'pair'
  | 'triple'
  | 'triple_single'
  | 'triple_pair'
  | 'straight'
  | 'pairs_seq'
  | 'airplane'
  | 'four_two_single'
  | 'four_two_pair'
  | 'bomb'
  | 'rocket'

export interface Combo {
  type: ComboType
  /** Comparison rank (the main triple/quad/top-of-sequence). */
  key: number
  /** Sequence length (straight cards / #pairs / #triples); 1 for fixed-size shapes. */
  len: number
}

const RANK_LABELS: Record<number, string> = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: 'SJ', 17: 'BJ', // SJ = small joker, BJ = big joker
}

/** Human label for a rank code (used by render + view). */
export function rankLabel(r: number): string {
  return RANK_LABELS[r] ?? String(r)
}

function countsOf(ranks: number[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const r of ranks) m.set(r, (m.get(r) ?? 0) + 1)
  return m
}

function isConsecutive(sorted: number[]): boolean {
  for (let i = 1; i < sorted.length; i++) if (sorted[i]! !== sorted[i - 1]! + 1) return false
  return true
}

/** Detect an airplane (≥2 consecutive triples), with optional single or pair wings. */
function classifyAirplane(counts: Map<number, number>, n: number): Combo | null {
  // Spine ranks: count EXACTLY 3, at most A, sorted. A count-4 rank can't be a spine triple.
  const triples = [...counts.keys()].filter((r) => counts.get(r) === 3 && r <= MAX_SEQ_RANK).sort((a, b) => a - b)
  if (triples.length < 2) return null

  // Longest consecutive run among the triple ranks.
  let bestStart = 0
  let bestLen = 1
  let curStart = 0
  for (let i = 1; i <= triples.length; i++) {
    if (i < triples.length && triples[i]! === triples[i - 1]! + 1) continue
    const runLen = i - curStart
    if (runLen > bestLen) {
      bestLen = runLen
      bestStart = curStart
    }
    curStart = i
  }
  if (bestLen < 2) return null

  const k = bestLen
  const spine = triples.slice(bestStart, bestStart + k)
  const spineSet = new Set(spine)
  const topKey = spine[k - 1]!

  // Leftover = every card not consumed by the k spine triples.
  let leftoverTotal = 0
  let maxLeftoverCount = 0
  let leftoverPairs = 0
  let leftoverRanks = 0
  for (const [r, c] of counts) {
    const left = spineSet.has(r) ? c - 3 : c
    if (left <= 0) continue
    leftoverTotal += left
    leftoverRanks++
    if (left > maxLeftoverCount) maxLeftoverCount = left
    if (left === 2) leftoverPairs++
  }

  // Pure airplane.
  if (n === 3 * k && leftoverTotal === 0) return { type: 'airplane', key: topKey, len: k }
  // Airplane + k single wings (a wing must not be a triple/quad).
  if (n === 4 * k && leftoverTotal === k && maxLeftoverCount <= 2) return { type: 'airplane', key: topKey, len: k }
  // Airplane + k pair wings (every wing is exactly a pair).
  if (n === 5 * k && leftoverTotal === 2 * k && leftoverPairs === k && leftoverRanks === k) {
    return { type: 'airplane', key: topKey, len: k }
  }
  return null
}

/** Classify a played multiset of rank codes into a Combo, or null if illegal. */
export function classify(ranks: number[]): Combo | null {
  const n = ranks.length
  if (n === 0) return null
  const counts = countsOf(ranks)

  // Rocket — both jokers.
  if (n === 2 && counts.get(SMALL_JOKER) === 1 && counts.get(BIG_JOKER) === 1) {
    return { type: 'rocket', key: BIG_JOKER, len: 1 }
  }

  const distinct = [...counts.keys()].sort((a, b) => a - b)
  const uniq = distinct.length
  const withCount = (c: number): number[] => distinct.filter((r) => counts.get(r) === c)
  const top = distinct[uniq - 1]!

  // Bomb — four of a kind.
  if (n === 4 && uniq === 1) return { type: 'bomb', key: distinct[0]!, len: 1 }

  // Single / pair / triple.
  if (uniq === 1) {
    if (n === 1) return { type: 'single', key: distinct[0]!, len: 1 }
    if (n === 2) return { type: 'pair', key: distinct[0]!, len: 1 }
    if (n === 3) return { type: 'triple', key: distinct[0]!, len: 1 }
    return null
  }

  // Triple + single.
  if (n === 4) {
    if (withCount(3).length === 1 && withCount(1).length === 1) {
      return { type: 'triple_single', key: withCount(3)[0]!, len: 1 }
    }
    return null
  }

  // Triple + pair (checked before straight; a 5-straight has uniq 5, so no clash).
  if (n === 5 && withCount(3).length === 1 && withCount(2).length === 1) {
    return { type: 'triple_pair', key: withCount(3)[0]!, len: 1 }
  }

  // Straight — ≥5 distinct consecutive singles, up to A.
  if (n >= 5 && uniq === n && isConsecutive(distinct) && top <= MAX_SEQ_RANK) {
    return { type: 'straight', key: top, len: n }
  }

  // Consecutive pairs — ≥3 consecutive pairs, up to A.
  if (n >= 6 && n % 2 === 0 && withCount(2).length === uniq && uniq === n / 2 && isConsecutive(distinct) && top <= MAX_SEQ_RANK) {
    return { type: 'pairs_seq', key: top, len: uniq }
  }

  // Airplane (with/without wings).
  const air = classifyAirplane(counts, n)
  if (air) return air

  // Four + two singles / four + two pairs.
  if (withCount(4).length === 1) {
    const quad = withCount(4)[0]!
    if (n === 6) return { type: 'four_two_single', key: quad, len: 1 } // quad + any 2 cards
    if (n === 8 && withCount(2).length === 2) return { type: 'four_two_pair', key: quad, len: 1 }
  }

  return null
}

/** Does `cur` legally beat `prev` already on the table? */
export function beats(prev: Combo, cur: Combo): boolean {
  if (cur.type === 'rocket') return true
  if (prev.type === 'rocket') return false
  if (cur.type === 'bomb') {
    if (prev.type === 'bomb') return cur.key > prev.key
    return true // bomb tops any non-bomb
  }
  if (prev.type === 'bomb') return false
  if (cur.type !== prev.type) return false
  if (cur.len !== prev.len) return false
  return cur.key > prev.key
}
