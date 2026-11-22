import { Stream } from '../core/rng.ts';
import type { FloatElevatorControl, FloatElevatorLevel, FloatElevatorState } from './types.ts';

export type { FloatElevatorControl, FloatElevatorLevel, FloatElevatorState } from './types.ts';

export function floatElevatorTarget(seed: string): 1 | 2 | 3 | 4 {
  return Stream.fromKey(`${seed}:float-elevator-level`).int(1, 4) as 1 | 2 | 3 | 4;
}

export const FLOAT_SERVICE_READY = 3;

export function readFloatElevator(run: {
  readonly floatElevator?: FloatElevatorState;
}): FloatElevatorState {
  return run.floatElevator ?? { level: 0, collected: false, serviceStep: 0 };
}

export function operateFloatElevator(
  seed: string,
  state: FloatElevatorState,
  control: FloatElevatorControl,
): FloatElevatorState {
  const target = floatElevatorTarget(seed);
  const stage = state.serviceStep ?? 0;
  if (state.collected) return state;
  if (control === 'take')
    return state.level === target && stage === FLOAT_SERVICE_READY
      ? { ...state, collected: true }
      : state;
  const level = Math.max(
    0,
    Math.min(4, state.level + (control === 'fill' ? 1 : -1)),
  ) as FloatElevatorLevel;
  if (level === state.level) return state;
  const primed = control === 'fill' && level === target;
  const bled = stage === 1 && state.level === target && level === target - 1;
  const serviceStep = primed ? (stage === 2 ? FLOAT_SERVICE_READY : 1) : bled ? 2 : 0;
  return { level, collected: false, serviceStep };
}
