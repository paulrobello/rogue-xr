/**
 * Seated locomotion: head-relative smooth move, snap or smooth turn, comfort vignette, teleport
 * with landing validation, wall collision and seated height calibration.
 *
 * Everything that decides anything is a pure, three.js-free function over plain numbers. Headings
 * are degrees, 0 faces north (-Z) and increasing clockwise seen from above, matching `Socket.yaw`
 * in `content/rooms.ts`. Ground positions are `[x, z]`. Colliders and walkable rects are in world
 * space; moving room-local templates into world space is the caller's job. The `Locomotion` class
 * at the bottom is a thin wiring layer onto a rig and head `Object3D`.
 */
import type * as THREE from 'three';
import type { Box, Rect, Vec3 } from '../content/rooms.ts';

export type Vec2 = readonly [number, number];

const DEG = Math.PI / 180;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

function finiteOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

/** Wraps a heading into [0, 360). */
export function normalizeYaw(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped === 0 || wrapped >= 360 ? 0 : wrapped;
}

/** Rounds a heading to the nearest multiple of `step` degrees, wrapped into [0, 360). */
export function quantizeYaw(degrees: number, step: number): number {
  const s = step > 0 ? step : DEFAULT_SNAP_DEGREES;
  return normalizeYaw(Math.round(degrees / s) * s);
}

/** Heading of a world matrix (column-major `elements`) from its right axis, stable under pitch. */
export function yawFromMatrix(elements: ArrayLike<number>): number {
  return normalizeYaw(Math.atan2(elements[2] as number, elements[0] as number) / DEG);
}

/** Rotates `point` clockwise (seen from above) by `degrees` about `pivot`. */
export function rotateAboutPivot(point: Vec2, pivot: Vec2, degrees: number): Vec2 {
  const a = degrees * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const dx = point[0] - pivot[0];
  const dz = point[1] - pivot[1];
  return [pivot[0] + dx * c - dz * s, pivot[1] + dx * s + dz * c];
}

// --- Thumbstick, move and turn -------------------------------------------------------------------

export const DEFAULT_DEADZONE = 0.15;

/**
 * Radial deadzone with rescale: inside the deadzone is zero, the outer edge maps to magnitude 1,
 * so a stick just past the deadzone starts at zero speed instead of jumping.
 */
export function applyDeadzone(x: number, y: number, deadzone = DEFAULT_DEADZONE): Vec2 {
  const m = Math.hypot(x, y);
  if (!(m > deadzone)) return [0, 0];
  const scale = Math.min(1, (m - deadzone) / (1 - deadzone)) / m;
  return [x * scale, y * scale];
}

/**
 * Reads a WebXR gamepad thumbstick as `[x, forward]`. Quest controllers report the stick on axes
 * 2 and 3 with up as negative, so forward is the negated Y. Falls back to axes 0 and 1.
 */
export function readThumbstick(axes: ArrayLike<number>): Vec2 {
  const [x, y] = axes.length >= 4 ? [axes[2], axes[3]] : [axes[0] ?? 0, axes[1] ?? 0];
  return [finiteOr(x as number, 0), -finiteOr(y as number, 0)];
}

/**
 * Head-relative smooth move: stick forward goes where the head faces, stick right goes to the
 * head's right. `forward` and `strafe` are expected after the deadzone and are clamped to a unit
 * circle so diagonals are not faster. Returns the world displacement `[dx, dz]` for this frame.
 */
export function smoothMove(
  headYawDegrees: number,
  forward: number,
  strafe: number,
  speed: number,
  dt: number,
): Vec2 {
  const mag = Math.hypot(forward, strafe);
  if (!(mag > 0)) return [0, 0];
  const k = mag > 1 ? 1 / mag : 1;
  const f = forward * k;
  const s = strafe * k;
  const yaw = headYawDegrees * DEG;
  const dist = speed * dt;
  return [
    (Math.sin(yaw) * f + Math.cos(yaw) * s) * dist,
    (-Math.cos(yaw) * f + Math.sin(yaw) * s) * dist,
  ];
}

export const DEFAULT_SNAP_DEGREES = 30;
export const SNAP_TRIGGER = 0.7;
export const SNAP_REARM = 0.3;

