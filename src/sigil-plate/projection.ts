import {
  MIN_SCORE,
  PERFECT_SCORE,
  type Point,
  recognize,
  type SigilId,
  type SigilLevel,
  type Stroke,
  scoreAgainst,
  scoreToMultiplier,
} from '../sigil/index.ts';

/**
 * Sigil plate projection and scoring. Pure: no three.js runtime import. This module is the one
 * scoring path for the XR controller tip and the desktop mouse: both project a point onto the plate,
 * feed a `TraceBuilder`, and call `scoreTrace`.
 *
 * Plate space is the plate's own 2D frame in metres from its centre: +x along `pose.right`, +y along
 * `pose.up`. That is the same handedness the sigil templates are authored in, so a stroke built here
 * goes straight to the recognizer, which normalizes position and scale.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A plate in space. `right`, `up` and `normal` are orthonormal and right-handed (right = up × normal). */
export interface PlatePose {
  readonly center: Vec3;
  readonly right: Vec3;
  readonly up: Vec3;
  /** Faces the player. */
  readonly normal: Vec3;
  /** Half extents along `right` and `up`, metres. */
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/** A tip point beyond this distance from the plate plane is not drawing on it (metres, both sides). */
export const MAX_PLATE_DEPTH = 0.08;
/** Points this far outside the plate edge still count, so a stroke may overshoot slightly (metres). */
export const PLATE_MARGIN = 0.04;
/** Consecutive trace points closer than this are dropped, so the cloud is not dominated by jitter (metres). */
export const MIN_POINT_SPACING = 0.012;
/** Cap on stored trace points; further points are ignored. Sizes the plate's trail buffer. */
export const MAX_TRACE_POINTS = 600;
/** Fewer trace points than this is a stray trigger tap, not a cast. */
export const MIN_CAST_POINTS = 8;
/** From this score a trace reads as Clean; below it, but at least MIN_SCORE, Rough. */
export const CLEAN_SCORE = 0.85;

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z);
  if (!(l > 1e-9)) throw new Error('Cannot normalize a zero-length vector');
  return scale(a, 1 / l);
}

/**
 * Builds an orthonormal plate pose. `normal` is the direction the plate faces (toward the player);
 * `upHint` picks the roll and need only be non-parallel to it (default world up, falling back to the
 * world -Z axis when the plate faces straight up or down).
 */
export function makePlatePose(
  center: Vec3,
  normal: Vec3,
  halfWidth: number,
  halfHeight: number = halfWidth,
  upHint: Vec3 = { x: 0, y: 1, z: 0 },
): PlatePose {
  const n = normalize(normal);
  let hint = upHint;
  if (Math.abs(dot(normalize(hint), n)) > 0.999) hint = { x: 0, y: 0, z: -1 };
  const up = normalize(sub(hint, scale(n, dot(hint, n))));
  const right = cross(up, n);
  return { center, right, up, normal: n, halfWidth, halfHeight };
}

export interface PlateAboveTableOptions {
  /** Toward the enemies from the table centre, metres. */
  forwardOffset?: number;
  /** Height of the plate centre above the table top, metres. */
  lift?: number;
  /** How far the plate leans back to face the seated player's eyes, degrees. */
  tiltDeg?: number;
  halfWidth?: number;
  halfHeight?: number;
}

/** The fields of `TablePose` (src/combat/placement.ts) the plate needs. */
export interface TableFrame {
  x: number;
  z: number;
  /** Heading from the player toward the enemies, degrees (forward = [sin yaw, -cos yaw] on x/z). */
  yaw: number;
  /** Table top height above the floor, metres. */
  height: number;
}

/** Default plate pose over the combat table: facing the seated player, leaning back, above the far half. */
export function platePoseAboveTable(
  table: TableFrame,
  {
    forwardOffset = 0.1,
    lift = 0.5,
    tiltDeg = 25,
    halfWidth = 0.22,
    halfHeight = 0.22,
  }: PlateAboveTableOptions = {},
): PlatePose {
  const yaw = (table.yaw * Math.PI) / 180;
  const fx = Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const tilt = (tiltDeg * Math.PI) / 180;
  const center: Vec3 = {
    x: table.x + fx * forwardOffset,
    y: table.height + lift,
    z: table.z + fz * forwardOffset,
  };
  const normal: Vec3 = {
    x: -fx * Math.cos(tilt),
    y: Math.sin(tilt),
    z: -fz * Math.cos(tilt),
  };
  return makePlatePose(center, normal, halfWidth, halfHeight);
}

export interface PlateHit {
  /** Plate-space coordinates, metres from the centre. */
  readonly x: number;
  readonly y: number;
  /** Signed distance in front of the plate (+ toward the player), metres. */
  readonly depth: number;
}

