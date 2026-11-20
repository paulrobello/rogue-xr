import { normalizeSeed, Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { CommissionKind, StoredCommissionState } from './types.ts';

export type { CommissionKind, StoredCommissionState } from './types.ts';
export const COMMISSION_PAYOUT: Readonly<Record<CommissionKind, number>> = {
  recovery: 15,
  restoration: 10,
  delve: 18,
};
export const COMMISSION_TITLES: Readonly<Record<CommissionKind, string>> = {
  recovery: 'Missing escapements',
  restoration: 'Cold return line',
  delve: 'The sealed collection',
};
export const COMMISSION_ORDERS: Readonly<Record<CommissionKind, string>> = {
  recovery: 'Recover two tagged springs downstairs and one from the Upper Works.',
  restoration: 'Restore pressure to the service line, then return to the ledger.',
  delve: 'Open the Conservatory archive, then report back to the keeper.',
};
export function commissionPlan(seed: string): CommissionKind {
  return Stream.fromKey(normalizeSeed(seed) + ':commission-v1').pick([
    'recovery',
    'restoration',
    'delve',
  ] as const);
}
export function readCommission(run: Pick<RunState, 'seed' | 'commission'>): StoredCommissionState {
  const kind = commissionPlan(run.seed);
  return (
    run.commission ?? {
      kind,
      accepted: false,
      claimed: false,
      recovered: [],
      payout: COMMISSION_PAYOUT[kind],
    }
  );
}
export function commissionSummary(
  run: Pick<RunState, 'seed' | 'commission' | 'conservatoryFormula'>,
  pressureSolved: boolean,
) {
  const state = readCommission(run);
  const progress =
    state.kind === 'recovery'
      ? state.recovered.length
      : Number(
          state.kind === 'restoration' ? pressureSolved : run.conservatoryFormula?.opened === true,
        );
  return { ...state, progress, total: state.kind === 'recovery' ? 3 : 1 };
}
export function collectSpring(run: RunState, id: 0 | 1 | 2): RunState | null {
  const s = readCommission(run);
  if (![0, 1, 2].includes(id) || s.kind !== 'recovery' || s.recovered.includes(id) || s.claimed)
    return null;
  return { ...run, commission: { ...s, recovered: [...s.recovered, id] } };
}
export function acceptCommission(run: RunState): RunState | null {
  const s = readCommission(run);
  return s.accepted ? null : { ...run, commission: { ...s, accepted: true } };
}
export function claimCommission(run: RunState, pressureSolved: boolean): RunState | null {
  const s = commissionSummary(run, pressureSolved);
  return s.accepted && !s.claimed && s.progress === s.total
    ? { ...run, cogs: run.cogs + s.payout, commission: { ...readCommission(run), claimed: true } }
    : null;
}
