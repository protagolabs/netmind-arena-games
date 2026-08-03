/**
 * Light Cycles author view (T2) — a full 3D renderer, running in the Arena
 * sandbox iframe. three.js is bundled into the view (the sandbox has no
 * network), fonts are system-stack, and everything renders from the frames
 * the platform posts in — this view drives no gameplay.
 *
 * Look: floating obsidian arena over a starfield — mirror floor (planar
 * reflection), trails as thin light-ribbon walls with a "hot head, cooling
 * tail" per-segment gradient, comet-orb riders with spark tails, gold rim,
 * fog + bloom. Crash = particle burst, flash and camera shake; game over =
 * slow overhead reveal of the finished trail painting.
 *
 * Frame-driven playback: each `render(state)` frame arrives via `onFrame`;
 * the view diffs it against the previous one — head moved → tween + extend
 * ribbon; new crashes → wreck FX; tick went backwards → replay restarted →
 * rebuild. A viewer joining MID-match gets a graceful cold start: existing
 * trail cells rise as uniform ember pillars (their order is unknowable from
 * one frame), and proper directional ribbons grow from the next move on.
 */
import * as THREE from 'three'
import { Reflector } from 'three/examples/jsm/objects/Reflector.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import { ARENA_THEME } from '@arena/game-sdk/theme'
import type { PlayerInfo } from '@arena/game-sdk'

interface CycleFrame {
  board?: { cols: number; rows: number; cells: number[][] }
  panels?: Array<{ type: string; text?: string }>
  tick?: number
  heads?: { x: number; y: number }[]
  committed?: [boolean, boolean]
  status?: 'playing' | 'over'
  winner?: string
  crashes?: { seat: number; x: number; y: number; cause: string }[]
}

const SEAT_COLORS = [0x35d6ff, 0xff9433] as const
const SEAT_COLORS_CSS = ['#35d6ff', '#ff9433'] as const
const WALL_BODY_COLORS = [0x0e7fb0, 0xc2600e] as const
const WALL_EDGE_COLORS = [0x1fb6f2, 0xff9430] as const
const GOLD = 0xd9a441
const VOID = 0x04050a
const FONT = `'Chakra Petch', ${ARENA_THEME.font}`

const WALL_H = 0.48
const HEAD_Y = 0.34
const AGE_WINDOW = 16
const EDGE_HOT = 1.7
const EDGE_FLOOR = 0.42
const BODY_HOT = 1.0
const BODY_FLOOR = 0.36
const WALL_RISE_MS = 320
const TWEEN_SEC = 0.24

let COLS = 13
let ROWS = 13
const cellToWorld = (x: number, y: number): [number, number] => [x - (COLS - 1) / 2, y - (ROWS - 1) / 2]

// ---------------------------------------------------------------------------
// particles
// ---------------------------------------------------------------------------

class SparkPool {
  points: THREE.Points
  private pos: Float32Array
  private vel: Float32Array
  private life: Float32Array
  private n: number
  private cursor = 0

  constructor(color: number, n: number, size: number) {
    this.n = n
    this.pos = new Float32Array(n * 3).fill(-999)
    this.vel = new Float32Array(n * 3)
    this.life = new Float32Array(n)
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    this.points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color,
        size,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    )
    this.points.frustumCulled = false
  }

  spawn(x: number, y: number, z: number, spread: number, up: number, count: number, lifeSec: number): void {
    for (let k = 0; k < count; k++) {
      const i = this.cursor
      this.cursor = (this.cursor + 1) % this.n
      this.pos[i * 3] = x
      this.pos[i * 3 + 1] = y
      this.pos[i * 3 + 2] = z
      this.vel[i * 3] = (Math.random() - 0.5) * spread
      this.vel[i * 3 + 1] = Math.random() * up
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * spread
      this.life[i] = lifeSec
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue
      this.life[i]! -= dt
      if (this.life[i]! <= 0) {
        this.pos[i * 3 + 1] = -999
        continue
      }
      this.pos[i * 3]! += this.vel[i * 3]! * dt
      this.pos[i * 3 + 1]! += this.vel[i * 3 + 1]! * dt
      this.pos[i * 3 + 2]! += this.vel[i * 3 + 2]! * dt
      this.vel[i * 3 + 1]! -= 2.2 * dt
    }
    ;(this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
  }
}

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

