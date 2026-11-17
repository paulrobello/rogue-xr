import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import { GLOW_HOT } from '../enemies/glow.ts';
import {
  type LinearRgb,
  MAX_STEP,
  SPARK_CAPACITY,
  SPARK_LIFE_MAX,
  SPARK_LIFE_MIN,
  SparkEmitter,
  SparkPool,
  type SparkRamp,
} from './spark-pool.ts';

/** D11 rim amber: the glow family's dim end, sampled from the concept sheets. */
export const SPARK_AMBER = '#F08C2C';
/** Downward pull on a spark, m/s². Below real gravity so the shower stays around the plate. */
export const SPARK_GRAVITY = 3;
/** Spark sprite size, metres at one metre from the eye (attenuated with distance). */
const SPARK_SIZE = 0.007;
/** Height of new sparks above the plate face, just over the trail ribbon. */
const SPARK_Z = 0.006;
const DOT_SIZE = 0.022;
const DOT_Z = 0.005;
/** The contact dot's slot: the one point after the spark ring, drawn in the same call. */
export const DOT_SLOT = SPARK_CAPACITY;
/** Lines of three's points vertex shader the per-point scale is spliced into. */
export const POINTS_SIZE_DECL = 'uniform float size;';
export const POINTS_SIZE_ASSIGN = 'gl_PointSize = size;';
/** Seconds the contact dot takes to fade once the beam leaves the plate. */
const DOT_FADE_SECONDS = 0.12;
/** Speed below this (m/s) is controller jitter, not a stroke. */
const SPEED_DEADZONE = 0.03;
/** Low-pass rate on the contact velocity, per second. */
const SPEED_SMOOTHING = 14;
/** Draw after the plate face, which is transparent and would otherwise dim the additive glow. */
export const GLOW_RENDER_ORDER = 1;

/** Linear RGB of a hex colour, resolved once at module load. */
export function linearRgb(hex: string): LinearRgb {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

const RAMP: SparkRamp = { hot: linearRgb(GLOW_HOT), mid: linearRgb(SPARK_AMBER) };
const DOT_RGB = linearRgb(GLOW_HOT);

/** 16 x 16 white disc with a soft alpha falloff, shared by the sparks and the contact dot. */
export function discTexture(): THREE.DataTexture {
  const n = 16;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const r = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      const o = (y * n + x) * 4;
      data[o] = 255;
      data[o + 1] = 255;
      data[o + 2] = 255;
      data[o + 3] = Math.round(255 * Math.max(0, 1 - r) ** 1.6);
    }
  const texture = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Splices a per-point `pointScale` attribute into a `PointsMaterial`'s size. Every material patched
 * here shares one program (same splice, same cache key), so the spell effects add no shader build.
 */
export function usePointScale(material: THREE.PointsMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(POINTS_SIZE_DECL, `${POINTS_SIZE_DECL}\nattribute float pointScale;`)
      .replace(POINTS_SIZE_ASSIGN, 'gl_PointSize = size * pointScale;');
  };
  material.customProgramCacheKey = () => 'sigil-sparks-scaled';
}

/**
 * Brass-amber sparks and a hot contact dot where the beam meets the sigil plate. Lives in plate
 * space (a child of `SigilPlate`, +Z toward the player): `setContact` each sample, `clearContact`
 * when the beam leaves the plate or the stroke ends, `update` once per frame with gravity in plate
 * space. One `THREE.Points` draw holds the pooled sparks and, in its last slot, the dot (a
 * per-point scale attribute sizes it); no per-frame allocation. Randomness is visual only and comes from its own keyed stream, never a run stream.
 */
export class SigilSparks extends THREE.Group {
  readonly pool = new SparkPool(SPARK_CAPACITY, 1);
  private readonly emitter = new SparkEmitter();
  private readonly stream = Stream.fromKey('sigil-sparks');
  private readonly texture = discTexture();
  private readonly points: THREE.Points;
  private readonly pointsMaterial: THREE.PointsMaterial;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly scaleAttr: THREE.BufferAttribute;
  private contact = false;
  private tracking = false;
  private cx = 0;
  private cy = 0;
  private px = 0;
  private py = 0;
  private vx = 0;
  private vy = 0;
  private dotLevel = 0;
  private idle = true;

