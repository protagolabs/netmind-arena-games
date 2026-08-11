/**
 * The island renderer: the approved art pipeline (terraced faceted terrain
 * with baked AO + warm/cool faux-GI, hand-written water and sky shaders,
 * bloom + film grade, ambience actors) plus placement affordances
 * (buildable-area overlay, three-color ghost, spacing ring).
 */
import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  BufferGeometry,
  BufferAttribute,
  Raycaster,
  Group,
  Mesh,
  InstancedMesh,
  Points,
  DirectionalLight,
  HemisphereLight,
  PlaneGeometry,
  SphereGeometry,
  ConeGeometry,
  CylinderGeometry,
  BoxGeometry,
  IcosahedronGeometry,
  TorusGeometry,
  RingGeometry,
  CircleGeometry,
  MeshStandardMaterial,
  MeshBasicMaterial,
  ShaderMaterial,
  PointsMaterial,
  Color,
  Vector2,
  Vector3,
  Matrix4,
  Quaternion,
  Euler,
  Fog,
  PCFSoftShadowMap,
  NoToneMapping,
  BackSide,
  DoubleSide,
  AdditiveBlending,
} from './three.js'
import { createPost, type Post } from './post.js'
import { ihash, makeRng, smooth, vnoise } from './seed.js'
import type { Island, Placed, BType } from './sim.js'

const WATER_VS = `
uniform float uTime;
attribute float aDepth;
varying vec3 vW;varying vec3 vView;varying vec3 vN;varying float vD;varying float vCrest;
void main(){
vec3 p=position;
float damp=smoothstep(0.0,1.5,aDepth);
float y=0.0;vec2 off=vec2(0.0);vec2 ng=vec2(0.0);
vec2 d1=vec2(0.9578,0.2873);float th=0.5712*dot(d1,p.xz)-0.55*uTime;
y+=0.085*sin(th);off+=d1*(0.0935*cos(th));ng+=d1*(0.0486*cos(th));
vec2 d2=vec2(-0.5735,0.8192);th=0.8378*dot(d2,p.xz)-0.8*uTime;
y+=0.06*sin(th);off+=d2*(0.066*cos(th));ng+=d2*(0.0503*cos(th));
vec2 d3=vec2(0.3714,-0.9285);th=1.2083*dot(d3,p.xz)-1.05*uTime;
y+=0.045*sin(th);off+=d3*(0.0495*cos(th));ng+=d3*(0.0544*cos(th));
vec2 d4=vec2(0.7071,0.7071);th=1.848*dot(d4,p.xz)-1.35*uTime;
y+=0.028*sin(th);off+=d4*(0.0308*cos(th));ng+=d4*(0.0517*cos(th));
p.x+=off.x*damp;p.z+=off.y*damp;p.y+=y*damp;
vN=normalize(vec3(-ng.x*damp,1.0,-ng.y*damp));
vW=(modelMatrix*vec4(p,1.0)).xyz;
vView=cameraPosition-vW;
vD=aDepth;vCrest=y*damp/0.218;
gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`

const WATER_FS = `
uniform float uTime;
uniform vec3 uSunDir,uSunCol,uShallow,uDeep,uFoam,uSky,uFog;
varying vec3 vW;varying vec3 vView;varying vec3 vN;varying float vD;varying float vCrest;
float h21(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float vno(vec2 p){vec2 i=floor(p);vec2 f=fract(p);f=f*f*(3.0-2.0*f);
float a=h21(i);float b=h21(i+vec2(1.0,0.0));float c=h21(i+vec2(0.0,1.0));float d=h21(i+vec2(1.0,1.0));
return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
void main(){
vec3 n=normalize(vN);
vec2 nc=vW.xz*1.4+vec2(uTime*0.22,uTime*0.16);
float n1=vno(nc);float n2=vno(nc+vec2(0.35,0.0));float n3=vno(nc+vec2(0.0,0.35));
n=normalize(n+vec3((n2-n1)*0.35,0.0,(n3-n1)*0.35));
vec3 V=normalize(vView);
float dfac=smoothstep(0.1,3.5,vD);
vec3 col=mix(uShallow,uDeep,dfac);
float fr=pow(1.0-max(dot(V,n),0.0),3.0);
col=mix(col,uSky,fr*0.55);
vec3 R=reflect(-normalize(uSunDir),n);
float sp=pow(max(dot(R,V),0.0),90.0);
float glint=step(0.78,vno(vW.xz*6.0+uTime*0.55));
col+=uSunCol*sp*(0.7+glint*1.8);
float lap=0.18*sin(uTime*0.9-vD*5.0);
float foamM=smoothstep(0.5,0.05,vD+(vno(vW.xz*2.2+uTime*0.14)-0.5)*0.3+lap);
foamM+=smoothstep(0.65,0.95,vCrest)*(0.3+0.4*vno(vW.xz*3.0+uTime*0.3));
foamM=clamp(foamM,0.0,1.0);
col=mix(col,uFoam,foamM*0.85);
float dist=length(vView);
col=mix(col,uFog,smoothstep(60.0,165.0,dist));
float alpha=mix(0.62,0.94,dfac);
alpha=max(alpha,foamM*0.9);
gl_FragColor=vec4(col,alpha);}`

const SKY_VS = `varying vec3 vDir;void main(){vDir=normalize(position);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`

const SKY_FS = `
uniform vec3 uHor,uZen,uHaze,uSunDir,uSunCol;
varying vec3 vDir;
void main(){
float t=smoothstep(-0.08,0.5,vDir.y);
vec3 col=mix(uHor,uZen,pow(t,0.85));
float hz=1.0-smoothstep(0.0,0.18,abs(vDir.y));
col=mix(col,uHaze,hz*0.45);
float d=max(dot(vDir,normalize(uSunDir)),0.0);
col+=uSunCol*(pow(d,350.0)*1.15+pow(d,30.0)*0.22);
gl_FragColor=vec4(col,1.0);}`

interface DayNightPair {
  d: Color
  n: Color
  into: Color
}

const pair = (d: number, n: number, into: Color): DayNightPair => ({ d: new Color(d), n: new Color(n), into })

export interface IsleScene {
  resize(w: number, h: number): void
  orbitBy(dx: number, dy: number): void
  setPointer(nx: number, ny: number): void
  pickGround(): { x: number; z: number } | null
  setGhostType(t: BType | null): void
  setGhostState(ok: boolean, positive: boolean): void
  refreshOverlay(tier: (x: number, z: number) => 0 | 1 | 2): void
  overlayWake(): void
  addBuilding(p: Placed): void
  resetBuildings(): void
  unsettle(): void
  setLamps(n: number): void
  setNeighbors(list: { id: string; label: string; score: number; bearing: number; dist: number }[]): void
  pickNeighbor(): { id: string; label: string; top: Vector3 } | null
  project(x: number, y: number, z: number): { x: number; y: number } | null
  setNightTarget(t: number): void
  settle(): void
  frame(dt: number): void
  dragging: boolean
  dispose(): void
}

