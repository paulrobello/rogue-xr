import * as THREE from 'three';
import { PALETTE } from '../palette.ts';
import type { PlayerHit } from './enemy-turn.ts';

/** Seconds the edge flash takes to rise, then to fade out. */
export const FLASH_RISE_SECONDS = 0.05;
export const FLASH_FADE_SECONDS = 0.5;
/** Peak edge opacity of a clean hit; a partial block peaks lower, a full block shows brass instead. */
export const HIT_PEAK = 0.62;
export const PARTIAL_PEAK = 0.42;
export const BLOCK_PEAK = 0.5;
/** Reduced motion: the flash peaks this much lower and rises and fades this much slower. */
export const REDUCED_PEAK_SCALE = 0.5;
const REDUCED_TIME_SCALE = 1.6;
/** The overlay quad sits this far in front of the eye, beyond the 0.05 m near plane. */
const OVERLAY_DISTANCE = 0.1;
/** XR draws on the union of both eyes' frusta; oversize so each eye's outer edge is covered. */
const XR_OVERSIZE = 1.15;
/** Brighter than the palette ruby, so the thin edge glow reads against the dark rooms. */
export const HIT_RED = '#c8281e';

export interface HapticActuatorLike {
  pulse?: (value: number, duration: number) => Promise<boolean> | boolean;
}
export interface HapticSourceLike {
  readonly gamepad?: { readonly hapticActuators?: readonly HapticActuatorLike[] } | null;
}

/**
 * Pulses the first haptic actuator of every source that has one; returns how many pulsed. Safe with
 * no sources, sources without a gamepad, gamepads without actuators, and rejected pulses.
 */
export function pulseHaptics(
  sources: Iterable<HapticSourceLike> | null | undefined,
  intensity: number,
  milliseconds: number,
): number {
  if (!sources) return 0;
  const value = Math.min(1, Math.max(0, intensity));
  let pulsed = 0;
  for (const source of sources) {
    const actuator = source.gamepad?.hapticActuators?.[0];
    if (typeof actuator?.pulse !== 'function') continue;
    try {
      const result = actuator.pulse(value, milliseconds);
      if (result instanceof Promise) result.catch(() => {});
      pulsed++;
    } catch {
      // A controller that refuses the pulse just stays still.
    }
  }
  return pulsed;
}

/** Haptic strength and length for a hit: stronger for more hit points lost, faint for a full block. */
export function hapticFor(hit: PlayerHit): { intensity: number; milliseconds: number } {
  if (hit.kind === 'blocked') return { intensity: 0.25, milliseconds: 50 };
  const intensity = Math.min(1, 0.45 + hit.hpLost / 20);
  return { intensity: hit.kind === 'partial' ? intensity * 0.8 : intensity, milliseconds: 110 };
}

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// The quad spans the view frustum times `span` (oversized in XR), so r = 1 is the edge of the view
// (elliptical on wide views).
// Damage: a red edge glow. Block: a brass ring that shimmers around the rim.
const FRAGMENT = /* glsl */ `
varying vec2 vUv;
uniform vec3 color;
uniform float opacity;
uniform float shimmer;
uniform float time;
uniform float span;
void main() {
  vec2 p = (vUv * 2.0 - 1.0) * span;
  float r = length(p);
  float edge = smoothstep(0.7, 1.25, r);
  float ripple = 0.55 + 0.45 * sin(atan(p.y, p.x) * 14.0 + time * 9.0 - r * 10.0);
  float ring = smoothstep(0.75, 1.0, r) * mix(1.0, ripple, shimmer);
  float a = mix(edge, ring, shimmer) * opacity;
  if (a < 0.003) discard;
  gl_FragColor = vec4(color, a);
}`;

export interface HitFeedbackOptions {
  /** True when the player asked for reduced motion: the flash is softer and slower. */
  reducedMotion?: boolean;
}

/**
 * The player-hit edge flash: a camera-locked quad in its own scene, drawn after the boards so
 * nothing covers it, in the desktop view and in both XR eyes. Red for damage, brass shimmer for
 * a full block. Brief and edge-only by design: the centre of the view never tints.
 */
