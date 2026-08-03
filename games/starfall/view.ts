/**
 * Starfall author view (T2) — a 3D starmap renderer for the Arena sandbox.
 * three.js is bundled (the sandbox has no network); fonts are system-stack;
 * WebGLRenderer construction is wrapped so WebGL-less sandboxes fall back to
 * the HUD narration instead of throwing (same pattern as light-cycles).
 *
 * Look: deep-space void with layered starfields and soft nebulae; stars as
 * glowing spheres sized by production and tinted by their empire, garrison
 * count on a floating label; fleets as comet swarms sliding along their
 * lanes; captures bloom a shockwave ring in the conqueror's colour.
 *
 * Frame-driven: the platform posts `render(state)` frames; the view diffs
 * consecutive frames — fleet progress interpolates smoothly, ownership flips
 * flash + recolour, tick regression (replay restart) rebuilds the scene.
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { onFrame, onPlayers } from '@arena/game-sdk/view'
import { ARENA_THEME } from '@arena/game-sdk/theme'
import type { PlayerInfo } from '@arena/game-sdk'

interface FramePlanet {
  id: number
  x: number
  y: number
  prod: number
  owner: number
  ships: number
  home: boolean
}
interface FrameFleet {
  id: number
  owner: number
  ships: number
  sx: number
  sy: number
  tx: number
  ty: number
  progress: number
}
interface FrameEvent {
  tick: number
  planetId: number
  kind: 'capture' | 'repelled' | 'reinforced'
  attacker: number
  ships: number
}
interface StarFrame {
  panels?: Array<{ type: string; text?: string }>
  field?: number
  tick?: number
  maxTicks?: number
  planets?: FramePlanet[]
  fleets?: FrameFleet[]
  committed?: boolean[]
  status?: 'playing' | 'over'
  winnerSeat?: number | null
  empires?: number[]
  events?: FrameEvent[]
}

const SEAT_COLORS = [0x35d6ff, 0xff9433, 0xb46bff, 0x45e08c] as const
const SEAT_COLORS_CSS = ['#35d6ff', '#ff9433', '#b46bff', '#45e08c'] as const
const NEUTRAL = 0x5b6a85
const VOID = 0x030408
const FONT = ARENA_THEME.font

const worldOf = (fx: number, fy: number, field: number): [number, number] => [fx - field / 2, fy - field / 2]

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function radialSprite(color: string, inner = 0.2): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32)
  grad.addColorStop(0, color)
  grad.addColorStop(inner, color)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  const t = new THREE.CanvasTexture(c)
  return t
}

function labelTexture(text: string, color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 128
  c.height = 48
  const g = c.getContext('2d')!
  g.clearRect(0, 0, 128, 48)
  g.font = `700 26px ${FONT}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.shadowColor = color
  g.shadowBlur = 10
  g.fillStyle = '#eef2fa'
  g.fillText(text, 64, 24)
  const t = new THREE.CanvasTexture(c)
  return t
}

class Shockwave {
  mesh: THREE.Mesh
  age = 0
  constructor(color: number, x: number, z: number) {
    this.mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.7, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    )
    this.mesh.rotation.x = -Math.PI / 2
    this.mesh.position.set(x, 0.4, z)
  }
  /** @returns false when spent */
  update(dt: number): boolean {
    this.age += dt
    const k = this.age / 1.1
    this.mesh.scale.setScalar(1 + k * 9)
    ;(this.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k))
    return k < 1
  }
}

// ---------------------------------------------------------------------------
// stage
// ---------------------------------------------------------------------------

interface PlanetNode {
  group: THREE.Group
  sphere: THREE.Mesh
  halo: THREE.Sprite
  ring: THREE.Mesh
  label: THREE.Sprite
  labelText: string
  owner: number
}

