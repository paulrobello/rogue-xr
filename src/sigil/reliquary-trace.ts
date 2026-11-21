import { type Cloud, toCloud } from './pdollar.ts';
import type { Point } from './types.ts';

const SAMPLE_COUNT = 32;
function matchDistance(a: Cloud, b: Cloud, reverse: boolean): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const q = b[reverse ? b.length - 1 - i : i];
    sum += Math.hypot(p.x - q.x, p.y - q.y);
  }
  return sum / a.length;
}

function traceCloud(trace: readonly Point[]): Cloud | null {
  if (trace.length < 5 || trace.length > 600) return null;
  if (trace.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  const xs = trace.map((p) => p.x);
  const ys = trace.map((p) => p.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const first = trace[0];
  const last = trace[trace.length - 1];
  if (span < 0.15 || span > 0.8 || Math.hypot(first.x - last.x, first.y - last.y) < 0.05)
    return null;
  const smoothed = trace.map((p, i) => {
    const before = trace[i - 1],
      after = trace[i + 1];
    if (!before || !after) return p;
    return { x: (before.x + 2 * p.x + after.x) / 4, y: (before.y + 2 * p.y + after.y) / 4 };
  });
  return toCloud([smoothed], SAMPLE_COUNT);
}

export function matchesReliquaryGlyph(trace: readonly Point[], glyph: readonly Point[]): boolean {
  const drawn = traceCloud(trace);
  const expected = toCloud([glyph], SAMPLE_COUNT);
  return (
    !!drawn &&
    !!expected &&
    Math.min(matchDistance(drawn, expected, false), matchDistance(drawn, expected, true)) < 0.135
  );
}
