// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DARK_CIRCUIT_VERSION } from '../src/combat/encounter-choice.ts';
import { rectsOverlap, worldRooms } from '../src/floor/generate.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { stoneRoomsFor } from '../src/floor/stone-rooms.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import {
  type CircuitSocket,
  circuitLampMask,
  darkCircuitTarget,
  readDarkCircuit,
  toggleCircuitBridge,
} from '../src/rules/dark-circuit.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { DARK_CIRCUIT_GATE_SECONDS } from '../src/world/dark-circuit.ts';
import { mountFloorView, playableFloorPlan } from '../src/world/floor-view.ts';
import { exposedWindowBays } from '../src/world/window-bays.ts';

const SEED = 'C1RC0000';
const UPPER = floorSeedFor(SEED, 2);
const SEEDS = Array.from({ length: 40 }, (_, i) => `C1RC${String(i).padStart(4, '0')}`);
const SOCKETS = [0, 1, 2, 3] as const;
const fresh = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: ['cog-toss'] });
const solution = (seed: string): CircuitSocket[] =>
  SOCKETS.slice(0, 3).filter((_, i) => darkCircuitTarget(seed) & (1 << i));

describe('Dark Circuit', () => {
  it('adds a reachable stone switchboard and one gated coffer without displacing older rooms', () => {
    let appended = 0;
    for (const seed of SEEDS) {
      const upper = floorSeedFor(seed, 2);
      const before = playableFloorPlan(upper, DARK_CIRCUIT_VERSION - 1, 2);
      const after = playableFloorPlan(upper, DARK_CIRCUIT_VERSION, 2);
      expect(before.darkCircuit).toBeUndefined();
      expect(placeStairEntry(after)).toEqual(placeStairEntry(before));
      expect(exposedWindowBays(after, 2)).toEqual(exposedWindowBays(before, 2));
      if (!after.darkCircuit) {
        expect(after).toEqual(before);
        continue;
      }
      appended++;
      const { switchboard, recess, gate } = after.darkCircuit;
      expect(after.rooms.slice(0, switchboard)).toEqual(before.rooms);
      expect(after.connections.slice(0, -2)).toEqual(before.connections);
      expect(after.connections.at(-2)).toMatchObject({ 1: { room: switchboard } });
      expect(after.connections.at(-2)?.puzzleGate).toBeUndefined();
      expect(after.connections.at(-1)).toMatchObject({
        0: gate,
        1: { room: recess },
        puzzleGate: 'dark-circuit',
      });
      expect(after.rooms[recess].loot).toHaveLength(1);
      const style = stoneRoomsFor(after, 2);
      expect(style.get(switchboard)).toBe('circuit');
      expect(style.get(recess)).toBe('dungeon');
      const rooms = worldRooms(after);
      for (const index of [switchboard, recess])
        expect(
          rooms.slice(0, index).some((r) => rectsOverlap(r.footprint, rooms[index].footprint)),
        ).toBe(false);
    }
    expect(appended).toBeGreaterThan(0);
    expect(playableFloorPlan(UPPER, DARK_CIRCUIT_VERSION, 2).darkCircuit).toBeDefined();
  });

  it('requires two seated bridges and exactly the seeded lamp pair while allowing recovery', () => {
    const targets = new Set<number>();
    for (const seed of SEEDS) {
      const target = darkCircuitTarget(seed);
      targets.add(target);
      const empty = readDarkCircuit({});
      for (const first of SOCKETS) {
        const seated = toggleCircuitBridge(seed, empty, first);
        expect(seated).toEqual({ outcome: 'seated', state: { sockets: [first], open: false } });
        expect(toggleCircuitBridge(seed, seated.state, first).state).toEqual(empty);
        for (const second of SOCKETS.filter((socket) => socket !== first)) {
          const next = toggleCircuitBridge(seed, seated.state, second);
          const matching = circuitLampMask([first, second]) === target;
          expect(next.state.open).toBe(matching);
          const spare = SOCKETS.find(
            (socket) => socket !== first && socket !== second,
          ) as CircuitSocket;
          expect(toggleCircuitBridge(seed, next.state, spare).outcome).toBe(
            matching ? 'ignored' : 'no-bridge',
          );
        }
      }
      expect(circuitLampMask(solution(seed))).toBe(target);
    }
    expect(targets).toEqual(new Set([3, 5, 6]));
  });

  it('validates partial and solved saves and restores the floor-local latch and claimed coffer', () => {
    const flow = fresh();
    flow.newRun(SEED);
    const [first, second] = solution(SEED);
    expect(flow.toggleCircuitBridge(first)).toBe('ignored');
    expect(flow.travelToFloor(2, 0)).toBe(true);
    expect(flow.toggleCircuitBridge(first)).toBe('seated');
    const partial = validateSnapshot(flow.snapshot(12));
    expect(partial.run.darkCircuit).toEqual({ sockets: [first], open: false });
    expect(() =>
      validateSnapshot({
        ...partial,
        run: { ...partial.run, darkCircuit: { sockets: [first, first], open: true } },
      }),
    ).toThrow('distinct bridge sockets');
    const continued = fresh();
    expect(continued.continueRun(partial)).toBe(true);
    expect(continued.toggleCircuitBridge(second)).toBe('opened');
    expect(continued.toggleCircuitBridge(first)).toBe('ignored');
    const annex = playableFloorPlan(UPPER, DARK_CIRCUIT_VERSION, 2).darkCircuit;
    if (!annex) throw Error('Fixture seed is missing its circuit');
    const coffer = 'desk-drawer';
    expect(continued.openLoot(annex.recess, coffer, 'card')).toBeDefined();
    expect(continued.claimLoot(annex.recess, coffer)).not.toBeNull();
    expect(continued.travelToFloor(1, 0)).toBe(true);
    const restored = fresh();
    expect(restored.continueRun(validateSnapshot(continued.snapshot(22)))).toBe(true);
    expect(restored.travelToFloor(2, 0)).toBe(true);
    expect(restored.darkCircuit).toEqual({ sockets: [first, second], open: true });
    expect(restored.openLoot(annex.recess, coffer, 'card')).toBeNull();
  });

  it.each([false, true])(
    'keeps the grille blocked until it clears with reduced motion %s',
    (reduced) => {
      const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), UPPER, { floorNumber: 2 });
      try {
        floor.dressDarkCircuit(SEED, reduced, null);
        const station = floor.darkCircuit;
        if (!station) throw Error('Fixture seed is missing its switchboard');
        const { switchboard, recess } = station.layout;
        floor.world.current = switchboard;
        const blocked = () =>
          [switchboard, recess].map((room) => floor.world.colliders[room].length);
        const before = blocked();
        const socket = station.object.getObjectByName('dark-circuit-socket-0');
        if (!socket?.parent) throw Error('Missing bridge socket');
        const target = socket.getWorldPosition(new THREE.Vector3());
        const eye = socket.parent.localToWorld(new THREE.Vector3(socket.position.x, 0.04, 1.6));
        expect(station.pick(eye, target.clone().sub(eye).normalize())?.action).toBe(0);
        expect(station.near(target, 0.12)?.action).toBe(0);
        station.sync({ sockets: solution(SEED), open: true });
        if (!reduced) {
          station.update(DARK_CIRCUIT_GATE_SECONDS / 2);
          expect(station.leaf.position.y).toBeGreaterThan(0);
          expect(station.released).toBe(false);
          expect(blocked()).toEqual(before);
          station.update(DARK_CIRCUIT_GATE_SECONDS / 2);
        }
        expect(station.released).toBe(true);
        expect(station.leaf.visible).toBe(false);
        expect(blocked()).toEqual(before.map((count) => count - 1));
      } finally {
        floor.dispose();
      }
    },
  );
});
