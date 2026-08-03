/**
 * Divine Brush (神明的画笔) — a creation game that is secretly a public-goods game.
 *
 * Every seat is handed one blank planet (a 5x5 grid) and a brush. On your turn you
 * do exactly one thing:
 *
 *   paint — lay a stroke on YOUR planet (ocean / snow / dune / grove / glow)
 *   light — spend the turn lighting up SOMEONE ELSE'S planet
 *   wish  — let go: clear the attachment you built up by painting over yourself
 *
 * The tension: strokes only ever improve your own world, but every lamp and every
 * wish feeds `sky` — one shared brightness that multiplies EVERYONE's final tally,
 * yours included. A table of pure painters ends up with pretty planets under a dead
 * black sky; a table that looks up at each other scores far higher. Nobody can buy
 * the sky, only feed it.
 *
 * Beauty has to be computable here (this code is deterministic and never calls out
 * to a model), so the aesthetic is stated outright and scored directly:
 *   mass     — few large contiguous blocks beat confetti
 *   contrast — cold (ocean/snow) set against warm (dune/grove), and the seam between
 *   space    — keep roughly a third of the world empty; a full grid is noise
 *   accent   — glow reads as backlight: a handful of cells against a silhouette
 * Painting over a cell you already painted costs `burden`, which eats your tally
 * until you spend a turn on `wish`.
 *
 * Supports BOTH paces from one definition:
 *   strategy   — each seat submits four knobs and `play` runs the whole match
 *   turn-based — each agent submits one real brush stroke per turn via `reduce`
 *
 * Deterministic and pure: the only randomness is `ctx.random()`.
 */
import { defineGame, type Action, type Ctx } from '@arena/game-sdk'

const SIZE = 5
const AREA = SIZE * SIZE
/**
 * Turns each seat gets. Deliberately just under what IDEAL_VOID below wants: a seat
 * that paints every single turn lands almost exactly on the ideal density, so every
 * lamp is paid for with a stroke it wanted. Connection is never free here — that is
 * the whole game.
 */
const TURNS_PER_PLAYER = 14
const MAX_SEATS = 6
/** Share of the grid a finished world should leave untouched. */
const IDEAL_VOID = 0.45
/**
 * Cold+warm cells needed before the contrast term pays out in full. Must stay
 * reachable inside TURNS_PER_PLAYER, otherwise contrast is permanently clipped and
 * stops being a thing anyone can play toward.
 */
const CONTRAST_FULL_AT = 8
/** Glow cells that read as backlight; past this they read as a floodlight. */
const MAX_ACCENT = 3

// Cell codes. VOID is untouched sky-through; SEPARATOR is render-only.
const VOID = 0
const OCEAN = 1
const SNOW = 2
const DUNE = 3
const GROVE = 4
const GLOW = 5
const SEPARATOR = 6

const ELEMENT_NAMES = ['虚空', '海', '雪', '沙', '林', '光'] as const

/**
 * How much one lamp feeds the shared sky. Divided by the number of seats when
 * applied, so a big table is not automatically a bright one — the sky tracks how
 * generous the table is, not how crowded. Tuned so a table that mostly paints
 * ends near 0.3 and only a table that mostly looks up approaches the 1.0 cap.
 */
const SKY_PER_LAMP = 0.14
/** How much releasing one point of attachment feeds the shared sky (per seat, as above). */
const SKY_PER_WISH = 0.06
/** Tally each received lamp is worth to the planet that received it. */
const LAMP_VALUE = 2
/** Tally the lamp-lighter keeps — "为TA点灯，也是为自己攒一点运气". */
const LUCK_PER_LAMP = 0.6
/** Tally cost of one point of attachment left unreleased at the end. */
const BURDEN_PENALTY = 1.5
/**
 * Awarded to a seat that lit every other planet at least once. This is the only
 * reward for connecting that the free-riders at the table cannot also collect — the
 * sky is shared, guardian is not — so it has to be big enough to outweigh the
 * strokes it costs, or looking up is never individually rational.
 */
const GUARDIAN_BONUS = 10
/** Lamps a guardian must have given in total, so a 2-seat table still earns it. */
const GUARDIAN_MIN_LAMPS = 3

const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

const isCold = (e: number): boolean => e === OCEAN || e === SNOW
const isWarm = (e: number): boolean => e === DUNE || e === GROVE