export interface SnapTurnState {
  /** True when the stick has returned toward centre since the last snap and may fire again. */
  armed: boolean;
}

export const SNAP_TURN_INITIAL: SnapTurnState = { armed: true };

/**
 * Snap turn with hysteresis. The stick fires once past `SNAP_TRIGGER` and only fires again after
 * dropping below `SNAP_REARM`, so holding the stick turns exactly one step. Positive `x` is right
 * and turns clockwise. The result is always 0 or plus or minus `stepDegrees`.
 */
export function stepSnapTurn(
  state: SnapTurnState,
  x: number,
  stepDegrees = DEFAULT_SNAP_DEGREES,
): { degrees: number; state: SnapTurnState } {
  const step = stepDegrees > 0 ? stepDegrees : DEFAULT_SNAP_DEGREES;
  const ax = Math.abs(finiteOr(x, 0));
  if (ax < SNAP_REARM) return { degrees: 0, state: state.armed ? state : { armed: true } };
  if (state.armed && ax >= SNAP_TRIGGER) {
    return { degrees: x > 0 ? step : -step, state: { armed: false } };
  }
  return { degrees: 0, state };
}

export const DEFAULT_SMOOTH_TURN_RATE = 90;

/** Smooth turn rate in degrees per second, clockwise positive, after a deadzone rescale. */
export function smoothTurnRate(x: number, maxRate = DEFAULT_SMOOTH_TURN_RATE): number {
  const [scaled] = applyDeadzone(finiteOr(x, 0), 0);
  return scaled * maxRate;
}

export const AIM_ENGAGE = 0.7;
export const AIM_RELEASE = 0.3;

/**
 * Teleport aim hysteresis on the forward stick: aiming starts once the stick passes `AIM_ENGAGE`
 * and holds until it falls below `AIM_RELEASE`, so the release that commits is a deliberate
 * return toward centre, not the stick wobbling around one threshold.
 */
export function stepTeleportAim(aiming: boolean, forward: number): boolean {
  const f = finiteOr(forward, 0);
  return aiming ? f >= AIM_RELEASE : f >= AIM_ENGAGE;
}

// --- Comfort vignette ---------------------------------------------------------------------------

export interface VignetteConfig {
  /** Strongest vignette, 0 to 1. */
  maxStrength: number;
  /** Move speed in m/s that reaches `maxStrength`. */
  speedForMax: number;
  /** Smooth turn rate in degrees per second that reaches `maxStrength`. */
  turnRateForMax: number;
  /** Strength per second while rising. Fast, so the cue is there before the motion registers. */
  attack: number;
  /** Strength per second while falling. Slower, so it does not flicker between stick taps. */
  release: number;
}

export const DEFAULT_VIGNETTE: VignetteConfig = {
  maxStrength: 0.7,
  speedForMax: 2,
  turnRateForMax: DEFAULT_SMOOTH_TURN_RATE,
  attack: 6,
  release: 2.5,
};

/** Target strength for the current motion: the stronger of the move and smooth-turn demands. */
export function vignetteTarget(
  speed: number,
  turnRate: number,
  cfg: VignetteConfig = DEFAULT_VIGNETTE,
): number {
  const move = Math.abs(speed) / cfg.speedForMax;
  const turn = Math.abs(turnRate) / cfg.turnRateForMax;
  return cfg.maxStrength * clamp01(Math.max(move, turn));
}

/** Moves `current` toward `target` by the attack or release rate, never overshooting. */
export function vignetteStep(
  current: number,
  target: number,
  dt: number,
  cfg: VignetteConfig = DEFAULT_VIGNETTE,
): number {
  if (target > current) return Math.min(target, current + cfg.attack * dt);
  return Math.max(target, current - cfg.release * dt);
}

// --- Height calibration -------------------------------------------------------------------------

export const DEFAULT_STANDING_EYE_HEIGHT = 1.6;
const MIN_RIG_OFFSET = -0.3;
const MAX_RIG_OFFSET = 1;

/**
 * Rig height offset that lifts a seated head to a virtual standing eye height. `seatedHeadY` is
 * the head height in tracking space (local-floor) at recenter. A non-finite reading yields 0.
 */
