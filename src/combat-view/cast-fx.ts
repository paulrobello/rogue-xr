import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import { PALETTE } from '../palette.ts';
import type { StatusId } from '../rules/types.ts';
import type { LinearRgb } from '../sigil-plate/spark-pool.ts';
import { discTexture, linearRgb, SPARK_AMBER, usePointScale } from '../sigil-plate/sparks.ts';
import {
  DRAW_SECONDS,
  MOTE_SECONDS,
  newShieldFrame,
  puffLevel,
  puffSize,
  REDUCED_SHIELD_SCALE,
  SHIELD_SECONDS,
  STEAM_RISE,
  STEAM_SECONDS,
  shieldFrame,
  shieldGain,
  steamPuffs,
} from './cast-timing.ts';
import { boltPoint, type Point3 } from './impact-timing.ts';

/** Rune points on the shield's outer ring, and hex points on its inner ring. */
export const SHIELD_RING_POINTS = 30;
export const SHIELD_HEX_POINTS = 6;
const SHIELD_POINTS = SHIELD_RING_POINTS + SHIELD_HEX_POINTS + 1;
/** Steam puffs alive at once (a ring: the oldest is reused). */
export const STEAM_CAPACITY = 24;
/** Mote and draw streams at once (a ring), and the points in each. */
export const STREAM_CAPACITY = 6;
export const STREAM_POINTS = 8;
const FIRST_STEAM = SHIELD_POINTS;
const FIRST_STREAM = FIRST_STEAM + STEAM_CAPACITY;
/** Every point the one draw holds. */
export const CAST_FX_POINTS = FIRST_STREAM + STREAM_CAPACITY * STREAM_POINTS;

/** Shield ring radius at full size, metres. */
export const SHIELD_RADIUS = 0.11;
/** Base sprite size, metres at one metre (attenuated with distance). */
const POINT_SIZE = 0.02;
const RING_SCALE = 1.3;
const HEX_SCALE = 2.4;
const CORE_SCALE = 9;
const PUFF_SCALE = 3.2;
const STREAM_SCALE = 1.6;
/** Puffs leave within this radius of the vent, metres. */
const PUFF_SPREAD = 0.05;
/** Stream points trail their head by this path fraction each. */
const STREAM_LAG = 0.07;
/** A stream glows at its target this long after arriving. */
const STREAM_LINGER = 0.18;
const STEP_MAX = 1 / 30;

const AMBER = linearRgb(PALETTE.candle);
const BRASS = linearRgb(PALETTE.brass);
/** Steam: a warm grey-white, dimmer than the sparks so additive puffs read soft. */
const STEAM = mixRgb(linearRgb(PALETTE.parchment), [0.55, 0.55, 0.55], 0.5);
const STATUS_RGB: Record<StatusId, LinearRgb> = {
  weak: boost(linearRgb(PALETTE.sapphire), 2.4),
  vulnerable: boost(linearRgb(PALETTE.ruby), 2.6),
  overheat: linearRgb(SPARK_AMBER),
  'wound-up': BRASS,
};

