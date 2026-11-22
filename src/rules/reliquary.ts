import { Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';

export type ReliquarySeal = 'hidden' | 'known' | 'open';
const GLYPHS = [
  {
    name: 'keystone',
    points: [
      { x: 0, y: -0.5 },
      { x: -0.38, y: 0.18 },
      { x: 0, y: 0.5 },
      { x: 0.38, y: 0.18 },
    ],
  },
  {
    name: 'chalice',
    points: [
      { x: -0.4, y: 0.4 },
      { x: 0.4, y: 0.4 },
      { x: 0.18, y: -0.12 },
      { x: 0, y: -0.5 },
      { x: -0.18, y: -0.12 },
    ],
  },
  {
    name: 'crown',
    points: [
      { x: -0.45, y: -0.3 },
      { x: -0.28, y: 0.45 },
      { x: 0, y: 0.05 },
      { x: 0.28, y: 0.45 },
      { x: 0.45, y: -0.3 },
    ],
  },
] as const;

export function reliquaryGlyph(runSeed: string): {
  name: string;
  points: readonly { readonly x: number; readonly y: number }[];
} {
  return GLYPHS[Stream.fromKey(`${runSeed}:reliquary-glyph`).int(0, GLYPHS.length - 1)];
}

export function readReliquary(run: Pick<RunState, 'reliquarySeal'>): ReliquarySeal {
  return run.reliquarySeal ?? 'hidden';
}

export function rememberReliquary(run: RunState): RunState | null {
  if (readReliquary(run) !== 'hidden') return null;
  return { ...run, reliquarySeal: 'known' };
}

export function submitReliquaryTrace(
  run: RunState,
  matched: boolean,
): { readonly run: RunState; readonly result: 'wrong' | 'opened' } | null {
  if (readReliquary(run) !== 'known') return null;
  if (!matched) return { run, result: 'wrong' };
  return { run: { ...run, reliquarySeal: 'open' }, result: 'opened' };
}
