import { Stream } from '../core/rng.ts';

import type { ValvehouseState } from './types.ts';

export type { ValvehouseState } from './types.ts';
export type ValvehouseGasket = 'round' | 'triangular' | 'square';

export function gasketFor(runSeed: string): ValvehouseGasket {
  return Stream.fromKey(`${runSeed}:valvehouse-gasket`).pick([
    'round',
    'triangular',
    'square',
  ] as const);
}

export function readValvehouse(run: { readonly valvehouse?: ValvehouseState }): ValvehouseState {
  return run.valvehouse ?? 'missing';
}

export function collectValvehouse(run: {
  readonly valvehouse?: ValvehouseState;
}): ValvehouseState | null {
  return readValvehouse(run) === 'missing' ? 'held' : null;
}

export function seatValvehouse(run: {
  readonly valvehouse?: ValvehouseState;
}): ValvehouseState | null {
  return readValvehouse(run) === 'held' ? 'seated' : null;
}

export function testValvehouse(run: {
  readonly valvehouse?: ValvehouseState;
}): ValvehouseState | null {
  return readValvehouse(run) === 'seated' ? 'open' : null;
}
