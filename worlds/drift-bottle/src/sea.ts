/**
 * The ocean itself: one canvas, six layers of moving water, a light in the sky
 * and its reflection on the swell.
 *
 * Drawn rather than styled because the horizon has to be continuous behind
 * everything else, and because a bottle should sit on a crest that is actually
 * moving under it. The bottles are DOM on top — they are records, they need
 * hit-testing, focus and text.
 *
 * The palette follows `theme.mode` and nothing else. Arena's accent belongs on
 * buttons, not on the sea; a world is allowed to keep its own colours, and dawn
 * and midnight are the two this one has.
 */
export interface SeaPalette {
  skyTop: string
  skyBottom: string
  light: string
  lightGlow: string
  bands: string[]
  crest: string
  stars: boolean
}

export const NIGHT: SeaPalette = {
  skyTop: '#04060f',
  skyBottom: '#123049',
  light: '#f2ecd8',
  lightGlow: 'rgba(220,232,255,0.16)',
  bands: ['#0d2438', '#0b1e30', '#091829', '#071322', '#050f1b', '#040b15'],
  crest: 'rgba(190,225,255,0.30)',
  stars: true,
}

export const DAWN: SeaPalette = {
  skyTop: '#8fc9e8',
  skyBottom: '#f7dcc0',
  light: '#fff6e0',
  lightGlow: 'rgba(255,226,170,0.30)',
  bands: ['#4d9ab5', '#3f8aa6', '#347b96', '#2a6c86', '#215d75', '#194f65'],
  crest: 'rgba(255,255,255,0.42)',
  stars: false,
}

/** How many glints make up the light's path on the water. */
const GLINTS = 64

/** Deterministic 0..1 from an index — the reflection's shape, fixed once. */
function hash(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** The waterline, as a fraction of height. Bottles float below it. */
export const HORIZON = 0.42

interface Band {
  /** Vertical position under the horizon, 0..1 of the remaining height. */
  depth: number
  amp: number
  len: number
  speed: number
}

const BANDS: Band[] = [
  { depth: 0.0, amp: 3, len: 260, speed: 5 },
  { depth: 0.08, amp: 5, len: 220, speed: 9 },
  { depth: 0.2, amp: 8, len: 300, speed: 14 },
  { depth: 0.36, amp: 12, len: 380, speed: 20 },
  { depth: 0.56, amp: 17, len: 460, speed: 28 },
  { depth: 0.78, amp: 24, len: 560, speed: 38 },
]

export class Sea {
  private readonly g: CanvasRenderingContext2D
  private palette: SeaPalette = NIGHT
  private raf = 0
  private w = 0
  private h = 0
  private dpr = 1
  private t0 = performance.now()
  /** Fixed once, so the sky does not reshuffle on every resize. */
  private readonly stars = Array.from({ length: 90 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random() * 1.1 + 0.3,
    phase: Math.random() * Math.PI * 2,
  }))
  private readonly still = matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(private readonly canvas: HTMLCanvasElement) {
    const g = canvas.getContext('2d')
    if (!g) throw new Error('canvas 2d unavailable')
    this.g = g
    this.resize()
  }

  setPalette(p: SeaPalette): void {
    this.palette = p
    if (this.still) this.draw(0)
  }

  resize(): void {
    this.dpr = Math.min(devicePixelRatio || 1, 2)
    this.w = this.canvas.clientWidth
    this.h = this.canvas.clientHeight
    this.canvas.width = Math.max(1, Math.round(this.w * this.dpr))
    this.canvas.height = Math.max(1, Math.round(this.h * this.dpr))
    this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    if (this.still) this.draw(0)
  }

  start(): void {
    if (this.still) {
      this.draw(0)
      return
    }
    const loop = () => {
      this.draw((performance.now() - this.t0) / 1000)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
  }

  private draw(t: number): void {
    const { g, w, h } = this
    const p = this.palette
    const horizon = h * HORIZON
    g.clearRect(0, 0, w, h)

    const sky = g.createLinearGradient(0, 0, 0, horizon)
    sky.addColorStop(0, p.skyTop)
    sky.addColorStop(1, p.skyBottom)
    g.fillStyle = sky
    g.fillRect(0, 0, w, horizon + 1)

    if (p.stars) {
      for (const s of this.stars) {
        const y = s.y * horizon * 0.92
        g.globalAlpha = 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(t * 0.9 + s.phase))
        g.fillStyle = '#ffffff'
        g.beginPath()
        g.arc(s.x * w, y, s.r, 0, Math.PI * 2)
        g.fill()
      }
      g.globalAlpha = 1
    }

    // The light in the sky, and the haze it throws onto the water below it.
    const lx = w * 0.72
    const ly = horizon * 0.34
    const glow = g.createRadialGradient(lx, ly, 0, lx, ly, Math.max(w, h) * 0.42)
    glow.addColorStop(0, p.lightGlow)
    glow.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = glow
    g.fillRect(0, 0, w, h)
    g.fillStyle = p.light
    g.beginPath()
    g.arc(lx, ly, Math.min(w, h) * 0.045, 0, Math.PI * 2)
    g.fill()

    // Water body first, so a band that dips below its baseline still has sea
    // under it rather than sky.
    g.fillStyle = p.bands[0]
    g.fillRect(0, horizon, w, h - horizon)

    const sea = h - horizon
    for (let i = 0; i < BANDS.length; i++) {
      const b = BANDS[i]
      const y0 = horizon + sea * b.depth
      g.beginPath()
      g.moveTo(0, h)
      g.lineTo(0, y0)
      for (let x = 0; x <= w; x += 6) {
        const y =
          y0 +
          Math.sin((x / b.len) * Math.PI * 2 + (t * b.speed) / 12) * b.amp +
          Math.sin((x / (b.len * 0.37)) * Math.PI * 2 - (t * b.speed) / 21) * b.amp * 0.35
        g.lineTo(x, y)
      }
      g.lineTo(w, h)
      g.closePath()
      g.fillStyle = p.bands[Math.min(i, p.bands.length - 1)]
      g.fill()

      // A crest highlight on the alternating bands only — every band lit reads
      // as corduroy rather than as water.
      if (i % 2 === 1) {
        g.strokeStyle = p.crest
        g.lineWidth = 1
        g.globalAlpha = 0.5
        g.stroke()
        g.globalAlpha = 1
      }
    }

    // The light's reflection: a scattering of glints down the column beneath it,
    // in a wedge that widens with distance the way a real one does. The offsets
    // are hashed from the index rather than rolled, so the path is the same
    // shape frame to frame and only the wobble moves — rolling each frame would
    // read as static rather than as water.
    g.fillStyle = p.crest
    for (let i = 0; i < GLINTS; i++) {
      const f = (i % 22) / 22
      const y = horizon + sea * (f * f * 0.95 + 0.02)
      const wedge = 14 + f * 300
      const seed = hash(i)
      const wob = Math.sin(t * (0.7 + f * 1.6) + seed * 12)
      const x = lx + (seed - 0.5) * wedge + wob * (4 + f * 26)
      const len = (7 + f * 46) * (0.45 + 0.55 * Math.abs(wob))
      g.globalAlpha = (1 - f * 0.85) * 0.3 * (0.5 + 0.5 * Math.abs(wob))
      g.fillRect(x - len / 2, y, len, 1 + f * 2.5)
    }
    g.globalAlpha = 1
  }
}
