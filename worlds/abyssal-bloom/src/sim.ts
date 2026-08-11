/**
 * The dive itself: a tall column of water from sunlit surface to garden floor.
 * Pure state + stepping — rendering reads from here and never writes back.
 */

import { type Genome, type SpinePoint, followSpine, fitSpine, headRadius, mulberry32, randomGenome } from './genome.js'

export const WORLD_W = 2600
export const WORLD_H = 11000
export const GARDEN_TOP = WORLD_H * 0.82

/** band index for a y position: 0 sunlit, 1 twilight, 2 midnight, 3 garden */
export const bandAt = (y: number): number => {
  const k = y / WORLD_H
  if (k < 0.16) return 0
  if (k < 0.46) return 1
  if (k < 0.82) return 2
  return 3
}

export interface Mote {
  x: number
  y: number
  r: number
  phase: number
  worth: number
  hue: number
  /** scattered by a sting: flies outward briefly before it can be re-eaten */
  scatter: number
}

export interface Medusa {
  x: number
  y: number
  r: number
  phase: number
  drift: number
}

export interface Ring {
  x: number
  y: number
  r: number
  max: number
  hue: number
  age: number
  life: number
}

export type SimEvent =
  | { kind: 'eat'; streak: number; x: number; y: number }
  | { kind: 'sting' }
  | { kind: 'evolve-ready' }
  | { kind: 'band'; band: number }

// Seven chances per dive: enough to collect all six traits and still elongate
// once, with gaps that widen as the body grows.
const EVOLVE_AT = [5, 12, 20, 29, 39, 50, 62]

export class Player {
  genome: Genome
  spine: SpinePoint[]
  vx = 0
  vy = 0
  targetX: number
  targetY: number
  hasTarget = false
  eaten = 0
  streak = 0
  streakT = 0
  stingCooldown = 0
  evolutionsSeen = 0
  pendingEvolution = false

  constructor(seedRand: () => number, x: number, y: number) {
    this.genome = randomGenome(seedRand)
    this.spine = [{ x, y }]
    fitSpine(this.spine, this.genome.segs)
    this.targetX = x
    this.targetY = y
  }

  get head() {
    return this.spine[0]
  }

  speedCap() {
    return (this.genome.traits.includes('fins') ? 340 : 260) * (1 + Math.min(0.3, this.genome.motes * 0.004))
  }

  applyChoice(choice: string) {
    this.pendingEvolution = false
    this.evolutionsSeen++
    if (choice === 'grow') {
      this.genome.segs = Math.min(30, this.genome.segs + 5)
    } else if (choice !== 'skip') {
      if (!this.genome.traits.includes(choice as Genome['traits'][number]) && this.genome.traits.length < 6) {
        this.genome.traits.push(choice as Genome['traits'][number])
      }
      this.genome.segs = Math.min(30, this.genome.segs + 2)
    }
    fitSpine(this.spine, this.genome.segs)
  }
}

export class Sim {
  player: Player
  motes: Mote[] = []
  medusae: Medusa[] = []
  rings: Ring[] = []
  events: SimEvent[] = []
  time = 0
  lastBand = -1
  private rand = mulberry32((Math.random() * 2 ** 31) | 0)

  constructor() {
    this.player = new Player(this.rand, WORLD_W / 2, 420)
    this.seedField()
  }

  /** Fresh larva for a new dive; the water itself stays as it is. */
  rebirth() {
    this.player = new Player(this.rand, WORLD_W / 2, 420)
    this.lastBand = -1
  }

  private seedField() {
    for (let i = 0; i < 260; i++) this.spawnMote(this.rand() * WORLD_W, this.rand() * WORLD_H)
    for (let i = 0; i < 26; i++) {
      const y = WORLD_H * (0.18 + this.rand() * 0.6)
      this.medusae.push({
        x: this.rand() * WORLD_W,
        y,
        r: 26 + this.rand() * 30,
        phase: this.rand() * Math.PI * 2,
        drift: 0.35 + this.rand() * 0.5,
      })
    }
  }

