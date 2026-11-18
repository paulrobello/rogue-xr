import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import { GLOW_HOT } from '../enemies/glow.ts';
import { type LinearRgb, SparkPool, type SparkRamp } from '../sigil-plate/spark-pool.ts';
import { discTexture, linearRgb, SPARK_AMBER, usePointScale } from '../sigil-plate/sparks.ts';
import { isSolidAttack, projectileGeometry, type SolidAttack } from './attack-projectiles.ts';
import {
  BOLT_TAIL_POINTS,
  boltEase,
  boltPoint,
  flashSize,
  IMPACT_SECONDS,
  impactFlash,
  impactSparkCount,
  type Point3,
  tailBrightness,
  tailFraction,
} from './impact-timing.ts';

/** Bolts in flight at once; an all-enemies spell sends one per enemy. A fifth reuses the oldest. */
export const BOLT_CAPACITY = 4;
/** Impact flashes at once. */
export const FLASH_CAPACITY = 4;
/** Impact sparks alive at once (a ring: the oldest is reused). */
export const IMPACT_SPARK_CAPACITY = 96;
const BOLT_SLOTS = BOLT_CAPACITY * BOLT_TAIL_POINTS;
const FIRST_BOLT_SLOT = IMPACT_SPARK_CAPACITY;
const FIRST_FLASH_SLOT = FIRST_BOLT_SLOT + BOLT_SLOTS;
/** Every point the one draw holds. */
export const SPELL_FX_POINTS = FIRST_FLASH_SLOT + FLASH_CAPACITY;

/** Base sprite size, metres at one metre (attenuated with distance): the impact sparks. */
const POINT_SIZE = 0.02;
const HEAD_SCALE = 3.2;
const FLASH_SCALE = 14;
/** World gravity on impact sparks, m/s², below real gravity so the burst hangs on the enemy. */
const IMPACT_GRAVITY = 4;
const STEP_MAX = 1 / 30;

const HOT = linearRgb(GLOW_HOT);
const RAMP: SparkRamp = { hot: HOT, mid: linearRgb(SPARK_AMBER) };
const FORWARD = new THREE.Vector3(0, 0, 1);

export type BoltKind = 'sigil' | 'card';

/** Stable visual families for attacks. These change only the pooled presentation, never damage. */
export type AttackVisualKind =
  | 'physical'
  | 'cog'
  | 'flurry'
  | 'volley'
  | 'hammer'
  | 'storm'
  | 'furnace'
  | 'lightning';

/** Maps card identity to its authored combat language without coupling the renderer to card data. */
export function attackVisualKind(cardId: string | null | undefined): AttackVisualKind {
  switch (cardId?.replace(/\+$/, '')) {
    case 'strike':
      return 'physical';
    case 'cog-toss':
      return 'cog';
    case 'ratchet-flurry':
      return 'flurry';
    case 'rivet-volley':
      return 'volley';
    case 'escapement-hammer':
      return 'hammer';
    case 'cogstorm':
      return 'storm';
    case 'furnace-brand':
      return 'furnace';
    case 'arc-bolt':
      return 'lightning';
    default:
      return 'lightning';
  }
}

const VISUAL_RGB: Record<AttackVisualKind, LinearRgb> = {
  physical: linearRgb('#d98b45'),
  cog: linearRgb('#e0b14b'),
  flurry: linearRgb('#ef6b4a'),
  volley: linearRgb('#6cb8c7'),
  hammer: linearRgb('#f2d27b'),
  storm: linearRgb('#b07ad8'),
  furnace: linearRgb('#e34b2f'),
  lightning: linearRgb('#79b9ff'),
};

const from3: Point3 = { x: 0, y: 0, z: 0 };
const to3: Point3 = { x: 0, y: 0, z: 0 };
const at3: Point3 = { x: 0, y: 0, z: 0 };

