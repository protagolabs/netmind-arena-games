/**
 * 山外山 · renderer. Five altitude bands (dawn gold → day → mist violet →
 * dusk → starry night) drive every palette; all silhouettes are flat shapes
 * under aerial perspective. Nothing here mutates the sim.
 *
 * Hard-won art rules baked in: the cloud sea is HORIZONTAL (camera-relative,
 * never tied to the walk line); snowlines blend into haze (pure white floats);
 * the moon halo is a radial gradient (a solid disc leaves a ring).
 */

import type { Sim, PNode } from './sim.js'
import { h1, G, VY0, VY_K, VX0, VX_K, EXTEND_MAX, EXTEND_MIN, RISE_UP, RISE_DOWN, APEX_PAD } from './sim.js'
import type { Strings } from './i18n.js'

type C3 = [number, number, number]
type Band = [number, C3][]

const SKY: Band = [
  [0, [253, 215, 152]], [430, [226, 229, 229]], [900, [162, 190, 215]],
  [1400, [172, 155, 199]], [1850, [216, 141, 117]], [2280, [80, 86, 138]],
  [2780, [26, 30, 62]], [3400, [12, 14, 34]],
]
const TER: Band = [
  [0, [60, 84, 72]], [700, [58, 68, 94]], [1400, [66, 64, 100]],
  [2100, [48, 50, 82]], [2700, [34, 36, 60]],
]
const TOP: Band = [
  [0, [184, 188, 160]], [800, [174, 182, 194]], [1600, [192, 198, 216]], [2300, [212, 220, 238]],
]
const PET: Band = [
  [0, [244, 186, 200]], [900, [255, 219, 142]], [1800, [208, 224, 255]],
]

