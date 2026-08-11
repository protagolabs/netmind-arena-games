/**
 * Hand-written types for the vendored three.js subset (three-core.js).
 * Declares exactly the surface this world uses — @types/three would need a
 * package.json dependency, which a worlds-only PR cannot add.
 */

export class Color {
  constructor(hex?: number)
  r: number
  g: number
  b: number
  setHex(hex: number): this
  setHSL(h: number, s: number, l: number): this
  offsetHSL(h: number, s: number, l: number): this
  multiplyScalar(s: number): this
  lerp(c: Color, t: number): this
  lerpColors(a: Color, b: Color, t: number): this
  copy(c: Color): this
  clone(): Color
}

export class Vector2 {
  constructor(x?: number, y?: number)
  x: number
  y: number
  set(x: number, y: number): this
}

export class Vector3 {
  constructor(x?: number, y?: number, z?: number)
  x: number
  y: number
  z: number
  set(x: number, y: number, z: number): this
  setScalar(s: number): this
  copy(v: Vector3): this
  normalize(): this
  lerpVectors(a: Vector3, b: Vector3, t: number): this
  project(camera: PerspectiveCamera): this
}

export class Euler {
  x: number
  y: number
  z: number
  set(x: number, y: number, z: number): this
}

export class Quaternion {
  identity(): this
  setFromEuler(e: Euler): this
  copy(q: Quaternion): this
}

export class Matrix4 {
  compose(position: Vector3, quaternion: Quaternion, scale: Vector3): this
}

declare class Object3DBase {
  position: Vector3
  rotation: Euler
  quaternion: Quaternion
  scale: Vector3
  visible: boolean
  castShadow: boolean
  receiveShadow: boolean
  frustumCulled: boolean
  userData: Record<string, unknown>
  add(...objects: Object3DBase[]): this
  remove(...objects: Object3DBase[]): this
  traverse(cb: (o: Object3DBase) => void): void
  lookAt(x: number, y: number, z: number): void
}

export class Object3D extends Object3DBase {}
export class Group extends Object3DBase {}

export class BufferAttribute {
  constructor(array: ArrayLike<number>, itemSize: number)
  count: number
  array: ArrayLike<number>
  needsUpdate: boolean
  getX(i: number): number
  getY(i: number): number
  getZ(i: number): number
}

export class BufferGeometry {
  attributes: Record<string, BufferAttribute>
  setAttribute(name: string, attr: BufferAttribute): this
  computeVertexNormals(): void
  setDrawRange(start: number, count: number): void
  drawRange: { start: number; count: number }
  rotateX(rad: number): this
  rotateY(rad: number): this
  rotateZ(rad: number): this
  translate(x: number, y: number, z: number): this
  scale(x: number, y: number, z: number): this
  toNonIndexed(): BufferGeometry
  dispose(): void
}

export class PlaneGeometry extends BufferGeometry {
  constructor(w?: number, h?: number, ws?: number, hs?: number)
}
export class SphereGeometry extends BufferGeometry {
  constructor(r?: number, ws?: number, hs?: number, phiStart?: number, phiLength?: number, thetaStart?: number, thetaLength?: number)
}
export class ConeGeometry extends BufferGeometry {
  constructor(r?: number, h?: number, radial?: number, heightSeg?: number, openEnded?: boolean)
}
export class CylinderGeometry extends BufferGeometry {
  constructor(rTop?: number, rBottom?: number, h?: number, radial?: number)
}
export class BoxGeometry extends BufferGeometry {
  constructor(w?: number, h?: number, d?: number)
}
export class IcosahedronGeometry extends BufferGeometry {
  constructor(r?: number, detail?: number)
}
export class TorusGeometry extends BufferGeometry {
  constructor(r?: number, tube?: number, radialSeg?: number, tubularSeg?: number)
}
export class RingGeometry extends BufferGeometry {
  constructor(inner?: number, outer?: number, segments?: number)
}
export class CircleGeometry extends BufferGeometry {
  constructor(r?: number, segments?: number)
}

