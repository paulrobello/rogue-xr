import type * as THREE from 'three';

/** A claimed card flies to its claimer in this many seconds, shrinking to `CARD_FLIGHT_END_SCALE`. */
export const CARD_FLIGHT_SECONDS = 0.4;
export const CARD_FLIGHT_END_SCALE = 0.06;
/** A card that stops short of its claimer (in front of the head) ends this far below the line. */
const STANDOFF_DROP = 0.1;

export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/**
 * Where a card flying from `from` to `to` ends, written to `out`: `standoff` metres short of `to`
 * along the line (0 lands on it, a hand), and a little lower when it stops short (a head), so the
 * card shrinks away under the eyes instead of into them. All three share one space.
 */
export function flightGoal(
  from: THREE.Vector3,
  to: THREE.Vector3,
  standoff: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  out.copy(to).sub(from);
  const length = out.length();
  out.multiplyScalar(length > standoff ? (length - standoff) / length : 0).add(from);
  if (standoff > 0) out.y -= STANDOFF_DROP;
  return out;
}

/**
 * The flying card's position at progress `t` (0..1) between `from` and `goal`, written to `out`.
 * Returns the eased progress, for `flightScale` and any fade.
 */
export function flightPose(
  from: THREE.Vector3,
  goal: THREE.Vector3,
  t: number,
  out: THREE.Vector3,
): number {
  const k = easeInOut(Math.max(0, Math.min(1, t)));
  out.lerpVectors(from, goal, k);
  return k;
}

/** The flying card's scale at eased progress `k`: full size shrinking to `CARD_FLIGHT_END_SCALE`. */
export const flightScale = (k: number): number => 1 + (CARD_FLIGHT_END_SCALE - 1) * k;
