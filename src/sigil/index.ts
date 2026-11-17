import { type Cloud, greedyCloudMatch, toCloud } from './pdollar.ts';
import { SIGIL_TEMPLATES } from './templates.ts';
import {
  type Recognition,
  SIGIL_IDS,
  type SigilId,
  type SigilLevel,
  type SigilScore,
  type Stroke,
} from './types.ts';

export { CLOUD_SIZE, greedyCloudMatch, toCloud } from './pdollar.ts';
export { SIGIL_TEMPLATES } from './templates.ts';
export * from './types.ts';

/**
 * Score normalization. $P yields a mean weighted point distance `d` in unit-box units (see
 * `greedyCloudMatch`); score = clamp(1 - d / DISTANCE_AT_ZERO, 0, 1). DISTANCE_AT_ZERO is
 * calibrated on the reference traces in tests/sigil.test.ts (redrawn, rescaled, moved, stretched
 * ±6% and tilted up to 7°): the worst own-sigil match is d ≈ 0.032 (score 0.870, ward) and the
 * closest cross-sigil match is d ≈ 0.083 (score 0.668, a gear trace against bolt), so own traces
 * clear 0.85 while every wrong sigil stays below MIN_SCORE.
 */
export const DISTANCE_AT_ZERO = 0.25;

/** The level a caller that names none is judged at: Casual, the tolerance above. */
export const DEFAULT_SIGIL_LEVEL: SigilLevel = 'casual';

/**
 * `DISTANCE_AT_ZERO` per level. Casual is the calibration above. Each harder level is 20 % tighter, so
 * the same trace scores lower and casts weaker, while MIN_SCORE, PERFECT_SCORE, FLOOR and MAX stay the
 * same on every level (the quality word and the multiplier read one score). On the reference traces in
 * tests/sigil.test.ts (d 0.016 to 0.033) the mean multiplier is 1.14 on Casual, 1.07 on Normal and 0.99
 * on Hard; every own trace still clears MIN_SCORE on Hard (it fizzles above d = 0.048).
 */
export const DISTANCE_AT_ZERO_BY_LEVEL: Readonly<Record<SigilLevel, number>> = {
  casual: DISTANCE_AT_ZERO,
  normal: 0.2,
  hard: 0.16,
};

/** Below this score a trace fizzles to the FLOOR multiplier instead of failing the cast. */
export const MIN_SCORE = 0.7;
/** Scores at or above this count as a near-perfect trace and earn the MAX multiplier. */
export const PERFECT_SCORE = 0.95;
/** Fizzle multiplier: a bad or wrong trace still casts at half power. */
export const FLOOR = 0.5;
/** Multiplier for a near-perfect trace. */
export const MAX = 1.25;

const templateClouds = new Map<SigilId, Cloud>(
  SIGIL_IDS.map((id) => [id, toCloud(SIGIL_TEMPLATES[id].strokes) as Cloud]),
);

/** Map a $P distance to a 0..1 score at `level` (Casual by default). */
export function distanceToScore(distance: number, level: SigilLevel = DEFAULT_SIGIL_LEVEL): number {
  return Math.min(1, Math.max(0, 1 - distance / DISTANCE_AT_ZERO_BY_LEVEL[level]));
}

function scoreCloud(cloud: Cloud | null, id: SigilId, level: SigilLevel): number {
  if (!cloud) return 0;
  return distanceToScore(greedyCloudMatch(cloud, templateClouds.get(id) as Cloud), level);
}

/**
 * Score a trace against one sigil: how well the player drew the card's own sigil, judged at `level`
 * (Casual by default). 0 for an empty trace.
 */
export function scoreAgainst(
  strokes: readonly Stroke[],
  sigilId: SigilId,
  level: SigilLevel = DEFAULT_SIGIL_LEVEL,
): number {
  return scoreCloud(toCloud(strokes), sigilId, level);
}

/**
 * Score a trace against every candidate sigil (all five by default) and name the best match.
 * Ties keep candidate order. An empty or dot-only trace scores 0 everywhere.
 */
export function recognize(
  strokes: readonly Stroke[],
  candidates: readonly SigilId[] = SIGIL_IDS,
): Recognition {
  if (candidates.length === 0) throw new Error('recognize needs at least one candidate sigil');
  const cloud = toCloud(strokes);
  const scores: SigilScore[] = candidates
    .map((id) => ({ id, score: scoreCloud(cloud, id, DEFAULT_SIGIL_LEVEL) }))
    .sort((a, b) => b.score - a.score);
  const best = scores[0] as SigilScore;
  return { id: best.id, score: best.score, scores };
}

/**
 * Power multiplier for a sigil score (PRD D6): below MIN_SCORE the cast fizzles to FLOOR;
 * from MIN_SCORE it rises linearly from FLOOR to MAX at PERFECT_SCORE, and holds MAX above.
 */
export function scoreToMultiplier(score: number): number {
  if (!(score >= MIN_SCORE)) return FLOOR;
  const t = Math.min(1, (score - MIN_SCORE) / (PERFECT_SCORE - MIN_SCORE));
  return FLOOR + t * (MAX - FLOOR);
}
