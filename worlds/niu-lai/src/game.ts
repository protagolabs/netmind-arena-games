/**
 * 牛来 · Niu Lai (海报与正片): the engine.
 *
 * A dual-world runner paying tribute to the film "Niu Lai" (2026). One key
 * switches between the ink-wash POSTER world (paper-light, painted things are
 * not solid, spikes are harmless brush grass) and the crude low-poly REEL world
 * (everything is real: platforms hold, tickets collect, spikes kill). The rule
 * in one line: dreams are painted, roads are handmade.
 *
 * This module is platform-agnostic: no storage, no network, no identity. The
 * host (world.ts) injects live strings, a save snapshot, persistence callbacks
 * and an AudioContext supplier, and receives run results. Joint (all-player)
 * box office arrives back through `setJoint` and is rendered on the end card.
 *
 * Sandbox notes: rendering is one canvas + author-authored DOM only. The only
 * innerHTML below is our own static template; every string that ever came from
 * another visitor (roadshow-board names) is set via textContent.
 */
import type { Strings } from './i18n.js'

export interface SaveData {
  total: number
  ach: boolean
  bestScenes: number
  bestTime: number
}

export interface RunStats {
  mode: 'story' | 'endless'
  box: number
  scenes: number
  cleared: boolean
  total: number
  bestScenes: number
}

export interface JointEntry { name: string; box: number; mine: boolean }
export interface JointInfo {
  sum: number
  players: number
  top: JointEntry[]
  signedIn: boolean
  partial: boolean
}

export interface GameOpts {
  L: () => Strings
  initial: SaveData
  save: (d: SaveData) => void
  onRunEnd: (s: RunStats) => void
  getAudio: () => AudioContext | null
  isTouch: boolean
}

export interface GameHandle {
  applyLang(): void
  setJoint(j: JointInfo): void
  toast(text: string): void
}

const W = 960, H = 540
const KILL_Y = 800
const WORLD_W = 7250
const TICKET_PRICE = 38.5
const TARGET = 7705
const INK = '#26221d', PAPER = '#f3ead8', VERM = '#c8402a'

const FILM = { g: 2300, jumpV: -640, maxV: 265, acc: 1900, fricG: 2400, fricA: 500 }
const POSTER = { g: 560, jumpV: -430, maxV: 300, acc: 1000, fricG: 1400, fricA: 120, glideCap: 135 }

interface Plat { x: number; y: number; w: number; h: number; solid: 'both' | 'film'; seed: number }
interface Spike { x: number; y: number; w: number; h: number }
interface Ticket { x: number; y: number; r: number; got: boolean; bob: number }
interface Sign { x: number; y: number; key: string }
interface CP { x: number; y: number; got: boolean }
interface Sub { x: number; key: string; shown: boolean }
interface Particle {
  type: 'ink' | 'gold' | 'burst' | 'plus'
  x: number; y: number; vx: number; vy: number; life: number; max: number
  col?: string; txt?: string
}

const CSS = `
  .pr-root { position: absolute; inset: 0; overflow: hidden; background: #0d0c0a;
    display: flex; align-items: center; justify-content: center;
    font-family: "Kaiti SC", "STKaiti", "KaiTi", serif; }
  .pr-wrap { position: relative; }
  .pr-wrap canvas { display: block; background: #f3ead8; }
  .pr-hud { position: absolute; inset: 0; pointer-events: none; display: none; }
  .pr-chip { position: absolute; padding: 6px 14px; border-radius: 4px; font-size: 15px;
    letter-spacing: 1px; line-height: 1.5; }
  .pr-box { top: 12px; left: 14px; background: rgba(28,26,23,.82); color: #f3ead8;
    border: 1px solid rgba(243,234,216,.25); }
  .pr-box b { color: #ffd76a; font-weight: normal; }
  .pr-mode { top: 12px; right: 14px; text-align: right; transition: all .15s ease; }
  .pr-mode.poster { background: rgba(28,26,23,.85); color: #f3ead8; border: 1px solid #c8402a;
    box-shadow: 0 0 0 2px rgba(200,64,42,.2); }
  .pr-mode.film { background: rgba(190,190,190,.9); color: #333; border: 1px solid #666;
    font-family: "Songti SC", "SimSun", serif; }
  .pr-mode small { display: block; font-size: 11px; opacity: .75; }
  .pr-touch { position: absolute; inset: 0; display: none; pointer-events: none; }
  .pr-tbtn { position: absolute; bottom: 16px; width: 62px; height: 62px; border-radius: 50%;
    background: rgba(28,26,23,.32); color: #f3ead8; border: 1px solid rgba(243,234,216,.45);
    font-size: 21px; display: flex; align-items: center; justify-content: center;
    pointer-events: auto; user-select: none; -webkit-user-select: none; touch-action: none;
    font-family: inherit; }
  .pr-tbtn:active { background: rgba(200,64,42,.55); }
  .pr-tleft { left: 14px; } .pr-tright { left: 92px; }
  .pr-tjump { right: 92px; } .pr-tswitch { right: 14px; background: rgba(200,64,42,.38); }
  .pr-overlay { position: absolute; inset: 0; display: flex; align-items: center;
    justify-content: center; flex-direction: column; background: rgba(16,14,12,.55); }
  .pr-panel { background: #f3ead8; color: #2a2620; text-align: center; padding: 26px 38px;
    border-radius: 6px; max-width: 660px; max-height: 94%; overflow-y: auto;
    box-shadow: 0 12px 60px rgba(0,0,0,.5); border: 1px solid #d8ccb2; position: relative; }
  .pr-panel::after { content: "牛"; position: absolute; right: 16px; top: 16px; width: 32px;
    height: 32px; line-height: 32px; background: #c8402a; color: #f3ead8; font-size: 19px;
    border-radius: 3px; opacity: .92; }
  .pr-panel h1 { font-size: 38px; letter-spacing: 9px; margin: 0 0 6px; font-weight: normal; }
  .pr-sub { font-size: 13px; color: #8a7f6a; margin-bottom: 14px; }
  .pr-rule { font-size: 18px; margin: 12px 0 14px; letter-spacing: 2px;
    border-top: 1px solid #d8ccb2; border-bottom: 1px solid #d8ccb2; padding: 10px 0;
    color: #6b3226; }
  .pr-keys { font-size: 14px; line-height: 1.9; color: #4a4438; }
  .pr-btn { margin-top: 16px; font-family: inherit; font-size: 17px; letter-spacing: 4px;
    padding: 9px 32px; background: #2a2620; color: #f3ead8; border: none; border-radius: 4px;
    cursor: pointer; }
  .pr-btn:hover { background: #c8402a; }
  .pr-btn.alt { background: #6b6254; font-size: 14px; letter-spacing: 2px; padding: 9px 18px;
    margin-left: 10px; }
  .pr-credit { margin-top: 12px; font-size: 11px; color: #a89b82; line-height: 1.7; }
  .pr-endo { display: none; }
  .pr-screen { background: #16140f; color: #7a7264; font-size: 20px; letter-spacing: 12px;
    padding: 10px 0 9px; margin: 2px auto 12px; width: 80%;
    border-radius: 3px 3px 40% 40% / 3px 3px 12px 12px; }
  .pr-seats { line-height: 1.15; font-size: 15px; letter-spacing: 3px; margin-bottom: 12px;
    user-select: none; }
  .pr-seats .s { color: #cabfa6; } .pr-seats .p { color: #c8402a; }
  .pr-stats { font-size: 14px; line-height: 1.9; color: #4a4438; }
  .pr-stats b { color: #6b3226; }
  .pr-ach { display: none; margin: 10px auto 2px; font-size: 19px; letter-spacing: 5px;
    color: #f3ead8; background: #c8402a; padding: 7px 18px; width: fit-content;
    border-radius: 4px; transform: rotate(-2deg); box-shadow: 0 4px 18px rgba(200,64,42,.45); }
  .pr-jointbar { width: 84%; height: 13px; margin: 10px auto 4px; background: #e2d7bd;
    border-radius: 7px; overflow: hidden; border: 1px solid #cabfa6; }
  .pr-jointfill { height: 100%; background: linear-gradient(90deg,#c8402a,#e8863a);
    width: 0%; transition: width 1s ease; }
  .pr-jointtxt { font-size: 12px; color: #8a7f6a; margin-bottom: 4px; }
  .pr-mine { font-size: 13px; color: #6b6254; }
  .pr-hint { font-size: 12px; color: #b0873a; margin-top: 2px; }
  .pr-board { margin: 10px auto 0; font-size: 13px; color: #4a4438; width: 86%; }
  .pr-board h4 { font-size: 13px; letter-spacing: 3px; color: #8a7f6a; margin: 0 0 4px;
    font-weight: normal; border-bottom: 1px dashed #cabfa6; padding-bottom: 3px; }
  .pr-board .row { display: flex; justify-content: space-between; padding: 1px 0; }
  .pr-board .row.me { color: #c8402a; }
  .pr-board .nm { max-width: 70%; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; text-align: left; }
  .pr-quote { font-size: 13px; color: #6b6254; margin-top: 4px; }
  .pr-quote::before { content: "★★★★★ "; color: #e8a63a; letter-spacing: 2px; font-size: 11px; }
`

