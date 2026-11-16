import * as THREE from 'three';

export interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** A desktop view: pitch (radians, negative looks down) and the vertical field of view in degrees. */
export interface CombatFraming {
  pitch: number;
  fov: number;
}

export interface FramingInput {
  /** The camera's world position. */
  eye: XYZ;
  /** The walker heading in degrees (the table's yaw), forward is (sin, -cos) on the floor. */
  headingDeg: number;
  aspect: number;
  /** The vertical field of view the view starts from. */
  baseFov: number;
  /** Points that must be on screen: the dice tray and the sigil plate. */
  must: readonly XYZ[];
  /** Points that should be on screen when the field of view allows: the automatons. */
  want: readonly XYZ[];
  /** Largest normalized device coordinate a point may reach (1 is the screen edge). */
  margin?: number;
  /**
   * Lowest normalized device y a `must` point may take (default `-margin`). The desktop hand strip
   * owns the band below it, so the dice tray never sits behind the cards.
   */
  floor?: number;
  /** The widest vertical field of view the fit may use. */
  maxFov?: number;
}

const DEFAULT_MARGIN = 0.88;
const DEFAULT_MAX_FOV = 95;
const FOV_STEP = 5;
const PITCH_STEP = 0.01;
const PITCH_LIMIT = 1.4;

/**
 * Projects a world point through a camera at `eye` that is turned to `headingDeg` and pitched by
 * `pitch`, returning its normalized device coordinates or null when it is behind the camera.
 */
export function projectToNdc(
  point: XYZ,
  eye: XYZ,
  headingDeg: number,
  pitch: number,
  fovDeg: number,
  aspect: number,
): { x: number; y: number } | null {
  const heading = THREE.MathUtils.degToRad(headingDeg);
  const dx = point.x - eye.x;
  const dz = point.z - eye.z;
  const forward = dx * Math.sin(heading) - dz * Math.cos(heading);
  const lateral = dx * Math.cos(heading) + dz * Math.sin(heading);
  const dy = point.y - eye.y;
  const depth = forward * Math.cos(pitch) + dy * Math.sin(pitch);
  if (depth <= 1e-3) return null;
  const up = -forward * Math.sin(pitch) + dy * Math.cos(pitch);
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2);
  return { x: lateral / (depth * tanHalf * aspect), y: up / (depth * tanHalf) };
}

/**
 * The largest extent of `points` in the view, compared against `margin`. With a `floor`, a point
 * below it counts as far out as it is under the floor, so the result stays at or under `margin`
 * exactly when every point is inside the margin and at or above the floor.
 */
function worst(
  points: readonly XYZ[],
  input: FramingInput,
  pitch: number,
  fov: number,
  margin: number,
  floor = -margin,
): number {
  let out = 0;
  for (const p of points) {
    const n = projectToNdc(p, input.eye, input.headingDeg, pitch, fov, input.aspect);
    if (!n) return Number.POSITIVE_INFINITY;
    out = Math.max(out, Math.abs(n.x), n.y, margin + floor - n.y);
  }
  return out;
}

/**
 * The desktop pitch and field of view that keep `must` on screen and, when the field of view can
 * widen enough, `want` as well. The pitch is the best centred one for the whole set, and the field
 * of view widens in steps from `baseFov` only as far as the fit needs.
 */
export function fitCombatFraming(input: FramingInput): CombatFraming {
  const margin = input.margin ?? DEFAULT_MARGIN;
  const maxFov = Math.max(input.maxFov ?? DEFAULT_MAX_FOV, input.baseFov);
  let fallback: CombatFraming = { pitch: 0, fov: input.baseFov };
  let fallbackMust = Number.POSITIVE_INFINITY;
  for (let fov = input.baseFov; fov <= maxFov + 1e-6; fov += FOV_STEP) {
    let best: { pitch: number; score: number } | null = null;
    for (let pitch = 0; pitch >= -PITCH_LIMIT; pitch -= PITCH_STEP) {
      const mustWorst = worst(input.must, input, pitch, fov, margin, input.floor);
      if (mustWorst < fallbackMust) {
        fallbackMust = mustWorst;
        fallback = { pitch, fov };
      }
      if (mustWorst > margin) continue;
      const score = Math.max(mustWorst, worst(input.want, input, pitch, fov, margin));
      if (!best || score < best.score) best = { pitch, score };
    }
    if (best && (best.score <= margin || fov + FOV_STEP > maxFov + 1e-6)) {
      return { pitch: best.pitch, fov };
    }
  }
  return fallback;
}
