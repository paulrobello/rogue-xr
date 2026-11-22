// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SPRING_TENSION_VERSION } from '../src/combat/encounter-choice.ts';
import { rectsOverlap, worldRooms } from '../src/floor/generate.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import {
  MAX_SPRING_TENSION,
  operateSpringTension,
  readSpringTension,
  springTensionWindow,
} from '../src/rules/spring-tension.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { mountFloorView, playableFloorPlan } from '../src/world/floor-view.ts';
import { SPRING_GATE_SECONDS } from '../src/world/spring-tension.ts';
import { exposedWindowBays } from '../src/world/window-bays.ts';

const SEED = 'SPIRE002';
const UPPER = floorSeedFor(SEED, 2);
const ITERATED = Array.from({ length: 48 }, (_, index) => `TENS${String(index).padStart(4, '0')}`);
const fresh = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: ['cog-toss'] });

describe('Spring Tension', () => {
  it('appends both rooms only if they fit, preserves each prior route, and gates only the new recess', () => {
    let fits = 0;
    for (const seed of [SEED, ...ITERATED]) {
      const upper = floorSeedFor(seed, 2);
      const before = playableFloorPlan(upper, SPRING_TENSION_VERSION - 1, 2);
      const after = playableFloorPlan(upper, SPRING_TENSION_VERSION, 2);
      expect(placeStairEntry(after)).toEqual(placeStairEntry(before));
      expect(exposedWindowBays(after, 2)).toEqual(exposedWindowBays(before, 2));
      if (!after.springTension) {
        expect(after).toEqual(before);
        continue;
      }
      fits++;
      const { workshop, recess, gate } = after.springTension;
      expect(workshop).toBe(before.rooms.length);
      expect(recess).toBe(workshop + 1);
      expect(after.rooms.slice(0, workshop)).toEqual(before.rooms);
      expect(after.connections.slice(0, -2)).toEqual(before.connections);
      expect(after.connections.at(-2)?.puzzleGate).toBeUndefined();
      expect(after.connections.at(-1)).toMatchObject({
        0: gate,
        1: { room: recess },
        puzzleGate: 'spring-tension',
      });
      expect(after.rooms[recess].loot).toEqual([{ socketId: 'desk-drawer', kind: 'card' }]);
      const reachable = new Set([0]);
      for (const room of reachable)
        for (const edge of after.connections) {
          if (edge.puzzleGate) continue;
          if (edge[0].room === room) reachable.add(edge[1].room);
          if (edge[1].room === room) reachable.add(edge[0].room);
        }
      expect(reachable.has(workshop)).toBe(true);
      expect(reachable.has(recess)).toBe(false);
      const rooms = worldRooms(after);
      for (const index of [workshop, recess])
        expect(
          rooms
            .slice(0, index)
            .some(({ footprint }) => rectsOverlap(footprint, rooms[index].footprint)),
        ).toBe(false);
    }
    expect(fits).toBeGreaterThanOrEqual(20);
    expect(playableFloorPlan(UPPER, SPRING_TENSION_VERSION, 2).springTension).toBeDefined();
  });

  it('requires a clutch release inside either marked detent, supports overshoot and a deliberate reset', () => {
    const minima = new Set();
    for (const seed of ITERATED) {
      const target = springTensionWindow(seed);
      minima.add(target.min);
      let state = readSpringTension({});
      for (let marks = 0; marks <= MAX_SPRING_TENSION; marks++) {
        expect(state).toEqual({ tension: marks, open: false });
        const test = operateSpringTension(seed, state, 'release');
        if (marks < target.min) expect(test).toEqual({ state, outcome: 'partial' });
        else if (marks > target.max)
          expect(test).toEqual({ state: { tension: 0, open: false }, outcome: 'slipped' });
        else {
          expect(test).toEqual({ state: { tension: marks, open: true }, outcome: 'opened' });
          expect(operateSpringTension(seed, test.state, 'reset')).toEqual({
            state: test.state,
            outcome: 'ignored',
          });
        }
        const wound = operateSpringTension(seed, state, 'wind');
        expect(wound.outcome).toBe(marks < MAX_SPRING_TENSION ? 'wound' : 'ignored');
        state = wound.state;
      }
      expect(operateSpringTension(seed, state, 'reset')).toEqual({
        state: { tension: 0, open: false },
        outcome: 'reset',
      });
    }
    expect(minima).toEqual(new Set([3, 4, 5]));
  });

  it('persists partial tension and the open gate through import and stair travel', () => {
    const flow = fresh();
    flow.newRun(SEED);
    expect(flow.operateSpringTension('wind')).toBe('ignored');
    expect(flow.travelToFloor(2, 0)).toBe(true);
    expect(flow.operateSpringTension('wind')).toBe('wound');
    const draft = validateSnapshot(flow.snapshot(14));
    expect(draft.run.springTension).toEqual({ tension: 1, open: false });
    const continued = fresh();
    expect(continued.continueRun(draft)).toBe(true);
    expect(continued.operateSpringTension('release')).toBe('partial');
    while (continued.springTension.tension < springTensionWindow(SEED).min)
      expect(continued.operateSpringTension('wind')).toBe('wound');
    expect(continued.operateSpringTension('release')).toBe('opened');
    expect(continued.travelToFloor(1, 0)).toBe(true);
    const restored = fresh();
    expect(restored.continueRun(validateSnapshot(continued.snapshot(22)))).toBe(true);
    expect(restored.travelToFloor(2, 0)).toBe(true);
    expect(restored.springTension).toEqual({ tension: springTensionWindow(SEED).min, open: true });
    expect(restored.operateSpringTension('release')).toBe('ignored');
    const legacy = fresh();
    expect(legacy.continueRun({ ...draft, contentVersion: SPRING_TENSION_VERSION - 1 })).toBe(true);
    expect(legacy.operateSpringTension('wind')).toBe('ignored');
  });

  it('moves the needle, raises the gate partway while retaining collision, and clears both sides at full lift', () => {
    const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), UPPER, { floorNumber: 2 });
    try {
      floor.dressSpringTension(undefined, SEED, false, null);
      const station = floor.springTension;
      if (!station) throw new Error('Missing the test-seed workshop');
      const { workshop, recess } = station.layout;
      floor.world.current = workshop;
      const during = () => [
        floor.world.colliders[workshop].length,
        floor.world.colliders[recess].length,
      ];
      const blocked = during();
      const key = station.object.getObjectByName('spring-tension-wind');
      const needle = station.object.getObjectByName('spring-tension-needle');
      if (!key || !needle) throw new Error('The station needs a physical key and needle');
      const eye = station.object.localToWorld(new THREE.Vector3(0, 1.43, 1.9));
      const keyPoint = key.getWorldPosition(new THREE.Vector3());
      expect(station.pick(eye, keyPoint.clone().sub(eye).normalize())?.action).toBe('wind');
      expect(station.near(keyPoint, 0.24)?.action).toBe('wind');
      const initialAngle = needle.rotation.z;
      station.sync({ tension: 1, open: false });
      expect(station.winding).toBe(true);
      station.update(0.3);
      expect(station.winding).toBe(false);
      expect(needle.rotation.z).toBeLessThan(initialAngle);
      station.testCatch(true);
      station.update(0.25);
      expect(station.leaf.position.y).toBeGreaterThan(0.2);
      expect(during()).toEqual(blocked);
      station.update(0.4);
      expect(station.leaf.position.y).toBeCloseTo(0);
      const solved = { tension: station.range.min, open: true };
      station.sync(solved);
      station.update(SPRING_GATE_SECONDS / 2);
      expect(station.leaf.visible).toBe(true);
      expect(during()).toEqual(blocked);
      station.update(SPRING_GATE_SECONDS / 2);
      expect(station.released).toBe(true);
      expect(station.leaf.visible).toBe(false);
      expect(during()).toEqual(blocked.map((count) => count - 1));
      station.sync(solved, true);
      expect(during()).toEqual(blocked.map((count) => count - 1));
    } finally {
      floor.dispose();
    }
  });
});
