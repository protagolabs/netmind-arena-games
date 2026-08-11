/**
 * A creature is a genome — a handful of bounded numbers and trait names — plus
 * a spine pose. Everything visible is derived from those, so the same record a
 * visitor wrote during play renders identically in everyone else's garden.
 */

export type Trait = 'fins' | 'veil' | 'tendrils' | 'bell' | 'crest' | 'lanterns'

export const ALL_TRAITS: Trait[] = ['fins', 'veil', 'tendrils', 'bell', 'crest', 'lanterns']

export interface Genome {
  seed: number
  hue: number
  hue2: number
  segs: number
  motes: number
  traits: Trait[]
}

export interface SpinePoint {
  x: number
  y: number
}

/** Deterministic RNG so a stored seed always re-grows the same body. */
export const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const randomGenome = (rand: () => number): Genome => {
  const hue = Math.floor(rand() * 360)
  // Accent sits a third of the wheel away so head and tail read as two lights.
  const hue2 = (hue + 90 + Math.floor(rand() * 140)) % 360
  return {
    seed: Math.floor(rand() * 2147483647),
    hue,
    hue2,
    segs: 6,
    motes: 0,
    traits: [],
  }
}

/* ── glow sprites ─────────────────────────────────────────────────────────
 * shadowBlur per frame is what kills canvas performance; a pre-rendered
 * radial-gradient sprite scaled at draw time is what replaces it. Hue is
 * quantised so a shared world of many creatures still uses a small atlas.
 */

const glowCache = new Map<string, HTMLCanvasElement>()

const GLOW_SIZE = 64

export const glowSprite = (hue: number, sat = 90, core = 0.9): HTMLCanvasElement => {
  const h = Math.round(hue / 12) * 12
  const key = `${h}/${sat}/${core}`
  const hit = glowCache.get(key)
  if (hit) return hit
  const c = document.createElement('canvas')
  c.width = GLOW_SIZE
  c.height = GLOW_SIZE
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, `hsla(${h},${sat * 0.4}%,96%,${core})`)
  grad.addColorStop(0.25, `hsla(${h},${sat}%,68%,${core * 0.55})`)
  grad.addColorStop(0.62, `hsla(${h},${sat}%,52%,${core * 0.16})`)
  grad.addColorStop(1, `hsla(${h},${sat}%,50%,0)`)
  g.fillStyle = grad
  g.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE)
  glowCache.set(key, c)
  return c
}

export const drawGlow = (
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  hue: number,
  alpha: number,
  sat = 90,
) => {
  if (alpha <= 0.004 || r <= 0.1) return
  g.globalAlpha = Math.min(1, alpha)
  g.drawImage(glowSprite(hue, sat), x - r, y - r, r * 2, r * 2)
  g.globalAlpha = 1
}

/* ── body geometry ──────────────────────────────────────────────────────── */

export const headRadius = (genome: Genome) => 6 + Math.sqrt(genome.motes + 1) * 1.35

const lerpHue = (a: number, b: number, t: number) => {
  let d = ((b - a + 540) % 360) - 180
  return (a + d * t + 360) % 360
}

export interface DrawOpts {
  /** overall brightness multiplier (garden ambience vs. the player's own lamp) */
  glow: number
  /** extra halo radius from received resonance, 0..1 */
  halo?: number
  scale?: number
}

/**
 * Draw one creature. `spine[0]` is the head. The pose is supplied by the
 * caller (play physics or garden wander); this function only turns genome +
 * pose + time into light. Draw under `globalCompositeOperation = 'lighter'`.
 */
