import * as THREE from 'three';

const DEG = Math.PI / 180;

/**
 * Limits of the head look-at. Angles are radians in the enemy's body frame (the actor root, which
 * faces -Z); yaw is about body up, pitch about body right, both measured from the head pivot.
 * Entering and leaving the cone use different thresholds so the head never flickers at its edge.
 */
export interface LookLimits {
  /** Yaw inside which a player starts being watched. */
  enterYaw: number;
  /** Yaw beyond which a watched player is let go. */
  exitYaw: number;
  /** Farthest a player starts being watched, in metres. */
  enterRange: number;
  /** Distance beyond which a watched player is let go, in metres. */
  exitRange: number;
  /** Closer than this the angles are unstable, so the look is let go. */
  minRange: number;
  /** Largest yaw the head (with its neck) turns. */
  maxYaw: number;
  /** Largest pitch the head (with its neck) tilts, up or down. */
  maxPitch: number;
  /** Spring rate (1/s) while turning toward or back from a player. */
  omega: number;
  /** Spring rate (1/s) back to the animated pose while dead or frozen. */
  releaseOmega: number;
  /** Share of the turn the neck takes when the head sits on one. */
  neckShare: number;
}

export const LOOK_LIMITS: Readonly<LookLimits> = {
  enterYaw: 75 * DEG,
  exitYaw: 85 * DEG,
  enterRange: 6,
  exitRange: 7,
  minRange: 0.3,
  maxYaw: 60 * DEG,
  maxPitch: 30 * DEG,
  omega: 7,
  releaseOmega: 20,
  neckShare: 0.4,
};

/** The spring state of one look: the applied yaw and pitch, their velocities, and the gate. */
export interface LookState {
  yaw: number;
  pitch: number;
  yawVel: number;
  pitchVel: number;
  tracking: boolean;
}

export function createLookState(): LookState {
  return { yaw: 0, pitch: 0, yawVel: 0, pitchVel: 0, tracking: false };
}

export function resetLook(state: LookState): void {
  state.yaw = 0;
  state.pitch = 0;
  state.yawVel = 0;
  state.pitchVel = 0;
  state.tracking = false;
}

export interface LookAngles {
  yaw: number;
  pitch: number;
  distance: number;
}

/**
 * Yaw and pitch that turn body forward (-Z) toward the offset (x, y, z) from the head pivot, in the
 * body frame. Positive yaw turns toward -X, positive pitch up.
 */
export function lookAngles(x: number, y: number, z: number, out: LookAngles): LookAngles {
  const flat = Math.hypot(x, z);
  out.yaw = flat > 0 ? Math.atan2(-x, -z) : 0;
  out.pitch = Math.atan2(y, flat);
  out.distance = Math.hypot(flat, y);
  return out;
}

/** Whether a player at `yaw` and `distance` is watched, given whether it already was. */
export function inLookCone(
  yaw: number,
  distance: number,
  tracking: boolean,
  limits: Readonly<LookLimits> = LOOK_LIMITS,
): boolean {
  if (!(distance >= limits.minRange)) return false;
  const maxYaw = tracking ? limits.exitYaw : limits.enterYaw;
  const maxRange = tracking ? limits.exitRange : limits.enterRange;
  return Math.abs(yaw) <= maxYaw && distance <= maxRange;
}

export function clampAngle(angle: number, limit: number): number {
  return Math.min(limit, Math.max(-limit, angle));
}

export interface Damped {
  x: number;
  v: number;
}

/**
 * One exact step of a critically damped spring toward a fixed `target`: it eases in from rest,
 * never overshoots from rest, and any split of `dt` into smaller steps lands on the same state.
 */
export function dampCritical(
  x: number,
  v: number,
  target: number,
  omega: number,
  dt: number,
  out: Damped,
): Damped {
  const y = x - target;
  const c = v + omega * y;
  const e = Math.exp(-omega * dt);
  out.x = target + (y + c * dt) * e;
  out.v = (v - omega * c * dt) * e;
  return out;
}

const SETTLED_ANGLE = 1e-4;
const SETTLED_RATE = 1e-3;
const scratchDamped: Damped = { x: 0, v: 0 };
const scratchAngles: LookAngles = { yaw: 0, pitch: 0, distance: 0 };

/**
 * Advances `state` by `dt`. `offset` is the player's head relative to the enemy's head pivot in the
 * body frame, or null for no player. While `enabled` is false (dead, frozen) the look eases back to
 * the animated pose at the release rate. Returns false once the look is fully at rest, when the
 * bones need no touch at all.
 */
export function stepLook(
  state: LookState,
  offset: THREE.Vector3 | null,
  enabled: boolean,
  dt: number,
  limits: Readonly<LookLimits> = LOOK_LIMITS,
): boolean {
  let targetYaw = 0;
  let targetPitch = 0;
  if (enabled && offset) {
    const a = lookAngles(offset.x, offset.y, offset.z, scratchAngles);
    state.tracking = inLookCone(a.yaw, a.distance, state.tracking, limits);
    if (state.tracking) {
      targetYaw = clampAngle(a.yaw, limits.maxYaw);
      targetPitch = clampAngle(a.pitch, limits.maxPitch);
    }
  } else {
    state.tracking = false;
  }
  const omega = enabled ? limits.omega : limits.releaseOmega;
  dampCritical(state.yaw, state.yawVel, targetYaw, omega, dt, scratchDamped);
  state.yaw = scratchDamped.x;
  state.yawVel = scratchDamped.v;
  dampCritical(state.pitch, state.pitchVel, targetPitch, omega, dt, scratchDamped);
  state.pitch = scratchDamped.x;
  state.pitchVel = scratchDamped.v;
  if (
    !state.tracking &&
    Math.abs(state.yaw) < SETTLED_ANGLE &&
    Math.abs(state.pitch) < SETTLED_ANGLE &&
    Math.abs(state.yawVel) < SETTLED_RATE &&
    Math.abs(state.pitchVel) < SETTLED_RATE
  ) {
    resetLook(state);
    return false;
  }
  return true;
}