class Stage {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private planetNodes = new Map<number, PlanetNode>()
  private fleetNodes = new Map<number, { group: THREE.Group; from: THREE.Vector3; to: THREE.Vector3; shown: number; target: number }>()
  private waves: Shockwave[] = []
  private fleetTex: THREE.Texture
  private t = 0
  field = 100

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(VOID)
    this.scene.fog = new THREE.FogExp2(VOID, 0.004)
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 600)

    this.scene.add(new THREE.HemisphereLight(0x2c3a55, 0x05070c, 0.9))
    const key = new THREE.DirectionalLight(0xbfd4ff, 1.1)
    key.position.set(60, 90, 40)
    this.scene.add(key)

    this.scene.add(this.stars(900, 160, 320, 0.9, 0xaec6ff))
    this.scene.add(this.stars(500, 90, 150, 0.55, 0x7f95c9))
    this.nebulae()
    this.fleetTex = radialSprite('rgba(255,255,255,1)', 0.25)

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(640, 480), 0.75, 0.45, 0.55)
    this.composer.addPass(this.bloom)
    this.composer.addPass(new OutputPass())
  }

  private stars(n: number, rMin: number, rMax: number, size: number, color: number): THREE.Points {
    const pos = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      const r = rMin + Math.random() * (rMax - rMin)
      const th = Math.random() * Math.PI * 2
      const ph = Math.acos(Math.random() * 2 - 1)
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th)
      pos[i * 3 + 1] = r * Math.cos(ph) * 0.6
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    return new THREE.Points(
      geo,
      new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.8, depthWrite: false, fog: false }),
    )
  }

  private nebulae(): void {
    const tints = ['rgba(64,110,255,0.16)', 'rgba(168,80,255,0.13)', 'rgba(40,200,255,0.10)']
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: radialSprite(tints[i]!, 0.05), transparent: true, depthWrite: false }),
      )
      sp.scale.setScalar(180 + i * 60)
      sp.position.set((i - 1) * 70, -30 + i * 22, -120 - i * 40)
      this.scene.add(sp)
    }
  }

  reset(): void {
    for (const n of this.planetNodes.values()) this.scene.remove(n.group)
    for (const f of this.fleetNodes.values()) this.scene.remove(f.group)
    for (const w of this.waves) this.scene.remove(w.mesh)
    this.planetNodes.clear()
    this.fleetNodes.clear()
    this.waves = []
  }

  private colorOf(owner: number): number {
    return owner >= 0 ? SEAT_COLORS[owner % 4]! : NEUTRAL
  }

  syncPlanet(p: FramePlanet): void {
    const [wx, wz] = worldOf(p.x, p.y, this.field)
    let node = this.planetNodes.get(p.id)
    if (!node) {
      const group = new THREE.Group()
      const r = 1.15 + p.prod * 0.45
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(r, 32, 32),
        new THREE.MeshStandardMaterial({ color: 0x101a2c, roughness: 0.45, metalness: 0.1, emissive: 0x0a1220, emissiveIntensity: 1.0 }),
      )
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialSprite('rgba(255,255,255,0.9)', 0.1), transparent: true, opacity: 0.32, depthWrite: false }))
      halo.scale.setScalar(r * 6.2)
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(r + 0.75, 0.07, 12, 64),
        new THREE.MeshBasicMaterial({ color: NEUTRAL, transparent: true, opacity: 0.85 }),
      )
      ring.rotation.x = Math.PI / 2
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTexture('0', '#5b6a85'), transparent: true, depthWrite: false }))
      label.scale.set(6.5, 2.5, 1)
      label.position.y = r + 2.4
      group.add(sphere, halo, ring, label)
      if (p.home) {
        const crown = new THREE.Mesh(
          new THREE.TorusGeometry(r + 1.5, 0.045, 10, 64),
          new THREE.MeshBasicMaterial({ color: 0xd9a441, transparent: true, opacity: 0.5 }),
        )
        crown.rotation.x = Math.PI / 2
        group.add(crown)
      }
      group.position.set(wx, 0, wz)
      this.scene.add(group)
      node = { group, sphere, halo, ring, label, labelText: '', owner: -99 }
      this.planetNodes.set(p.id, node)
    }
    const color = this.colorOf(p.owner)
    if (node.owner !== p.owner) {
      node.owner = p.owner
      const mat = node.sphere.material as THREE.MeshStandardMaterial
      mat.emissive.setHex(color)
      mat.emissive.multiplyScalar(p.owner >= 0 ? 0.85 : 0.3)
      ;(node.ring.material as THREE.MeshBasicMaterial).color.setHex(color)
      const halo = node.halo.material as THREE.SpriteMaterial
      halo.color.setHex(color)
      halo.opacity = p.owner >= 0 ? 0.45 : 0.2
    }
    const text = String(p.ships)
    if (node.labelText !== text) {
      node.labelText = text
      const css = p.owner >= 0 ? SEAT_COLORS_CSS[p.owner % 4]! : '#5b6a85'
      ;(node.label.material as THREE.SpriteMaterial).map?.dispose()
      ;(node.label.material as THREE.SpriteMaterial).map = labelTexture(text, css)
      ;(node.label.material as THREE.SpriteMaterial).needsUpdate = true
    }
  }

  syncFleets(fleets: FrameFleet[]): void {
    const seen = new Set<number>()
    for (const f of fleets) {
      seen.add(f.id)
      let node = this.fleetNodes.get(f.id)
      if (!node) {
        const group = new THREE.Group()
        const color = this.colorOf(f.owner)
        const css = SEAT_COLORS_CSS[f.owner % 4]!
        const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.fleetTex, color, transparent: true, depthWrite: false }))
        const mag = Math.min(4.4, 1.5 + Math.sqrt(f.ships) * 0.34)
        core.scale.setScalar(mag)
        group.add(core)
        for (let k = 1; k <= 3; k++) {
          const tail = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: radialSprite(css, 0.15), color, transparent: true, opacity: 0.4 - k * 0.1, depthWrite: false }),
          )
          tail.scale.setScalar(mag * (1 - k * 0.22))
          tail.userData.k = k
          group.add(tail)
        }
        const [sx, sz] = worldOf(f.sx, f.sy, this.field)
        const [tx, tz] = worldOf(f.tx, f.ty, this.field)
        node = {
          group,
          from: new THREE.Vector3(sx, 1.1, sz),
          to: new THREE.Vector3(tx, 1.1, tz),
          shown: f.progress,
          target: f.progress,
        }
        this.scene.add(group)
        this.fleetNodes.set(f.id, node)
      }
      node.target = f.progress
    }
    for (const [id, node] of this.fleetNodes) {
      if (!seen.has(id)) {
        this.scene.remove(node.group)
        this.fleetNodes.delete(id)
      }
    }
  }

  burst(planetId: number, owner: number): void {
    const node = this.planetNodes.get(planetId)
    if (!node) return
    const w = new Shockwave(this.colorOf(owner), node.group.position.x, node.group.position.z)
    this.waves.push(w)
    this.scene.add(w.mesh)
  }

  update(dt: number): void {
    this.t += dt
    // fleets glide toward their reported progress (one tick ahead max)
    for (const node of this.fleetNodes.values()) {
      node.shown += (node.target + 0.5 * dt - node.shown) * Math.min(1, dt * 3.2)
      node.shown = Math.min(node.shown, 1)
      node.group.position.lerpVectors(node.from, node.to, node.shown)
      const dir = node.to.clone().sub(node.from).normalize()
      node.group.children.forEach((ch) => {
        const k = (ch.userData.k as number) || 0
        if (k > 0) ch.position.copy(dir.clone().multiplyScalar(-k * 1.3))
      })
    }
    for (const node of this.planetNodes.values()) {
      node.ring.rotation.z = this.t * 0.35
      const base = node.owner >= 0 ? 0.42 : 0.18
      node.halo.material.opacity = base + Math.sin(this.t * 2.2 + node.group.position.x) * 0.07
    }
    for (let i = this.waves.length - 1; i >= 0; i--) {
      if (!this.waves[i]!.update(dt)) {
        this.scene.remove(this.waves[i]!.mesh)
        this.waves.splice(i, 1)
      }
    }
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
// HUD
// ---------------------------------------------------------------------------

let players: PlayerInfo[] = []
let lastFrame: StarFrame | null = null
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
  header.style.cssText = `display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:center;min-height:40px;font:13px ${FONT};color:${ARENA_THEME.fg}`
  canvas = document.createElement('canvas')
  canvas.style.cssText = 'width:100%;border-radius:12px;display:block'
  statusEl = document.createElement('div')
  statusEl.style.cssText = `font:12px ${FONT};letter-spacing:.14em;color:${ARENA_THEME.fgSubtle}`
  wrap.appendChild(header)
  wrap.appendChild(canvas)
  wrap.appendChild(statusEl)
  root.appendChild(wrap)

  // Graceful fallback when the iframe has no WebGL: the HUD chips + status
  // line still narrate the match (same pattern as light-cycles).
  try {
    stage = new Stage(canvas)
  } catch {
    canvas.remove()
    const notice = document.createElement('div')
    notice.style.cssText = `padding:28px;font:13px ${FONT};color:${ARENA_THEME.fgSubtle};letter-spacing:.08em;text-align:center`
    notice.textContent = 'starmap requires WebGL — following the campaign via the panel below'
    wrap.insertBefore(notice, statusEl)
    return
  }
  const fit = (): void => {
    const w = Math.max(320, wrap.clientWidth - 16)
    const h = Math.round(Math.min(Math.max(w * 0.66, 300), 620))
    canvas!.style.height = `${h}px`
    stage!.resize(w, h)
  }
  fit()
  new ResizeObserver(fit).observe(wrap)
  requestAnimationFrame(loop)
}

