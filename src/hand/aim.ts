/**
 * Aim assist for card play. Pure functions over plain numbers, no three.js. World space, metres,
 * y up. Table headings follow `combat/placement.ts`: degrees, 0 faces -Z, forward `(sin h, -cos h)`
 * on the floor plane and right-hand side `(cos h, sin h)`.
 */
import { TABLE_HALF_DEPTH, TABLE_HALF_WIDTH, type TablePose } from '../combat/placement.ts';
import type { Vec3 } from './velocity.ts';

export type { Vec3 };

const DEG = Math.PI / 180;

export const DEFAULT_CONE_DEG = 20;
/** Slowest release, metres per second, that counts as a throw. Below it the card is just let go. */
export const DEFAULT_MIN_SPEED = 1.5;
/** Default point-and-trigger hit radius around a target, metres. Enemies are 2 to 3 m tall. */
export const DEFAULT_POINT_RADIUS = 0.6;
/** Two candidates whose distances differ by less than this (metres) are tied and the angle decides. */
export const TIE_DISTANCE = 0.25;

export interface AimTarget {
  readonly id: string;
  readonly position: Vec3;
  /** False when the rules would refuse this target (dead, untargetable); it is never picked. */
  readonly valid: boolean;
  /** Overrides the point radius for this target, metres. */
  readonly radius?: number;
}

export interface FlingOptions {
  /** Half angle of the aim cone, degrees. */
  coneDeg?: number;
  /** Slowest throw that plays at all, metres per second. */
  minSpeed?: number;
}

