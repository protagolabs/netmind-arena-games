/**
 * Atmosphere. The water column is painted in four registers: a depth-graded
 * background, parallax life behind the play plane, the additive light pass
 * (creatures, motes, medusae), and a darkness layer with light punched out of
 * it — in the midnight band your own glow is literally your lamp.
 */

import { drawGlow, glowSprite, headRadius, mulberry32, type SpinePoint } from './genome.js'
import { WORLD_W, WORLD_H, GARDEN_TOP, type Sim, Dweller } from './sim.js'

interface Snow {
  x: number
  y: number
  r: number
  speed: number
  drift: number
}

interface Frond {
  x: number
  h: number
  lean: number
  hue: number
  phase: number
  branches: number
}

const DEPTH_STOPS: Array<[number, [number, number, number]]> = [
  [0, [10, 66, 84]],
  [0.16, [6, 44, 64]],
  [0.34, [4, 27, 48]],
  [0.5, [3, 16, 32]],
  [0.68, [2, 9, 20]],
  [0.82, [1, 5, 13]],
  [1, [2, 3, 10]],
]

const depthColor = (k: number): [number, number, number] => {
  const kk = Math.max(0, Math.min(1, k))
  for (let i = 1; i < DEPTH_STOPS.length; i++) {
    if (kk <= DEPTH_STOPS[i][0]) {
      const [k0, c0] = DEPTH_STOPS[i - 1]
      const [k1, c1] = DEPTH_STOPS[i]
      const t = (kk - k0) / (k1 - k0)
      return [c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t]
    }
  }
  return DEPTH_STOPS[DEPTH_STOPS.length - 1][1]
}

/** How much of the water swallows light at this depth (0 none, ~.62 midnight). */
const darknessAt = (k: number): number => {
  if (k < 0.2) return 0
  if (k < 0.46) return ((k - 0.2) / 0.26) * 0.34
  if (k < 0.82) return 0.34 + ((k - 0.46) / 0.36) * 0.3
  return 0.4 // the garden keeps a faint ambient shimmer of its own
}

export interface Scene {
  time: number
  camX: number
  camY: number
  sim: Sim
  dwellers: Dweller[]
  playerVisible: boolean
  /** id of a dweller being inspected — gets a soft focus ring */
  focusId: string | null
}

export class Renderer {
  canvas: HTMLCanvasElement
  private g: CanvasRenderingContext2D
  private dark: HTMLCanvasElement
  private dg: CanvasRenderingContext2D
  private hole: HTMLCanvasElement
  w = 1
  h = 1
  private dpr = 1
  private snow: Snow[] = []
  private fronds: Frond[] = []
  private whalePhase = Math.random() * 1000

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.g = canvas.getContext('2d')!
    this.dark = document.createElement('canvas')
    this.dg = this.dark.getContext('2d')!

    // the punch-out sprite: a radial hole for the darkness layer
    this.hole = document.createElement('canvas')
    this.hole.width = 128
    this.hole.height = 128
    const hg = this.hole.getContext('2d')!
    const grad = hg.createRadialGradient(64, 64, 0, 64, 64, 64)
    grad.addColorStop(0, 'rgba(255,255,255,0.92)')
    grad.addColorStop(0.45, 'rgba(255,255,255,0.5)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    hg.fillStyle = grad
    hg.fillRect(0, 0, 128, 128)

    const rand = mulberry32(20260810)
    for (let i = 0; i < 150; i++) {
      this.snow.push({
        x: rand() * 4000,
        y: rand() * WORLD_H,
        r: 0.6 + rand() * 1.7,
        speed: 5 + rand() * 12,
        drift: rand() * Math.PI * 2,
      })
    }
    for (let x = 30; x < WORLD_W - 30; x += 36 + rand() * 60) {
      this.fronds.push({
        x,
        h: 60 + rand() * 190,
        lean: (rand() - 0.5) * 0.5,
        hue: rand() < 0.55 ? 175 + rand() * 40 : 265 + rand() * 55,
        phase: rand() * Math.PI * 2,
        branches: 3 + Math.floor(rand() * 4),
      })
    }
  }

  resize(w: number, h: number, dpr: number) {
    this.w = w
    this.h = h
    this.dpr = Math.min(2, dpr)
    this.canvas.width = Math.round(w * this.dpr)
    this.canvas.height = Math.round(h * this.dpr)
    // the attribute size is physical pixels; without an explicit CSS size the
    // canvas would display at dpr× scale and only its top-left quadrant shows
    this.canvas.style.width = `${w}px`
    this.canvas.style.height = `${h}px`
    this.dark.width = this.canvas.width
    this.dark.height = this.canvas.height
  }