/** Finds a bone by its authored name or the name GLTFLoader gives it (`neck.2` becomes `neck2`). */
function boneNamed(root: THREE.Object3D, name: string): THREE.Object3D | undefined {
  return (
    root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(name)) ?? root.getObjectByName(name)
  );
}

const _offset = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _frame = new THREE.Quaternion();
const _frameInv = new THREE.Quaternion();
const _delta = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * The head look-at of one actor, layered on its animation: call `update` right after the mixer. The
 * mixer skips a bone whose animated value did not change since its last write (a constant track,
 * a held or clamped clip), which would leave last frame's turn on it, so `update` puts such a bone
 * back on its animated rotation before turning it again and the turn never compounds. The turn is
 * built in the body frame and conjugated into each bone's parent frame, so no bone's local axes
 * matter. A rig without a `head` bone gets no HeadLook (see {@link HeadLook.find}): nothing else
 * ever turns.
 */
export class HeadLook {
  readonly state: LookState = createLookState();
  /** Bones the turn is split over, outermost first, with each one's share of it. */
  readonly bones: readonly { readonly bone: THREE.Object3D; readonly share: number }[];
  /** Per bone: its animated rotation under the last turn, and the rotation that turn left on it. */
  private readonly applied: {
    readonly base: THREE.Quaternion;
    readonly turned: THREE.Quaternion;
  }[];
  private hasApplied = false;

  constructor(
    readonly root: THREE.Object3D,
    readonly head: THREE.Object3D,
    neck: THREE.Object3D | null,
    readonly limits: Readonly<LookLimits> = LOOK_LIMITS,
  ) {
    this.bones = neck
      ? [
          { bone: neck, share: limits.neckShare },
          { bone: head, share: 1 - limits.neckShare },
        ]
      : [{ bone: head, share: 1 }];
    this.applied = this.bones.map(() => ({
      base: new THREE.Quaternion(),
      turned: new THREE.Quaternion(),
    }));
  }

  /** The look for `root`'s `head` bone, split with its parent when that is a neck; null without a head. */
  static find(root: THREE.Object3D, limits: Readonly<LookLimits> = LOOK_LIMITS): HeadLook | null {
    const head = boneNamed(root, 'head');
    if (!head) return null;
    const parent = head.parent;
    const neck = parent && parent !== root && parent.name.startsWith('neck') ? parent : null;
    return new HeadLook(root, head, neck, limits);
  }

  get yaw(): number {
    return this.state.yaw;
  }
  get pitch(): number {
    return this.state.pitch;
  }
  get tracking(): boolean {
    return this.state.tracking;
  }

  /** Steps the look toward `target` (a world point, or null) and turns the bones. */
  update(dt: number, target: THREE.Vector3 | null, enabled: boolean): void {
    this.undoSkipped();
    let offset: THREE.Vector3 | null = null;
    if (enabled && target) {
      offset = this.root.worldToLocal(_offset.copy(target)).sub(this.pivot(_pivot));
    }
    if (!stepLook(this.state, offset, enabled, dt, this.limits)) return;
    this.bones.forEach(({ bone, share }, i) => {
      const applied = this.applied[i];
      applied?.base.copy(bone.quaternion);
      this.parentFrame(bone, _frame);
      _frameInv.copy(_frame).invert();
      _delta.setFromEuler(_euler.set(this.state.pitch * share, this.state.yaw * share, 0, 'YXZ'));
      bone.quaternion.premultiply(_frame).premultiply(_delta).premultiply(_frameInv);
      applied?.turned.copy(bone.quaternion);
    });
    this.hasApplied = true;
  }

  /** Clears the look and takes its turn off any bone the mixer has not rewritten since. */
  reset(): void {
    this.undoSkipped();
    resetLook(this.state);
  }

  /** Puts each bone still holding the last turn (the mixer skipped it) back on its animated rotation. */
  private undoSkipped(): void {
    if (!this.hasApplied) return;
    this.hasApplied = false;
    this.bones.forEach(({ bone }, i) => {
      const applied = this.applied[i];
      if (applied && bone.quaternion.equals(applied.turned)) bone.quaternion.copy(applied.base);
    });
  }

  /** The head pivot in the root's frame, from the bones' current (just animated) local transforms. */
  private pivot(out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.head.position);
    for (let p = this.head.parent; p && p !== this.root; p = p.parent) {
      out.multiply(p.scale).applyQuaternion(p.quaternion).add(p.position);
    }
    return out;
  }

  /** The rotation of `bone`'s parent relative to the root, from current local rotations. */
  private parentFrame(bone: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
    out.identity();
    for (let p = bone.parent; p && p !== this.root; p = p.parent) out.premultiply(p.quaternion);
    return out;
  }
}
