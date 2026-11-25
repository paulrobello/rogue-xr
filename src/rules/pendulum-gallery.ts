import { Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { PendulumDetent, PendulumGalleryState } from './types.ts';

export type { PendulumDetent, PendulumGalleryState } from './types.ts';
export const PENDULUM_PERIODS = [1.1, 1.5, 1.9] as const;

export function pendulumTarget(runSeed: string): PendulumDetent {
  return Stream.fromKey(`${runSeed}:pendulum-gallery`).int(0, 2) as PendulumDetent;
}
export function pendulumWeightTarget(runSeed: string): 0 | 1 | 2 {
  return Stream.fromKey(`${runSeed}:pendulum-gallery:weight`).int(0, 2) as 0 | 1 | 2;
}

export function pendulumTrialSeconds(reference: PendulumDetent, detent: PendulumDetent): number {
  return 1.25 * Math.max(PENDULUM_PERIODS[reference], PENDULUM_PERIODS[detent]);
}

export function pendulumAngle(detent: PendulumDetent, elapsed: number): number {
  const period = PENDULUM_PERIODS[detent];
  return 0.34 * Math.cos((2 * Math.PI * elapsed) / period);
}

export function readPendulumGallery(
  run: Pick<RunState, 'pendulumGallery'> & Partial<Pick<RunState, 'seed'>>,
): PendulumGalleryState {
  if (run.pendulumGallery) return run.pendulumGallery;
  const detent = run.seed ? (((pendulumTarget(run.seed) + 1) % 3) as PendulumDetent) : 0;
  return { detent, open: false, phaseReady: false, phaseSet: false };
}

export function advancePendulumDetent(state: PendulumGalleryState): PendulumGalleryState {
  if (state.open || state.phaseSet) return state;
  if (state.phaseReady) return { ...state, phaseSet: true };
  return { ...state, detent: ((state.detent + 1) % 3) as PendulumDetent };
}

export function completePendulumTrial(run: RunState): {
  readonly run: RunState;
  readonly result: 'ignored' | 'wrong' | 'wrong-weight' | 'matched' | 'opened';
} {
  const state = readPendulumGallery(run);
  if (state.open) return { run, result: 'ignored' };
  if (state.weight !== pendulumWeightTarget(run.seed)) return { run, result: 'wrong-weight' };
  if (state.detent !== pendulumTarget(run.seed)) return { run, result: 'wrong' };
  if (!state.phaseReady) {
    return {
      run: { ...run, pendulumGallery: { ...state, phaseReady: true, phaseSet: false } },
      result: 'matched',
    };
  }
  if (!state.phaseSet) return { run, result: 'wrong' };
  return { run: { ...run, pendulumGallery: { ...state, open: true } }, result: 'opened' };
}
