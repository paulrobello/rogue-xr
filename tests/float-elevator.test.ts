// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FLOAT_ELEVATOR_VERSION } from '../src/combat/encounter-choice.ts';
import { rectsOverlap, worldRooms } from '../src/floor/generate.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import {
  FLOAT_SERVICE_READY,
  floatElevatorTarget,
  operateFloatElevator,
  readFloatElevator,
} from '../src/rules/float-elevator.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { FLOAT_RELEASE_SECONDS, FLOAT_TRAVEL_SECONDS } from '../src/world/float-elevator.ts';
import { mountFloorView, playableFloorPlan } from '../src/world/floor-view.ts';
import { exposedWindowBays } from '../src/world/window-bays.ts';

const SEED = 'MAPTEST2';
const fresh = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: ['cog-toss'] });

describe('Float Elevator', () => {
  it('appends a room and preserves the previous floor plan, connections and stair', () => {
    let count = 0;
    for (const seed of [
      SEED,
      ...Array.from({ length: 48 }, (_, i) => `FL0AT${String(i).padStart(3, '0')}`),
    ]) {
      const base = playableFloorPlan(seed, FLOAT_ELEVATOR_VERSION - 1, 1);
      const latest = playableFloorPlan(seed, FLOAT_ELEVATOR_VERSION, 1);
      if (!latest.floatElevator) {
        expect(latest).toEqual(base);
        continue;
      }
      count++;
      const { room } = latest.floatElevator;
      expect(room).toBe(base.rooms.length);
      expect(latest.rooms.slice(0, room)).toEqual(base.rooms);
      expect(latest.rooms[room].loot).toContainEqual({ socketId: 'chest', kind: 'card' });
      expect(latest.connections.slice(0, -1)).toEqual(base.connections);
      expect(latest.connections.at(-1)?.[1].room).toBe(room);
      expect(latest.connections.at(-1)?.puzzleGate).toBeUndefined();
      expect(placeStairEntry(latest)).toEqual(placeStairEntry(base));
      expect(exposedWindowBays(latest, 1)).toEqual(exposedWindowBays(base, 1));
      const bounds = worldRooms(latest);
      expect(
        bounds
          .slice(0, room)
          .some((other) => rectsOverlap(other.footprint, bounds[room].footprint)),
      ).toBe(false);
    }
    expect(count).toBeGreaterThan(35);
  });

  it('bounds the water, releases only at the current seed’s hatch and retains a single claim', () => {
    const found = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const seed = `FL0AT${String(i).padStart(3, '0')}`;
      const target = floatElevatorTarget(seed);
      found.add(target);
      let state = readFloatElevator({});
      expect(operateFloatElevator(seed, state, 'drain')).toBe(state);
      for (const control of [
        ...Array.from({ length: target }, () => 'fill' as const),
        'drain',
        'fill',
      ] as const) {
        const next = operateFloatElevator(seed, state, control);
        expect(next).not.toBe(state);
        state = next;
      }
      expect(state.level).toBe(target);
      const take = operateFloatElevator(seed, state, 'take');
      expect(take.collected).toBe(true);
      expect(operateFloatElevator(seed, take, 'take')).toBe(take);
      expect(operateFloatElevator(seed, take, 'drain').collected).toBe(true);
      if (target < 4) expect(operateFloatElevator(seed, state, 'fill').serviceStep).toBe(0);
    }
    expect(found).toEqual(new Set([1, 2, 3, 4]));
  });

  it('can recover a legacy save at the old target hatch', () => {
    const level = floatElevatorTarget(SEED);
    let state = { level, collected: false } as ReturnType<typeof readFloatElevator>;
    expect(operateFloatElevator(SEED, state, 'take')).toBe(state);
    for (const control of ['drain', 'fill', 'drain', 'fill', 'take'] as const)
      state = operateFloatElevator(SEED, state, control);
    expect(state).toEqual({ level, collected: true, serviceStep: FLOAT_SERVICE_READY });
  });

  it('restores the unfinished water level and the released coffer across floor travel', () => {
    const flow = fresh();
    flow.newRun(SEED);
    expect(flow.operateFloatElevator('fill')).toBe('adjusted');
    const draft = validateSnapshot(flow.snapshot(11));
    expect(draft.run.floatElevator).toMatchObject({ level: 1, collected: false, serviceStep: 0 });
    const continued = fresh();
    expect(continued.continueRun(draft)).toBe(true);
    while (continued.floatElevator.level < floatElevatorTarget(SEED))
      expect(continued.operateFloatElevator('fill')).toBe('adjusted');
    expect(continued.operateFloatElevator('take')).toBe('ignored');
    expect(continued.operateFloatElevator('drain')).toBe('adjusted');
    expect(continued.operateFloatElevator('fill')).toBe('adjusted');
    expect(continued.operateFloatElevator('take')).toBe('released');
    expect(continued.operateFloatElevator('take')).toBe('ignored');
    const solved = continued.floatElevator;
    expect(continued.travelToFloor(2, 0)).toBe(true);
    expect(continued.operateFloatElevator('drain')).toBe('ignored');
    const continuedUpstairs = validateSnapshot(continued.snapshot(23));
    const restored = fresh();
    expect(restored.continueRun(continuedUpstairs)).toBe(true);
    expect(restored.travelToFloor(1, 0)).toBe(true);
    expect(restored.floatElevator).toEqual(solved);
    expect(restored.operateFloatElevator('take')).toBe('ignored');
  });

  it('moves water and float together, and holds the pickup and shutter until their animations settle', () => {
    const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED, {
      floorNumber: 1,
      contentVersion: FLOAT_ELEVATOR_VERSION,
    });
    try {
      floor.dressFloatElevator(undefined, SEED, false, null);
      const apparatus = floor.floatElevator;
      if (!apparatus) throw Error('The fixture needs a reservoir');
      floor.world.current = apparatus.room;
      const water = apparatus.object.getObjectByName('reservoir-water');
      const basket = apparatus.object.getObjectByName('reservoir-float');
      const pick = apparatus.object.getObjectByName('reservoir-take-fitting');
      if (!water || !basket || !pick) throw Error('Missing station parts');
      const coffer = floor.world.coffers.find(({ room }) => room === apparatus.room);
      const lid = coffer?.object.getObjectByName('coffer-lid');
      const lock = coffer?.object.getObjectByName('coffer-padlock');
      if (!coffer || !lid || !lock) throw Error('Missing coffer lid or lock');
      expect(floor.world.group.getObjectByName('reservoir-coffer-recess')).toBeUndefined();
      coffer.open(false);
      expect(coffer.opened).toBe(false);
      expect(lock.visible).toBe(true);
      const wheel = apparatus.object.getObjectByName('reservoir-fill-wheel-hit');
      if (!wheel) throw Error('Missing valve wheel target');
      const wheelPoint = wheel.getWorldPosition(new THREE.Vector3());
      const valveEye = apparatus.object.localToWorld(new THREE.Vector3(-0.7, 1.076, 1.9));
      expect(apparatus.pick(valveEye, wheelPoint.clone().sub(valveEye).normalize())?.action).toBe(
        'fill',
      );
      expect(apparatus.near(wheelPoint, 0.25)?.action).toBe('fill');
      const barriers = floor.world.colliders[apparatus.room].length;
      const eye = apparatus.object.localToWorld(new THREE.Vector3(0, pick.position.y, 1.63));
      const aim = pick.getWorldPosition(new THREE.Vector3()).sub(eye).normalize();
      expect(apparatus.pick(eye, aim)).toBeNull();
      const closed = {
        level: apparatus.target,
        collected: false,
        serviceStep: FLOAT_SERVICE_READY,
      } as const;
      apparatus.sync(closed);
      const start = basket.position.y;
      apparatus.update(FLOAT_TRAVEL_SECONDS / 2);
      expect(basket.position.y).toBeGreaterThan(start);
      expect(basket.position.y).toBeCloseTo(water.position.y + water.scale.y);
      expect(apparatus.pick(eye, aim)).toBeNull();
      apparatus.update(FLOAT_TRAVEL_SECONDS / 2);
      expect(apparatus.pick(eye, aim)?.action).toBe('take');
      const farSide = apparatus.object.localToWorld(new THREE.Vector3(0, pick.position.y, -0.7));
      expect(apparatus.near(farSide, 1.4)).toBeNull();
      apparatus.sync({ ...closed, collected: true });
      apparatus.update(FLOAT_RELEASE_SECONDS / 2);
      expect(apparatus.opening).toBe(true);
      expect(floor.world.colliders[apparatus.room]).toHaveLength(barriers);
      apparatus.update(FLOAT_RELEASE_SECONDS / 2);
      expect(apparatus.released).toBe(true);
      coffer.update(FLOAT_RELEASE_SECONDS);
      expect(lock.visible).toBe(false);
      expect(lid.rotation.x).toBe(0);
      coffer.open(false);
      expect(coffer.opened).toBe(true);
      expect(floor.world.colliders[apparatus.room]).toHaveLength(barriers);
    } finally {
      floor.dispose();
    }
  });
});
