/**
 * Starfall — 2-4 player star conquest (Galcon-lite for Arena).
 *
 * Every player starts on one home star of a seeded, symmetry-fair starmap;
 * neutral stars hold fixed garrisons. Each tick EVERY empire secretly commits
 * one order — send a fraction of a star's garrison at another star, or pass —
 * and all orders resolve at the same instant: fleets launch, stars produce,
 * arrivals merge or fight (attackers subtract from defenders; a positive
 * remainder flips the star). Last empire standing wins; at the tick cap the
 * largest empire wins.
 *
 * Simultaneity uses the sealed-commit pattern established by penalty-shootout
 * and light-cycles, generalised to N seats: seats commit in order 0..N-1
 * (each commit hidden — `meta.hiddenInfo`), then the tick resolves. Commit
 * order carries no information advantage because pending orders are sealed.
 *
 * Fairness is structural, using the light-cycles lessons:
 *  - the starmap is generated in one wedge and replicated by rotation, so
 *    every seat opens onto a near-identical local neighbourhood (2p maps are
 *    point-symmetric, ±2 ships of per-replica wobble — see generateMap);
 *  - the built-in mover's tie-breaks are salted per match AND keyed per seat,
 *    so equal default policies can never lock into rotational lock-step.
 *
 * Termination is structural: MAX_TICKS caps the match; every tick advances
 * the counter regardless of orders, so settlement always converges.
 */
import { defineGame, type Ctx, type RenderCtx, type RenderSpec } from '@arena/game-sdk'

const FIELD = 100 // square starfield, world units
const MAX_TICKS = 80
const SPEED = 7 // units per tick a fleet travels
const HOME_RADIUS = 37 // home stars sit on a ring around the map centre
const MIN_DIST = 13 // minimum spacing between generated stars
const PLANET_BONUS = 30 // empire-size value of holding a star at the cap

interface Planet {
  id: number
  x: number
  y: number
  /** Ships produced per tick while owned by a player. */
  prod: number
  /** Seat index that owns it, or -1 for neutral. */
  owner: number
  ships: number
  /** True for the N home stars (view flavour only). */
  home: boolean
}

interface Fleet {
  id: number
  owner: number
  ships: number
  fromId: number
  toId: number
  sx: number
  sy: number
  tx: number
  ty: number
  departTick: number
  arriveTick: number
}

/** One tick's public battle log entry — the view draws FX from these. */
interface Event {
  tick: number
  planetId: number
  kind: 'capture' | 'repelled' | 'reinforced'
  attacker: number
  ships: number
}

type Order = { pass: true } | { from: number; to: number; ratio: number }

interface State {
  players: string[]
  planets: Planet[]
  fleets: Fleet[]
  /** Sealed orders for the CURRENT tick — secret until the tick resolves. */
  pending: (Order | null)[]
  tick: number
  fleetSeq: number
  status: 'playing' | 'over'
  /** Seat that won by annihilation or empire size; null = draw. */
  winnerSeat: number | null | undefined
  /** Tick each seat was eliminated on (MAX_TICKS+1 while alive). */
  elimTick: number[]
  events: Event[]
  /** Per-match noise seed for the mover's tie-breaks (see light-cycles). */
  salt: number
  moves: number
  side: number
}

interface Params {
  expand: number
  aggression: number
  reinforce: number
  boldness: number
}

const dist = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by)

