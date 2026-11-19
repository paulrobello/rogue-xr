import type { NormalizedPressureState, PressureState } from '../rules/pressure.ts';

export type PressureAction =
  | { readonly action: 'turn'; readonly valve: 0 | 1 | 2; readonly distance: number }
  | { readonly action: 'prime' | 'open' | 'claim'; readonly distance: number };

/** Save data predates the physical compartment, so its presentation state is optional. */
export function normalizePressureState(
  state: PressureState | NormalizedPressureState,
): NormalizedPressureState {
  return 'notes' in state
    ? { ...state, notes: [...state.notes] }
    : {
        dials: [...state.dials],
        solved: state.solved,
        notes: [],
        drawerOpen: state.solved,
        rewardClaimed: state.solved,
      };
}

export function primeMiss(state: NormalizedPressureState): string {
  if (!(['A', 'B', 'C'] as const).every((id) => state.notes.includes(id)))
    return 'Find all three circuit notes.';
  return 'Check the three readings, then pull the primer.';
}
