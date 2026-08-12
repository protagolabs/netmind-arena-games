/**
 * 山外山 · simulation. One input: hold to charge, release to leap.
 *
 * The mountain's own bones (rock ledges + pavilions) come from a fixed seed —
 * this is THE mountain, permanent. Player stones extend past the frontier at
 * runtime; in this milestone they live only for the session.
 *
 * Generator invariant (hard-won): a gap and a rise that are each legal in
 * isolation can still compose into an unplayable hop — a solvable arc whose
 * apex grazes the landing plane by <1px is missed by discrete integration.
 * `feas()` therefore demands apex clearance ≥20px AND a ≥10px landing window,
 * and the generator rerolls until it holds.
 */

export const G = 1350
export const CHARGE_TIME = 0.95
export const VY0 = 340
export const VY_K = 310
export const VX0 = 150
export const VX_K = 320
export const EXTEND_MAX = 300
export const EXTEND_MIN = 50
export const RISE_UP = 70
export const RISE_DOWN = 35
export const APEX_PAD = 55
export const WORLD_SEED = 20260811

export interface PNode {
  /** 0 = stone (player), 1 = rock ledge (world), 2 = pavilion (world) */
  k: 0 | 1 | 2
  x: number
  y: number
  w: number
  /** eight per-node jitters, drives silhouette + cracks */
  j: number[]
  /** pavilion name index into Strings.pav */
  pv?: number
  mine?: boolean
  /** fresh-born animation 1→0 */
  fr?: number
  /** platform record id — absent while unsaved */
  rid?: string
  /** author byline (already plain text; rendered via canvas only) */
  nm?: string
  /** written through the API by an agent visitor — renders as a courier stone */
  agent?: boolean
  /** placed this session but not accepted by the platform */
  ghost?: boolean
  /** carved one-liner */
  mk?: string
  /** wind bells hanging on this stone */
  bells?: number
  /** one of those bells is the current visitor's */
  myBell?: boolean
}

export interface TerrPt {
  x: number
  y: number
}

export type ParticleKind = 'dust' | 'gold' | 'petal' | 'mist' | 'leaf' | 'snow'

export interface Particle {
  kind: ParticleKind
  x: number
  y: number
  vx: number
  vy: number
  l: number
  r: number
  /** altitude at spawn — the renderer picks petal colour from it */
  y0: number
}

export interface Ring {
  x: number
  y: number
  a: number
}

export class Rng {
  private s: number
  constructor(seed: number) {
    this.s = seed >>> 0
  }
  next(): number {
    this.s = (this.s * 1664525 + 1013904223) >>> 0
    return this.s / 4294967296
  }
}

export function h1(n: number): number {
  let v = (n * 2654435761) >>> 0
  v ^= v >>> 13
  v = (v * 1274126177) >>> 0
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296
}

export function feas(dx: number, dy: number): boolean {
  for (let p = 0.05; p <= 1.001; p += 0.01) {
    const vy = VY0 + VY_K * p
    const vx = (VX0 + VX_K * p) * 1.06
    if (vy * vy - 2 * G * (dy + 20) < 0) continue
    const t = (vy + Math.sqrt(vy * vy - 2 * G * dy)) / G
    if (Math.abs(vx * t - dx) < 10) return true
  }
  return false
}

export interface Path {
  nodes: PNode[]
  terr: TerrPt[]
  /** count of seeded (world-owned) nodes */
  frn: number
}