interface Rising {
  seat: 0 | 1
  index: number
  wx: number
  wz: number
  rotY: number
  born: number
}

class Stage {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  private composer: EffectComposer
  private bloom: UnrealBloomPass

  private wallBody: [THREE.InstancedMesh, THREE.InstancedMesh]
  private wallEdge: [THREE.InstancedMesh, THREE.InstancedMesh]
  private pillars: [THREE.InstancedMesh, THREE.InstancedMesh]
  private wallCount: [number, number] = [0, 0]
  private pillarCount: [number, number] = [0, 0]
  private rising: Rising[] = []

  private heads: [THREE.Group, THREE.Group]
  private headLights: [THREE.PointLight, THREE.PointLight]
  private tails: [SparkPool, SparkPool]
  private bursts: [SparkPool, SparkPool]
  private flash: THREE.PointLight

  private dummy = new THREE.Object3D()
  private tmpColor = new THREE.Color()
  private t = 0

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(VOID)
    this.scene.fog = new THREE.FogExp2(VOID, 0.02)
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300)
    this.camera.position.set(0, 9, 14)

    this.scene.add(new THREE.HemisphereLight(0x27324a, 0x05070c, 0.7))
    this.flash = new THREE.PointLight(0xffffff, 0, 20, 2)
    this.flash.position.set(0, 2, 0)
    this.scene.add(this.flash)

    const mirror = new Reflector(new THREE.PlaneGeometry(COLS + 0.4, ROWS + 0.4), {
      clipBias: 0.003,
      textureWidth: 512,
      textureHeight: 512,
      color: 0x353d4e,
    })
    mirror.rotateX(-Math.PI / 2)
    this.scene.add(mirror)

    const glassOverlay = new THREE.Mesh(
      new THREE.PlaneGeometry(COLS + 0.4, ROWS + 0.4),
      new THREE.MeshBasicMaterial({ color: 0x05070c, transparent: true, opacity: 0.86, depthWrite: false }),
    )
    glassOverlay.rotateX(-Math.PI / 2)
    glassOverlay.position.y = 0.005
    this.scene.add(glassOverlay)

    this.scene.add(this.buildGrid(), this.buildRim(), this.buildStars())

    const cap = COLS * ROWS
    const mkBody = (): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1.07, 1, 0.13),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }),
        cap,
      )
      m.count = 0
      m.frustumCulled = false
      this.scene.add(m)
      return m
    }
    this.wallBody = [mkBody(), mkBody()]

    const mkEdge = (): THREE.InstancedMesh => {
      const m = new THREE.InstancedMesh(
        new THREE.BoxGeometry(1.07, 0.045, 0.2),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
        cap,
      )
      m.count = 0
      m.frustumCulled = false
      this.scene.add(m)
      return m
    }
    this.wallEdge = [mkEdge(), mkEdge()]

    // ember pillars: mid-match cold-start backfill (trail order unknowable)
    const mkPillar = (seat: 0 | 1): THREE.InstancedMesh => {
      const mat = new THREE.MeshBasicMaterial({ color: WALL_BODY_COLORS[seat], transparent: true, opacity: 0.5 })
      const m = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, WALL_H * 0.7, 0.46), mat, cap)
      m.count = 0
      m.frustumCulled = false
      this.scene.add(m)
      return m
    }
    this.pillars = [mkPillar(0), mkPillar(1)]

    const mkHead = (seat: 0 | 1): THREE.Group => {
      const g = new THREE.Group()
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 24), new THREE.MeshBasicMaterial({ color: 0xffffff }))
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(0.3, 24, 24),
        new THREE.MeshBasicMaterial({
          color: SEAT_COLORS[seat],
          transparent: true,
          opacity: 0.4,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      )
      g.add(core, shell)
      g.position.y = HEAD_Y
      this.scene.add(g)
      return g
    }
    this.heads = [mkHead(0), mkHead(1)]

    const mkLight = (seat: 0 | 1): THREE.PointLight => {
      const l = new THREE.PointLight(SEAT_COLORS[seat], 6, 8, 2)
      l.position.y = 0.6
      this.heads[seat].add(l)
      return l
    }
    this.headLights = [mkLight(0), mkLight(1)]

    this.tails = [new SparkPool(SEAT_COLORS[0], 220, 0.065), new SparkPool(SEAT_COLORS[1], 220, 0.065)]
    this.bursts = [new SparkPool(SEAT_COLORS[0], 380, 0.09), new SparkPool(SEAT_COLORS[1], 380, 0.09)]
    for (const p of [...this.tails, ...this.bursts]) this.scene.add(p.points)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(640, 480), 0.6, 0.45, 0.62)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
  }

  private buildGrid(): THREE.LineSegments {
    const pts: number[] = []
    const half = COLS / 2
    for (let i = 0; i <= COLS; i++) {
      pts.push(i - half, 0.012, -half, i - half, 0.012, half)
      pts.push(-half, 0.012, i - half, half, 0.012, i - half)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x35507a, transparent: true, opacity: 0.5 }))
  }

  private buildRim(): THREE.Group {
    const g = new THREE.Group()
    const mat = new THREE.MeshBasicMaterial({ color: GOLD })
    mat.color.multiplyScalar(0.55)
    const long = new THREE.BoxGeometry(COLS + 0.55, 0.07, 0.09)
    const side = new THREE.BoxGeometry(0.09, 0.07, ROWS + 0.55)
    const half = COLS / 2 + 0.23
    for (const [geo, x, z] of [
      [long, 0, -half],
      [long, 0, half],
      [side, -half, 0],
      [side, half, 0],
    ] as const) {
      const m = new THREE.Mesh(geo, mat)
      m.position.set(x, 0.05, z)
      g.add(m)
    }
    return g
  }

  private buildStars(): THREE.Points {
    const n = 700
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const r = 45 + Math.random() * 70
      const theta = Math.random() * Math.PI * 2
      const phi = Math.acos(Math.random() * 1.6 - 0.6)
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta)
      pos[i * 3 + 1] = Math.abs(r * Math.cos(phi)) - 6
      pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        color: 0xaec6ff,
        size: 0.55,
        transparent: true,
        opacity: 0.75,
        sizeAttenuation: true,
        depthWrite: false,
        fog: false,
      }),
    )
  }

  clearTrails(): void {
    this.wallCount = [0, 0]
    this.pillarCount = [0, 0]
    this.rising = []
    for (const m of [...this.wallBody, ...this.wallEdge, ...this.pillars]) {
      m.count = 0
      m.instanceMatrix.needsUpdate = true
    }
  }

  showHead(seat: 0 | 1, visible: boolean): void {
    this.heads[seat].visible = visible
    this.headLights[seat].intensity = visible ? 6 : 0
  }

  setHead(seat: 0 | 1, wx: number, wz: number): void {
    this.heads[seat].position.x = wx
    this.heads[seat].position.z = wz
  }

  headWorld(seat: 0 | 1): THREE.Vector3 {
    return this.heads[seat].position.clone()
  }

  addSegment(seat: 0 | 1, from: { x: number; y: number }, to: { x: number; y: number }): void {
    const [ax, az] = cellToWorld(from.x, from.y)
    const [bx, bz] = cellToWorld(to.x, to.y)
    const wx = (ax + bx) / 2
    const wz = (az + bz) / 2
    const rotY = Math.abs(bx - ax) > Math.abs(bz - az) ? 0 : Math.PI / 2
    const index = this.wallCount[seat]!
    this.wallCount[seat] = index + 1
    this.rising.push({ seat, index, wx, wz, rotY, born: this.t })
    this.wallBody[seat].count = this.wallCount[seat]!
    this.wallEdge[seat].count = this.wallCount[seat]!
    this.placeWall(seat, index, wx, wz, rotY, 0.02)
    this.restyleAges(seat)
  }

  /** Cold-start backfill: one ember pillar per already-painted trail cell. */
  addPillar(seat: 0 | 1, x: number, y: number): void {
    const [wx, wz] = cellToWorld(x, y)
    const index = this.pillarCount[seat]!
    this.pillarCount[seat] = index + 1
    this.dummy.rotation.set(0, 0, 0)
    this.dummy.position.set(wx, (WALL_H * 0.7) / 2, wz)
    this.dummy.scale.set(1, 1, 1)
    this.dummy.updateMatrix()
    this.pillars[seat].setMatrixAt(index, this.dummy.matrix)
    this.pillars[seat].count = this.pillarCount[seat]!
    this.pillars[seat].instanceMatrix.needsUpdate = true
  }

  private placeWall(seat: 0 | 1, index: number, wx: number, wz: number, rotY: number, h01: number): void {
    const h = Math.max(0.02, h01) * WALL_H
    this.dummy.rotation.set(0, rotY, 0)
    this.dummy.position.set(wx, h / 2, wz)
    this.dummy.scale.set(1, h, 1)
    this.dummy.updateMatrix()
    this.wallBody[seat].setMatrixAt(index, this.dummy.matrix)
    this.dummy.position.y = h + 0.02
    this.dummy.scale.set(1, 1, 1)
    this.dummy.updateMatrix()
    this.wallEdge[seat].setMatrixAt(index, this.dummy.matrix)
    this.wallBody[seat].instanceMatrix.needsUpdate = true
    this.wallEdge[seat].instanceMatrix.needsUpdate = true
  }

  private restyleAges(seat: 0 | 1): void {
    const count = this.wallCount[seat]!
    const from = Math.max(0, count - AGE_WINDOW - 1)
    for (let i = from; i < count; i++) {
      const age = count - 1 - i
      const k = Math.pow(0.9, age)
      this.tmpColor.setHex(WALL_EDGE_COLORS[seat]).multiplyScalar(Math.max(EDGE_FLOOR, EDGE_HOT * k))
      this.wallEdge[seat].setColorAt(i, this.tmpColor)
      this.tmpColor.setHex(WALL_BODY_COLORS[seat]).multiplyScalar(Math.max(BODY_FLOOR, BODY_HOT * k))
      this.wallBody[seat].setColorAt(i, this.tmpColor)
    }
    this.wallEdge[seat].instanceColor!.needsUpdate = true
    this.wallBody[seat].instanceColor!.needsUpdate = true
  }

  crash(seat: 0 | 1, at: THREE.Vector3): void {
    this.bursts[seat].spawn(at.x, at.y, at.z, 7.5, 4.5, 220, 1.1)
    this.bursts[(seat ^ 1) as 0 | 1].spawn(at.x, at.y, at.z, 3.5, 2.2, 40, 0.7)
    this.flash.position.set(at.x, 1.2, at.z)
    this.flash.intensity = 40
    this.showHead(seat, false)
  }

  emitTail(seat: 0 | 1): void {
    if (!this.heads[seat].visible) return
    const p = this.heads[seat].position
    this.tails[seat].spawn(p.x, p.y - 0.05, p.z, 0.9, 0.7, 2, 0.55)
  }

  update(dt: number): void {
    this.t += dt
    for (let i = this.rising.length - 1; i >= 0; i--) {
      const r = this.rising[i]!
      const k = Math.min(1, ((this.t - r.born) * 1000) / WALL_RISE_MS)
      this.placeWall(r.seat, r.index, r.wx, r.wz, r.rotY, 1 - Math.pow(1 - k, 3))
      if (k >= 1) this.rising.splice(i, 1)
    }
    for (const seat of [0, 1] as const) {
      const shell = this.heads[seat].children[1] as THREE.Mesh
      shell.scale.setScalar(1 + Math.sin(this.t * 7 + seat * 2) * 0.12)
      this.heads[seat].position.y = HEAD_Y + Math.sin(this.t * 3.1 + seat) * 0.02
    }
    this.flash.intensity = Math.max(0, this.flash.intensity - dt * 120)
    for (const p of [...this.tails, ...this.bursts]) p.update(dt)
  }

  render(): void {
    this.composer.render()
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
    this.composer.setSize(w, h)
    this.bloom.setSize(w, h)
  }
}

