import * as THREE from 'three';
import { PALETTE } from '../palette.ts';
import type { ShieldFrame } from './cast-timing.ts';

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uRim;
uniform vec3 uCell;
uniform float uLevel;
uniform float uSpin;
uniform float uLock;
uniform float uPulse;
varying vec2 vUv;

const float TAU = 6.28318530718;

// Distance to a hex cell's edge (0 at the centre, 0.5 on the edge) and the cell-local point.
vec2 hexLocal(vec2 p) {
  vec2 r = vec2(1.0, 1.7320508);
  vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h;
  vec2 b = mod(p - h, r) - h;
  return dot(a, a) < dot(b, b) ? a : b;
}

float hexEdge(vec2 g) {
  g = abs(g);
  return max(dot(g, vec2(0.5, 0.8660254)), g.x);
}

float line(float d, float w) {
  return 1.0 - smoothstep(0.0, w, abs(d));
}

// A rune ring at radius 'at': dashes of glyph marks, closed over 'arc' turns from angle 'turn'.
float runeRing(float r, float a, float at, float turn, float arc, float marks) {
  float band = line(r - at, 0.016);
  float u = fract((a - turn) / TAU);
  float drawn = step(u, arc);
  float tick = smoothstep(0.15, 0.3, fract(u * marks)) * (1.0 - smoothstep(0.7, 0.85, fract(u * marks)));
  float glyph = line(r - at, 0.045) * tick * 0.6;
  return (band + glyph) * drawn;
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  float a = atan(p.y, p.x);
  // Fresnel-like dome: the faint body brightens toward a hot rim.
  float dome = pow(r, 4.0);
  float rim = line(r - 0.965, 0.025) + 0.28 * dome;
  vec2 g = hexLocal(p * 4.2);
  float cells = smoothstep(0.44, 0.49, hexEdge(g)) * (0.12 + 0.88 * dome) * uLock;
  float rings = runeRing(r, a, 0.86, uSpin, uLock, 24.0) + 0.8 * runeRing(r, -a, 0.7, uSpin * 1.6, uLock, 16.0);
  vec3 color = uRim * (rim + rings * 0.8) + uCell * (cells * 0.4 + 0.015);
  color += (uRim * 0.6 + vec3(0.4)) * uPulse * (0.15 + rim);
  gl_FragColor = vec4(color * uLevel * 0.8, 1.0);
  #include <colorspace_fragment>
}`;

const linear = (hex: string): THREE.Color => new THREE.Color(hex);

/**
 * The ward shield: one translucent glowing disc facing the player, with a hot candle-amber rim,
 * faint brass hex cells and two rune rings that swirl in and lock with a pulse, then fade. One
 * additive mesh and shader, allocated once and reused for every block; `frame` drives it.
 */
export class WardShield extends THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  constructor() {
    super(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: {
          uRim: { value: linear(PALETTE.candle).multiplyScalar(1.25) },
          uCell: { value: linear(PALETTE.brass) },
          uLevel: { value: 0 },
          uSpin: { value: 0 },
          uLock: { value: 1 },
          uPulse: { value: 0 },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    this.name = 'cast-fx-shield';
    this.frustumCulled = false;
    this.renderOrder = 2;
    this.raycast = () => undefined;
    this.visible = false;
  }

  /** Brightness the shader draws at now (0: hidden). */
  get level(): number {
    return this.material.uniforms.uLevel?.value as number;
  }

  /** Places the disc at `centre` in the plane of `right` and `up`. */
  place(centre: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): void {
    const normal = right.clone().cross(up).normalize();
    this.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
    this.position.copy(centre);
  }

  /** Draws frame `f` at `radius` metres and brightness `gain`. */
  apply(f: ShieldFrame, radius: number, gain: number): void {
    const u = this.material.uniforms;
    const level = f.level * gain;
    (u.uLevel as THREE.IUniform<number>).value = level;
    (u.uSpin as THREE.IUniform<number>).value = f.spin;
    (u.uLock as THREE.IUniform<number>).value = f.lock;
    (u.uPulse as THREE.IUniform<number>).value = f.pulse;
    this.scale.setScalar(radius * f.radius);
    this.visible = level > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
