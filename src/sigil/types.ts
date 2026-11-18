/** A point in plate space: +x right, +y up. Units are arbitrary; the recognizer normalizes scale and position. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One continuous pen-down trace. */
export type Stroke = readonly Point[];

/** The sigil ids card content refers to. */
export const SIGIL_IDS = ['gear', 'flame', 'ward', 'bolt', 'spiral', 'anchor'] as const;
export type SigilId = (typeof SIGIL_IDS)[number];

export interface SigilTemplate {
  readonly id: SigilId;
  /** Authored strokes in plate space. Stroke order and direction do not matter to $P. */
  readonly strokes: readonly Stroke[];
}

export interface SigilScore {
  readonly id: SigilId;
  /** Normalized match quality, 0 (no resemblance) to 1 (identical point cloud). */
  readonly score: number;
}

export interface Recognition extends SigilScore {
  /** Every candidate's score, best first. */
  readonly scores: readonly SigilScore[];
}

/**
 * How strictly a trace is judged. Mirrors `Difficulty` in rules/difficulty.ts (src/sigil may not import
 * outside itself; tests/sigil.test.ts keeps the two identical).
 */
export type SigilLevel = 'casual' | 'normal' | 'hard';