function clamp(v: number, a: number, b: number): number {
  return v < a ? a : v > b ? b : v
}
function mix(a: C3, b: C3, u: number): C3 {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]
}
function rgb(c: C3): string {
  return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
}
function rgbA(c: C3, a: number): string {
  return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`
}
function band(bs: Band, y: number): C3 {
  if (y <= bs[0][0]) return bs[0][1]
  for (let i = 0; i < bs.length - 1; i++) {
    if (y < bs[i + 1][0]) {
      const u = (y - bs[i][0]) / (bs[i + 1][0] - bs[i][0])
      return mix(bs[i][1], bs[i + 1][1], u)
    }
  }
  return bs[bs.length - 1][1]
}

export class Renderer {
  private g: CanvasRenderingContext2D
  private W = 680
  private H = 480
  private dpr = 1
  private bu = 0
  private su = 0

  constructor(private cvs: HTMLCanvasElement) {
    const g = cvs.getContext('2d')
    if (!g) throw new Error('canvas 2d context unavailable')
    this.g = g
  }

  resize(w: number, h: number, dpr: number): void {
    this.W = Math.max(320, w)
    this.H = Math.max(240, h)
    this.dpr = Math.min(2, dpr)
    this.cvs.width = Math.round(this.W * this.dpr)
    this.cvs.height = Math.round(this.H * this.dpr)
    /* absolutely-positioned replaced elements ignore inset stretching: without
       an explicit CSS size a dpr>1 canvas displays at physical pixels and only
       its top-left quarter is visible */
    this.cvs.style.width = `${this.W}px`
    this.cvs.style.height = `${this.H}px`
    this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
  }

  private sx(s: Sim, x: number): number {
    return x - s.camX + this.W * 0.34
  }
  private sy(s: Sim, y: number): number {
    return this.H * 0.62 - (y - s.camY)
  }

  draw(s: Sim, T: Strings, arcOn: boolean): void {
    const { g, W, H } = this
    this.bu = clamp(s.camY / 2800, 0, 1)
    this.su = clamp(1 - s.camY / 1300, 0, 1)
    const bu = this.bu
    const su = this.su
    const top = band(SKY, s.camY + 600)

    const lg = g.createLinearGradient(0, 0, 0, H)
    lg.addColorStop(0, rgb(top))
    lg.addColorStop(1, rgb(band(SKY, s.camY - 500)))
    g.fillStyle = lg
    g.fillRect(0, 0, W, H)

    const st = clamp((s.camY - 1900) / 520, 0, 1)
    if (st > 0.01) {
      g.fillStyle = '#fff'
      for (let i = 0; i < 90; i++) {
        const px = (i * 137.5) % W
        const py = (i * 89.3) % (H * 0.72)
        g.globalAlpha = st * (0.22 + ((i * 7) % 10) / 16) * (0.65 + 0.35 * Math.sin(s.t * 1.7 + i))
        g.fillRect(px, py, i % 3 ? 1.3 : 2, i % 3 ? 1.3 : 2)
      }
      g.globalAlpha = 1
      if (st > 0.4) {
        g.save()
        g.translate(W * 0.6, H * 0.26)
        g.rotate(-0.45)
        g.scale(1, 0.3)
        const mw = g.createRadialGradient(0, 0, 10, 0, 0, 250)
        mw.addColorStop(0, `rgba(235,240,255,${(st * 0.1).toFixed(2)})`)
        mw.addColorStop(0.6, `rgba(200,212,255,${(st * 0.05).toFixed(2)})`)
        mw.addColorStop(1, 'rgba(200,212,255,0)')
        g.fillStyle = mw
        g.beginPath()
        g.arc(0, 0, 250, 0, 6.3)
        g.fill()
        g.restore()
      }
    }
    if (su > 0.01) {
      const sxp = W * 0.74
      const syp = H * 0.32 + s.camY * 0.05
      g.globalAlpha = su * 0.1
      g.fillStyle = '#ffd9a0'
      g.beginPath()
      g.arc(sxp, syp, 185, 0, 6.3)
      g.fill()
      g.globalAlpha = su * 0.26
      g.beginPath()
      g.arc(sxp, syp, 102, 0, 6.3)
      g.fill()
      g.globalAlpha = su * 0.95
      g.fillStyle = '#ffe2b0'
      g.beginPath()
      g.arc(sxp, syp, 46, 0, 6.3)
      g.fill()
      g.globalAlpha = 1
    }
    const mo = clamp((s.camY - 1650) / 650, 0, 1)
    if (mo > 0.01) {
      const mh = g.createRadialGradient(W * 0.28, H * 0.17, 20, W * 0.28, H * 0.17, 80)
      mh.addColorStop(0, `rgba(223,231,250,${(mo * 0.2).toFixed(2)})`)
      mh.addColorStop(1, 'rgba(223,231,250,0)')
      g.fillStyle = mh
      g.beginPath()
      g.arc(W * 0.28, H * 0.17, 80, 0, 6.3)
      g.fill()
      g.globalAlpha = mo
      g.fillStyle = '#eef2fa'
      g.beginPath()
      g.arc(W * 0.28, H * 0.17, 24, 0, 6.3)
      g.fill()
      g.fillStyle = rgb(top)
      g.beginPath()
      g.arc(W * 0.28 + 9, H * 0.17 - 4, 21, 0, 6.3)
      g.fill()
      g.globalAlpha = 1
    }
    g.globalAlpha = 0.05
    g.strokeStyle = '#fff'
    g.lineWidth = 1.5
    for (let w2 = 0; w2 < 8; w2++) {
      const wx2 = ((s.t * 150 + w2 * 97) % (W + 90)) - 45
      const wy2 = 40 + ((w2 * 67) % ((H * 0.5) | 0))
      g.beginPath()
      g.moveTo(wx2, wy2)
      g.lineTo(wx2 + 34, wy2 - 4)
      g.stroke()
    }
    g.globalAlpha = 1

    this.ridge(s, 0, 0.12, 62, 0.68, 0.3)
    this.lenses(s, 0.18, 0.1)
    this.ridge(s, 1, 0.24, 88, 0.48, 0.37)
    this.ridge(s, 2, 0.4, 112, 0.26, 0.45)
    this.lenses(s, 0.55, 0.13)

    const shY = s.shk > 0.3 ? (Math.random() * 2 - 1) * s.shk * 0.6 : 0
    g.save()
    g.translate(0, shY)

    g.fillStyle = rgb(mix(band(TER, s.camY), band(SKY, s.camY - 500), 0.42))
    g.beginPath()
    g.moveTo(this.sx(s, s.terr[0].x + 90), this.sy(s, s.terr[0].y - 30))
    for (let k = 1; k < s.terr.length; k++) g.lineTo(this.sx(s, s.terr[k].x + 90), this.sy(s, s.terr[k].y - 30))
    g.lineTo(this.sx(s, s.terr[s.terr.length - 1].x + 90), H + 40)
    g.lineTo(this.sx(s, s.terr[0].x + 90), H + 40)
    g.closePath()
    g.fill()

    g.fillStyle = rgb(mix([255, 255, 255], [150, 162, 200], bu))
    for (let mwx = Math.floor((s.camX - W) / 300) * 300; mwx < s.camX + W * 2; mwx += 300) {
      const hM = h1((mwx | 0) + 557)
      g.globalAlpha = 0.06 + hM * 0.05
      g.beginPath()
      g.ellipse(this.sx(s, mwx) + Math.sin(s.t * 0.15 + hM * 7) * 26, this.sy(s, s.camY - 14 - hM * 54), 190 + hM * 90, 12 + hM * 7, 0, 0, 6.3)
      g.fill()
    }
    g.globalAlpha = 1

    const tc = band(TER, s.camY)
    const tg = g.createLinearGradient(0, H * 0.22, 0, H)
    tg.addColorStop(0, rgb(mix(tc, [255, 255, 255], 0.1)))
    tg.addColorStop(1, rgb(mix(tc, [12, 14, 26], 0.5)))
    g.fillStyle = tg
    g.beginPath()
    g.moveTo(this.sx(s, s.terr[0].x), this.sy(s, s.terr[0].y))
    for (let k = 1; k < s.terr.length; k++) g.lineTo(this.sx(s, s.terr[k].x), this.sy(s, s.terr[k].y))
    g.lineTo(this.sx(s, s.terr[s.terr.length - 1].x), H + 40)
    g.lineTo(this.sx(s, s.terr[0].x), H + 40)
    g.closePath()
    g.fill()

    g.strokeStyle = bu < 0.55 ? rgbA([255, 212, 150], 0.12 + su * 0.34) : rgbA([176, 196, 244], 0.24)
    g.lineWidth = 2
    g.beginPath()
    for (let k = 0; k < s.terr.length; k++) {
      const xx = this.sx(s, s.terr[k].x)
      if (xx < -40 || xx > W + 40) continue
      const yy = this.sy(s, s.terr[k].y)
      if (k === 0) g.moveTo(xx, yy)
      else g.lineTo(xx, yy)
    }
    g.stroke()

    g.strokeStyle = 'rgba(10,12,24,0.13)'
    g.lineWidth = 1.2
    for (let co = 0; co < 2; co++) {
      const off = co ? 58 : 26
      g.beginPath()
      let first = true
      for (let k = 0; k < s.terr.length; k++) {
        const xx = this.sx(s, s.terr[k].x)
        if (xx < -40 || xx > W + 40) continue
        const yy = this.sy(s, s.terr[k].y - off)
        if (first) {
          g.moveTo(xx, yy)
          first = false
        } else g.lineTo(xx, yy)
      }
      g.stroke()
    }
    if (s.camY > 1300) {
      g.strokeStyle = 'rgba(232,238,248,0.75)'
      g.lineWidth = 2.5
      g.beginPath()
      let pen = false
      for (let k = 0; k < s.terr.length; k++) {
        const tr = s.terr[k]
        if (tr.y > 1750) {
          const xx = this.sx(s, tr.x)
          const yy = this.sy(s, tr.y)
          if (!pen) {
            g.moveTo(xx, yy)
            pen = true
          } else g.lineTo(xx, yy)
        } else pen = false
      }
      g.stroke()
    }

    this.sea(s)

    for (let i = 0; i < s.nodes.length; i++) this.node(s, T, s.nodes[i], i)

    const aB = clamp((s.camY - 380) / 220, 0, 1) * clamp((1560 - s.camY) / 220, 0, 1) * 0.55
    if (aB > 0.02) {
      g.strokeStyle = `rgba(30,36,54,${aB.toFixed(2)})`
      g.lineWidth = 1.6
      for (let b = 0; b < 3; b++) {
        const bpx = W + 260 - ((s.t * 40 + b * 280) % (W + 260)) - 130
        const bpy = H * (0.2 + b * 0.09) + Math.sin(s.t * 1.2 + b * 2) * 10
        const wg = Math.sin(s.t * 9 + b * 2.1) * 4
        g.beginPath()
        g.moveTo(bpx - 7, bpy)
        g.quadraticCurveTo(bpx - 3, bpy - 5 - wg, bpx, bpy)
        g.quadraticCurveTo(bpx + 3, bpy - 5 - wg, bpx + 7, bpy)
        g.stroke()
      }
    }

    for (const p of s.pts) {
      const l = clamp(p.l, 0, 1)
      if (p.kind === 'mist') {
        g.globalAlpha = l * 0.2
        g.fillStyle = '#eef2f8'
        g.beginPath()
        g.arc(this.sx(s, p.x), this.sy(s, p.y), 3 + (1 - l) * 10, 0, 6.3)
        g.fill()
      } else if (p.kind === 'petal' || p.kind === 'leaf') {
        g.globalAlpha = l * (p.kind === 'leaf' ? 0.55 : 1)
        g.fillStyle = rgb(band(PET, p.y0))
        g.save()
        g.translate(this.sx(s, p.x), this.sy(s, p.y))
        g.rotate(p.r + s.t * 2)
        g.beginPath()
        g.ellipse(0, 0, 3.2, 2, 0, 0, 6.3)
        g.fill()
        g.restore()
      } else if (p.kind === 'snow') {
        g.globalAlpha = l * 0.55
        g.fillStyle = '#eef2fa'
        g.beginPath()
        g.arc(this.sx(s, p.x), this.sy(s, p.y), 1.6, 0, 6.3)
        g.fill()
      } else {
        g.globalAlpha = l
        g.fillStyle = p.kind === 'gold' ? '#ffe2b0' : '#cfd3da'
        g.fillRect(this.sx(s, p.x), this.sy(s, p.y), 2, 2)
      }
    }
    g.globalAlpha = 1
    for (const f of s.rings) {
      g.globalAlpha = f.a * 0.75
      g.strokeStyle = '#ffe6a8'
      g.lineWidth = 2
      g.beginPath()
      g.arc(this.sx(s, f.x), this.sy(s, f.y) + 6, 10 + (1 - f.a) * 30, 0, 6.3)
      g.stroke()
    }
    g.globalAlpha = 1

    if (arcOn && s.chg > 0 && !s.air && s.fade <= 0) this.aim(s)
    this.player(s)
    g.restore()

    this.lenses(s, 1.15, 0.07)
    this.mistWall(s)

    if (!s.air && s.idx === s.nodes.length - 1 && s.fade <= 0) {
      g.globalAlpha = 0.5 + 0.4 * Math.sin(s.t * 3)
      g.font = '12px system-ui,sans-serif'
      g.textAlign = 'center'
      g.fillStyle = s.camY > 1000 ? 'rgba(246,248,252,0.95)' : '#2b3242'
      const hint = s.canPlace ? T.frontierHint : s.anonNote ? T.signInToPlace : T.todayDone
      g.fillText(hint, this.sx(s, s.px), this.sy(s, s.py) - 58)
      g.globalAlpha = 1
    }
    if (s.fade > 0) {
      const fa = Math.sin(clamp(s.fade, 0, 1) * 3.14)
      g.globalAlpha = Math.min(1, fa * 1.3)
      g.fillStyle = rgb(mix([255, 255, 255], [70, 82, 120], bu * 0.5))
      g.fillRect(0, 0, W, H)
      g.globalAlpha = 1
    }
    const gr = g.createLinearGradient(0, 0, 0, H)
    gr.addColorStop(0, `rgba(255,190,130,${(0.055 * (1 - bu)).toFixed(3)})`)
    gr.addColorStop(1, 'rgba(40,60,120,0.05)')
    g.fillStyle = gr
    g.fillRect(0, 0, W, H)
    const vg = g.createRadialGradient(W / 2, H * 0.5, H * 0.45, W / 2, H * 0.5, H * 0.88)
    vg.addColorStop(0, 'rgba(8,10,22,0)')
    vg.addColorStop(1, 'rgba(8,10,22,0.17)')
    g.fillStyle = vg
    g.fillRect(0, 0, W, H)

    this.hud(s, T)
  }

  private ridge(s: Sim, li: number, f: number, amp: number, haze: number, baseF: number): void {
    const { g, W, H } = this
    const base = mix([60, 68, 96], [26, 30, 54], this.bu)
    const c = mix(base, band(SKY, s.camY - 500), haze)
    const xs: number[] = []
    const ys: number[] = []
    const rs: number[] = []
    for (let px = 0; px <= W; px += 12) {
      const wx = px + s.camX * f
      const r =
        (1 - Math.abs(Math.sin(wx * 0.0019 + li * 7))) * 0.6 +
        (1 - Math.abs(Math.sin(wx * 0.0043 + li * 2.3))) * 0.28 +
        (1 - Math.abs(Math.sin(wx * 0.0097 + li * 5.1))) * 0.12
      xs.push(px)
      ys.push(H * baseF - r * amp + s.camY * 0.03 * (0.5 + li * 0.35))
      rs.push(r)
    }
    g.fillStyle = rgb(c)
    g.beginPath()
    g.moveTo(0, H)
    for (let q = 0; q < xs.length; q++) g.lineTo(xs[q], ys[q])
    g.lineTo(W, H)
    g.closePath()
    g.fill()
    if (li > 0) {
      const th = 0.74 - 0.18 * this.bu
      const sc = mix([238, 244, 252], band(SKY, s.camY - 500), haze * 0.55)
      g.strokeStyle = rgbA(sc, 0.62 - haze * 0.25)
      g.lineWidth = li === 2 ? 3 : 2.2
      g.lineJoin = 'round'
      g.lineCap = 'round'
      g.beginPath()
      let pen = false
      for (let q = 0; q < xs.length; q++) {
        if (rs[q] > th) {
          if (!pen) {
            g.moveTo(xs[q], ys[q])
            pen = true
          } else g.lineTo(xs[q], ys[q])
        } else pen = false
      }
      g.stroke()
    }
  }

  private lenses(s: Sim, par: number, al: number): void {
    const { g, W, H } = this
    const stp = 650
    const xl = s.camX * par - W * 0.7
    const xr = s.camX * par + W * 1.7
    const lc = mix([255, 255, 255], [196, 206, 238], this.bu)
    for (let wx = Math.floor(xl / stp) * stp; wx < xr; wx += stp) {
      const h = h1((wx | 0) + 1731)
      if (h < 0.35) continue
      const px = wx - s.camX * par + W * 0.34 + Math.sin(s.t * 0.1 + h * 9) * 10
      const py = H * (0.14 + h * 0.4) + Math.sin(s.t * 0.23 + h * 7) * 4
      const rx = 80 + h * 95
      g.fillStyle = rgbA(lc, al * (0.5 + h * 0.5))
      g.beginPath()
      g.ellipse(px, py, rx, 11 + h * 6, 0, 0, 6.3)
      g.fill()
      g.beginPath()
      g.ellipse(px - rx * 0.42, py + 7, rx * 0.55, 8, 0, 0, 6.3)
      g.fill()
      g.beginPath()
      g.ellipse(px + rx * 0.4, py + 6, rx * 0.5, 7, 0, 0, 6.3)
      g.fill()
    }
  }

  private sea(s: Sim): void {
    const { g, W, H } = this
    const bu = this.bu
    const seaC = mix([255, 255, 255], [142, 156, 200], bu)
    const camL = s.camX - W * 0.34 - 160
    const camR = camL + W + 320
    const seaY = s.camY - 168
    const pyc = this.sy(s, seaY)
    g.globalAlpha = 0.12
    g.fillStyle = '#fff'
    g.fillRect(0, pyc - 14, W, 18)
    g.globalAlpha = 1
    g.fillStyle = rgb(mix(seaC, [210, 218, 240], 0.3))
    for (let wx = Math.floor(camL / 74) * 74; wx < camR; wx += 74) {
      const h = h1((wx | 0) + 77)
      const py = this.sy(s, seaY + 22 + 8 * Math.sin(wx * 0.02 + s.t * 0.22 + h * 6))
      g.globalAlpha = 0.26
      g.beginPath()
      g.ellipse(this.sx(s, wx) + h * 20, py, 44 + h * 40, 7 + h * 5, 0, 0, 6.3)
      g.fill()
    }
    g.fillStyle = rgb(seaC)
    for (let wx = Math.floor(camL / 112) * 112; wx < camR; wx += 112) {
      const h = h1((wx | 0) + 911)
      const py = this.sy(s, seaY + 6 + 11 * Math.sin(wx * 0.012 + s.t * 0.32 + h * 6))
      g.globalAlpha = 0.5
      g.beginPath()
      g.ellipse(this.sx(s, wx) + Math.sin(s.t * 0.2 + h * 6) * 8, py, 78 + h * 66, 11 + h * 8, 0, 0, 6.3)
      g.fill()
    }
    for (let wx = Math.floor(camL / 180) * 180; wx < camR; wx += 180) {
      const h = h1((wx | 0) + 413)
      const py = this.sy(s, seaY - 12 + 9 * Math.sin(wx * 0.009 + s.t * 0.42 + h * 6))
      g.globalAlpha = 0.26
      g.beginPath()
      g.ellipse(this.sx(s, wx) + Math.sin(s.t * 0.3 + h * 7) * 14, py, 165, 17 + h * 7, 0, 0, 6.3)
      g.fill()
    }
    const sg = g.createLinearGradient(0, pyc + 8, 0, H)
    sg.addColorStop(0, rgbA(seaC, 0.62))
    sg.addColorStop(1, rgbA(mix(seaC, [54, 64, 104], 0.55), 0.9))
    g.globalAlpha = 1
    g.fillStyle = sg
    g.fillRect(0, pyc + 8, W, H)
    g.globalAlpha = 0.22 * (1 - bu) + 0.08
    g.fillStyle = '#fff'
    g.fillRect(0, pyc + 5, W, 1.5)
    g.globalAlpha = 1
  }

  private node(s: Sim, T: Strings, nd: PNode, i: number): void {
    const { g } = this
    const bu = this.bu
    const su = this.su
    const px = this.sx(s, nd.x)
    if (px < -170 || px > this.W + 170) return
    if (nd.fr && nd.fr > 0) nd.fr = Math.max(0, nd.fr - 0.016)
    const fr = nd.fr ?? 0
    const py = this.sy(s, nd.y) + fr * fr * 30
    const w = nd.w
    const j = nd.j
    let topc = band(TOP, nd.y)
    let side = mix(topc, [26, 30, 44], 0.64)
    if (nd.mine) {
      topc = mix(topc, [255, 206, 138], 0.42)
      side = mix(side, [118, 74, 42], 0.38)
    } else if (nd.agent) {
      topc = mix(topc, [150, 200, 226], 0.4)
      side = mix(side, [42, 74, 96], 0.4)
    }
    if (nd.k === 1) {
      topc = mix(topc, [96, 102, 98], 0.32)
      side = mix(side, [20, 24, 30], 0.18)
    }
    if (nd.ghost) g.globalAlpha = 0.55
    g.fillStyle = 'rgba(12,16,28,0.24)'
    g.beginPath()
    g.ellipse(px, py + 19, w * 0.52, 5, 0, 0, 6.3)
    g.fill()
    if (nd.k === 1) {
      g.fillStyle = rgb(mix(side, [0, 0, 0], 0.1))
      g.beginPath()
      g.moveTo(px - w * 0.3 + j[2] * 5, py + 13)
      g.lineTo(px + w * 0.28 + j[4] * 5, py + 13)
      g.lineTo(px + w * 0.16 + j[3] * 9, py + 34)
      g.lineTo(px + w * 0.24 - j[5] * 6, py + 58)
      g.lineTo(px - w * 0.2 - j[1] * 8, py + 56)
      g.lineTo(px - w * 0.12 - j[6] * 7, py + 32)
      g.closePath()
      g.fill()
      g.strokeStyle = 'rgba(8,10,20,0.2)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(px - w * 0.06, py + 18)
      g.lineTo(px - w * 0.1, py + 40)
      g.moveTo(px + w * 0.12, py + 20)
      g.lineTo(px + w * 0.16, py + 44)
      g.stroke()
    }
    g.fillStyle = rgb(side)
    g.beginPath()
    g.moveTo(px - w / 2 + j[0] * 3, py)
    g.lineTo(px - w / 2 - 2 - j[1] * 4, py + 6 + j[2] * 3)
    g.lineTo(px - w / 2 + 3, py + 16)
    g.lineTo(px + w / 2 - 3, py + 16)
    g.lineTo(px + w / 2 + 2 + j[3] * 4, py + 5 + j[4] * 3)
    g.lineTo(px + w / 2 - j[5] * 3, py)
    g.closePath()
    g.fill()
    g.fillStyle = 'rgba(6,8,16,0.25)'
    g.beginPath()
    g.moveTo(px - w / 2 + 3, py + 12)
    g.lineTo(px + w / 2 - 3, py + 12)
    g.lineTo(px + w / 2 - 3, py + 16)
    g.lineTo(px - w / 2 + 3, py + 16)
    g.closePath()
    g.fill()
    g.fillStyle = rgb(topc)
    g.beginPath()
    g.moveTo(px - w / 2 + j[0] * 3, py)
    g.lineTo(px - w / 2 + 6, py - 6 - j[6] * 2)
    g.lineTo(px + w / 2 + 6, py - 6 - j[7] * 2)
    g.lineTo(px + w / 2 - j[5] * 3, py)
    g.closePath()
    g.fill()
    g.strokeStyle = bu < 0.55 ? `rgba(255,236,190,${(0.18 + su * 0.25).toFixed(2)})` : 'rgba(190,206,248,0.3)'
    g.lineWidth = 1.4
    g.beginPath()
    g.moveTo(px + w / 2 + 6, py - 6 - j[7] * 2)
    g.lineTo(px + w / 2 - j[5] * 3, py)
    g.stroke()
    g.fillStyle = 'rgba(255,250,240,0.22)'
    g.fillRect(px - w / 2 + 6, py - 6, w * 0.9, 1.6)
    g.fillStyle = 'rgba(8,10,18,0.16)'
    g.beginPath()
    g.moveTo(px - w / 2 + j[0] * 3, py)
    g.lineTo(px - w / 2 - 2 - j[1] * 4, py + 6 + j[2] * 3)
    g.lineTo(px - w / 2 + 3, py + 16)
    g.lineTo(px - w * 0.14, py + 16)
    g.lineTo(px - w * 0.1, py)
    g.closePath()
    g.fill()
    g.fillStyle = bu < 0.55 ? 'rgba(255,222,170,0.1)' : 'rgba(170,190,240,0.08)'
    g.beginPath()
    g.moveTo(px + w / 2 - j[5] * 3, py)
    g.lineTo(px + w / 2 + 2 + j[3] * 4, py + 5 + j[4] * 3)
    g.lineTo(px + w / 2 - 3, py + 16)
    g.lineTo(px + w * 0.3, py + 16)
    g.lineTo(px + w * 0.34, py)
    g.closePath()
    g.fill()
    g.fillStyle = 'rgba(10,12,22,0.13)'
    g.beginPath()
    g.moveTo(px - w / 2 + 6, py - 6 - j[6] * 2)
    g.lineTo(px + w / 2 + 6, py - 6 - j[7] * 2)
    g.lineTo(px + w / 2 + 2, py - 3.5)
    g.lineTo(px - w / 2 + 8, py - 3.5)
    g.closePath()
    g.fill()
    g.strokeStyle = 'rgba(255,250,240,0.13)'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(px - w / 2 + j[0] * 3, py + 0.5)
    g.lineTo(px + w / 2 - j[5] * 3, py + 0.5)
    g.stroke()
    const c1 = h1(i * 37 + 5)
    const c2 = h1(i * 53 + 9)
    const c3 = h1(i * 71 + 3)
    g.strokeStyle = 'rgba(10,12,20,0.28)'
    g.lineWidth = 1
    if (w > 44) {
      const cx0 = px - w / 2 + 8 + c1 * (w - 16)
      g.beginPath()
      g.moveTo(cx0, py + 1)
      g.lineTo(cx0 - 2 + c2 * 4, py + 6)
      g.lineTo(cx0 - 3 + c3 * 6, py + 11)
      g.stroke()
      if (c2 > 0.55) {
        g.beginPath()
        g.moveTo(cx0 - 2 + c2 * 4, py + 6)
        g.lineTo(cx0 + 5, py + 9)
        g.stroke()
      }
    }
    if (c3 > 0.35) {
      g.strokeStyle = 'rgba(10,12,20,0.18)'
      g.beginPath()
      const tx0 = px - w * 0.25 + c1 * w * 0.5
      g.moveTo(tx0, py - 5)
      g.lineTo(tx0 + 6 - c2 * 12, py - 1.5)
      g.stroke()
    }
    g.fillStyle = 'rgba(10,12,20,0.15)'
    g.fillRect(px - w * 0.3 + c2 * w * 0.55, py - 4, 1.6, 1.2)
    g.fillRect(px - w * 0.3 + c3 * w * 0.5, py - 2.5, 1.3, 1.1)
    if (c1 > 0.6) {
      g.fillStyle = 'rgba(255,250,240,0.16)'
      const chx = px - w * 0.2 + c2 * w * 0.4
      g.beginPath()
      g.moveTo(chx, py)
      g.lineTo(chx + 3.5, py)
      g.lineTo(chx + 1.7, py + 2.4)
      g.closePath()
      g.fill()
    }
    if (nd.y > 1750) {
      g.fillStyle = 'rgba(240,246,254,0.9)'
      g.beginPath()
      g.moveTo(px - w / 2 + 6, py - 6 - j[6] * 2)
      g.lineTo(px + w / 2 + 6, py - 6 - j[7] * 2)
      g.lineTo(px + w / 2 + 1, py - 1)
      g.lineTo(px - w / 2 + 9, py - 1)
      g.closePath()
      g.fill()
      g.fillRect(px - w * 0.16, py + 1, 3, 5)
      g.fillRect(px + w * 0.2, py, 3, 4)
    }
    if (nd.y < 600) {
      g.fillStyle = '#7fae6a'
      g.fillRect(px - w * 0.2, py + 3, 3, 3)
      g.fillRect(px + w * 0.24, py + 7, 3, 3)
      g.fillRect(px + w * 0.05, py + 2, 2, 2)
      g.strokeStyle = '#7fae6a'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(px - w * 0.32, py)
      g.lineTo(px - w * 0.34, py - 4)
      g.moveTo(px - w * 0.28, py)
      g.lineTo(px - w * 0.27, py - 3)
      g.stroke()
    }
    if (nd.k === 0) {
      g.font = '9px system-ui,sans-serif'
      g.textAlign = 'center'
      g.fillStyle = nd.mine ? 'rgba(255,236,200,0.95)' : nd.agent ? 'rgba(190,226,244,0.9)' : 'rgba(236,240,248,0.8)'
      g.fillText(nd.mine ? T.you : (nd.nm ?? ''), px, py + 11)
      if (nd.mk) {
        g.font = '10px system-ui,sans-serif'
        g.textAlign = 'left'
        g.fillStyle = s.camY > 1000 ? 'rgba(255,255,255,0.42)' : 'rgba(43,50,66,0.48)'
        g.fillText(nd.mk, px + w / 2 + 10, py - 4)
      }
      if (nd.bells && nd.bells > 0) {
        const bx = px + w / 2 - 4
        const sw = Math.sin(s.t * 2.2 + i) * 4
        g.strokeStyle = nd.myBell ? 'rgba(255,214,110,0.95)' : 'rgba(226,140,96,0.85)'
        g.lineWidth = 1.6
        g.beginPath()
        g.moveTo(bx, py + 15)
        g.quadraticCurveTo(bx + sw * 0.5, py + 20, bx + sw, py + 26)
        g.stroke()
        g.fillStyle = '#f0c060'
        g.beginPath()
        g.moveTo(bx + sw - 3, py + 26)
        g.lineTo(bx + sw + 3, py + 26)
        g.lineTo(bx + sw + 2, py + 32)
        g.lineTo(bx + sw - 2, py + 32)
        g.closePath()
        g.fill()
        if (nd.bells > 1) {
          g.font = '8px system-ui,sans-serif'
          g.textAlign = 'left'
          g.fillStyle = 'rgba(240,192,96,0.9)'
          g.fillText(`×${nd.bells}`, bx + 6, py + 32)
        }
      }
    }
    g.globalAlpha = 1
    if (nd.k === 2) this.pavilion(s, T, nd, i, px, py)
  }

  private pavilion(s: Sim, T: Strings, nd: PNode, i: number, px: number, py: number): void {
    const { g } = this
    const bu = this.bu
    const fk = 0.85 + 0.15 * Math.sin(s.t * 7 + i)
    const pool = g.createRadialGradient(px, py - 4, 2, px, py - 4, 30)
    pool.addColorStop(0, `rgba(255,191,110,${((0.1 + 0.3 * bu) * fk).toFixed(2)})`)
    pool.addColorStop(1, 'rgba(255,191,110,0)')
    g.fillStyle = pool
    g.beginPath()
    g.ellipse(px, py - 3, 30, 9, 0, 0, 6.3)
    g.fill()
    const pvc = rgb(mix([64, 72, 96], [40, 46, 66], bu))
    const pvd = rgb(mix([46, 52, 72], [28, 32, 50], bu))
    const pvl = bu < 0.55 ? 'rgba(255,236,200,0.4)' : 'rgba(200,214,250,0.32)'
    g.fillStyle = pvc
    g.fillRect(px - 16, py - 27, 2.6, 27)
    g.fillRect(px + 13.4, py - 27, 2.6, 27)
    g.strokeStyle = pvc
    g.lineWidth = 1.4
    g.beginPath()
    g.moveTo(px - 15, py - 9)
    g.lineTo(px + 15, py - 9)
    g.stroke()
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(px - 8, py - 9)
    g.lineTo(px - 8, py - 2)
    g.moveTo(px, py - 9)
    g.lineTo(px, py - 2)
    g.moveTo(px + 8, py - 9)
    g.lineTo(px + 8, py - 2)
    g.stroke()
    const ug = g.createRadialGradient(px, py - 19, 2, px, py - 19, 17)
    ug.addColorStop(0, `rgba(255,196,120,${((0.24 + 0.24 * bu) * fk).toFixed(2)})`)
    ug.addColorStop(1, 'rgba(255,196,120,0)')
    g.fillStyle = ug
    g.beginPath()
    g.arc(px, py - 17, 17, 0, 6.3)
    g.fill()
    g.fillStyle = pvd
    g.beginPath()
    g.moveTo(px - 13, py - 33)
    g.quadraticCurveTo(px - 27, py - 27, px - 33, py - 23)
    g.quadraticCurveTo(px - 37.5, py - 20.5, px - 38, py - 23.5)
    g.quadraticCurveTo(px - 35, py - 19.8, px - 30, py - 20.8)
    g.quadraticCurveTo(px - 23, py - 22.5, px - 13, py - 29.5)
    g.lineTo(px + 13, py - 29.5)
    g.quadraticCurveTo(px + 23, py - 22.5, px + 30, py - 20.8)
    g.quadraticCurveTo(px + 35, py - 19.8, px + 38, py - 23.5)
    g.quadraticCurveTo(px + 37.5, py - 20.5, px + 33, py - 23)
    g.quadraticCurveTo(px + 27, py - 27, px + 13, py - 33)
    g.closePath()
    g.fill()
    g.strokeStyle = pvl
    g.lineWidth = 1.1
    g.beginPath()
    g.moveTo(px - 38, py - 23.5)
    g.quadraticCurveTo(px - 37.5, py - 20.5, px - 33, py - 23)
    g.quadraticCurveTo(px - 27, py - 27, px - 13, py - 33)
    g.lineTo(px + 13, py - 33)
    g.quadraticCurveTo(px + 27, py - 27, px + 33, py - 23)
    g.quadraticCurveTo(px + 37.5, py - 20.5, px + 38, py - 23.5)
    g.stroke()
    g.fillStyle = pvc
    g.beginPath()
    g.moveTo(px - 15, py - 32)
    g.quadraticCurveTo(px - 12, py - 39, px - 7, py - 41)
    g.lineTo(px + 7, py - 41)
    g.quadraticCurveTo(px + 12, py - 39, px + 15, py - 32)
    g.closePath()
    g.fill()
    g.strokeStyle = pvl
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(px - 8, py - 41)
    g.lineTo(px - 26, py - 25.5)
    g.moveTo(px + 8, py - 41)
    g.lineTo(px + 26, py - 25.5)
    g.stroke()
    g.strokeStyle = pvc
    g.lineWidth = 2.4
    g.beginPath()
    g.moveTo(px - 10, py - 42)
    g.lineTo(px + 10, py - 42)
    g.stroke()
    g.fillStyle = pvc
    g.fillRect(px - 12.4, py - 46.5, 2.6, 5)
    g.fillRect(px + 9.8, py - 46.5, 2.6, 5)
    g.globalAlpha = (0.3 + 0.4 * bu) * fk
    g.fillStyle = '#ffbf6e'
    g.beginPath()
    g.arc(px, py - 16, 6, 0, 6.3)
    g.fill()
    g.globalAlpha = 1
    g.fillStyle = '#ffbf6e'
    g.beginPath()
    g.arc(px, py - 16, 2.8, 0, 6.3)
    g.fill()
    g.strokeStyle = '#d96a4e'
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(px + 37, py - 24)
    for (let m = 1; m <= 4; m++) g.lineTo(px + 37 + m * 8, py - 24 + Math.sin(s.t * 6 + m) * 3 + m * 1.2)
    g.stroke()
    g.font = '10px system-ui,sans-serif'
    g.textAlign = 'center'
    g.fillStyle = s.camY > 1000 ? 'rgba(246,248,252,0.9)' : '#2b3242'
    g.fillText(T.pav[nd.pv ?? 0], px, py - 60)
  }

  private aim(s: Sim): void {
    const { g } = this
    const p = Math.min(1, s.chg)
    const vy0 = VY0 + VY_K * p
    const vx = (VX0 + VX_K * p) * (1 + s.wind * 0.5)
    let ax = s.px
    let ay = s.py
    let avy = vy0
    const arc: [number, number][] = [[ax, ay]]
    let hitI = -1
    let hitX = 0
    let ghost = false
    let gx = 0
    let gy = 0
    const la = s.nodes[s.nodes.length - 1]
    const onLast = s.idx === s.nodes.length - 1
    for (let k = 0; k < 80; k++) {
      const pay = ay
      avy -= G * 0.025
      ay += avy * 0.025
      ax += vx * 0.025
      arc.push([ax, ay])
      if (avy < 0) {
        let done = false
        for (let n = 0; n < s.nodes.length; n++) {
          const nd = s.nodes[n]
          if (pay >= nd.y && ay <= nd.y && Math.abs(ax - nd.x) < nd.w / 2 + 7) {
            hitI = n
            hitX = ax
            arc[arc.length - 1] = [ax, nd.y]
            done = true
            break
          }
        }
        if (done) break
        if (onLast && ax > la.x + 42) {
          if (!gy) gy = Math.min(la.y + RISE_UP, Math.max(la.y - RISE_DOWN, s.py + (vy0 * vy0) / (2 * G) - APEX_PAD))
          if (ay <= gy) {
            gx = Math.min(ax, la.x + EXTEND_MAX)
            if (gx - la.x >= EXTEND_MIN) {
              ghost = true
              arc[arc.length - 1] = [gx, gy]
            }
            break
          }
        }
        if (ay < s.py - 380) break
      }
    }
    g.strokeStyle = s.camY > 1000 ? 'rgba(255,255,255,0.55)' : 'rgba(43,50,66,0.5)'
    g.setLineDash([3, 5])
    g.lineWidth = 1.5
    g.beginPath()
    for (let k = 0; k < arc.length; k++) {
      if (k === 0) g.moveTo(this.sx(s, arc[k][0]), this.sy(s, arc[k][1]))
      else g.lineTo(this.sx(s, arc[k][0]), this.sy(s, arc[k][1]))
    }
    g.stroke()
    g.setLineDash([])
    if (hitI >= 0) {
      const nd = s.nodes[hitI]
      g.strokeStyle = 'rgba(255,236,180,0.85)'
      g.lineWidth = 2
      g.strokeRect(this.sx(s, nd.x) - nd.w / 2 - 3, this.sy(s, nd.y) - 8, nd.w + 6, 25)
      g.fillStyle = 'rgba(255,255,255,0.3)'
      g.fillRect(this.sx(s, nd.x) - nd.w * 0.2, this.sy(s, nd.y) - 5, nd.w * 0.4, 3)
      g.fillStyle = '#9fe6a8'
      g.beginPath()
      g.arc(this.sx(s, hitX), this.sy(s, nd.y) - 2, 3.5, 0, 6.3)
      g.fill()
    } else if (ghost) {
      const can = s.canPlace
      g.strokeStyle = can ? 'rgba(255,191,110,0.85)' : 'rgba(160,168,186,0.6)'
      g.setLineDash([4, 4])
      g.strokeRect(this.sx(s, gx) - 26, this.sy(s, gy), 52, 13)
      g.setLineDash([])
      g.fillStyle = can ? '#ffbf6e' : '#9aa2b5'
      g.beginPath()
      g.arc(this.sx(s, gx), this.sy(s, gy) - 2, 3.5, 0, 6.3)
      g.fill()
    } else {
      const last = arc[arc.length - 1]
      g.fillStyle = '#e0674f'
      g.globalAlpha = 0.9
      g.beginPath()
      g.arc(this.sx(s, last[0]), this.sy(s, last[1]), 3.5, 0, 6.3)
      g.fill()
      g.globalAlpha = 1
    }
  }

  private player(s: Sim): void {
    const { g } = this
    const x = this.sx(s, s.px)
    const y = this.sy(s, s.py)
    const ch = Math.min(1, s.chg)
    let sq = s.sq
    if (!s.air && ch > 0) sq = ch * 0.36
    let hh = 25 * (1 - sq * 0.45) + (!s.air && ch <= 0 ? Math.sin(s.t * 2.6) * 0.5 : 0)
    let ww = 13 * (1 + sq * 0.5)
    if (s.air) {
      hh = 27
      ww = 12
    }
    const ln = !s.air ? ch * 3.5 : 0
    const xt = x + ln
    if (!s.air) {
      g.fillStyle = 'rgba(14,18,30,0.25)'
      g.beginPath()
      g.ellipse(x, y + 2, 10, 3, 0, 0, 6.3)
      g.fill()
    }
    const wv = Math.sin(s.t * 8) * 3 + s.wind * 10 + (s.air ? 6 : 0)
    g.fillStyle = '#454f6e'
    g.beginPath()
    g.moveTo(x - 3, y - hh * 0.78)
    g.quadraticCurveTo(x - 15 - wv * 1.2, y - hh * 0.45, x - 9 - wv * 0.7, y - 2)
    g.lineTo(x - 3, y - 3)
    g.closePath()
    g.fill()
    g.fillStyle = '#38405a'
    g.beginPath()
    g.moveTo(x - 2, y - hh * 0.72)
    g.quadraticCurveTo(x - 12 - wv, y - hh * 0.4, x - 7 - wv * 0.5, y - 2)
    g.lineTo(x - 2, y - 3)
    g.closePath()
    g.fill()
    g.fillStyle = '#262b38'
    g.beginPath()
    g.moveTo(x - ww / 2, y)
    g.lineTo(x - ww / 2 + 1.5, y - hh * 0.6)
    g.quadraticCurveTo(xt, y - hh, x + ww / 2 - 1 + ln * 0.6, y - hh * 0.6)
    g.lineTo(x + ww / 2, y)
    g.closePath()
    g.fill()
    g.fillStyle = '#404a63'
    g.beginPath()
    g.moveTo(xt - 10, y - hh * 0.7)
    g.lineTo(xt + 10, y - hh * 0.7)
    g.lineTo(xt, y - hh - 6)
    g.closePath()
    g.fill()
    g.strokeStyle = 'rgba(255,244,220,0.3)'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(xt - 10, y - hh * 0.7)
    g.lineTo(xt + 10, y - hh * 0.7)
    g.stroke()
    g.strokeStyle = '#d96a4e'
    g.lineWidth = 2
    g.beginPath()
    g.moveTo(x + 2, y - hh * 0.6)
    g.quadraticCurveTo(x - 8 - wv, y - hh * 0.5, x - 13 - wv, y - hh * 0.42 + Math.sin(s.t * 9) * 2)
    g.stroke()
    if (!s.air && ch > 0) {
      const bw = 44
      const bx = x - 22
      const by = y - hh - 19
      g.fillStyle = 'rgba(10,14,24,0.35)'
      g.fillRect(bx, by, bw, 5)
      g.fillStyle = ch > 0.95 ? '#e0674f' : '#ffd76e'
      g.fillRect(bx, by, bw * ch, 5)
    }
  }

  private mistWall(s: Sim): void {
    const { g, W, H } = this
    const bu = this.bu
    const su = this.su
    const la = s.nodes[s.nodes.length - 1]
    const mx = this.sx(s, la.x + 245)
    if (mx >= W + 260) return
    const mc = mix([240, 244, 252], [92, 102, 146], bu)
    const lg = g.createLinearGradient(mx - 130, 0, mx + 40, 0)
    lg.addColorStop(0, rgbA(mc, 0))
    lg.addColorStop(0.7, rgbA(mc, 0.72))
    lg.addColorStop(1, rgbA(mc, 0.9))
    g.fillStyle = lg
    g.fillRect(mx - 130, 0, Math.max(0, W - mx + 130), H)
    for (let v = 0; v < 4; v++) {
      const vx = mx + 22 + v * 34 + Math.sin(s.t * 0.4 + v * 1.9) * 20
      g.fillStyle = rgbA(mix(mc, [255, 255, 255], 0.2), 0.05 + v * 0.012)
      g.beginPath()
      g.ellipse(vx, H * (0.14 + v * 0.24), 88, 190, 0, 0, 6.3)
      g.fill()
    }
    if (su > 0.15) {
      g.fillStyle = `rgba(255,222,170,${(su * 0.09).toFixed(2)})`
      g.beginPath()
      g.moveTo(mx - 46, 0)
      g.lineTo(mx + 86, 0)
      g.lineTo(mx + 26, H * 0.55)
      g.closePath()
      g.fill()
    }
    g.fillStyle = 'rgba(255,255,255,0.3)'
    for (let m = 0; m < 7; m++) {
      const mmx = mx + 24 + ((s.t * 9 + m * 53) % 130)
      const mmy = (m * 67 + ((s.t * 6) | 0)) % H
      g.fillRect(mmx, mmy, 1.6, 1.6)
    }
  }

  private hud(s: Sim, T: Strings): void {
    const { g, W } = this
    const hc = s.camY > 1000 ? 'rgba(246,248,252,0.95)' : '#2b3242'
    const hs = s.camY > 1000 ? 'rgba(246,248,252,0.62)' : 'rgba(43,50,66,0.62)'
    let np = -1
    for (let h = s.idx + 1; h < s.frn; h++) {
      if (s.nodes[h].k === 2) {
        np = h
        break
      }
    }
    g.font = '500 12.5px system-ui,sans-serif'
    g.textAlign = 'left'
    g.fillStyle = hc
    g.fillText(
      `${T.alt} ${(1200 + s.py) | 0} m · ${T.stoneN(s.idx + 1, s.nodes.length)} · ${T.placedN(s.placed)}`,
      14,
      24,
    )
    g.font = '11px system-ui,sans-serif'
    g.fillStyle = hs
    const combo = s.combo > 1 ? T.comboX(s.combo) : ''
    const pav = np >= 0 ? T.toPav(np - s.idx) : T.trail
    const dir = s.wind >= 0 ? '→' : '←'
    const comm = s.commStones > 0 ? ` · ${T.commStones(s.commStones)}` : ''
    g.fillText(
      `${T.perfect} ${s.perf}${combo} · ${T.falls} ${s.falls} · ${T.wind} ${dir} ${Math.round(Math.abs(s.wind) * 100)}%${pav}${comm}`,
      14,
      41,
    )
    g.textAlign = 'right'
    g.fillText(s.canPlace ? T.fallNote : s.anonNote ? T.signInToPlace : T.todayDone, W - 14, 24)
  }
}