export function createScene(canvas: HTMLCanvasElement, island: Island): IsleScene {
  const seed = island.seed
  const terr = island.terr
  const renderer = new WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFSoftShadowMap
  renderer.toneMapping = NoToneMapping

  const scene = new Scene()
  const fog = new Fog(0xf2dfc0, 60, 165)
  scene.fog = fog
  const camera = new PerspectiveCamera(34, 1, 0.1, 400)

  const hemi = new HemisphereLight(0xd8ecf8, 0xb7c6a2, 0.5)
  scene.add(hemi)
  const sun = new DirectionalLight(0xffdfae, 1.6)
  sun.position.set(27, 18, 8)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.bias = -0.0005
  sun.shadow.radius = 4
  sun.shadow.camera.left = -24
  sun.shadow.camera.right = 24
  sun.shadow.camera.top = 24
  sun.shadow.camera.bottom = -24
  sun.shadow.camera.far = 130
  scene.add(sun)
  scene.add(sun.target)
  const rim = new DirectionalLight(0xbcd6ff, 0.3)
  rim.position.set(-30, 14, -18)
  scene.add(rim)

  const disposables: { dispose(): void }[] = []
  const track = <T extends { dispose(): void }>(d: T): T => {
    disposables.push(d)
    return d
  }
  const std = (hex: number, rough = 0.85) =>
    track(new MeshStandardMaterial({ color: hex, flatShading: true, roughness: rough }))

  // ---------------------------------------------------------------- terrain
  const GN = 63
  const EX = 16.5
  const ST = (EX * 2) / (GN - 1)
  const px = new Float32Array(GN * GN)
  const pz = new Float32Array(GN * GN)
  const ph = new Float32Array(GN * GN)
  const ao = new Float32Array(GN * GN)
  for (let i = 0; i < GN; i++) {
    for (let j = 0; j < GN; j++) {
      const x = -EX + i * ST + (ihash(i, j, seed ^ 0x11) - 0.5) * 0.38
      const z = -EX + j * ST + (ihash(i, j, seed ^ 0x22) - 0.5) * 0.38
      px[i * GN + j] = x
      pz[i * GN + j] = z
      ph[i * GN + j] = terr(x, z)
    }
  }
  for (let i = 0; i < GN; i++) {
    for (let j = 0; j < GN; j++) {
      let occ = 0
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (!di && !dj) continue
          const ii = Math.min(GN - 1, Math.max(0, i + di))
          const jj = Math.min(GN - 1, Math.max(0, j + dj))
          occ += Math.max(0, ph[ii * GN + jj]! - ph[i * GN + j]!)
        }
      }
      ao[i * GN + j] = Math.max(0.6, 1 / (1 + occ * 0.32))
    }
  }
  const sunN = new Vector3(27, 18, 8).normalize()
  const tp: number[] = []
  const tc: number[] = []
  const gIdx: number[] = []
  const CT = new Color()
  const DEEP_SEA = new Color(0x12374a)
  const fcol = (h: number, ny: number, cx: number, cz: number): Color => {
    if (h < 0.02) {
      const d = Math.min(1, -h / 1.9)
      CT.setHex(0xd9c48f).multiplyScalar(1 - 0.5 * d)
      CT.lerp(DEEP_SEA, smooth(12.8, 16.2, Math.hypot(cx, cz)))
    } else if (ny < 0.6) {
      const band = Math.floor((h + 3) * 1.9) % 2 === 0 ? 1 : 0.88
      CT.setHex(0xcdb59a).multiplyScalar(band * (0.7 + 0.3 * Math.min(1, h / 4.5)))
    } else if (h < 0.8) {
      CT.setHex(0xecd9a6)
    } else {
      const p = vnoise(cx * 0.5, cz * 0.5, seed, 15)
      CT.setHex(p > 0.56 ? 0xa9cb7c : 0x8cbb66)
      CT.offsetHSL(Math.min(1, h / 4.5) * 0.015, 0.02, 0.02 * Math.min(1, h / 4.5))
    }
    return CT
  }
  const pushTri = (a: number, b: number, c: number) => {
    const ax = px[a]!, ay = ph[a]!, az = pz[a]!
    const bx = px[b]!, by = ph[b]!, bz = pz[b]!
    const cx = px[c]!, cy = ph[c]!, cz = pz[c]!
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz) || 1
    nx /= l; ny /= l; nz /= l
    const col = fcol((ay + by + cy) / 3, ny, (ax + bx + cx) / 3, (az + bz + cz) / 3)
    const dl = Math.max(0, nx * sunN.x + ny * sunN.y + nz * sunN.z)
    const wr = 0.93 + dl * 0.14
    const wg = 0.965 + dl * 0.045
    const wb = 1.07 - dl * 0.125
    tp.push(ax, ay, az, bx, by, bz, cx, cy, cz)
    gIdx.push(a, b, c)
    for (const id of [a, b, c]) {
      const av = ao[id]!
      tc.push(col.r * wr * av, col.g * wg * av, col.b * wb * av)
    }
  }
  for (let i = 0; i < GN - 1; i++) {
    for (let j = 0; j < GN - 1; j++) {
      const a = i * GN + j
      const b = (i + 1) * GN + j
      const c = i * GN + j + 1
      const d = (i + 1) * GN + j + 1
      pushTri(a, c, d)
      pushTri(a, d, b)
    }
  }
  const tgeo = track(new BufferGeometry())
  const posAttr = new BufferAttribute(new Float32Array(tp), 3)
  tgeo.setAttribute('position', posAttr)
  tgeo.setAttribute('color', new BufferAttribute(new Float32Array(tc), 3))
  tgeo.computeVertexNormals()
  const terrain = new Mesh(tgeo, track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 })))
  terrain.receiveShadow = true
  terrain.castShadow = true
  scene.add(terrain)

  // Buildable-area overlay shares the terrain positions; per-vertex green.
  const ovCap = gIdx.length * 3
  const mkOverlayLayer = (hex: number, alpha: number) => {
    const geo = track(new BufferGeometry())
    const attr = new BufferAttribute(new Float32Array(ovCap), 3)
    geo.setAttribute('position', attr)
    geo.setDrawRange(0, 0)
    const mat = track(
      new MeshBasicMaterial({
        color: hex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false,
      }),
    )
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    scene.add(mesh)
    return { geo, attr, mat, alpha }
  }
  const ovGreen = mkOverlayLayer(0xa8f5c6, 0.55)
  const ovGold = mkOverlayLayer(0xffc226, 0.82)

  const deep = new Mesh(track(new CircleGeometry(115, 24)), track(new MeshStandardMaterial({ color: 0x12374a, roughness: 0.95 })))
  deep.rotation.x = -Math.PI / 2
  deep.position.y = -2.0
  scene.add(deep)

  // ------------------------------------------------------------------ water
  const waterGeo = track(new PlaneGeometry(240, 240, 96, 96))
  waterGeo.rotateX(-Math.PI / 2)
  const wvp = waterGeo.attributes.position!
  const aDepth = new Float32Array(wvp.count)
  for (let i = 0; i < wvp.count; i++) aDepth[i] = -terr(wvp.getX(i), wvp.getZ(i))
  waterGeo.setAttribute('aDepth', new BufferAttribute(aDepth, 1))
  const waterUni = {
    uTime: { value: 0 },
    uSunDir: { value: new Vector3(27, 18, 8).normalize() },
    uSunCol: { value: new Color(0xffedc2) },
    uShallow: { value: new Color(0x5fcfc0) },
    uDeep: { value: new Color(0x175d80) },
    uFoam: { value: new Color(0xf7fdf7) },
    uSky: { value: new Color(0xbfe3f2) },
    uFog: { value: new Color(0xf2dfc0) },
  }
  const waterMat = track(
    new ShaderMaterial({
      uniforms: waterUni,
      vertexShader: WATER_VS,
      fragmentShader: WATER_FS,
      transparent: true,
      depthWrite: false,
    }),
  )
  const water = new Mesh(waterGeo, waterMat)
  water.position.y = 0.02
  scene.add(water)

  // -------------------------------------------------------------------- sky
  const skyUni = {
    uHor: { value: new Color(0xf7e4c3) },
    uZen: { value: new Color(0x8cc7e6) },
    uHaze: { value: new Color(0xfff3dd) },
    uSunDir: { value: new Vector3(27, 18, 8).normalize() },
    uSunCol: { value: new Color(0xffe8b8) },
  }
  const skyMat = track(
    new ShaderMaterial({ side: BackSide, depthWrite: false, uniforms: skyUni, vertexShader: SKY_VS, fragmentShader: SKY_FS }),
  )
  scene.add(new Mesh(track(new SphereGeometry(170, 24, 14)), skyMat))

  const stGeo = track(new BufferGeometry())
  const stArr: number[] = []
  for (let i = 0; i < 260; i++) {
    const a = ihash(i, 3, seed) * Math.PI * 2
    const e = 0.06 + ihash(i, 4, seed) * 1.3
    stArr.push(Math.cos(a) * Math.cos(e) * 150, Math.sin(e) * 150, Math.sin(a) * Math.cos(e) * 150)
  }
  stGeo.setAttribute('position', new BufferAttribute(new Float32Array(stArr), 3))
  const starMat = track(
    new PointsMaterial({ color: 0xeef2ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false }),
  )
  scene.add(new Points(stGeo, starMat))

  const cloudMat = track(
    new MeshStandardMaterial({ color: 0xfffbf4, roughness: 1, flatShading: true, transparent: true, opacity: 0.9 }),
  )
  const clouds: Group[] = []
  for (let i = 0; i < 5; i++) {
    const parent = new Group()
    const g = new Group()
    const nBlob = 4 + (i % 2)
    for (let k = 0; k < nBlob; k++) {
      const s = new Mesh(track(new SphereGeometry(1.7 + ihash(i, k, seed) * 1.9, 7, 5)), cloudMat)
      s.scale.y = 0.38
      s.position.set(k * 2.1 - nBlob, ihash(k, i, seed) * 0.7, (ihash(i * 3, k, seed) - 0.5) * 2)
      g.add(s)
    }
    g.position.set(25 + i * 6, 24 + i * 3.2, 0)
    parent.rotation.y = i * 1.3
    parent.add(g)
    scene.add(parent)
    clouds.push(parent)
  }

  // ------------------------------------------------------------------ decor
  const mats = {
    wall: std(0xf6ead6),
    roof: std(0xd1704f),
    roofD: std(0xb0563c),
    wood: std(0x7d5f43),
    white: std(0xf7f4ec, 0.7),
    red: std(0xd6543f),
    dark: std(0x4a4f5a),
    stone: std(0xcfc3ae),
    door: std(0x6b4a36),
    plank: std(0x9a7856),
    drift: std(0xb9a184),
    soil: std(0xa5834f),
    wheat: std(0xd8b45a),
    teal: std(0x2f6f6a),
  }
  const winMat = track(new MeshStandardMaterial({ color: 0x3a3f4a, emissive: 0xffc873, emissiveIntensity: 0 }))
  const lampMat = track(new MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xffdf88, emissiveIntensity: 0.6 }))

  // Textureless glow quads: radial falloff in the fragment shader, additive.
  const GLOW_VS = `varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`
  const GLOW_FS = `
uniform vec3 uColor;uniform float uAlpha;varying vec2 vUv;
void main(){
float d=length(vUv-vec2(0.5))*2.0;
float a=uAlpha*pow(max(0.0,1.0-d),2.2);
gl_FragColor=vec4(uColor*a,a);}`
  const mkGlowMat = (hex: number) =>
    track(
      new ShaderMaterial({
        uniforms: { uColor: { value: new Color(hex) }, uAlpha: { value: 0 } },
        vertexShader: GLOW_VS,
        fragmentShader: GLOW_FS,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    )
  const warmGlowMat = mkGlowMat(0xffd27a)
  const poolGlowMat = mkGlowMat(0xffc85e)
  const coolGlowMat = mkGlowMat(0xbfe9ff)
  const glowGeo = track(new PlaneGeometry(1, 1))
  const staticGlows: Mesh[] = []
  const buildingGlows: Mesh[] = []
  const addGlow = (
    parent: Group,
    x: number,
    y: number,
    z: number,
    size: number,
    mat: ShaderMaterial,
    kind: 'static' | 'building',
    flat = false,
  ) => {
    const m = new Mesh(glowGeo, mat)
    m.position.set(x, y, z)
    m.scale.setScalar(size * (0.9 + ihash(Math.round(x * 91), Math.round(z * 57), seed) * 0.25))
    m.userData.isGlow = true
    if (flat) {
      m.rotation.x = -Math.PI / 2
      m.userData.flat = true
    }
    parent.add(m)
    ;(kind === 'static' ? staticGlows : buildingGlows).push(m)
    return m
  }
  const beamMat = track(
    new MeshBasicMaterial({ color: 0xffe9b0, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
  )
  const mills: Group[] = []
  const beams: { g: Group; up: boolean }[] = []
  const sway: { can: Group; ph: number }[] = []

  const mkTree = (sc: number, sd: number): Group => {
    const g = new Group()
    const tr = new Mesh(track(new CylinderGeometry(0.08, 0.14, 0.5, 5)), mats.wood)
    tr.position.y = 0.24
    tr.castShadow = true
    g.add(tr)
    const can = new Group()
    if (ihash(sd, 11, seed) > 0.75) {
      const m = track(new MeshStandardMaterial({ flatShading: true, roughness: 0.9 }))
      m.color.setHSL(0.24 + ihash(sd, 2, seed) * 0.04, 0.42, 0.42)
      const c = new Mesh(track(new IcosahedronGeometry(0.62, 1)), m)
      c.scale.set(1, 0.85, 1)
      c.position.y = 1.05
      c.castShadow = true
      can.add(c)
    } else {
      const hue = 0.285 + (ihash(sd, 2, seed) - 0.5) * 0.09
      const hs: [number, number, number][] = [
        [0.66, 0.85, 0.68],
        [0.5, 0.75, 1.16],
        [0.32, 0.6, 1.6],
      ]
      for (let L = 0; L < 3; L++) {
        const m = track(new MeshStandardMaterial({ flatShading: true, roughness: 0.9 }))
        m.color.setHSL(hue + L * 0.012, 0.44, 0.3 + L * 0.05 + ihash(sd, 3, seed) * 0.06)
        const c = new Mesh(track(new ConeGeometry(hs[L]![0], hs[L]![1], 7)), m)
        c.position.set((ihash(sd, L + 4, seed) - 0.5) * 0.12, hs[L]![2], (ihash(sd, L + 7, seed) - 0.5) * 0.12)
        c.castShadow = true
        can.add(c)
      }
    }
    g.add(can)
    sway.push({ can, ph: ihash(sd, 13, seed) * 6.28 })
    g.scale.setScalar(sc)
    g.rotation.y = ihash(sd, 7, seed) * 6.28
    return g
  }
  island.trees.forEach((t, i) => {
    const g = mkTree(0.8 + ihash(i, 5, seed) * 0.55, i)
    g.position.set(t.x, terr(t.x, t.z) - 0.04, t.z)
    scene.add(g)
  })
  island.bushes.forEach((b, i) => {
    const m = track(new MeshStandardMaterial({ flatShading: true, roughness: 0.9 }))
    m.color.setHSL(0.26, 0.4, 0.42 + ihash(i, 6, seed) * 0.1)
    const mesh = new Mesh(track(new SphereGeometry(b.s, 6, 5)), m)
    mesh.scale.y = 0.7
    mesh.position.set(b.x, terr(b.x, b.z) + 0.1, b.z)
    mesh.castShadow = true
    scene.add(mesh)
  })
  island.rocks.forEach((r, i) => {
    const mesh = new Mesh(track(new IcosahedronGeometry(r.s, 0)), mats.stone)
    mesh.position.set(r.x, terr(r.x, r.z) + 0.1, r.z)
    mesh.rotation.set(ihash(i, 1, seed) * 3, ihash(i, 2, seed) * 3, 0)
    mesh.castShadow = true
    scene.add(mesh)
  })

  // grass tufts in noise-gated meadows, colored to the ground under them
  const bladeGeo = (rot: number, lean: number, sc: number, dx: number, dz: number): BufferGeometry => {
    const g = new ConeGeometry(0.06, 0.26, 5)
    g.scale(sc, sc * 1.15, sc)
    g.translate(0, 0.15 * sc, 0)
    g.rotateX(lean)
    g.rotateY(rot)
    g.translate(dx, 0, dz)
    return g
  }
  const mergeGeos = (geos: BufferGeometry[]): BufferGeometry => {
    const nonIndexed = geos.map((g) => g.toNonIndexed())
    let count = 0
    for (const g of nonIndexed) count += g.attributes.position!.count
    const pos = new Float32Array(count * 3)
    const nor = new Float32Array(count * 3)
    let o = 0
    for (const g of nonIndexed) {
      pos.set(g.attributes.position!.array as Float32Array, o * 3)
      nor.set(g.attributes.normal!.array as Float32Array, o * 3)
      o += g.attributes.position!.count
      g.dispose()
    }
    for (const g of geos) g.dispose()
    const out = new BufferGeometry()
    out.setAttribute('position', new BufferAttribute(pos, 3))
    out.setAttribute('normal', new BufferAttribute(nor, 3))
    return out
  }
  const tuftGeo = track(
    mergeGeos([bladeGeo(0.4, 0.3, 1.0, 0.06, 0.02), bladeGeo(2.6, 0.26, 0.84, -0.06, 0.05), bladeGeo(4.5, 0.34, 0.7, 0.01, -0.07)]),
  )
  const grassMat = track(new MeshStandardMaterial({ color: 0xffffff, flatShading: true, roughness: 0.95 }))
  const gPts: [number, number, number, number][] = []
  const grng = makeRng(seed ^ 0x9a55)
  for (let i = 0; i < 2600 && gPts.length < 430; i++) {
    const rad = Math.sqrt(grng()) * 13
    const an = grng() * Math.PI * 2
    const x = Math.cos(an) * rad
    const z = Math.sin(an) * rad
    const h = terr(x, z)
    if (h > 0.85 && vnoise(x * 0.35, z * 0.35, seed, 16) > 0.52 && island.slopeOk(x, z) && !island.trees.some((t) => Math.hypot(t.x - x, t.z - z) < 0.85)) {
      gPts.push([x, h, z, i])
    }
  }
  const M4 = new Matrix4()
  const Q4 = new Quaternion()
  const E4 = new Euler()
  const S4 = new Vector3()
  const P4 = new Vector3()
  const C4 = new Color()
  const grass = new InstancedMesh(tuftGeo, grassMat, Math.max(1, gPts.length))
  gPts.forEach((p, i) => {
    E4.set((ihash(p[3], 1, seed) - 0.5) * 0.14, ihash(p[3], 2, seed) * 6.28, (ihash(p[3], 3, seed) - 0.5) * 0.14)
    Q4.setFromEuler(E4)
    const s = 0.8 + ihash(p[3], 4, seed) * 0.5
    M4.compose(P4.set(p[0], p[1] - 0.01, p[2]), Q4, S4.set(s, s * (0.8 + ihash(p[3], 8, seed) * 0.35), s))
    grass.setMatrixAt(i, M4)
    const pch = vnoise(p[0] * 0.5, p[2] * 0.5, seed, 15)
    C4.setHex(pch > 0.56 ? 0xa9cb7c : 0x8cbb66).offsetHSL((ihash(p[3], 5, seed) - 0.5) * 0.03, 0.02, 0.05 + ihash(p[3], 6, seed) * 0.07)
    grass.setColorAt(i, C4)
  })
  if (grass.instanceColor) grass.instanceColor.needsUpdate = true
  scene.add(grass)

  const flowGeo = track(new IcosahedronGeometry(0.05, 0))
  const flowMat = track(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }))
  const fCols = [0xfff4f0, 0xffd9e8, 0xffe9a8]
  const nFl = Math.min(60, gPts.length)
  const flowers = new InstancedMesh(flowGeo, flowMat, Math.max(1, nFl))
  for (let i = 0; i < nFl; i++) {
    const p = gPts[Math.floor(ihash(i, 7, seed) * gPts.length)]!
    M4.compose(
      P4.set(p[0] + (ihash(i, 1, seed) - 0.5) * 0.5, p[1] + 0.16, p[2] + (ihash(i, 2, seed) - 0.5) * 0.5),
      Q4.identity(),
      S4.set(1, 1, 1),
    )
    flowers.setMatrixAt(i, M4)
    C4.setHex(fCols[i % 3]!)
    flowers.setColorAt(i, C4)
  }
  if (flowers.instanceColor) flowers.instanceColor.needsUpdate = true
  scene.add(flowers)

  // shoreline scan (dock placement + shore-aware actors)
  const shoreR: number[] = []
  const shoreDX: number[] = []
  const shoreDZ: number[] = []
  for (let k = 0; k < 160; k++) {
    const a = (k / 160) * Math.PI * 2
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    let lo = 5
    let hi = 16.5
    if (terr(ca * 5, sa * 5) <= 0) {
      shoreR.push(shoreR.length ? shoreR[shoreR.length - 1]! : 9)
    } else {
      for (let it = 0; it < 18; it++) {
        const mid = (lo + hi) / 2
        if (terr(ca * mid, sa * mid) > 0) lo = mid
        else hi = mid
      }
      shoreR.push(lo)
    }
    shoreDX.push(ca)
    shoreDZ.push(sa)
  }
  let dockK = -1
  for (let k = 0; k < 160; k++) {
    const r = shoreR[k]!
    const h1 = terr(shoreDX[k]! * (r - 1.5), shoreDZ[k]! * (r - 1.5))
    const h2 = terr(shoreDX[k]! * (r - 2.8), shoreDZ[k]! * (r - 2.8))
    if (h1 > 0.1 && h1 < 0.55 && h2 < 1.0) {
      dockK = k
      break
    }
  }
  if (dockK < 0) dockK = 0
  {
    const dock = new Group()
    const dx = shoreDX[dockK]!
    const dz = shoreDZ[dockK]!
    const r0 = shoreR[dockK]!
    dock.rotation.y = Math.atan2(dx, dz)
    for (let i = 0; i < 7; i++) {
      const p = new Mesh(track(new BoxGeometry(1.0, 0.06, 0.55)), mats.plank)
      p.position.set((ihash(i, 3, seed) - 0.5) * 0.03, 0.44 + (ihash(i, 1, seed) - 0.5) * 0.02, r0 - 1.3 + i * 0.6)
      p.rotation.y = (ihash(i, 2, seed) - 0.5) * 0.04
      p.castShadow = true
      dock.add(p)
    }
    for (let s = 0; s < 2; s++) {
      for (let e = 0; e < 2; e++) {
        const pole = new Mesh(track(new CylinderGeometry(0.055, 0.065, 1.15, 6)), mats.wood)
        pole.position.set(s ? 0.42 : -0.42, -0.1, r0 - 0.9 + e * 2.6)
        pole.castShadow = true
        dock.add(pole)
      }
    }
    const harborPost = new Mesh(track(new CylinderGeometry(0.04, 0.055, 0.7, 5)), mats.wood)
    harborPost.position.set(0.42, 0.78, r0 + 1.65)
    dock.add(harborPost)
    const harborLamp = new Mesh(track(new SphereGeometry(0.08, 6, 5)), lampMat)
    harborLamp.position.set(0.42, 1.18, r0 + 1.65)
    dock.add(harborLamp)
    addGlow(dock, 0.42, 1.18, r0 + 1.65, 1.3, warmGlowMat, 'static')
    addGlow(dock, 0.42, 0.52, r0 + 1.65, 1.6, poolGlowMat, 'static', true)
    scene.add(dock)
  }
  // Lantern slots around the shore — lit one per lamp when visiting an isle.
  const lampSlots: Group[] = []
  for (let s = 0; s < 20; s++) {
    const k = (s * 8) % 160
    let r = shoreR[k]! - 0.7
    let lx = shoreDX[k]! * r
    let lz = shoreDZ[k]! * r
    if (terr(lx, lz) < 0.08) {
      r = shoreR[k]! - 1.4
      lx = shoreDX[k]! * r
      lz = shoreDZ[k]! * r
    }
    const g = new Group()
    const post = new Mesh(track(new CylinderGeometry(0.035, 0.05, 0.55, 5)), mats.wood)
    post.position.y = 0.26
    post.castShadow = true
    g.add(post)
    const glow = new Mesh(track(new SphereGeometry(0.07, 6, 5)), lampMat)
    glow.position.y = 0.58
    g.add(glow)
    addGlow(g, 0, 0.58, 0, 1.1, warmGlowMat, 'static')
    addGlow(g, 0, 0.045, 0, 1.9, poolGlowMat, 'static', true)
    g.position.set(lx, terr(lx, lz) - 0.02, lz)
    g.visible = false
    scene.add(g)
    lampSlots.push(g)
  }

  const rowboat = new Group()
  {
    const hull = new Mesh(track(new BoxGeometry(0.5, 0.2, 1.0)), std(0xc9a97e))
    hull.position.y = 0.1
    hull.castShadow = true
    rowboat.add(hull)
    const bowG = track(new ConeGeometry(0.25, 0.4, 4))
    bowG.rotateY(Math.PI / 4)
    bowG.rotateX(Math.PI / 2)
    const bow = new Mesh(bowG, std(0xc9a97e))
    bow.scale.y = 0.4
    bow.position.set(0, 0.1, 0.7)
    rowboat.add(bow)
    const inn = new Mesh(track(new BoxGeometry(0.38, 0.12, 0.85)), std(0x8a6a4d))
    inn.position.y = 0.16
    rowboat.add(inn)
    for (let s = 0; s < 2; s++) {
      const seat = new Mesh(track(new BoxGeometry(0.42, 0.03, 0.12)), mats.plank)
      seat.position.set(0, 0.22, s ? 0.25 : -0.2)
      rowboat.add(seat)
    }
    const dx = shoreDX[dockK]!
    const dz = shoreDZ[dockK]!
    const r0 = shoreR[dockK]!
    rowboat.position.set(dx * (r0 + 1.3) + dz * 0.85, 0.06, dz * (r0 + 1.3) - dx * 0.85)
    rowboat.rotation.y = Math.atan2(dx, dz) + 0.35
    scene.add(rowboat)
  }

  // sloop + wake + flag
  const boat = new Group()
  const boatIn = new Group()
  boat.add(boatIn)
  let flag: Mesh | null = null
  {
    const hullM = std(0xf1e6cf)
    const railM = std(0x6f523b)
    const sailM = track(new MeshStandardMaterial({ color: 0xfdf8ec, side: DoubleSide, flatShading: true }))
    const hull = new Mesh(track(new BoxGeometry(1.15, 0.3, 0.55)), hullM)
    hull.position.y = 0.16
    hull.castShadow = true
    boatIn.add(hull)
    const bowG = track(new ConeGeometry(0.275, 0.55, 4))
    bowG.rotateY(Math.PI / 4)
    bowG.rotateZ(-Math.PI / 2)
    const bow = new Mesh(bowG, hullM)
    bow.scale.y = 0.55
    bow.position.set(0.85, 0.16, 0)
    boatIn.add(bow)
    const stripe = new Mesh(track(new BoxGeometry(1.18, 0.05, 0.57)), mats.roofD)
    stripe.position.y = 0.045
    boatIn.add(stripe)
    const deck = new Mesh(track(new BoxGeometry(1.12, 0.03, 0.5)), std(0xd9c9a8))
    deck.position.y = 0.32
    boatIn.add(deck)
    const cabin = new Mesh(track(new BoxGeometry(0.34, 0.15, 0.3)), hullM)
    cabin.position.set(-0.16, 0.42, 0)
    boatIn.add(cabin)
    const mast = new Mesh(track(new CylinderGeometry(0.025, 0.035, 1.9, 6)), railM)
    mast.position.set(0.12, 1.28, 0)
    boatIn.add(mast)
    const mainG = track(new BufferGeometry())
    mainG.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([0.12, 0.68, 0, 0.12, 2.02, 0, -0.28, 1.28, 0.13, 0.12, 2.02, 0, -0.72, 0.72, 0, -0.28, 1.28, 0.13, 0.12, 0.68, 0, -0.28, 1.28, 0.13, -0.72, 0.72, 0]),
        3,
      ),
    )
    mainG.computeVertexNormals()
    const main = new Mesh(mainG, sailM)
    main.castShadow = true
    boatIn.add(main)
    const jibG = track(new BufferGeometry())
    jibG.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([0.84, 0.4, 0, 0.13, 1.9, 0, 0.32, 0.95, 0.11, 0.13, 1.9, 0, -0.1, 0.52, 0.02, 0.32, 0.95, 0.11, 0.84, 0.4, 0, 0.32, 0.95, 0.11, -0.1, 0.52, 0.02]),
        3,
      ),
    )
    jibG.computeVertexNormals()
    boatIn.add(new Mesh(jibG, sailM))
    flag = new Mesh(track(new PlaneGeometry(0.16, 0.09)), track(new MeshBasicMaterial({ color: 0xd6543f, side: DoubleSide })))
    flag.position.set(0.04, 2.22, 0)
    boatIn.add(flag)
    const wkg = track(new BufferGeometry())
    wkg.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-0.7, 0.03, 0, -3.6, 0.03, 0.6, -3.6, 0.03, -0.6, -0.7, 0.05, 0, -2.0, 0.05, 0.28, -2.0, 0.05, -0.28]), 3),
    )
    const wkm = track(
      new MeshBasicMaterial({ color: 0xdff4ee, transparent: true, opacity: 0.2, blending: AdditiveBlending, depthWrite: false, side: DoubleSide }),
    )
    boat.add(new Mesh(wkg, wkm))
    scene.add(boat)
  }

  // gulls
  interface Gull {
    g: Group
    bd: Group
    sh: Group[]
    el: Group[]
    ph: number
    sp: number
    fw: number
    r: number
    h: number
  }
  const gulls: Gull[] = []
  {
    const wm = std(0xf7f5ef, 0.9)
    const gm = std(0xbcc4cb, 0.9)
    const om = std(0xe8923a, 0.8)
    const dm = std(0x454b55, 0.9)
    for (let i = 0; i < 4; i++) {
      const sd = i + 1
      const g = new Group()
      const bd = new Group()
      g.add(bd)
      const body = new Mesh(track(new SphereGeometry(0.12, 7, 6)), wm)
      body.scale.set(2.0, 0.8, 0.9)
      body.castShadow = true
      bd.add(body)
      const head = new Mesh(track(new SphereGeometry(0.075, 6, 5)), wm)
      head.position.set(0.24, 0.06, 0)
      bd.add(head)
      const bkG = track(new ConeGeometry(0.028, 0.13, 5))
      bkG.rotateZ(-Math.PI / 2)
      const beak = new Mesh(bkG, om)
      beak.position.set(0.36, 0.05, 0)
      bd.add(beak)
      const tlG = track(new ConeGeometry(0.05, 0.2, 4))
      tlG.rotateZ(Math.PI / 2)
      const tail = new Mesh(tlG, gm)
      tail.scale.y = 0.45
      tail.position.set(-0.3, 0.02, 0)
      bd.add(tail)
      const sh: Group[] = []
      const el: Group[] = []
      for (let k = 0; k < 2; k++) {
        const s = k ? 1 : -1
        const shoulder = new Group()
        shoulder.position.set(0.03, 0.07, s * 0.06)
        bd.add(shoulder)
        const inner = new Mesh(track(new BoxGeometry(0.24, 0.014, 0.3)), gm)
        inner.position.set(-0.02, 0, s * 0.15)
        inner.rotation.y = -s * 0.1
        inner.castShadow = true
        shoulder.add(inner)
        const elbow = new Group()
        elbow.position.set(0, 0, s * 0.3)
        shoulder.add(elbow)
        const outer = new Mesh(track(new BoxGeometry(0.19, 0.012, 0.32)), wm)
        outer.position.set(-0.03, 0, s * 0.16)
        outer.rotation.y = -s * 0.32
        elbow.add(outer)
        const tip = new Mesh(track(new BoxGeometry(0.12, 0.013, 0.09)), dm)
        tip.position.set(-0.05, 0, s * 0.32)
        tip.rotation.y = -s * 0.32
        elbow.add(tip)
        sh.push(shoulder)
        el.push(elbow)
      }
      g.scale.setScalar(1.25)
      scene.add(g)
      gulls.push({ g, bd, sh, el, ph: sd * 1.9, sp: 0.2 + ihash(sd, 1, seed) * 0.09, fw: 4.0 + ihash(sd, 2, seed) * 1.5, r: 9 + ihash(sd, 3, seed) * 4.5, h: 6.5 + ihash(sd, 4, seed) * 2.8 })
    }
  }

  // Neighbor isles: silhouettes of other players' moored islands, placed on
  // the horizon at their true bearing in sea-space. Windows glow at dusk.
  const nbMoundGeo = track(new IcosahedronGeometry(4, 0))
  const nbPeakGeo = track(new ConeGeometry(2.1, 4.6, 6))
  const nbLampGeo = track(new SphereGeometry(0.18, 5, 4))
  const nbMatA = std(0x55688a, 0.95)
  const nbMatB = std(0x49597a, 0.95)
  const nbLampMat = track(new MeshStandardMaterial({ color: 0x2a2f3a, emissive: 0xffc873, emissiveIntensity: 0 }))
  const nbRoot = new Group()
  scene.add(nbRoot)
  interface NbEntry {
    g: Group
    id: string
    label: string
    top: Vector3
  }
  const nbs: NbEntry[] = []
  let hoverNb: NbEntry | null = null
  const setNeighbors = (list: { id: string; label: string; score: number; bearing: number; dist: number }[]) => {
    for (const n of nbs) nbRoot.remove(n.g)
    nbs.length = 0
    list.forEach((n, i) => {
      const g = new Group()
      const s = 1.0 + Math.min(1.2, Math.log2(1 + n.score / 20) * 0.4)
      const m1 = new Mesh(nbMoundGeo, nbMatA)
      m1.scale.set(1.7, 0.8, 1.7)
      g.add(m1)
      const m2 = new Mesh(nbMoundGeo, nbMatB)
      m2.scale.set(1.05, 0.62, 1.05)
      m2.position.set(3.1, -0.4, -1.2)
      g.add(m2)
      const pk = new Mesh(nbPeakGeo, nbMatB)
      pk.position.set(-1.4, 3.2, 0.6)
      g.add(pk)
      const lampN = 3 + Math.min(5, Math.floor(n.score / 25))
      for (let k = 0; k < lampN; k++) {
        const l = new Mesh(nbLampGeo, nbLampMat)
        l.position.set((ihash(i, k, seed) - 0.5) * 5, 0.6 + ihash(k, i, seed) * 2.2, (ihash(i * 7, k, seed) - 0.5) * 5)
        g.add(l)
      }
      g.scale.setScalar(s)
      const R = 95 + n.dist * 35
      g.position.set(Math.cos(n.bearing) * R, -0.6, Math.sin(n.bearing) * R)
      g.rotation.y = ihash(i, 99, seed) * 6.28
      g.traverse((o) => {
        o.userData.nid = i
      })
      nbRoot.add(g)
      const top = new Vector3(g.position.x, s * 4.2, g.position.z)
      nbs.push({ g, id: n.id, label: n.label, top })
    })
  }

  // petals by day, fireflies by night
  const petMat = track(new MeshBasicMaterial({ color: 0xfff0f4, side: DoubleSide, transparent: true, opacity: 0.9 }))
  const petals: { m: Mesh; bx: number; bz: number; ph: number }[] = []
  for (let i = 0; i < 7; i++) {
    const m = new Mesh(track(new PlaneGeometry(0.1, 0.08)), petMat)
    const b = island.trees.length ? island.trees[i % island.trees.length]! : { x: 0, z: 0 }
    scene.add(m)
    petals.push({ m, bx: b.x, bz: b.z, ph: i * 1.7 })
  }
  const nFF = 40
  const ffGeo = track(new BufferGeometry())
  const ffBase = new Float32Array(nFF * 3)
  for (let i = 0; i < nFF; i++) {
    const p = gPts.length ? gPts[Math.floor(ihash(i, 9, seed) * gPts.length)]! : [0, 1, 0, 0]
    ffBase[i * 3] = p[0]!
    ffBase[i * 3 + 1] = p[1]! + 0.7 + ihash(i, 4, seed) * 1.6
    ffBase[i * 3 + 2] = p[2]!
  }
  ffGeo.setAttribute('position', new BufferAttribute(new Float32Array(nFF * 3), 3))
  const ffMat = track(
    new PointsMaterial({ color: 0xffe9a0, size: 0.3, sizeAttenuation: true, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false }),
  )
  scene.add(new Points(ffGeo, ffMat))

  // ------------------------------------------------------------- buildings
  const mkHouse = (): Group => {
    const g = new Group()
    const f = new Mesh(track(new CylinderGeometry(0.95, 1.1, 0.2, 9)), mats.stone)
    f.position.y = 0.06
    f.receiveShadow = true
    g.add(f)
    const b = new Mesh(track(new BoxGeometry(1.15, 0.85, 0.98)), mats.wall)
    b.position.y = 0.6
    b.castShadow = true
    g.add(b)
    const rg = track(new ConeGeometry(0.95, 0.65, 4))
    rg.rotateY(Math.PI / 4)
    const r = new Mesh(rg, mats.roof)
    r.position.y = 1.34
    r.scale.set(1.25, 1, 1.05)
    r.castShadow = true
    g.add(r)
    const ch = new Mesh(track(new BoxGeometry(0.16, 0.36, 0.16)), mats.stone)
    ch.position.set(0.3, 1.52, 0.12)
    g.add(ch)
    const w1 = new Mesh(track(new PlaneGeometry(0.28, 0.22)), winMat)
    w1.position.set(0.18, 0.66, 0.5)
    g.add(w1)
    const w2 = new Mesh(track(new PlaneGeometry(0.24, 0.22)), winMat)
    w2.position.set(0.578, 0.66, 0)
    w2.rotation.y = Math.PI / 2
    g.add(w2)
    addGlow(g, 0.18, 0.66, 0.62, 0.7, warmGlowMat, 'building')
    addGlow(g, 0.7, 0.66, 0, 0.6, warmGlowMat, 'building')
    const d = new Mesh(track(new PlaneGeometry(0.28, 0.44)), mats.door)
    d.position.set(-0.22, 0.4, 0.5)
    g.add(d)
    return g
  }
  const mkFisher = (): Group => {
    const g = new Group()
    for (let sx = 0; sx < 2; sx++) {
      for (let sz = 0; sz < 2; sz++) {
        const leg = new Mesh(track(new CylinderGeometry(0.05, 0.06, 0.55, 5)), mats.wood)
        leg.position.set(sx ? 0.38 : -0.38, 0.24, sz ? 0.3 : -0.3)
        leg.castShadow = true
        g.add(leg)
      }
    }
    const floor = new Mesh(track(new BoxGeometry(1.0, 0.08, 0.85)), mats.plank)
    floor.position.y = 0.52
    floor.castShadow = true
    g.add(floor)
    const hut = new Mesh(track(new BoxGeometry(0.85, 0.6, 0.7)), mats.drift)
    hut.position.y = 0.88
    hut.castShadow = true
    g.add(hut)
    const roof = new Mesh(track(new BoxGeometry(1.05, 0.06, 0.92)), mats.dark)
    roof.position.y = 1.24
    roof.rotation.z = 0.16
    roof.castShadow = true
    g.add(roof)
    const d = new Mesh(track(new PlaneGeometry(0.26, 0.4)), mats.teal)
    d.position.set(0, 0.78, 0.36)
    g.add(d)
    const w = new Mesh(track(new PlaneGeometry(0.2, 0.18)), winMat)
    w.position.set(0.43, 0.92, 0)
    w.rotation.y = Math.PI / 2
    g.add(w)
    addGlow(g, 0.55, 0.92, 0, 0.55, warmGlowMat, 'building')
    const p1 = new Mesh(track(new CylinderGeometry(0.03, 0.03, 0.8, 4)), mats.wood)
    p1.position.set(-0.75, 0.4, 0.25)
    g.add(p1)
    const p2 = new Mesh(track(new CylinderGeometry(0.03, 0.03, 0.8, 4)), mats.wood)
    p2.position.set(-0.75, 0.4, -0.25)
    g.add(p2)
    const bar = new Mesh(track(new CylinderGeometry(0.02, 0.02, 0.6, 4)), mats.wood)
    bar.rotation.x = Math.PI / 2
    bar.position.set(-0.75, 0.72, 0)
    g.add(bar)
    return g
  }
  const mkMill = (): Group => {
    const g = new Group()
    const f = new Mesh(track(new CylinderGeometry(0.85, 1.0, 0.2, 9)), mats.stone)
    f.position.y = 0.06
    g.add(f)
    const b = new Mesh(track(new CylinderGeometry(0.5, 0.72, 1.7, 6)), mats.wall)
    b.position.y = 1.02
    b.castShadow = true
    g.add(b)
    const r = new Mesh(track(new ConeGeometry(0.62, 0.55, 6)), mats.roofD)
    r.position.y = 2.14
    r.castShadow = true
    g.add(r)
    const d = new Mesh(track(new PlaneGeometry(0.3, 0.5)), mats.door)
    d.position.set(0, 0.45, 0.66)
    d.rotation.x = -0.06
    g.add(d)
    const bl = new Group()
    bl.position.set(0, 1.78, 0.56)
    for (let k = 0; k < 4; k++) {
      const hold = new Group()
      hold.rotation.z = (k * Math.PI) / 2
      const p = new Mesh(track(new BoxGeometry(0.14, 1.3, 0.03)), mats.wood)
      p.position.y = 0.65
      p.castShadow = true
      hold.add(p)
      bl.add(hold)
    }
    const hub = new Mesh(track(new SphereGeometry(0.1, 6, 5)), mats.wood)
    bl.add(hub)
    g.add(bl)
    mills.push(bl)
    return g
  }
  const mkField = (): Group => {
    const g = new Group()
    const plot = new Mesh(track(new BoxGeometry(1.5, 0.1, 1.5)), mats.soil)
    plot.position.y = 0.05
    plot.receiveShadow = true
    g.add(plot)
    for (let k = 0; k < 4; k++) {
      const row = new Mesh(track(new BoxGeometry(1.34, 0.14, 0.18)), mats.wheat)
      row.position.set(0, 0.14, -0.54 + k * 0.36)
      row.castShadow = true
      g.add(row)
      for (let s = 0; s < 3; s++) {
        const sheaf = new Mesh(track(new ConeGeometry(0.05, 0.22, 4)), std(0xe3c56b))
        sheaf.position.set(-0.45 + s * 0.45 + (ihash(k, s, seed) - 0.5) * 0.14, 0.3, -0.54 + k * 0.36)
        g.add(sheaf)
      }
    }
    return g
  }
  const mkShrine = (): Group => {
    const g = new Group()
    const base = new Mesh(track(new BoxGeometry(1.3, 0.15, 1.05)), mats.stone)
    base.position.y = 0.07
    base.receiveShadow = true
    g.add(base)
    for (const s of [-1, 1]) {
      const pillar = new Mesh(track(new CylinderGeometry(0.06, 0.07, 0.95, 6)), mats.red)
      pillar.position.set(s * 0.35, 0.55, 0.32)
      pillar.castShadow = true
      g.add(pillar)
      const lant = new Mesh(track(new CylinderGeometry(0.07, 0.09, 0.3, 6)), mats.stone)
      lant.position.set(s * 0.52, 0.3, 0.55)
      g.add(lant)
      const glow = new Mesh(track(new SphereGeometry(0.045, 6, 5)), lampMat)
      glow.position.set(s * 0.52, 0.48, 0.55)
      g.add(glow)
      addGlow(g, s * 0.52, 0.48, 0.55, 0.75, warmGlowMat, 'building')
      addGlow(g, s * 0.52, 0.1, 0.55, 1.1, poolGlowMat, 'building', true)
    }
    const lin1 = new Mesh(track(new BoxGeometry(1.05, 0.09, 0.13)), mats.red)
    lin1.position.set(0, 1.05, 0.32)
    lin1.castShadow = true
    g.add(lin1)
    const lin2 = new Mesh(track(new BoxGeometry(0.86, 0.06, 0.11)), mats.red)
    lin2.position.set(0, 0.86, 0.32)
    g.add(lin2)
    const hut = new Mesh(track(new BoxGeometry(0.62, 0.5, 0.5)), std(0xf2ede2))
    hut.position.set(0, 0.4, -0.18)
    hut.castShadow = true
    g.add(hut)
    const rg = track(new ConeGeometry(0.55, 0.4, 4))
    rg.rotateY(Math.PI / 4)
    const roof = new Mesh(rg, mats.roofD)
    roof.position.set(0, 0.83, -0.18)
    roof.scale.set(1.15, 1, 1.0)
    roof.castShadow = true
    g.add(roof)
    return g
  }
  const mkLighthouse = (): Group => {
    const g = new Group()
    const f = new Mesh(track(new CylinderGeometry(0.52, 0.68, 0.5, 10)), mats.stone)
    f.position.y = 0.25
    f.castShadow = true
    g.add(f)
    const b = new Mesh(track(new CylinderGeometry(0.3, 0.48, 1.9, 10)), mats.white)
    b.position.y = 1.45
    b.castShadow = true
    g.add(b)
    const b1 = new Mesh(track(new CylinderGeometry(0.445, 0.455, 0.3, 10)), mats.red)
    b1.position.y = 1.0
    g.add(b1)
    const b2 = new Mesh(track(new CylinderGeometry(0.375, 0.385, 0.3, 10)), mats.red)
    b2.position.y = 1.7
    g.add(b2)
    const gal = new Mesh(track(new TorusGeometry(0.32, 0.05, 6, 12)), mats.dark)
    gal.rotation.x = Math.PI / 2
    gal.position.y = 2.42
    g.add(gal)
    const lamp = new Mesh(track(new CylinderGeometry(0.2, 0.2, 0.28, 8)), lampMat)
    lamp.position.y = 2.56
    g.add(lamp)
    addGlow(g, 0, 2.56, 0, 2.1, warmGlowMat, 'building')
    const cap = new Mesh(track(new ConeGeometry(0.28, 0.3, 10)), mats.roofD)
    cap.position.y = 2.85
    g.add(cap)
    const bg2 = track(new ConeGeometry(2.0, 11, 14, 1, true))
    bg2.translate(0, -5.5, 0)
    bg2.rotateZ(-Math.PI / 2)
    const beam = new Mesh(bg2, beamMat)
    const bgrp = new Group()
    bgrp.add(beam)
    bgrp.position.y = 2.56
    g.add(bgrp)
    beams.push({ g: bgrp, up: false })
    return g
  }
  const mkObservatory = (): Group => {
    const g = new Group()
    const f = new Mesh(track(new CylinderGeometry(0.55, 0.68, 0.4, 8)), mats.stone)
    f.position.y = 0.2
    f.castShadow = true
    g.add(f)
    const b = new Mesh(track(new CylinderGeometry(0.42, 0.52, 1.3, 8)), mats.white)
    b.position.y = 1.05
    b.castShadow = true
    g.add(b)
    const dome = new Mesh(track(new SphereGeometry(0.48, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)), std(0x8fa0b4, 0.6))
    dome.position.y = 1.7
    dome.castShadow = true
    g.add(dome)
    const slit = new Mesh(track(new PlaneGeometry(0.12, 0.42)), lampMat)
    slit.position.set(0, 1.92, 0.44)
    slit.rotation.x = -0.55
    g.add(slit)
    addGlow(g, 0, 1.95, 0.5, 1.0, coolGlowMat, 'building')
    const d = new Mesh(track(new PlaneGeometry(0.28, 0.44)), mats.door)
    d.position.set(0, 0.42, 0.53)
    g.add(d)
    const bg2 = track(new ConeGeometry(0.9, 9, 12, 1, true))
    bg2.translate(0, 4.5, 0)
    const beam = new Mesh(bg2, beamMat)
    const bgrp = new Group()
    bgrp.add(beam)
    bgrp.position.y = 1.9
    bgrp.rotation.z = 0.22
    g.add(bgrp)
    beams.push({ g: bgrp, up: true })
    return g
  }
  const factories: Record<BType, () => Group> = {
    house: mkHouse,
    fisher: mkFisher,
    mill: mkMill,
    field: mkField,
    shrine: mkShrine,
    lighthouse: mkLighthouse,
    observatory: mkObservatory,
  }

  // ------------------------------------------------------ ghost + overlay
  const ghostMat = track(new MeshBasicMaterial({ color: 0x9fe08a, transparent: true, opacity: 0.45, depthWrite: false }))
  const ringMat = track(
    new MeshBasicMaterial({ color: 0x9fe08a, transparent: true, opacity: 0.5, blending: AdditiveBlending, depthWrite: false, side: DoubleSide, fog: false }),
  )
  const ringGeo = track(new RingGeometry(1.62, 1.78, 48))
  ringGeo.rotateX(-Math.PI / 2)
  const ring = new Mesh(ringGeo, ringMat)
  ring.visible = false
  scene.add(ring)
  let ghost: Group | null = null
  const setGhostType = (t: BType | null) => {
    if (ghost) {
      scene.remove(ghost)
      ghost = null
    }
    if (!t) {
      ring.visible = false
      return
    }
    const millsN = mills.length
    const beamsN = beams.length
    const glowsN = buildingGlows.length
    ghost = factories[t]()
    mills.length = millsN
    beams.length = beamsN
    buildingGlows.length = glowsN
    ghost.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      if (m.userData.isGlow) {
        m.visible = false
        return
      }
      m.material = ghostMat
      m.castShadow = false
    })
    ghost.visible = false
    scene.add(ghost)
  }

  const anims: { g: Group; t0: number }[] = []
  const buildingGroups: Group[] = []
  const addBuilding = (p: Placed) => {
    const g = factories[p.t]()
    g.position.set(p.x, terr(p.x, p.z) - 0.02, p.z)
    g.rotation.y = p.rot
    scene.add(g)
    anims.push({ g, t0: tNow })
    buildingGroups.push(g)
  }

  // --------------------------------------------------------------- runtime
  const post: Post = createPost(renderer)
  const ray = new Raycaster()
  const mouse = new Vector2(9, 9)
  let az = 0.85
  let pol = 1.1
  let tNow = 0
  let mixv = 0
  let mixTgt = 0
  let settled = false
  let lastActive = -9
  let hover: { x: number; z: number } | null = null

  const DAY = {
    sun: pair(0xffdfae, 0x8fa3d8, sun.color),
    hemi: pair(0xd8ecf8, 0x3a4a6a, hemi.color),
    fog: pair(0xf2dfc0, 0x131b32, fog.color),
    hor: pair(0xf7e4c3, 0x253052, skyUni.uHor.value),
    zen: pair(0x8cc7e6, 0x0b1326, skyUni.uZen.value),
    haze: pair(0xfff3dd, 0x2e3a5e, skyUni.uHaze.value),
    sunC: pair(0xffe8b8, 0xd8e2f8, skyUni.uSunCol.value),
    wSunC: pair(0xffedc2, 0xd8e2f8, waterUni.uSunCol.value),
    shal: pair(0x5fcfc0, 0x1e4653, waterUni.uShallow.value),
    deep: pair(0x175d80, 0x0d2438, waterUni.uDeep.value),
    foam: pair(0xf7fdf7, 0x9fb8c8, waterUni.uFoam.value),
    skyR: pair(0xbfe3f2, 0x1a2440, waterUni.uSky.value),
  }
  const sunDay = new Vector3(27, 18, 8)
  const sunNight = new Vector3(-20, 24, -14)
  const sunCur = new Vector3()

  const updCam = () => {
    const rad = 44 + 1.4 * Math.sin(tNow * 0.1)
    const ty = 2.0
    camera.position.set(rad * Math.sin(pol) * Math.cos(az), ty + rad * Math.cos(pol), rad * Math.sin(pol) * Math.sin(az))
    camera.lookAt(0, ty, 0)
  }

  const api: IsleScene = {
    dragging: false,
    resize(w, h) {
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.fov = camera.aspect < 0.95 ? 44 : 34
      camera.updateProjectionMatrix()
      post.setSize(w, h)
    },
    orbitBy(dx, dy) {
      az += dx * 0.006
      pol = Math.max(0.9, Math.min(1.38, pol + dy * 0.004))
      lastActive = tNow
    },
    setPointer(nx, ny) {
      mouse.set(nx, ny)
      lastActive = tNow
    },
    pickGround() {
      return hover
    },
    setGhostType,
    setGhostState(ok, positive) {
      const hex = ok ? (positive ? 0x9fe08a : 0xffc86e) : 0xff8f7a
      ghostMat.color.setHex(hex)
      ringMat.color.setHex(hex)
    },
    refreshOverlay(tier) {
      const greenA = ovGreen.attr.array as Float32Array
      const goldA = ovGold.attr.array as Float32Array
      let gn = 0
      let go = 0
      for (let v = 0; v < gIdx.length; v += 3) {
        const base = v * 3
        const cx = (tp[base]! + tp[base + 3]! + tp[base + 6]!) / 3
        const cz = (tp[base + 2]! + tp[base + 5]! + tp[base + 8]!) / 3
        const t = tier(cx, cz)
        if (t === 0) continue
        const arr = t === 2 ? goldA : greenA
        const at = t === 2 ? go : gn
        for (let k = 0; k < 9; k++) arr[at + k] = tp[base + k]! + (k % 3 === 1 ? 0.08 : 0)
        if (t === 2) go = at + 9
        else gn = at + 9
      }
      ovGreen.attr.needsUpdate = true
      ovGold.attr.needsUpdate = true
      ovGreen.geo.setDrawRange(0, gn / 3)
      ovGold.geo.setDrawRange(0, go / 3)
    },
    overlayWake() {
      lastActive = tNow
    },
    addBuilding,
    resetBuildings() {
      for (const g of buildingGroups) scene.remove(g)
      buildingGroups.length = 0
      anims.length = 0
      mills.length = 0
      beams.length = 0
      buildingGlows.length = 0
    },
    unsettle() {
      settled = false
      mixTgt = 0
    },
    setLamps(n) {
      const lit = Math.min(20, Math.max(0, n))
      lampSlots.forEach((g, i) => {
        g.visible = i < lit
      })
    },
    setNeighbors,
    pickNeighbor() {
      return hoverNb ? { id: hoverNb.id, label: hoverNb.label, top: hoverNb.top } : null
    },
    project(x, y, z) {
      P4.set(x, y, z).project(camera)
      if (P4.z > 1) return null
      return { x: (P4.x * 0.5 + 0.5), y: (-P4.y * 0.5 + 0.5) }
    },
    setNightTarget(t) {
      mixTgt = Math.max(0, Math.min(1, t))
    },
    settle() {
      settled = true
      mixTgt = 1
    },
    frame(dt) {
      tNow += dt
      const idleSpin = settled ? 0.12 : ghost && ghost.visible ? 0 : 0.03
      az += dt * idleSpin * (api.dragging ? 0 : 1)
      updCam()
      mixv += (mixTgt - mixv) * Math.min(1, dt * (settled ? 0.7 : 1.8))
      for (const k of Object.keys(DAY) as (keyof typeof DAY)[]) {
        const p = DAY[k]
        p.into.lerpColors(p.d, p.n, mixv)
      }
      sun.intensity = 1.6 - 1.25 * mixv
      sun.position.lerpVectors(sunDay, sunNight, mixv)
      sunCur.copy(sun.position).normalize()
      hemi.intensity = 0.5 - 0.36 * mixv
      rim.intensity = 0.3 - 0.16 * mixv
      winMat.emissiveIntensity = 1.9 * mixv
      lampMat.emissiveIntensity = 0.6 + 1.8 * mixv
      nbLampMat.emissiveIntensity = 1.5 * mixv
      const nightGlow = smooth(0.35, 0.85, mixv)
      warmGlowMat.uniforms.uAlpha!.value = 0.8 * nightGlow * (0.93 + 0.07 * Math.sin(tNow * 2.7))
      poolGlowMat.uniforms.uAlpha!.value = 0.38 * nightGlow * (0.9 + 0.1 * Math.sin(tNow * 2.1 + 1.7))
      coolGlowMat.uniforms.uAlpha!.value = 0.75 * nightGlow * (0.94 + 0.06 * Math.sin(tNow * 1.9 + 3.1))
      for (const arr of [staticGlows, buildingGlows]) {
        for (const m of arr) {
          if (!m.userData.flat) m.quaternion.copy(camera.quaternion)
        }
      }
      beamMat.opacity = 0.11 * smooth(0.55, 0.95, mixv)
      starMat.opacity = 0.9 * mixv
      cloudMat.opacity = 0.9 - 0.66 * mixv
      post.setNight(mixv)
      waterUni.uTime.value = tNow
      waterUni.uSunDir.value.copy(sunCur)
      waterUni.uFog.value.copy(fog.color)
      skyUni.uSunDir.value.copy(sunCur)
      ffMat.opacity = 0.85 * smooth(0.5, 0.85, mixv)
      petMat.opacity = 0.9 * (1 - smooth(0.3, 0.6, mixv))
      const fp2 = ffGeo.attributes.position!.array as Float32Array
      for (let i = 0; i < nFF; i++) {
        fp2[i * 3] = ffBase[i * 3]! + Math.sin(tNow * 0.7 + i * 1.3) * 0.5
        fp2[i * 3 + 1] = ffBase[i * 3 + 1]! + Math.sin(tNow * 1.1 + i * 2.1) * 0.3
        fp2[i * 3 + 2] = ffBase[i * 3 + 2]! + Math.cos(tNow * 0.6 + i) * 0.5
      }
      ffGeo.attributes.position!.needsUpdate = true
      for (const p of petals) {
        p.m.position.set(
          p.bx + Math.sin(tNow * 0.5 + p.ph) * 1.6,
          terr(p.bx, p.bz) + 1.2 + Math.sin(tNow * 0.9 + p.ph * 1.3) * 0.6,
          p.bz + Math.cos(tNow * 0.4 + p.ph) * 1.6,
        )
        p.m.rotation.set(tNow * 1.5 + p.ph, tNow * 1.1, 0)
      }
      for (const s of sway) {
        s.can.rotation.z = 0.03 * Math.sin(tNow * 1.1 + s.ph)
        s.can.rotation.x = 0.02 * Math.sin(tNow * 0.9 + s.ph * 2)
      }
      rowboat.position.y = 0.06 + 0.05 * Math.sin(tNow * 1.2)
      rowboat.rotation.z = 0.03 * Math.sin(tNow * 1.4)
      const act = ghost && ghost.visible ? 1 : 1 - smooth(2.0, 4.5, tNow - lastActive)
      const pulse = act * (0.85 + 0.15 * Math.sin(tNow * 2.4)) * (1 - 0.35 * mixv)
      ovGreen.mat.opacity = ovGreen.alpha * pulse
      ovGold.mat.opacity = ovGold.alpha * pulse
      for (const m of mills) m.rotation.z += dt * 1.3
      for (const b of beams) {
        if (b.up) b.g.rotation.y += dt * 0.25
        else b.g.rotation.y += dt * 0.5
      }
      for (const c of clouds) c.rotation.y += dt * 0.004
      const ba = tNow * 0.04
      boat.position.set(Math.cos(ba) * 17.5, 0.05 + 0.07 * Math.sin(tNow * 1.1), Math.sin(ba) * 17.5)
      boat.rotation.y = -ba - Math.PI / 2
      boatIn.rotation.z = -0.07 + 0.04 * Math.sin(tNow * 0.9)
      boatIn.rotation.x = 0.03 * Math.sin(tNow * 1.3)
      if (flag) flag.rotation.y = 0.45 * Math.sin(tNow * 5.5)
      for (const u of gulls) {
        const a = tNow * u.sp + u.ph
        u.g.position.set(Math.cos(a) * u.r, u.h + Math.sin(tNow * 0.5 + u.ph) * 0.6, Math.sin(a) * u.r)
        u.g.rotation.y = -a - Math.PI / 2
        const glide = 0.5 + 0.5 * Math.sin(tNow * 0.14 + u.ph * 2.3)
        const amp = 0.12 + (1 - glide) * 0.6
        const fl = Math.sin(tNow * u.fw + u.ph * 5)
        const fl2 = Math.sin(tNow * u.fw - 0.8 + u.ph * 5)
        for (let k = 0; k < 2; k++) {
          const s = k ? 1 : -1
          u.sh[k]!.rotation.x = s * (fl * amp + 0.15 * glide)
          u.el[k]!.rotation.x = s * fl2 * amp * 1.35
        }
        u.bd.rotation.x = 0.18
        u.bd.rotation.z = 0.06 * fl * amp
        u.bd.position.y = 0.06 * Math.sin(tNow * u.fw * 0.5 + u.ph)
      }
      for (let i = anims.length - 1; i >= 0; i--) {
        const a = anims[i]!
        const k = Math.min(1, (tNow - a.t0) / 0.4)
        const c1 = 1.70158
        const e = 1 + (c1 + 1) * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2)
        a.g.scale.setScalar(Math.max(0.05, e))
        if (k >= 1) {
          a.g.scale.setScalar(1)
          anims.splice(i, 1)
        }
      }
      hover = null
      hoverNb = null
      if (!api.dragging) {
        ray.setFromCamera(mouse, camera)
        if (ghost) {
          const hit = ray.intersectObject(terrain)[0]
          if (hit) {
            const hx = hit.point.x
            const hz = hit.point.z
            hover = { x: hx, z: hz }
            ghost.visible = true
            ring.visible = true
            const h = terr(hx, hz)
            ghost.position.set(hx, h - 0.02, hz)
            ring.position.set(hx, Math.max(h + 0.12, 0.3), hz)
          } else {
            ghost.visible = false
            ring.visible = false
          }
        }
        if (!hover && nbs.length) {
          const nHit = ray.intersectObject(nbRoot, true)[0]
          if (nHit) {
            const nid = nHit.object.userData.nid as number | undefined
            if (nid !== undefined && nbs[nid]) hoverNb = nbs[nid]!
          }
        }
      } else if (ghost) {
        ghost.visible = false
        ring.visible = false
      }
      post.render(scene, camera)
    },
    dispose() {
      post.dispose()
      for (const d of disposables) d.dispose()
      renderer.dispose()
    },
  }
  return api
}
