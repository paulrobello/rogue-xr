import { Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { DispatchRoute, StoredDispatchState } from './types.ts';

export type { DispatchRoute, StoredDispatchState } from './types.ts';

export function dispatchDestination(seed: string): DispatchRoute {
  return Stream.fromKey(`${seed}:dispatch-destination`).int(0, 2) as DispatchRoute;
}

export function readDispatch(run: Pick<RunState, 'dispatch'>): StoredDispatchState {
  return run.dispatch ?? { route: 0, sent: false, opened: false };
}

export function turnDispatch(state: StoredDispatchState): StoredDispatchState {
  if (state.sent) return state;
  return { ...state, route: ((state.route + 1) % 3) as DispatchRoute };
}

export function sendDispatch(
  run: RunState,
): { readonly run: RunState; readonly result: 'misrouted' | 'sent' } | null {
  const state = readDispatch(run);
  if (state.sent) return null;
  const correct = state.route === dispatchDestination(run.seed);
  return {
    run: { ...run, dispatch: { ...state, sent: correct } },
    result: correct ? 'sent' : 'misrouted',
  };
}

export function openDispatch(run: RunState): RunState | null {
  const state = readDispatch(run);
  if (!state.sent || state.opened) return null;
  return { ...run, dispatch: { ...state, opened: true } };
}