// ---------------------------------------------------------------------------
// HUD (ported from the 2D view: identity chips, LOCKED/WINNER, status line)
// ---------------------------------------------------------------------------

let players: PlayerInfo[] = []
let lastFrame: CycleFrame | null = null

let header: HTMLDivElement | null = null
let canvas: HTMLCanvasElement | null = null
let statusEl: HTMLDivElement | null = null
let stage: Stage | null = null

let domReady = false

function ensureDom(root: HTMLElement): void {
  if (domReady) return
  domReady = true
  root.innerHTML = ''
  const wrap = document.createElement('div')
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px'
  header = document.createElement('div')
  header.style.cssText = `display:flex;gap:24px;align-items:center;justify-content:center;min-height:40px;font:13px ${FONT};color:${ARENA_THEME.fg}`
  canvas = document.createElement('canvas')
  canvas.style.cssText = 'width:100%;border-radius:12px;display:block'
  statusEl = document.createElement('div')
  statusEl.style.cssText = `font:12px ${FONT};letter-spacing:.14em;color:${ARENA_THEME.fgSubtle}`
  wrap.appendChild(header)
  wrap.appendChild(canvas)
  wrap.appendChild(statusEl)
  root.appendChild(wrap)

  // Graceful fallback when the iframe has no WebGL context: keep the HUD
  // (chips + status line still narrate the match) and say why there's no 3D.
  try {
    stage = new Stage(canvas)
  } catch {
    canvas.remove()
    canvas = null
    const fallback = document.createElement('div')
    fallback.textContent = '3D view unavailable (WebGL is disabled in this browser)'
    fallback.style.cssText = `font:12px ${FONT};letter-spacing:.1em;color:${ARENA_THEME.fgSubtle};padding:48px 16px`
    wrap.insertBefore(fallback, statusEl)
    return
  }
  const fit = (): void => {
    const w = Math.max(320, wrap.clientWidth - 16)
    const h = Math.round(Math.min(Math.max(w * 0.68, 300), 620))
    canvas!.style.height = `${h}px`
    stage!.resize(w, h)
  }
  fit()
  new ResizeObserver(fit).observe(wrap)
  requestAnimationFrame(loop)
}