function mixRgb(a: LinearRgb, b: LinearRgb, k: number): LinearRgb {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

function boost(c: LinearRgb, k: number): LinearRgb {
  return [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];
}

const from3: Point3 = { x: 0, y: 0, z: 0 };
const to3: Point3 = { x: 0, y: 0, z: 0 };
const at3: Point3 = { x: 0, y: 0, z: 0 };
const streamRgb: [number, number, number] = [0, 0, 0];

/**
 * The non-attack effect FX of a cast, in world space (add to an untransformed root): a brass rune
 * shield that spins in front of the player and settles (block), soft steam puffs that rise and thin
 * out (steam), coloured mote streams to a status's target, and a brass shimmer to the hand (draw).
 * One additive `THREE.Points` draw holds all of it; every buffer is allocated up front and each
 * kind is a fixed ring of slots. Every start takes a `delay` so a cast can be queued at once.
 * Puff jitter comes from its own keyed visual stream, never a run stream.
 */
export class CastFx extends THREE.Group {
  readonly reducedMotion: boolean;
  private readonly stream = Stream.fromKey('cast-fx');
  private readonly texture = discTexture();
  private readonly points: THREE.Points;
  private readonly material: THREE.PointsMaterial;
  private readonly positions = new Float32Array(CAST_FX_POINTS * 3);
  private readonly colors = new Float32Array(CAST_FX_POINTS * 3);
  private readonly scales = new Float32Array(CAST_FX_POINTS);
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly scaleAttr: THREE.BufferAttribute;
  /** Shield: centre, right and up axes (xyz each), age, gain. */
  private readonly shieldBasis = new Float32Array(9);
  private shieldAge = SHIELD_SECONDS;
  private shieldLevel = 0;
  private readonly shieldNow = newShieldFrame();
  /** Puffs: origin xyz, drift xyz, age (negative while delayed), size. */
  private readonly puffAt = new Float32Array(STEAM_CAPACITY * 3);
  private readonly puffDrift = new Float32Array(STEAM_CAPACITY * 3);
  private readonly puffAge = new Float32Array(STEAM_CAPACITY).fill(STEAM_SECONDS);
  private readonly puffScale = new Float32Array(STEAM_CAPACITY);
  private puffNext = 0;
  /** Streams: from xyz, to xyz, age (negative while delayed), travel seconds, colour, shimmer. */
  private readonly streamEnds = new Float32Array(STREAM_CAPACITY * 6);
  private readonly streamAge = new Float32Array(STREAM_CAPACITY).fill(1e3);
  private readonly streamSeconds = new Float32Array(STREAM_CAPACITY).fill(1);
  private readonly streamRgb = new Float32Array(STREAM_CAPACITY * 3);
  private readonly streamShimmer = new Uint8Array(STREAM_CAPACITY);
  private streamNext = 0;
  private idle = true;

  constructor(options: { reducedMotion?: boolean } = {}) {
    super();
    this.name = 'cast-fx';
    this.reducedMotion = options.reducedMotion ?? false;
    const geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.positions, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.scaleAttr = new THREE.BufferAttribute(this.scales, 1);
    this.scaleAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('color', this.colorAttr);
    geometry.setAttribute('pointScale', this.scaleAttr);
    geometry.setDrawRange(0, CAST_FX_POINTS);
    this.material = new THREE.PointsMaterial({
      size: POINT_SIZE,
      sizeAttenuation: true,
      map: this.texture,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    usePointScale(this.material);
    this.points = new THREE.Points(geometry, this.material);
    this.points.name = 'cast-fx-points';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
    this.add(this.points);
  }

  /** True while anything is drawn or waiting to start. */
  get active(): boolean {
    return !this.idle;
  }

  /** True while the shield is up (or waiting to form). */
  get shielding(): boolean {
    return this.shieldAge < this.shieldSeconds();
  }

  /** Steam puffs alive or waiting. */
  get puffs(): number {
    let n = 0;
    for (let i = 0; i < STEAM_CAPACITY; i++) if ((this.puffAge[i] as number) < STEAM_SECONDS) n++;
    return n;
  }

  /** Mote and draw streams alive or waiting. */
  get streams(): number {
    let n = 0;
    for (let i = 0; i < STREAM_CAPACITY; i++) if (this.streamLive(i)) n++;
    return n;
  }

  /** Every buffer the draw uses, for pooling checks. */
  get buffers(): readonly Float32Array[] {
    return [this.positions, this.colors, this.scales];
  }

  /**
   * Forms the ward shield at `centre` facing along `normal` (toward the player), `delay` seconds
   * from now, as bright as `block` deserves. A new shield replaces the one up.
   */
  shield(centre: Point3, normal: Point3, block: number, delay = 0): void {
    const n = new THREE.Vector3(normal.x, normal.y, normal.z).normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(n);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = n.clone().cross(right).normalize();
    const b = this.shieldBasis;
    b[0] = centre.x;
    b[1] = centre.y;
    b[2] = centre.z;
    b[3] = right.x;
    b[4] = right.y;
    b[5] = right.z;
    b[6] = up.x;
    b[7] = up.y;
    b[8] = up.z;
    this.shieldAge = -Math.max(0, delay);
    this.shieldLevel = shieldGain(block);
    this.wake();
  }

  /** A puff of steam from `at` for `steam` gained, `delay` seconds from now. */
  steam(at: Point3, steam: number, delay = 0): void {
    const s = this.stream;
    const count = steamPuffs(steam);
    for (let n = 0; n < count; n++) {
      const p = this.puffNext;
      this.puffNext = (p + 1) % STEAM_CAPACITY;
      const a = s.next() * Math.PI * 2;
      const r = PUFF_SPREAD * Math.sqrt(s.next());
      this.puffAt[p * 3] = at.x + r * Math.cos(a);
      this.puffAt[p * 3 + 1] = at.y;
      this.puffAt[p * 3 + 2] = at.z + r * Math.sin(a);
      this.puffDrift[p * 3] = Math.cos(a) * (0.04 + 0.05 * s.next());
      this.puffDrift[p * 3 + 1] = (0.75 + 0.5 * s.next()) * (this.reducedMotion ? 1 / 3 : 1);
      this.puffDrift[p * 3 + 2] = Math.sin(a) * (0.04 + 0.05 * s.next());
      // Puffs leave in a short ragged burst rather than all at once.
      this.puffAge[p] = -Math.max(0, delay) - 0.18 * s.next();
      this.puffScale[p] = 0.75 + 0.5 * s.next();
    }
    this.wake();
  }

  /** A stream of `status`-coloured motes from `from` to `to`, `delay` seconds from now. */
  motes(from: Point3, to: Point3, status: StatusId, delay = 0, seconds = MOTE_SECONDS): void {
    this.startStream(from, to, STATUS_RGB[status], false, delay, seconds);
  }

  /** A brass shimmer from `from` to the hand at `to`, `delay` seconds from now. */
  draw(from: Point3, to: Point3, delay = 0): void {
    this.startStream(from, to, BRASS, true, delay, DRAW_SECONDS);
  }

  update(dt: number): void {
    if (this.idle) return;
    const h = Math.min(Math.max(0, dt), STEP_MAX);
    let lit = this.stepShield(h);
    if (this.stepPuffs(h)) lit = true;
    if (this.stepStreams(h)) lit = true;
    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
    this.idle = !lit;
    this.points.visible = lit;
  }

  /** Drops every shield, puff and stream at once. */
  reset(): void {
    this.shieldAge = SHIELD_SECONDS;
    this.puffAge.fill(STEAM_SECONDS);
    this.streamAge.fill(1e3);
    this.colors.fill(0);
    this.idle = true;
    this.points.visible = false;
    this.colorAttr.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }

  private wake(): void {
    this.idle = false;
    this.points.visible = true;
  }

  private shieldSeconds(): number {
    return this.reducedMotion ? SHIELD_SECONDS * REDUCED_SHIELD_SCALE : SHIELD_SECONDS;
  }

  private startStream(
    from: Point3,
    to: Point3,
    rgb: LinearRgb,
    shimmer: boolean,
    delay: number,
    seconds: number,
  ): void {
    const i = this.streamNext;
    this.streamNext = (i + 1) % STREAM_CAPACITY;
    const o = i * 6;
    this.streamEnds[o] = from.x;
    this.streamEnds[o + 1] = from.y;
    this.streamEnds[o + 2] = from.z;
    this.streamEnds[o + 3] = to.x;
    this.streamEnds[o + 4] = to.y;
    this.streamEnds[o + 5] = to.z;
    this.streamAge[i] = -Math.max(0, delay);
    this.streamSeconds[i] = Math.max(1e-3, seconds);
    this.streamRgb[i * 3] = rgb[0];
    this.streamRgb[i * 3 + 1] = rgb[1];
    this.streamRgb[i * 3 + 2] = rgb[2];
    this.streamShimmer[i] = shimmer ? 1 : 0;
    this.wake();
  }

  private streamLive(i: number): boolean {
    return (this.streamAge[i] as number) < (this.streamSeconds[i] as number) + STREAM_LINGER;
  }

  private dark(slot: number): void {
    this.colors[slot * 3] = 0;
    this.colors[slot * 3 + 1] = 0;
    this.colors[slot * 3 + 2] = 0;
  }

  private put(slot: number, x: number, y: number, z: number, rgb: LinearRgb, k: number): void {
    this.positions[slot * 3] = x;
    this.positions[slot * 3 + 1] = y;
    this.positions[slot * 3 + 2] = z;
    this.colors[slot * 3] = rgb[0] * k;
    this.colors[slot * 3 + 1] = rgb[1] * k;
    this.colors[slot * 3 + 2] = rgb[2] * k;
  }

  private stepShield(h: number): boolean {
    const total = this.shieldSeconds();
    if (this.shieldAge >= total) {
      for (let i = 0; i < SHIELD_POINTS; i++) this.dark(i);
      return false;
    }
    this.shieldAge += h;
    const f = shieldFrame(this.shieldAge, this.reducedMotion, this.shieldNow);
    const b = this.shieldBasis;
    const level = f.level * this.shieldLevel;
    const r = SHIELD_RADIUS * f.radius;
    for (let i = 0; i < SHIELD_RING_POINTS + SHIELD_HEX_POINTS; i++) {
      const hex = i >= SHIELD_RING_POINTS;
      const j = hex ? i - SHIELD_RING_POINTS : i;
      const count = hex ? SHIELD_HEX_POINTS : SHIELD_RING_POINTS;
      // The hex ring turns against the rune ring, so the ward reads as two interlocked wheels.
      const a = (2 * Math.PI * j) / count + (hex ? -1.5 * f.spin : f.spin);
      const rr = hex ? r * 0.62 : r;
      const c = Math.cos(a) * rr;
      const s = Math.sin(a) * rr;
      // Runes: every third point is a brighter glyph mark.
      const k = hex ? 1 : j % 3 === 0 ? 1 : 0.55;
      this.put(
        i,
        (b[0] as number) + (b[3] as number) * c + (b[6] as number) * s,
        (b[1] as number) + (b[4] as number) * c + (b[7] as number) * s,
        (b[2] as number) + (b[5] as number) * c + (b[8] as number) * s,
        hex ? BRASS : AMBER,
        level * k,
      );
      this.scales[i] = hex ? HEX_SCALE : RING_SCALE;
    }
    const core = SHIELD_POINTS - 1;
    this.put(core, b[0] as number, b[1] as number, b[2] as number, AMBER, 0.28 * level);
    this.scales[core] = CORE_SCALE * f.radius;
    return true;
  }

  private stepPuffs(h: number): boolean {
    let lit = false;
    for (let p = 0; p < STEAM_CAPACITY; p++) {
      const slot = FIRST_STEAM + p;
      const age = this.puffAge[p] as number;
      if (age >= STEAM_SECONDS) {
        this.dark(slot);
        continue;
      }
      lit = true;
      const next = age + h;
      this.puffAge[p] = next;
      const u = next / STEAM_SECONDS;
      if (u <= 0) {
        this.dark(slot);
        continue;
      }
      // The rise slows as the puff spreads.
      const rise = STEAM_RISE * (1 - (1 - Math.min(1, u)) ** 2);
      const d = this.puffDrift;
      this.put(
        slot,
        (this.puffAt[p * 3] as number) + (d[p * 3] as number) * u,
        (this.puffAt[p * 3 + 1] as number) + rise * (d[p * 3 + 1] as number),
        (this.puffAt[p * 3 + 2] as number) + (d[p * 3 + 2] as number) * u,
        STEAM,
        0.55 * puffLevel(u),
      );
      this.scales[slot] = PUFF_SCALE * (this.puffScale[p] as number) * puffSize(u);
    }
    return lit;
  }

  private stepStreams(h: number): boolean {
    let lit = false;
    for (let i = 0; i < STREAM_CAPACITY; i++) {
      const base = FIRST_STREAM + i * STREAM_POINTS;
      if (!this.streamLive(i)) {
        for (let n = 0; n < STREAM_POINTS; n++) this.dark(base + n);
        continue;
      }
      lit = true;
      const age = (this.streamAge[i] as number) + h;
      this.streamAge[i] = age;
      const seconds = this.streamSeconds[i] as number;
      const o = i * 6;
      from3.x = this.streamEnds[o] as number;
      from3.y = this.streamEnds[o + 1] as number;
      from3.z = this.streamEnds[o + 2] as number;
      to3.x = this.streamEnds[o + 3] as number;
      to3.y = this.streamEnds[o + 4] as number;
      to3.z = this.streamEnds[o + 5] as number;
      const rgb = streamRgb;
      rgb[0] = this.streamRgb[i * 3] as number;
      rgb[1] = this.streamRgb[i * 3 + 1] as number;
      rgb[2] = this.streamRgb[i * 3 + 2] as number;
      const shimmer = this.streamShimmer[i] === 1;
      const u = age / seconds;
      // After arrival the motes glow at the target and fade over the linger.
      const linger = u > 1 ? 1 - (age - seconds) / STREAM_LINGER : 1;
      for (let n = 0; n < STREAM_POINTS; n++) {
        const slot = base + n;
        if (u <= 0) {
          this.dark(slot);
          continue;
        }
        // Reduced motion: no travel, the motes glow up at the target and fade.
        const s = this.reducedMotion ? 1 : Math.max(0, Math.min(1, u - STREAM_LAG * n));
        if (s <= 0) {
          this.dark(slot);
          continue;
        }
        boltPoint(from3, to3, s, at3);
        // The stream fans out across its path so it reads as many motes, not one comet.
        const wobble = 0.012 * Math.sin(7 * s + n * 2.1) * (1 - s);
        const twinkle = shimmer ? 0.6 + 0.4 * Math.sin(40 * age + n * 1.7) : 1;
        const fade = this.reducedMotion
          ? Math.sin(Math.PI * Math.min(1, u))
          : 1 - n / STREAM_POINTS;
        this.put(slot, at3.x + wobble, at3.y + wobble, at3.z, rgb, fade * twinkle * linger);
        this.scales[slot] = STREAM_SCALE * (n === 0 ? 1.4 : 1);
      }
    }
    return lit;
  }
}
