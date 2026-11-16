import * as THREE from 'three';
import { DEFAULT_VIGNETTE } from './locomotion.ts';

/** The overlay quad sits this far in front of the eye, beyond the 0.05 m near plane. */
const OVERLAY_DISTANCE = 0.1;
/** XR draws on the union of both eyes' frusta; oversize so each eye's outer edge is covered. */
const XR_OVERSIZE = 1.15;
/** Below this strength the pass is skipped entirely. */
const VISIBLE_AT = 0.004;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// r = 1 is the edge of the view (elliptical on wide views). The clear aperture closes from about
// the full view toward 0.55 as the strength rises, and the shade deepens with it. The centre of the
// view never darkens.
const FRAGMENT = /* glsl */ `
varying vec2 vUv;
uniform float strength;
uniform float span;
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * span;
  float r = length(p);
  float inner = mix(1.05, 0.55, strength);
  float shade = smoothstep(inner, inner + 0.5, r) * (0.3 + 0.7 * strength);
  if (shade < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, shade);
}`;

/**
 * The comfort vignette: a camera-locked quad in its own scene, drawn in XR after the boards and
 * before the red hit flash, so the two stack. `update` takes `Locomotion.vignetteStrength` (0 to
 * the vignette cap) and darkens a radial edge band that closes in as the strength rises.
 */
export class ComfortVignette {
  readonly scene = new THREE.Scene();
  readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  private readonly anchor = new THREE.Group();
  private readonly uniforms = { strength: { value: 0 }, span: { value: 1 } };
  /** Debug: when set, shown instead of the locomotion strength, for pixel checks at a fixed pose. */
  hold: number | null = null;

  constructor() {
    this.scene.name = 'comfort-vignette';
    this.anchor.matrixAutoUpdate = false;
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: this.uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.quad.name = 'comfort-vignette';
    this.quad.frustumCulled = false;
    this.quad.renderOrder = 9_000;
    this.quad.position.z = -OVERLAY_DISTANCE;
    this.quad.visible = false;
    this.anchor.add(this.quad);
    this.scene.add(this.anchor);
  }

  /** The shown strength as 0 to 1 of the cap, 0 when idle. */
  get strength(): number {
    return this.uniforms.strength.value;
  }

  /** True while the pass is worth rendering. */
  get active(): boolean {
    return this.quad.visible;
  }

  /**
   * Sets the strength (`raw` is `Locomotion.vignetteStrength`, up to `DEFAULT_VIGNETTE.maxStrength`)
   * and locks the quad to `camera`. `tan` is the half-extent of the view at unit distance.
   */
  update(raw: number, camera: THREE.Camera, tan: { x: number; y: number }, xr = false): void {
    const k = Math.min(1, Math.max(0, (this.hold ?? raw) / DEFAULT_VIGNETTE.maxStrength));
    this.uniforms.strength.value = k;
    this.quad.visible = k > VISIBLE_AT;
    if (!this.quad.visible) return;
    camera.updateMatrixWorld();
    this.anchor.matrix.copy(camera.matrixWorld);
    this.anchor.matrixWorldNeedsUpdate = true;
    const over = xr ? XR_OVERSIZE : 1;
    this.uniforms.span.value = over;
    this.quad.scale.set(tan.x * OVERLAY_DISTANCE * over, tan.y * OVERLAY_DISTANCE * over, 1);
    this.scene.updateMatrixWorld(true);
  }

  dispose(): void {
    this.quad.geometry.dispose();
    this.quad.material.dispose();
  }
}