export const drawCreature = (
  g: CanvasRenderingContext2D,
  genome: Genome,
  spine: SpinePoint[],
  t: number,
  opts: DrawOpts,
) => {
  const n = spine.length
  if (n < 2) return
  const scale = opts.scale ?? 1
  const r0 = headRadius(genome) * scale
  const rand = mulberry32(genome.seed)
  const phase = rand() * Math.PI * 2
  const has = (tr: Trait) => genome.traits.includes(tr)

  // Local tangent/normal per segment, used by every appendage.
  const tang: SpinePoint[] = []
  for (let i = 0; i < n; i++) {
    const a = spine[Math.max(0, i - 1)]
    const b = spine[Math.min(n - 1, i + 1)]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    tang.push({ x: dx / len, y: dy / len })
  }
  const radiusAt = (i: number) => {
    const k = i / (n - 1)
    return r0 * (0.42 + 0.58 * Math.pow(1 - k, 1.4)) * (i === 0 ? 1.15 : 1)
  }

  /* trailing appendages first, so the body renders on top of them */

  if (has('veil')) {
    g.lineCap = 'round'
    for (let v = 0; v < 3; v++) {
      const side = v === 1 ? 0 : v === 0 ? 1 : -1
      const start = Math.floor(n * 0.55)
      g.beginPath()
      for (let i = start; i < n; i++) {
        const k = (i - start) / Math.max(1, n - start)
        const sway = Math.sin(t * 1.7 + phase + i * 0.45 + v) * r0 * (0.5 + k * 1.3)
        const nx = -tang[i].y
        const ny = tang[i].x
        const x = spine[i].x + nx * (sway + side * r0 * 0.6 * k)
        const y = spine[i].y + ny * (sway * 0.6) + k * r0 * 0.5
        if (i === start) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      const hueV = lerpHue(genome.hue, genome.hue2, 0.8)
      g.strokeStyle = `hsla(${hueV},80%,72%,${0.1 * opts.glow})`
      g.lineWidth = r0 * (1.5 - v * 0.35)
      g.stroke()
      g.strokeStyle = `hsla(${hueV},90%,84%,${0.16 * opts.glow})`
      g.lineWidth = r0 * 0.3
      g.stroke()
    }
  }

  if (has('tendrils')) {
    const count = 4
    g.lineCap = 'round'
    for (let c = 0; c < count; c++) {
      const anchor = Math.max(1, n - 1 - (c % 3))
      const p = spine[anchor]
      const nx = -tang[anchor].y
      const ny = tang[anchor].x
      const spread = (c / (count - 1) - 0.5) * 2
      const len = r0 * (2.2 + rand() * 1.4)
      const tipX = p.x + nx * spread * r0 * 1.2 - tang[anchor].x * len + Math.sin(t * 2.1 + c * 1.9 + phase) * r0 * 0.8
      const tipY = p.y + ny * spread * r0 * 1.2 - tang[anchor].y * len + Math.cos(t * 1.6 + c * 1.3 + phase) * r0 * 0.5
      const midX = (p.x + tipX) / 2 + Math.sin(t * 2.4 + c) * r0 * 0.5
      const midY = (p.y + tipY) / 2 + Math.cos(t * 2.0 + c) * r0 * 0.5
      g.beginPath()
      g.moveTo(p.x, p.y)
      g.quadraticCurveTo(midX, midY, tipX, tipY)
      g.strokeStyle = `hsla(${genome.hue2},85%,70%,${0.32 * opts.glow})`
      g.lineWidth = Math.max(0.6, r0 * 0.09)
      g.stroke()
      drawGlow(g, tipX, tipY, r0 * 0.5, genome.hue2, 0.5 * opts.glow)
    }
  }

  if (has('lanterns')) {
    for (let c = 0; c < 3; c++) {
      const anchor = Math.floor(n * (0.25 + c * 0.22))
      if (anchor >= n) continue
      const p = spine[anchor]
      const nx = -tang[anchor].y
      const ny = tang[anchor].x
      // hang toward screen-down, biased by the local normal
      const sway = Math.sin(t * 1.3 + c * 2.1 + phase) * r0 * 0.35
      const drop = r0 * (1.5 + c * 0.25)
      const lx = p.x + nx * sway * 0.4 + sway
      const ly = p.y + Math.abs(ny) * drop * 0.2 + drop
      g.beginPath()
      g.moveTo(p.x, p.y)
      g.quadraticCurveTo(p.x + sway * 0.5, (p.y + ly) / 2, lx, ly)
      g.strokeStyle = `hsla(${genome.hue},60%,75%,${0.25 * opts.glow})`
      g.lineWidth = Math.max(0.5, r0 * 0.06)
      g.stroke()
      const pulse = 0.75 + 0.25 * Math.sin(t * 2.6 + c * 2.4)
      drawGlow(g, lx, ly, r0 * 0.62 * pulse, genome.hue2, 0.85 * opts.glow)
      g.fillStyle = `hsla(${genome.hue2},70%,88%,${0.9 * opts.glow})`
      g.beginPath()
      g.arc(lx, ly, Math.max(0.8, r0 * 0.1), 0, Math.PI * 2)
      g.fill()
    }
  }

  /* fins ride the mid-body, under the glow cores */

  if (has('fins')) {
    const from = Math.floor(n * 0.18)
    const to = Math.floor(n * 0.72)
    for (const side of [-1, 1]) {
      g.beginPath()
      g.moveTo(spine[from].x, spine[from].y)
      for (let i = from; i <= to; i++) {
        const k = (i - from) / Math.max(1, to - from)
        const flap = Math.sin(t * 3.1 + phase + k * 3.5) * 0.4 + 0.9
        const w = Math.sin(k * Math.PI) * radiusAt(i) * 2.1 * flap
        const nx = -tang[i].y * side
        const ny = tang[i].x * side
        g.lineTo(spine[i].x + nx * w, spine[i].y + ny * w)
      }
      for (let i = to; i >= from; i--) g.lineTo(spine[i].x, spine[i].y)
      g.closePath()
      const hueF = lerpHue(genome.hue, genome.hue2, 0.35)
      g.fillStyle = `hsla(${hueF},85%,66%,${0.13 * opts.glow})`
      g.fill()
      g.strokeStyle = `hsla(${hueF},90%,80%,${0.2 * opts.glow})`
      g.lineWidth = 1
      g.stroke()
    }
  }

  /* the body itself: glow bloom + bright core, hot head cooling toward tail */

  for (let i = n - 1; i >= 0; i--) {
    const k = i / (n - 1)
    const hue = lerpHue(genome.hue, genome.hue2, k)
    const heat = 1 - 0.62 * Math.min(1, k * 1.35)
    const r = radiusAt(i)
    const breathe = 1 + 0.06 * Math.sin(t * 2 + phase + i * 0.5)
    drawGlow(g, spine[i].x, spine[i].y, r * 2.6 * breathe, hue, 0.34 * heat * opts.glow)
    g.fillStyle = `hsla(${hue},72%,${62 + heat * 26}%,${(0.5 + 0.42 * heat) * opts.glow})`
    g.beginPath()
    g.arc(spine[i].x, spine[i].y, r * 0.52 * breathe, 0, Math.PI * 2)
    g.fill()
  }

  /* patterning: seeded photophore dots along the flank */

  const dots = Math.min(10, Math.floor(n * 0.8))
  for (let d = 0; d < dots; d++) {
    const i = 1 + Math.floor(rand() * (n - 2))
    const side = rand() > 0.5 ? 1 : -1
    const nx = -tang[i].y * side
    const ny = tang[i].x * side
    const r = radiusAt(i)
    const tw = 0.55 + 0.45 * Math.sin(t * (1.5 + rand()) + d * 2.2 + phase)
    g.fillStyle = `hsla(${genome.hue2},90%,86%,${0.5 * tw * opts.glow})`
    g.beginPath()
    g.arc(spine[i].x + nx * r * 0.55, spine[i].y + ny * r * 0.55, Math.max(0.6, r * 0.14), 0, Math.PI * 2)
    g.fill()
  }

  if (has('crest')) {
    const from = 1
    const to = Math.floor(n * 0.55)
    for (let i = from; i <= to; i += 2) {
      const nx = -tang[i].y
      const ny = tang[i].x
      const r = radiusAt(i)
      const len = r * (1.3 + 0.3 * Math.sin(t * 2.5 + i + phase))
      const tipX = spine[i].x + nx * (r + len)
      const tipY = spine[i].y + ny * (r + len)
      g.beginPath()
      g.moveTo(spine[i].x + nx * r * 0.6, spine[i].y + ny * r * 0.6)
      g.lineTo(tipX, tipY)
      g.strokeStyle = `hsla(${genome.hue2},88%,75%,${0.4 * opts.glow})`
      g.lineWidth = Math.max(0.7, r * 0.14)
      g.stroke()
      drawGlow(g, tipX, tipY, r * 0.35, genome.hue2, 0.4 * opts.glow)
    }
  }

  if (has('bell')) {
    const p = spine[0]
    const pulse = 1 + 0.09 * Math.sin(t * 2.3 + phase)
    const R = r0 * 1.9 * pulse
    const dir = Math.atan2(tang[0].y, tang[0].x)
    g.beginPath()
    g.arc(p.x, p.y, R, dir - Math.PI * 0.82, dir + Math.PI * 0.82)
    g.strokeStyle = `hsla(${genome.hue},80%,78%,${0.34 * opts.glow})`
    g.lineWidth = r0 * 0.28
    g.stroke()
    g.beginPath()
    g.arc(p.x, p.y, R * 0.82, dir - Math.PI * 0.7, dir + Math.PI * 0.7)
    g.strokeStyle = `hsla(${genome.hue},85%,85%,${0.14 * opts.glow})`
    g.lineWidth = r0 * 0.75
    g.stroke()
  }

  /* eyes — two unlit ink dots; the one part of a creature that absorbs light */

  const e = spine[0]
  const nx = -tang[0].y
  const ny = tang[0].x
  g.fillStyle = `rgba(6,10,18,${0.85 * Math.min(1, opts.glow + 0.3)})`
  for (const side of [-1, 1]) {
    g.beginPath()
    g.arc(e.x + nx * side * r0 * 0.42 + tang[0].x * r0 * 0.3, e.y + ny * side * r0 * 0.42 + tang[0].y * r0 * 0.3, Math.max(0.9, r0 * 0.13), 0, Math.PI * 2)
    g.fill()
  }

  /* resonance halo — other people's light, wrapped around this creature */

  if (opts.halo && opts.halo > 0.01) {
    const breathe = 1 + 0.1 * Math.sin(t * 1.1 + phase)
    drawGlow(g, e.x, e.y, r0 * (3.4 + opts.halo * 3.4) * breathe, lerpHue(genome.hue, genome.hue2, 0.5), 0.16 + opts.halo * 0.22, 70)
  }
}

/**
 * Relax a spine so segment i trails segment i-1 at `spacing` — one call per
 * frame per creature, after the head has been moved by whoever owns it.
 */
export const followSpine = (spine: SpinePoint[], spacing: number) => {
  for (let i = 1; i < spine.length; i++) {
    const dx = spine[i].x - spine[i - 1].x
    const dy = spine[i].y - spine[i - 1].y
    const d = Math.hypot(dx, dy) || 1
    const k = spacing / d
    spine[i].x = spine[i - 1].x + dx * k
    spine[i].y = spine[i - 1].y + dy * k
  }
}

/** Grow or shrink a pose array to match the genome without visual popping. */
export const fitSpine = (spine: SpinePoint[], segs: number) => {
  while (spine.length < segs) {
    const last = spine[spine.length - 1]
    spine.push({ x: last.x, y: last.y })
  }
  if (spine.length > segs) spine.length = segs
}
