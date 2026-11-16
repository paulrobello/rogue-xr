/**
 * Pure particle logic behind the sigil trace sparks: a fixed-capacity ring of sparks, the
 * speed-to-emission mapping and the trail's heat ramp. No three.js here; `sparks.ts` binds these
 * arrays straight to GPU buffers, so nothing in the per-frame path allocates.
 */

/** Linear RGB triplet. */
export type LinearRgb = readonly [number, number, number];

/** Pool size: one draw call of this many points. */
export const SPARK_CAPACITY = 96;
export const SPARK_LIFE_MIN = 0.3;
export const SPARK_LIFE_MAX = 0.6;
/** Sparks per second while the beam rests on the plate: a gentle fizz. */
export const FIZZ_RATE = 22;
/** Extra sparks per second per metre per second of stroke speed. */
export const SPEED_RATE = 300;
/**
 * Emission ceiling. Kept at or under capacity / longest life, so a fast stroke never has to
 * recycle a spark that is still in flight.
 */
export const MAX_RATE = SPARK_CAPACITY / SPARK_LIFE_MAX;
/** Longest frame step the effect integrates; a frame hitch must not dump a burst or teleport sparks. */
export const MAX_STEP = 1 / 30;

/** Sparks per second for a contact moving at `speed` metres per second. */
export function emissionRate(speed: number): number {
  return Math.min(MAX_RATE, FIZZ_RATE + Math.max(0, speed) * SPEED_RATE);
}

/** Turns a continuous rate into whole sparks per frame, carrying the remainder between frames. */
export class SparkEmitter {
  private carry = 0;

  /** Whole sparks to emit this frame for a contact moving at `speed`. */
  take(dt: number, speed: number): number {
    this.carry += emissionRate(speed) * Math.min(Math.max(0, dt), MAX_STEP);
    const n = Math.floor(this.carry);
    this.carry -= n;
    return n;
  }

  reset(): void {
    this.carry = 0;
  }
}

/** Spark colour over life: `hot` at birth, `mid` partway, fading to black (invisible when additive). */
export interface SparkRamp {
  readonly hot: LinearRgb;
  readonly mid: LinearRgb;
}

/**
 * Fixed ring of sparks. `positions` and `colors` (xyz and linear rgb per slot) are the arrays the
 * renderer draws; a dead slot is black, which additive blending shows as nothing.
 */
export class SparkPool {
  readonly capacity: number;
  readonly positions: Float32Array;
  readonly colors: Float32Array;
  private readonly velocities: Float32Array;
  private readonly ages: Float32Array;
  private readonly lives: Float32Array;
  private head = 0;

  constructor(capacity = SPARK_CAPACITY) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.ages = new Float32Array(capacity);
    this.lives = new Float32Array(capacity);
  }

  /** Slot the next `emit` writes: the ring wraps, reusing the oldest spark. */
  get nextSlot(): number {
    return this.head;
  }

  get alive(): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if ((this.lives[i] as number) > 0) n++;
    return n;
  }

  isAlive(slot: number): boolean {
    return (this.lives[slot] as number) > 0;
  }

  /** Starts a spark at (x, y, z) moving at (vx, vy, vz) for `life` seconds. Returns its slot. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number): number {
    const slot = this.head;
    this.head = (slot + 1) % this.capacity;
    const o = slot * 3;
    this.positions[o] = x;
    this.positions[o + 1] = y;
    this.positions[o + 2] = z;
    this.velocities[o] = vx;
    this.velocities[o + 1] = vy;
    this.velocities[o + 2] = vz;
    this.ages[slot] = 0;
    this.lives[slot] = Math.max(1e-3, life);
    return slot;
  }

  /**
   * Ages, moves and recolours every live spark under gravity (gx, gy, gz) with light air drag.
   * Returns the live count after the step.
   */
  step(dt: number, gx: number, gy: number, gz: number, ramp: SparkRamp): number {
    const h = Math.min(Math.max(0, dt), MAX_STEP);
    const drag = Math.max(0, 1 - 2.5 * h);
    let alive = 0;
    for (let i = 0; i < this.capacity; i++) {
      const life = this.lives[i] as number;
      if (life <= 0) continue;
      const o = i * 3;
      const age = (this.ages[i] as number) + h;
      if (age >= life) {
        this.lives[i] = 0;
        this.colors[o] = 0;
        this.colors[o + 1] = 0;
        this.colors[o + 2] = 0;
        continue;
      }
      this.ages[i] = age;
      const vx = ((this.velocities[o] as number) + gx * h) * drag;
      const vy = ((this.velocities[o + 1] as number) + gy * h) * drag;
      const vz = ((this.velocities[o + 2] as number) + gz * h) * drag;
      this.velocities[o] = vx;
      this.velocities[o + 1] = vy;
      this.velocities[o + 2] = vz;
      this.positions[o] = (this.positions[o] as number) + vx * h;
      this.positions[o + 1] = (this.positions[o + 1] as number) + vy * h;
      this.positions[o + 2] = (this.positions[o + 2] as number) + vz * h;
      const t = age / life;
      // Hot to amber over the first 40% of life, while the brightness falls away to nothing.
      const k = Math.min(1, t / 0.4);
      const fade = (1 - t) ** 1.5;
      this.colors[o] = (ramp.hot[0] + (ramp.mid[0] - ramp.hot[0]) * k) * fade;
      this.colors[o + 1] = (ramp.hot[1] + (ramp.mid[1] - ramp.hot[1]) * k) * fade;
      this.colors[o + 2] = (ramp.hot[2] + (ramp.mid[2] - ramp.hot[2]) * k) * fade;
      alive++;
    }
    return alive;
  }

  /** Kills every spark and rewinds the ring. */
  clear(): void {
    this.lives.fill(0);
    this.ages.fill(0);
    this.colors.fill(0);
    this.velocities.fill(0);
    this.head = 0;
  }
}