export function calibrateHeight(
  seatedHeadY: number,
  targetEyeHeight = DEFAULT_STANDING_EYE_HEIGHT,
): number {
  if (!Number.isFinite(seatedHeadY) || !Number.isFinite(targetEyeHeight)) return 0;
  return clamp(targetEyeHeight - seatedHeadY, MIN_RIG_OFFSET, MAX_RIG_OFFSET);
}

// --- Collision ----------------------------------------------------------------------------------

export interface CollisionOptions {
  /** Player circle radius in metres. */
  radius?: number;
  /** Floor level the band is measured from. */
  floorY?: number;
  /** Only boxes reaching above `floorY + stepHeight` and below `floorY + bodyHeight` block. */
  stepHeight?: number;
  bodyHeight?: number;
}

export const PLAYER_RADIUS = 0.25;
const STEP_HEIGHT = 0.1;
const BODY_HEIGHT = 1.8;
const MAX_RESOLVE_PASSES = 6;
const SKIN = 1e-6;

function blocking(boxes: readonly Box[], opts: CollisionOptions): Box[] {
  const floor = opts.floorY ?? 0;
  const lo = floor + (opts.stepHeight ?? STEP_HEIGHT);
  const hi = floor + (opts.bodyHeight ?? BODY_HEIGHT);
  return boxes.filter((b) => b.max[1] > lo && b.min[1] < hi);
}

/**
 * Pushes a circle out of every overlapping box on the XZ plane. Because only the penetration is
 * removed, a circle driven into a wall keeps its motion along the wall, which is the slide.
 */
export function resolveCollision(
  pos: Vec2,
  boxes: readonly Box[],
  opts: CollisionOptions = {},
): Vec2 {
  const r = opts.radius ?? PLAYER_RADIUS;
  const solid = blocking(boxes, opts);
  let [x, z] = pos;
  for (let pass = 0; pass < MAX_RESOLVE_PASSES; pass++) {
    let moved = false;
    for (const b of solid) {
      const cx = clamp(x, b.min[0], b.max[0]);
      const cz = clamp(z, b.min[2], b.max[2]);
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-12) {
        const k = (r + SKIN) / Math.sqrt(d2);
        x = cx + dx * k;
        z = cz + dz * k;
      } else {
        const exits: [number, number, number][] = [
          [x - b.min[0], b.min[0] - r - SKIN, z],
          [b.max[0] - x, b.max[0] + r + SKIN, z],
          [z - b.min[2], x, b.min[2] - r - SKIN],
          [b.max[2] - z, x, b.max[2] + r + SKIN],
        ];
        const nearest = exits.reduce((a, c) => (c[0] < a[0] ? c : a));
        [, x, z] = nearest;
      }
      moved = true;
    }
    if (!moved) break;
  }
  return [x, z];
}

/**
 * Moves a circle by `delta` and resolves against `boxes`. The move is cut into steps of at most
 * half a radius so a frame hitch cannot carry the circle through a thin wall.
 */
export function moveWithCollision(
  from: Vec2,
  delta: Vec2,
  boxes: readonly Box[],
  opts: CollisionOptions = {},
): Vec2 {
  const r = opts.radius ?? PLAYER_RADIUS;
  const solid = blocking(boxes, opts);
  const steps = Math.max(1, Math.ceil(Math.hypot(delta[0], delta[1]) / (r * 0.5)));
  let p = from;
  for (let i = 0; i < steps; i++) {
    p = resolveCollision([p[0] + delta[0] / steps, p[1] + delta[1] / steps], solid, {
      ...opts,
      stepHeight: -Infinity,
      bodyHeight: Infinity,
    });
  }
  return p;
}

// --- Teleport -----------------------------------------------------------------------------------

export interface TeleportConfig {
  /** Launch speed of the arc in m/s. */
  speed: number;
  gravity: number;
  /** Sample spacing in seconds. */
  stepSeconds: number;
  maxSeconds: number;
  /** Farthest landing from the arc origin on the ground plane, in metres. */
  maxRange: number;
  radius: number;
}

