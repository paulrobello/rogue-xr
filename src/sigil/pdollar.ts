import type { Point, Stroke } from './types.ts';

/**
 * The $P point-cloud recognizer core (Vatavu, Anthony & Wobbrock, "Gestures as Point Clouds",
 * ICMI 2012). A gesture becomes an unordered cloud of N points, so stroke count, order and
 * direction do not matter. Rotation is not normalized: sigils are drawn upright on the plate.
 */

/** Cloud size. The paper finds N = 32 already reaches peak accuracy. */
export const CLOUD_SIZE = 64;

/** Greedy-match start stride exponent ε from the paper (step = ⌊N^(1-ε)⌋). */
const EPSILON = 0.5;

interface CloudPoint {
  readonly x: number;
  readonly y: number;
  readonly stroke: number;
}

export type Cloud = readonly Point[];

/** Flatten strokes into stroke-tagged points, dropping empty strokes. */
function tag(strokes: readonly Stroke[]): CloudPoint[] {
  const points: CloudPoint[] = [];
  strokes.forEach((stroke, index) => {
    for (const p of stroke) points.push({ x: p.x, y: p.y, stroke: index });
  });
  return points;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Total drawn length, never bridging the gap between two strokes. */
function pathLength(points: readonly CloudPoint[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as CloudPoint;
    const b = points[i] as CloudPoint;
    if (a.stroke === b.stroke) length += distance(a, b);
  }
  return length;
}

/** Resample to `n` points evenly spaced along the drawn path. */
function resample(input: readonly CloudPoint[], n: number): CloudPoint[] {
  const points = [...input];
  const interval = pathLength(points) / (n - 1);
  let carried = 0;
  const out: CloudPoint[] = [points[0] as CloudPoint];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as CloudPoint;
    const b = points[i] as CloudPoint;
    if (a.stroke !== b.stroke) continue;
    const d = distance(a, b);
    if (carried + d >= interval && d > 0) {
      const t = (interval - carried) / d;
      const q: CloudPoint = {
        x: a.x + t * (b.x - a.x),
        y: a.y + t * (b.y - a.y),
        stroke: a.stroke,
      };
      out.push(q);
      points.splice(i, 0, q);
      carried = 0;
    } else {
      carried += d;
    }
  }
  const last = points[points.length - 1] as CloudPoint;
  while (out.length < n) out.push(last);
  return out.slice(0, n);
}

/** Uniform scale into the unit box (aspect ratio preserved), then centre the centroid on the origin. */
function normalizePosition(points: readonly CloudPoint[]): Point[] {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const size = Math.max(maxX - minX, maxY - minY);
  const scaled = points.map((p) => ({ x: (p.x - minX) / size, y: (p.y - minY) / size }));
  const cx = scaled.reduce((sum, p) => sum + p.x, 0) / scaled.length;
  const cy = scaled.reduce((sum, p) => sum + p.y, 0) / scaled.length;
  return scaled.map((p) => ({ x: p.x - cx, y: p.y - cy }));
}

/**
 * Normalize strokes into a $P cloud: resample to `n`, scale, translate to the centroid.
 * Returns `null` for a trace with no drawn length (empty, or a single dot), which cannot be scored.
 */
export function toCloud(strokes: readonly Stroke[], n: number = CLOUD_SIZE): Cloud | null {
  const points = tag(strokes);
  if (points.length < 2 || pathLength(points) <= 0) return null;
  return normalizePosition(resample(points, n));
}

/**
 * Weighted cloud distance from `start`: each point of `a`, in order, claims its nearest unclaimed
 * point of `b`; earlier claims weigh more (weight 1 - k/n for the k-th claim).
 */
function cloudDistance(
  distances: Float64Array,
  n: number,
  start: number,
  transposed: boolean,
): number {
  const matched = new Array<boolean>(n).fill(false);
  let sum = 0;
  let i = start;
  do {
    let best = Number.POSITIVE_INFINITY;
    let index = -1;
    for (let j = 0; j < n; j++) {
      if (matched[j]) continue;
      const d = distances[transposed ? j * n + i : i * n + j];
      if (d < best) {
        best = d;
        index = j;
      }
    }
    matched[index] = true;
    const weight = 1 - ((i - start + n) % n) / n;
    sum += weight * best;
    i = (i + 1) % n;
  } while (i !== start);
  return sum;
}

/**
 * $P greedy cloud match, normalized to a mean per-point distance in unit-box units: the paper's
 * minimum weighted sum over several starts in both directions, divided by the weight total
 * (N + 1) / 2, so the value no longer depends on the cloud size.
 */
export function greedyCloudMatch(a: Cloud, b: Cloud): number {
  const n = a.length;
  // All start positions and both traversal directions share the same pairwise distances.
  const distances = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) distances[i * n + j] = distance(a[i] as Point, b[j] as Point);
  }
  const step = Math.floor(n ** (1 - EPSILON));
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i += step) {
    min = Math.min(
      min,
      cloudDistance(distances, n, i, false),
      cloudDistance(distances, n, i, true),
    );
  }
  return min / ((n + 1) / 2);
}
