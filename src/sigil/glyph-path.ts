import type { Stroke } from './types.ts';

/** One straight piece of a glyph, in the template's unit box, with where it starts along the whole path. */
export interface GlyphSegment {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  /** Path length before this segment. */
  readonly start: number;
  readonly length: number;
}

/** A glyph's strokes flattened into segments in drawing order (stroke after stroke). */
export interface GlyphPath {
  readonly segments: readonly GlyphSegment[];
  /** Total length of every stroke. */
  readonly length: number;
}

/** How much of a path a reveal fraction draws: `full` whole segments, then `partial` (0..1) of the next. */
export interface GlyphReveal {
  full: number;
  partial: number;
}

export function glyphPath(strokes: readonly Stroke[]): GlyphPath {
  const segments: GlyphSegment[] = [];
  let length = 0;
  for (const stroke of strokes) {
    for (let i = 1; i < stroke.length; i++) {
      const a = stroke[i - 1] as Stroke[number];
      const b = stroke[i] as Stroke[number];
      const piece = Math.hypot(b.x - a.x, b.y - a.y);
      segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, start: length, length: piece });
      length += piece;
    }
  }
  return { segments, length };
}

/**
 * The segments drawn when `fraction` (0..1) of the path's length is revealed, written into `out`.
 * The reveal runs at constant speed along the arc, so long strokes take longer than short ones.
 */
export function revealAt(path: GlyphPath, fraction: number, out: GlyphReveal): GlyphReveal {
  const n = path.segments.length;
  const f = fraction <= 0 ? 0 : fraction >= 1 ? 1 : fraction;
  if (n === 0 || f === 0) {
    out.full = 0;
    out.partial = 0;
    return out;
  }
  if (f === 1 || path.length <= 0) {
    out.full = n;
    out.partial = 0;
    return out;
  }
  const at = f * path.length;
  // Binary search for the segment that contains `at`.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((path.segments[mid] as GlyphSegment).start <= at) lo = mid;
    else hi = mid - 1;
  }
  const seg = path.segments[lo] as GlyphSegment;
  out.full = lo;
  out.partial = seg.length > 0 ? Math.min(1, (at - seg.start) / seg.length) : 1;
  return out;
}