export const DEFAULT_TELEPORT: TeleportConfig = {
  speed: 7,
  gravity: 9.81,
  stepSeconds: 0.04,
  maxSeconds: 2.5,
  maxRange: 9,
  radius: PLAYER_RADIUS,
};

export interface TeleportEnv {
  /** World-space walkable rects the player may land in. */
  walkable: readonly Rect[];
  colliders: readonly Box[];
  floorY?: number;
}

export type TeleportReason =
  | 'ok'
  | 'no-direction'
  | 'no-landing'
  | 'blocked'
  | 'too-far'
  | 'out-of-bounds'
  | 'obstructed';

export interface TeleportResult {
  valid: boolean;
  reason: TeleportReason;
  /** Arc samples from the origin to where the arc ended (the landing, or the blocking hit). */
  points: Vec3[];
  /** Landing point on the floor, set whenever the arc reached the floor unobstructed. */
  landing: Vec3 | null;
}

/** First hit of the segment `a`-`b` with a box as a fraction in [0, 1], or null (slab test). */
export function segmentBoxHit(a: Vec3, b: Vec3, box: Box): number | null {
  let tMin = 0;
  let tMax = 1;
  for (let axis = 0; axis < 3; axis++) {
    const o = a[axis] as number;
    const d = (b[axis] as number) - o;
    const lo = box.min[axis] as number;
    const hi = box.max[axis] as number;
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const t1 = (lo - o) / d;
    const t2 = (hi - o) / d;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return null;
  }
  return tMin;
}

/** Whether a floor point is inside a walkable rect and clear of colliders by `radius`. */
export function validateLanding(
  xz: Vec2,
  env: TeleportEnv,
  radius = PLAYER_RADIUS,
): 'ok' | 'out-of-bounds' | 'obstructed' {
  const eps = 1e-6;
  const inside = env.walkable.some(
    (w) =>
      xz[0] >= w.min[0] - eps &&
      xz[0] <= w.max[0] + eps &&
      xz[1] >= w.min[1] - eps &&
      xz[1] <= w.max[1] + eps,
  );
  if (!inside) return 'out-of-bounds';
  const pushed = resolveCollision(xz, env.colliders, { radius, floorY: env.floorY });
  return Math.hypot(pushed[0] - xz[0], pushed[1] - xz[1]) > 1e-4 ? 'obstructed' : 'ok';
}

/** Samples a ballistic arc from `origin` along unit-length-normalised `direction`. */
export function sampleTeleportArc(
  origin: Vec3,
  direction: Vec3,
  cfg: TeleportConfig = DEFAULT_TELEPORT,
): Vec3[] {
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 0)) return [origin];
  const v = [
    (direction[0] / len) * cfg.speed,
    (direction[1] / len) * cfg.speed,
    (direction[2] / len) * cfg.speed,
  ];
  const points: Vec3[] = [];
  const n = Math.ceil(cfg.maxSeconds / cfg.stepSeconds);
  for (let i = 0; i <= n; i++) {
    const t = i * cfg.stepSeconds;
    points.push([
      origin[0] + (v[0] as number) * t,
      origin[1] + (v[1] as number) * t - 0.5 * cfg.gravity * t * t,
      origin[2] + (v[2] as number) * t,
    ]);
  }
  return points;
}

/**
 * Casts the teleport arc and validates where it ends. The arc stops at the first collider it
 * crosses (segment test, so thin walls cannot be skipped) or where it first descends to the
 * floor. The landing must be within `maxRange`, inside a walkable rect and clear of colliders.
 * Greybox floors are flat, so `env.floorY` is the single landing height.
 */