let chipSlots: Array<{ lock: HTMLSpanElement; crown: HTMLSpanElement; empire: HTMLSpanElement } | null> = []
let playersKey: string | null = null

function initialBadge(seat: number, name: string): HTMLSpanElement {
  const el = document.createElement('span')
  const css = SEAT_COLORS_CSS[seat % 4]!
  el.textContent = (name || `E${seat + 1}`).slice(0, 1).toUpperCase()
  el.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:${css}26;border:1px solid ${css};color:${css};font:600 11px ${FONT}`
  return el
}

function seatChip(seat: number): HTMLDivElement {
  const info = players.find((p) => p.seat === seat)
  const name = info?.name ?? `Empire ${seat + 1}`
  const css = SEAT_COLORS_CSS[seat % 4]!
  const chip = document.createElement('div')
  chip.style.cssText = 'display:flex;align-items:center;gap:7px'
  const swatch = document.createElement('span')
  swatch.style.cssText = `width:11px;height:11px;border-radius:3px;background:${css};box-shadow:0 0 10px ${css}`
  chip.appendChild(swatch)
  if (info?.avatar) {
    const img = document.createElement('img')
    img.src = info.avatar
    img.alt = ''
    img.style.cssText = `width:22px;height:22px;border-radius:50%;background:${ARENA_THEME.surface}`
    img.onerror = () => img.replaceWith(initialBadge(seat, name))
    chip.appendChild(img)
  } else {
    chip.appendChild(initialBadge(seat, name))
  }
  const label = document.createElement('span')
  label.textContent = name
  chip.appendChild(label)
  const empire = document.createElement('span')
  empire.style.cssText = `font:11px ${FONT};color:${ARENA_THEME.fgSubtle}`
  chip.appendChild(empire)
  const lock = document.createElement('span')
  lock.textContent = 'SEALED'
  lock.style.cssText = `display:none;font-size:9px;letter-spacing:1px;padding:2px 5px;border-radius:4px;border:1px solid ${ARENA_THEME.border};color:${ARENA_THEME.fgSubtle}`
  chip.appendChild(lock)
  const crown = document.createElement('span')
  crown.textContent = 'RULES THE FIELD'
  crown.style.cssText = `display:none;font-size:9px;letter-spacing:1px;padding:2px 5px;border-radius:4px;background:${ARENA_THEME.accent};color:${ARENA_THEME.accentFg}`
  chip.appendChild(crown)
  chipSlots[seat] = { lock, crown, empire }
  return chip
}

function ensureHeader(seats: number): void {
  if (!header) return
  const key = JSON.stringify([seats, players.map((p) => [p.seat, p.agentId, p.name, p.avatar ?? ''])])
  if (key === playersKey) return
  playersKey = key
  header.innerHTML = ''
  chipSlots = []
  for (let s = 0; s < seats; s++) header.appendChild(seatChip(s))
}

function updateBadges(): void {
  const f = lastFrame
  if (!f) return
  for (let seat = 0; seat < chipSlots.length; seat++) {
    const slot = chipSlots[seat]
    if (!slot) continue
    slot.empire.textContent = f.empires ? `· ${f.empires[seat] ?? 0}` : ''
    slot.lock.style.display = f.status === 'playing' && f.committed?.[seat] ? '' : 'none'
    slot.crown.style.display = f.status === 'over' && f.winnerSeat === seat ? '' : 'none'
  }
}

// ---------------------------------------------------------------------------
// frame driving + camera
// ---------------------------------------------------------------------------

let prevTick = -1
const seenEvents = new Set<string>()
let azimuth = 0.6

function applyFrame(f: StarFrame): void {
  if (!stage) {
    // HUD-only fallback still narrates
    ensureHeader(f.empires?.length ?? 2)
    updateBadges()
    if (statusEl) statusEl.textContent = f.panels?.find((p) => p.type === 'status')?.text ?? ''
    return
  }
  if (f.field) stage.field = f.field
  const tick = f.tick ?? 0
  if (tick < prevTick) {
    stage.reset()
    seenEvents.clear()
  }
  prevTick = tick

  for (const p of f.planets ?? []) stage.syncPlanet(p)
  stage.syncFleets(f.fleets ?? [])
  for (const e of f.events ?? []) {
    const k = `${e.tick}:${e.planetId}:${e.kind}:${e.attacker}`
    if (seenEvents.has(k)) continue
    seenEvents.add(k)
    if (e.kind === 'capture') stage.burst(e.planetId, e.attacker)
  }

  ensureHeader(f.empires?.length ?? 2)
  updateBadges()
  if (statusEl) statusEl.textContent = f.panels?.find((p) => p.type === 'status')?.text ?? ''
}

let lastT = -1
function loop(): void {
  requestAnimationFrame(loop)
  if (!stage) return
  const now = performance.now() / 1000
  const dt = lastT < 0 ? 0.016 : Math.min(0.05, now - lastT)
  lastT = now

  azimuth += dt * 0.045
  const over = lastFrame?.status === 'over'
  const radius = over ? 96 : 88
  const height = over ? 92 : 62
  stage.camera.position.set(Math.cos(azimuth) * radius, height, Math.sin(azimuth) * radius)
  stage.camera.lookAt(0, 0, 0)

  stage.update(dt)
  stage.render()
}

onPlayers((p) => {
  players = p
  playersKey = null
  if (lastFrame) applyFrame(lastFrame)
})

onFrame((frame, root) => {
  ensureDom(root)
  lastFrame = frame as StarFrame
  applyFrame(lastFrame)
})