function tieBreak(salt: number, seat: number, tick: number, i: number): number {
  let h = salt ^ Math.imul(seat + 1, 0x9e3779b9)
  h = (h + Math.imul(tick + 1, 0x85ebca6b)) | 0
  h = (h + Math.imul(i + 1, 0xc2b2ae35)) | 0
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

/**
 * Seeded starmap with one wedge replicated per seat (rotational symmetry →
 * every empire's opening neighbourhood is identical). 2 players get the
 * point-symmetric special case.
 */
function generateMap(n: number, ctx: Ctx): Planet[] {
  const cx = FIELD / 2
  const cy = FIELD / 2
  const planets: Planet[] = []
  let id = 0
  const add = (x: number, y: number, prod: number, owner: number, ships: number, home: boolean): void => {
    planets.push({ id: id++, x, y, prod, owner, ships, home })
  }

  const theta = ctx.random() * Math.PI * 2
  // home stars on the ring, one per seat, evenly rotated
  for (let s = 0; s < n; s++) {
    const a = theta + (s * 2 * Math.PI) / n
    add(cx + HOME_RADIUS * Math.cos(a), cy + HOME_RADIUS * Math.sin(a), 3, s, 22, true)
  }

  // neutral wedge: sample points, then replicate rotated per seat
  const perWedge = n === 2 ? 5 : 4
  const wedge: { x: number; y: number; prod: number; ships: number }[] = []
  let guard = 0
  while (wedge.length < perWedge && guard++ < 300) {
    const r = 12 + ctx.random() * 40
    const a = theta + (ctx.random() * 2 * Math.PI) / n
    const x = cx + r * Math.cos(a)
    const y = cy + r * Math.sin(a)
    if (x < 6 || x > FIELD - 6 || y < 6 || y > FIELD - 6) continue
    const tooClose =
      planets.some((p) => dist(p.x, p.y, x, y) < MIN_DIST) ||
      wedge.some((w) => dist(w.x, w.y, x, y) < MIN_DIST)
    if (tooClose) continue
    const prod = 1 + Math.floor(ctx.random() * 3)
    wedge.push({ x, y, prod, ships: 5 + Math.floor(ctx.random() * 16) + prod * 3 })
  }
  for (let s = 0; s < n; s++) {
    const rot = (s * 2 * Math.PI) / n
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    for (const w of wedge) {
      const dx = w.x - cx
      const dy = w.y - cy
      const x = cx + dx * cos - dy * sin
      const y = cy + dx * sin + dy * cos
      // replicas of the same wedge point may collide near the centre; nudge-skip
      if (planets.some((p) => dist(p.x, p.y, x, y) < MIN_DIST * 0.5)) continue
      // ±2 garrison jitter PER REPLICA: with an exactly symmetric map, equal
      // default policies mirror each other into exact empire ties at the cap
      // (the light-cycles lock-step dance, rotational edition). A two-ship
      // wobble is statistically fair but desynchronises capture timings, and
      // the divergence cascades. Skill impact is negligible; mirrors die.
      const wobble = Math.floor(ctx.random() * 5) - 2
      add(x, y, w.prod, -1, Math.max(1, w.ships + wobble), false)
    }
  }
  // one contested royal star at the exact centre (every seat equidistant)
  if (ctx.random() < 0.65) add(cx, cy, 3, -1, 26 + Math.floor(ctx.random() * 10), false)
  return planets
}

const travelTicks = (a: Planet, b: Planet): number => Math.max(1, Math.ceil(dist(a.x, a.y, b.x, b.y) / SPEED))

function isOrder(raw: unknown, s: State): Order | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as { pass?: unknown; from?: unknown; to?: unknown; ratio?: unknown }
  if (o.pass === true) return { pass: true }
  if (typeof o.from !== 'number' || typeof o.to !== 'number' || typeof o.ratio !== 'number') return null
  if (!Number.isInteger(o.from) || !Number.isInteger(o.to)) return null
  if (o.from < 0 || o.from >= s.planets.length || o.to < 0 || o.to >= s.planets.length) return null
  if (o.from === o.to) return null
  if (!Number.isFinite(o.ratio) || o.ratio <= 0) return null
  return { from: o.from, to: o.to, ratio: Math.min(1, o.ratio) }
}

/** Seal the order for the seat whose commit is due; resolve once all are in. */
function commit(s: State, order: Order): State {
  const pending = [...s.pending]
  pending[s.side] = order
  if (s.side < s.players.length - 1) {
    return { ...s, pending, side: s.side + 1, moves: s.moves + 1 }
  }
  return resolveTick({ ...s, pending, moves: s.moves + 1 })
}

function empireOf(s: State, seat: number): number {
  let e = 0
  for (const p of s.planets) if (p.owner === seat) e += p.ships + PLANET_BONUS
  for (const f of s.fleets) if (f.owner === seat) e += f.ships
  return e
}