export function createGame(root: HTMLElement, opts: GameOpts): GameHandle {
  const LS = opts.L
  const save: SaveData = { ...opts.initial }

  /* ---------------- DOM ---------------- */
  const style = document.createElement('style')
  style.textContent = CSS
  root.appendChild(style)
  const shell = document.createElement('div')
  shell.className = 'pr-root'
  // Static authored template only — never receives visitor content.
  shell.innerHTML = `
  <div class="pr-wrap">
    <canvas></canvas>
    <div class="pr-hud">
      <div class="pr-chip pr-box"></div>
      <div class="pr-chip pr-mode poster"></div>
    </div>
    <div class="pr-touch">
      <div class="pr-tbtn pr-tleft">◀</div>
      <div class="pr-tbtn pr-tright">▶</div>
      <div class="pr-tbtn pr-tjump">▲</div>
      <div class="pr-tbtn pr-tswitch">⇄</div>
    </div>
    <div class="pr-overlay pr-menu">
      <div class="pr-panel">
        <h1></h1>
        <div class="pr-sub"></div>
        <div class="pr-rule"></div>
        <div class="pr-keys"></div>
        <div>
          <button class="pr-btn pr-start"></button>
          <button class="pr-btn alt pr-endless"></button>
        </div>
        <div class="pr-credit"></div>
      </div>
    </div>
    <div class="pr-overlay pr-endo">
      <div class="pr-panel">
        <div class="pr-screen"></div>
        <div class="pr-seats"></div>
        <div class="pr-ach"></div>
        <div class="pr-stats"></div>
        <div class="pr-jointbar"><div class="pr-jointfill"></div></div>
        <div class="pr-jointtxt"></div>
        <div class="pr-mine"></div>
        <div class="pr-hint"></div>
        <div class="pr-board"><h4></h4><div class="pr-rows"></div></div>
        <div class="pr-quote pr-q1"></div>
        <div class="pr-quote pr-q2"></div>
        <div>
          <button class="pr-btn pr-again"></button>
          <button class="pr-btn alt pr-swap"></button>
        </div>
      </div>
    </div>
  </div>`
  root.appendChild(shell)

  const qs = <T extends HTMLElement>(sel: string): T => {
    const el = shell.querySelector(sel)
    if (!el) throw new Error(`missing ${sel}`)
    return el as T
  }
  const wrap = qs<HTMLDivElement>('.pr-wrap')
  const cv = qs<HTMLCanvasElement>('canvas')
  const ctx = cv.getContext('2d')!
  const hudEl = qs<HTMLDivElement>('.pr-hud')
  const boxEl = qs<HTMLDivElement>('.pr-box')
  const modeEl = qs<HTMLDivElement>('.pr-mode')
  const menuEl = qs<HTMLDivElement>('.pr-menu')
  const endoEl = qs<HTMLDivElement>('.pr-endo')

  const RS = Math.min(2, window.devicePixelRatio || 1)
  cv.width = W * RS; cv.height = H * RS
  function fit(): void {
    const sw = Math.min(window.innerWidth, window.innerHeight * (W / H))
    const sh = sw * (H / W)
    wrap.style.width = sw + 'px'; wrap.style.height = sh + 'px'
    cv.style.width = sw + 'px'; cv.style.height = sh + 'px'
  }
  window.addEventListener('resize', fit); fit()

  /* ---------------- state ---------------- */
  const g = {
    state: 'menu' as 'menu' | 'play' | 'pause' | 'dead' | 'end',
    mode: 'poster' as 'poster' | 'film',
    gameMode: 'story' as 'story' | 'endless',
    time: 0, runTime: 0,
    box: 0, ticketsGot: 0, deaths: 0,
    checkpoint: { x: 80, y: 472 },
    switchCd: 0, deadT: 0, cam: 0,
    sub: null as { line: string; t: number } | null,
    toast: null as { text: string; t: number } | null,
    shakeT: 0,
  }
  const pl = {
    x: 80, y: 472, w: 30, h: 28, vx: 0, vy: 0,
    onGround: false, face: 1, coyote: 0, jbuf: 0,
    animT: 0, poseT: 0, pose: 0,
  }
  const wall = { active: false, x: 5230, triggerX: 5450, startX: 5230, speed: 196 }
  const bird = { state: 'perch' as 'perch' | 'follow', x: 3660, y: 288, t: 0, sayT: 0, sparkT: 0 }
  const trans = { t: 0, to: 'poster' as 'poster' | 'film', px: 0, py: 0, blobs: [] as { ang: number; spd: number; r: number }[] }
  const endless = { genX: 0, sceneCount: 0, mult: 1, nextSubX: 0, toasted359: false }
  let particles: Particle[] = []
  let lastJoint: JointInfo | null = null

  /* ---------------- level ---------------- */
  let seedCnt = 1
  const plats: Plat[] = [], spikes: Spike[] = [], tickets: Ticket[] = []
  const signs: Sign[] = [], cps: CP[] = [], subs: Sub[] = []
  const G = (x: number, w: number): void => { plats.push({ x, y: 500, w, h: 90, solid: 'both', seed: seedCnt++ }) }
  const B = (x: number, y: number, w: number, h = 18): void => { plats.push({ x, y, w, h, solid: 'both', seed: seedCnt++ }) }
  const P = (x: number, y: number, w: number, h = 18): void => { plats.push({ x, y, w, h, solid: 'film', seed: seedCnt++ }) }
  const S = (x: number, w: number): void => { spikes.push({ x, y: 478, w, h: 22 }) }
  const T = (x: number, y: number): void => { tickets.push({ x, y, r: 9, got: false, bob: seedCnt++ }) }

  function clearLevel(): void {
    plats.length = 0; spikes.length = 0; tickets.length = 0
    signs.length = 0; cps.length = 0; subs.length = 0
  }
  function buildStory(): void {
    clearLevel()
    G(0, 1400); G(1600, 1200); G(3000, 180); G(4350, 1750); G(6280, 970)
    B(600, 440, 90); B(760, 380, 90); B(3620, 315, 380); B(4560, 430, 160)
    P(1400, 500, 200); P(3230, 440, 110); P(3410, 375, 110); P(6100, 500, 180)
    S(1950, 170); S(2350, 240); S(4580, 120); S(4900, 180); S(5800, 130); S(6500, 200)
    const TT: [number, number][] = [[300, 470], [360, 470], [420, 470], [630, 405], [790, 345],
      [1450, 468], [1510, 468], [1570, 468], [1700, 470],
      [1975, 432], [2200, 470], [2260, 470], [2360, 432],
      [3270, 405], [3450, 340], [3700, 280], [3780, 280], [3860, 280],
      [4420, 470], [4620, 395], [4700, 395], [5150, 470],
      [5700, 470], [5950, 470], [6160, 468], [6220, 468], [6800, 470]]
    TT.forEach(a => T(a[0], a[1]))
    const SG: [number, number, string][] = [[220, 432, 'move'], [1290, 428, 'bridge'],
      [1880, 428, 'spike'], [3080, 420, 'rule'], [3760, 268, 'lark'], [5480, 428, 'run']]
    SG.forEach(a => signs.push({ x: a[0], y: a[1], key: a[2] }))
    cps.push({ x: 3060, y: 500, got: false }, { x: 5300, y: 500, got: false })
    const SB: [number, string][] = [[500, 's1'], [1430, 's2'], [2550, 's3'],
      [4450, 's4'], [5750, 's5'], [6700, 's6']]
    SB.forEach(a => subs.push({ x: a[0], key: a[1], shown: false }))
  }
  buildStory()
  const goal = { x: 6950, y: 380, w: 90, h: 120 }
  const waypoints = [{ x: 3060, y: 450 }, { x: 5300, y: 450 }, { x: 6990, y: 420 }]

  function genChunk(): void {
    const d = Math.min(1, (endless.genX - 1200) / 14000)
    const R = Math.random
    let x = endless.genX
    const roll = R()
    if (roll < 0.18) {
      const w = 320 + R() * 200
      G(x, w)
      for (let tx = x + 60; tx < x + w - 40; tx += 60) if (R() < 0.7) T(tx, 470)
      x += w
    } else if (roll < 0.42) {
      const w = 300 + R() * 260
      G(x, w)
      const sw = Math.min(w - 80, 120 + R() * (120 + d * 140))
      const sx = x + (w - sw) / 2
      S(sx, sw)
      if (R() < 0.8) T(x + 40, 470)
      T(sx + sw / 2, 432)
      if (R() < 0.8) T(x + w - 40, 470)
      x += w
    } else if (roll < 0.62) {
      const gap = 170 + R() * (60 + d * 90)
      P(x, 500, gap)
      for (let tx = x + 30; tx < x + gap - 20; tx += 55) T(tx, 468)
      const w = 260 + R() * 200
      G(x + gap, w)
      x += gap + w
    } else if (roll < 0.78) {
      const gap = 240 + R() * (80 + d * 120)
      const w = 280 + R() * 200
      G(x + gap, w)
      T(x + gap + 50, 470)
      x += gap + w
    } else if (roll < 0.92) {
      const w = 380 + R() * 180
      G(x, w)
      const bw = 130 + R() * 80
      const bx = x + (w - bw) / 2
      S(bx + 10, bw - 20)
      B(bx, 430 - R() * 30, bw)
      T(bx + bw / 2 - 20, 392); T(bx + bw / 2 + 20, 392)
      x += w
    } else {
      const gap = 300 + R() * 200
      let px = x + 40, py = 460
      while (px < x + gap - 80) {
        const pw = 90 + R() * 50
        P(px, py, pw)
        T(px + pw / 2, py - 32)
        px += pw + 60 + R() * 30
        py = 380 + R() * 90
      }
      const w = 260 + R() * 160
      G(x + gap, w)
      x += gap + w
    }
    endless.genX = x
  }
  function pruneLevel(): void {
    const cut = g.cam - 600
    while (plats.length && plats[0]!.x + plats[0]!.w < cut) plats.shift()
    while (spikes.length && spikes[0]!.x + spikes[0]!.w < cut) spikes.shift()
    while (tickets.length && tickets[0]!.x + 30 < cut) tickets.shift()
  }

  /* ---------------- audio ---------------- */
  const music = { muted: false, gain: null as GainNode | null, nextT: 0, idx: 6, droneT: 0 }
  const SCALE = [0, 2, 4, 7, 9]
  const ROOT = 196
  function degFreq(i: number): number {
    const oct = Math.floor(i / 5), st = SCALE[((i % 5) + 5) % 5]! + oct * 12
    return ROOT * Math.pow(2, st / 12)
  }
  function pluck(a: AudioContext, freq: number, t: number, vel: number, dur: number): void {
    const o = a.createOscillator(), o2 = a.createOscillator()
    const gn = a.createGain(), g2 = a.createGain(), f = a.createBiquadFilter()
    o.type = 'triangle'; o.frequency.value = freq
    o2.type = 'sine'; o2.frequency.value = freq * 2.005
    g2.gain.value = 0.25
    f.type = 'lowpass'; f.frequency.value = 1700
    gn.gain.setValueAtTime(vel, t)
    gn.gain.exponentialRampToValueAtTime(0.0008, t + dur)
    o.connect(f); o2.connect(g2); g2.connect(f); f.connect(gn); gn.connect(music.gain!)
    o.start(t); o2.start(t); o.stop(t + dur + 0.05); o2.stop(t + dur + 0.05)
  }
  setInterval(() => {
    const a = opts.getAudio()
    if (!a) return
    if (!music.gain) {
      music.gain = a.createGain()
      music.gain.gain.value = 0
      music.gain.connect(a.destination)
      music.nextT = a.currentTime + 0.3
      music.droneT = a.currentTime + 2
    }
    const target = !music.muted && g.mode === 'poster' ? 0.14 : 0
    music.gain.gain.setTargetAtTime(target, a.currentTime, 0.12)
    if (target === 0) { music.nextT = Math.max(music.nextT, a.currentTime + 0.25); return }
    while (music.nextT < a.currentTime + 0.8) {
      const steps = [-2, -1, -1, 1, 1, 2]
      music.idx = Math.max(0, Math.min(11, music.idx + steps[Math.floor(Math.random() * steps.length)]!))
      const dur = [0.45, 0.9, 0.9, 1.35, 1.8][Math.floor(Math.random() * 5)]!
      if (Math.random() > 0.22) {
        pluck(a, degFreq(music.idx), music.nextT, 0.22, 2.2)
        if (Math.random() < 0.18) pluck(a, degFreq(music.idx - 5), music.nextT + 0.02, 0.1, 2.6)
      }
      music.nextT += dur
    }
    if (a.currentTime > music.droneT) {
      pluck(a, ROOT / 2, a.currentTime + 0.05, 0.12, 5)
      music.droneT = a.currentTime + 9 + Math.random() * 6
    }
  }, 180)

  function tone(f0: number, f1: number, dur: number, type: OscillatorType, vol: number): void {
    const a = opts.getAudio()
    if (!a) return
    try {
      const o = a.createOscillator(), gn = a.createGain()
      o.type = type
      o.frequency.setValueAtTime(f0, a.currentTime)
      o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), a.currentTime + dur)
      gn.gain.setValueAtTime(vol, a.currentTime)
      gn.gain.exponentialRampToValueAtTime(0.001, a.currentTime + dur)
      o.connect(gn); gn.connect(a.destination); o.start(); o.stop(a.currentTime + dur + 0.02)
    } catch { /* audio is best-effort */ }
  }
  function splashSfx(dur: number, vol: number, freq: number): void {
    const a = opts.getAudio()
    if (!a) return
    try {
      const len = a.sampleRate * dur, buf = a.createBuffer(1, len, a.sampleRate)
      const d = buf.getChannelData(0)
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len)
      const src = a.createBufferSource(); src.buffer = buf
      const f = a.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq
      const gn = a.createGain(); gn.gain.value = vol
      src.connect(f); f.connect(gn); gn.connect(a.destination); src.start()
    } catch { /* audio is best-effort */ }
  }
  const sfx = {
    jump: () => tone(300, 540, 0.12, 'square', 0.06),
    switch: () => splashSfx(0.22, 0.16, 900),
    ticket: () => { tone(880, 880, 0.07, 'sine', 0.08); setTimeout(() => tone(1318, 1318, 0.1, 'sine', 0.08), 70) },
    die: () => tone(200, 55, 0.4, 'sawtooth', 0.1),
    cp: () => tone(523, 784, 0.16, 'triangle', 0.08),
    goal: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, f, 0.18, 'triangle', 0.09), i * 110)),
  }

  /* ---------------- input ---------------- */
  const keys: Record<string, boolean> = {}
  window.addEventListener('keydown', e => {
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
    if (keys[e.code]) return
    keys[e.code] = true
    if (g.state === 'menu' && (e.code === 'Enter' || e.code === 'Space')) { startStory(); return }
    if (g.state === 'end' && e.code === 'Enter') { resetRun(); return }
    if (e.code === 'KeyM') { music.muted = !music.muted; return }
    if (e.code === 'KeyP' || e.code === 'Escape') {
      if (g.state === 'play') g.state = 'pause'
      else if (g.state === 'pause') g.state = 'play'
      return
    }
    if (e.code === 'KeyR' && (g.state === 'play' || g.state === 'pause' || g.state === 'end')) { resetRun(); return }
    if (g.state !== 'play') return
    if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') pl.jbuf = 0.12
    if (e.code === 'KeyX' || e.code === 'KeyJ' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') switchMode()
  })
  window.addEventListener('keyup', e => { keys[e.code] = false })
  const left = (): boolean => !!(keys['ArrowLeft'] || keys['KeyA'])
  const right = (): boolean => !!(keys['ArrowRight'] || keys['KeyD'])

  if (opts.isTouch) {
    qs<HTMLDivElement>('.pr-touch').style.display = 'block'
    const hold = (sel: string, code: string): void => {
      const el = qs<HTMLDivElement>(sel)
      const on = (e: Event): void => { e.preventDefault(); keys[code] = true }
      const off = (e: Event): void => { e.preventDefault(); keys[code] = false }
      el.addEventListener('pointerdown', on)
      el.addEventListener('pointerup', off)
      el.addEventListener('pointercancel', off)
      el.addEventListener('pointerleave', off)
    }
    hold('.pr-tleft', 'ArrowLeft')
    hold('.pr-tright', 'ArrowRight')
    qs<HTMLDivElement>('.pr-tjump').addEventListener('pointerdown', e => {
      e.preventDefault()
      if (g.state === 'play') pl.jbuf = 0.12
    })
    qs<HTMLDivElement>('.pr-tswitch').addEventListener('pointerdown', e => {
      e.preventDefault()
      switchMode()
    })
  }

  /* ---------------- flow ---------------- */
  function switchMode(): void {
    if (g.switchCd > 0 || g.state !== 'play') return
    g.switchCd = 0.18
    g.mode = g.mode === 'poster' ? 'film' : 'poster'
    trans.t = 1; trans.to = g.mode
    trans.px = pl.x + pl.w / 2 - g.cam; trans.py = pl.y + pl.h / 2
    trans.blobs = []
    for (let i = 0; i < 16; i++) {
      trans.blobs.push({ ang: Math.random() * 6.283, spd: 120 + Math.random() * 480, r: 24 + Math.random() * 90 })
    }
    sfx.switch()
    resolveEmbed()
    updateHud()
  }
  function solids(): Plat[] {
    return plats.filter(p => p.solid === 'both' || (p.solid === 'film' && g.mode === 'film'))
  }
  function overlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  }
  function resolveEmbed(): void {
    for (let iter = 0; iter < 4; iter++) {
      let hit: Plat | null = null
      for (const p of solids()) if (overlap(pl, p)) { hit = p; break }
      if (!hit) return
      const pen = pl.y + pl.h - hit.y
      if (pen < 26) { pl.y = hit.y - pl.h; pl.vy = Math.min(pl.vy, 0); pl.onGround = true }
      else {
        const dl = pl.x + pl.w - hit.x, dr = hit.x + hit.w - pl.x
        if (dl < dr) pl.x = hit.x - pl.w; else pl.x = hit.x + hit.w
      }
    }
  }

  function hideOverlays(): void {
    menuEl.style.display = 'none'
    endoEl.style.display = 'none'
    hudEl.style.display = 'block'
  }
  function resetCommon(): void {
    g.box = 0; g.deaths = 0; g.runTime = 0; g.ticketsGot = 0; g.toast = null
    g.mode = 'poster'; g.sub = null; g.cam = 0
    g.checkpoint = { x: 80, y: 472 }
    pl.x = 80; pl.y = 472; pl.vx = 0; pl.vy = 0; pl.face = 1
    particles = []
  }
  function startStory(): void {
    g.gameMode = 'story'
    buildStory()
    resetCommon()
    wall.active = false; wall.x = wall.startX; wall.speed = 196
    bird.state = 'perch'; bird.x = 3660; bird.y = 288
    hideOverlays()
    g.state = 'play'
    updateHud()
  }
  function startEndless(): void {
    g.gameMode = 'endless'
    clearLevel()
    G(0, 1200)
    T(300, 470); T(360, 470); T(420, 470)
    endless.genX = 1200; endless.sceneCount = 0; endless.mult = 1
    endless.nextSubX = 900; endless.toasted359 = false
    resetCommon()
    wall.active = true; wall.x = -450; wall.speed = 175
    bird.state = 'follow'; bird.x = 220; bird.y = 380
    hideOverlays()
    g.state = 'play'
    updateHud()
  }
  function resetRun(): void { if (g.gameMode === 'endless') startEndless(); else startStory() }

  function die(): void {
    if (g.state !== 'play') return
    g.state = 'dead'; g.deadT = 0.7; g.deaths++
    g.shakeT = 0.3
    sfx.die()
    const col = g.mode === 'poster' ? INK : '#777'
    for (let i = 0; i < 24; i++) {
      particles.push({ type: 'burst', x: pl.x + pl.w / 2, y: pl.y + pl.h / 2,
        vx: (Math.random() - 0.5) * 420, vy: -Math.random() * 380, life: 0.9, max: 0.9, col })
    }
  }
  function respawn(): void {
    pl.x = g.checkpoint.x; pl.y = g.checkpoint.y; pl.vx = 0; pl.vy = 0
    wall.active = false; wall.x = wall.startX
    g.mode = 'poster'; g.sub = null
    g.state = 'play'
    updateHud()
  }
  function endGame(cleared: boolean): void {
    g.state = 'end'
    if (cleared) sfx.goal()
    save.total = Math.round((save.total + g.box) * 10) / 10
    if (g.gameMode === 'endless' && endless.sceneCount > save.bestScenes) save.bestScenes = endless.sceneCount
    if (cleared && (save.bestTime === 0 || g.runTime < save.bestTime)) save.bestTime = Math.round(g.runTime * 10) / 10
    opts.save({ ...save })
    hudEl.style.display = 'none'
    fillEndScreen()
    endoEl.style.display = 'flex'
    opts.onRunEnd({
      mode: g.gameMode, box: g.box, scenes: endless.sceneCount,
      cleared, total: save.total, bestScenes: save.bestScenes,
    })
  }

  function collectTicket(t: Ticket): void {
    t.got = true
    g.ticketsGot++
    const val = TICKET_PRICE * (g.gameMode === 'endless' ? endless.mult : 1)
    g.box = Math.round((g.box + val) * 10) / 10
    sfx.ticket()
    particles.push({ type: 'plus', x: t.x, y: t.y - 14, vx: 0, vy: -46, life: 0.9, max: 0.9, txt: '+¥' + val.toFixed(1) })
    for (let i = 0; i < 6; i++) particles.push({ type: 'gold', x: t.x, y: t.y,
      vx: (Math.random() - 0.5) * 160, vy: -Math.random() * 140, life: 0.5, max: 0.5 })
    updateHud()
  }

  /* ---------------- update ---------------- */
  function update(dt: number): void {
    if (g.state === 'pause') return
    g.time += dt
    if (g.switchCd > 0) g.switchCd -= dt
    if (trans.t > 0) trans.t -= dt * 3.5
    if (g.shakeT > 0) g.shakeT -= dt
    if (g.sub) { g.sub.t -= dt; if (g.sub.t <= 0) g.sub = null }
    if (g.toast) { g.toast.t -= dt; if (g.toast.t <= 0) g.toast = null }

    particles = particles.filter(p => (p.life -= dt) > 0)
    particles.forEach(p => {
      p.x += p.vx * dt; p.y += p.vy * dt
      if (p.type === 'burst') p.vy += 900 * dt
      if (p.type === 'gold') p.vy += 500 * dt
    })

    if (g.state === 'dead') {
      g.deadT -= dt
      if (g.deadT <= 0) { if (g.gameMode === 'endless') endGame(false); else respawn() }
      return
    }
    if (g.state !== 'play') { pl.animT += dt * 0.4; return }

    g.runTime += dt

    if (g.gameMode === 'endless') {
      while (endless.genX < pl.x + 1700) genChunk()
      pruneLevel()
      wall.speed = Math.min(288, 175 + (pl.x - 80) * 0.008)
      if (wall.x < pl.x - 900) wall.x = pl.x - 900
      const sc = Math.floor(Math.max(0, pl.x - 80) / 100)
      if (sc > endless.sceneCount) {
        endless.sceneCount = sc
        endless.mult = 1 + Math.floor(sc / 20)
        if (sc >= 359 && !endless.toasted359) {
          endless.toasted359 = true
          g.toast = { text: LS().toast359, t: 3 }
        }
        updateHud()
      }
      if (pl.x > endless.nextSubX) {
        endless.nextSubX = pl.x + 1100 + Math.random() * 500
        const pool = LS().endlessSubs.concat([LS().sceneSub(Math.max(1, endless.sceneCount))])
        g.sub = { line: pool[Math.floor(Math.random() * pool.length)]!, t: 3 }
      }
    }

    const M = g.mode === 'poster' ? POSTER : FILM

    let ax = 0
    if (left()) { ax -= M.acc; pl.face = -1 }
    if (right()) { ax += M.acc; pl.face = 1 }
    if (ax === 0) {
      const f = pl.onGround ? M.fricG : M.fricA
      if (pl.vx > 0) pl.vx = Math.max(0, pl.vx - f * dt)
      else pl.vx = Math.min(0, pl.vx + f * dt)
    } else pl.vx += ax * dt
    pl.vx = Math.max(-M.maxV, Math.min(M.maxV, pl.vx))

    pl.coyote = pl.onGround ? 0.1 : Math.max(0, pl.coyote - dt)
    pl.jbuf = Math.max(0, pl.jbuf - dt)
    if (pl.jbuf > 0 && pl.coyote > 0) {
      pl.vy = M.jumpV; pl.onGround = false; pl.coyote = 0; pl.jbuf = 0
      sfx.jump()
    }

    pl.vy += M.g * dt
    if (g.mode === 'poster' && pl.vy > POSTER.glideCap) pl.vy = POSTER.glideCap

    const S_ = solids()
    pl.x += pl.vx * dt
    pl.x = Math.max(0, g.gameMode === 'story' ? Math.min(WORLD_W - pl.w, pl.x) : pl.x)
    for (const p of S_) if (overlap(pl, p)) {
      if (pl.vx > 0) pl.x = p.x - pl.w; else if (pl.vx < 0) pl.x = p.x + p.w
      pl.vx = 0
    }
    pl.onGround = false
    pl.y += pl.vy * dt
    for (const p of S_) if (overlap(pl, p)) {
      if (pl.vy > 0) { pl.y = p.y - pl.h; pl.vy = 0; pl.onGround = true }
      else if (pl.vy < 0) { pl.y = p.y + p.h; pl.vy = 0 }
    }

    pl.animT += dt * (0.3 + Math.abs(pl.vx) / M.maxV)
    pl.poseT += dt
    if (pl.poseT > 1 / 6) { pl.poseT = 0; pl.pose = 1 - pl.pose }

    if (pl.y > KILL_Y) { die(); return }

    if (g.mode === 'film') {
      for (const s of spikes) {
        const box = { x: s.x + 5, y: s.y + 6, w: s.w - 10, h: s.h - 6 }
        if (overlap(pl, box)) { die(); return }
      }
      for (const t of tickets) {
        if (!t.got && Math.abs(pl.x + pl.w / 2 - t.x) < 24 && Math.abs(pl.y + pl.h / 2 - t.y) < 26) collectTicket(t)
      }
      let fired: Sub | null = null
      for (const s of subs) if (!s.shown && pl.x > s.x) { s.shown = true; fired = s }
      if (fired) g.sub = { line: LS().storySubs[fired.key] ?? '', t: 3.4 }
    }

    for (const c of cps) {
      if (!c.got && pl.x + pl.w > c.x && pl.x < c.x + 30) {
        c.got = true; g.checkpoint = { x: c.x, y: c.y - pl.h }
        sfx.cp()
      }
    }

    bird.t += dt
    if (bird.state === 'perch' && pl.x > 3400) bird.state = 'follow'
    if (bird.state === 'follow') {
      const tx = pl.x + 130 * pl.face
      bird.x += (tx - bird.x) * Math.min(1, dt * 2.6)
      const baseY = Math.max(80, pl.y - 85)
      bird.y += (baseY + Math.sin(bird.t * 3) * 16 - bird.y) * Math.min(1, dt * 3)
      bird.sayT -= dt
      if (bird.sayT < -6) bird.sayT = 1.2
      if (g.mode === 'poster') {
        bird.sparkT -= dt
        if (bird.sparkT <= 0) {
          bird.sparkT = 0.09
          const wp = g.gameMode === 'endless'
            ? { x: pl.x + 500, y: Math.max(120, pl.y - 60) }
            : (waypoints.find(w => w.x > pl.x + 40) || waypoints[waypoints.length - 1]!)
          const dx = wp.x - bird.x, dy = wp.y - bird.y, len = Math.hypot(dx, dy) || 1
          particles.push({ type: 'gold', x: bird.x, y: bird.y,
            vx: dx / len * 90 + (Math.random() - 0.5) * 30, vy: dy / len * 90 + (Math.random() - 0.5) * 30,
            life: 0.8, max: 0.8 })
        }
      }
    }

    if (g.gameMode === 'story' && !wall.active && pl.x > wall.triggerX) {
      wall.active = true; wall.x = wall.startX; g.shakeT = 0.4
    }
    if (wall.active) {
      wall.x += wall.speed * dt
      if (pl.x < wall.x - 10) { die(); return }
    }

    if (g.gameMode === 'story' && overlap(pl, goal)) { endGame(true); return }

    if (g.mode === 'poster' && (Math.abs(pl.vx) > 60 || !pl.onGround)) {
      if (Math.random() < 0.35) particles.push({ type: 'ink', x: pl.x + pl.w / 2 - pl.face * 12, y: pl.y + pl.h - 6,
        vx: -pl.face * 20, vy: -14 - Math.random() * 20, life: 0.7, max: 0.7 })
    }

    const target = Math.max(0, g.gameMode === 'story' ? Math.min(WORLD_W - W, pl.x - W * 0.38) : pl.x - W * 0.38)
    g.cam += (target - g.cam) * Math.min(1, dt * 8)
  }

  /* ---------------- HUD / end screen ---------------- */
  function fmtMoney(n: number): string { return n.toFixed(1) }
  function fmtTime(sec: number): string {
    const L = LS()
    return L.minSec(Math.floor(sec / 60), String(Math.floor(sec % 60)).padStart(2, '0'))
  }
  function updateHud(): void {
    const L = LS()
    const mult = g.gameMode === 'endless' && endless.mult > 1 ? `（${L.hudMult(endless.mult)}）` : ''
    const scenes = g.gameMode === 'endless' ? `　·　${L.hudScenes(endless.sceneCount)}` : ''
    const mine = Math.round((save.total + g.box) * 10) / 10
    boxEl.innerHTML = ''
    const b = document.createElement('b')
    b.textContent = `¥${fmtMoney(g.box)}`
    boxEl.append(`${L.hudRun} `, b, `${mult}${scenes}　·　${L.hudMine} ¥${fmtMoney(mine)}`)
    modeEl.className = 'pr-chip pr-mode ' + g.mode
    modeEl.innerHTML = ''
    const sm = document.createElement('small')
    sm.textContent = L.switchHint
    modeEl.append(g.mode === 'poster' ? L.modePoster : L.modeFilm, sm)
  }

  function mulberry(a: number): () => number {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0
      let t = Math.imul(a ^ a >>> 15, 1 | a)
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
      return ((t ^ t >>> 14) >>> 0) / 4294967296
    }
  }

  function renderJoint(): void {
    const L = LS()
    const bar = qs<HTMLDivElement>('.pr-jointfill')
    const txt = qs<HTMLDivElement>('.pr-jointtxt')
    const mineEl = qs<HTMLDivElement>('.pr-mine')
    const hintEl = qs<HTMLDivElement>('.pr-hint')
    const boardH = qs<HTMLHeadingElement>('.pr-board h4')
    const rows = qs<HTMLDivElement>('.pr-rows')
    mineEl.textContent = L.mineLine(fmtMoney(save.total))
    if (!lastJoint) {
      bar.style.width = '0%'
      txt.textContent = '…'
      hintEl.textContent = ''
      boardH.textContent = L.boardTitle
      rows.textContent = ''
      return
    }
    const j = lastJoint
    const sum = Math.round(j.sum * 10) / 10
    let goalN: number, label = ''
    if (sum < TARGET) goalN = TARGET
    else if (sum < 1000000) { goalN = 1000000; label = L.goalM1 }
    else if (sum < 10000000) { goalN = 10000000; label = L.goalM2 }
    else goalN = 0
    bar.style.width = (goalN === 0 ? 100 : Math.min(100, sum / goalN * 100)) + '%'
    if (goalN === 0) txt.textContent = L.jointBarDone(fmtMoney(sum))
    else if (goalN === TARGET) txt.textContent = L.jointBar(fmtMoney(sum), String(TARGET), fmtMoney(TARGET - sum))
    else txt.textContent = L.jointBarNext(fmtMoney(sum), goalN.toLocaleString('en-US'), label)
    hintEl.textContent = j.signedIn ? '' : L.signInHint
    boardH.textContent = `${L.boardTitle} · ${L.playersLine(j.players)}`
    rows.textContent = ''
    if (j.top.length === 0) {
      const d = document.createElement('div')
      d.textContent = L.boardEmpty
      rows.appendChild(d)
    } else {
      j.top.forEach(e => {
        const row = document.createElement('div')
        row.className = 'row' + (e.mine ? ' me' : '')
        const nm = document.createElement('span')
        nm.className = 'nm'
        nm.textContent = e.name        // another visitor's text — textContent only
        const val = document.createElement('span')
        val.textContent = `¥${fmtMoney(e.box)}`
        row.append(nm, val)
        rows.appendChild(row)
      })
    }
    qs<HTMLDivElement>('.pr-ach').style.display = (save.ach || sum >= TARGET) ? 'block' : 'none'
  }

  function fillEndScreen(): void {
    const L = LS()
    const isE = g.gameMode === 'endless'
    const audience = isE
      ? Math.min(60, 1 + Math.floor(endless.sceneCount / 6))
      : Math.min(60, g.deaths + 1)
    const rnd = mulberry((isE ? endless.sceneCount : g.deaths) * 31 + 7)
    const idx = new Set<number>()
    while (idx.size < audience) idx.add(Math.floor(rnd() * 60))
    const seats = qs<HTMLDivElement>('.pr-seats')
    seats.textContent = ''
    for (let r = 0; r < 5; r++) {
      const row = document.createElement('div')
      for (let c = 0; c < 12; c++) {
        const i = r * 12 + c
        const sp = document.createElement('span')
        sp.className = idx.has(i) ? 'p' : 's'
        sp.textContent = idx.has(i) ? '人' : '〇'
        row.appendChild(sp)
      }
      seats.appendChild(row)
    }
    qs<HTMLDivElement>('.pr-screen').textContent = isE ? L.endEndless : L.endStory

    const stats = qs<HTMLDivElement>('.pr-stats')
    stats.textContent = ''
    const lines: string[] = []
    if (isE) {
      lines.push(L.statBoxEndless(fmtMoney(g.box), g.ticketsGot, (TICKET_PRICE * endless.mult).toFixed(1)))
      lines.push(L.statScenesEndless(endless.sceneCount, save.bestScenes, fmtTime(g.runTime)))
      lines.push(L.statAudienceEndless(audience))
    } else {
      lines.push(L.statBoxStory(fmtMoney(g.box), g.ticketsGot, tickets.length))
      lines.push(L.statAudienceStory(audience, Math.max(0, audience - 1)))
      lines.push(L.statTimeStory(fmtTime(g.runTime), fmtTime(save.bestTime > 0 ? save.bestTime : g.runTime)))
    }
    lines.forEach((s, i) => {
      if (i > 0) stats.appendChild(document.createElement('br'))
      stats.append(s)
    })

    qs<HTMLDivElement>('.pr-ach').textContent = L.ach
    const qa = (g.deaths * 7 + g.ticketsGot * 3 + (isE ? endless.sceneCount : 0)) % L.quotes.length
    let qb = (qa + 3) % L.quotes.length; if (qb === qa) qb = (qb + 1) % L.quotes.length
    qs<HTMLDivElement>('.pr-q1').textContent = L.quotes[qa]!
    qs<HTMLDivElement>('.pr-q2').textContent = L.quotes[qb]!
    qs<HTMLButtonElement>('.pr-again').textContent = L.btnAgain
    qs<HTMLButtonElement>('.pr-swap').textContent = isE ? L.btnSwapToStory : L.btnSwapToEndless
    renderJoint()
  }

  qs<HTMLButtonElement>('.pr-start').addEventListener('click', () => startStory())
  qs<HTMLButtonElement>('.pr-endless').addEventListener('click', () => startEndless())
  qs<HTMLButtonElement>('.pr-again').addEventListener('click', () => resetRun())
  qs<HTMLButtonElement>('.pr-swap').addEventListener('click', () => {
    if (g.gameMode === 'endless') startStory(); else startEndless()
  })

  function applyLang(): void {
    const L = LS()
    qs<HTMLHeadingElement>('.pr-menu h1').textContent = L.title
    qs<HTMLDivElement>('.pr-menu .pr-sub').textContent = L.sub
    qs<HTMLDivElement>('.pr-menu .pr-rule').textContent = L.rule
    const keysEl = qs<HTMLDivElement>('.pr-menu .pr-keys')
    keysEl.textContent = ''
    ;[L.keys1, L.keys2, L.expl1, L.expl2].forEach((s, i) => {
      if (i > 0) keysEl.appendChild(document.createElement('br'))
      keysEl.append(s)
    })
    qs<HTMLButtonElement>('.pr-start').textContent = L.btnStart
    qs<HTMLButtonElement>('.pr-endless').textContent = L.btnEndless
    const credit = qs<HTMLDivElement>('.pr-menu .pr-credit')
    credit.textContent = ''
    credit.append(L.creditLine, document.createElement('br'), L.jointGoalLine)
    updateHud()
    if (g.state === 'end') fillEndScreen()
  }
  applyLang()

  /* ---------------- render ---------------- */
  let paperTex: HTMLCanvasElement | null = null
  function makePaper(): void {
    const c = document.createElement('canvas'); c.width = 480; c.height = 270
    const x = c.getContext('2d')!
    x.fillStyle = PAPER; x.fillRect(0, 0, 480, 270)
    for (let i = 0; i < 5200; i++) {
      x.fillStyle = `rgba(120,105,80,${Math.random() * 0.09})`
      x.fillRect(Math.random() * 480, Math.random() * 270, 1.3, 1.3)
    }
    for (let i = 0; i < 60; i++) {
      x.strokeStyle = `rgba(150,135,105,${0.05 + Math.random() * 0.07})`
      x.beginPath()
      const sx = Math.random() * 480, sy = Math.random() * 270
      x.moveTo(sx, sy); x.lineTo(sx + (Math.random() - 0.5) * 60, sy + (Math.random() - 0.5) * 8)
      x.stroke()
    }
    paperTex = c
  }
  makePaper()

  const KAI = '"Kaiti SC","STKaiti",serif'
  const SONG = '"Songti SC","SimSun",serif'

  function render(): void {
    ctx.setTransform(RS, 0, 0, RS, 0, 0)
    let shx = 0, shy = 0
    if (g.shakeT > 0) { shx = (Math.random() - 0.5) * 8 * g.shakeT; shy = (Math.random() - 0.5) * 8 * g.shakeT }

    if (g.mode === 'poster') renderPosterBG(); else renderFilmBG()

    ctx.save()
    ctx.translate(-g.cam + shx, shy)
    for (const p of plats) g.mode === 'poster' ? drawPlatPoster(p) : drawPlatFilm(p)
    for (const s of spikes) g.mode === 'poster' ? drawSpikePoster(s) : drawSpikeFilm(s)
    for (const c of cps) drawCP(c)
    if (g.gameMode === 'story') drawGoal()
    for (const s of signs) drawSign(s)
    for (const t of tickets) if (!t.got) drawTicket(t)
    drawBird()
    if (g.state !== 'dead') drawPlayer()
    drawWall()
    drawParticles()
    ctx.restore()

    if (g.mode === 'poster') posterOverlay(); else filmOverlay()
    if (wall.active && g.state === 'play') {
      const d = pl.x - wall.x
      if (d < 320) {
        const a = Math.max(0, 1 - d / 320) * 0.4
        const grd = ctx.createLinearGradient(0, 0, 220, 0)
        grd.addColorStop(0, `rgba(140,20,10,${a})`)
        grd.addColorStop(1, 'rgba(140,20,10,0)')
        ctx.fillStyle = grd; ctx.fillRect(0, 0, 220, H)
      }
    }
    drawSubtitle()
    drawToast()
    drawTransition()
    drawPause()
  }

  function renderPosterBG(): void {
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H)
    const MTN = ['rgba(70,72,66,0.12)', 'rgba(74,112,96,0.17)', 'rgba(52,86,78,0.22)']
    for (let L = 0; L < 3; L++) {
      const par = 0.12 + L * 0.1, base = 300 + L * 55
      ctx.fillStyle = MTN[L]!
      ctx.beginPath(); ctx.moveTo(0, H)
      for (let x = 0; x <= W + 40; x += 40) {
        const wx = x + g.cam * par
        const y = base - Math.abs(Math.sin(wx * 0.0022 + L * 2.1)) * 130 - Math.sin(wx * 0.011 + L) * 18
        ctx.lineTo(x, y)
      }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill()
    }
    ctx.beginPath()
    for (let x = -20; x <= W + 20; x += 24) {
      const wx = x + g.cam * 0.5
      ctx.lineTo(x, 462 + Math.sin(wx * 0.0042) * 15 + Math.sin(wx * 0.013) * 4)
    }
    for (let x = W + 20; x >= -20; x -= 24) {
      const wx = x + g.cam * 0.5
      ctx.lineTo(x, 486 + Math.sin(wx * 0.0042 + 0.5) * 13)
    }
    ctx.closePath()
    ctx.fillStyle = 'rgba(84,134,116,0.30)'; ctx.fill()
    ctx.strokeStyle = 'rgba(50,72,64,0.25)'; ctx.lineWidth = 1.4; ctx.stroke()
    ctx.globalAlpha = 0.5
    ctx.fillStyle = '#d86a4a'
    ctx.beginPath(); ctx.arc(700 - (g.cam * 0.04) % 200, 95, 34, 0, 7); ctx.fill()
    ctx.globalAlpha = 1
    ctx.globalAlpha = 0.5
    if (paperTex) ctx.drawImage(paperTex, 0, 0, W, H)
    ctx.globalAlpha = 1
  }
  function drawPlatPoster(p: Plat): void {
    if (p.solid === 'film') {
      ctx.save()
      ctx.strokeStyle = 'rgba(120,110,90,0.75)'; ctx.lineWidth = 1.6
      ctx.setLineDash([7, 5])
      ctx.strokeRect(p.x, p.y, p.w, p.h)
      ctx.setLineDash([])
      ctx.strokeStyle = 'rgba(120,110,90,0.3)'
      ctx.beginPath()
      ctx.moveTo(p.x + 6, p.y + p.h - 3); ctx.lineTo(p.x + p.w * 0.4, p.y + 3)
      ctx.moveTo(p.x + p.w * 0.55, p.y + p.h - 3); ctx.lineTo(p.x + p.w - 6, p.y + 3)
      ctx.stroke()
      if (p.w >= 160) {
        ctx.fillStyle = 'rgba(120,110,90,0.8)'
        ctx.font = `13px ${KAI}`
        ctx.textAlign = 'center'
        ctx.fillText(LS().signs['painted'] ?? '', p.x + p.w / 2, p.y - 8)
      }
      ctx.restore()
      return
    }
    const rnd = mulberry(p.seed * 977)
    ctx.save()
    ctx.shadowColor = 'rgba(40,35,28,0.55)'; ctx.shadowBlur = 7
    ctx.fillStyle = '#2c2822'
    ctx.beginPath()
    ctx.moveTo(p.x, p.y + 3)
    for (let x = 0; x <= p.w; x += 22) ctx.lineTo(p.x + x, p.y + Math.sin(x * 0.4 + p.seed) * 2.4)
    ctx.lineTo(p.x + p.w + 3, p.y + p.h)
    ctx.lineTo(p.x - 2, p.y + p.h - 1)
    ctx.closePath(); ctx.fill()
    ctx.shadowBlur = 0
    ctx.globalAlpha = 0.16; ctx.fillStyle = PAPER
    for (let i = 0; i < 2; i++) {
      const fx = p.x + rnd() * p.w * 0.8, fw = 14 + rnd() * p.w * 0.16
      ctx.fillRect(fx, p.y + 4 + rnd() * (p.h - 8), fw, 1.6)
    }
    ctx.restore()
  }
  function drawSpikePoster(s: Spike): void {
    const rnd = mulberry(s.x)
    ctx.save()
    ctx.strokeStyle = 'rgba(64,76,96,0.55)'; ctx.lineWidth = 1.5
    for (let x = 6; x < s.w; x += 14) {
      const h = 10 + rnd() * 12, sw = Math.sin(g.time * 1.4 + x) * 2.5
      ctx.beginPath()
      ctx.moveTo(s.x + x, s.y + s.h)
      ctx.quadraticCurveTo(s.x + x + sw, s.y + s.h - h * 0.7, s.x + x + sw * 2, s.y + s.h - h)
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(90,110,150,0.5)'
    for (let x = 14; x < s.w; x += 34) ctx.fillRect(s.x + x, s.y + 4 + rnd() * 6, 2.6, 2.6)
    ctx.restore()
  }
  function posterOverlay(): void {
    const gr = ctx.createRadialGradient(W / 2, H / 2, H * 0.55, W / 2, H / 2, H * 0.95)
    gr.addColorStop(0, 'rgba(40,35,28,0)'); gr.addColorStop(1, 'rgba(40,35,28,0.14)')
    ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H)
    ctx.save()
    ctx.fillStyle = 'rgba(42,38,32,0.88)'
    ctx.font = `32px ${KAI}`
    ctx.textAlign = 'center'
    const chars = '牛来'
    for (let i = 0; i < chars.length; i++) ctx.fillText(chars[i]!, W - 30, 142 + i * 40)
    ctx.fillStyle = VERM
    ctx.fillRect(W - 41, 210, 22, 22)
    ctx.fillStyle = PAPER
    ctx.font = `14px ${KAI}`
    ctx.fillText('牛', W - 30, 226)
    ctx.restore()
  }

  function renderFilmBG(): void {
    const bands = ['#87a0b8', '#93abc1', '#a2b7ca', '#b3c4d4', '#c5d2de', '#d8e1e9']
    for (let i = 0; i < 6; i++) { ctx.fillStyle = bands[i]!; ctx.fillRect(0, i * 64, W, 64) }
    ctx.fillStyle = '#cfc4b0'; ctx.fillRect(0, 384, W, H - 384)
    ctx.strokeStyle = '#9a9184'; ctx.beginPath(); ctx.moveTo(0, 384.5); ctx.lineTo(W, 384.5); ctx.stroke()
    ctx.fillStyle = '#fdfdf6'; ctx.beginPath(); ctx.arc(730, 78, 26, 0, 7); ctx.fill()
    ctx.globalAlpha = 0.16
    for (let i = 1; i <= 4; i++) {
      ctx.fillStyle = i % 2 ? '#ffffff' : '#ffe9b0'
      ctx.beginPath(); ctx.arc(730 - i * 68, 78 + i * 42, 14 - i * 2, 0, 7); ctx.fill()
    }
    ctx.globalAlpha = 1
    for (let k = -1; k < 4; k++) {
      const bx = ((k * 420 - g.cam * 0.3) % (W + 840) + (W + 840)) % (W + 840) - 420
      ctx.fillStyle = k % 2 ? '#8b9198' : '#7d848c'
      ctx.beginPath()
      ctx.moveTo(bx, 384); ctx.lineTo(bx + 170, 205 + ((k % 3) + 3) % 3 * 30); ctx.lineTo(bx + 360, 384)
      ctx.closePath(); ctx.fill()
      ctx.strokeStyle = '#3a3d41'; ctx.stroke()
    }
    ctx.fillStyle = '#eceff2'
    for (let k = 0; k < 3; k++) {
      const cx = ((k * 340 + 120 - g.cam * 0.12) % (W + 300) + (W + 300)) % (W + 300) - 150
      ctx.fillRect(cx, 60 + k * 46, 92, 16); ctx.fillRect(cx + 18, 48 + k * 46, 54, 14)
    }
  }
  function box3(x: number, y: number, w: number, h: number, base: string, top: string, side: string): void {
    const dx = 7, dy = 6
    ctx.fillStyle = top
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + dx, y - dy); ctx.lineTo(x + w + dx, y - dy); ctx.lineTo(x + w, y); ctx.closePath(); ctx.fill()
    ctx.strokeStyle = '#26282b'; ctx.lineWidth = 1; ctx.stroke()
    ctx.fillStyle = side
    ctx.beginPath(); ctx.moveTo(x + w, y); ctx.lineTo(x + w + dx, y - dy); ctx.lineTo(x + w + dx, y + h - dy); ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.fill()
    ctx.stroke()
    ctx.fillStyle = base; ctx.fillRect(x, y, w, h)
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  }
  function drawPlatFilm(p: Plat): void {
    if (p.solid === 'film') box3(p.x, p.y, p.w, p.h, '#cdbfa8', '#e0d4bd', '#a8997f')
    else box3(p.x, p.y, p.w, p.h, '#9aa0a6', '#b4bac0', '#7c8288')
  }
  function drawSpikeFilm(s: Spike): void {
    for (let x = 0; x + 16 <= s.w + 2; x += 16) {
      ctx.fillStyle = (x / 16) % 3 === 2 ? '#767c83' : '#8f959b'
      ctx.beginPath()
      ctx.moveTo(s.x + x, s.y + s.h); ctx.lineTo(s.x + x + 8, s.y); ctx.lineTo(s.x + x + 16, s.y + s.h)
      ctx.closePath(); ctx.fill()
      ctx.strokeStyle = '#26282b'; ctx.stroke()
    }
  }
  function filmOverlay(): void {
    ctx.save()
    ctx.globalAlpha = 0.4
    ctx.fillStyle = '#555'
    ctx.font = `12px ${SONG}`
    ctx.textAlign = 'right'
    ctx.fillText(LS().signs['wm'] ?? '', W - 14, H - 12)
    ctx.restore()
  }

  function drawTicket(t: Ticket): void {
    const bob = Math.sin(g.time * 2.2 + t.bob) * 3
    if (g.mode === 'poster') {
      ctx.save()
      ctx.globalAlpha = 0.75
      ctx.strokeStyle = '#b8922e'; ctx.lineWidth = 1.6
      ctx.beginPath(); ctx.arc(t.x, t.y + bob, t.r, 0, 7); ctx.stroke()
      ctx.fillStyle = 'rgba(184,146,46,0.7)'
      ctx.font = `9px ${KAI}`; ctx.textAlign = 'center'
      ctx.fillText('票', t.x, t.y + bob + 3)
      ctx.restore()
    } else {
      ctx.fillStyle = '#ffd23a'
      ctx.beginPath(); ctx.arc(t.x, t.y + bob, t.r, 0, 7); ctx.fill()
      ctx.strokeStyle = '#26282b'; ctx.stroke()
      ctx.fillStyle = '#26282b'
      ctx.font = `bold 10px ${SONG}`; ctx.textAlign = 'center'
      ctx.fillText('¥', t.x, t.y + bob + 3.5)
    }
  }
  function drawSign(s: Sign): void {
    const text = LS().signs[s.key] ?? ''
    if (g.mode === 'poster') {
      ctx.save()
      ctx.fillStyle = 'rgba(74,68,56,0.92)'
      ctx.font = `15px ${KAI}`; ctx.textAlign = 'center'
      ctx.fillText(text, s.x, s.y)
      ctx.strokeStyle = 'rgba(74,68,56,0.4)'; ctx.lineWidth = 1
      const w = ctx.measureText(text).width
      ctx.beginPath(); ctx.moveTo(s.x - w / 2, s.y + 6); ctx.lineTo(s.x + w / 2, s.y + 6); ctx.stroke()
      ctx.restore()
    } else {
      ctx.save()
      ctx.font = `13px ${SONG}`; ctx.textAlign = 'center'
      const w = ctx.measureText(text).width + 18
      ctx.strokeStyle = '#5a5d61'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(s.x, s.y + 10); ctx.lineTo(s.x, 500); ctx.stroke()
      ctx.fillStyle = '#dcdcd6'
      ctx.fillRect(s.x - w / 2, s.y - 16, w, 24)
      ctx.strokeStyle = '#26282b'; ctx.lineWidth = 1
      ctx.strokeRect(s.x - w / 2 + 0.5, s.y - 15.5, w - 1, 23)
      ctx.fillStyle = '#26282b'
      ctx.fillText(text, s.x, s.y + 1)
      ctx.restore()
    }
  }
  function drawCP(c: CP): void {
    ctx.save()
    if (g.mode === 'poster') {
      ctx.strokeStyle = INK; ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x, c.y - 64); ctx.stroke()
      ctx.fillStyle = c.got ? VERM : 'rgba(42,38,32,0.55)'
      ctx.beginPath()
      ctx.moveTo(c.x, c.y - 64); ctx.lineTo(c.x + 34, c.y - 56); ctx.lineTo(c.x, c.y - 46)
      ctx.closePath(); ctx.fill()
      ctx.fillStyle = PAPER
      ctx.font = `11px ${KAI}`
      ctx.fillText('记', c.x + 8, c.y - 52)
    } else {
      ctx.strokeStyle = '#5a5d61'; ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x, c.y - 64); ctx.stroke()
      ctx.fillStyle = c.got ? '#ffd23a' : '#c8cbce'
      ctx.fillRect(c.x, c.y - 64, 34, 18)
      ctx.strokeStyle = '#26282b'; ctx.lineWidth = 1
      ctx.strokeRect(c.x + 0.5, c.y - 63.5, 33, 17)
      ctx.fillStyle = '#26282b'
      ctx.font = `11px ${SONG}`
      ctx.fillText('存', c.x + 11, c.y - 51)
    }
    ctx.restore()
  }
  function drawGoal(): void {
    const q = goal
    ctx.save()
    if (g.mode === 'poster') {
      ctx.strokeStyle = INK; ctx.lineWidth = 5
      ctx.beginPath()
      ctx.moveTo(q.x, q.y + q.h); ctx.lineTo(q.x, q.y + 14)
      ctx.moveTo(q.x + q.w, q.y + q.h); ctx.lineTo(q.x + q.w, q.y + 14)
      ctx.stroke()
      ctx.lineWidth = 7
      ctx.beginPath(); ctx.moveTo(q.x - 14, q.y + 14); ctx.lineTo(q.x + q.w + 14, q.y + 14); ctx.stroke()
      ctx.lineWidth = 4
      ctx.beginPath(); ctx.moveTo(q.x - 6, q.y + 26); ctx.lineTo(q.x + q.w + 6, q.y + 26); ctx.stroke()
      ctx.fillStyle = VERM; ctx.fillRect(q.x + q.w / 2 - 13, q.y + 44, 26, 26)
      ctx.fillStyle = PAPER; ctx.font = `16px ${KAI}`; ctx.textAlign = 'center'
      ctx.fillText('入', q.x + q.w / 2, q.y + 63)
      const glow = 0.25 + Math.sin(g.time * 2) * 0.1
      ctx.globalAlpha = glow; ctx.fillStyle = '#e8a63a'
      ctx.beginPath(); ctx.arc(q.x + q.w / 2, q.y + q.h / 2 + 10, 52, 0, 7); ctx.fill()
    } else {
      box3(q.x - 10, q.y - 20, q.w + 20, q.h + 20, '#b0a794', '#c9c0ad', '#8e8674')
      ctx.fillStyle = '#f5f5ef'
      ctx.fillRect(q.x, q.y - 8, q.w, 26)
      ctx.strokeStyle = '#26282b'; ctx.strokeRect(q.x + 0.5, q.y - 7.5, q.w - 1, 25)
      ctx.fillStyle = '#26282b'; ctx.font = `16px ${SONG}`; ctx.textAlign = 'center'
      ctx.fillText('影 院', q.x + q.w / 2, q.y + 10)
      ctx.fillStyle = '#3a3226'
      ctx.fillRect(q.x + q.w / 2 - 16, q.y + 46, 32, 54)
      ctx.strokeRect(q.x + q.w / 2 - 15.5, q.y + 46.5, 31, 53)
    }
    ctx.restore()
  }
  function drawBird(): void {
    const bx = bird.x, by = bird.y
    ctx.save()
    if (g.mode === 'poster') {
      const flap = Math.sin(bird.t * 9) * 0.9
      ctx.strokeStyle = '#c2512f'; ctx.lineWidth = 2.4; ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(bx - 14, by - flap * 8)
      ctx.quadraticCurveTo(bx - 5, by - 6 - flap * 5, bx, by)
      ctx.quadraticCurveTo(bx + 5, by - 6 + flap * 5, bx + 14, by + flap * 8)
      ctx.stroke()
      ctx.fillStyle = '#c0432a'
      ctx.beginPath(); ctx.ellipse(bx, by + 2, 5.5, 3.4, 0, 0, 7); ctx.fill()
      ctx.fillStyle = '#6b2015'
      ctx.beginPath(); ctx.arc(bx + 4.6, by - 0.5, 1.6, 0, 7); ctx.fill()
    } else {
      const up = pl.pose === 0
      ctx.fillStyle = '#9aa0a6'
      ctx.beginPath(); ctx.moveTo(bx - 9, by); ctx.lineTo(bx + 9, by - 4); ctx.lineTo(bx + 9, by + 4)
      ctx.closePath(); ctx.fill()
      ctx.strokeStyle = '#26282b'; ctx.stroke()
      ctx.fillStyle = '#b4bac0'
      ctx.beginPath()
      if (up) { ctx.moveTo(bx - 2, by - 2); ctx.lineTo(bx - 6, by - 14); ctx.lineTo(bx + 4, by - 3) }
      else { ctx.moveTo(bx - 2, by + 2); ctx.lineTo(bx - 6, by + 12); ctx.lineTo(bx + 4, by + 3) }
      ctx.closePath(); ctx.fill(); ctx.stroke()
      if (bird.state === 'follow' && bird.sayT > 0) {
        ctx.fillStyle = '#fff'; ctx.fillRect(bx + 12, by - 22, 34, 16)
        ctx.strokeRect(bx + 12.5, by - 21.5, 33, 15)
        ctx.fillStyle = '#26282b'; ctx.font = `10px ${SONG}`; ctx.textAlign = 'center'
        ctx.fillText('。。。', bx + 29, by - 10)
      }
    }
    ctx.restore()
  }
  function drawPlayer(): void {
    const px = g.mode === 'film' ? Math.round(pl.x / 2) * 2 : pl.x
    const py = g.mode === 'film' ? Math.round(pl.y / 2) * 2 : pl.y
    const cx = px + pl.w / 2, cy = py + pl.h / 2
    ctx.save()
    ctx.translate(cx, cy)
    ctx.scale(pl.face, 1)

    if (g.mode === 'poster') {
      const gliding = !pl.onGround
      ctx.rotate(gliding ? -0.12 : 0)
      const flut = Math.sin(pl.animT * 9) * 3 + (gliding ? 5 : 0)
      ctx.fillStyle = VERM
      ctx.beginPath()
      ctx.moveTo(8, -11)
      ctx.quadraticCurveTo(-8, -16 - flut, -22 - flut, -6 - flut * 0.8)
      ctx.quadraticCurveTo(-26 - flut * 1.3, 2 - flut * 0.4, -16 - flut * 0.6, 6)
      ctx.quadraticCurveTo(-4, 8, 8, -2)
      ctx.closePath(); ctx.fill()
      ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.lineCap = 'round'
      for (let i = 0; i < 4; i++) {
        const bxx = -10 + i * 7
        let ang: number
        if (gliding) ang = 2.6 + i * 0.12
        else if (Math.abs(pl.vx) > 20) ang = 1.57 + Math.sin(pl.animT * 14 + i * 1.7) * 0.5
        else ang = 1.57 + (i % 2 ? 0.06 : -0.06)
        ctx.beginPath()
        ctx.moveTo(bxx, 4)
        ctx.lineTo(bxx + Math.cos(ang) * 10, 4 + Math.sin(ang) * 10)
        ctx.stroke()
      }
      ctx.fillStyle = INK
      ctx.beginPath(); ctx.ellipse(-1, -1, 15, 9.5, gliding ? -0.08 : 0, 0, 7); ctx.fill()
      ctx.beginPath(); ctx.arc(13, -7, 7.5, 0, 7); ctx.fill()
      ctx.strokeStyle = INK; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(10, -13); ctx.quadraticCurveTo(9, -18, 5, -18); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(15, -13); ctx.quadraticCurveTo(16, -18, 20, -17); ctx.stroke()
      ctx.lineWidth = 2.2
      ctx.beginPath(); ctx.moveTo(-15, -3)
      ctx.quadraticCurveTo(-21, -6 + Math.sin(pl.animT * 8) * 3, -23, 1 + Math.sin(pl.animT * 8) * 2)
      ctx.stroke()
      ctx.fillStyle = VERM; ctx.fillRect(5, -10, 6, 6)
      ctx.fillStyle = PAPER
      ctx.beginPath(); ctx.arc(15.5, -8.5, 1.5, 0, 7); ctx.fill()
    } else {
      const moving = Math.abs(pl.vx) > 20
      const air = !pl.onGround
      const o = pl.pose ? 4 : -4
      const BODY = '#e0a13d', BODY_D = '#c08428', LINE = '#26282b'
      ctx.strokeStyle = LINE; ctx.lineWidth = 1
      ctx.fillStyle = '#c0392b'
      ctx.beginPath()
      ctx.moveTo(-8, -12)
      ctx.lineTo(-20 + o / 2, -8)
      ctx.lineTo(-20 + o / 2, 8)
      ctx.lineTo(-8, 2)
      ctx.closePath(); ctx.fill(); ctx.stroke()
      const armSw = air ? -8 : (moving ? -o : 0)
      ctx.fillStyle = BODY_D
      ctx.fillRect(-12 + armSw * 0.4, air ? -14 : -8, 5, 12)
      ctx.strokeRect(-11.5 + armSw * 0.4, (air ? -14 : -8) + 0.5, 4, 11)
      for (let i = 0; i < 2; i++) {
        const lx = i === 0 ? -7 : 1
        let dx2 = 0, lh = 12
        if (air) { dx2 = i === 0 ? -3 : 3; lh = 9 }
        else if (moving) dx2 = i === 0 ? o : -o
        ctx.fillStyle = BODY
        ctx.fillRect(lx + dx2, 2, 6, lh)
        ctx.strokeRect(lx + dx2 + 0.5, 2.5, 5, lh - 1)
      }
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(-11, -4); ctx.quadraticCurveTo(-16, -2 + o * 0.3, -15, 4); ctx.stroke()
      ctx.lineWidth = 1
      ctx.fillStyle = BODY
      ctx.fillRect(-12, -12, 22, 16)
      ctx.strokeRect(-11.5, -11.5, 21, 15)
      ctx.fillStyle = '#ecc989'
      ctx.fillRect(-6, -8, 12, 10)
      ctx.strokeRect(-5.5, -7.5, 11, 9)
      ctx.fillStyle = BODY
      ctx.fillRect(6 - armSw * 0.4, air ? -16 : -8, 5, 12)
      ctx.strokeRect(6.5 - armSw * 0.4, (air ? -16 : -8) + 0.5, 4, 11)
      ctx.fillStyle = BODY
      ctx.fillRect(0, -28, 21, 17)
      ctx.strokeRect(0.5, -27.5, 20, 16)
      ctx.beginPath(); ctx.moveTo(0, -24); ctx.lineTo(-6, -27); ctx.lineTo(0, -20); ctx.closePath(); ctx.fill(); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(21, -24); ctx.lineTo(27, -27); ctx.lineTo(21, -20); ctx.closePath(); ctx.fill(); ctx.stroke()
      ctx.fillStyle = '#cfc8b8'
      ctx.beginPath(); ctx.moveTo(3, -28); ctx.lineTo(1, -33); ctx.lineTo(7, -28); ctx.closePath(); ctx.fill(); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(14, -28); ctx.lineTo(18, -33); ctx.lineTo(18, -28); ctx.closePath(); ctx.fill(); ctx.stroke()
      ctx.fillStyle = '#e8ded2'
      ctx.fillRect(8, -19, 15, 9)
      ctx.strokeRect(8.5, -18.5, 14, 8)
      ctx.fillStyle = '#d8a8a0'
      ctx.fillRect(17, -17, 2, 2); ctx.fillRect(20, -17, 2, 2)
      ctx.fillStyle = LINE
      ctx.fillRect(9, -23, 2, 2); ctx.fillRect(15, -23, 2, 2)
      ctx.strokeStyle = '#3e4f63'; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(7, -25); ctx.lineTo(12, -26); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(14, -26); ctx.lineTo(19, -25); ctx.stroke()
    }
    ctx.restore()
  }
  function drawWall(): void {
    if (!wall.active) return
    const wl = g.cam - 60, wr = wall.x
    if (wr < wl) return
    ctx.save()
    if (g.mode === 'poster') {
      ctx.fillStyle = '#efe6d2'
      ctx.beginPath()
      ctx.moveTo(wr + 10, 0)
      for (let y = 0; y <= H; y += 26) ctx.lineTo(wr + 10 + Math.sin(y * 0.24 + g.time * 3.5) * 7, y)
      ctx.lineTo(wl, H); ctx.lineTo(wl, 0); ctx.closePath(); ctx.fill()
      ctx.fillStyle = '#17140f'
      ctx.beginPath()
      ctx.moveTo(wr, 0)
      for (let y = 0; y <= H; y += 26) ctx.lineTo(wr + Math.sin(y * 0.24 + g.time * 3.5) * 7, y)
      ctx.lineTo(wl, H); ctx.lineTo(wl, 0); ctx.closePath(); ctx.fill()
      ctx.strokeStyle = 'rgba(243,234,216,0.18)'; ctx.lineWidth = 2
      for (let i = 0; i < 4; i++) {
        const sy = 90 + i * 120, r = 24 + (i % 2) * 14
        ctx.beginPath(); ctx.arc(wr - 60 - i * 40, sy, r, g.time * 1.5 + i, g.time * 1.5 + i + 4.4); ctx.stroke()
      }
    } else {
      ctx.fillStyle = '#0c0c0e'
      ctx.fillRect(wl, 0, wr - wl, H)
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'
      for (let y = 0; y < H; y += 4) { ctx.beginPath(); ctx.moveTo(wl, y + 0.5); ctx.lineTo(wr, y + 0.5); ctx.stroke() }
      ctx.fillStyle = '#e8e8e8'
      ctx.font = `17px ${SONG}`; ctx.textAlign = 'center'
      const msg = LS().signs['canceled'] ?? ''
      for (let i = 0; i < msg.length; i++) ctx.fillText(msg[i]!, wr - 26, 150 + i * 26)
    }
    ctx.restore()
  }
  function drawParticles(): void {
    for (const p of particles) {
      const a = Math.max(0, p.life / p.max)
      ctx.save()
      ctx.globalAlpha = a
      if (p.type === 'ink') {
        ctx.fillStyle = INK
        ctx.beginPath(); ctx.arc(p.x, p.y, 3.5 * a, 0, 7); ctx.fill()
      } else if (p.type === 'gold') {
        ctx.fillStyle = '#e0b23a'
        ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3)
      } else if (p.type === 'burst') {
        ctx.fillStyle = p.col ?? INK
        ctx.beginPath(); ctx.arc(p.x, p.y, 3 + 2 * a, 0, 7); ctx.fill()
      } else {
        ctx.fillStyle = g.mode === 'poster' ? '#8a6a1e' : '#5a4a00'
        ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'
        ctx.fillText(p.txt ?? '', p.x, p.y)
      }
      ctx.restore()
    }
  }
  function drawSubtitle(): void {
    if (!g.sub || g.mode !== 'film' || g.state === 'end') return
    ctx.save()
    ctx.fillStyle = 'rgba(0,0,0,0.85)'
    ctx.fillRect(0, H - 46, W, 46)
    ctx.fillStyle = '#fff'
    ctx.font = `17px ${SONG}`
    ctx.textAlign = 'center'
    ctx.fillText(g.sub.line, W / 2, H - 17)
    ctx.restore()
  }
  function drawToast(): void {
    if (!g.toast) return
    ctx.save()
    ctx.globalAlpha = Math.min(1, g.toast.t / 0.5)
    ctx.translate(W / 2, 96); ctx.rotate(-0.03)
    ctx.font = `20px ${KAI}`; ctx.textAlign = 'center'
    const w = ctx.measureText(g.toast.text).width + 44
    ctx.fillStyle = VERM; ctx.fillRect(-w / 2, -24, w, 40)
    ctx.fillStyle = PAPER; ctx.fillText(g.toast.text, 0, 4)
    ctx.restore()
  }
  function drawTransition(): void {
    if (trans.t <= 0) return
    const p = 1 - trans.t
    const col = trans.to === 'poster' ? '#1c1a17' : '#8f959b'
    ctx.save()
    ctx.globalAlpha = Math.min(0.9, trans.t * 1.2)
    ctx.fillStyle = col
    for (const b of trans.blobs) {
      const d = b.spd * p
      ctx.beginPath()
      ctx.arc(trans.px + Math.cos(b.ang) * d, trans.py + Math.sin(b.ang) * d, b.r * (0.35 + p * 0.9), 0, 7)
      ctx.fill()
    }
    ctx.globalAlpha = trans.t * 0.22
    ctx.fillRect(0, 0, W, H)
    ctx.restore()
  }
  function drawPause(): void {
    if (g.state !== 'pause') return
    ctx.fillStyle = 'rgba(16,14,12,0.55)'; ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = PAPER; ctx.textAlign = 'center'
    ctx.font = `26px ${KAI}`
    ctx.fillText(LS().pauseTitle, W / 2, H / 2 - 8)
    ctx.font = `14px ${KAI}`
    ctx.fillText(LS().pauseHint, W / 2, H / 2 + 22)
  }

  /* ---------------- loop ---------------- */
  let last = performance.now()
  function frame(now: number): void {
    const dt = Math.min(1 / 30, (now - last) / 1000)
    last = now
    update(dt)
    render()
    requestAnimationFrame(frame)
  }
  updateHud()
  requestAnimationFrame(frame)

  return {
    applyLang,
    setJoint(j: JointInfo): void {
      lastJoint = j
      if (j.sum >= TARGET && !save.ach) { save.ach = true; opts.save({ ...save }) }
      if (g.state === 'end') renderJoint()
    },
    toast(text: string): void {
      g.toast = { text, t: 3 }
    },
  }
}