function initialBadge(seat: number, name: string): HTMLSpanElement {
  const el = document.createElement('span')
  el.textContent = (name || ['Blue', 'Red'][seat] || '?').slice(0, 1).toUpperCase()
  el.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:50%;background:${SEAT_COLORS_CSS[seat]}26;border:1px solid ${SEAT_COLORS_CSS[seat]};color:${SEAT_COLORS_CSS[seat]};font:600 12px ${FONT}`
  return el
}

let chipSlots: Array<{ lock: HTMLSpanElement; crown: HTMLSpanElement } | null> = [null, null]
let playersKey: string | null = null

function seatChip(seat: number): HTMLDivElement {
  const info = players.find((p) => p.seat === seat)
  const name = info?.name ?? ['Blue', 'Red'][seat] ?? `Seat ${seat}`
  const chip = document.createElement('div')
  chip.style.cssText = 'display:flex;align-items:center;gap:8px'
  const swatch = document.createElement('span')
  swatch.style.cssText = `width:12px;height:12px;border-radius:3px;background:${SEAT_COLORS_CSS[seat]};box-shadow:0 0 12px ${SEAT_COLORS_CSS[seat]}`
  chip.appendChild(swatch)
  if (info?.avatar) {
    const img = document.createElement('img')
    img.src = info.avatar
    img.alt = ''
    img.style.cssText = `width:24px;height:24px;border-radius:50%;background:${ARENA_THEME.surface}`
    img.onerror = () => img.replaceWith(initialBadge(seat, name))
    chip.appendChild(img)
  } else {
    chip.appendChild(initialBadge(seat, name))
  }
  const label = document.createElement('span')
  label.textContent = name
  label.style.cssText = 'letter-spacing:.08em'
  chip.appendChild(label)
  const lock = document.createElement('span')
  lock.textContent = 'LOCKED'
  lock.style.cssText = `display:none;font-size:10px;letter-spacing:1px;padding:2px 6px;border-radius:4px;border:1px solid ${ARENA_THEME.border};color:${ARENA_THEME.fgSubtle}`
  chip.appendChild(lock)
  const crown = document.createElement('span')
  crown.textContent = 'WINNER'
  crown.style.cssText = `display:none;font-size:10px;letter-spacing:1px;padding:2px 6px;border-radius:4px;background:${ARENA_THEME.accent};color:${ARENA_THEME.accentFg}`
  chip.appendChild(crown)
  chipSlots[seat] = { lock, crown }
  return chip
}

function ensureHeader(): void {
  if (!header) return
  const key = JSON.stringify(players.map((p) => [p.seat, p.agentId, p.name, p.avatar ?? '']))
  if (key === playersKey) return
  playersKey = key
  header.innerHTML = ''
  chipSlots = [null, null]
  header.appendChild(seatChip(0))
  const vs = document.createElement('span')
  vs.textContent = 'vs'
  vs.style.color = ARENA_THEME.fgSubtle
  header.appendChild(vs)
  header.appendChild(seatChip(1))
}

function updateBadges(): void {
  for (const seat of [0, 1] as const) {
    const slot = chipSlots[seat]
    if (!slot) continue
    const playing = lastFrame?.status === 'playing'
    slot.lock.style.display = playing && lastFrame?.committed?.[seat] === true ? '' : 'none'
    const info = players.find((p) => p.seat === seat)
    const won = lastFrame?.status === 'over' && lastFrame.winner !== undefined && info?.agentId === lastFrame.winner
    slot.crown.style.display = won ? '' : 'none'
  }
}

// ---------------------------------------------------------------------------
// frame-driven playback
// ---------------------------------------------------------------------------

interface Tween {
  seat: 0 | 1
  from: { x: number; y: number }
  to: { x: number; y: number }
  t: number
}

let prevHeads: [{ x: number; y: number }, { x: number; y: number }] | null = null
let prevTick = -1
let prevCrashCount = 0
let dead: [boolean, boolean] = [false, false]
let tweens: Tween[] = []
let shake = 0
let overSince = -1

function clampCell(v: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.max(-0.55, Math.min(COLS - 0.45, v.x)), y: Math.max(-0.55, Math.min(ROWS - 0.45, v.y)) }
}

/** Rebuild the whole stage from one frame (first frame, or replay restart). */
function rebuild(f: CycleFrame): void {
  if (!stage) return
  stage.clearTrails()
  tweens = []
  dead = [false, false]
  overSince = -1
  const cells = f.board?.cells ?? []
  for (let y = 0; y < cells.length; y++) {
    for (let x = 0; x < (cells[y]?.length ?? 0); x++) {
      const code = cells[y]![x]!
      // trail codes 1/2 (head cells are 3/4 — the orb marks those)
      if (code === 1 || code === 2) stage.addPillar((code - 1) as 0 | 1, x, y)
    }
  }
  for (const seat of [0, 1] as const) {
    const h = f.heads?.[seat]
    if (!h) continue
    const [wx, wz] = cellToWorld(h.x, h.y)
    stage.setHead(seat, wx, wz)
    stage.showHead(seat, true)
  }
  for (const c of f.crashes ?? []) {
    dead[c.seat as 0 | 1] = true
    stage.showHead(c.seat as 0 | 1, false)
  }
  prevCrashCount = f.crashes?.length ?? 0
  if (f.status === 'over') overSince = perfNow()
}

function applyFrame(f: CycleFrame): void {
  if (!stage) return
  if (f.board) {
    COLS = f.board.cols
    ROWS = f.board.rows
  }
  const tick = f.tick ?? 0

  if (prevTick < 0 || tick < prevTick) {
    rebuild(f)
  } else if (tick > prevTick && prevHeads) {
    // resolution frame: extend ribbons along each surviving rider's move
    for (const seat of [0, 1] as const) {
      const h = f.heads?.[seat]
      if (!h || dead[seat]) continue
      const moved = h.x !== prevHeads[seat].x || h.y !== prevHeads[seat].y
      if (moved) {
        stage.addSegment(seat, prevHeads[seat], h)
        tweens.push({ seat, from: prevHeads[seat], to: h, t: 0 })
      }
    }
    // new crashes this frame: wreck FX at the attempted cell
    const crashes = f.crashes ?? []
    for (let i = prevCrashCount; i < crashes.length; i++) {
      const c = crashes[i]!
      const seat = c.seat as 0 | 1
      dead[seat] = true
      const at = clampCell({ x: c.x, y: c.y })
      const [wx, wz] = cellToWorld(at.x, at.y)
      // ride most of the way into the lethal cell, then burst
      if (prevHeads) tweens.push({ seat, from: prevHeads[seat], to: { x: at.x, y: at.y }, t: 0 })
      stage.crash(seat, new THREE.Vector3(wx, 0.4, wz))
      shake = 0.55
    }
    prevCrashCount = crashes.length
    if (f.status === 'over' && overSince < 0) overSince = perfNow()
  }

  prevHeads = [
    { x: f.heads?.[0]?.x ?? 0, y: f.heads?.[0]?.y ?? 0 },
    { x: f.heads?.[1]?.x ?? 0, y: f.heads?.[1]?.y ?? 0 },
  ]
  prevTick = tick

  ensureHeader()
  updateBadges()
  if (statusEl) statusEl.textContent = f.panels?.find((p) => p.type === 'status')?.text ?? ''
}

// ---------------------------------------------------------------------------
// render loop + camera
// ---------------------------------------------------------------------------

const perfNow = (): number => performance.now() / 1000

let azimuth = 0.9
const camPos = new THREE.Vector3(0, 10, 15)
const camFocus = new THREE.Vector3(0, 0.4, 0)
let fovCur = 50
let lastT = -1

function loop(): void {
  requestAnimationFrame(loop)
  if (!stage) return
  const now = perfNow()
  const dt = lastT < 0 ? 0.016 : Math.min(0.05, now - lastT)
  lastT = now

  // head tweens
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]!
    tw.t += dt / TWEEN_SEC
    const k = Math.min(1, tw.t)
    const cap = dead[tw.seat] ? 0.72 : 1
    const f = Math.min(k, cap)
    const x = tw.from.x + (tw.to.x - tw.from.x) * f
    const y = tw.from.y + (tw.to.y - tw.from.y) * f
    const [wx, wz] = cellToWorld(x, y)
    stage.setHead(tw.seat, wx, wz)
    if (!dead[tw.seat]) stage.emitTail(tw.seat)
    if (k >= 1) tweens.splice(i, 1)
  }

  // camera: orbit + follow midpoint, rise with board fill, overhead when over
  const p0 = stage.headWorld(0)
  const p1 = stage.headWorld(1)
  const mid = p0.clone().add(p1).multiplyScalar(0.5)
  const dist = p0.distanceTo(p1)
  const fill = Math.min(1, Math.max(prevTick, 0) / 60)

  let focus = mid
  let radius = 9.5 + dist * 0.5 + fill * 2.5
  let height = 5.6 + dist * 0.28 + fill * 5
  let fovTarget = dist < 4 ? 43 : 50
  let orbitSpeed = 0.06

  if (overSince >= 0) {
    const k = Math.min(1, (perfNow() - overSince) / 2.4)
    const e = 1 - Math.pow(1 - k, 3)
    focus = new THREE.Vector3(0, 0, 0)
    radius = 7 + e * 1.5
    height = 4.5 + e * 11.5
    fovTarget = 46
    orbitSpeed = 0.045
  }

  azimuth += orbitSpeed * dt
  const desired = new THREE.Vector3(focus.x + Math.cos(azimuth) * radius, height, focus.z + Math.sin(azimuth) * radius)
  camPos.lerp(desired, 1 - Math.exp(-dt * 2.4))
  camFocus.lerp(focus, 1 - Math.exp(-dt * 3.2))
  fovCur += (fovTarget - fovCur) * (1 - Math.exp(-dt * 3))

  shake = Math.max(0, shake - dt * 0.9)
  const sx = (Math.random() - 0.5) * shake * 0.5
  const sy = (Math.random() - 0.5) * shake * 0.35
  stage.camera.position.set(camPos.x + sx, camPos.y + sy, camPos.z + sx)
  stage.camera.lookAt(camFocus)
  stage.camera.fov = fovCur
  stage.camera.updateProjectionMatrix()

  stage.update(dt)
  stage.render()
}

// ---------------------------------------------------------------------------
// wire the view contract
// ---------------------------------------------------------------------------

onPlayers((p) => {
  players = p
  ensureHeader()
  updateBadges()
})

onFrame((frame, root) => {
  ensureDom(root)
  lastFrame = frame as CycleFrame
  applyFrame(lastFrame)
})