interface Planet {
  /** rows[y][x], each a cell code. */
  cells: number[][]
  /** Lamps received from other seats (fractional — repeat lamps decay). */
  lamps: number
  /** Attachment built up by painting over your own strokes; cleared by `wish`. */
  burden: number
}

interface LogEntry {
  label: string
  detail: string
}

interface State {
  /** Agent ids in seat order — `players[i]` is always seat i. */
  players: string[]
  planets: Planet[]
  /** Seat to move next (the SDK convention the engine reads for strategy pace). */
  side: number
  /** Actions taken so far, across all seats. */
  turn: number
  /** The shared sky, 0..1. Multiplies every seat's final tally. */
  sky: number
  /** lit[from][to] — how many lamps `from` has given `to`. */
  lit: number[][]
  /** Luck each seat kept from lighting others. */
  luck: number[]
  /** Times each seat let go. */
  wishes: number[]
  /** Recent events, newest last (capped — state stays small). */
  log: LogEntry[]
  lastPaint?: { seat: number; x: number; y: number }
}

interface Params {
  /** Every knob is numeric, so the testkit can treat these as clampable params. */
  [knob: string]: number
  /** Share of turns spent lighting other planets instead of your own. */
  generosity: number
  /** Bias toward cold-against-warm over one big calm mass. */
  contrast: number
  /** Bias toward leaving the world empty rather than filling it. */
  restraint: number
  /** How quickly attachment gets released. */
  release: number
}

// ---------------------------------------------------------------------------
// Aesthetic — the stated look, scored. Pure functions of the grid.
// ---------------------------------------------------------------------------

/** Sum of squared contiguous same-element region sizes, normalised by area. */
function massOf(cells: number[][]): number {
  const seen: boolean[][] = Array.from({ length: SIZE }, () => Array<boolean>(SIZE).fill(false))
  let total = 0
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const element = cells[y]![x]!
      if (element === VOID || seen[y]![x]) continue
      let size = 0
      const stack = [y * SIZE + x]
      seen[y]![x] = true
      while (stack.length > 0) {
        const packed = stack.pop()!
        const py = (packed / SIZE) | 0
        const px = packed % SIZE
        size++
        for (const [dx, dy] of NEIGHBORS) {
          const nx = px + dx
          const ny = py + dy
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
          if (seen[ny]![nx] || cells[ny]![nx] !== element) continue
          seen[ny]![nx] = true
          stack.push(ny * SIZE + nx)
        }
      }
      total += size * size
    }
  }
  return total / AREA
}

/** Cold against warm: how balanced the families are, plus the seam between them. */
function contrastOf(cells: number[][]): number {
  let cold = 0
  let warm = 0
  let seam = 0
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const element = cells[y]![x]!
      if (isCold(element)) cold++
      else if (isWarm(element)) warm++
      const right = x + 1 < SIZE ? cells[y]![x + 1]! : VOID
      const down = y + 1 < SIZE ? cells[y + 1]![x]! : VOID
      for (const other of [right, down]) {
        if ((isCold(element) && isWarm(other)) || (isWarm(element) && isCold(other))) seam++
      }
    }
  }
  const balance = cold > 0 && warm > 0 ? (2 * Math.min(cold, warm)) / (cold + warm) : 0
  // Balance alone is a ratio, and one cold cell beside one warm cell would max it.
  // Scale it by how much terrain actually exists, so contrast has to be BUILT —
  // otherwise the cheapest planet is two token cells and a pile of glow.
  const presence = Math.min(1, (cold + warm) / CONTRAST_FULL_AT)
  return balance * presence * 8 + Math.min(seam, 12) * 0.5
}

/** Negative space: best when roughly a third of the world is left untouched. */
function spaceOf(cells: number[][]): number {
  let voids = 0
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) if (cells[y]![x] === VOID) voids++
  }
  return Math.max(0, 1 - Math.abs(voids / AREA - IDEAL_VOID) / IDEAL_VOID) * 8
}

/** Glow reads as backlight: a few cells rimming a silhouette, not a floodlight. */
function accentOf(cells: number[][]): number {
  let total = 0
  let rimming = 0
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (cells[y]![x] !== GLOW) continue
      total++
      for (const [dx, dy] of NEIGHBORS) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue
        const other = cells[ny]![nx]!
        if (other !== VOID && other !== GLOW) {
          rimming++
          break
        }
      }
    }
  }
  return Math.min(rimming, MAX_ACCENT) * 1.2 - Math.max(0, total - MAX_ACCENT) * 1.5
}

