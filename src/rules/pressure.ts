import { normalizeSeed, Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type {
  NormalizedPressureState,
  PressureDial,
  PressureDials,
  PressureNoteId,
} from './types.ts';

export type {
  NormalizedPressureState,
  PressureDials,
  PressureNoteId,
  PressureState,
  StoredPressureState,
} from './types.ts';

export const PRESSURE_REWARD = 20;
const NOTE_IDS = ['dispatch', 'A', 'B', 'C'] as const satisfies readonly PressureNoteId[];

export interface PressureActionResult {
  readonly run: RunState;
  readonly dials: PressureDials;
  readonly solved: boolean;
  readonly notes: readonly PressureNoteId[];
  readonly drawerOpen: boolean;
  readonly rewardClaimed: boolean;
  readonly reward: 0 | 20;
  readonly note?: PressureNoteId;
}

/** Legacy result export retained for rules consumers. */
export interface PressureTurnResult {
  readonly run: RunState;
  readonly dials: PressureDials;
  readonly solved: boolean;
  readonly reward: 0 | 20;
}

function defaultDials(): PressureDials {
  return [1, 1, 1];
}

export function isPressureNoteId(value: unknown): value is PressureNoteId {
  return typeof value === 'string' && (NOTE_IDS as readonly string[]).includes(value);
}

/** The untouched 111 is excluded from the 27 three-valve combinations. */
export function pressureTarget(seed: string, contentVersion?: number): PressureDials {
  if (contentVersion !== undefined && contentVersion < 5) return legacyPressureTarget(seed);
  const stream = Stream.fromKey(`${normalizeSeed(seed)}:pressure-target-v2`);
  const value = stream.int(1, 26);
  return [
    Math.floor(value / 9) + 1,
    (Math.floor(value / 3) % 3) + 1,
    (value % 3) + 1,
  ] as PressureDials;
}

/** Target used by pre-v2 pressure saves. Exported for strict save compatibility checks. */
export function legacyPressureTarget(seed: string): PressureDials {
  const stream = Stream.fromKey(`${normalizeSeed(seed)}:pressure-target`);
  const [a, b, c] = stream.shuffle([1, 2, 3] as const);
  return [a, b, c];
}

/** Returns the normalized pressure view. A v3 solved save is already paid. */
export function readPressure(run: Pick<RunState, 'pressure'>): NormalizedPressureState {
  const pressure = run.pressure;
  return {
    dials: pressure ? [...pressure.dials] : defaultDials(),
    solved: pressure?.solved === true,
    notes: pressure?.notes ? [...pressure.notes] : [],
    drawerOpen: pressure?.drawerOpen ?? pressure?.solved === true,
    rewardClaimed: pressure?.rewardClaimed ?? pressure?.solved === true,
  };
}

function result(
  run: RunState,
  state: NormalizedPressureState,
  reward: 0 | 20,
  note?: PressureNoteId,
): PressureActionResult {
  return {
    run,
    dials: state.dials,
    solved: state.solved,
    notes: state.notes,
    drawerOpen: state.drawerOpen,
    rewardClaimed: state.rewardClaimed,
    reward,
    ...(note === undefined ? {} : { note }),
  };
}

export function collectPressureNote(
  run: RunState,
  note: PressureNoteId,
): PressureActionResult | null {
  const current = readPressure(run);
  if (current.notes.includes(note)) return null;
  const state: NormalizedPressureState = { ...current, notes: [...current.notes, note] };
  return result({ ...run, pressure: state }, state, 0, note);
}

/** Turns one valve without solving or paying. Priming and claiming are explicit actions. */
export function turnPressureValve(run: RunState, valve: 0 | 1 | 2): PressureActionResult | null {
  const current = readPressure(run);
  if (current.solved) return null;
  const dials: [PressureDial, PressureDial, PressureDial] = [...current.dials];
  dials[valve] = ((dials[valve] % 3) + 1) as PressureDial;
  const state: NormalizedPressureState = { ...current, dials };
  return result({ ...run, pressure: state }, state, 0);
}

export function primePressure(run: RunState, contentVersion?: number): PressureActionResult | null {
  const current = readPressure(run);
  if (current.solved || !(['A', 'B', 'C'] as const).every((id) => current.notes.includes(id)))
    return null;
  const target = pressureTarget(run.floorSeed ?? run.seed, contentVersion);
  if (!current.dials.every((dial, index) => dial === target[index])) return null;
  const state: NormalizedPressureState = { ...current, solved: true };
  return result({ ...run, pressure: state }, state, 0);
}

export function openPressureDrawer(run: RunState): PressureActionResult | null {
  const current = readPressure(run);
  if (!current.solved || current.drawerOpen) return null;
  const state: NormalizedPressureState = { ...current, drawerOpen: true };
  return result({ ...run, pressure: state }, state, 0);
}

export function claimPressureReward(run: RunState): PressureActionResult | null {
  const current = readPressure(run);
  if (!current.drawerOpen || current.rewardClaimed) return null;
  const state: NormalizedPressureState = { ...current, rewardClaimed: true };
  return result(
    { ...run, cogs: run.cogs + PRESSURE_REWARD, pressure: state },
    state,
    PRESSURE_REWARD,
  );
}