  private spawnMote(x: number, y: number) {
    const band = bandAt(y)
    this.motes.push({
      x,
      y,
      r: 2.4 + this.rand() * 2.4 + (band >= 2 ? 1 : 0),
      phase: this.rand() * Math.PI * 2,
      worth: band >= 2 ? 2 : 1,
      hue: band === 0 ? 165 + this.rand() * 40 : band === 1 ? 190 + this.rand() * 50 : 210 + this.rand() * 90,
      scatter: 0,
    })
  }

  /** Keep the water around the player stocked without simulating all 11000px. */
  private replenish() {
    const p = this.player.head
    const near = this.motes.filter((m) => Math.abs(m.y - p.y) < 1400)
    const want = bandAt(p.y) === 3 ? 26 : 40
    if (near.length < want) {
      const ang = this.rand() * Math.PI * 2
      const dist = 500 + this.rand() * 700
      const x = Math.min(WORLD_W - 40, Math.max(40, p.x + Math.cos(ang) * dist))
      const y = Math.min(WORLD_H - 220, Math.max(80, p.y + Math.sin(ang) * dist))
      this.spawnMote(x, y)
    }
    if (this.motes.length > 420) {
      // drop the farthest so the array stays bounded on long sessions
      let far = 0
      let farD = -1
      for (let i = 0; i < this.motes.length; i++) {
        const d = Math.abs(this.motes[i].y - p.y)
        if (d > farD) {
          farD = d
          far = i
        }
      }
      this.motes.splice(far, 1)
    }
  }

  step(dt: number) {
    this.time += dt
    const p = this.player
    const head = p.head

    /* steering: seek the pointer with momentum, drag when idle */
    if (p.hasTarget) {
      const dx = p.targetX - head.x
      const dy = p.targetY - head.y
      const d = Math.hypot(dx, dy)
      if (d > 6) {
        const accel = 640
        p.vx += (dx / d) * accel * dt
        p.vy += (dy / d) * accel * dt
      }
    }
    const cap = p.speedCap()
    const v = Math.hypot(p.vx, p.vy)
    if (v > cap) {
      p.vx = (p.vx / v) * cap
      p.vy = (p.vy / v) * cap
    }
    p.vx *= Math.pow(0.32, dt)
    p.vy *= Math.pow(0.32, dt)

    // gentle band current pushes sideways; visible in the marine snow too
    const band = bandAt(head.y)
    const current = Math.sin(this.time * 0.08 + band * 2.1) * (band === 3 ? 4 : 14)
    head.x += (p.vx + current) * dt
    head.y += p.vy * dt
    head.x = Math.max(30, Math.min(WORLD_W - 30, head.x))
    head.y = Math.max(60, Math.min(WORLD_H - 120, head.y))

    const spacing = Math.max(4.5, headRadius(p.genome) * 0.78)
    followSpine(p.spine, spacing)

    /* eating */
    const reach = headRadius(p.genome) + 10
    p.streakT -= dt
    if (p.streakT <= 0) p.streak = 0
    for (let i = this.motes.length - 1; i >= 0; i--) {
      const m = this.motes[i]
      if (m.scatter > 0) {
        m.scatter -= dt
        m.x += Math.cos(m.phase) * 120 * dt
        m.y += Math.sin(m.phase) * 120 * dt
        continue
      }
      const dx = m.x - head.x
      const dy = m.y - head.y
      const dd = Math.hypot(dx, dy)
      // nearby motes lean toward a large creature — the water noticing you
      if (dd < reach * 6 && dd > reach) {
        m.x -= (dx / dd) * 26 * dt
        m.y -= (dy / dd) * 26 * dt
      }
      if (dd < reach) {
        this.motes.splice(i, 1)
        p.genome.motes = Math.min(240, p.genome.motes + m.worth)
        p.eaten += m.worth
        p.streak++
        p.streakT = 2.2
        this.rings.push({ x: m.x, y: m.y, r: 4, max: 46, hue: m.hue, age: 0, life: 0.7 })
        this.events.push({ kind: 'eat', streak: p.streak, x: m.x, y: m.y })
        const next = EVOLVE_AT[p.evolutionsSeen]
        const canStillChange = p.genome.traits.length < 6 || p.genome.segs < 30
        if (next !== undefined && p.genome.motes >= next && !p.pendingEvolution && canStillChange) {
          p.pendingEvolution = true
          this.events.push({ kind: 'evolve-ready' })
        }
      }
    }

    /* medusae drift and sting */
    p.stingCooldown -= dt
    for (const md of this.medusae) {
      md.phase += dt
      md.y += Math.sin(md.phase * 0.6) * 14 * dt
      md.x += Math.cos(md.phase * 0.23 + md.drift * 7) * md.drift * 34 * dt
      if (md.x < -60) md.x = WORLD_W + 50
      if (md.x > WORLD_W + 60) md.x = -50
      if (p.stingCooldown <= 0) {
        const dd = Math.hypot(md.x - head.x, md.y - head.y)
        if (dd < md.r * 0.75 + headRadius(p.genome) * 0.6 && p.genome.motes > 0) {
          const lost = Math.min(2, p.genome.motes)
          p.genome.motes -= lost
          p.stingCooldown = 2.4
          p.streak = 0
          for (let s = 0; s < lost; s++) {
            this.motes.push({
              x: head.x,
              y: head.y,
              r: 3,
              phase: this.rand() * Math.PI * 2,
              worth: 1,
              hue: 300,
              scatter: 0.7 + this.rand() * 0.4,
            })
          }
          this.rings.push({ x: head.x, y: head.y, r: 8, max: 90, hue: 320, age: 0, life: 0.8 })
          this.events.push({ kind: 'sting' })
        }
      }
    }

    /* rings age out */
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]
      r.age += dt
      if (r.age >= r.life) this.rings.splice(i, 1)
    }

    if (band !== this.lastBand) {
      this.lastBand = band
      this.events.push({ kind: 'band', band })
    }

    this.replenish()
  }

  drainEvents(): SimEvent[] {
    const out = this.events
    this.events = []
    return out
  }
}