/** What one planet is worth on its own, before lamps and before the sky. */
function harmonyOf(planet: Planet): number {
  return (
    massOf(planet.cells) +
    contrastOf(planet.cells) +
    spaceOf(planet.cells) +
    accentOf(planet.cells) -
    planet.burden * BURDEN_PENALTY
  )
}

/** A seat that lit every other planet, and lit enough of them to mean it. */
function isGuardian(s: State, seat: number): boolean {
  let given = 0
  for (let j = 0; j < s.players.length; j++) {
    if (j === seat) continue
    const lamps = s.lit[seat]![j]!
    if (lamps === 0) return false
    given += lamps
  }
  return given >= GUARDIAN_MIN_LAMPS
}

/** Final tally per seat. The shared sky multiplies every one of them. */
function finalScores(s: State): number[] {
  return s.players.map((_, seat) => {
    const planet = s.planets[seat]!
    let value = harmonyOf(planet) + planet.lamps * LAMP_VALUE + s.luck[seat]!
    if (isGuardian(s, seat)) value += GUARDIAN_BONUS
    value *= 1 + s.sky
    return Math.round(value * 1000) / 1000
  })
}

const isSealed = (s: State): boolean => s.turn >= s.players.length * TURNS_PER_PLAYER

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/** Close out one action: bank the log line and hand the brush to the next seat. */
function advance(s: State, label: string, detail: string): State {
  const turn = s.turn + 1
  return {
    ...s,
    turn,
    side: turn % s.players.length,
    log: s.log.concat([{ label, detail }]).slice(-8),
  }
}

function doPaint(s: State, action: Action, ctx: Ctx): State {
  const { x, y, element } = action as { x: number; y: number; element: number }
  if (!Number.isInteger(x) || x < 0 || x >= SIZE) ctx.reject('out-of-bounds')
  if (!Number.isInteger(y) || y < 0 || y >= SIZE) ctx.reject('out-of-bounds')
  if (!Number.isInteger(element) || element < OCEAN || element > GLOW) ctx.reject('bad-element')

  const planet = s.planets[s.side]!
  const before = planet.cells[y]![x]!
  if (before === element) ctx.reject('no-change')

  const cells = planet.cells.map((row) => row.slice())
  cells[y]![x] = element
  // Painting over your own stroke is the compromise this game charges you for.
  const burden = planet.burden + (before === VOID ? 0 : 1)
  const planets = s.planets.map((p, i) => (i === s.side ? { ...p, cells, burden } : p))

  return advance(
    { ...s, planets, lastPaint: { seat: s.side, x, y } },
    s.players[s.side]!,
    `落笔 · ${ELEMENT_NAMES[element]}`,
  )
}

function doLight(s: State, action: Action, ctx: Ctx): State {
  const { target } = action as { target: number }
  if (!Number.isInteger(target) || target < 0 || target >= s.players.length) ctx.reject('bad-target')
  if (target === s.side) ctx.reject('cannot-light-own')

  // Repeat lamps to the same planet decay, so nobody can farm one friend.
  const already = s.lit[s.side]![target]!
  const gain = 1 / (already + 1)

  const planets = s.planets.map((p, i) => (i === target ? { ...p, lamps: p.lamps + gain } : p))
  const lit = s.lit.map((row, i) => (i === s.side ? row.map((v, j) => (j === target ? v + 1 : v)) : row))
  const luck = s.luck.map((v, i) => (i === s.side ? v + LUCK_PER_LAMP * gain : v))
  const sky = Math.min(1, s.sky + (SKY_PER_LAMP * gain) / s.players.length)

  return advance({ ...s, planets, lit, luck, sky }, s.players[s.side]!, `为 ${s.players[target]} 点灯`)
}

function doWish(s: State, ctx: Ctx): State {
  const planet = s.planets[s.side]!
  if (planet.burden <= 0) ctx.reject('nothing-to-release')

  const released = planet.burden
  const planets = s.planets.map((p, i) => (i === s.side ? { ...p, burden: 0 } : p))
  const wishes = s.wishes.map((v, i) => (i === s.side ? v + 1 : v))
  const sky = Math.min(1, s.sky + (SKY_PER_WISH * released) / s.players.length)

  return advance({ ...s, planets, wishes, sky }, s.players[s.side]!, `放手 · 释放执念 ${released}`)
}