export function buildPath(): Path {
  const rng = new Rng(WORLD_SEED)
  const jit = (): number[] => {
    const a: number[] = []
    for (let z = 0; z < 8; z++) a.push(rng.next())
    return a
  }
  const nodes: PNode[] = [{ k: 2, x: 0, y: 0, w: 96, pv: 0, j: jit() }]
  let x = 0
  let y = 0
  for (let i = 1; i <= 57; i++) {
    if (i % 13 === 0) {
      x += 150
      y += 28
      nodes.push({ k: 2, x, y, w: 96, pv: i >= 39 ? 2 : 1, j: jit() })
      continue
    }
    let gap = 0
    let rise = 0
    let tries = 0
    do {
      gap = 80 + rng.next() * rng.next() * 175
      rise = -25 + rng.next() * 100
      tries++
      if (tries > 12) {
        rise = Math.min(rise, 45)
        gap = Math.max(gap, 120)
        break
      }
    } while (!feas(gap, rise))
    x += gap
    y += rise
    nodes.push({ k: 1, x, y, w: 58 + rng.next() * 34, j: jit() })
  }
  const frn = nodes.length
  const terr: TerrPt[] = []
  const xb = nodes[frn - 1].x + 80
  for (let tx = -620; tx <= xb; tx += 22) {
    let i2 = 0
    while (i2 < frn - 2 && nodes[i2 + 1].x < tx) i2++
    const a = nodes[i2]
    const b = nodes[Math.min(i2 + 1, frn - 1)]
    const u = b.x > a.x ? Math.min(1, Math.max(0, (tx - a.x) / (b.x - a.x))) : 0
    const ly = a.y + (b.y - a.y) * u
    const gp = b.x - a.x
    const dip = Math.max(0, gp - 125) * 1.15 * Math.sin(u * 3.14)
    const rg =
      (1 - Math.abs(Math.sin(tx * 0.0128 + 2))) * 0.68 +
      (1 - Math.abs(Math.sin(tx * 0.0293 + 0.7))) * 0.32
    const fn = 0.5 + 0.5 * Math.sin(tx * 0.071 + 1.3)
    terr.push({ x: tx, y: ly - 70 - rg * 44 - fn * 11 - dip })
  }
  return { nodes, terr, frn }
}

export interface SimEvents {
  onPerfect?: (combo: number) => void
  onStep?: () => void
  onGrab?: () => void
  onSpawn?: (node: PNode) => void
  onFall?: () => void
  onBell?: () => void
  /** leapt past the frontier while placing is not allowed today */
  onDenied?: () => void
  /** landed on a node (any kind) — world layer refreshes contextual UI */
  onStand?: (node: PNode, index: number) => void
}

export class Sim {
  nodes: PNode[]
  terr: TerrPt[]
  frn: number
  wind: number
  ev: SimEvents

  px = 0
  py = 0
  vx = 0
  vy = 0
  air = false
  sq = 0
  apx = 0
  stY = 0
  idx = 0
  from = 0

  chg = 0
  hold = false
  perf = 0
  combo = 0
  falls = 0
  placed = 0
  camX = 0
  camY = 0
  t = 0
  fade = 0
  private fpend = false
  freeze = 0
  shk = 0
  started = false
  /** false once today's stone is spent (or the visitor is signed out) */
  canPlace = true
  /** the deny reason is "sign in" rather than "spent" */
  anonNote = false
  /** total community stones on the mountain, for the HUD */
  commStones = 0

  pts: Particle[] = []
  rings: Ring[] = []

  constructor(wind: number, ev: SimEvents = {}) {
    const p = buildPath()
    this.nodes = p.nodes
    this.terr = p.terr
    this.frn = p.frn
    this.wind = wind
    this.ev = ev
    this.setTo(0)
  }

  L(x: number): number {
    const n = this.nodes
    if (x <= n[0].x) return n[0].y
    if (x >= n[this.frn - 1].x) return n[this.frn - 1].y
    let i = 0
    while (i < this.frn - 2 && n[i + 1].x < x) i++
    const a = n[i]
    const b = n[i + 1]
    const u = Math.min(1, Math.max(0, (x - a.x) / (b.x - a.x)))
    return a.y + (b.y - a.y) * u
  }

  setTo(i: number): void {
    const nd = this.nodes[i]
    if (!nd) return
    this.idx = i
    this.from = i
    this.px = nd.x
    this.py = nd.y
    this.vx = 0
    this.vy = 0
    this.air = false
    this.sq = 0
    this.stY = 0
    this.chg = 0
    this.camX = nd.x
    this.camY = nd.y
  }

  press(): void {
    if (this.fade > 0) return
    this.started = true
    if (!this.air) this.hold = true
  }

  release(): void {
    if (!this.hold) return
    this.hold = false
    if (this.air || this.fade > 0) return
    const p = Math.min(1, this.chg)
    this.chg = 0
    this.from = this.idx
    this.vy = VY0 + VY_K * p
    this.vx = (VX0 + VX_K * p) * (1 + this.wind * 0.5)
    this.air = true
    this.apx = this.py
    this.sq = -0.3
  }

  private burst(kind: ParticleKind, x: number, y: number, n: number, spread: number, up: number): void {
    for (let i = 0; i < n; i++) {
      this.pts.push({
        kind,
        x: x + (Math.random() * 2 - 1) * 12,
        y,
        vx: (Math.random() * 2 - 1) * spread,
        vy: up * (0.4 + Math.random()),
        l: kind === 'petal' ? 1.3 : 1,
        r: Math.random() * 6,
        y0: this.py,
      })
    }
  }