  constructor() {
    super();
    this.name = 'sigil-sparks';

    const geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.pool.positions, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.pool.colors, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    const scales = new Float32Array(SPARK_CAPACITY + 1).fill(1);
    this.scaleAttr = new THREE.BufferAttribute(scales, 1);
    this.scaleAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('color', this.colorAttr);
    geometry.setAttribute('pointScale', this.scaleAttr);
    geometry.setDrawRange(0, SPARK_CAPACITY + 1);
    this.pointsMaterial = new THREE.PointsMaterial({
      size: SPARK_SIZE,
      sizeAttenuation: true,
      map: this.texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    usePointScale(this.pointsMaterial);
    this.points = new THREE.Points(geometry, this.pointsMaterial);
    this.points.name = 'sigil-sparks-points';
    this.points.frustumCulled = false;
    this.points.renderOrder = GLOW_RENDER_ORDER;
    this.points.visible = false;
    this.add(this.points);
    this.positionAttr.setXYZ(DOT_SLOT, 0, 0, DOT_Z);
  }

  /** True while the beam rests on the plate. */
  get touching(): boolean {
    return this.contact;
  }

  /** Smoothed contact speed, m/s, after the jitter dead zone. */
  get speed(): number {
    return Math.max(0, Math.hypot(this.vx, this.vy) - SPEED_DEADZONE);
  }

  /** The beam meets the plate at (x, y), plate metres. */
  setContact(x: number, y: number): void {
    this.cx = x;
    this.cy = y;
    if (!this.contact) {
      // A fresh contact starts from rest, so a new stroke never opens with a shower from the old end.
      this.tracking = false;
      this.vx = 0;
      this.vy = 0;
    }
    this.contact = true;
  }

  clearContact(): void {
    this.contact = false;
    this.tracking = false;
    this.vx = 0;
    this.vy = 0;
    this.emitter.reset();
  }

  /** Kills every spark and the dot at once, for a plate that is reset or hidden. */
  reset(): void {
    this.clearContact();
    this.pool.clear();
    this.dotLevel = 0;
    this.points.visible = false;
    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.idle = true;
  }

  /** Emits, moves and fades the sparks. `gx, gy, gz` is gravity in plate space, m/s². */
  update(dt: number, gx: number, gy: number, gz: number): void {
    const h = Math.min(Math.max(0, dt), MAX_STEP);
    if (this.contact) {
      if (this.tracking && h > 0) {
        const k = Math.min(1, h * SPEED_SMOOTHING);
        this.vx += ((this.cx - this.px) / h - this.vx) * k;
        this.vy += ((this.cy - this.py) / h - this.vy) * k;
      }
      this.tracking = true;
      this.px = this.cx;
      this.py = this.cy;
      this.spawn(this.emitter.take(h, this.speed));
    }

    const alive = this.pool.step(h, gx, gy, gz, RAMP);

    const target = this.contact ? 1 : 0;
    this.dotLevel =
      target >= this.dotLevel
        ? Math.min(1, this.dotLevel + h / 0.04)
        : Math.max(0, this.dotLevel - h / DOT_FADE_SECONDS);
    const level = this.dotLevel;
    let scale = 0;
    if (level > 0) {
      const flicker = 0.85 + 0.3 * this.stream.next();
      const swell = 1 + Math.min(0.5, this.speed * 0.8);
      scale = (DOT_SIZE / SPARK_SIZE) * flicker * swell * (0.6 + 0.4 * level);
      this.positionAttr.setXYZ(DOT_SLOT, this.cx, this.cy, DOT_Z);
    }
    // Additive blending: the dot fades by darkening its colour, the way the sparks do.
    this.colorAttr.setXYZ(DOT_SLOT, DOT_RGB[0] * level, DOT_RGB[1] * level, DOT_RGB[2] * level);
    this.scaleAttr.setX(DOT_SLOT, scale);

    const lit = alive > 0 || level > 0;
    // Once every spark has died, the dot is out and the arrays went black, stop uploading.
    if (lit || !this.idle) {
      this.positionAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.scaleAttr.needsUpdate = true;
    }
    this.idle = !lit;
    this.points.visible = lit;
  }

  /** The contact dot's brightness, 0 (out) to 1 (beam on the plate). */
  get dotBrightness(): number {
    return this.dotLevel;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.pointsMaterial.dispose();
    this.texture.dispose();
  }

  private spawn(count: number): void {
    const s = this.stream;
    for (let i = 0; i < count; i++) {
      const angle = s.next() * Math.PI * 2;
      const spread = 0.12 + 0.4 * s.next();
      const out = 0.15 + 0.45 * s.next();
      // Sparks fly off behind the moving tip, the way a grinder throws them.
      this.pool.emit(
        this.cx + (s.next() - 0.5) * 0.004,
        this.cy + (s.next() - 0.5) * 0.004,
        SPARK_Z,
        Math.cos(angle) * spread - this.vx * 0.35,
        Math.sin(angle) * spread - this.vy * 0.35 + 0.08,
        out,
        SPARK_LIFE_MIN + (SPARK_LIFE_MAX - SPARK_LIFE_MIN) * s.next(),
      );
    }
  }
}