/** World-space projectiles, trails and impacts. Slots share geometry and use a separate visual RNG. */
export class SpellFx extends THREE.Group {
  readonly reducedMotion: boolean;
  private readonly pool = new SparkPool(IMPACT_SPARK_CAPACITY, BOLT_SLOTS + FLASH_CAPACITY);
  private readonly stream = Stream.fromKey('spell-impact');
  private readonly texture = discTexture();
  private readonly points: THREE.Points;
  private readonly material: THREE.PointsMaterial;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly scaleAttr: THREE.BufferAttribute;
  private readonly scales: Float32Array;
  /** Per bolt: from xyz, to xyz. */
  private readonly ends = new Float32Array(BOLT_CAPACITY * 6);
  private readonly boltAge = new Float32Array(BOLT_CAPACITY);
  private readonly boltSeconds = new Float32Array(BOLT_CAPACITY);
  private readonly boltPower = new Float32Array(BOLT_CAPACITY);
  private readonly boltVisual: AttackVisualKind[] =
    Array<AttackVisualKind>(BOLT_CAPACITY).fill('lightning');
  private readonly boltLive = new Uint8Array(BOLT_CAPACITY);
  private readonly boltSerial = new Float64Array(BOLT_CAPACITY);
  private readonly flashAt = new Float32Array(FLASH_CAPACITY * 3);
  private readonly flashAge = new Float32Array(FLASH_CAPACITY).fill(IMPACT_SECONDS);
  private readonly flashPower = new Float32Array(FLASH_CAPACITY);
  private readonly flashVisual: AttackVisualKind[] =
    Array<AttackVisualKind>(FLASH_CAPACITY).fill('lightning');
  private readonly geometries = new Map<SolidAttack, THREE.BufferGeometry>();
  private readonly metal = new THREE.MeshStandardMaterial({
    vertexColors: true,
    metalness: 0.35,
    roughness: 0.4,
  });
  private readonly glow = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  private readonly emptyGeometry = new THREE.BufferGeometry();
  private readonly direction = new THREE.Vector3();
  private readonly solid = Array.from(
    { length: BOLT_CAPACITY },
    () => new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(this.emptyGeometry, this.metal),
  );
  private readonly lightningLines = Array.from({ length: BOLT_CAPACITY }, () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(30), 3));
    const line = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: '#79b9ff', transparent: true, opacity: 0.95 }),
    );
    line.name = 'arc-bolt-filament';
    line.frustumCulled = false;
    line.visible = false;
    return line;
  });
  private flashNext = 0;
  private serial = 0;
  private idle = true;

  constructor(options: { reducedMotion?: boolean } = {}) {
    super();
    this.name = 'spell-fx';
    this.reducedMotion = options.reducedMotion ?? false;
    const geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.pool.positions, 3);
    this.positionAttr.setUsage(THREE.DynamicDrawUsage);
    this.colorAttr = new THREE.BufferAttribute(this.pool.colors, 3);
    this.colorAttr.setUsage(THREE.DynamicDrawUsage);
    this.scales = new Float32Array(SPELL_FX_POINTS).fill(1);
    this.scaleAttr = new THREE.BufferAttribute(this.scales, 1);
    this.scaleAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('color', this.colorAttr);
    geometry.setAttribute('pointScale', this.scaleAttr);
    geometry.setDrawRange(0, SPELL_FX_POINTS);
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
    this.points.name = 'spell-fx-points';
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    this.points.visible = false;
    this.add(this.points);
    for (let i = 0; i < BOLT_CAPACITY; i++) {
      this.solid[i].name = `attack-solid-${i}`;
      this.solid[i].visible = false;
      this.add(this.solid[i], this.lightningLines[i]);
    }
  }

  /** Bolts in flight. */
  get flying(): number {
    let n = 0;
    for (let i = 0; i < BOLT_CAPACITY; i++) n += this.boltLive[i] as number;
    return n;
  }

  /** Impact flashes still burning. */
  get flashing(): number {
    let n = 0;
    for (let i = 0; i < FLASH_CAPACITY; i++) if ((this.flashAge[i] as number) < IMPACT_SECONDS) n++;
    return n;
  }

  /** True while anything is drawn. */
  get active(): boolean {
    return !this.idle;
  }

  /**
   * Sends a bolt from `from` to `to` (world) that arrives `seconds` after it left; `age` is how long
   * ago it left (a launch noticed a frame late). Returns the bolt's slot.
   */
  launch(
    from: Point3,
    to: Point3,
    seconds: number,
    power: number,
    kind: BoltKind,
    age = 0,
    visual: AttackVisualKind = kind === 'card' ? 'physical' : 'lightning',
  ): number {
    let slot = -1;
    let oldest = 0;
    for (let i = 0; i < BOLT_CAPACITY; i++) {
      if (!this.boltLive[i]) {
        slot = i;
        break;
      }
      if ((this.boltSerial[i] as number) < (this.boltSerial[oldest] as number)) oldest = i;
    }
    if (slot < 0) slot = oldest;
    const o = slot * 6;
    this.ends[o] = from.x;
    this.ends[o + 1] = from.y;
    this.ends[o + 2] = from.z;
    this.ends[o + 3] = to.x;
    this.ends[o + 4] = to.y;
    this.ends[o + 5] = to.z;
    this.boltAge[slot] = Math.max(0, age);
    this.boltSeconds[slot] = Math.max(1e-3, seconds);
    this.boltPower[slot] = power;
    this.boltVisual[slot] = visual;
    const solid = this.solid[slot];
    solid.visible = isSolidAttack(visual);
    if (isSolidAttack(visual)) {
      let geometry = this.geometries.get(visual);
      if (!geometry) {
        geometry = projectileGeometry(visual);
        this.geometries.set(visual, geometry);
      }
      solid.geometry = geometry;
      solid.material = visual === 'furnace' || visual === 'flurry' ? this.glow : this.metal;
      solid.position.set(from.x, from.y, from.z);
    }
    this.lightningLines[slot].visible = visual === 'lightning';
    this.clearTrail(slot);
    this.boltLive[slot] = 1;
    this.boltSerial[slot] = ++this.serial;
    this.idle = false;
    this.points.visible = true;
    return slot;
  }

  /**
   * The burst at contact: a flash at `at` and sparks thrown back toward `from` (where the bolt came
   * from). Stops any bolt still flying to this spot so the comet never overshoots the flash.
   */
  impact(at: Point3, from: Point3, power: number, visual: AttackVisualKind = 'lightning'): void {
    const f = this.flashNext;
    this.flashNext = (f + 1) % FLASH_CAPACITY;
    this.flashAt[f * 3] = at.x;
    this.flashAt[f * 3 + 1] = at.y;
    this.flashAt[f * 3 + 2] = at.z;
    this.flashAge[f] = 0;
    this.flashPower[f] = power;
    this.flashVisual[f] = visual;
    for (let i = 0; i < BOLT_CAPACITY; i++) {
      if (!this.boltLive[i]) continue;
      const o = i * 6;
      const d = Math.hypot(
        (this.ends[o + 3] as number) - at.x,
        (this.ends[o + 4] as number) - at.y,
        (this.ends[o + 5] as number) - at.z,
      );
      if (d < 0.05) this.killBolt(i);
    }
    let bx = from.x - at.x;
    let by = from.y - at.y;
    let bz = from.z - at.z;
    const len = Math.hypot(bx, by, bz);
    if (len > 1e-6) {
      bx /= len;
      by /= len;
      bz /= len;
    }
    const s = this.stream;
    const count = impactSparkCount(power);
    for (let n = 0; n < count; n++) {
      // A random direction on the sphere, pulled toward the caster and slightly up.
      const u = s.next() * 2 - 1;
      const a = s.next() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const dx = r * Math.cos(a) + bx * 0.7;
      const dy = u + by * 0.7 + 0.35;
      const dz = r * Math.sin(a) + bz * 0.7;
      const k = (0.8 + 1.6 * s.next()) / (Math.hypot(dx, dy, dz) || 1);
      this.pool.emit(at.x, at.y, at.z, dx * k, dy * k, dz * k, 0.22 + 0.3 * s.next());
    }
    this.idle = false;
    this.points.visible = true;
  }

  update(dt: number): void {
    if (this.idle) return;
    const h = Math.min(Math.max(0, dt), STEP_MAX);
    const alive = this.pool.step(h, 0, -IMPACT_GRAVITY, 0, RAMP);
    let lit = alive > 0;
    const pos = this.pool.positions;
    const col = this.pool.colors;
    for (let b = 0; b < BOLT_CAPACITY; b++) {
      const base = FIRST_BOLT_SLOT + b * BOLT_TAIL_POINTS;
      if (!this.boltLive[b]) continue;
      const age = (this.boltAge[b] as number) + h;
      this.boltAge[b] = age;
      const seconds = this.boltSeconds[b] as number;
      if (age >= seconds) {
        this.killBolt(b);
        continue;
      }
      lit = true;
      const o = b * 6;
      from3.x = this.ends[o] as number;
      from3.y = this.ends[o + 1] as number;
      from3.z = this.ends[o + 2] as number;
      to3.x = this.ends[o + 3] as number;
      to3.y = this.ends[o + 4] as number;
      to3.z = this.ends[o + 5] as number;
      const s = boltEase(age / seconds);
      const power = this.boltPower[b] as number;
      const gain = 0.6 + 0.4 * power;
      const visual = this.boltVisual[b];
      const dx = to3.x - from3.x;
      const dz = to3.z - from3.z;
      if (isSolidAttack(visual)) {
        const mesh = this.solid[b];
        boltPoint(from3, to3, s, at3);
        mesh.position.set(at3.x, at3.y, at3.z);
        this.direction.set(dx, to3.y - from3.y, dz).normalize();
        mesh.quaternion.setFromUnitVectors(FORWARD, this.direction);
        if (visual === 'hammer') mesh.rotateX(this.reducedMotion ? -0.35 : 0.85 - 1.7 * s);
        if (visual === 'cog' || visual === 'storm') {
          mesh.rotateY(0.4);
          if (!this.reducedMotion) mesh.rotateZ(2 * Math.PI * s);
        }
        continue;
      }
      if (visual === 'physical') continue;
      if (visual === 'lightning') this.updateLightning(b, from3, to3, s);
      const tail = VISUAL_RGB[visual];
      const grow = Math.min(1, s / 0.08);
      for (let i = 0; i < BOLT_TAIL_POINTS; i++) {
        const slot = base + i;
        const k = i / (BOLT_TAIL_POINTS - 1);
        boltPoint(from3, to3, tailFraction(s, i), at3);
        pos[slot * 3] = at3.x;
        pos[slot * 3 + 1] = at3.y;
        pos[slot * 3 + 2] = at3.z;
        const light = tailBrightness(i) * gain * grow;
        col[slot * 3] = tail[0] * light;
        col[slot * 3 + 1] = tail[1] * light;
        col[slot * 3 + 2] = tail[2] * light;
        this.scales[slot] = HEAD_SCALE * (1 - 0.6 * k) * (0.7 + 0.3 * power);
      }
    }
    for (let f = 0; f < FLASH_CAPACITY; f++) {
      const slot = FIRST_FLASH_SLOT + f;
      const age = this.flashAge[f] as number;
      if (age >= IMPACT_SECONDS) {
        col[slot * 3] = 0;
        col[slot * 3 + 1] = 0;
        col[slot * 3 + 2] = 0;
        continue;
      }
      const next = age + h;
      this.flashAge[f] = next;
      const power = this.flashPower[f] as number;
      const level = impactFlash(next, power, this.reducedMotion);
      pos[slot * 3] = this.flashAt[f * 3] as number;
      pos[slot * 3 + 1] = this.flashAt[f * 3 + 1] as number;
      pos[slot * 3 + 2] = this.flashAt[f * 3 + 2] as number;
      const family = VISUAL_RGB[this.flashVisual[f]];
      col[slot * 3] = (HOT[0] * 0.45 + family[0] * 0.55) * level;
      col[slot * 3 + 1] = (HOT[1] * 0.45 + family[1] * 0.55) * level;
      col[slot * 3 + 2] = (HOT[2] * 0.45 + family[2] * 0.55) * level;
      this.scales[slot] = FLASH_SCALE * flashSize(next) * (0.7 + 0.3 * power);
      if (level > 0) lit = true;
    }
    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.scaleAttr.needsUpdate = true;
    this.idle = !lit;
    this.points.visible = lit;
  }

  /** Drops every bolt, flash and spark at once. */
  reset(): void {
    this.pool.clear();
    this.boltLive.fill(0);
    this.flashAge.fill(IMPACT_SECONDS);
    this.idle = true;
    this.points.visible = false;
    for (const object of this.solid) object.visible = false;
    for (const line of this.lightningLines) line.visible = false;
    this.colorAttr.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.emptyGeometry.dispose();
    this.metal.dispose();
    this.glow.dispose();
    for (const line of this.lightningLines) {
      line.geometry.dispose();
      (line.material as THREE.Material).dispose();
    }
  }

  private killBolt(b: number): void {
    this.boltLive[b] = 0;
    this.solid[b].visible = false;
    this.lightningLines[b].visible = false;
    this.clearTrail(b);
  }

  private clearTrail(b: number): void {
    const col = this.pool.colors;
    const base = FIRST_BOLT_SLOT + b * BOLT_TAIL_POINTS;
    for (let i = 0; i < BOLT_TAIL_POINTS; i++) {
      const slot = base + i;
      col[slot * 3] = 0;
      col[slot * 3 + 1] = 0;
      col[slot * 3 + 2] = 0;
    }
  }

  private updateLightning(slot: number, from: Point3, to: Point3, progress: number): void {
    const attr = this.lightningLines[slot].geometry.getAttribute(
      'position',
    ) as THREE.BufferAttribute;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dz) || 1;
    const sx = -dz / length;
    const sz = dx / length;
    for (let i = 0; i < 8; i++) {
      const point = (i + 1) >> 1;
      const k = (progress * point) / 4;
      const sideways = point === 0 || point === 4 ? 0 : point % 2 ? 0.065 : -0.055;
      attr.setXYZ(
        i,
        from.x + dx * k + sx * sideways,
        from.y + dy * k + Math.sin(k * Math.PI) * 0.05,
        from.z + dz * k + sz * sideways,
      );
    }
    const x = attr.getX(3),
      y = attr.getY(3),
      z = attr.getZ(3);
    attr.setXYZ(8, x, y, z);
    attr.setXYZ(
      9,
      x + dx * progress * 0.19 - sx * 0.09,
      y + dy * progress * 0.19 + 0.08,
      z + dz * progress * 0.19 - sz * 0.09,
    );
    attr.needsUpdate = true;
  }
}
