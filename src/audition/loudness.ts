/** Level the review page matches every clip to when "Match loudness" is on. */
export const REVIEW_LUFS = -24;
const MAX_BOOST_DB = 12;
const PEAK_CEILING = 0.97;

interface Biquad {
  b: [number, number, number];
  a: [number, number];
}

/** BS.1770 stage 1 (head-related high shelf) at the given sample rate. */
function shelf(fs: number): Biquad {
  const gainDb = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * 1681.9744509555319) / fs);
  const vh = 10 ** (gainDb / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  return {
    b: [
      (vh + (vb * k) / q + k * k) / a0,
      (2 * (k * k - vh)) / a0,
      (vh - (vb * k) / q + k * k) / a0,
    ],
    a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
  };
}

/** BS.1770 stage 2 (revised low-frequency B-curve high-pass). */
function highPass(fs: number): Biquad {
  const q = 0.5003270373253953;
  const k = Math.tan((Math.PI * 38.13547087613982) / fs);
  const a0 = 1 + k / q + k * k;
  return { b: [1, -2, 1], a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] };
}

function filter(input: ArrayLike<number>, f: Biquad): Float64Array {
  const out = new Float64Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i] as number;
    const y0 = f.b[0] * x0 + f.b[1] * x1 + f.b[2] * x2 - f.a[0] * y1 - f.a[1] * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

const toLufs = (energy: number): number => -0.691 + 10 * Math.log10(energy);

/**
 * Gated integrated loudness (ITU-R BS.1770-4) of the first two channels, in LUFS, or null for
 * silence. Clips shorter than one 400 ms block are measured as a single zero-padded block, the
 * same convention as `scripts/assets/build_audio.py`. This is an estimate for files whose
 * loudness was never measured, so the page labels it as such.
 */
export function estimateLufs(channels: readonly Float32Array[], sampleRate: number): number | null {
  const used = channels.slice(0, 2);
  const length = used[0]?.length ?? 0;
  if (length === 0) return null;
  const shelfCoef = shelf(sampleRate);
  const hpCoef = highPass(sampleRate);
  // Prefix sums of squared K-weighted samples make every block energy two lookups.
  const prefix = used.map((ch) => {
    const weighted = filter(filter(ch, shelfCoef), hpCoef);
    const sums = new Float64Array(length + 1);
    for (let i = 0; i < length; i++) {
      sums[i + 1] = (sums[i] as number) + (weighted[i] as number) ** 2;
    }
    return sums;
  });
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const blockEnergy = (start: number, end: number): number => {
    let total = 0;
    for (const sums of prefix) total += ((sums[end] as number) - (sums[start] as number)) / block;
    return total;
  };
  const energies: number[] = [];
  if (length <= block) {
    energies.push(blockEnergy(0, length));
  } else {
    for (let start = 0; start + block <= length; start += hop) {
      energies.push(blockEnergy(start, start + block));
    }
  }
  const absolute = energies.filter((e) => e > 0 && toLufs(e) > -70);
  if (absolute.length === 0) return null;
  const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length;
  const relativeGate = toLufs(mean(absolute)) - 10;
  const gated = absolute.filter((e) => toLufs(e) > relativeGate);
  return gated.length === 0 ? null : toLufs(mean(gated));
}

/** Largest absolute sample across every channel. */
export function samplePeak(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i] as number));
  }
  return peak;
}

export interface MatchGain {
  /** Linear gain to apply. */
  gain: number;
  gainDb: number;
  /** True when the sample-peak ceiling or the boost cap stopped the gain short of the target. */
  limited: boolean;
}

/** Gain that brings a clip at `lufs` to `target`, held under the boost cap and the peak ceiling. */
export function matchGain(lufs: number, peak: number, target = REVIEW_LUFS): MatchGain {
  let db = Math.min(target - lufs, MAX_BOOST_DB);
  let limited = target - lufs > MAX_BOOST_DB;
  if (peak > 0) {
    const ceilingDb = 20 * Math.log10(PEAK_CEILING / peak);
    if (db > ceilingDb) {
      db = ceilingDb;
      limited = true;
    }
  }
  return { gain: 10 ** (db / 20), gainDb: db, limited };
}

/** Per-column [min, max] pairs of the mono mix, for drawing a waveform. */
export function computePeaks(channels: readonly Float32Array[], columns: number): Float32Array {
  const out = new Float32Array(columns * 2);
  const length = channels[0]?.length ?? 0;
  if (length === 0) return out;
  const perColumn = length / columns;
  for (let c = 0; c < columns; c++) {
    const from = Math.floor(c * perColumn);
    const to = Math.max(from + 1, Math.floor((c + 1) * perColumn));
    let lo = 0;
    let hi = 0;
    for (let i = from; i < to && i < length; i++) {
      let sum = 0;
      for (const ch of channels) sum += ch[i] as number;
      const v = sum / channels.length;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    out[c * 2] = lo;
    out[c * 2 + 1] = hi;
  }
  return out;
}