export function resolveTeleport(
  origin: Vec3,
  direction: Vec3,
  env: TeleportEnv,
  cfg: TeleportConfig = DEFAULT_TELEPORT,
): TeleportResult {
  const floorY = env.floorY ?? 0;
  const samples = sampleTeleportArc(origin, direction, cfg);
  if (samples.length < 2)
    return { valid: false, reason: 'no-direction', points: samples, landing: null };

  const points: Vec3[] = [samples[0] as Vec3];
  let landing: Vec3 | null = null;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] as Vec3;
    let b = samples[i] as Vec3;
    let reachedFloor = false;
    if (b[1] <= floorY && a[1] > floorY) {
      const f = (a[1] - floorY) / (a[1] - b[1]);
      b = [a[0] + (b[0] - a[0]) * f, floorY, a[2] + (b[2] - a[2]) * f];
      reachedFloor = true;
    }
    let hit: number | null = null;
    for (const box of env.colliders) {
      const t = segmentBoxHit(a, b, box);
      if (t !== null && (hit === null || t < hit)) hit = t;
    }
    if (hit !== null) {
      points.push([
        a[0] + (b[0] - a[0]) * hit,
        a[1] + (b[1] - a[1]) * hit,
        a[2] + (b[2] - a[2]) * hit,
      ]);
      return { valid: false, reason: 'blocked', points, landing: null };
    }
    points.push(b);
    if (reachedFloor) {
      landing = b;
      break;
    }
  }
  if (!landing) return { valid: false, reason: 'no-landing', points, landing: null };
  if (Math.hypot(landing[0] - origin[0], landing[2] - origin[2]) > cfg.maxRange) {
    return { valid: false, reason: 'too-far', points, landing };
  }
  const verdict = validateLanding([landing[0], landing[2]], env, cfg.radius);
  return { valid: verdict === 'ok', reason: verdict, points, landing };
}

// --- Locomotion wiring --------------------------------------------------------------------------

export interface LocomotionSettings {
  turnMode: 'snap' | 'smooth';
  snapDegrees: number;
  /** Smooth turn rate at full stick, degrees per second. */
  smoothTurnRate: number;
  /** Smooth move speed at full stick, m/s. */
  moveSpeed: number;
  /** Right stick forward aims and commits a teleport when true. Smooth move on the left stick stays on. */
  teleport: boolean;
  vignette: boolean;
  standingEyeHeight: number;
}

/** The subset of the persisted profile settings that drive locomotion. */
export interface ComfortProfile {
  turnMode: 'snap' | 'smooth';
  snapDegrees: number;
  vignette: boolean;
  eyeHeight: number;
  teleportEnabled: boolean;
}

/** Maps persisted comfort options onto locomotion settings. */
export function locomotionSettingsFrom(profile: ComfortProfile): Partial<LocomotionSettings> {
  return {
    turnMode: profile.turnMode,
    snapDegrees: profile.snapDegrees,
    vignette: profile.vignette,
    standingEyeHeight: profile.eyeHeight,
    teleport: profile.teleportEnabled,
  };
}

export const DEFAULT_LOCOMOTION_SETTINGS: LocomotionSettings = {
  turnMode: 'snap',
  snapDegrees: DEFAULT_SNAP_DEGREES,
  smoothTurnRate: DEFAULT_SMOOTH_TURN_RATE,
  moveSpeed: 2,
  teleport: true,
  vignette: true,
  standingEyeHeight: DEFAULT_STANDING_EYE_HEIGHT,
};

export interface TeleportAim {
  /** Arc origin (controller position) and aim direction, both in world space. */
  origin: Vec3;
  direction: Vec3;
}

export interface LocomotionInput {
  /** Raw left stick (smooth move): x right, y forward positive (see `readThumbstick`). */
  moveX: number;
  moveY: number;
  /** Raw right stick x (snap or smooth turn), right positive. */
  turnX: number;
  /** Non-null while the player holds the teleport aim. Releasing it commits a valid landing. */
  teleportAim: TeleportAim | null;
}

const MAX_FRAME_SECONDS = 0.1;

/**
 * Drives a rig. `head` must be a descendant of `rig` (the XR camera) and `rig` must have no parent
 * transform. Turning pivots about the head so the player does not swing, and collision tests the
 * head's ground position, with any correction applied to the rig.
 */
export class Locomotion {
  readonly settings: LocomotionSettings;
  private snap: SnapTurnState = SNAP_TURN_INITIAL;
  private strength = 0;
  private preview: TeleportResult | null = null;
  private colliders: readonly Box[] = [];
  private walkable: readonly Rect[] = [];
  private floorY = 0;

  constructor(
    private readonly rig: THREE.Object3D,
    private readonly head: THREE.Object3D,
    settings: Partial<LocomotionSettings> = {},
  ) {
    this.settings = { ...DEFAULT_LOCOMOTION_SETTINGS, ...settings };
  }

