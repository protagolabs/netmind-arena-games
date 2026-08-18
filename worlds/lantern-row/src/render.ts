/**
 * The night street, drawn. Pure presentation: this module owns the canvas,
 * the camera, the ambient crowd and every lantern — and knows nothing about
 * storage or DOM sheets. `world.ts` feeds it plots and reads back hits.
 *
 * Two hard-won rules from the sibling worlds apply throughout:
 *  - the canvas gets EXPLICIT CSS width/height (a dpr>1 canvas positioned by
 *    inset alone renders at physical pixels and shows only its top-left);
 *  - everything time-based runs off the frame clock, never off setTimeout.
 */
import type { Plot } from './data.js'
import { BOARD_X, GATE_X, PLOT_W, WORLD_W } from './data.js'
import type { Strings } from './i18n.js'

const WORLD_H = 640
const FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif'

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v }
function lerp(a: number, b: number, k: number): number { return a + (b - a) * k }
function hash(n: number): number { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x) }
function shade(hex: string, k: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return 'rgb(' + Math.round(r * k) + ',' + Math.round(g * k) + ',' + Math.round(b * k) + ')'
}

interface Figure {
  x: number
  tx: number
  lane: number
  sp: number
  state: 'walk' | 'pause'
  t: number
  phase: number
  lantern: boolean
  tint: string
  pause: number
  kid: boolean
  balloon: string | null
}

interface Burst { x: number; y: number; vx: number; vy: number; life: number }

export type Hit = { type: 'bulletin' } | { type: 'plot'; plot: Plot } | null

export class Scene {
  private readonly cv: HTMLCanvasElement
  private readonly cx: CanvasRenderingContext2D
  private readonly glowWarm: HTMLCanvasElement
  private readonly glowRed: HTMLCanvasElement
  private readonly glowTeal: HTMLCanvasElement
  private readonly glowCloud: HTMLCanvasElement

  private vw = 1
  private vh = 1
  private dpr = 1
  private scale = 1
  private oy = 0

  camX = 600
  camVX = 0
  camTarget: number | null = null
  autoPan = true

  private readonly stars: Array<[number, number, number, number]> = []
  private readonly windows: Array<[number, number, number]> = []
  private readonly flies: Array<[number, number, number, number]> = []
  private readonly clouds: Array<[number, number, number, number, number]> = []
  private readonly skyLanterns: Array<{ x: number; y: number; phase: number; speed: number }> = []
  private readonly crowd: Figure[] = []
  private readonly bursts: Burst[] = []
  private readonly tints = ['#2c2448', '#342a4a', '#293252']

  private zh = true

  constructor(
    canvas: HTMLCanvasElement,
    private readonly plots: Plot[],
    private msg: Strings,
  ) {
    this.cv = canvas
    const c2d = canvas.getContext('2d')
    if (!c2d) throw new Error('no 2d context')
    this.cx = c2d
    this.glowWarm = makeGlow('255,186,105')
    this.glowRed = makeGlow('255,116,84')
    this.glowTeal = makeGlow('118,216,228')
    this.glowCloud = makeGlow('186,178,210')
    for (let i = 0; i < 130; i++) this.stars.push([Math.random(), Math.random() * 0.62, 0.5 + Math.random() * 1.3, Math.random() * 6.28])
    for (let i = 0; i < 40; i++) this.windows.push([Math.random() * WORLD_W * 0.6, 452 + Math.random() * 55, hash(i) * 6.28])
    for (let i = 0; i < 16; i++) this.flies.push([Math.random() * WORLD_W, 400 + Math.random() * 150, Math.random() * 6.28, 0.5 + Math.random() * 0.8])
    for (let i = 0; i < 3; i++) this.clouds.push([Math.random(), 0.1 + Math.random() * 0.3, 170 + Math.random() * 150, 3 + Math.random() * 4, 0.05 + Math.random() * 0.035])
    for (let i = 0; i < 4; i++) this.skyLanterns.push({ x: 500 + Math.random() * (WORLD_W - 1000), y: 90 + Math.random() * 240, phase: Math.random() * 6.28, speed: 3.2 + Math.random() * 2.6 })
    for (let i = 0; i < 38; i++) this.spawnFigure(false)
    for (let i = 0; i < 170; i++) this.updateCrowd(0.05)
  }

  setStrings(msg: Strings, zh: boolean): void { this.msg = msg; this.zh = zh }

  resize(w: number, h: number, dpr: number): void {
    this.vw = Math.max(1, w)
    this.vh = Math.max(1, h)
    this.dpr = Math.min(dpr, 2)
    this.cv.width = Math.round(this.vw * this.dpr)
    this.cv.height = Math.round(this.vh * this.dpr)
    this.cv.style.width = this.vw + 'px'
    this.cv.style.height = this.vh + 'px'
    this.scale = Math.min(this.vh / WORLD_H, this.vw / 1150)
    this.oy = this.vh - WORLD_H * this.scale
    if (this.oy > this.vh * 0.26) {
      this.scale = (this.vh * 0.74) / WORLD_H
      this.oy = this.vh * 0.26
    }
  }

  worldX(sx: number): number { return (sx - this.vw / 2) / this.scale + this.camX }
  worldY(sy: number): number { return (sy - this.oy) / this.scale }
  panBy(dxScreen: number): void { this.camX = clamp(this.camX - dxScreen / this.scale, 320, WORLD_W - 300) }
  panTo(x: number): void { this.camX = clamp(x, 320, WORLD_W - 300) }
  flingBy(v: number): void { this.camVX = clamp(v / this.scale, -1400, 1400) }
  flyTo(x: number): void { this.camTarget = clamp(x, 320, WORLD_W - 300); this.autoPan = false }
  stopAuto(): void { this.autoPan = false; this.camTarget = null }

  hit(wx: number, wy: number): Hit {
    if (wy > 160 && wy < 585 && Math.abs(wx - GATE_X) < 160) return { type: 'bulletin' }
    if (wy > 360 && wy < 585 && Math.abs(wx - BOARD_X) < 122) return { type: 'bulletin' }
    for (const p of this.plots) {
      if (wx >= p.x + 6 && wx <= p.x + PLOT_W - 6 && wy > 350 && wy < 585) return { type: 'plot', plot: p }
    }
    return null
  }