export interface MaterialParams {
  color?: number
  flatShading?: boolean
  roughness?: number
  metalness?: number
  transparent?: boolean
  opacity?: number
  emissive?: number
  emissiveIntensity?: number
  side?: number
  blending?: number
  depthWrite?: boolean
  depthTest?: boolean
  polygonOffset?: boolean
  polygonOffsetFactor?: number
  polygonOffsetUnits?: number
  fog?: boolean
  vertexColors?: boolean
  size?: number
  sizeAttenuation?: boolean
}

export class Material {
  color: Color
  opacity: number
  transparent: boolean
  visible: boolean
  emissive: Color
  emissiveIntensity: number
  side: number
  blending: number
  depthWrite: boolean
  depthTest: boolean
  needsUpdate: boolean
  dispose(): void
}

export class MeshStandardMaterial extends Material {
  constructor(params?: MaterialParams)
}
export class MeshBasicMaterial extends Material {
  constructor(params?: MaterialParams)
}
export class PointsMaterial extends Material {
  constructor(params?: MaterialParams)
}
export class ShaderMaterial extends Material {
  constructor(params?: {
    uniforms?: Record<string, { value: unknown }>
    vertexShader?: string
    fragmentShader?: string
    transparent?: boolean
    depthWrite?: boolean
    depthTest?: boolean
    side?: number
    blending?: number
  })
  // Pragmatically loose: uniform values span numbers, colors, vectors, textures.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uniforms: Record<string, { value: any }>
}

export class Mesh extends Object3DBase {
  constructor(geometry?: BufferGeometry, material?: Material)
  isMesh: boolean
  geometry: BufferGeometry
  material: Material
}

export class InstancedMesh extends Mesh {
  constructor(geometry: BufferGeometry, material: Material, count: number)
  instanceColor: { needsUpdate: boolean } | null
  setMatrixAt(i: number, m: Matrix4): void
  setColorAt(i: number, c: Color): void
}

export class Points extends Object3DBase {
  constructor(geometry?: BufferGeometry, material?: Material)
}

export class Fog {
  constructor(hex: number, near?: number, far?: number)
  color: Color
}

export class Scene extends Object3DBase {
  background: Color | null
  fog: Fog | null
}

export class PerspectiveCamera extends Object3DBase {
  constructor(fov?: number, aspect?: number, near?: number, far?: number)
  fov: number
  aspect: number
  updateProjectionMatrix(): void
}

export class OrthographicCamera extends Object3DBase {
  constructor(left: number, right: number, top: number, bottom: number, near: number, far: number)
}

declare class LightShadow {
  mapSize: { set(w: number, h: number): void }
  bias: number
  radius: number
  camera: { left: number; right: number; top: number; bottom: number; far: number }
}

export class DirectionalLight extends Object3DBase {
  constructor(hex?: number, intensity?: number)
  color: Color
  intensity: number
  shadow: LightShadow
  target: Object3DBase
}

export class HemisphereLight extends Object3DBase {
  constructor(sky?: number, ground?: number, intensity?: number)
  color: Color
  intensity: number
}

export class Raycaster {
  setFromCamera(ndc: Vector2, camera: PerspectiveCamera): void
  intersectObject(object: Object3DBase, recursive?: boolean): { point: Vector3; object: Object3DBase; instanceId?: number }[]
}

export class WebGLRenderTarget {
  constructor(w: number, h: number, options?: { minFilter?: number; magFilter?: number; format?: number; type?: number; depthBuffer?: boolean })
  texture: unknown
  setSize(w: number, h: number): void
  dispose(): void
}

export class WebGLRenderer {
  constructor(params?: { canvas?: HTMLCanvasElement; antialias?: boolean })
  shadowMap: { enabled: boolean; type: number }
  toneMapping: number
  toneMappingExposure: number
  setPixelRatio(r: number): void
  getPixelRatio(): number
  setSize(w: number, h: number, updateStyle?: boolean): void
  setRenderTarget(rt: WebGLRenderTarget | null): void
  render(scene: Scene, camera: PerspectiveCamera | OrthographicCamera): void
  dispose(): void
}

export const ACESFilmicToneMapping: number
export const PCFSoftShadowMap: number
export const BackSide: number
export const DoubleSide: number
export const AdditiveBlending: number
export const LinearFilter: number
export const RGBAFormat: number
export const HalfFloatType: number
export const NoToneMapping: number
