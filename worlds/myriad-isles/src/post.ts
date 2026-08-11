/**
 * Minimal post chain: scene → bright-pass → separable blur → composite with
 * split-tone grade, vignette and manual sRGB. Hand-rolled because
 * three/examples postprocessing imports the monolithic 'three' entry, which
 * would drag FileLoader's `fetch(` into the scanned bundle.
 */
import {
  WebGLRenderer,
  WebGLRenderTarget,
  Scene,
  PerspectiveCamera,
  OrthographicCamera,
  PlaneGeometry,
  ShaderMaterial,
  Mesh,
  Vector2,
  LinearFilter,
  RGBAFormat,
  HalfFloatType,
} from './three.js'

const QUAD_VS = `varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}`

const BRIGHT_FS = `
uniform sampler2D tSrc;uniform float uThr;varying vec2 vUv;
void main(){
vec3 c=texture2D(tSrc,vUv).rgb;
float l=dot(c,vec3(0.299,0.587,0.114));
float k=smoothstep(uThr,uThr+0.18,l);
gl_FragColor=vec4(c*k,1.0);}`

const BLUR_FS = `
uniform sampler2D tSrc;uniform vec2 uDir;varying vec2 vUv;
void main(){
vec3 a=vec3(0.0);
a+=texture2D(tSrc,vUv-uDir*3.2307).rgb*0.0702;
a+=texture2D(tSrc,vUv-uDir*1.3846).rgb*0.3162;
a+=texture2D(tSrc,vUv).rgb*0.2270;
a+=texture2D(tSrc,vUv+uDir*1.3846).rgb*0.3162;
a+=texture2D(tSrc,vUv+uDir*3.2307).rgb*0.0702;
gl_FragColor=vec4(a,1.0);}`

const FINAL_FS = `
uniform sampler2D tScene;uniform sampler2D tBloom;
uniform float uBloom;uniform float uNight;uniform float uExposure;
varying vec2 vUv;
vec3 aces(vec3 x){return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),vec3(0.0),vec3(1.0));}
void main(){
vec3 c=texture2D(tScene,vUv).rgb+texture2D(tBloom,vUv).rgb*uBloom;
c=aces(c*uExposure);
float l=dot(c,vec3(0.299,0.587,0.114));
c=mix(c*vec3(0.965,1.0,1.045),c*vec3(1.05,1.0,0.945),smoothstep(0.15,0.85,l));
c=mix(vec3(l),c,1.09);
float d=distance(vUv,vec2(0.5,0.46));
c*=1.0-smoothstep(0.52,0.95,d)*(0.3+0.12*uNight);
c=pow(max(c,vec3(0.0)),vec3(1.0/2.2));
gl_FragColor=vec4(c,1.0);}`

export interface Post {
  render(scene: Scene, camera: PerspectiveCamera): void
  setSize(w: number, h: number): void
  setNight(mix: number): void
  dispose(): void
}

export function createPost(renderer: WebGLRenderer): Post {
  const opts = { minFilter: LinearFilter, magFilter: LinearFilter, format: RGBAFormat, type: HalfFloatType, depthBuffer: true }
  const rtScene = new WebGLRenderTarget(2, 2, opts)
  const rtA = new WebGLRenderTarget(2, 2, { ...opts, depthBuffer: false })
  const rtB = new WebGLRenderTarget(2, 2, { ...opts, depthBuffer: false })

  const cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const quadScene = new Scene()
  const matBright = new ShaderMaterial({
    vertexShader: QUAD_VS,
    fragmentShader: BRIGHT_FS,
    uniforms: { tSrc: { value: null }, uThr: { value: 0.72 } },
    depthTest: false,
    depthWrite: false,
  })
  const matBlur = new ShaderMaterial({
    vertexShader: QUAD_VS,
    fragmentShader: BLUR_FS,
    uniforms: { tSrc: { value: null }, uDir: { value: new Vector2(0, 0) } },
    depthTest: false,
    depthWrite: false,
  })
  const matFinal = new ShaderMaterial({
    vertexShader: QUAD_VS,
    fragmentShader: FINAL_FS,
    uniforms: {
      tScene: { value: null },
      tBloom: { value: null },
      uBloom: { value: 0.4 },
      uNight: { value: 0 },
      uExposure: { value: 1.15 },
    },
    depthTest: false,
    depthWrite: false,
  })
  const quad = new Mesh(new PlaneGeometry(2, 2), matFinal)
  quadScene.add(quad)

  let bw = 1
  let bh = 1
  const pass = (mat: ShaderMaterial, into: WebGLRenderTarget | null) => {
    quad.material = mat
    renderer.setRenderTarget(into)
    renderer.render(quadScene, cam)
  }

  return {
    setSize(w, h) {
      const pr = renderer.getPixelRatio()
      rtScene.setSize(Math.max(2, Math.floor(w * pr)), Math.max(2, Math.floor(h * pr)))
      bw = Math.max(2, Math.floor((w * pr) / 2))
      bh = Math.max(2, Math.floor((h * pr) / 2))
      rtA.setSize(bw, bh)
      rtB.setSize(bw, bh)
    },
    setNight(mix) {
      matFinal.uniforms.uNight!.value = mix
      matFinal.uniforms.uBloom!.value = 0.4 + 0.55 * mix
      matFinal.uniforms.uExposure!.value = 1.15 - 0.27 * mix
      matBright.uniforms.uThr!.value = 0.85 - 0.35 * mix
    },
    render(scene, camera) {
      renderer.setRenderTarget(rtScene)
      renderer.render(scene, camera)
      matBright.uniforms.tSrc!.value = rtScene.texture
      pass(matBright, rtA)
      matBlur.uniforms.tSrc!.value = rtA.texture
      matBlur.uniforms.uDir!.value.set(1.6 / bw, 0)
      pass(matBlur, rtB)
      matBlur.uniforms.tSrc!.value = rtB.texture
      matBlur.uniforms.uDir!.value.set(0, 1.6 / bh)
      pass(matBlur, rtA)
      matFinal.uniforms.tScene!.value = rtScene.texture
      matFinal.uniforms.tBloom!.value = rtA.texture
      pass(matFinal, null)
      renderer.setRenderTarget(null)
    },
    dispose() {
      rtScene.dispose()
      rtA.dispose()
      rtB.dispose()
      quad.geometry.dispose()
      matBright.dispose()
      matBlur.dispose()
      matFinal.dispose()
    },
  }
}