/** Validate and apply one action for the seat currently holding the brush. */
function step(s: State, action: Action, ctx: Ctx): State {
  if (isSealed(s)) ctx.reject('world-sealed')
  // Untrusted input: a malformed submission must reject cleanly, never throw raw.
  if (typeof action !== 'object' || action === null) ctx.reject('bad-action')
  const act = (action as { act?: unknown }).act
  if (act === 'paint') return doPaint(s, action, ctx)
  if (act === 'light') return doLight(s, action, ctx)
  if (act === 'wish') return doWish(s, ctx)
  return ctx.reject('unknown-act')
}

// ---------------------------------------------------------------------------
// The built-in mover (strategy pace, and the self-play driver for sim/preview)
// ---------------------------------------------------------------------------

/** Seat this one has never lit, or -1. Chasing these is how you become a guardian. */
function firstUnlitTarget(s: State, seat: number): number {
  for (let j = 0; j < s.players.length; j++) {
    if (j !== seat && s.lit[seat]![j] === 0) return j
  }
  return -1
}

/** Seat this one has lit least — always a legal lamp target with 2+ seats. */
function leastLitTarget(s: State, seat: number): number {
  let best = seat === 0 ? 1 : 0
  for (let j = 0; j < s.players.length; j++) {
    if (j === seat) continue
    if (s.lit[seat]![j]! < s.lit[seat]![best]!) best = j
  }
  return best
}

/** The knobs re-weight what "good" means, so different strategies paint differently. */
function weighted(cells: number[][], p: Params): number {
  return (
    massOf(cells) * (1.4 - p.contrast * 0.6) +
    contrastOf(cells) * (0.6 + p.contrast) +
    spaceOf(cells) * (0.5 + p.restraint) +
    accentOf(cells)
  )
}