  private land(i: number, fresh: boolean, grab: boolean): void {
    const nd = this.nodes[i]
    this.idx = i
    if (!grab) this.px = Math.min(nd.x + nd.w / 2 - 4, Math.max(nd.x - nd.w / 2 + 4, this.px))
    this.py = nd.y
    this.vx = 0
    this.vy = 0
    this.air = false
    this.sq = 0.42
    this.stY = 0
    this.shk = 4
    if (fresh) return
    if (grab) {
      this.combo = 0
      this.burst('dust', this.px, this.py, 6, 54, 60)
      this.ev.onGrab?.()
      return
    }
    const off = Math.abs(this.px - nd.x) / (nd.w / 2)
    if (off < 0.2) {
      this.perf++
      this.combo++
      this.freeze = 0.055
      this.rings.push({ x: this.px, y: this.py, a: 1 })
      this.burst('petal', this.px, this.py + 6, 6, 60, 90)
      this.ev.onPerfect?.(this.combo)
    } else {
      this.combo = 0
      this.burst('dust', this.px, this.py, 4, 54, 60)
      this.ev.onStep?.()
    }
    this.ev.onStand?.(nd, i)
  }

  /**
   * Replace everything past the seeded ridge with stones from the platform,
   * clamping each into jumpable range of the previous frontier — this is what
   * keeps the path legal when moderation removes a stone or an agent writes
   * one from the API. Unsaved session ghosts are re-appended at the end.
   */
  setStones(stones: PNode[]): void {
    const standing = this.nodes[this.idx]
    const ghosts = this.nodes.slice(this.frn).filter((n) => n.ghost)
    this.nodes.length = this.frn
    const sorted = [...stones].sort((a, b) => a.x - b.x)
    for (const st of sorted) {
      const la = this.nodes[this.nodes.length - 1]
      st.x = Math.min(Math.max(st.x, la.x + EXTEND_MIN), la.x + EXTEND_MAX)
      st.y = Math.min(la.y + RISE_UP, Math.max(la.y - RISE_DOWN, st.y))
      this.nodes.push(st)
    }
    for (const gh of ghosts) {
      const la = this.nodes[this.nodes.length - 1]
      gh.x = Math.min(Math.max(gh.x, la.x + EXTEND_MIN), la.x + EXTEND_MAX)
      gh.y = Math.min(la.y + RISE_UP, Math.max(la.y - RISE_DOWN, gh.y))
      this.nodes.push(gh)
    }
    if (!this.air) {
      const same = standing && this.nodes[this.idx] === standing
      if (!same) {
        let best = 0
        for (let i = 0; i < this.nodes.length; i++) {
          if (this.nodes[i].x <= this.px + 4) best = i
          else break
        }
        this.setTo(best)
      }
    }
  }

  private spawnStone(nx: number, ny: number): void {
    const j: number[] = []
    for (let z = 0; z < 8; z++) j.push(h1((this.nodes.length + 1) * 91 + z * 17))
    const nd: PNode = { k: 0, x: nx, y: ny, w: 52 + h1(this.nodes.length * 7) * 10, mine: true, ghost: true, fr: 1, j }
    this.nodes.push(nd)
    this.placed++
    this.px = nx
    this.land(this.nodes.length - 1, true, false)
    this.combo = 0
    this.shk = 5
    this.burst('gold', nx, ny, 14, 70, 90)
    this.burst('mist', nx, ny + 6, 9, 60, 30)
    this.rings.push({ x: nx, y: ny, a: 1 })
    this.ev.onSpawn?.(nd)
  }