  frame(scene: Scene, drawLightPass: (g: CanvasRenderingContext2D) => void) {
    const { g } = this
    const { camX, camY, time } = scene
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)

    const kTop = camY / WORLD_H
    const kBot = (camY + this.h) / WORLD_H

    /* 1 — water */
    const cTop = depthColor(kTop)
    const cBot = depthColor(kBot)
    const bg = g.createLinearGradient(0, 0, 0, this.h)
    bg.addColorStop(0, `rgb(${cTop[0] | 0},${cTop[1] | 0},${cTop[2] | 0})`)
    bg.addColorStop(1, `rgb(${cBot[0] | 0},${cBot[1] | 0},${cBot[2] | 0})`)
    g.fillStyle = bg
    g.fillRect(0, 0, this.w, this.h)

    /* 2 — god rays, only where the sun still reaches */
    const sun = Math.max(0, 1 - kTop / 0.22)
    if (sun > 0.02) {
      g.save()
      g.globalCompositeOperation = 'lighter'
      for (let i = 0; i < 5; i++) {
        const cx = ((i * 397 + time * 6) % (this.w + 600)) - 300
        const sway = Math.sin(time * 0.1 + i * 1.7) * 120
        const wTop = 40 + i * 14
        const grad = g.createLinearGradient(0, -50, 0, this.h * 0.9)
        grad.addColorStop(0, `rgba(150,220,230,${0.05 * sun})`)
        grad.addColorStop(1, 'rgba(150,220,230,0)')
        g.fillStyle = grad
        g.beginPath()
        g.moveTo(cx - wTop, -60)
        g.lineTo(cx + wTop, -60)
        g.lineTo(cx + sway + wTop * 3.2, this.h)
        g.lineTo(cx + sway - wTop * 3.2, this.h)
        g.closePath()
        g.fill()
      }
      g.restore()
    }

    /* 3 — a whale passing far behind the twilight (parallax .35) */
    const midK = (kTop + kBot) / 2
    if (midK > 0.14 && midK < 0.5) {
      const cycle = 90
      const tt = ((time + this.whalePhase) % cycle) / cycle
      if (tt < 0.55) {
        const wx = -500 + tt * (this.w + 1000) * 1.8 - camX * 0.35 + 400
        const wy = WORLD_H * 0.3 - camY * 0.35 + Math.sin(time * 0.24) * 30 - 100
        if (wx > -600 && wx < this.w + 600) {
          g.save()
          g.globalAlpha = 0.16
          g.fillStyle = 'rgb(1,10,20)'
          g.beginPath()
          g.ellipse(wx, wy, 300, 74, Math.sin(time * 0.2) * 0.04, 0, Math.PI * 2)
          g.fill()
          g.beginPath()
          const tailSw = Math.sin(time * 0.9) * 26
          g.moveTo(wx - 280, wy)
          g.quadraticCurveTo(wx - 400, wy - 60 + tailSw, wx - 452, wy - 84 + tailSw)
          g.quadraticCurveTo(wx - 396, wy - 8 + tailSw * 0.4, wx - 452, wy + 62 + tailSw)
          g.quadraticCurveTo(wx - 400, wy + 40 + tailSw, wx - 280, wy + 8)
          g.fill()
          g.restore()
        }
      }
    }

    /* 4 — marine snow (parallax .68), the sense that the water is a place */
    g.save()
    g.fillStyle = 'rgba(190,220,235,0.5)'
    const snowVis = midK < 0.14 ? 0.35 : midK > 0.8 ? 0.5 : 1
    for (const s of this.snow) {
      const sy = (((s.y + time * s.speed) % WORLD_H) - camY * 0.68 + WORLD_H) % WORLD_H
      if (sy < -10 || sy > this.h + 10) continue
      const sx = (((s.x + Math.sin(time * 0.14 + s.drift) * 40 - camX * 0.68) % (this.w + 80)) + this.w + 80) % (this.w + 80) - 40
      g.globalAlpha = (0.1 + s.r * 0.12) * snowVis
      g.beginPath()
      g.arc(sx, sy, s.r, 0, Math.PI * 2)
      g.fill()
    }
    g.restore()

    /* 5 — world space: garden flora behind creatures, then the light pass */
    g.save()
    g.translate(-camX, -camY)

