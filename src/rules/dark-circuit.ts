import { Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { CircuitSocket, DarkCircuitState } from './types.ts';

export type { CircuitSocket, DarkCircuitState } from './types.ts';

export type DarkCircuitOutcome =
  | 'seated'
  | 'primed'
  | 'lifted'
  | 'opened'
  | 'wrong'
  | 'no-bridge'
  | 'ignored';

export const CIRCUIT_SOCKET_MASKS = [1, 2, 4, 3] as const;
export const CIRCUIT_BRIDGES = 2;

export function darkCircuitTarget(seed: string): number {
  return Stream.fromKey(`${seed}:dark-circuit:target`).pick([3, 5, 6]);
}

export function darkCircuitTargets(seed: string): readonly [number, number, number] {
  return Stream.fromKey(`${seed}:dark-circuit:order`).shuffle([3, 5, 6]) as [
    number,
    number,
    number,
  ];
}

export function circuitLampMask(sockets: readonly CircuitSocket[]): number {
  return sockets.reduce<number>((mask, socket) => mask ^ CIRCUIT_SOCKET_MASKS[socket], 0);
}

export function readDarkCircuit(run: Pick<RunState, 'darkCircuit'>): DarkCircuitState {
  const state = run.darkCircuit;
  if (!state || (!state.open && !state.completed && state.sockets.length === CIRCUIT_BRIDGES))
    return { sockets: [], open: false, completed: [] };
  return state;
}

export function toggleCircuitBridge(
  seed: string,
  state: DarkCircuitState,
  socket: CircuitSocket,
): { state: DarkCircuitState; outcome: DarkCircuitOutcome } {
  if (state.open) return { state, outcome: 'ignored' };
  const completed = state.completed ?? [];
  const target = darkCircuitTargets(seed)[completed.length];
  if (state.sockets.includes(socket)) {
    const sockets = state.sockets.filter((installed) => installed !== socket);
    return { state: { sockets, open: false, completed }, outcome: 'lifted' };
  }
  if (state.sockets.length >= CIRCUIT_BRIDGES) return { state, outcome: 'no-bridge' };
  const sockets = [...state.sockets, socket];
  if (sockets.length < CIRCUIT_BRIDGES)
    return { state: { sockets, open: false, completed }, outcome: 'seated' };
  if (circuitLampMask(sockets) !== target)
    return { state: { sockets: [], open: false, completed }, outcome: 'wrong' };
  const nextCompleted = [...completed, target];
  const open = nextCompleted.length === 3;
  return {
    state: { sockets: [], open, completed: nextCompleted },
    outcome: open ? 'opened' : 'primed',
  };
}
