import { Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { PipeChannel, SpeakingPipesState, StoredSpeakingPipesState } from './types.ts';

export type { PipeChannel, SpeakingPipesState, StoredSpeakingPipesState } from './types.ts';

export function pipeTarget(seed: string): PipeChannel {
  return Stream.fromKey(`${seed}:speaking-pipes-target`).int(0, 2) as PipeChannel;
}

export function readSpeakingPipes(run: Pick<RunState, 'speakingPipes'>): StoredSpeakingPipesState {
  return run.speakingPipes ?? 'idle';
}

export function primeSpeakingPipes(run: RunState): RunState | null {
  const state = readSpeakingPipes(run);
  if (state !== 'idle') return state === 'primed' ? run : null;
  return { ...run, speakingPipes: 'primed' };
}

export function selectSpeakingPipe(
  run: RunState,
  channel: PipeChannel,
): { readonly run: RunState; readonly result: 'wrong' | 'opened' } | null {
  const state = readSpeakingPipes(run);
  if (state !== 'primed') return null;
  if (channel !== pipeTarget(run.seed)) return { run, result: 'wrong' };
  return { run: { ...run, speakingPipes: 'open' }, result: 'opened' };
}
