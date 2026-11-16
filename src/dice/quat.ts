/** Plain-object vector and quaternion math for the dice module, so nothing here depends on three.js. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Unit quaternion, `w` last (the three.js and Rapier component order). */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Pose {
  position: Vec3;
  quaternion: Quat;
}

export const QUAT_IDENTITY: Readonly<Quat> = { x: 0, y: 0, z: 0, w: 1 };

export function quatNormalize(q: Quat): Quat {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (length === 0) return { ...QUAT_IDENTITY };
  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

/** Hamilton product `a * b`: applies `b` first, then `a`. */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

export function quatConjugate(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Rotates `v` by the unit quaternion `q`. */
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/**
 * Shortest-arc rotation taking unit vector `from` onto unit vector `to`. A half-turn has no unique
 * arc, so it turns about a fixed axis perpendicular to `from`, keeping results reproducible.
 */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const dot = from.x * to.x + from.y * to.y + from.z * to.z;
  if (dot < -0.999999) {
    const axis: Vec3 =
      Math.abs(from.x) < 0.9 ? { x: 0, y: -from.z, z: from.y } : { x: from.z, y: 0, z: -from.x };
    const length = Math.hypot(axis.x, axis.y, axis.z);
    return { x: axis.x / length, y: axis.y / length, z: axis.z / length, w: 0 };
  }
  return quatNormalize({
    x: from.y * to.z - from.z * to.y,
    y: from.z * to.x - from.x * to.z,
    z: from.x * to.y - from.y * to.x,
    w: 1 + dot,
  });
}

/** Spherical interpolation along the shorter arc. */
export function quatSlerp(a: Quat, b: Quat, t: number): Quat {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0 = 1 - t;
  let s1 = t;
  if (cos < 0.9995) {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    s0 = Math.sin((1 - t) * angle) / sin;
    s1 = Math.sin(t * angle) / sin;
  }
  return quatNormalize({
    x: a.x * s0 + bx * s1,
    y: a.y * s0 + by * s1,
    z: a.z * s0 + bz * s1,
    w: a.w * s0 + bw * s1,
  });
}

/** Angle in radians between two orientations, in [0, PI]. */
export function quatAngle(a: Quat, b: Quat): number {
  const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
  return 2 * Math.acos(Math.min(1, dot));
}
