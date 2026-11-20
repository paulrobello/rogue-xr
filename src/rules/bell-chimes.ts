import { normalizeSeed, Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';

import type { BellNote } from './types.ts';

export type { BellNote, StoredBellChimesState } from './types.ts';
export const BELL_CHIME_REWARD = 12;
export const BELL_PHRASE_LENGTH = 4;
export const BELL_CLUE_HINT = 'Find the music box on Floor 1.';

export type BellFeedback = 'clue' | 'hint' | 'correct' | 'mistake' | 'solved' | 'claimed';

export function bellMelody(seed: string): readonly BellNote[] {
  const stream = Stream.fromKey(`bell-chimes:${normalizeSeed(seed)}`);
  return stream.shuffle<BellNote>([0, 1, 2, stream.int(0, 2) as BellNote]);
}

export function listenToChimes(run: RunState): RunState {
  if (run.bellChimes?.clueHeard) return run;
  return {
    ...run,
    bellChimes: { clueHeard: true, progress: [], solved: false, rewardClaimed: false },
  };
}

export function strikeChime(
  run: RunState,
  note: BellNote,
): { run: RunState; feedback: BellFeedback } | null {
  const state = run.bellChimes;
  if (!state?.clueHeard) return { run, feedback: 'hint' };
  if (state.solved) return null;
  const melody = bellMelody(run.seed);
  const correct = melody[state.progress.length] === note;
  const progress = correct ? [...state.progress, note] : [];
  const solved = progress.length === melody.length;
  return {
    run: { ...run, bellChimes: { ...state, progress, solved } },
    feedback: solved ? 'solved' : correct ? 'correct' : 'mistake',
  };
}

export function claimChimeReward(run: RunState): RunState | null {
  const state = run.bellChimes;
  if (!state?.solved || state.rewardClaimed) return null;
  return {
    ...run,
    cogs: run.cogs + BELL_CHIME_REWARD,
    bellChimes: { ...state, rewardClaimed: true },
  };
}
