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
import { SteamPuffs } from './steam-puffs.ts';
import { WardShield } from './ward-shield.ts';

/** Steam puffs alive at once (a ring: the oldest is reused). */
export const STEAM_CAPACITY = 24;
/** Mote and draw streams at once (a ring), and the points in each. */
export const STREAM_CAPACITY = 6;
export const STREAM_POINTS = 8;
/** Every point the mote and shimmer draw holds. */
export const CAST_FX_POINTS = STREAM_CAPACITY * STREAM_POINTS;

/** Shield disc radius at full size, metres. */
export const SHIELD_RADIUS = 0.11;
/** Base sprite size, metres at one metre (attenuated with distance). */
const POINT_SIZE = 0.02;
const STREAM_SCALE = 1.6;
/** Puffs leave within this radius of the vent, metres. */
const PUFF_SPREAD = 0.06;
/** A puff's size across as it leaves the vent, metres (it billows to three times this). */
export const PUFF_SIZE = 0.08;
/** Peak opacity of one puff. */
const PUFF_OPACITY = 0.85;
/** Puffs leave this far above the vent, metres, so the table does not swallow their lower half. */
const PUFF_LIFT = 0.03;
/** Most a puff turns over its life, radians. */
const PUFF_TURN = 0.9;
/** Stream points trail their head by this path fraction each. */
const STREAM_LAG = 0.07;
/** A stream glows at its target this long after arriving. */
const STREAM_LINGER = 0.18;
const STEP_MAX = 1 / 30;

const BRASS = linearRgb(PALETTE.brass);
/** Steam: a grey-white with the faintest warmth, alpha blended over the scene. */
const STEAM = mixRgb(linearRgb(PALETTE.parchment), [0.72, 0.72, 0.72], 0.8);
const STATUS_RGB: Record<StatusId, LinearRgb> = {
  weak: boost(linearRgb(PALETTE.sapphire), 2.4),
  vulnerable: boost(linearRgb(PALETTE.ruby), 2.6),
  overheat: linearRgb(SPARK_AMBER),
  'wound-up': BRASS,
  plating: boost(linearRgb(PALETTE.brass), 2.0),
  rust: boost(linearRgb('#d85b2b'), 2.2),
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
 * The non-attack effect FX of a cast, in world space (add to an untransformed root): a glowing
 * rune-ring ward disc that swirls in front of the player and locks (block, `WardShield`), grey-white
 * steam puffs that burst, rise and thin out (steam, `SteamPuffs`), coloured mote streams to a
 * status's target, and a brass shimmer to the hand (draw, one additive `THREE.Points`). Three
 * draws, every buffer allocated up front, each kind a fixed ring of slots. Every start takes a
 * `delay` so a cast can be queued at once. Puff jitter comes from its own keyed visual stream,
 * never a run stream.
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
  private readonly ward = new WardShield();
  private shieldAge = SHIELD_SECONDS;
  private shieldLevel = 0;
  private readonly shieldNow = newShieldFrame();
  private readonly steamDraw = new SteamPuffs(STEAM_CAPACITY, new THREE.Color(...STEAM));
  /** Puffs: origin xyz, drift xyz, age (negative while delayed), size, rotation and turn. */
  private readonly puffAt = new Float32Array(STEAM_CAPACITY * 3);
  private readonly puffDrift = new Float32Array(STEAM_CAPACITY * 3);
  private readonly puffAge = new Float32Array(STEAM_CAPACITY).fill(STEAM_SECONDS);
  private readonly puffScale = new Float32Array(STEAM_CAPACITY);
  private readonly puffSpin = new Float32Array(STEAM_CAPACITY * 2);
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
    this.add(this.points, this.ward, this.steamDraw);
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

  /** Brightness the ward shield draws at now (0: not drawn). */
  get shieldDrawn(): number {
    return this.ward.visible ? this.ward.level : 0;
  }

  /** True while any FX is drawn this frame (the shield, a puff, a mote). */
  get lit(): boolean {
    return (
      this.shieldDrawn > 0 ||
      this.steamDraw.lookData.some((v, i) => i % 2 === 0 && v > 0) ||
      this.colors.some((v) => v > 0)
    );
  }

  /** Every buffer the draws use, for pooling checks: stream points, then steam puffs. */
  get buffers(): readonly Float32Array[] {
    return [
      this.positions,
      this.colors,
      this.scales,
      this.steamDraw.puffData,
      this.steamDraw.lookData,
    ];
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
    this.ward.place(new THREE.Vector3(centre.x, centre.y, centre.z), right, up);
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
      this.puffAt[p * 3 + 1] = at.y + PUFF_LIFT;
      this.puffAt[p * 3 + 2] = at.z + r * Math.sin(a);
      this.puffDrift[p * 3] = Math.cos(a) * (0.05 + 0.07 * s.next());
      this.puffDrift[p * 3 + 1] = (0.8 + 0.4 * s.next()) * (this.reducedMotion ? 1 / 3 : 1);
      this.puffDrift[p * 3 + 2] = Math.sin(a) * (0.05 + 0.07 * s.next());
      // Puffs leave in a short ragged burst rather than all at once.
      this.puffAge[p] = -Math.max(0, delay) - 0.22 * s.next();
      this.puffScale[p] = 0.7 + 0.6 * s.next();
      this.puffSpin[p * 2] = s.next() * Math.PI * 2;
      this.puffSpin[p * 2 + 1] = this.reducedMotion ? 0 : (s.next() * 2 - 1) * PUFF_TURN;
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
    this.ward.apply(shieldFrame(-1, this.reducedMotion, this.shieldNow), SHIELD_RADIUS, 0);
    for (let p = 0; p < STEAM_CAPACITY; p++) this.steamDraw.hide(p);
    this.steamDraw.commit(false);
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.ward.dispose();
    this.steamDraw.dispose();
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
      if (this.ward.visible) this.ward.apply(shieldFrame(-1, false, this.shieldNow), 0, 0);
      return false;
    }
    this.shieldAge += h;
    const f = shieldFrame(this.shieldAge, this.reducedMotion, this.shieldNow);
    this.ward.apply(f, SHIELD_RADIUS, this.shieldLevel);
    return true;
  }

  private stepPuffs(h: number): boolean {
    let lit = false;
    const draw = this.steamDraw;
    for (let p = 0; p < STEAM_CAPACITY; p++) {
      const age = this.puffAge[p] as number;
      if (age >= STEAM_SECONDS) {
        draw.hide(p);
        continue;
      }
      lit = true;
      const next = age + h;
      this.puffAge[p] = next;
      const u = next / STEAM_SECONDS;
      if (u <= 0) {
        draw.hide(p);
        continue;
      }
      // The rise slows as the puff spreads.
      const rise = STEAM_RISE * (1 - (1 - Math.min(1, u)) ** 2);
      const d = this.puffDrift;
      draw.puff(
        p,
        (this.puffAt[p * 3] as number) + (d[p * 3] as number) * u,
        (this.puffAt[p * 3 + 1] as number) + rise * (d[p * 3 + 1] as number),
        (this.puffAt[p * 3 + 2] as number) + (d[p * 3 + 2] as number) * u,
        PUFF_SIZE * (this.puffScale[p] as number) * puffSize(u),
        PUFF_OPACITY * puffLevel(u),
        (this.puffSpin[p * 2] as number) + (this.puffSpin[p * 2 + 1] as number) * u,
      );
    }
    draw.commit(lit);
    return lit;
  }

  private stepStreams(h: number): boolean {
    let lit = false;
    for (let i = 0; i < STREAM_CAPACITY; i++) {
      const base = i * STREAM_POINTS;
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
