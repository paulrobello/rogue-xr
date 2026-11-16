/**
 * The played-card burn (H4): a card that leaves the hand flares amber, drifts toward where it was
 * played and burns away from its edges inward over `BURN_SECONDS`. This module is the timing only,
 * with no three.js: `burnFrame` maps progress to the shader and motion inputs, and `BurnPool` is a
 * fixed set of slots so the fan draws the burning cards as spare instances of its one card mesh.
 */

export const BURN_SECONDS = 0.6;
/** Progress at which the flare peaks; it fades out by `FLARE_FADE`. */
export const FLARE_PEAK = 0.06;
export const FLARE_FADE = 0.35;
/** Progress at which the burn front leaves the card edge. */
export const BURN_START = 0.08;
/** Fraction of its size the card loses by the end of the burn. */
export const BURN_SHRINK = 0.3;

export interface BurnFrame {
  /** Progress 0..1. */
  u: number;
  /** Burn front 0 (whole card) to 1 (all burnt). */
  burn: number;
  /** Amber flare 0..1 over the whole face. */
  flare: number;
  /** Fraction of the drift covered, eased out. */
  travel: number;
  /** Size multiplier. */
  scale: number;
}

export const newBurnFrame = (): BurnFrame => ({ u: 0, burn: 0, flare: 0, travel: 0, scale: 1 });

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** The shader and motion inputs at progress `u`, written into `out`. */
export function burnFrame(u: number, out: BurnFrame): BurnFrame {
  const k = clamp01(u);
  out.u = k;
  out.flare =
    k < FLARE_PEAK ? k / FLARE_PEAK : clamp01(1 - (k - FLARE_PEAK) / (FLARE_FADE - FLARE_PEAK));
  const b = clamp01((k - BURN_START) / (1 - BURN_START));
  out.burn = b * b * (3 - 2 * b);
  out.travel = 1 - (1 - k) ** 3;
  out.scale = 1 - BURN_SHRINK * k;
  return out;
}

/**
 * Fixed slots for burning cards. `start` takes a free slot, or the oldest burning one when all are
 * busy; `update` advances every live slot and frees those that finished. No allocation after
 * construction.
 */
export class BurnPool {
  readonly capacity: number;
  readonly seconds: number;
  private readonly elapsed: Float64Array;
  private readonly live: Uint8Array;
  private readonly started: Float64Array;
  private readonly seeds: Float32Array;
  private serial = 0;
  private liveCount = 0;

  constructor(capacity: number, seconds = BURN_SECONDS) {
    if (capacity < 1) throw new RangeError('a burn pool needs at least one slot');
    if (!(seconds > 0)) throw new RangeError('burn duration must be positive');
    this.capacity = capacity;
    this.seconds = seconds;
    this.elapsed = new Float64Array(capacity);
    this.live = new Uint8Array(capacity);
    this.started = new Float64Array(capacity);
    this.seeds = new Float32Array(capacity);
  }

  /** Slots burning right now. */
  get active(): number {
    return this.liveCount;
  }

  /** Starts a burn and returns its slot. */
  start(): number {
    let slot = -1;
    let oldest = -1;
    for (let i = 0; i < this.capacity; i++) {
      if (!this.live[i]) {
        slot = i;
        break;
      }
      if (oldest < 0 || (this.started[i] as number) < (this.started[oldest] as number)) oldest = i;
    }
    if (slot < 0) slot = oldest;
    else this.liveCount++;
    this.serial++;
    this.live[slot] = 1;
    this.elapsed[slot] = 0;
    this.started[slot] = this.serial;
    // A golden-ratio sequence, so consecutive burns get different noise without a random stream.
    this.seeds[slot] = (this.serial * 0.618034) % 1;
    return slot;
  }

  /** Advances every burn by `dt` seconds and frees the finished ones. */
  update(dt: number): void {
    if (this.liveCount === 0) return;
    const step = Math.max(0, dt);
    for (let i = 0; i < this.capacity; i++) {
      if (!this.live[i]) continue;
      const t = (this.elapsed[i] as number) + step;
      this.elapsed[i] = t;
      if (t >= this.seconds) {
        this.live[i] = 0;
        this.liveCount--;
      }
    }
  }

  isLive(slot: number): boolean {
    return this.live[slot] === 1;
  }

  /** Progress 0..1 of the burn in `slot`; 1 once it has finished. */
  progress(slot: number): number {
    if (!this.live[slot]) return 1;
    return Math.min(1, (this.elapsed[slot] as number) / this.seconds);
  }

  /** The slot's noise seed, 0..1. */
  seed(slot: number): number {
    return this.seeds[slot] as number;
  }

  clear(): void {
    this.live.fill(0);
    this.liveCount = 0;
  }
}
