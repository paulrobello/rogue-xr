import { Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { PrismChannel, StoredPrismState } from './types.ts';

export type { PrismChannel, StoredPrismState } from './types.ts';
export type PrismLatchResult = 'matched' | 'mistake' | 'solved';

const CHANNELS = [0, 1, 2] as const;

export function prismOrder(runSeed: string): readonly PrismChannel[] {
  return Stream.fromKey(`${runSeed}:prism-signal`).shuffle(CHANNELS);
}

export function readPrismSignal(run: Pick<RunState, 'prismSignal'>): StoredPrismState {
  return run.prismSignal ?? { orientation: 0, progress: 0 };
}

export function turnPrism(state: StoredPrismState): StoredPrismState {
  if (state.progress === 3) return state;
  return { ...state, orientation: ((state.orientation + 1) % 3) as PrismChannel };
}

export function latchPrismReceiver(
  run: RunState,
  channel: PrismChannel,
): { readonly run: RunState; readonly result: PrismLatchResult } | null {
  const state = readPrismSignal(run);
  if (state.progress === 3) return null;
  if (channel !== state.orientation) return null;
  const order = prismOrder(run.seed);
  const result: PrismLatchResult =
    channel === order[state.progress] ? (state.progress === 2 ? 'solved' : 'matched') : 'mistake';
  const next: StoredPrismState =
    result === 'solved'
      ? { ...state, progress: 3 }
      : result === 'matched'
        ? { ...state, progress: (state.progress + 1) as 1 | 2 }
        : { ...state, progress: 0 };
  return { run: { ...run, prismSignal: next }, result };
}