  step(dt: number): void {
    this.t += dt
    if (this.fade > 0) {
      this.fade -= dt * 1.3
      if (this.fpend && this.fade < 0.5) {
        this.setTo(this.from)
        this.fpend = false
      }
    }
    if (this.hold && !this.air) this.chg = Math.min(1.12, this.chg + dt / CHARGE_TIME)
    if (this.air) {
      this.px += this.vx * dt
      const prevY = this.py
      this.vy -= G * dt
      this.py += this.vy * dt
      if (this.py > this.apx) this.apx = this.py
      if (this.vy < 0) {
        let li = -1
        let grab = false
        for (let i = 0; i < this.nodes.length; i++) {
          const nd = this.nodes[i]
          if (prevY >= nd.y && this.py <= nd.y) {
            const dx0 = Math.abs(this.px - nd.x)
            if (dx0 < nd.w / 2 + 7) {
              li = i
              grab = false
              break
            }
            if (dx0 < nd.w / 2 + 19) {
              li = i
              grab = true
              break
            }
          }
        }
        if (li >= 0) {
          const nd = this.nodes[li]
          if (grab) this.px = nd.x + (this.px > nd.x ? 1 : -1) * (nd.w / 2 - 6)
          this.land(li, (nd.fr ?? 0) > 0, grab)
          if (!this.air) {
            for (const b of this.nodes) {
              if (b.k === 2 && Math.abs(b.x - this.px) < 52) this.ev.onBell?.()
            }
          }
        } else {
          const la = this.nodes[this.nodes.length - 1]
          if (this.px > la.x + 42) {
            if (!this.stY) this.stY = Math.min(la.y + RISE_UP, Math.max(la.y - RISE_DOWN, this.apx - APEX_PAD))
            if (this.py <= this.stY) {
              const nx = Math.min(this.px, la.x + EXTEND_MAX)
              if (nx - la.x >= EXTEND_MIN) {
                if (this.canPlace) this.spawnStone(nx, this.stY)
                else {
                  this.ev.onDenied?.()
                  this.stY = -99999
                }
              }
            }
          }
        }
      }
      if (this.air && this.fade <= 0 && this.py < this.L(this.px) - 300) {
        this.falls++
        this.combo = 0
        this.fade = 1
        this.fpend = true
        this.burst('mist', this.px, this.py, 12, 50, 60)
        this.ev.onFall?.()
      }
      const la2 = this.nodes[this.nodes.length - 1]
      if (this.air && this.px > la2.x + 150 && Math.random() < dt * 26) {
        this.pts.push({
          kind: 'mist',
          x: this.px - 6,
          y: this.py + (Math.random() * 2 - 1) * 10,
          vx: -this.vx * 0.1 + (Math.random() * 2 - 1) * 16,
          vy: (Math.random() * 2 - 1) * 16,
          l: 1,
          r: Math.random() * 6,
          y0: this.py,
        })
      }
    }
    this.sq += (0 - this.sq) * Math.min(1, dt * 9)
    this.camX += (this.px + 46 + Math.min(1, this.chg) * 40 - this.camX) * Math.min(1, dt * 5)
    this.camY += (this.py - this.camY) * Math.min(1, dt * 4.2)
    this.shk *= Math.pow(0.0005, dt)
    if (Math.random() < dt * 1.1) {
      const kind: ParticleKind | null = this.camY < 900 ? 'leaf' : this.camY > 1650 ? 'snow' : null
      if (kind) {
        this.pts.push({
          kind,
          x: this.camX + (Math.random() * 1.3 - 0.4) * 900,
          y: this.camY + 300,
          vx: kind === 'leaf' ? -12 - Math.random() * 18 : -6 - Math.random() * 8,
          vy: kind === 'leaf' ? -26 - Math.random() * 18 : -20 - Math.random() * 14,
          l: kind === 'leaf' ? 4 : 5,
          r: Math.random() * 6,
          y0: this.camY,
        })
      }
    }
    for (let q = this.pts.length - 1; q >= 0; q--) {
      const p = this.pts[q]
      if (p.kind === 'leaf' || p.kind === 'snow' || p.kind === 'mist') {
        p.x += p.vx * dt + Math.sin(this.t * 2 + p.r) * 16 * dt
        p.y += p.vy * dt
        p.l -= dt * (p.kind === 'mist' ? 1.15 : 0.35)
      } else {
        p.vy -= (p.kind === 'petal' ? 240 : 620) * dt
        p.x += p.vx * dt + (p.kind === 'petal' ? Math.sin(this.t * 4 + p.r) * 30 * dt : 0)
        p.y += p.vy * dt
        p.l -= dt * (p.kind === 'petal' ? 0.55 : 1.5)
      }
      if (p.l <= 0) this.pts.splice(q, 1)
    }
    for (let f = this.rings.length - 1; f >= 0; f--) {
      this.rings[f].a -= dt * 1.6
      if (this.rings[f].a <= 0) this.rings.splice(f, 1)
    }
  }
}
