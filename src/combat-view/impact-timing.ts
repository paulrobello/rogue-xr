/**
 * Timing of a player attack reaching an enemy (pure, no three.js): the spell bolt's flight from
 * where the spell left (the released card, the sigil plate, the dice tray) to the enemy's hit
 * socket, and the impact burst, light flash and knock-back at contact. The session holds the
 * attack's effects (HP change, hit clip, sounds) until `contactAt`.
 */

/** Bolt travel speed, metres per second. */
export const BOLT_SPEED = 4.5;
/** Flight time bounds, seconds: a point-blank throw still reads, a far one never drags. */
export const FLIGHT_MIN_SECONDS = 0.2;
export const FLIGHT_MAX_SECONDS = 0.45;
/** A flung card's bolt leaves at the card burn's flare peak (`FLARE_PEAK` of `BURN_SECONDS`). */
export const CARD_LAUNCH_DELAY = 0.04;
/** Height of the flight arc at mid-path, as a fraction of the distance. */
export const BOLT_ARC = 0.12;
/** Points in a bolt's comet tail, head included. */
export const BOLT_TAIL_POINTS = 8;
/** Tail span, as path fraction behind the head. */
export const BOLT_TAIL_SPAN = 0.22;

/** The impact burst lasts this long. */
export const IMPACT_SECONDS = 0.5;
/** The flash peaks this long after contact. */
export const FLASH_PEAK_SECONDS = 0.03;
/** Sparks thrown at contact for a cast at power 0 and power 1. */
export const IMPACT_SPARKS_MIN = 10;
export const IMPACT_SPARKS_MAX = 24;

/** The enemy is pushed back this far, metres, and is back home after `KNOCK_SECONDS`. */
export const KNOCK_METRES = 0.045;
export const KNOCK_RISE_SECONDS = 0.05;
export const KNOCK_SECONDS = 0.32;

/** Power of an attack that was not traced (a flung attack card or a dice attack). */
export const CARD_POWER = 0.75;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Flight time over `distance` metres. */
export function flightSeconds(distance: number): number {
  const d = Number.isFinite(distance) ? Math.max(0, distance) : 0;
  return Math.min(FLIGHT_MAX_SECONDS, Math.max(FLIGHT_MIN_SECONDS, d / BOLT_SPEED));
}

/**
 * When the effects land, measured from the moment of the play: the launch delay plus the flight to
 * the farthest target (every target of one play is struck together).
 */
export function contactAt(launchDelay: number, distances: readonly number[]): number {
  let longest = 0;
  for (const d of distances) longest = Math.max(longest, flightSeconds(d));
  return Math.max(0, launchDelay) + (distances.length > 0 ? longest : 0);
}

/** Path fraction covered at flight progress `u`: it accelerates into the target. */
export function boltEase(u: number): number {
  const k = clamp01(u);
  return 0.35 * k + 0.65 * k * k;
}

/**
 * The bolt's position at path fraction `s` (already eased) from `from` to `to`, lifted on a
 * shallow arc so it reads as thrown, written into `out`.
 */
export function boltPoint(from: Point3, to: Point3, s: number, out: Point3): Point3 {
  const k = clamp01(s);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const lift = BOLT_ARC * Math.hypot(dx, dy, dz) * 4 * k * (1 - k);
  out.x = from.x + dx * k;
  out.y = from.y + dy * k + lift;
  out.z = from.z + dz * k;
  return out;
}

/** Path fraction of tail point `i` (0 is the head) when the head is at `s`; clamped at the start. */
export function tailFraction(s: number, i: number): number {
  return Math.max(0, s - (BOLT_TAIL_SPAN * i) / (BOLT_TAIL_POINTS - 1));
}

/** Brightness of tail point `i` (0 is the head, 1). */
export function tailBrightness(i: number): number {
  const k = i / (BOLT_TAIL_POINTS - 1);
  return (1 - k) ** 1.6;
}

/**
 * The impact flash `t` seconds after contact: a sharp rise to the peak and a fast decay, scaled by
 * power. Reduced motion keeps it softer. 0 once the burst is over.
 */
export function impactFlash(t: number, power: number, reducedMotion: boolean): number {
  if (t < 0 || t >= IMPACT_SECONDS) return 0;
  const p = 0.55 + 0.45 * clamp01(power);
  const peak = reducedMotion ? 0.6 : 1;
  if (t < FLASH_PEAK_SECONDS) return peak * p * (t / FLASH_PEAK_SECONDS);
  const k = (t - FLASH_PEAK_SECONDS) / (IMPACT_SECONDS - FLASH_PEAK_SECONDS);
  return peak * p * (1 - k) ** 3;
}

/** Size multiplier of the flash sprite: it blooms out as it fades. */
export function flashSize(t: number): number {
  return 1 + 1.5 * clamp01(t / IMPACT_SECONDS) ** 0.5;
}

/** Sparks thrown at contact for `power` (0..1). */
export function impactSparkCount(power: number): number {
  return Math.round(IMPACT_SPARKS_MIN + (IMPACT_SPARKS_MAX - IMPACT_SPARKS_MIN) * clamp01(power));
}

/**
 * Knock-back distance `t` seconds after contact, metres: a quick shove away from the bolt, then an
 * eased return home. 0 under reduced motion and after `KNOCK_SECONDS`.
 */
export function knockOffset(t: number, power: number, reducedMotion: boolean): number {
  if (reducedMotion || t <= 0 || t >= KNOCK_SECONDS) return 0;
  const reach = KNOCK_METRES * (0.6 + 0.4 * clamp01(power));
  if (t < KNOCK_RISE_SECONDS) {
    const k = t / KNOCK_RISE_SECONDS;
    return reach * (1 - (1 - k) ** 2);
  }
  const k = (t - KNOCK_RISE_SECONDS) / (KNOCK_SECONDS - KNOCK_RISE_SECONDS);
  return reach * (1 - k * k * (3 - 2 * k));
}
