import { Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { PendulumDetent, PendulumGalleryState } from './types.ts';

export type { PendulumDetent, PendulumGalleryState } from './types.ts';
export const PENDULUM_PERIODS = [1.1, 1.5, 1.9] as const;

export function pendulumTarget(runSeed: string): PendulumDetent {
  return Stream.fromKey(`${runSeed}:pendulum-gallery`).int(0, 2) as PendulumDetent;
}

export function pendulumTrialSeconds(_reference: number, _detent: PendulumDetent): number {
  return 1.25 * Math.max(...PENDULUM_PERIODS);
}

export function pendulumAngle(detent: PendulumDetent, elapsed: number): number {
  const period = PENDULUM_PERIODS[detent];
  return 0.34 * Math.cos((2 * Math.PI * elapsed) / period);
}

export function readPendulumGallery(run: Pick<RunState, 'pendulumGallery'>): PendulumGalleryState {
  return run.pendulumGallery ?? { detent: 0, open: false };
}

export function advancePendulumDetent(state: PendulumGalleryState): PendulumGalleryState {
  if (state.open) return state;
  return { ...state, detent: ((state.detent + 1) % 3) as PendulumDetent };
}

export function completePendulumTrial(run: RunState): {
  readonly run: RunState;
  readonly result: 'ignored' | 'wrong' | 'opened';
} {
  const state = readPendulumGallery(run);
  if (state.open) return { run, result: 'ignored' };
  if (state.detent !== pendulumTarget(run.seed)) return { run, result: 'wrong' };
  return { run: { ...run, pendulumGallery: { ...state, open: true } }, result: 'opened' };
}