/** Plain projection of a 3D point onto the plate plane, with no tolerance checks. */
export function projectToPlate(pose: PlatePose, point: Vec3): PlateHit {
  const d = sub(point, pose.center);
  return { x: dot(d, pose.right), y: dot(d, pose.up), depth: dot(d, pose.normal) };
}

export interface ProjectionTolerance {
  maxDepth?: number;
  margin?: number;
}

/** True when plate-space (x, y) is on the plate or within `margin` of its edge. */
export function insidePlate(
  pose: PlatePose,
  x: number,
  y: number,
  margin: number = PLATE_MARGIN,
): boolean {
  return Math.abs(x) <= pose.halfWidth + margin && Math.abs(y) <= pose.halfHeight + margin;
}

/**
 * Projects a controller tip onto the plate. Returns null when the tip is not drawing on it: farther
 * than `maxDepth` from the plate plane on either side, or outside the plate bounds plus `margin`.
 */
export function projectTip(
  pose: PlatePose,
  point: Vec3,
  { maxDepth = MAX_PLATE_DEPTH, margin = PLATE_MARGIN }: ProjectionTolerance = {},
): Point | null {
  const hit = projectToPlate(pose, point);
  if (!Number.isFinite(hit.x + hit.y + hit.depth)) return null;
  if (Math.abs(hit.depth) > maxDepth) return null;
  if (!insidePlate(pose, hit.x, hit.y, margin)) return null;
  return { x: hit.x, y: hit.y };
}

/**
 * Intersects a ray with the plate plane. Null when the ray is parallel to the plane, points away from
 * it, or lands outside the plate bounds plus `margin`. `direction` need not be normalized.
 */