function aliveSeats(s: State): number[] {
  const n = s.players.length
  const alive: number[] = []
  for (let seat = 0; seat < n; seat++) {
    if (s.planets.some((p) => p.owner === seat) || s.fleets.some((f) => f.owner === seat)) alive.push(seat)
  }
  return alive
}

function resolveTick(s: State): State {
  const planets = s.planets.map((p) => ({ ...p }))
  let fleets = s.fleets.map((f) => ({ ...f }))
  let fleetSeq = s.fleetSeq
  const events: Event[] = []
  const tick = s.tick + 1

  // 1) launch — all sealed orders leave simultaneously from pre-tick garrisons
  for (let seat = 0; seat < s.players.length; seat++) {
    const o = s.pending[seat]
    if (!o || 'pass' in o) continue
    const from = planets[o.from]!
    if (from.owner !== seat) continue // lost the star since committing — order fizzles
    const ships = Math.floor(from.ships * o.ratio)
    if (ships <= 0) continue
    const to = planets[o.to]!
    from.ships -= ships
    fleets.push({
      id: fleetSeq++,
      owner: seat,
      ships,
      fromId: from.id,
      toId: to.id,
      sx: from.x,
      sy: from.y,
      tx: to.x,
      ty: to.y,
      departTick: s.tick,
      arriveTick: s.tick + travelTicks(from, to),
    })
  }

  // 2) production
  for (const p of planets) if (p.owner >= 0) p.ships += p.prod

  // 3) arrivals — simultaneous battles per star, independent of launch order
  // (per-fleet sequential resolution let later seats mop up weakened garrisons:
  // a systematic later-seat advantage. Group forces per owner instead: the
  // strongest force wins with strength = top - second; an exact top tie
  // annihilates everyone and the star keeps its owner at zero garrison.)
  const arriving = fleets.filter((f) => f.arriveTick === tick)
  fleets = fleets.filter((f) => f.arriveTick !== tick)
  const byPlanet = new Map<number, Fleet[]>()
  for (const f of arriving) {
    const list = byPlanet.get(f.toId) ?? []
    list.push(f)
    byPlanet.set(f.toId, list)
  }
  for (const [pid, group] of [...byPlanet.entries()].sort((a, b) => a[0] - b[0])) {
    const p = planets[pid]!
    const forces = new Map<number, number>()
    forces.set(p.owner, p.ships)
    for (const f of group) {
      if (f.owner === p.owner) {
        events.push({ tick, planetId: p.id, kind: 'reinforced', attacker: f.owner, ships: f.ships })
      }
      forces.set(f.owner, (forces.get(f.owner) ?? 0) + f.ships)
    }
    const ranked = [...forces.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
    const [topOwner, topForce] = ranked[0]!
    const second = ranked.length > 1 ? ranked[1]![1] : 0
    if (topForce === second) {
      p.ships = 0 // mutual annihilation at the gate; the incumbent keeps the husk
      events.push({ tick, planetId: p.id, kind: 'repelled', attacker: ranked[1]![0], ships: second })
    } else if (topOwner === p.owner) {
      p.ships = topForce - second
      if (second > 0) events.push({ tick, planetId: p.id, kind: 'repelled', attacker: ranked[1]![0], ships: second })
    } else {
      p.ships = topForce - second
      p.owner = topOwner
      events.push({ tick, planetId: p.id, kind: 'capture', attacker: topOwner, ships: topForce })
    }
  }

  // 4) elimination + terminal
  const next: State = {
    ...s,
    planets,
    fleets,
    fleetSeq,
    pending: s.players.map(() => null),
    tick,
    events: events.slice(-12),
    side: 0,
  }
  const elimTick = [...s.elimTick]
  const alive = aliveSeats(next)
  for (let seat = 0; seat < s.players.length; seat++) {
    if (elimTick[seat]! > MAX_TICKS && !alive.includes(seat)) elimTick[seat] = tick
  }
  next.elimTick = elimTick

  if (alive.length <= 1) {
    next.status = 'over'
    next.winnerSeat = alive.length === 1 ? alive[0]! : null
  } else if (tick >= MAX_TICKS) {
    next.status = 'over'
    const empires = alive.map((seat) => ({ seat, e: empireOf(next, seat) }))
    empires.sort((a, b) => b.e - a.e)
    next.winnerSeat = empires.length > 1 && empires[0]!.e === empires[1]!.e ? null : empires[0]!.seat
  }
  return next
}

export default defineGame<State, Params>({
  meta: {
    type: 'starfall',
    players: { min: 2, max: 4 },
    pace: 'strategy',
    paces: ['strategy', 'turn-based'],
    hiddenInfo: true,
    submitWindowSec: 600,
    turnTimeoutSec: 60,
    // one sealed commit per seat per tick
    maxSteps: 4 * MAX_TICKS + 8,
  },

  params: {
    /** Priority on grabbing neutral stars early. */
    expand: { min: 0, max: 1, default: 0.65 },
    /** Priority on striking enemy stars. */
    aggression: { min: 0, max: 1, default: 0.45 },
    /** Priority on reinforcing your own frontline stars. */
    reinforce: { min: 0, max: 1, default: 0.3 },
    /** Fraction of a garrison committed per strike (0.35..0.9). */
    boldness: { min: 0, max: 1, default: 0.5 },
  },

  init(cfg, ctx): State {
    const n = cfg.players.length
    return {
      players: [...cfg.players],
      planets: generateMap(n, ctx),
      fleets: [],
      pending: cfg.players.map(() => null),
      tick: 0,
      fleetSeq: 0,
      status: 'playing',
      winnerSeat: undefined,
      elimTick: cfg.players.map(() => MAX_TICKS + 1),
      events: [],
      salt: Math.floor(ctx.random() * 4294967296),
      moves: 0,
      side: 0,
    }
  },

  play(state, params, ctx) {
    // Sealed-duel discipline: never read other seats' `state.pending`.
    const me = state.side
    const mine = state.planets.filter((p) => p.owner === me)
    if (mine.length === 0) return { pass: true }

    const ratio = 0.35 + params.boldness * 0.55
    // the war escalates: late-game strikes score higher, and a superior
    // economy presses its advantage instead of coasting to the tick cap
    const late = state.tick / MAX_TICKS
    const myEmpire = empireOf(state, me)
    let bestRival = 0
    for (let seat = 0; seat < state.players.length; seat++) {
      if (seat !== me) bestRival = Math.max(bestRival, empireOf(state, seat))
    }
    const pressing = myEmpire > bestRival * 1.25 ? 1 : 0
    const threshold = 0.9 - params.aggression * 0.3 - late * 0.25 - pressing * 0.15

    let best: { score: number; from: number; to: number } | null = null
    let i = 0
    for (const src of mine) {
      const spare = src.ships
      if (spare < 6) continue
      for (const dst of state.planets) {
        i++
        if (dst.id === src.id) continue
        const t = travelTicks(src, dst)
        const send = Math.floor(spare * ratio)
        let score = -1
        if (dst.owner === -1) {
          // neutral: worth its production, if we can actually take it
          if (send > dst.ships) score = params.expand * (10 + dst.prod * 8) - t * 1.6 - dst.ships * 0.25
        } else if (dst.owner !== me) {
          const defence = dst.ships + dst.prod * t
          if (send > defence * threshold)
            score =
              (params.aggression + late * 0.8 + pressing * 0.6) * (14 + dst.prod * 8) - t * 1.4 - defence * 0.1
        } else {
          // reinforce/stage: feed the star nearest to enemy space
          let danger = 0
          for (const q of state.planets) {
            if (q.owner >= 0 && q.owner !== me) danger = Math.max(danger, 34 - dist(dst.x, dst.y, q.x, q.y) * 0.4)
          }
          if (danger > 0 && src.ships > 30 && dst.ships < src.ships)
            score = (params.reinforce + late * 0.4) * danger * 0.6 - t * 1.2
        }
        if (score < 0) continue
        score += ctx.random() * 0.4 + tieBreak(state.salt, me, state.tick, i) * 0.4
        if (!best || score > best.score) best = { score, from: src.id, to: dst.id }
      }
    }
    if (!best || best.score < 0.6) return { pass: true }
    return { from: best.from, to: best.to, ratio }
  },

  apply(s, action, ctx): State {
    if (s.status === 'over') return ctx.reject('game-over')
    const order = isOrder(action, s)
    if (!order) return ctx.reject('invalid-order')
    if (!('pass' in order) && s.planets[order.from]!.owner !== s.side) return ctx.reject('not-your-star')
    return commit(s, order)
  },

  reduce(s, action, ctx): State {
    if (s.status === 'over') return ctx.reject('game-over')
    if (typeof action !== 'object' || action === null) return ctx.reject('bad-action')
    if (ctx.actor !== s.players[s.side]) return ctx.reject('not-your-turn')
    const order = isOrder(action, s)
    if (!order) return ctx.reject('invalid-order')
    if (!('pass' in order) && s.planets[order.from]!.owner !== s.side) return ctx.reject('not-your-star')
    return commit(s, order)
  },

  terminal: (s) =>
    s.status === 'over'
      ? { done: true, winner: s.winnerSeat === null || s.winnerSeat === undefined ? null : s.players[s.winnerSeat]! }
      : { done: false },

  score(s): Record<string, number> {
    const n = s.players.length
    const out: Record<string, number> = {}
    if (s.status !== 'over') {
      for (const p of s.players) out[p] = 0
      return out
    }
    // placement: alive > bigger empire > survived longer
    const rows = s.players.map((_, seat) => ({
      seat,
      alive: s.elimTick[seat]! > MAX_TICKS ? 1 : 0,
      empire: empireOf(s, seat),
      elim: s.elimTick[seat]!,
    }))
    rows.sort((a, b) => b.alive - a.alive || b.empire - a.empire || b.elim - a.elim)
    const points = [1, 0.5, 0.25, 0.1]
    for (let i = 0; i < rows.length; ) {
      // average points across exact ties
      let j = i
      while (
        j + 1 < rows.length &&
        rows[j + 1]!.alive === rows[i]!.alive &&
        rows[j + 1]!.empire === rows[i]!.empire &&
        rows[j + 1]!.elim === rows[i]!.elim
      )
        j++
      const share = points.slice(i, j + 1).reduce((a, b) => a + b, 0) / (j - i + 1)
      for (let k = i; k <= j; k++) out[s.players[rows[k]!.seat]!] = share
      i = j + 1
    }
    void n
    return out
  },

  render(s, rctx?: RenderCtx): RenderSpec {
    const viewer = rctx?.viewer
    const viewerSeat = s.players.indexOf(viewer ?? '')
    const myPending = viewerSeat >= 0 ? s.pending[viewerSeat] ?? null : null

    const empires = s.players.map((_, seat) => empireOf(s, seat))
    let statusText: string
    if (s.status === 'over') {
      statusText =
        s.winnerSeat === null || s.winnerSeat === undefined
          ? `Tick ${s.tick} — the galaxy is split, draw`
          : `Tick ${s.tick} — empire ${s.winnerSeat + 1} rules the field`
    } else {
      statusText = `Tick ${s.tick + 1} — sealed orders ${s.pending.filter(Boolean).length}/${s.players.length}`
    }

    const frame = {
      layout: 'custom' as const,
      panels: [
        {
          type: 'scoreboard' as const,
          rows: s.players.map((p, seat) => ({ label: `Empire ${seat + 1}`, value: `${p} · ${empires[seat]}` })),
        },
        { type: 'status' as const, text: statusText },
      ],
      game: 'starfall',
      field: FIELD,
      tick: s.tick,
      maxTicks: MAX_TICKS,
      planets: s.planets.map((p) => ({ id: p.id, x: p.x, y: p.y, prod: p.prod, owner: p.owner, ships: p.ships, home: p.home })),
      fleets: s.fleets.map((f) => ({
        id: f.id,
        owner: f.owner,
        ships: f.ships,
        sx: f.sx,
        sy: f.sy,
        tx: f.tx,
        ty: f.ty,
        // 0..1 playback progress at this tick (view interpolates between frames)
        progress: Math.max(0, Math.min(1, (s.tick - f.departTick) / (f.arriveTick - f.departTick))),
      })),
      committed: s.pending.map((p) => p !== null),
      myPending,
      viewerSeat: viewerSeat >= 0 ? viewerSeat : null,
      empires,
      events: s.events,
      status: s.status,
      winnerSeat: s.winnerSeat ?? null,
    }
    return frame as unknown as RenderSpec
  },
})
