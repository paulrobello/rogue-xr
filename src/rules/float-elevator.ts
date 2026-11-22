import { Stream } from '../core/rng.ts';
import type { FloatElevatorControl, FloatElevatorLevel, FloatElevatorState } from './types.ts';

export type { FloatElevatorControl, FloatElevatorLevel, FloatElevatorState } from './types.ts';

export function floatElevatorTarget(seed: string): 1 | 2 | 3 | 4 {
  return Stream.fromKey(`${seed}:float-elevator-level`).int(1, 4) as 1 | 2 | 3 | 4;
}

export function readFloatElevator(run: {
  readonly floatElevator?: FloatElevatorState;
}): FloatElevatorState {
  return run.floatElevator ?? { level: 0, collected: false };
}

export function operateFloatElevator(
  seed: string,
  state: FloatElevatorState,
  control: FloatElevatorControl,
): FloatElevatorState {
  if (control === 'take') {
    return state.level === floatElevatorTarget(seed) && !state.collected
      ? { ...state, collected: true }
      : state;
  }
  const next = Math.max(
    0,
    Math.min(4, state.level + (control === 'fill' ? 1 : -1)),
  ) as FloatElevatorLevel;
  return next === state.level ? state : { ...state, level: next };
}
