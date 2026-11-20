import { normalizeSeed, Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { GearId, StoredCalibrationState } from './types.ts';

export type { CalibrationKind, GearId, StoredCalibrationState } from './types.ts';
export const GEAR_TEETH = [12, 18, 24] as const;
export const BEARINGS = ['North', 'East', 'South', 'West'] as const;
export const PLANET_NAMES = ['Moon', 'Sun', 'Ringed planet'] as const;
export function calibrationPlan(seed: string) {
  const stream = Stream.fromKey(normalizeSeed(seed) + ':calibration-v1');
  const kind = stream.pick(['gears', 'orrery'] as const);
  const gearOrder = stream.shuffle<GearId>([0, 1, 2]);
  const phase = stream.int(1, 63); // exclude the unadjusted orrery
  const detents = [Math.floor(phase / 16), Math.floor(phase / 4) % 4, phase % 4];
  return {
    kind,
    gearOrder,
    detents,
    rewardCard: stream.pick(
      kind === 'gears'
        ? ['ratchet-flurry', 'rivet-volley', 'escapement-hammer']
        : ['arc-bolt', 'time-spiral', 'warding-glyph'],
    ),
  };
}
export function readCalibration(
  run: Pick<RunState, 'seed' | 'calibration'>,
): StoredCalibrationState {
  return (
    run.calibration ?? {
      kind: calibrationPlan(run.seed).kind,
      chart: false,
      selected: null,
      slots: [null, null, null],
      detents: [0, 0, 0],
      solved: false,
      claimed: false,
    }
  );
}
/** From a driver of known pitch radius each engaged spindle fixes the radius of its neighbor. */
export function meshedSpindles(
  slots: readonly (GearId | null)[],
  order: readonly GearId[],
): number {
  const gap = order.findIndex((id, i) => slots[i] !== id);
  return gap < 0 ? order.length : gap;
}
export function calibrated(
  state: StoredCalibrationState,
  plan: ReturnType<typeof calibrationPlan>,
): boolean {
  return state.kind === 'gears'
    ? meshedSpindles(state.slots, plan.gearOrder) === 3
    : plan.detents.every((d, i) => state.detents[i] === d);
}
export function takeCalibrationChart(run: RunState): RunState | null {
  const s = readCalibration(run);
  return s.chart ? null : { ...run, calibration: { ...s, chart: true } };
}
export function selectCalibrationGear(run: RunState, id: GearId): RunState | null {
  const s = readCalibration(run);
  return s.kind !== 'gears' || s.solved || ![0, 1, 2].includes(id)
    ? null
    : { ...run, calibration: { ...s, selected: s.selected === id ? null : id } };
}
export function seatCalibrationGear(run: RunState, slot: GearId): RunState | null {
  const s = readCalibration(run);
  if (s.kind !== 'gears' || s.solved || s.selected === null || ![0, 1, 2].includes(slot))
    return null;
  const slots = [...s.slots],
    previous = slots.indexOf(s.selected);
  if (previous >= 0) slots[previous] = slots[slot];
  slots[slot] = s.selected;
  return { ...run, calibration: { ...s, selected: null, slots } };
}
export function turnCalibrationRing(run: RunState, id: GearId): RunState | null {
  const s = readCalibration(run);
  if (s.kind !== 'orrery' || s.solved || ![0, 1, 2].includes(id)) return null;
  const detents = [...s.detents];
  detents[id] = (detents[id] + 1) % 4;
  return { ...run, calibration: { ...s, detents } };
}
export function windCalibration(run: RunState): RunState | null {
  const s = readCalibration(run);
  if (!s.chart || s.solved) return null;
  return calibrated(s, calibrationPlan(run.seed))
    ? { ...run, calibration: { ...s, selected: null, solved: true } }
    : run;
}
export function claimCalibrationCard(run: RunState): { run: RunState; card: string } | null {
  const s = readCalibration(run);
  if (!s.solved || s.claimed) return null;
  const card = calibrationPlan(run.seed).rewardCard;
  return { card, run: { ...run, deck: [...run.deck, card], calibration: { ...s, claimed: true } } };
}