/** Seconds a trail segment takes to cool from the hot tip colour to the settled stroke colour. */
export const TRAIL_COOL_SECONDS = 0.55;

/** Trail colour ramp: `cool` is the settled stroke, `mid` the amber band, `hot` the tip. */
export interface HeatRamp {
  readonly cool: LinearRgb;
  readonly mid: LinearRgb;
  readonly hot: LinearRgb;
}

/** Writes the colour for `heat` (1 at the tip, 0 settled) into `out` at `offset`. */
export function heatColor(heat: number, ramp: HeatRamp, out: Float32Array, offset: number): void {
  const h = Math.min(1, Math.max(0, heat));
  const [a, b, k] = h < 0.5 ? [ramp.cool, ramp.mid, h * 2] : [ramp.mid, ramp.hot, h * 2 - 1];
  out[offset] = a[0] + (b[0] - a[0]) * k;
  out[offset + 1] = a[1] + (b[1] - a[1]) * k;
  out[offset + 2] = a[2] + (b[2] - a[2]) * k;
}

/**
 * Per-segment heat for the trail ribbon. Each new segment is born hot and cools over
 * {@link TRAIL_COOL_SECONDS}; only the still-cooling window is revisited each frame.
 */
export class TrailHeat {
  private readonly born: Float64Array;
  private count = 0;
  private coolFrom = 0;
  private clock = 0;

  constructor(capacity: number) {
    this.born = new Float64Array(capacity);
  }

  get segments(): number {
    return this.count;
  }

  /** First segment that may still be cooling; everything before it is settled. */
  get firstWarm(): number {
    return this.coolFrom;
  }

  /** Records a new segment at the tip. Returns its index, or -1 when full. */
  push(): number {
    if (this.count >= this.born.length) return -1;
    this.born[this.count] = this.clock;
    return this.count++;
  }

  /** Heat of segment `i`: 1 when just drawn, 0 once cooled. */
  heat(i: number): number {
    if (i < 0 || i >= this.count) return 0;
    return Math.max(0, 1 - (this.clock - (this.born[i] as number)) / TRAIL_COOL_SECONDS);
  }

  /**
   * Advances the clock. Returns the first segment index that needs a colour write this frame (the
   * window runs to `segments`); segments before it settled on an earlier frame.
   */
  advance(dt: number): number {
    this.clock += Math.max(0, dt);
    const from = this.coolFrom;
    while (this.coolFrom < this.count && this.heat(this.coolFrom) <= 0) this.coolFrom++;
    // Include the segments that reached zero on this step, so their final settled colour is written.
    return from;
  }

  clear(): void {
    this.count = 0;
    this.coolFrom = 0;
    this.clock = 0;
  }
}