    const floorY = WORLD_H - 130
    if (camY + this.h > GARDEN_TOP - 300) {
      // ground fog — tall and eased so its onset never reads as a seam
      const fog = g.createLinearGradient(0, floorY - 900, 0, floorY + 80)
      fog.addColorStop(0, 'rgba(8,26,40,0)')
      fog.addColorStop(0.55, 'rgba(9,30,46,0.16)')
      fog.addColorStop(1, 'rgba(10,34,52,0.5)')
      g.fillStyle = fog
      g.fillRect(camX - 20, floorY - 900, this.w + 40, 1000)
      g.fillStyle = 'rgb(3,8,16)'
      g.fillRect(camX - 20, floorY, this.w + 40, this.h)

      g.save()
      g.globalCompositeOperation = 'lighter'
      for (const f of this.fronds) {
        if (f.x < camX - 80 || f.x > camX + this.w + 80) continue
        const sway = Math.sin(time * 0.5 + f.phase) * 0.12 + f.lean
        for (let b = 0; b < f.branches; b++) {
          const bh = f.h * (1 - b * 0.16)
          const ang = sway + (b - (f.branches - 1) / 2) * 0.16 + Math.sin(time * 0.7 + f.phase + b) * 0.05
          const tipX = f.x + Math.sin(ang) * bh
          const tipY = floorY - Math.cos(ang) * bh
          g.beginPath()
          g.moveTo(f.x, floorY + 6)
          g.quadraticCurveTo(f.x + Math.sin(ang) * bh * 0.3, floorY - bh * 0.55, tipX, tipY)
          g.strokeStyle = `hsla(${f.hue},70%,55%,0.2)`
          g.lineWidth = 2.2
          g.stroke()
          const pulse = 0.5 + 0.5 * Math.sin(time * 1.1 + f.phase * 3 + b * 1.4)
          drawGlow(g, tipX, tipY, 7 + pulse * 6, f.hue, 0.5 + pulse * 0.3)
        }
      }
      g.restore()
    }

    g.save()
    g.globalCompositeOperation = 'lighter'
    drawLightPass(g)
    g.restore()
    g.restore()

    /* 6 — darkness with lamps punched out */
    const darkness = darknessAt(midK)
    if (darkness > 0.01) {
      const dg = this.dg
      dg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
      dg.globalCompositeOperation = 'source-over'
      dg.fillStyle = `rgba(1,4,11,${darkness})`
      dg.clearRect(0, 0, this.w, this.h)
      dg.fillRect(0, 0, this.w, this.h)
      dg.globalCompositeOperation = 'destination-out'
      const punch = (wx: number, wy: number, r: number, a = 1) => {
        const sx = wx - camX
        const sy = wy - camY
        if (sx < -r || sy < -r || sx > this.w + r || sy > this.h + r) return
        dg.globalAlpha = a
        dg.drawImage(this.hole, sx - r, sy - r, r * 2, r * 2)
      }
      const sim = scene.sim
      if (scene.playerVisible) {
        const p = sim.player
        const lamp = 170 + Math.sqrt(p.genome.motes + 1) * 34 + (p.genome.traits.includes('lanterns') ? 120 : 0)
        punch(p.head.x, p.head.y, lamp)
        punch(p.head.x, p.head.y, lamp * 2.2, 0.55)
      }
      for (const m of sim.motes) punch(m.x, m.y, 34, 0.75)
      for (const md of sim.medusae) punch(md.x, md.y, md.r * 2.4, 0.6)
      for (const d of scene.dwellers) {
        const r = headRadius(d.genome)
        punch(d.spine[0].x, d.spine[0].y, 120 + r * 9, 0.9)
      }
      dg.globalAlpha = 1
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.drawImage(this.dark, 0, 0)
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    }

