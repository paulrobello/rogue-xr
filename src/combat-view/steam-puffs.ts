import * as THREE from 'three';

/** Puff texture size, texels (a power of two, so it mipmaps). */
const PUFF_TEXELS = 64;

const VERTEX = /* glsl */ `
attribute vec4 aPuff;
attribute vec2 aLook;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vUv = uv;
  vAlpha = aLook.x;
  vec4 mv = modelViewMatrix * vec4(aPuff.xyz, 1.0);
  float c = cos(aLook.y);
  float s = sin(aLook.y);
  mv.xy += mat2(c, s, -s, c) * position.xy * aPuff.w;
  gl_Position = aLook.x > 0.0 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
varying vec2 vUv;
varying float vAlpha;
void main() {
  float a = texture2D(uMap, vUv).r * vAlpha;
  if (a < 0.004) discard;
  // A touch of self-shade low in the puff gives it volume without darkening what is behind.
  gl_FragColor = vec4(uColor * mix(0.86, 1.0, vUv.y), a);
  #include <colorspace_fragment>
}`;

function hash(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy);
  const b = hash(ix + 1, iy);
  const c = hash(ix, iy + 1);
  const d = hash(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * A soft, lumpy steam puff (opacity in the red channel): a round falloff whose edge and body are
 * broken by value noise, so rotated copies read as billows rather than discs. Generated in code,
 * deterministic, no asset.
 */
export function puffTexture(): THREE.DataTexture {
  const n = PUFF_TEXELS;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n - 0.5;
      const v = (y + 0.5) / n - 0.5;
      const lumps = 0.6 * valueNoise(u * 6 + 3, v * 6 + 7) + 0.4 * valueNoise(u * 13 + 1, v * 13);
      const r = Math.hypot(u, v) * 2 * (0.82 + 0.36 * lumps);
      const body = Math.min(1, 1.7 * Math.max(0, 1 - r)) ** 1.2;
      const a = Math.round(255 * Math.min(1, body * (0.7 + 0.45 * lumps)));
      const i = (y * n + x) * 4;
      data[i] = a;
      data[i + 1] = a;
      data[i + 2] = a;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, n, n);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Steam puffs: camera-facing soft sprites with normal alpha blending, so steam whitens what is
 * behind it (bright brass included) and never adds glow. `capacity` instances in one draw; every
 * buffer is allocated up front and written by the owner through `puff` and `hide`.
 */
export class SteamPuffs extends THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial> {
  /** Per puff: centre xyz, size (metres across). */
  readonly puffData: Float32Array;
  /** Per puff: opacity, rotation (radians). */
  readonly lookData: Float32Array;
  private readonly puffAttr: THREE.InstancedBufferAttribute;
  private readonly lookAttr: THREE.InstancedBufferAttribute;
  private readonly texture = puffTexture();

  constructor(capacity: number, color: THREE.Color) {
    const geometry = new THREE.InstancedBufferGeometry();
    const quad = new THREE.PlaneGeometry(1, 1);
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    geometry.setAttribute('uv', quad.getAttribute('uv'));
    const puffData = new Float32Array(capacity * 4);
    const lookData = new Float32Array(capacity * 2);
    const puffAttr = new THREE.InstancedBufferAttribute(puffData, 4);
    const lookAttr = new THREE.InstancedBufferAttribute(lookData, 2);
    puffAttr.setUsage(THREE.DynamicDrawUsage);
    lookAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aPuff', puffAttr);
    geometry.setAttribute('aLook', lookAttr);
    geometry.instanceCount = capacity;
    super(
      geometry,
      new THREE.ShaderMaterial({
        uniforms: { uMap: { value: null }, uColor: { value: color } },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.NormalBlending,
        toneMapped: false,
      }),
    );
    (this.material.uniforms.uMap as THREE.IUniform<THREE.Texture>).value = this.texture;
    this.puffData = puffData;
    this.lookData = lookData;
    this.puffAttr = puffAttr;
    this.lookAttr = lookAttr;
    this.name = 'cast-fx-steam';
    this.frustumCulled = false;
    this.renderOrder = 3;
    this.raycast = () => undefined;
    this.visible = false;
  }

  /** Writes puff `i`: centre, size across (metres), opacity and rotation. */
  puff(i: number, x: number, y: number, z: number, size: number, alpha: number, rot: number) {
    const p = this.puffData;
    p[i * 4] = x;
    p[i * 4 + 1] = y;
    p[i * 4 + 2] = z;
    p[i * 4 + 3] = size;
    this.lookData[i * 2] = alpha;
    this.lookData[i * 2 + 1] = rot;
  }

  /** Hides puff `i`. */
  hide(i: number): void {
    this.lookData[i * 2] = 0;
  }

  /** Uploads this frame's puffs; `lit` false hides the draw. */
  commit(lit: boolean): void {
    this.puffAttr.needsUpdate = true;
    this.lookAttr.needsUpdate = true;
    this.visible = lit;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