  /** World-space colliders and walkable rects of the rooms the player can currently reach. */
  setWorld(colliders: readonly Box[], walkable: readonly Rect[], floorY = 0): void {
    this.colliders = colliders;
    this.walkable = walkable;
    this.floorY = floorY;
  }

  /** Comfort vignette strength 0 to 1 for the renderer to consume. */
  get vignetteStrength(): number {
    return this.settings.vignette ? this.strength : 0;
  }

  /** The current teleport arc, for drawing, or null when not aiming. */
  get teleportPreview(): TeleportResult | null {
    return this.preview;
  }

  /** Drops a held teleport aim without committing it (a board or a fight took the controls). */
  cancelTeleport(): void {
    this.preview = null;
  }

  /** Lifts the rig so the seated head sits at the virtual standing eye height. */
  recenter(): void {
    this.rig.position.y =
      this.floorY + calibrateHeight(this.head.position.y, this.settings.standingEyeHeight);
    this.rig.updateMatrixWorld(true);
  }

  update(dtSeconds: number, input: LocomotionInput): void {
    const dt = Math.min(dtSeconds, MAX_FRAME_SECONDS);
    if (!(dt > 0)) return;
    this.rig.updateMatrixWorld(true);
    const e = this.head.matrixWorld.elements;
    const headXZ: Vec2 = [e[12] as number, e[14] as number];
    let yaw = yawFromMatrix(e);

    let turnDegrees = 0;
    let turnRate = 0;
    if (this.settings.turnMode === 'snap') {
      const r = stepSnapTurn(this.snap, input.turnX, this.settings.snapDegrees);
      this.snap = r.state;
      turnDegrees = r.degrees;
    } else {
      turnRate = smoothTurnRate(input.turnX, this.settings.smoothTurnRate);
      turnDegrees = turnRate * dt;
    }
    if (turnDegrees !== 0) {
      const p = rotateAboutPivot([this.rig.position.x, this.rig.position.z], headXZ, turnDegrees);
      this.rig.position.x = p[0];
      this.rig.position.z = p[1];
      this.rig.rotation.y -= turnDegrees * DEG;
      yaw = normalizeYaw(yaw + turnDegrees);
    }

    let speed = 0;
    // A committed jump replaces this frame's smooth move, which would start from a stale head.
    const jumped = this.settings.teleport && this.updateTeleport(input.teleportAim, headXZ);
    if (!jumped) {
      const [sx, sy] = applyDeadzone(input.moveX, input.moveY);
      const delta = smoothMove(yaw, sy, sx, this.settings.moveSpeed, dt);
      if (delta[0] !== 0 || delta[1] !== 0) {
        const to = moveWithCollision(headXZ, delta, this.colliders, { floorY: this.floorY });
        this.rig.position.x += to[0] - headXZ[0];
        this.rig.position.z += to[1] - headXZ[1];
        speed = Math.hypot(to[0] - headXZ[0], to[1] - headXZ[1]) / dt;
      }
    }

    const cfg = { ...DEFAULT_VIGNETTE, speedForMax: this.settings.moveSpeed };
    this.strength = vignetteStep(this.strength, vignetteTarget(speed, turnRate, cfg), dt, cfg);
    this.rig.updateMatrixWorld(true);
  }

  /** Holds or commits the teleport aim. Returns true on the frame a jump lands. */
  private updateTeleport(aim: TeleportAim | null, headXZ: Vec2): boolean {
    if (aim) {
      this.preview = resolveTeleport(
        aim.origin,
        aim.direction,
        { walkable: this.walkable, colliders: this.colliders, floorY: this.floorY },
        DEFAULT_TELEPORT,
      );
      return false;
    }
    const landing = this.preview?.valid ? this.preview.landing : null;
    this.preview = null;
    if (landing) {
      this.rig.position.x += landing[0] - headXZ[0];
      this.rig.position.z += landing[2] - headXZ[1];
      // The jump shows as a vignette pulse that fades on the normal release ramp.
      this.strength = DEFAULT_VIGNETTE.maxStrength;
      return true;
    }
    return false;
  }
}
