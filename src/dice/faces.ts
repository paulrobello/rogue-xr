import {
  type Pose,
  type Quat,
  quatConjugate,
  quatFromUnitVectors,
  quatMul,
  quatSlerp,
  rotateVec,
  type Vec3,
} from './quat.ts';

/** The dice shapes the slice has: `brass-d6` is a cube, `glass-d8` an octahedron. */
export type DieKind = 'd6' | 'd8';

/** Metres. The cube's half edge and the octahedron's centre-to-vertex distance. */
export const D6_HALF_EXTENT = 0.02;
export const D8_CIRCUMRADIUS = 0.026;

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const INV_SQRT3 = 1 / Math.sqrt(3);

/**
 * Outward face normals in die-local space, indexed by face index (`DieDef.faces[i]` is the value on
 * face `i`). Opposite faces sum to the die's pip total, so d6 face `i` faces away from face `5 - i`
 * (values 1/6, 2/5, 3/4) and d8 face `i` from face `7 - i` (values 1/8 ... 4/5). The P5 dice models
 * must number their faces in this order.
 */
const D6_NORMALS: readonly Vec3[] = [
  { x: 0, y: 1, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: 0, y: 0, z: -1 },
  { x: -1, y: 0, z: 0 },
  { x: 0, y: -1, z: 0 },
];

const D8_NORMALS: readonly Vec3[] = Array.from({ length: 8 }, (_, i) => ({
  x: (i & 4 ? -1 : 1) * INV_SQRT3,
  y: (i & 2 ? -1 : 1) * INV_SQRT3,
  z: (i & 1 ? -1 : 1) * INV_SQRT3,
}));

const D6_VERTICES: readonly Vec3[] = [-1, 1].flatMap((x) =>
  [-1, 1].flatMap((y) =>
    [-1, 1].map((z) => ({ x: x * D6_HALF_EXTENT, y: y * D6_HALF_EXTENT, z: z * D6_HALF_EXTENT })),
  ),
);

const D8_VERTICES: readonly Vec3[] = [
  { x: D8_CIRCUMRADIUS, y: 0, z: 0 },
  { x: -D8_CIRCUMRADIUS, y: 0, z: 0 },
  { x: 0, y: D8_CIRCUMRADIUS, z: 0 },
  { x: 0, y: -D8_CIRCUMRADIUS, z: 0 },
  { x: 0, y: 0, z: D8_CIRCUMRADIUS },
  { x: 0, y: 0, z: -D8_CIRCUMRADIUS },
];

export function faceNormals(kind: DieKind): readonly Vec3[] {
  return kind === 'd6' ? D6_NORMALS : D8_NORMALS;
}

/** Convex hull vertices of the die in local space. */
export function dieVertices(kind: DieKind): readonly Vec3[] {
  return kind === 'd6' ? D6_VERTICES : D8_VERTICES;
}

/** Index of the face whose world-space normal points closest to +Y. */
export function upFace(quaternion: Quat, normals: readonly Vec3[]): number {
  let best = 0;
  let bestY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < normals.length; i++) {
    const y = rotateVec(quaternion, normals[i] as Vec3).y;
    if (y > bestY) {
      bestY = y;
      best = i;
    }
  }
  return best;
}

/**
 * The world-space rotation that carries `targetFace`'s normal onto +Y by the shortest arc. Left-multiply
 * it onto the die's orientation (`quatMul(delta, current)`) to get the corrected orientation. A minimal
 * arc keeps the die's yaw as unchanged as the geometry allows, so the correction reads as a tip-over.
 */
export function correctionRotation(
  currentQuat: Quat,
  normals: readonly Vec3[],
  targetFace: number,
): Quat {
  const normal = normals[targetFace];
  if (normal === undefined)
    throw new RangeError(`No face ${targetFace} on a die of ${normals.length} faces`);
  return quatFromUnitVectors(rotateVec(currentQuat, normal), UP);
}

/** World-space heights and the contact point of the lowest part of the die in `pose`. */
export interface Lowest {
  y: number;
  /** Mean of every vertex within `CONTACT_TOLERANCE` of the lowest one: the resting face or edge. */
  contact: Vec3;
}

export const CONTACT_TOLERANCE = 0.002;

