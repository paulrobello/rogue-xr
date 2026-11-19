import { normalizeSeed, Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { PressureDial, PressureDials, PressureState } from './types.ts';

export type { PressureDials, PressureState } from './types.ts';

export interface PressureTurnResult {
  readonly run: RunState;
  readonly dials: PressureDials;
  readonly solved: boolean;
  /** 20 only for the turn that solves the regulator. */
  readonly reward: 0 | 20;
}

export const PRESSURE_REWARD = 20;

function defaultDials(): PressureDials {
  return [1, 1, 1];
}

/** The station setting is a seeded permutation, so it is never the untouched default. */
export function pressureTarget(seed: string): PressureDials {
  const stream = Stream.fromKey(`${normalizeSeed(seed)}:pressure-target`);
  const [a, b, c] = stream.shuffle([1, 2, 3] as const);
  return [a, b, c];
}

/** Reads the regulator without exposing mutable state from a run snapshot. */
export function readPressure(run: Pick<RunState, 'pressure'>): PressureState {
  const pressure = run.pressure;
  return {
    dials: pressure ? [...pressure.dials] : defaultDials(),
    solved: pressure?.solved === true,
  };
}

/** Advances one valve, paying the regulator reward once when all dials match its target. */
export function turnPressureValve(run: RunState, valve: 0 | 1 | 2): PressureTurnResult | null {
  const current = readPressure(run);
  if (current.solved) return null;
  const dials: [PressureDial, PressureDial, PressureDial] = [
    current.dials[0],
    current.dials[1],
    current.dials[2],
  ];
  dials[valve] = ((dials[valve] % 3) + 1) as PressureDial;
  const target = pressureTarget(run.seed);
  const solved = dials.every((dial, index) => dial === target[index]);
  const reward: 0 | 20 = solved ? PRESSURE_REWARD : 0;
  return {
    run: { ...run, cogs: run.cogs + reward, pressure: { dials, solved } },
    dials,
    solved,
    reward,
  };
}
