import { normalizeSeed, Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { StoredCounterweightState } from './types.ts';

export type { StoredCounterweightState } from './types.ts';

export interface CounterweightPuzzle {
  readonly left: number;
  readonly right: number;
  readonly correct: 0 | 1;
}

export interface CounterweightResult {
  readonly run: RunState;
  readonly state: StoredCounterweightState;
  readonly solved: boolean;
  readonly correct: boolean;
}

/** Two distinct weights, generated independently from the pressure station stream. */
export function counterweightPuzzle(seed: string): CounterweightPuzzle {
  const stream = Stream.fromKey(`${normalizeSeed(seed)}:counterweight-target-v1`);
  const left = stream.int(1, 9);
  let right = stream.int(1, 9);
  if (right === left) right = right === 9 ? 1 : right + 1;
  return { left, right, correct: left > right ? 0 : 1 };
}

/** Index of the heavier weight, for controller-facing consumers. */
export function counterweightTarget(seed: string): 0 | 1 {
  return counterweightPuzzle(seed).correct;
}

export function readCounterweight(run: Pick<RunState, 'counterweight'>): StoredCounterweightState {
  return run.counterweight ?? { solved: false };
}

/** Hanging the wrong weight is recoverable: it records the attempt but leaves the lock unsolved. */
export function hangCounterweight(run: RunState, side: 0 | 1): CounterweightResult | null {
  const current = readCounterweight(run);
  if (current.solved) return null;
  const solved = counterweightTarget(run.seed) === side;
  const state: StoredCounterweightState = {
    selected: side,
    solved,
  };
  return { run: { ...run, counterweight: state }, state, solved, correct: solved };
}