    /* 7 — vignette so the frame always has a quiet edge */
    const vg = g.createRadialGradient(this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.42, this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.78)
    vg.addColorStop(0, 'rgba(0,0,0,0)')
    vg.addColorStop(1, 'rgba(0,2,8,0.42)')
    g.fillStyle = vg
    g.fillRect(0, 0, this.w, this.h)
  }

  /* ── pieces of the light pass, called from world.ts inside drawLightPass ── */

  drawMotes(g: CanvasRenderingContext2D, sim: Sim, time: number, camY: number) {
    for (const m of sim.motes) {
      if (m.y < camY - 60 || m.y > camY + this.h + 60) continue
      const tw = 0.6 + 0.4 * Math.sin(time * 2.1 + m.phase)
      const wob = Math.sin(time * 0.8 + m.phase) * 6
      drawGlow(g, m.x + wob, m.y, m.r * (4.4 + tw), m.hue, 0.5 + tw * 0.34)
      g.fillStyle = `hsla(${m.hue},80%,92%,${0.75 + tw * 0.25})`
      g.beginPath()
      g.arc(m.x + wob, m.y, m.r * 0.55, 0, Math.PI * 2)
      g.fill()
    }
  }

  drawMedusae(g: CanvasRenderingContext2D, sim: Sim, time: number, camY: number) {
    for (const md of sim.medusae) {
      if (md.y < camY - 160 || md.y > camY + this.h + 160) continue
      const pulse = Math.sin(time * 1.6 + md.phase)
      const hueM = 302 + ((md.phase * 43) % 26)
      const rx = md.r * (1 - pulse * 0.05)
      const ry = md.r * (0.78 + pulse * 0.09)
      const skirtY = md.y + ry * 0.34

      // bell: elliptical dome with a scalloped, breathing skirt
      g.beginPath()
      g.ellipse(md.x, md.y, rx, ry, 0, Math.PI, Math.PI * 2)
      const scallops = 4
      const step = (rx * 2) / scallops
      for (let s = 0; s < scallops; s++) {
        const fromX = md.x + rx - step * s
        const toX = fromX - step
        const lift = Math.sin(time * 2 + md.phase + s * 1.7) * ry * 0.08
        g.quadraticCurveTo((fromX + toX) / 2, skirtY + ry * 0.3 + lift, toX, skirtY - ry * 0.12)
      }
      g.closePath()
      g.fillStyle = `hsla(${hueM},70%,72%,0.11)`
      g.fill()
      g.strokeStyle = `hsla(${hueM},80%,80%,0.4)`
      g.lineWidth = 1.6
      g.stroke()

      // inner organs: a dim core and radial canals
      drawGlow(g, md.x, md.y - ry * 0.15, rx * 0.8, hueM, 0.3, 70)
      g.strokeStyle = `hsla(${hueM},70%,85%,0.18)`
      g.lineWidth = 1
      for (let c = -1; c <= 1; c++) {
        g.beginPath()
        g.moveTo(md.x, md.y - ry * 0.55)
        g.quadraticCurveTo(md.x + c * rx * 0.4, md.y - ry * 0.1, md.x + c * rx * 0.55, skirtY - ry * 0.15)
        g.stroke()
      }

      // trailing tentacles + two central oral arms
      for (let tnt = 0; tnt < 6; tnt++) {
        const tx = md.x + (tnt / 5 - 0.5) * rx * 1.5
        const sw = Math.sin(time * 1.3 + md.phase + tnt * 0.9) * rx * 0.34
        const len = md.r * (1.7 + (tnt % 3) * 0.3 + pulse * 0.1)
        g.beginPath()
        g.moveTo(tx, skirtY - ry * 0.1)
        g.bezierCurveTo(tx + sw * 0.4, skirtY + len * 0.35, tx + sw, skirtY + len * 0.7, tx + sw * 1.6, skirtY + len)
        g.strokeStyle = `hsla(${hueM},70%,78%,${0.2 - tnt * 0.018})`
        g.lineWidth = 1
        g.stroke()
      }
      for (const c of [-1, 1]) {
        const sw = Math.sin(time * 1.1 + md.phase + c) * rx * 0.25
        g.beginPath()
        g.moveTo(md.x + c * rx * 0.12, skirtY - ry * 0.1)
        g.bezierCurveTo(md.x + c * rx * 0.2 + sw * 0.5, skirtY + md.r * 0.8, md.x + sw, skirtY + md.r * 1.1, md.x + sw * 1.4, skirtY + md.r * 1.45)
        g.strokeStyle = `hsla(${hueM},60%,82%,0.26)`
        g.lineWidth = 2.4
        g.stroke()
      }
    }
  }

  drawRings(g: CanvasRenderingContext2D, sim: Sim) {
    for (const r of sim.rings) {
      const k = r.age / r.life
      const rr = r.r + (r.max - r.r) * (1 - Math.pow(1 - k, 2.4))
      g.strokeStyle = `hsla(${r.hue},85%,80%,${(1 - k) * 0.6})`
      g.lineWidth = 2 * (1 - k) + 0.4
      g.beginPath()
      g.arc(r.x, r.y, rr, 0, Math.PI * 2)
      g.stroke()
    }
  }

  drawFocusRing(g: CanvasRenderingContext2D, spine: SpinePoint[], r: number, time: number) {
    const p = spine[0]
    const rr = r * 3 + Math.sin(time * 2.4) * 3
    g.strokeStyle = 'rgba(240,250,255,0.6)'
    g.lineWidth = 1.4
    g.setLineDash([6, 7])
    g.lineDashOffset = -time * 24
    g.beginPath()
    g.arc(p.x, p.y, rr, 0, Math.PI * 2)
    g.stroke()
    g.setLineDash([])
  }

  /** cheap sparkle used by the release ceremony */
  drawSpark(g: CanvasRenderingContext2D, x: number, y: number, r: number, hue: number, a: number) {
    drawGlow(g, x, y, r, hue, a)
    g.globalAlpha = Math.min(1, a * 1.4)
    g.drawImage(glowSprite(hue, 40), x - r * 0.4, y - r * 0.4, r * 0.8, r * 0.8)
    g.globalAlpha = 1
  }
}