export function lowestPoint(vertices: readonly Vec3[], pose: Pose): Lowest {
  const world = vertices.map((vertex) => {
    const r = rotateVec(pose.quaternion, vertex);
    return { x: r.x + pose.position.x, y: r.y + pose.position.y, z: r.z + pose.position.z };
  });
  const y = Math.min(...world.map((vertex) => vertex.y));
  const touching = world.filter((vertex) => vertex.y - y <= CONTACT_TOLERANCE);
  const contact = { x: 0, y, z: 0 };
  for (const vertex of touching) {
    contact.x += vertex.x / touching.length;
    contact.z += vertex.z / touching.length;
  }
  return { y, contact };
}

export interface CorrectionPlan {
  readonly start: Pose;
  /** Orientation once the target face is up. */
  readonly endQuaternion: Quat;
  /** World-space rotation from `start` to `endQuaternion`. */
  readonly delta: Quat;
  /** Lowest contact point of the die at the moment the correction began. */
  readonly pivot: Vec3;
  readonly vertices: readonly Vec3[];
  /** Height of the surface the die rests on. */
  readonly surfaceY: number;
  /** Horizontal shift applied over the ease so the finished die stays inside the tray. */
  readonly clamp: Vec3;
}

/**
 * Plans the seeded-face correction for a die that has (or is forced to) settle. The die turns about
 * its lowest contact point so it tips over rather than spinning in place, is lifted whenever the
 * rotation would push a corner below `surfaceY`, and finishes resting flat on `surfaceY` with
 * `targetFace` up. `inner` is the tray's half-extent at the die's resting height; the finished pose
 * is nudged inside it.
 */
export function planCorrection(
  start: Pose,
  kind: DieKind,
  targetFace: number,
  surfaceY: number,
  inner: { halfX: number; halfZ: number },
): CorrectionPlan {
  const vertices = dieVertices(kind);
  const delta = correctionRotation(start.quaternion, faceNormals(kind), targetFace);
  const endQuaternion = quatMul(delta, start.quaternion);
  const pivot = lowestPoint(vertices, start).contact;
  const plan: CorrectionPlan = {
    start,
    endQuaternion,
    delta,
    pivot,
    vertices,
    surfaceY,
    clamp: { x: 0, y: 0, z: 0 },
  };
  const end = rawPoseAt(plan, 1);
  let extentX = 0;
  let extentZ = 0;
  for (const vertex of vertices) {
    const r = rotateVec(endQuaternion, vertex);
    extentX = Math.max(extentX, Math.abs(r.x));
    extentZ = Math.max(extentZ, Math.abs(r.z));
  }
  const limitX = Math.max(0, inner.halfX - extentX);
  const limitZ = Math.max(0, inner.halfZ - extentZ);
  return {
    ...plan,
    clamp: {
      x: Math.min(limitX, Math.max(-limitX, end.position.x)) - end.position.x,
      y: 0,
      z: Math.min(limitZ, Math.max(-limitZ, end.position.z)) - end.position.z,
    },
  };
}

/** Smoothstep ease-in-out on [0, 1]. */
export function easeInOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** Rotation about the pivot with the height guard, before the tray clamp. `progress` is already eased. */
function rawPoseAt(plan: CorrectionPlan, progress: number): Pose {
  const quaternion = quatSlerp(plan.start.quaternion, plan.endQuaternion, progress);
  // Relative rotation start -> now, applied about the pivot.
  const step = quatMul(quaternion, quatConjugate(plan.start.quaternion));
  const offset = {
    x: plan.start.position.x - plan.pivot.x,
    y: plan.start.position.y - plan.pivot.y,
    z: plan.start.position.z - plan.pivot.z,
  };
  const turned = rotateVec(step, offset);
  const position: Vec3 = {
    x: plan.pivot.x + turned.x,
    y: plan.pivot.y + turned.y,
    z: plan.pivot.z + turned.z,
  };
  // Never sink below the surface. Descend gradually if the die began above it, landing exactly at 1.
  const need = plan.surfaceY - lowestPoint(plan.vertices, { position, quaternion }).y;
  position.y += need > 0 ? need : need * progress;
  return { position, quaternion };
}

/** Pose of the die `t` of the way (linear, 0 to 1) through the correction; the ease is applied here. */
export function correctionPoseAt(plan: CorrectionPlan, t: number): Pose {
  const progress = easeInOut(t);
  const pose = rawPoseAt(plan, progress);
  return {
    position: {
      x: pose.position.x + plan.clamp.x * progress,
      y: pose.position.y,
      z: pose.position.z + plan.clamp.z * progress,
    },
    quaternion: pose.quaternion,
  };
}