  burstAt(x: number, y: number): void {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * 6.28
      const v = 30 + Math.random() * 70
      this.bursts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 40, life: 0.9 + Math.random() * 0.5 })
    }
  }

  /** A wave of newcomers heading for one plot — the "crowd arriving" moment. */
  flock(target: Plot, n: number): void {
    for (let i = 0; i < n; i++) this.spawnFigure(true, target)
  }

  /* ────────────────────────── crowd ────────────────────────── */

  private liveStalls(): Plot[] {
    return this.plots.filter((p) => (p.kind !== 'empty' && p.kind !== 'ghost') || (p.kind === 'ghost' && !!p.preview))
  }

  private pickTarget(): Plot | null {
    const ls = this.liveStalls()
    if (!ls.length) return null
    let tot = 0
    for (const s of ls) tot += s.heat
    let r = Math.random() * tot
    for (const s of ls) { r -= s.heat; if (r <= 0) return s }
    return ls[0] ?? null
  }

  private spawnFigure(atEdge: boolean, force?: Plot): void {
    const st = force ?? (Math.random() < 0.82 ? this.pickTarget() : null)
    const tx = st ? st.x + 30 + Math.random() * (PLOT_W - 60) : 400 + Math.random() * (WORLD_W - 800)
    const span = this.vw / this.scale
    const x = atEdge
      ? (Math.random() < 0.5 ? this.camX - span * 0.6 - 60 : this.camX + span * 0.6 + 60)
      : 300 + Math.random() * (WORLD_W - 600)
    const kid = Math.random() < 0.14
    const balloon = !kid && Math.random() < 0.08
      ? (['#e05a48', '#f0a03c', '#57d18e'][(Math.random() * 3) | 0] ?? '#e05a48')
      : null
    this.crowd.push({
      x: clamp(x, 120, WORLD_W - 120), tx, lane: Math.random(),
      sp: (kid ? 34 : 26) + Math.random() * 26, state: 'walk', t: 0,
      phase: Math.random() * 6.28, lantern: !balloon && Math.random() < 0.58,
      tint: this.tints[(Math.random() * 3) | 0] ?? '#2c2448', pause: 2 + Math.random() * 6,
      kid, balloon,
    })
  }

  private updateCrowd(dt: number): void {
    for (let i = this.crowd.length - 1; i >= 0; i--) {
      const f = this.crowd[i]
      if (!f) continue
      f.phase += dt * (f.state === 'walk' ? 7 : 1.2)
      if (f.state === 'walk') {
        const d = f.tx - f.x
        f.x += clamp(d, -1, 1) * f.sp * dt
        if (Math.abs(d) < 4) { f.state = 'pause'; f.t = f.pause }
      } else {
        f.t -= dt
        if (f.t <= 0) {
          if (Math.random() < 0.12 && this.crowd.length > 26) { this.crowd.splice(i, 1); continue }
          const st = this.pickTarget()
          if (st) f.tx = st.x + 30 + Math.random() * (PLOT_W - 60)
          f.state = 'walk'
        }
      }
    }
    if (this.crowd.length < 40 && Math.random() < dt * 0.7) this.spawnFigure(true)
  }

  /* ────────────────────────── frame ────────────────────────── */

  frame(t: number, dt: number): void {
    const wind = Math.sin(t * 0.5) * 0.5 + Math.sin(t * 0.13) * 0.5

    if (this.autoPan) this.camX = clamp(this.camX + 22 * dt, 320, 2450)
    if (this.camTarget !== null) {
      this.camX += (this.camTarget - this.camX) * Math.min(1, dt * 2.6)
      if (Math.abs(this.camTarget - this.camX) < 3) this.camTarget = null
    }
    if (Math.abs(this.camVX) > 4) {
      this.camX = clamp(this.camX + this.camVX * dt, 320, WORLD_W - 300)
      this.camVX *= Math.pow(0.05, dt)
    }

    for (const p of this.plots) {
      const base = 6 + p.lamps * 2
      if (p.heat > base) p.heat = Math.max(base, p.heat - dt * 14)
      if (p.flash > 0) p.flash = Math.max(0, p.flash - dt * 1.4)
      if (p.preview && p.buildT < 1) p.buildT = Math.min(1, p.buildT + dt / 1.7)
    }

    this.updateCrowd(dt)

    this.drawSky(t)
    this.drawSkyLanterns(t, dt)
    this.drawMountains()
    this.drawRooftops(t)
    this.drawGround()
    this.layer(1)
    this.drawEndHint()
    this.drawGate(t, wind)
    this.drawBrazier(t)
    this.drawBoard(t)
    for (const p of this.plots) this.drawPlot(p, t, wind)
    this.drawStrings(t, wind)
    this.drawCat(t)
    this.drawFlies(t)

    this.crowd.sort((a, b) => a.lane - b.lane)
    for (const f of this.crowd) this.drawFigure(f)

    for (let i = this.bursts.length - 1; i >= 0; i--) {
      const b = this.bursts[i]
      if (!b) continue
      b.life -= dt
      if (b.life <= 0) { this.bursts.splice(i, 1); continue }
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.vy += 120 * dt
      this.cx.fillStyle = 'rgba(255,202,122,' + clamp(b.life, 0, 1) + ')'
      this.cx.fillRect(b.x - 1.4, b.y - 1.4, 2.8, 2.8)
      this.glow(this.glowWarm, b.x, b.y, 6, clamp(b.life * 0.5, 0, 0.5))
    }

    this.drawVignette()
  }

  /* ────────────────────────── layers ────────────────────────── */

  private layer(p: number): void {
    this.cx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * (this.vw / 2 - this.camX * p * this.scale), this.dpr * this.oy)
  }

  private screenSpace(): void {
    this.cx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  private glow(img: HTMLCanvasElement, x: number, y: number, r: number, a: number): void {
    const c = this.cx
    c.globalCompositeOperation = 'lighter'
    c.globalAlpha = a
    c.drawImage(img, x - r, y - r, r * 2, r * 2)
    c.globalAlpha = 1
    c.globalCompositeOperation = 'source-over'
  }

  private drawSky(t: number): void {
    const c = this.cx
    this.screenSpace()
    const hz = 500 * this.scale + this.oy
    const g = c.createLinearGradient(0, 0, 0, hz * 1.12)
    g.addColorStop(0, '#04060e')
    g.addColorStop(0.55, '#0a0e20')
    g.addColorStop(1, '#181430')
    c.fillStyle = g
    c.fillRect(0, 0, this.vw, this.vh)
    for (const st of this.stars) {
      const tw = Math.abs(Math.sin(t * 0.6 + st[3]))
      const a = 0.35 + 0.45 * tw
      const sx = st[0] * this.vw
      const sy = st[1] * hz
      c.fillStyle = 'rgba(210,225,255,' + a + ')'
      c.fillRect(sx, sy, st[2], st[2])
      if (st[2] > 1.5 && tw > 0.82) {
        const r = 3.5 + tw * 3
        c.fillStyle = 'rgba(210,225,255,' + (tw - 0.8) * 1.6 + ')'
        c.fillRect(sx - r, sy + st[2] / 2 - 0.4, r * 2 + st[2], 0.8)
        c.fillRect(sx + st[2] / 2 - 0.4, sy - r, 0.8, r * 2 + st[2])
      }
    }
    for (const cl of this.clouds) {
      const cxp = (((cl[0] * (this.vw + 400) + t * cl[3]) % (this.vw + 400)) + this.vw + 400) % (this.vw + 400) - 200
      const cyp = cl[1] * hz
      c.globalAlpha = cl[4] * 2.2
      c.drawImage(this.glowCloud, cxp - cl[2] * 1.3, cyp - 24, cl[2] * 2.6, 48)
      c.drawImage(this.glowCloud, cxp - cl[2] * 0.9, cyp - 14, cl[2] * 1.2, 34)
      c.drawImage(this.glowCloud, cxp, cyp - 12, cl[2] * 1.1, 30)
      c.globalAlpha = 1
    }
    const mx = this.vw * 0.76 - this.camX * 0.015
    const my = Math.max(56, hz * 0.24)
    this.glow(this.glowWarm, mx, my, 84 + Math.sin(t * 0.6) * 9, 0.22 + Math.abs(Math.sin(t * 0.3)) * 0.06)
    c.fillStyle = '#f2e6ce'
    c.beginPath(); c.arc(mx, my, 26, 0, 6.28); c.fill()
    c.fillStyle = 'rgba(190,175,150,0.5)'
    c.beginPath(); c.arc(mx - 8, my - 5, 4, 0, 6.28); c.fill()
    c.beginPath(); c.arc(mx + 6, my + 8, 3, 0, 6.28); c.fill()
    c.beginPath(); c.arc(mx + 10, my - 9, 2.2, 0, 6.28); c.fill()
  }

  /** Distant sky lanterns released down-street — the market's namesake, far off. */
  private drawSkyLanterns(t: number, dt: number): void {
    const c = this.cx
    this.layer(0.1)
    for (const k of this.skyLanterns) {
      k.y -= k.speed * dt
      k.x += 5 * dt
      if (k.y < 60) {
        k.y = 320 + Math.random() * 60
        k.x = this.camX * 0.1 + (Math.random() - 0.5) * this.vw * 1.4
      }
      const sway = Math.sin(t * 0.7 + k.phase) * 3
      const a = 0.5 + 0.3 * Math.abs(Math.sin(t * 1.3 + k.phase))
      this.glow(this.glowWarm, k.x + sway, k.y, 10, a * 0.6)
      c.fillStyle = 'rgba(255,196,120,' + a + ')'
      c.fillRect(k.x + sway - 1.6, k.y - 2.4, 3.2, 4.8)
      c.fillStyle = 'rgba(200,120,60,' + a * 0.8 + ')'
      c.fillRect(k.x + sway - 1.6, k.y + 2.4, 3.2, 1)
    }
  }

  private drawMountains(): void {
    const c = this.cx
    this.layer(0.07)
    c.fillStyle = '#080c17'
    c.beginPath()
    c.moveTo(this.camX * 0.07 - this.vw, 512)
    for (let i = 0; i <= 30; i++) {
      const px = this.camX * 0.07 - this.vw + (this.vw * 2 / 30) * i
      c.lineTo(px, 452 - (1 - Math.abs(Math.sin(px * 0.0012 + 2.6))) * 46)
    }
    c.lineTo(this.camX * 0.07 + this.vw, 512)
    c.fill()
    this.layer(0.12)
    c.fillStyle = '#0a0f1d'
    c.beginPath()
    c.moveTo(this.camX * 0.12 - this.vw, 520)
    for (let i = 0; i <= 40; i++) {
      const px = this.camX * 0.12 - this.vw + (this.vw * 2 / 40) * i
      c.lineTo(px, 468 - (1 - Math.abs(Math.sin(px * 0.0021 + 1.2))) * 65)
    }
    c.lineTo(this.camX * 0.12 + this.vw, 520)
    c.fill()
    this.layer(0.22)
    c.fillStyle = '#0e1526'
    c.beginPath()
    c.moveTo(this.camX * 0.22 - this.vw, 540)
    for (let j = 0; j <= 40; j++) {
      const qx = this.camX * 0.22 - this.vw + (this.vw * 2 / 40) * j
      c.lineTo(qx, 498 - (1 - Math.abs(Math.sin(qx * 0.0034 + 4.1))) * 42)
    }
    c.lineTo(this.camX * 0.22 + this.vw, 540)
    c.fill()
    this.layer(0.35)
    const hg = c.createLinearGradient(0, 496, 0, 560)
    hg.addColorStop(0, 'rgba(28,22,44,0)')
    hg.addColorStop(1, 'rgba(30,22,40,0.85)')
    c.fillStyle = hg
    c.fillRect(this.camX * 0.35 - this.vw, 496, this.vw * 2, 64)
  }

  private drawRooftops(t: number): void {
    const c = this.cx
    this.layer(0.5)
    const x0 = this.camX * 0.5 - this.vw
    const x1 = this.camX * 0.5 + this.vw
    c.fillStyle = '#111729'
    c.beginPath()
    c.moveTo(x0, 560)
    let px = x0
    let n = 0
    while (px < x1) {
      const rw = 60 + hash(n * 13) * 80
      const rh = 460 + hash(n * 29) * 48
      c.lineTo(px, rh + 14)
      c.lineTo(px + rw * 0.5, rh)
      c.lineTo(px + rw, rh + 14)
      px += rw
      n++
    }
    c.lineTo(x1, 560)
    c.fill()
    for (const wn of this.windows) {
      const a = 0.35 + 0.3 * Math.abs(Math.sin(t * 0.4 + wn[2]))
      c.fillStyle = 'rgba(232,164,74,' + a + ')'
      c.fillRect(wn[0], wn[1], 3, 4)
    }
  }

  private drawGround(): void {
    const c = this.cx
    this.layer(1)
    c.fillStyle = '#221b2b'
    c.fillRect(this.camX - this.vw, 556, this.vw * 2, 6)
    const g = c.createLinearGradient(0, 562, 0, 640)
    g.addColorStop(0, '#1a1522')
    g.addColorStop(1, '#120e18')
    c.fillStyle = g
    c.fillRect(this.camX - this.vw, 562, this.vw * 2, 78)
    c.fillStyle = '#0e0b12'
    c.fillRect(this.camX - this.vw, 640, this.vw * 2, 80)
    c.strokeStyle = 'rgba(255,255,255,0.028)'
    c.lineWidth = 1
    const rows = [578, 596, 616, 638]
    for (const ry of rows) {
      c.beginPath(); c.moveTo(this.camX - this.vw, ry); c.lineTo(this.camX + this.vw, ry); c.stroke()
    }
    const sx = Math.floor((this.camX - this.vw) / 58) * 58
    for (let px = sx; px < this.camX + this.vw; px += 58) {
      for (let r = 0; r < rows.length - 1; r++) {
        const top = rows[r] ?? 578
        const bot = rows[r + 1] ?? 638
        const jx = px + (r % 2 ? 29 : 0)
        c.beginPath(); c.moveTo(jx, top); c.lineTo(jx - 4, bot); c.stroke()
      }
    }
    for (const p of this.plots) {
      if (p.kind === 'empty') continue
      if (p.kind === 'ghost' && !p.preview) continue
      c.globalCompositeOperation = 'lighter'
      c.globalAlpha = 0.2
      c.drawImage(this.glowWarm, p.x + PLOT_W / 2 - 160, 560 - 40, 320, 116)
      c.globalAlpha = 1
      c.globalCompositeOperation = 'source-over'
      const wg = c.createLinearGradient(0, 578, 0, 634)
      wg.addColorStop(0, 'rgba(255,190,110,0.085)')
      wg.addColorStop(1, 'rgba(255,190,110,0)')
      c.fillStyle = wg
      c.fillRect(p.x + 34, 578, PLOT_W - 68, 56)
      c.fillRect(p.x + PLOT_W / 2 - 9, 578, 18, 50)
    }
    this.glow(this.glowWarm, GATE_X, 590, 160, 0.1)
  }

  private drawEndHint(): void {
    const c = this.cx
    const ex = WORLD_W - 60
    for (let i = 0; i < 5; i++) {
      const lx = ex + i * 46
      const ly = 430 + i * 6
      const a = 0.35 - i * 0.06
      this.glow(this.glowWarm, lx, ly, 16, a)
      c.fillStyle = 'rgba(255,190,110,' + a + ')'
      c.beginPath(); c.arc(lx, ly, 2.4, 0, 6.28); c.fill()
    }
  }

  private drawLantern(x: number, y: number, w: number, h: number, body: string, sway: number, img: HTMLCanvasElement, ga: number): void {
    const c = this.cx
    c.save()
    c.translate(x, y)
    c.rotate(sway)
    c.strokeStyle = 'rgba(90,66,36,0.9)'
    c.lineWidth = 1.2
    c.beginPath(); c.moveTo(0, 0); c.lineTo(0, 6); c.stroke()
    this.glow(img, 0, 6 + h / 2, h * 1.7, ga)
    c.fillStyle = body
    rr(c, -w / 2, 6, w, h, w * 0.4)
    c.fill()
    c.fillStyle = 'rgba(40,24,10,0.9)'
    c.fillRect(-w * 0.3, 4.4, w * 0.6, 2.4)
    c.fillRect(-w * 0.3, 6 + h - 0.8, w * 0.6, 2.4)
    c.fillStyle = 'rgba(255,240,200,0.55)'
    c.fillRect(-0.8, 8, 1.6, h - 4)
    c.restore()
  }

  private drawGate(t: number, wind: number): void {
    const c = this.cx
    const x = GATE_X
    this.glow(this.glowWarm, x, 330, 230, 0.2)
    c.fillStyle = '#241a12'
    c.fillRect(x - 104, 300, 20, 275)
    c.fillRect(x + 84, 300, 20, 275)
    c.fillStyle = '#1c130c'
    c.fillRect(x - 112, 560, 36, 15)
    c.fillRect(x + 76, 560, 36, 15)
    c.fillStyle = '#2c2014'
    c.fillRect(x - 130, 296, 260, 18)
    c.fillRect(x - 150, 246, 300, 20)
    c.fillStyle = '#171008'
    c.beginPath(); c.moveTo(x - 150, 246); c.lineTo(x - 170, 238); c.lineTo(x - 150, 232); c.fill()
    c.beginPath(); c.moveTo(x + 150, 246); c.lineTo(x + 170, 238); c.lineTo(x + 150, 232); c.fill()
    c.fillRect(x - 160, 238, 320, 9)
    c.fillStyle = '#100a06'
    rr(c, x - 76, 176, 152, 58, 6)
    c.fill()
    c.strokeStyle = '#7a5524'
    c.lineWidth = 2
    rr(c, x - 71, 181, 142, 48, 5)
    c.stroke()
    this.glow(this.glowWarm, x, 205, 110, 0.3)
    c.fillStyle = '#ffdf9e'
    c.font = '600 ' + (this.msg.cvGate.length > 6 ? 22 : 30) + 'px ' + FONT
    c.textAlign = 'center'
    c.fillText(this.msg.cvGate, x, 216)
    c.fillStyle = 'rgba(200,180,140,0.75)'
    c.font = '400 9px ' + FONT
    c.fillText(this.msg.cvGateSub, x, 258)
    for (let i = 0; i < 4; i++) {
      const lx = x - 90 + i * 60
      this.drawLantern(lx, 314, 15, 20, '#c8433a', Math.sin(t + i * 1.4) * 0.07 + wind * 0.05, this.glowRed, 0.6)
    }
    for (const side of [-1, 1]) {
      const px = x + side * 94
      c.fillStyle = '#6e1f16'
      c.fillRect(px - 7, 330, 14, 118)
      c.strokeStyle = 'rgba(240,200,120,0.35)'
      c.lineWidth = 1
      c.strokeRect(px - 5.5, 332, 11, 114)
      c.fillStyle = 'rgba(240,200,120,0.3)'
      for (let d = 0; d < 4; d++) c.fillRect(px - 1.4, 342 + d * 26, 2.8, 13)
    }
  }

  /** A little charcoal brazier by the gate — embers, warmth, a thread of steam. */
  private drawBrazier(t: number): void {
    const c = this.cx
    const x = GATE_X + 178
    const y = 575
    c.strokeStyle = '#241a12'
    c.lineWidth = 3
    c.beginPath(); c.moveTo(x - 8, y); c.lineTo(x - 3, y - 14); c.stroke()
    c.beginPath(); c.moveTo(x + 8, y); c.lineTo(x + 3, y - 14); c.stroke()
    c.fillStyle = '#2c2118'
    c.beginPath(); c.ellipse(x, y - 18, 13, 6, 0, 0, 6.28); c.fill()
    c.fillStyle = '#1a1208'
    c.beginPath(); c.ellipse(x, y - 20, 10, 4, 0, 0, 6.28); c.fill()
    const ember = 0.5 + 0.3 * Math.abs(Math.sin(t * 2.1))
    this.glow(this.glowWarm, x, y - 20, 22, ember)
    c.fillStyle = 'rgba(255,150,70,' + ember + ')'
    c.beginPath(); c.ellipse(x, y - 20, 6, 2.4, 0, 0, 6.28); c.fill()
    for (let k = 0; k < 3; k++) {
      const pr = ((t * 0.22 + k / 3) % 1)
      const sy = y - 28 - pr * 52
      const swx = Math.sin(t * 0.9 + k * 2.1 + pr * 4) * (4 + pr * 6)
      c.fillStyle = 'rgba(216,208,226,' + (1 - pr) * 0.13 + ')'
      c.beginPath(); c.ellipse(x + swx, sy, 4 + pr * 9, 3 + pr * 5, 0, 0, 6.28); c.fill()
    }
  }

  private drawBoard(t: number): void {
    const c = this.cx
    const x = BOARD_X
    c.fillStyle = '#241a12'
    c.fillRect(x - 86, 400, 11, 175)
    c.fillRect(x + 75, 400, 11, 175)
    c.fillStyle = '#1a1208'
    c.fillRect(x - 104, 382, 208, 15)
    c.beginPath(); c.moveTo(x - 104, 382); c.lineTo(x - 118, 377); c.lineTo(x - 104, 371); c.fill()
    c.beginPath(); c.moveTo(x + 104, 382); c.lineTo(x + 118, 377); c.lineTo(x + 104, 371); c.fill()
    c.fillStyle = '#2a2016'
    c.fillRect(x - 92, 397, 184, 148)
    this.glow(this.glowWarm, x, 470, 150, 0.3)
    c.fillStyle = '#c4b08a'
    c.fillRect(x - 82, 407, 164, 128)
    c.fillStyle = '#a03828'
    c.fillRect(x - 82, 407, 164, 30)
    c.fillStyle = '#f5ecd4'
    c.font = '600 ' + (this.msg.cvBoardTitle.length > 8 ? 14 : 19) + 'px ' + FONT
    c.textAlign = 'center'
    c.fillText(this.msg.cvBoardTitle, x, 428)
    c.fillStyle = '#3a2c1a'
    c.font = '500 13px ' + FONT
    c.fillText(this.msg.cvBoardSub, x, 460)
    c.strokeStyle = '#7a684a'
    c.lineWidth = 1.6
    for (let i = 0; i < 4; i++) {
      c.beginPath()
      c.moveTo(x - 62, 478 + i * 14)
      c.lineTo(x - 62 + 124 - hash(i * 5) * 44, 478 + i * 14)
      c.stroke()
    }
    const pa = 0.55 + Math.sin(t * 2.2) * 0.25
    c.fillStyle = 'rgba(240,180,92,' + pa + ')'
    c.font = '500 11px ' + FONT
    c.fillText(this.msg.cvBoardClick, x, 558)
    this.drawLantern(x - 96, 386, 13, 17, '#e8a44a', Math.sin(t * 1.15) * 0.08, this.glowWarm, 0.6)
    this.drawLantern(x + 96, 386, 13, 17, '#e8a44a', Math.sin(t * 1.3 + 2) * 0.08, this.glowWarm, 0.6)
  }

  /* ────────────────────────── plots ────────────────────────── */

  private drawPlot(p: Plot, t: number, wind: number): void {
    const c = this.cx
    const x = p.x
    const w = PLOT_W
    const base = 575

    if (p.kind === 'empty' || (p.kind === 'ghost' && !p.preview)) {
      const ghost = p.kind === 'ghost'
      c.strokeStyle = ghost ? 'rgba(118,216,228,0.4)' : 'rgba(200,170,120,0.22)'
      c.setLineDash([7, 6])
      c.strokeRect(x + 14, 452, w - 28, base - 452)
      c.setLineDash([])
      c.fillStyle = '#1b1410'
      c.fillRect(x + 22, 408, 9, base - 408)
      c.fillRect(x + w - 31, 408, 9, base - 408)
      c.fillRect(x + 14, 400, w - 28, 10)
      const sway = Math.sin(t * 1.1 + p.seed) * 0.09 + wind * 0.05
      this.drawLantern(x + w / 2, 412, 17, 24, ghost ? '#8fd8dc' : '#e8a44a', sway, ghost ? this.glowTeal : this.glowWarm, 0.65)
      c.save()
      c.translate(x + w / 2, 412)
      c.rotate(sway)
      c.fillStyle = ghost ? '#0c3034' : '#4a2c08'
      c.font = '600 9px ' + FONT
      c.textAlign = 'center'
      const chars = ghost ? this.msg.cvLanternGhost : this.msg.cvLanternRent
      c.fillText(chars[0], 0, 16)
      if (chars[1]) c.fillText(chars[1], 0, 26)
      c.restore()
      if (ghost) {
        const pa = 0.45 + Math.sin(t * 1.6) * 0.25
        c.fillStyle = 'rgba(140,220,228,' + pa + ')'
        c.font = '500 19px ' + FONT
        c.textAlign = 'center'
        c.fillText(this.msg.cvGhost, x + w / 2, 505)
        c.font = '400 11px ' + FONT
        c.fillStyle = 'rgba(140,220,228,' + pa * 0.7 + ')'
        c.fillText(this.msg.cvGhostSub, x + w / 2, 528)
      } else {
        c.fillStyle = 'rgba(200,170,120,0.4)'
        c.font = '400 12px ' + FONT
        c.textAlign = 'center'
        c.fillText(this.msg.cvForRent, x + w / 2, 508)
      }
      const ws = p.wishes
      for (let wl = 0; wl < Math.min(ws.length, 6); wl++) {
        const wx = x + 40 + wl * 30
        this.drawLantern(wx, 412, 10, 13, '#c8433a', Math.sin(t * 1.3 + wl * 1.7) * 0.1, this.glowRed, 0.4)
      }
      return
    }

    const name = p.kind === 'ghost' && p.preview ? p.preview.name : (this.zh ? p.nameZh : p.nameEn)
    const color = p.kind === 'ghost' && p.preview ? p.preview.color : p.color
    const screen = p.kind === 'ghost' ? 'bounce' : p.screen
    const bp = clamp(p.buildT, 0, 1)
    const topVar = (hash(p.seed) - 0.5) * 18
    const canopyTop = 362 + topVar

    if (bp > 0.05) {
      c.globalAlpha = clamp(bp * 2.5, 0, 1)
      c.fillStyle = '#191022'
      c.fillRect(x + 20, 430, w - 40, 145)
      c.fillStyle = 'rgba(60,38,18,0.55)'
      c.fillRect(x + 24, 434, w - 48, 137)
      this.glow(this.glowWarm, x + w / 2, 490, 130, 0.22 * bp)
      c.globalAlpha = 1
    }

    if (bp > 0.55) {
      const sx = x + w / 2 - 76
      const sy = 442
      const sw = 152
      const sh = 82
      c.save()
      c.beginPath()
      c.rect(sx, sy, sw, sh)
      c.clip()
      this.drawScreen(screen, sx, sy, sw, sh, t, color)
      c.restore()
      c.strokeStyle = '#4a3620'
      c.lineWidth = 3
      c.strokeRect(sx - 1.5, sy - 1.5, sw + 3, sh + 3)
      c.fillStyle = 'rgba(255,255,255,0.09)'
      c.fillRect(sx, sy, sw, 1.2)
      c.fillStyle = 'rgba(255,255,255,0.04)'
      c.beginPath()
      c.moveTo(sx + 14, sy)
      c.lineTo(sx + 34, sy)
      c.lineTo(sx + 58, sy + sh)
      c.lineTo(sx + 38, sy + sh)
      c.closePath()
      c.fill()
    }

    if (bp > 0.05) {
      c.fillStyle = '#241a12'
      c.fillRect(x + 16, 534, w - 32, 41)
      c.fillStyle = '#3a2a1a'
      c.fillRect(x + 16, 534, w - 32, 4)
      c.strokeStyle = 'rgba(0,0,0,0.35)'
      c.lineWidth = 1
      for (let pl = 1; pl < 4; pl++) {
        c.beginPath(); c.moveTo(x + 16, 534 + pl * 10); c.lineTo(x + w - 16, 534 + pl * 10); c.stroke()
      }
      if (hash(p.seed * 3) > 0.4) {
        c.fillStyle = '#201812'
        c.fillRect(x + w - 58, 508, 30, 26)
        c.fillRect(x + w - 52, 486, 22, 22)
        c.strokeStyle = 'rgba(120,90,50,0.4)'
        c.strokeRect(x + w - 58, 508, 30, 26)
        c.strokeRect(x + w - 52, 486, 22, 22)
      }
      if (hash(p.seed * 5) > 0.35) {
        c.fillStyle = '#1d150e'
        rr(c, x + 30, 520, 11, 14, 3)
        c.fill()
        c.fillStyle = 'rgba(255,200,130,0.3)'
        c.fillRect(x + 31.5, 520, 8, 1.6)
      }
      if (hash(p.seed * 7) > 0.5) {
        c.fillStyle = '#1a130c'
        c.beginPath()
        c.arc(x + 54, 534, 7, Math.PI, 0)
        c.fill()
        c.fillStyle = 'rgba(255,200,130,0.22)'
        c.fillRect(x + 47, 526.5, 14, 1.4)
      }
      c.fillStyle = '#2c2118'
      c.fillRect(x + 12, 402, 11, 173)
      c.fillRect(x + w - 23, 402, 11, 173)
      c.fillStyle = 'rgba(255,200,130,0.14)'
      c.fillRect(x + 21, 402, 2, 173)
      c.fillRect(x + w - 25, 402, 2, 173)
    }

    if (bp > 0.3) {
      const ca = clamp((bp - 0.3) * 3, 0, 1)
      c.globalAlpha = ca
      c.fillStyle = shade(color, 0.52)
      c.beginPath()
      c.moveTo(x + 2, 400)
      c.lineTo(x + 18, canopyTop)
      c.lineTo(x + w - 18, canopyTop)
      c.lineTo(x + w - 2, 400)
      c.closePath()
      c.fill()
      const segs = 5
      const sw2 = (w - 4) / segs
      for (let sg = 0; sg < segs; sg++) {
        c.fillStyle = shade(color, sg % 2 ? 0.42 : 0.62)
        c.beginPath()
        c.moveTo(x + 2 + sg * sw2, 400)
        c.lineTo(x + 2 + (sg + 1) * sw2, 400)
        c.arc(x + 2 + (sg + 0.5) * sw2, 400, sw2 / 2, 0, Math.PI)
        c.closePath()
        c.fill()
      }
      c.fillStyle = 'rgba(255,220,160,0.1)'
      c.beginPath()
      c.moveTo(x + 2, 400)
      c.lineTo(x + 18, canopyTop)
      c.lineTo(x + w - 18, canopyTop)
      c.lineTo(x + w - 2, 400)
      c.closePath()
      c.fill()
      const vsegs = 9
      const vw2 = (w - 12) / vsegs
      for (let vg = 0; vg < vsegs; vg++) {
        c.fillStyle = shade(color, vg % 2 ? 0.34 : 0.46)
        c.beginPath()
        c.moveTo(x + 6 + vg * vw2, 400)
        c.lineTo(x + 6 + (vg + 1) * vw2, 400)
        c.arc(x + 6 + (vg + 0.5) * vw2, 400, vw2 / 2, 0, Math.PI)
        c.closePath()
        c.fill()
      }
      c.globalAlpha = 1
    }

    if (bp > 0.68) {
      c.font = '600 20px ' + FONT
      const tw = c.measureText(name).width
      const bw = Math.max(tw + 36, 96)
      const bx = x + w / 2 - bw / 2
      const by = 408
      this.glow(this.glowWarm, x + w / 2, by + 16, bw * 0.7, 0.34 + p.flash * 0.5)
      c.fillStyle = '#170f07'
      rr(c, bx, by, bw, 33, 5)
      c.fill()
      c.strokeStyle = '#7a5524'
      c.lineWidth = 1.6
      rr(c, bx + 2.5, by + 2.5, bw - 5, 28, 4)
      c.stroke()
      c.fillStyle = '#ffdf9e'
      c.textAlign = 'center'
      c.fillText(name, x + w / 2, by + 24)
      if (p.kind === 'demo') {
        c.fillStyle = '#0e0803'
        rr(c, x + w / 2 - 56, by + 37, 112, 17, 3)
        c.fill()
        c.fillStyle = '#e8a44a'
        c.font = '500 10px ' + FONT
        c.fillText(this.msg.cvDemoBadge, x + w / 2, by + 49)
      }
    }

    if (bp > 0.88) {
      const sway1 = Math.sin(t * 1.2 + p.seed) * 0.08 + wind * 0.06
      const sway2 = Math.sin(t * 1.05 + p.seed * 2.1) * 0.08 + wind * 0.06
      this.drawLantern(x + 17, 404, 13, 17, '#c8433a', sway1, this.glowRed, 0.55)
      this.drawLantern(x + w - 17, 404, 13, 17, '#c8433a', sway2, this.glowRed, 0.55)
    }
    if (p.flash > 0) this.glow(this.glowWarm, x + w / 2, 470, 170, p.flash * 0.5)
  }

  /* ────────────────────────── stall windows ────────────────────────── */

  private drawScreen(key: string, x: number, y: number, w: number, h: number, t: number, col: string): void {
    const c = this.cx
    switch (key) {
      case 'peaks': {
        c.fillStyle = '#0e1526'
        c.fillRect(x, y, w, h)
        const cols = ['#1d2a44', '#28395c', '#354a76']
        for (let L = 0; L < 3; L++) {
          c.fillStyle = cols[L] ?? '#28395c'
          c.beginPath()
          c.moveTo(x, y + h)
          for (let i = 0; i <= 48; i++) {
            const px = x + (w / 48) * i
            const py = y + h - (14 + L * 14) - (1 - Math.abs(Math.sin(i * 0.32 + L * 2.3))) * (16 + L * 6)
            c.lineTo(px, py)
          }
          c.lineTo(x + w, y + h)
          c.fill()
        }
        const ph = (t % 1.6) / 1.6
        const jx = x + w * 0.3 + w * 0.34 * ph
        const jy = y + h - 44 - Math.sin(ph * Math.PI) * 20
        c.fillStyle = '#dce8ff'
        c.beginPath(); c.arc(jx, jy, 3, 0, 6.28); c.fill()
        c.fillStyle = '#8fa4c8'
        c.beginPath(); c.arc(x + w * 0.3, y + h - 40, 4, 0, 6.28); c.fill()
        c.beginPath(); c.arc(x + w * 0.64, y + h - 40, 4, 0, 6.28); c.fill()
        break
      }
      case 'isles': {
        c.fillStyle = '#0d2430'
        c.fillRect(x, y, w, h)
        c.fillStyle = '#f0c060'
        c.beginPath(); c.arc(x + w * 0.78, y + 18, 7, 0, 6.28); c.fill()
        c.fillStyle = '#caa96a'
        c.beginPath(); c.ellipse(x + w * 0.42, y + h * 0.62, 26, 10, 0, 0, 6.28); c.fill()
        c.fillStyle = '#4bbd82'
        c.beginPath(); c.ellipse(x + w * 0.42, y + h * 0.56, 16, 7, 0, 0, 6.28); c.fill()
        c.strokeStyle = 'rgba(140,220,230,0.5)'
        c.lineWidth = 1.4
        for (let L = 0; L < 3; L++) {
          c.beginPath()
          for (let i = 0; i <= 16; i++) {
            const px = x + (w / 16) * i
            const py = y + h * 0.74 + L * 8 + Math.sin(i * 0.8 + t * 2 + L) * 2
            if (i) c.lineTo(px, py); else c.moveTo(px, py)
          }
          c.stroke()
        }
        const bx = x + w * (0.15 + 0.1 * Math.sin(t * 0.4))
        c.fillStyle = '#e8e0d0'
        c.beginPath(); c.moveTo(bx, y + h * 0.7); c.lineTo(bx + 8, y + h * 0.7); c.lineTo(bx + 4, y + h * 0.55); c.fill()
        break
      }
      case 'drift': {
        c.fillStyle = '#0c2028'
        c.fillRect(x, y, w, h)
        c.fillStyle = 'rgba(220,235,240,0.5)'
        c.beginPath(); c.arc(x + w * 0.82, y + 14, 5, 0, 6.28); c.fill()
        c.strokeStyle = 'rgba(130,200,215,0.45)'
        c.lineWidth = 1.4
        for (let L = 0; L < 4; L++) {
          c.beginPath()
          for (let i = 0; i <= 16; i++) {
            const px = x + (w / 16) * i
            const py = y + h * 0.5 + L * 9 + Math.sin(i * 0.7 + t * 1.6 + L * 1.2) * 2.4
            if (i) c.lineTo(px, py); else c.moveTo(px, py)
          }
          c.stroke()
        }
        const bx = x + w * (0.5 + 0.16 * Math.sin(t * 0.5))
        const by = y + h * 0.48 + Math.sin(t * 1.6 + 1) * 3
        c.save()
        c.translate(bx, by)
        c.rotate(0.5 + Math.sin(t * 0.8) * 0.12)
        c.fillStyle = 'rgba(180,225,210,0.85)'
        rr(c, -4, -9, 8, 15, 3)
        c.fill()
        c.fillRect(-1.6, -13, 3.2, 5)
        c.fillStyle = '#8a6a3a'
        c.fillRect(-1.6, -14.5, 3.2, 2.4)
        c.fillStyle = 'rgba(240,220,170,0.9)'
        c.fillRect(-2.4, -4, 4.8, 6)
        c.restore()
        this.glow(this.glowTeal, bx, by, 14, 0.3)
        break
      }
      case 'abyss': {
        c.fillStyle = '#070812'
        c.fillRect(x, y, w, h)
        for (let i = 0; i < 10; i++) {
          const px = x + hash(i * 3) * w
          const py = y + ((hash(i * 7) * h + t * 6) % h)
          c.fillStyle = 'rgba(120,200,220,0.35)'
          c.fillRect(px, py, 1.4, 1.4)
        }
        const my = y + h * (0.3 + 0.25 * Math.sin(t * 0.7))
        const mx = x + w * (0.5 + 0.2 * Math.sin(t * 0.45))
        this.glow(this.glowTeal, mx, my, 22, 0.8)
        c.fillStyle = '#bff0f4'
        c.beginPath(); c.arc(mx, my, 3.4, 0, 6.28); c.fill()
        for (let k = 1; k < 5; k++) {
          c.fillStyle = 'rgba(150,220,230,' + (0.5 - k * 0.1) + ')'
          c.beginPath(); c.arc(mx - k * 6 * Math.sin(t * 0.45), my - k * 5, 2 - k * 0.3, 0, 6.28); c.fill()
        }
        break
      }
      case 'atlas': {
        c.fillStyle = '#0a0c1c'
        c.fillRect(x, y, w, h)
        for (let i = 0; i < 14; i++) {
          c.fillStyle = 'rgba(200,215,255,' + (0.3 + 0.4 * Math.abs(Math.sin(t + i * 2.1))) + ')'
          c.fillRect(x + hash(i * 11) * w, y + hash(i * 17) * h, 1.4, 1.4)
        }
        const px = x + w / 2
        const py = y + h / 2
        c.strokeStyle = 'rgba(160,175,240,0.25)'
        c.lineWidth = 1
        c.beginPath(); c.ellipse(px, py, 30, 11, -0.3, 0, 6.28); c.stroke()
        c.fillStyle = '#b98a5a'
        c.beginPath(); c.arc(px, py, 9, 0, 6.28); c.fill()
        c.fillStyle = 'rgba(255,235,200,0.25)'
        c.beginPath(); c.arc(px - 3, py - 3, 4, 0, 6.28); c.fill()
        for (let k = 0; k < 3; k++) {
          const a = t * 0.9 + k * 2.1
          const lx = px + Math.cos(a) * 30
          const ly = py + Math.sin(a) * 11 - Math.cos(a) * 3
          this.glow(this.glowWarm, lx, ly, 8, 0.6)
          c.fillStyle = '#ffd9a0'
          c.beginPath(); c.arc(lx, ly, 1.8, 0, 6.28); c.fill()
        }
        break
      }
      case 'predict': {
        c.fillStyle = '#174f2e'
        c.fillRect(x, y, w, h)
        c.strokeStyle = 'rgba(240,250,240,0.4)'
        c.lineWidth = 1.2
        c.strokeRect(x + 6, y + 6, w - 12, h - 12)
        c.beginPath(); c.moveTo(x + w / 2, y + 6); c.lineTo(x + w / 2, y + h - 6); c.stroke()
        c.beginPath(); c.arc(x + w / 2, y + h / 2, 10, 0, 6.28); c.stroke()
        c.strokeRect(x + 6, y + h / 2 - 14, 10, 28)
        c.strokeRect(x + w - 16, y + h / 2 - 14, 10, 28)
        const bx = x + w / 2 + Math.sin(t * 1.1) * (w * 0.32)
        const by = y + h / 2 + Math.sin(t * 2.3 + 1) * (h * 0.24)
        c.fillStyle = '#f5f5f0'
        c.beginPath(); c.arc(bx, by, 3, 0, 6.28); c.fill()
        this.glow(this.glowWarm, bx, by, 8, 0.3)
        break
      }
      case 'guest': {
        c.fillStyle = '#191207'
        c.fillRect(x, y, w, h)
        c.fillStyle = '#d8c9a4'
        c.beginPath()
        c.moveTo(x + w / 2, y + 12)
        c.quadraticCurveTo(x + 16, y + 8, x + 14, y + 16)
        c.lineTo(x + 14, y + h - 14)
        c.quadraticCurveTo(x + 16, y + h - 8, x + w / 2, y + h - 12)
        c.quadraticCurveTo(x + w - 16, y + h - 8, x + w - 14, y + h - 14)
        c.lineTo(x + w - 14, y + 16)
        c.quadraticCurveTo(x + w - 16, y + 8, x + w / 2, y + 12)
        c.fill()
        c.strokeStyle = 'rgba(60,44,20,0.5)'
        c.lineWidth = 1
        c.beginPath(); c.moveTo(x + w / 2, y + 12); c.lineTo(x + w / 2, y + h - 12); c.stroke()
        const maxw = w / 2 - 26
        for (let L = 0; L < 4; L++) {
          const lw = L < 3 ? maxw : maxw * (0.3 + 0.7 * Math.abs(Math.sin(t * 0.7)))
          c.beginPath()
          c.moveTo(x + 22, y + 26 + L * 11)
          c.lineTo(x + 22 + lw, y + 26 + L * 11)
          c.stroke()
          c.beginPath()
          c.moveTo(x + w / 2 + 8, y + 26 + L * 11)
          c.lineTo(x + w / 2 + 8 + maxw * (L === 1 ? 0.6 : 0.9), y + 26 + L * 11)
          c.stroke()
        }
        const qx = x + 22 + maxw * (0.3 + 0.7 * Math.abs(Math.sin(t * 0.7)))
        this.glow(this.glowWarm, qx, y + 59, 8, 0.5)
        c.fillStyle = '#3a2c14'
        c.beginPath()
        c.moveTo(qx, y + 59)
        c.lineTo(qx + 3, y + 50)
        c.lineTo(qx + 5.5, y + 51.5)
        c.closePath()
        c.fill()
        break
      }
      default: {
        c.fillStyle = '#0c0c18'
        c.fillRect(x, y, w, h)
        const p = t * 0.9
        const bx = x + 12 + Math.abs(((p * 60) % ((w - 24) * 2)) - (w - 24))
        const by = y + 10 + Math.abs(((p * 47) % ((h - 20) * 2)) - (h - 20))
        this.glow(this.glowWarm, bx, by, 14, 0.7)
        c.fillStyle = col
        c.beginPath(); c.arc(bx, by, 4, 0, 6.28); c.fill()
        c.strokeStyle = 'rgba(255,255,255,0.25)'
        c.strokeRect(x + 6, y + 6, w - 12, h - 12)
      }
    }
  }

  /* ────────────────────────── dressing ────────────────────────── */

  private drawStrings(t: number, wind: number): void {
    const c = this.cx
    c.strokeStyle = 'rgba(70,52,30,0.7)'
    c.lineWidth = 1.2
    for (let i = 0; i < this.plots.length - 1; i++) {
      const a = this.plots[i]
      const b = this.plots[i + 1]
      if (!a || !b) continue
      const x1 = a.x + PLOT_W - 17
      const x2 = b.x + 17
      const mid = (x1 + x2) / 2
      c.beginPath()
      c.moveTo(x1, 402)
      c.quadraticCurveTo(mid, 428, x2, 402)
      c.stroke()
      if (i % 3 === 1) {
        const cols = ['#8a3f4a', '#3f6a5a', '#8a6a3a', '#4a5a8a']
        for (let k = 1; k <= 5; k++) {
          const tt = k / 6
          const fx = lerp(x1, x2, tt)
          const fy = 402 + 2 * tt * (1 - tt) * 26
          const fl = Math.sin(t * 2 + i + k * 1.3) * 1.6 + wind * 1.2
          c.fillStyle = cols[k % 4] ?? '#8a3f4a'
          c.beginPath()
          c.moveTo(fx - 5, fy)
          c.lineTo(fx + 5, fy)
          c.lineTo(fx + fl, fy + 11)
          c.closePath()
          c.fill()
        }
      } else {
        for (let k = 1; k < 3; k++) {
          const tt = k / 3
          const lx = lerp(x1, x2, tt)
          const ly = 402 + 2 * tt * (1 - tt) * 26
          const warm = (i + k) % 3 === 0
          this.drawLantern(lx, ly - 2, 10, 13, warm ? '#d8903c' : '#c8433a', Math.sin(t * 1.4 + i * 2 + k) * 0.1 + wind * 0.08, warm ? this.glowWarm : this.glowRed, 0.42)
        }
      }
    }
  }

  private drawCat(t: number): void {
    const c = this.cx
    const anchor = this.plots[1]
    if (!anchor) return
    const x = anchor.x + PLOT_W + 52
    const y = 575
    c.fillStyle = '#201812'
    c.fillRect(x - 15, y - 20, 30, 20)
    c.strokeStyle = 'rgba(120,90,50,0.4)'
    c.strokeRect(x - 15, y - 20, 30, 20)
    c.fillStyle = '#0e0b14'
    c.beginPath(); c.ellipse(x, y - 27, 10, 7, 0, 0, 6.28); c.fill()
    c.beginPath(); c.arc(x + 9, y - 33, 5.5, 0, 6.28); c.fill()
    c.beginPath(); c.moveTo(x + 5.5, y - 37); c.lineTo(x + 7, y - 42); c.lineTo(x + 9.5, y - 37.5); c.fill()
    c.beginPath(); c.moveTo(x + 9.5, y - 37.5); c.lineTo(x + 12, y - 42); c.lineTo(x + 13, y - 36.5); c.fill()
    c.strokeStyle = '#0e0b14'
    c.lineWidth = 2.6
    c.lineCap = 'round'
    c.beginPath()
    c.moveTo(x - 9, y - 25)
    c.quadraticCurveTo(x - 18, y - 24, x - 17, y - 34 + Math.sin(t * 1.8) * 3)
    c.stroke()
    if (Math.sin(t * 0.31) > -0.92) {
      c.fillStyle = '#e8a44a'
      c.fillRect(x + 7, y - 34, 1.6, 1.6)
      c.fillRect(x + 11, y - 34, 1.6, 1.6)
    }
  }

  private drawFlies(t: number): void {
    const c = this.cx
    for (const f of this.flies) {
      const fx = f[0] + Math.sin(t * f[3] + f[2]) * 26
      const fy = f[1] + Math.sin(t * f[3] * 1.4 + f[2] * 2) * 16
      const a = 0.3 + 0.35 * Math.abs(Math.sin(t * 1.2 + f[2]))
      this.glow(this.glowWarm, fx, fy, 7, a)
      c.fillStyle = 'rgba(255,220,150,' + a + ')'
      c.fillRect(fx - 1, fy - 1, 2, 2)
    }
  }

  private drawFigure(f: Figure): void {
    const c = this.cx
    const y = 592 + f.lane * 30
    const sc = (0.78 + f.lane * 0.38) * (f.kid ? 0.68 : 1)
    const walk = f.state === 'walk'
    const bob = walk ? Math.abs(Math.sin(f.phase)) * 2.2 * sc : Math.sin(f.phase) * 0.6 * sc
    const hx = f.x
    const hy = y - 26 * sc - bob
    c.fillStyle = f.tint
    c.strokeStyle = f.tint
    c.lineWidth = 2.6 * sc
    c.lineCap = 'round'
    if (walk) {
      const lg = Math.sin(f.phase) * 5 * sc
      c.beginPath(); c.moveTo(hx, y - 12 * sc - bob); c.lineTo(hx + lg, y); c.stroke()
      c.beginPath(); c.moveTo(hx, y - 12 * sc - bob); c.lineTo(hx - lg, y); c.stroke()
    } else {
      c.beginPath(); c.moveTo(hx - 2 * sc, y - 12 * sc); c.lineTo(hx - 2 * sc, y); c.stroke()
      c.beginPath(); c.moveTo(hx + 2 * sc, y - 12 * sc); c.lineTo(hx + 2 * sc, y); c.stroke()
    }
    rr(c, hx - 4.6 * sc, hy + 6 * sc, 9.2 * sc, 16 * sc, 4 * sc)
    c.fill()
    c.beginPath(); c.arc(hx, hy + 2.4 * sc, 3.6 * sc, 0, 6.28); c.fill()
    if (f.lantern) {
      const dir = walk ? (f.tx > f.x ? 1 : -1) : 1
      const lx = hx + 8 * sc * dir
      const ly = hy + 15 * sc + Math.sin(f.phase * 0.7) * 1.5
      c.strokeStyle = 'rgba(120,90,50,0.8)'
      c.lineWidth = 1
      c.beginPath(); c.moveTo(hx + 4 * sc * dir, hy + 10 * sc); c.lineTo(lx, ly); c.stroke()
      this.glow(this.glowWarm, lx, ly, 14 * sc, 0.55)
      c.fillStyle = '#ffca7a'
      c.beginPath(); c.arc(lx, ly, 2.6 * sc, 0, 6.28); c.fill()
    }
    if (f.balloon) {
      const bsway = Math.sin(f.phase * 0.5) * 2.5
      const bx = hx + 6 * sc + bsway
      const by = hy - 22 * sc
      c.strokeStyle = 'rgba(200,190,210,0.4)'
      c.lineWidth = 0.8
      c.beginPath(); c.moveTo(hx + 4 * sc, hy + 8 * sc); c.quadraticCurveTo(hx + 7 * sc, hy - 8 * sc, bx, by); c.stroke()
      c.fillStyle = f.balloon
      c.beginPath(); c.ellipse(bx, by, 4.6 * sc, 5.6 * sc, 0, 0, 6.28); c.fill()
      c.fillStyle = 'rgba(255,255,255,0.35)'
      c.beginPath(); c.arc(bx - 1.5 * sc, by - 2 * sc, 1.3 * sc, 0, 6.28); c.fill()
    }
  }

  private drawVignette(): void {
    const c = this.cx
    this.screenSpace()
    const g = c.createRadialGradient(this.vw / 2, this.vh * 0.44, this.vh * 0.36, this.vw / 2, this.vh * 0.5, this.vh * 0.95)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(1, 'rgba(0,0,0,0.5)')
    c.fillStyle = g
    c.fillRect(0, 0, this.vw, this.vh)
  }
}

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}

function makeGlow(rgb: string): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  if (g) {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64)
    gr.addColorStop(0, 'rgba(' + rgb + ',0.85)')
    gr.addColorStop(0.3, 'rgba(' + rgb + ',0.28)')
    gr.addColorStop(1, 'rgba(' + rgb + ',0)')
    g.fillStyle = gr
    g.fillRect(0, 0, 128, 128)
  }
  return c
}
