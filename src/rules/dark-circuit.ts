import { Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { CircuitSocket, DarkCircuitState } from './types.ts';

export type { CircuitSocket, DarkCircuitState } from './types.ts';

export type DarkCircuitOutcome = 'seated' | 'lifted' | 'opened' | 'no-bridge' | 'ignored';

export const CIRCUIT_SOCKET_MASKS = [1, 2, 4, 3] as const;
export const CIRCUIT_BRIDGES = 2;

export function darkCircuitTarget(seed: string): number {
  return Stream.fromKey(`${seed}:dark-circuit:target`).pick([3, 5, 6]);
}

export function circuitLampMask(sockets: readonly CircuitSocket[]): number {
  return sockets.reduce<number>((mask, socket) => mask | CIRCUIT_SOCKET_MASKS[socket], 0);
}

export function readDarkCircuit(run: Pick<RunState, 'darkCircuit'>): DarkCircuitState {
  return run.darkCircuit ?? { sockets: [], open: false };
}

export function toggleCircuitBridge(
  seed: string,
  state: DarkCircuitState,
  socket: CircuitSocket,
): { state: DarkCircuitState; outcome: DarkCircuitOutcome } {
  if (state.open) return { state, outcome: 'ignored' };
  if (state.sockets.includes(socket)) {
    const sockets = state.sockets.filter((installed) => installed !== socket);
    return { state: { sockets, open: false }, outcome: 'lifted' };
  }
  if (state.sockets.length >= CIRCUIT_BRIDGES) return { state, outcome: 'no-bridge' };
  const sockets = [...state.sockets, socket];
  const open =
    sockets.length === CIRCUIT_BRIDGES && circuitLampMask(sockets) === darkCircuitTarget(seed);
  return { state: { sockets, open }, outcome: open ? 'opened' : 'seated' };
}