export class HitFeedback {
  readonly scene = new THREE.Scene();
  readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  /** The last hit shown, for debug checks. */
  last: (PlayerHit & { at: number }) | null = null;
  /** Hits shown, oldest first (capped). */
  readonly log: (PlayerHit & { at: number })[] = [];
  reducedMotion: boolean;
  private readonly anchor = new THREE.Group();
  private readonly uniforms = {
    color: { value: new THREE.Color(HIT_RED) },
    opacity: { value: 0 },
    shimmer: { value: 0 },
    time: { value: 0 },
    span: { value: 1 },
  };
  private clock = 0;
  private age = Infinity;
  private peak = 0;
  private held = false;

  constructor(options: HitFeedbackOptions = {}) {
    this.reducedMotion = options.reducedMotion ?? false;
    this.scene.name = 'hit-feedback';
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
    this.quad.name = 'hit-vignette';
    this.quad.frustumCulled = false;
    this.quad.renderOrder = 10_000;
    this.quad.position.z = -OVERLAY_DISTANCE;
    this.quad.visible = false;
    this.anchor.add(this.quad);
    this.scene.add(this.anchor);
  }

  /** Current edge opacity, 0 when idle. */
  get opacity(): number {
    return this.uniforms.opacity.value;
  }

  get kind(): 'damage' | 'block' | null {
    if (!this.active) return null;
    return this.uniforms.shimmer.value > 0.5 ? 'block' : 'damage';
  }

  /** True while the flash is on screen (the scene is worth rendering). */
  get active(): boolean {
    return this.quad.visible;
  }

  /** Shows `hit`: red for damage (partial blocks a little softer), brass shimmer for a full block. */
  trigger(hit: PlayerHit): void {
    const entry = { ...hit, at: this.clock };
    this.last = entry;
    this.log.push(entry);
    if (this.log.length > 50) this.log.shift();
    const block = hit.kind === 'blocked';
    const base = block ? BLOCK_PEAK : hit.kind === 'partial' ? PARTIAL_PEAK : HIT_PEAK;
    const peak = base * (this.reducedMotion ? REDUCED_PEAK_SCALE : 1);
    const u = this.uniforms;
    // A second blow while the first still shows extends it instead of strobing back to zero.
    const now = this.envelope();
    u.color.value.set(block ? PALETTE.brass : HIT_RED);
    u.shimmer.value = block ? 1 : 0;
    this.peak = Math.max(peak, now);
    this.age = now > 0 ? this.rise() : 0;
  }

  /** Debug: keep the flash of `hit` at its peak until `release()`, for pixel checks. */
  hold(hit: PlayerHit): void {
    this.trigger(hit);
    this.held = true;
  }

  release(): void {
    this.held = false;
  }

  /**
   * Steps the flash and locks the quad to `camera`. `tan` is the half-extent of the view at unit
   * distance (desktop: from the fov and aspect; XR: from the combined eye projection).
   */
  update(dt: number, camera: THREE.Camera, tan: { x: number; y: number }, xr = false): void {
    this.clock += dt;
    if (!this.held) this.age += dt;
    else this.age = this.rise();
    const opacity = this.envelope();
    this.uniforms.opacity.value = opacity;
    this.uniforms.time.value = this.clock;
    this.quad.visible = opacity > 0.001;
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

  private rise(): number {
    return FLASH_RISE_SECONDS * (this.reducedMotion ? REDUCED_TIME_SCALE : 1);
  }

  private envelope(): number {
    const k = this.reducedMotion ? REDUCED_TIME_SCALE : 1;
    const rise = FLASH_RISE_SECONDS * k;
    const fade = FLASH_FADE_SECONDS * k;
    if (!(this.age < rise + fade)) return 0;
    if (this.age < rise) return this.peak * (this.age / rise);
    const f = 1 - (this.age - rise) / fade;
    return this.peak * f * f;
  }
}

/** Half-extents at unit distance of a perspective camera's view. */
export function viewTan(camera: THREE.PerspectiveCamera): { x: number; y: number } {
  const y = Math.tan((camera.fov * Math.PI) / 360);
  return { x: y * camera.aspect, y };
}

/** Half-extents at unit distance of a projection matrix (the XR camera's combined eyes). */
export function projectionTan(projection: THREE.Matrix4): { x: number; y: number } {
  const e = projection.elements;
  const sx = e[0] ?? 1;
  const sy = e[5] ?? 1;
  return {
    x: (1 + Math.abs(e[8] ?? 0)) / (Math.abs(sx) || 1),
    y: (1 + Math.abs(e[9] ?? 0)) / (Math.abs(sy) || 1),
  };
}