/** Best stroke on an untouched cell — never paints over itself, so never adds burden. */
function bestStroke(s: State, p: Params): { x: number; y: number; element: number; gain: number } | null {
  const cells = s.planets[s.side]!.cells
  const scratch = cells.map((row) => row.slice())
  const base = weighted(scratch, p)
  let best: { x: number; y: number; element: number; gain: number } | null = null
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (cells[y]![x] !== VOID) continue
      for (let element = OCEAN; element <= GLOW; element++) {
        scratch[y]![x] = element
        const gain = weighted(scratch, p) - base
        scratch[y]![x] = VOID
        if (!best || gain > best.gain) best = { x, y, element, gain }
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------

export default defineGame<State, Params>({
  meta: {
    type: 'divine-brush',
    players: { min: 2, max: MAX_SEATS },
    pace: 'strategy',
    paces: ['strategy', 'turn-based'],
    submitWindowSec: 600,
    turnTimeoutSec: 90,
    maxSteps: MAX_SEATS * TURNS_PER_PLAYER,
  },

  params: {
    generosity: { min: 0, max: 1, default: 0.4 },
    contrast: { min: 0, max: 1, default: 0.5 },
    restraint: { min: 0, max: 1, default: 0.5 },
    release: { min: 0, max: 1, default: 0.5 },
  },

  init: (cfg, ctx): State => {
    const players = cfg.players.slice(0, MAX_SEATS)
    while (players.length < 2) players.push(`p${players.length}`)

    const planets: Planet[] = players.map(() => {
      const cells: number[][] = Array.from({ length: SIZE }, () => Array<number>(SIZE).fill(VOID))
      // Every world opens from one seeded landmark, so no seat faces a blank page.
      const x = Math.floor(ctx.random() * SIZE)
      const y = Math.floor(ctx.random() * SIZE)
      const element = OCEAN + Math.floor(ctx.random() * 4)
      cells[y]![x] = element
      return { cells, lamps: 0, burden: 0 }
    })

    return {
      players,
      planets,
      side: 0,
      turn: 0,
      sky: 0,
      lit: players.map(() => players.map(() => 0)),
      luck: players.map(() => 0),
      wishes: players.map(() => 0),
      log: [],
    }
  },

  // —— strategy pace ——
  play: (s, p, ctx): Action => {
    const planet = s.planets[s.side]!

    // Let go once attachment has piled up past this seat's tolerance.
    const releaseAt = 1 + Math.round((1 - p.release) * 4)
    if (planet.burden >= releaseAt) return { act: 'wish' }

    // A planet never lit is worth more than any stroke — that is the guardian path.
    const unlit = firstUnlitTarget(s, s.side)
    if (unlit >= 0 && ctx.random() < 0.1 + p.generosity * 0.7) return { act: 'light', target: unlit }
    if (ctx.random() < p.generosity * 0.5) return { act: 'light', target: leastLitTarget(s, s.side) }

    const stroke = bestStroke(s, p)
    // Restraint is knowing when a stroke would take more from the world than it gives.
    if (stroke && stroke.gain > p.restraint * 0.4) {
      return { act: 'paint', x: stroke.x, y: stroke.y, element: stroke.element }
    }
    // Out of strokes worth making. An ungenerous seat keeps fiddling with its own
    // world anyway (and pays for it in `space`) rather than drifting into charity —
    // otherwise `generosity` would quietly stop meaning anything at the low end.
    if (stroke && ctx.random() > p.generosity) {
      return { act: 'paint', x: stroke.x, y: stroke.y, element: stroke.element }
    }
    if (planet.burden > 0) return { act: 'wish' }
    return { act: 'light', target: leastLitTarget(s, s.side) }
  },

  apply: (s, action, ctx): State => step(s, action, ctx),

  terminal: (s) => {
    if (!isSealed(s)) return { done: false }
    const scores = finalScores(s)
    let best = -Infinity
    let winner: string | null = null
    let tied = false
    for (let i = 0; i < scores.length; i++) {
      const v = scores[i]!
      if (v > best) {
        best = v
        winner = s.players[i]!
        tied = false
      } else if (v === best) {
        tied = true
      }
    }
    return { done: true, winner: tied ? null : winner }
  },

  // —— turn-based pace ——
  reduce: (s, action, ctx: Ctx): State => {
    // MUST: the engine tracks ctx.actor but does not enforce turn ownership.
    if (ctx.actor !== s.players[s.side]) ctx.reject('not-your-turn')
    return step(s, action, ctx)
  },

  // —— common ——
  score: (s): Record<string, number> => {
    const scores = finalScores(s)
    const out: Record<string, number> = {}
    s.players.forEach((agent, i) => {
      out[agent] = scores[i]!
    })
    return out
  },

  /**
   * All the planets hung side by side under one sky, split by a dark gutter.
   * The T2 view cuts the strip back apart on SEPARATOR columns; the stable
   * `灯 x · 执念 y · 分 z` shape of each scoreboard value is what it reads per seat.
   */
  render: (s) => {
    const seats = s.players.length
    const scores = finalScores(s)
    const sealed = isSealed(s)

    const cells: number[][] = []
    for (let y = 0; y < SIZE; y++) {
      const row: number[] = []
      for (let seat = 0; seat < seats; seat++) {
        if (seat > 0) row.push(SEPARATOR)
        for (let x = 0; x < SIZE; x++) row.push(s.planets[seat]!.cells[y]![x]!)
      }
      cells.push(row)
    }

    const skyPct = Math.round(s.sky * 100)
    const leader = scores.indexOf(Math.max(...scores))

    return {
      layout: 'board' as const,
      board: {
        cols: seats * SIZE + (seats - 1),
        rows: SIZE,
        cells,
        palette: {
          [VOID]: '#0b0e17',
          [OCEAN]: '#2a5c8a',
          [SNOW]: '#dbe9f5',
          [DUNE]: '#d99b5b',
          [GROVE]: '#3f7d55',
          [GLOW]: '#ffd98a',
          [SEPARATOR]: '#000000',
        },
        ...(s.lastPaint
          ? { lastMove: { x: s.lastPaint.seat * (SIZE + 1) + s.lastPaint.x, y: s.lastPaint.y } }
          : {}),
        topology: 'grid' as const,
      },
      panels: [
        {
          type: 'status' as const,
          text: sealed
            ? `天空 ${skyPct}% · 这片宇宙由 ${s.players[leader]} 点得最亮`
            : `天空 ${skyPct}% · ${s.players[s.side]} 执笔`,
        },
        {
          type: 'scoreboard' as const,
          rows: s.players.map((agent, seat) => ({
            label: agent,
            value: `灯 ${s.planets[seat]!.lamps.toFixed(1)} · 执念 ${s.planets[seat]!.burden} · 分 ${scores[seat]!.toFixed(1)}${
              isGuardian(s, seat) ? ' · 守灯人' : ''
            }`,
          })),
        },
        { type: 'timeline' as const, items: s.log.map((e) => ({ label: e.label, detail: e.detail })) },
      ],
    }
  },
})

export type { State, Params }
