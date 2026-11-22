import { Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { SpringTensionControl, SpringTensionState } from './types.ts';

export type { SpringTensionControl, SpringTensionState } from './types.ts';

export type SpringTensionOutcome = 'wound' | 'partial' | 'slipped' | 'opened' | 'reset' | 'ignored';
export const MAX_SPRING_TENSION = 8;

export function springTensionWindow(seed: string): { min: number; max: number } {
  const min = Stream.fromKey(`${seed}:spring-tension:target`).int(3, 5);
  return { min, max: min + 1 };
}

export function readSpringTension(run: Pick<RunState, 'springTension'>): SpringTensionState {
  return run.springTension ?? { tension: 0, open: false };
}

export function operateSpringTension(
  seed: string,
  state: SpringTensionState,
  action: SpringTensionControl,
): { state: SpringTensionState; outcome: SpringTensionOutcome } {
  if (state.open) return { state, outcome: 'ignored' };
  if (action === 'reset')
    return state.tension === 0
      ? { state, outcome: 'ignored' }
      : { state: { tension: 0, open: false }, outcome: 'reset' };
  if (action === 'wind')
    return state.tension >= MAX_SPRING_TENSION
      ? { state, outcome: 'ignored' }
      : { state: { tension: state.tension + 1, open: false }, outcome: 'wound' };
  const target = springTensionWindow(seed);
  if (state.tension < target.min) return { state, outcome: 'partial' };
  if (state.tension > target.max) return { state: { tension: 0, open: false }, outcome: 'slipped' };
  return { state: { tension: state.tension, open: true }, outcome: 'opened' };
}