/* ── garden inhabitants: record-driven, wandering forever ──────────────── */

export class Dweller {
  id: string
  genome: Genome
  name: string | null
  authorName: string
  mine: boolean
  spine: SpinePoint[]
  anchorX: number
  anchorY: number
  phase: number
  speed: number
  halo = 0
  haloTarget = 0
  /** release-bloom: 0..1 growing-in animation */
  bloom: number

  constructor(id: string, genome: Genome, name: string | null, authorName: string, mine: boolean, justReleased: boolean) {
    this.id = id
    this.genome = genome
    this.name = name
    this.authorName = authorName
    this.mine = mine
    const rand = mulberry32(genome.seed ^ 0x9e3779b9)
    this.anchorX = 200 + rand() * (WORLD_W - 400)
    // hover in the lower garden, just above the sea-pen fronds
    this.anchorY = GARDEN_TOP + 700 + rand() * (WORLD_H - GARDEN_TOP - 1250)
    this.phase = rand() * Math.PI * 2
    this.speed = 0.14 + rand() * 0.12
    this.spine = [{ x: this.anchorX, y: this.anchorY }]
    fitSpine(this.spine, genome.segs)
    this.bloom = justReleased ? 0 : 1
  }

  step(dt: number, t: number) {
    this.bloom = Math.min(1, this.bloom + dt * 0.45)
    this.halo += (this.haloTarget - this.halo) * Math.min(1, dt * 2)
    const wanderR = 150 + this.genome.segs * 6
    const px = this.anchorX + Math.sin(t * this.speed + this.phase) * wanderR
    const py = this.anchorY + Math.sin(t * this.speed * 0.7 + this.phase * 1.7) * wanderR * 0.45
    const head = this.spine[0]
    head.x += (px - head.x) * Math.min(1, dt * 0.9)
    head.y += (py - head.y) * Math.min(1, dt * 0.9)
    followSpine(this.spine, Math.max(4.5, headRadius(this.genome) * 0.78) * this.bloom)
  }
}
