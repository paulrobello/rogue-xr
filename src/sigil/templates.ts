import type { Point, SigilId, SigilTemplate, Stroke } from './types.ts';

/**
 * The five sigil templates, authored as plate-space strokes (+y up, roughly a unit box).
 * Each is sampled from a simple parametric curve so the set is deterministic and easy to restyle.
 * The guide glyph shown on the plate should be drawn from these same strokes.
 */

/** Sample `count` points of `f(t)` for t evenly spaced over [0, 1]. */
export function sampleCurve(count: number, f: (t: number) => Point): Point[] {
  return Array.from({ length: count }, (_, i) => f(i / (count - 1)));
}

/** Straight segments through `corners`, `perSegment` points per segment. */
export function polyline(corners: readonly Point[], perSegment: number): Point[] {
  const out: Point[] = [];
  for (let s = 0; s < corners.length - 1; s++) {
    const a = corners[s] as Point;
    const b = corners[s + 1] as Point;
    for (let i = 0; i < perSegment; i++) {
      const t = i / perSegment;
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
    }
  }
  out.push(corners[corners.length - 1] as Point);
  return out;
}

const TAU = Math.PI * 2;

/**
 * Gear: a hub ring crossed by a vertical and a horizontal spoke that reach past it (three strokes).
 * The spokes overshooting the ring keep it apart from the spiral, which fills the same disc.
 */
const GEAR_HUB_RADIUS = 0.3;
const gear: readonly Stroke[] = [
  sampleCurve(48, (t) => ({
    x: 0.5 + GEAR_HUB_RADIUS * Math.cos(TAU * t),
    y: 0.5 + GEAR_HUB_RADIUS * Math.sin(TAU * t),
  })),
  polyline(
    [
      { x: 0.5, y: 1 },
      { x: 0.5, y: 0 },
    ],
    12,
  ),
  polyline(
    [
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
    ],
    12,
  ),
];

/** Flame: a teardrop with its point up, round belly at the bottom (one closed stroke). */
const flame: readonly Stroke[] = [
  sampleCurve(48, (t) => {
    const a = TAU * t;
    // Tip at a = 0 (top); the belly widens toward a = π.
    const sinHalf = Math.sin(a / 2);
    return { x: 0.5 + 0.38 * Math.sin(a) * sinHalf, y: 0.5 + 0.5 * Math.cos(a) };
  }),
];

/** Ward: a shield — flat top, straight sides, two arcs meeting in a point at the bottom (one closed stroke). */
const WARD_SIDE_X = 0.1;
const WARD_SIDE_BOTTOM = 0.55;
/** Centre x of the left arc, solved so the arc leaves the side vertically and meets x = 0.5 at y = 0. */
const WARD_ARC_CX = (0.25 + WARD_SIDE_BOTTOM ** 2 - WARD_SIDE_X ** 2) / (1 - 2 * WARD_SIDE_X);
const WARD_ARC_R = WARD_ARC_CX - WARD_SIDE_X;
const WARD_ARC_SPAN = Math.atan2(WARD_SIDE_BOTTOM, WARD_ARC_CX - 0.5);
const wardLeftArc = sampleCurve(14, (t) => {
  const a = Math.PI + WARD_ARC_SPAN * t;
  return {
    x: WARD_ARC_CX + WARD_ARC_R * Math.cos(a),
    y: WARD_SIDE_BOTTOM + WARD_ARC_R * Math.sin(a),
  };
});
const ward: readonly Stroke[] = [
  [
    ...polyline(
      [
        { x: 0.5, y: 1 },
        { x: WARD_SIDE_X, y: 1 },
        { x: WARD_SIDE_X, y: WARD_SIDE_BOTTOM },
      ],
      8,
    ).slice(0, -1),
    ...wardLeftArc,
    ...wardLeftArc
      .slice(0, -1)
      .reverse()
      .map((p) => ({ x: 1 - p.x, y: p.y })),
    ...polyline(
      [
        { x: 1 - WARD_SIDE_X, y: WARD_SIDE_BOTTOM },
        { x: 1 - WARD_SIDE_X, y: 1 },
        { x: 0.5, y: 1 },
      ],
      8,
    ).slice(1),
  ],
];

/** Bolt: a lightning zigzag from top right to bottom left (one open stroke). */
const bolt: readonly Stroke[] = [
  polyline(
    [
      { x: 0.65, y: 1 },
      { x: 0.2, y: 0.45 },
      { x: 0.8, y: 0.55 },
      { x: 0.35, y: 0 },
    ],
    12,
  ),
];

/** Spiral: an Archimedean spiral of two and a half turns, centre outward (one open stroke). */
const spiral: readonly Stroke[] = [
  sampleCurve(64, (t) => {
    const a = 2.5 * TAU * t;
    return { x: 0.5 + 0.5 * t * Math.cos(a), y: 0.5 + 0.5 * t * Math.sin(a) };
  }),
];

/** Anchor: looped crown, stem, and two flukes. */
const anchor: readonly Stroke[] = [
  polyline(
    [
      { x: 0.5, y: 1 },
      { x: 0.22, y: 0.78 },
      { x: 0.22, y: 0.58 },
      { x: 0.28, y: 0.46 },
      { x: 0.5, y: 0.4 },
      { x: 0.72, y: 0.46 },
      { x: 0.78, y: 0.58 },
      { x: 0.78, y: 0.78 },
      { x: 0.5, y: 1 },
      { x: 0.5, y: 0.4 },
      { x: 0.5, y: 0.05 },
      { x: 0.22, y: 0.2 },
      { x: 0.05, y: 0.2 },
      { x: 0.18, y: 0.34 },
    ],
    6,
  ),
  polyline(
    [
      { x: 0.5, y: 0.05 },
      { x: 0.78, y: 0.2 },
      { x: 0.95, y: 0.2 },
      { x: 0.82, y: 0.34 },
    ],
    6,
  ),
];

export const SIGIL_TEMPLATES: Readonly<Record<SigilId, SigilTemplate>> = {
  gear: { id: 'gear', strokes: gear },
  flame: { id: 'flame', strokes: flame },
  ward: { id: 'ward', strokes: ward },
  bolt: { id: 'bolt', strokes: bolt },
  spiral: { id: 'spiral', strokes: spiral },
  anchor: { id: 'anchor', strokes: anchor },
};
