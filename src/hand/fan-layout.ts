/**
 * Pure fan layout for the off-hand card hand. No three.js: positions are metres in grip-local space
 * (x right, y up, +z toward the player's face when the controller points forward), rotations are
 * radians composed as `Ry(yaw) * Rx(pitch) * Rz(roll)` (three.js Euler order 'YXZ').
 */

export type Vec3 = readonly [x: number, y: number, z: number];

export interface FanRotation {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface FanSlot {
  position: Vec3;
  rotation: FanRotation;
  /** Uniform card scale; cards shrink slightly as the hand grows. */
  scale: number;
}

export interface FanOptions {
  /** Unscaled card size in metres. */
  cardWidth: number;
  cardHeight: number;
  /** Fan centre in grip-local space. */
  origin: Vec3;
  /** Radians the fan plane leans so card faces point at the player's eyes. */
  tilt: number;
  /** Card centre spacing as a fraction of scaled card width, at its widest. */
  maxSpacingRatio: number;
  /** Cap on the distance between the first and last card centres. */
  maxSpan: number;
  /** Smallest arc radius, used for small hands. */
  minRadius: number;
  /** Cap on the total angular spread of the arc, radians. */
  maxSpread: number;
  /** Depth step between neighbours so later cards draw over earlier ones. */
  zStep: number;
  /** Card scale at the full hand of `MAX_HAND`. */
  minScale: number;
}

export const MAX_HAND = 10;

/** Holo card width and frame aspect, mirrored from `cards/card-proof.ts` (0.063 m, 1086x716 frame). */
export const HOLO_CARD_WIDTH = 0.063;
export const HOLO_CARD_ASPECT = 1086 / 716;

export const DEFAULT_FAN: FanOptions = {
  cardWidth: HOLO_CARD_WIDTH,
  cardHeight: HOLO_CARD_WIDTH * HOLO_CARD_ASPECT,
  origin: [0, 0.1, 0.04],
  tilt: 0.6,
  maxSpacingRatio: 0.62,
  maxSpan: 0.3,
  minRadius: 0.25,
  maxSpread: 1.25,
  zStep: 0.0015,
  minScale: 0.85,
};

/** Cards beyond this count no longer shrink; below it they keep full size. */
const FULL_SIZE_COUNT = 5;

function checkCount(count: number): void {
  if (!Number.isInteger(count) || count < 0 || count > MAX_HAND) {
    throw new RangeError(`fan count must be an integer in 0..${MAX_HAND}, got ${count}`);
  }
}

/** Uniform card scale for a hand of `count` cards: 1 up to 5 cards, easing to `minScale` at 10. */
export function fanScale(count: number, opts: Partial<FanOptions> = {}): number {
  const { minScale } = { ...DEFAULT_FAN, ...opts };
  const t = Math.max(0, Math.min(1, (count - FULL_SIZE_COUNT) / (MAX_HAND - FULL_SIZE_COUNT)));
  return 1 + (minScale - 1) * t;
}

export interface FanGeometry {
  scale: number;
  /** Distance between neighbouring card centres along the arc. */
  spacing: number;
  radius: number;
  /** Angle between neighbours, radians. */
  step: number;
}

/** Arc parameters for a hand of `count` cards; spacing never grows and radius never shrinks with count. */
export function fanGeometry(count: number, opts: Partial<FanOptions> = {}): FanGeometry {
  checkCount(count);
  const o = { ...DEFAULT_FAN, ...opts };
  const scale = fanScale(count, o);
  if (count <= 1) return { scale, spacing: 0, radius: o.minRadius, step: 0 };
  const spacing = Math.min(o.maxSpacingRatio * o.cardWidth * scale, o.maxSpan / (count - 1));
  const radius = Math.max(o.minRadius, ((count - 1) * spacing) / o.maxSpread);
  return { scale, spacing, radius, step: spacing / radius };
}

/** Slot per card, left to right, centred on `origin`. Deterministic for equal inputs. */
export function fanLayout(count: number, opts: Partial<FanOptions> = {}): FanSlot[] {
  checkCount(count);
  const o = { ...DEFAULT_FAN, ...opts };
  const { scale, radius, step } = fanGeometry(count, o);
  const pitch = -o.tilt;
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const slots: FanSlot[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i - (count - 1) / 2) * step;
    const x = radius * Math.sin(angle);
    const y = radius * Math.cos(angle) - radius;
    const z = (i - (count - 1) / 2) * o.zStep;
    slots.push({
      position: [
        o.origin[0] + x,
        o.origin[1] + y * cosP - z * sinP,
        o.origin[2] + y * sinP + z * cosP,
      ],
      rotation: { yaw: 0, pitch, roll: -angle },
      scale,
    });
  }
  return slots;
}

function rotate(v: Vec3, r: FanRotation): Vec3 {
  const cz = Math.cos(r.roll);
  const sz = Math.sin(r.roll);
  const x1 = v[0] * cz - v[1] * sz;
  const y1 = v[0] * sz + v[1] * cz;
  const cx = Math.cos(r.pitch);
  const sx = Math.sin(r.pitch);
  const y2 = y1 * cx - v[2] * sx;
  const z2 = y1 * sx + v[2] * cx;
  const cy = Math.cos(r.yaw);
  const sy = Math.sin(r.yaw);
  return [x1 * cy + z2 * sy, y2, -x1 * sy + z2 * cy];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface FanHit {
  index: number;
  /** Distance along the (unit) ray direction. */
  distance: number;
}

/**
 * Nearest card a grip-local ray crosses. `direction` must be unit length. A card that is not
 * hittable (grabbed, released) is passed as `null` in `slots` and skipped. `margin` grows each
 * card's rectangle by that many metres on every side.
 */
export function hitTestFan(
  slots: ReadonlyArray<FanSlot | null>,
  cardWidth: number,
  cardHeight: number,
  origin: Vec3,
  direction: Vec3,
  margin = 0,
): FanHit | null {
  let best: FanHit | null = null;
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const normal = rotate([0, 0, 1], slot.rotation);
    const denom = dot(direction, normal);
    if (Math.abs(denom) < 1e-9) continue;
    const toCentre: Vec3 = [
      slot.position[0] - origin[0],
      slot.position[1] - origin[1],
      slot.position[2] - origin[2],
    ];
    const distance = dot(toCentre, normal) / denom;
    if (distance < 0) continue;
    const hit: Vec3 = [
      origin[0] + direction[0] * distance - slot.position[0],
      origin[1] + direction[1] * distance - slot.position[1],
      origin[2] + direction[2] * distance - slot.position[2],
    ];
    const dx = dot(hit, rotate([1, 0, 0], slot.rotation));
    const dy = dot(hit, rotate([0, 1, 0], slot.rotation));
    if (
      Math.abs(dx) <= (cardWidth * slot.scale) / 2 + margin &&
      Math.abs(dy) <= (cardHeight * slot.scale) / 2 + margin &&
      (!best || distance < best.distance)
    ) {
      best = { index: i, distance };
    }
  }
  return best;
}