export interface FlingPick {
  readonly id: string;
  /** Angle between the throw direction and the target, degrees. */
  readonly angleDeg: number;
  /** Distance from the throw origin, metres. */
  readonly distance: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export const speedOf = (velocity: Vec3): number => len(velocity);

/**
 * The target a throw plays at, or null. A throw must be at least `minSpeed`, and only valid targets
 * whose direction from `origin` is within `coneDeg` of the velocity (edge inclusive) are candidates.
 * The nearest candidate wins. Candidates within `TIE_DISTANCE` of the nearest are tied, and among
 * the tied the smallest angle wins, so a throw at the middle of two enemies standing side by side
 * goes to the one it is aimed at, not to whichever is a few centimetres closer.
 */
export function pickFlingTarget(
  origin: Vec3,
  velocity: Vec3,
  targets: readonly AimTarget[],
  options: FlingOptions = {},
): FlingPick | null {
  const cone = options.coneDeg ?? DEFAULT_CONE_DEG;
  const minSpeed = options.minSpeed ?? DEFAULT_MIN_SPEED;
  const speed = len(velocity);
  if (speed < minSpeed || speed === 0) return null;
  const cosCone = Math.cos(cone * DEG);

  const inCone: FlingPick[] = [];
  for (const target of targets) {
    if (!target.valid) continue;
    const to = sub(target.position, origin);
    const distance = len(to);
    // A target at the origin is under the card; any direction hits it.
    const cos = distance < 1e-9 ? 1 : dot(to, velocity) / (distance * speed);
    // The epsilon keeps a target exactly on the cone edge in.
    if (cos < cosCone - 1e-12) continue;
    inCone.push({
      id: target.id,
      angleDeg: Math.acos(Math.min(1, Math.max(-1, cos))) / DEG,
      distance,
    });
  }
  if (inCone.length === 0) return null;
  const nearest = Math.min(...inCone.map((c) => c.distance));
  let best: FlingPick | null = null;
  for (const c of inCone) {
    if (c.distance > nearest + TIE_DISTANCE) continue;
    if (best === null || c.angleDeg < best.angleDeg) best = c;
  }
  return best;
}

export interface AimRay {
  readonly origin: Vec3;
  /** Need not be normalized. */
  readonly direction: Vec3;
}

export interface PointPick {
  readonly id: string;
  /** Distance from the ray to the target centre, metres. */
  readonly miss: number;
  /** Distance along the ray to the closest approach, metres. */
  readonly along: number;
}

/**
 * The valid target a pointing ray passes within `radius` of (a per-target `radius` overrides it),
 * ahead of the ray origin. The target the ray passes closest to wins.
 */
export function pickPointTarget(
  ray: AimRay,
  targets: readonly AimTarget[],
  radius = DEFAULT_POINT_RADIUS,
): PointPick | null {
  const dirLen = len(ray.direction);
  if (dirLen === 0) return null;
  const dir: Vec3 = [
    ray.direction[0] / dirLen,
    ray.direction[1] / dirLen,
    ray.direction[2] / dirLen,
  ];
  let best: PointPick | null = null;
  for (const target of targets) {
    if (!target.valid) continue;
    const to = sub(target.position, ray.origin);
    const along = dot(to, dir);
    if (along < 0) continue;
    const miss = Math.sqrt(Math.max(0, dot(to, to) - along * along));
    if (miss > (target.radius ?? radius)) continue;
    if (best === null || miss < best.miss) best = { id: target.id, miss, along };
  }
  return best;
}

export interface TableHalfExtents {
  /** Half size along the table's right-hand axis. */
  readonly width: number;
  /** Half size along the table's forward axis. */
  readonly depth: number;
}

export interface TableZone {
  /** Extra footprint around the table edge, metres. */
  margin?: number;
  /** How far below the table top a point still counts, metres. */
  below?: number;
  /** How far above the table top a point still counts, metres. */
  above?: number;
}

export const DEFAULT_TABLE_HALF_EXTENTS: TableHalfExtents = {
  width: TABLE_HALF_WIDTH,
  depth: TABLE_HALF_DEPTH,
};

/** `point` expressed on the table's own axes: `[right, forward]` from its centre. */
function tableLocal(x: number, z: number, table: TablePose): [number, number] {
  const h = table.yaw * DEG;
  const dx = x - table.x;
  const dz = z - table.z;
  return [dx * Math.cos(h) + dz * Math.sin(h), dx * Math.sin(h) - dz * Math.cos(h)];
}

/** True when `point` is over the table footprint and within `below`/`above` of its top: drop to play. */
export function isOverTable(
  point: Vec3,
  table: TablePose,
  halfExtents: TableHalfExtents = DEFAULT_TABLE_HALF_EXTENTS,
  zone: TableZone = {},
): boolean {
  const margin = zone.margin ?? 0.1;
  const rise = point[1] - table.height;
  if (rise < -(zone.below ?? 0.3) || rise > (zone.above ?? 0.6)) return false;
  const [right, forward] = tableLocal(point[0], point[2], table);
  return (
    Math.abs(right) <= halfExtents.width + margin && Math.abs(forward) <= halfExtents.depth + margin
  );
}

/**
 * True when a throw from `origin` along `velocity` passes over the table footprint on the floor
 * plane, however high it flies. Lets an untargeted card be flicked at the table instead of dropped.
 */
export function throwCrossesTable(
  origin: Vec3,
  velocity: Vec3,
  table: TablePose,
  halfExtents: TableHalfExtents = DEFAULT_TABLE_HALF_EXTENTS,
  margin = 0.1,
): boolean {
  const h = table.yaw * DEG;
  const [r0, f0] = tableLocal(origin[0], origin[2], table);
  const vr = velocity[0] * Math.cos(h) + velocity[2] * Math.sin(h);
  const vf = velocity[0] * Math.sin(h) - velocity[2] * Math.cos(h);
  // Slab test for the ray `origin + t * velocity`, t >= 0, against the footprint rectangle.
  let tMin = 0;
  let tMax = Number.POSITIVE_INFINITY;
  for (const [p, v, half] of [
    [r0, vr, halfExtents.width + margin],
    [f0, vf, halfExtents.depth + margin],
  ] as const) {
    if (Math.abs(v) < 1e-12) {
      if (Math.abs(p) > half) return false;
      continue;
    }
    const a = (-half - p) / v;
    const b = (half - p) / v;
    tMin = Math.max(tMin, Math.min(a, b));
    tMax = Math.min(tMax, Math.max(a, b));
    if (tMin > tMax) return false;
  }
  return true;
}
