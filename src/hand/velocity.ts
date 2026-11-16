/**
 * Release velocity from a short window of timestamped controller positions. Pure, no three.js.
 *
 * Quest controller poses arrive at the display rate (72, 90 or 120 Hz) with about 2 mm of noise, and
 * the last frame before a release is unreliable: the hand opens and the pose sags, or the frame is
 * dropped. The estimate is the least-squares slope of position against time over the newest
 * `windowSeconds` of samples. A slope over real timestamps does not depend on the frame rate or on
 * missing frames. Because the newest sample has the most leverage on a slope, it is checked
 * leave-one-out and discarded when it sits far from the line through the rest.
 */

export type Vec3 = readonly [x: number, y: number, z: number];
export type MutVec3 = [x: number, y: number, z: number];

/** Default span of the velocity fit, seconds. */
export const DEFAULT_WINDOW_SECONDS = 0.09;
/** Fewest samples a fit needs. */
export const MIN_FIT_SAMPLES = 3;
/** The newest sample is dropped when it is this many metres plus 3 residual rms off the line. */
const OUTLIER_FLOOR = 0.006;
const OUTLIER_RMS_FACTOR = 3;

/** Fixed-capacity ring buffer of `(t, x, y, z)` samples. Pushing never allocates. */
export class SampleWindow {
  readonly capacity: number;
  private readonly times: Float64Array;
  private readonly coords: Float64Array;
  private head = 0;
  private count = 0;

  constructor(capacity = 48) {
    if (!Number.isInteger(capacity) || capacity < MIN_FIT_SAMPLES) {
      throw new RangeError(`capacity must be an integer of at least ${MIN_FIT_SAMPLES}`);
    }
    this.capacity = capacity;
    this.times = new Float64Array(capacity);
    this.coords = new Float64Array(capacity * 3);
  }

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Appends a sample, evicting the oldest when full. A sample not newer than the last is ignored. */
  push(t: number, x: number, y: number, z: number): void {
    if (this.count > 0 && t <= this.timeAt(this.count - 1)) return;
    const slot = this.head;
    this.times[slot] = t;
    this.coords[slot * 3] = x;
    this.coords[slot * 3 + 1] = y;
    this.coords[slot * 3 + 2] = z;
    this.head = (slot + 1) % this.capacity;
    if (this.count < this.capacity) this.count += 1;
  }

  /** Time of sample `i`, 0 the oldest. */
  timeAt(i: number): number {
    return this.times[this.slot(i)] as number;
  }

  /** Coordinate `axis` (0 x, 1 y, 2 z) of sample `i`, 0 the oldest. */
  coordAt(i: number, axis: 0 | 1 | 2): number {
    return this.coords[this.slot(i) * 3 + axis] as number;
  }

  private slot(i: number): number {
    return (this.head - this.count + i + this.capacity) % this.capacity;
  }
}

export interface ReleaseVelocityOptions {
  /** Span of the fit, seconds, counted back from the newest sample. */
  windowSeconds?: number;
  /** Write the result here instead of allocating. */
  out?: MutVec3;
}

/** Linear fit of samples `lo..hi` per axis. Returns the mean time and writes slope and mean position. */
function linearFit(
  w: SampleWindow,
  lo: number,
  hi: number,
  slope: MutVec3,
  mean: MutVec3,
): { tMean: number } {
  const n = hi - lo + 1;
  let tMean = 0;
  for (let i = lo; i <= hi; i++) tMean += w.timeAt(i);
  tMean /= n;
  let stt = 0;
  for (let i = lo; i <= hi; i++) stt += (w.timeAt(i) - tMean) ** 2;
  for (const axis of [0, 1, 2] as const) {
    let pMean = 0;
    for (let i = lo; i <= hi; i++) pMean += w.coordAt(i, axis);
    pMean /= n;
    let stp = 0;
    for (let i = lo; i <= hi; i++) stp += (w.timeAt(i) - tMean) * (w.coordAt(i, axis) - pMean);
    mean[axis] = pMean;
    slope[axis] = stt > 0 ? stp / stt : 0;
  }
  return { tMean };
}

/**
 * Velocity in metres per second at the release, or null with fewer than `MIN_FIT_SAMPLES` samples in
 * the window. The window is anchored on the newest sample, so a dropped final frame only makes the
 * estimate one frame older.
 */
export function releaseVelocity(
  w: SampleWindow,
  options: ReleaseVelocityOptions = {},
): MutVec3 | null {
  const span = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  const n = w.size;
  if (n < MIN_FIT_SAMPLES) return null;
  const newest = n - 1;
  const cutoff = w.timeAt(newest) - span - 1e-9;
  let lo = newest;
  while (lo > 0 && w.timeAt(lo - 1) >= cutoff) lo -= 1;
  if (newest - lo + 1 < MIN_FIT_SAMPLES) return null;

  const slope: MutVec3 = options.out ?? [0, 0, 0];
  const mean: MutVec3 = [0, 0, 0];
  let hi = newest;
  if (newest - lo >= MIN_FIT_SAMPLES) {
    // Leave-one-out on the newest sample: fit without it, then see how far it lands from the line.
    const { tMean } = linearFit(w, lo, newest - 1, slope, mean);
    let sumSq = 0;
    for (let i = lo; i < newest; i++) {
      const dt = w.timeAt(i) - tMean;
      for (const axis of [0, 1, 2] as const) {
        sumSq += (w.coordAt(i, axis) - (mean[axis] + slope[axis] * dt)) ** 2;
      }
    }
    const rms = Math.sqrt(sumSq / (newest - lo));
    const dt = w.timeAt(newest) - tMean;
    let miss = 0;
    for (const axis of [0, 1, 2] as const) {
      miss += (w.coordAt(newest, axis) - (mean[axis] + slope[axis] * dt)) ** 2;
    }
    if (Math.sqrt(miss) > OUTLIER_FLOOR + OUTLIER_RMS_FACTOR * rms) hi = newest - 1;
  }
  linearFit(w, lo, hi, slope, mean);
  return slope;
}