export function rayToPlate(
  pose: PlatePose,
  origin: Vec3,
  direction: Vec3,
  margin: number = PLATE_MARGIN,
): Point | null {
  const denom = dot(direction, pose.normal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot(sub(pose.center, origin), pose.normal) / denom;
  if (!(t >= 0)) return null;
  const hit = projectToPlate(pose, {
    x: origin.x + direction.x * t,
    y: origin.y + direction.y * t,
    z: origin.z + direction.z * t,
  });
  if (!insidePlate(pose, hit.x, hit.y, margin)) return null;
  return { x: hit.x, y: hit.y };
}

/**
 * One controller sample on the plate: the tip when it touches the plate (`projectTip`), else where
 * the controller ray meets it (`rayToPlate`), else null. Feed the result to the trace once per
 * frame: feeding a tip miss and a ray hit separately closes the stroke on every frame.
 */
export function penToPlate(
  pose: PlatePose,
  tip: Vec3,
  ray: { readonly origin: Vec3; readonly direction: Vec3 } | null,
): Point | null {
  return projectTip(pose, tip) ?? (ray ? rayToPlate(pose, ray.origin, ray.direction) : null);
}

/** The slice of a three.js camera that mouse picking needs: both matrices must be current. */
export interface RayCamera {
  readonly matrixWorld: { readonly elements: ArrayLike<number> };
  readonly projectionMatrixInverse: { readonly elements: ArrayLike<number> };
}

/** `e` is a column-major 4x4; returns row `i` of `e` dotted with (a, b, c, d). */
function row(e: ArrayLike<number>, i: number, a: number, b: number, c: number, d: number): number {
  return (
    (e[i] as number) * a +
    (e[4 + i] as number) * b +
    (e[8 + i] as number) * c +
    (e[12 + i] as number) * d
  );
}

function unproject(camera: RayCamera, x: number, y: number, z: number): Vec3 {
  const p = camera.projectionMatrixInverse.elements;
  const m = camera.matrixWorld.elements;
  const w = row(p, 3, x, y, z, 1);
  const vx = row(p, 0, x, y, z, 1) / w;
  const vy = row(p, 1, x, y, z, 1) / w;
  const vz = row(p, 2, x, y, z, 1) / w;
  return { x: row(m, 0, vx, vy, vz, 1), y: row(m, 1, vx, vy, vz, 1), z: row(m, 2, vx, vy, vz, 1) };
}

/**
 * Desktop equivalent of `projectTip`: casts the mouse ray through `camera` onto the plate. `ndc` is
 * normalized device coordinates (x right, y up, both -1..1), i.e. the pointer position over the canvas
 * as `(2 * px / width - 1, 1 - 2 * py / height)`. Call `camera.updateMatrixWorld()` and, after any
 * projection change, `camera.updateProjectionMatrix()` first. Works for perspective and orthographic cameras.
 */
export function mouseToPlate(
  ndc: Point,
  camera: RayCamera,
  pose: PlatePose,
  margin: number = PLATE_MARGIN,
): Point | null {
  const near = unproject(camera, ndc.x, ndc.y, -1);
  const far = unproject(camera, ndc.x, ndc.y, 1);
  if (!Number.isFinite(near.x + near.y + near.z + far.x + far.y + far.z)) return null;
  return rayToPlate(pose, near, sub(far, near), margin);
}

export interface TraceBuilderOptions {
  minSpacing?: number;
  maxPoints?: number;
}

/**
 * Accumulates plate-space points into strokes. A stroke is one trigger-down (or mouse-down) to
 * trigger-up. A tip that leaves the plate mid-stroke (`add(null)`) ends the current stroke segment
 * and starts a new stroke on re-entry, so the recognizer never sees a straight line bridging the gap.
 * Points closer than `minSpacing` to the previous one are dropped.
 */
export class TraceBuilder {
  readonly minSpacing: number;
  readonly maxPoints: number;
  private readonly all: Point[][] = [];
  private current: Point[] | null = null;
  private drawing = false;
  private count = 0;

  constructor({
    minSpacing = MIN_POINT_SPACING,
    maxPoints = MAX_TRACE_POINTS,
  }: TraceBuilderOptions = {}) {
    this.minSpacing = minSpacing;
    this.maxPoints = maxPoints;
  }

  /** Strokes recorded so far, in draw order. Read-only view: do not mutate. */
  get strokes(): readonly Stroke[] {
    return this.all;
  }

  get pointCount(): number {
    return this.count;
  }

  get isDrawing(): boolean {
    return this.drawing;
  }

  /** Trigger down: the next accepted point opens a new stroke. */
  beginStroke(): void {
    this.closeCurrent();
    this.drawing = true;
  }

  /**
   * Feeds one projected point (or null when the tip is off the plate). Returns true when the point was
   * stored. Ignored unless a stroke is open.
   */
  add(point: Point | null): boolean {
    if (!this.drawing) return false;
    if (point === null) {
      this.closeCurrent();
      return false;
    }
    if (this.count >= this.maxPoints) return false;
    if (this.current === null) {
      this.current = [point];
      this.all.push(this.current);
      this.count++;
      return true;
    }
    const last = this.current[this.current.length - 1] as Point;
    if (Math.hypot(point.x - last.x, point.y - last.y) < this.minSpacing) return false;
    this.current.push(point);
    this.count++;
    return true;
  }

  /** Trigger up. A lone point cannot form a stroke and is discarded. */
  endStroke(): void {
    this.drawing = false;
    this.closeCurrent();
  }

  clear(): void {
    this.all.length = 0;
    this.current = null;
    this.drawing = false;
    this.count = 0;
  }

  private closeCurrent(): void {
    if (this.current !== null && this.current.length < 2) {
      this.all.pop();
      this.count -= this.current.length;
    }
    this.current = null;
  }
}

export type SigilQuality = 'Fizzle' | 'Rough' | 'Clean' | 'Masterful';

/** Quality word for a sigil score: Fizzle below MIN_SCORE, Rough, Clean from 0.85, Masterful from PERFECT_SCORE. */
export function qualityWord(score: number): SigilQuality {
  if (!(score >= MIN_SCORE)) return 'Fizzle';
  if (score >= PERFECT_SCORE) return 'Masterful';
  if (score >= CLEAN_SCORE) return 'Clean';
  return 'Rough';
}

/** Multiplier text for the in-scene label, e.g. "×1.18". */
export function formatMultiplier(multiplier: number): string {
  return `×${multiplier.toFixed(2)}`;
}

export interface TraceResult {
  readonly sigilId: SigilId;
  /** Match against the card's own sigil, 0..1. */
  readonly score: number;
  /** Trace power from `scoreToMultiplier` (0.5..1.25), or committed power after a plate cast. */
  readonly multiplier: number;
  readonly quality: SigilQuality;
  /** The best-matching authored sigil, for "you drew X" feedback. */
  readonly recognizedAs: SigilId;
  readonly points: number;
  /** False for a stray tap with fewer than MIN_CAST_POINTS points: do not cast. */
  readonly castable: boolean;
}

/**
 * Scores a trace against the card's sigil. THE scoring path: the XR plate, the desktop mouse and the
 * combat view all end here, delegating to `scoreAgainst` and `scoreToMultiplier` in src/sigil.
 * The trace is judged at the run's level, Casual by default.
 */
export function scoreTrace(
  strokes: readonly Stroke[],
  sigilId: SigilId,
  level: SigilLevel = 'casual',
): TraceResult {
  const points = strokes.reduce((sum, stroke) => sum + stroke.length, 0);
  const score = scoreAgainst(strokes, sigilId, level);
  return {
    sigilId,
    score,
    multiplier: scoreToMultiplier(score),
    quality: qualityWord(score),
    recognizedAs: recognize(strokes).id,
    points,
    castable: points >= MIN_CAST_POINTS,
  };
}
