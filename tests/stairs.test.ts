import { describe, expect, it } from 'vitest';
import { attachPressureWing, generateFloor, worldRooms } from '../src/floor/generate.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

const SEEDS = ['MAPTEST2', 'SPIRE001', 'SPIRE002', 'GEARS777', 'BRASS042', 'VA1T9QZK'];

describe('stair entry placement', () => {
  it.each(SEEDS)('%s has one deterministic clear reachable landing', (seed) => {
    const plan = attachPressureWing(generateFloor(seed));
    const first = placeStairEntry(plan);
    const second = placeStairEntry(plan);
    expect(first).toEqual(second);
    expect(first).not.toBeNull();
    expect(
      plan.pressureWing ? [plan.pressureWing.gallery, plan.pressureWing.pumpRoom] : [],
    ).not.toContain(first?.room);
    expect(plan.rooms[first?.room ?? -1]?.loot).toHaveLength(0);
    const rooms = worldRooms(plan);
    expect(
      rooms.some(
        (room) =>
          room.footprint.min[0] < (first?.alcove.max[0] ?? 0) &&
          room.footprint.max[0] > (first?.alcove.min[0] ?? 0) &&
          room.footprint.min[1] < (first?.alcove.max[1] ?? 0) &&
          room.footprint.max[1] > (first?.alcove.min[1] ?? 0),
      ),
    ).toBe(false);
  });

  it('prefers the entry room for the seated MAPTEST2 showcase when clear', () => {
    const entry = placeStairEntry(attachPressureWing(generateFloor('MAPTEST2')));
    expect(entry?.room).toBe(0);
  });
});

it('keeps the showcase upper floor peaceful and preserves MAPTEST3 when played as a regular run seed', () => {
  const upper = playableFloorPlan('MAPTEST3', 3, 2);
  expect(upper.rooms.every((room) => room.encounter === null)).toBe(true);
  const regular = playableFloorPlan('MAPTEST3', 3, 1);
  expect(regular.rooms.some((room) => room.encounter !== null)).toBe(true);
  expect(placeStairEntry(upper)).not.toBeNull();
});

describe('FloorWorld stair opening', () => {
  it('opens only the stair seal and stops smooth movement before the flight', () => {
    const world = buildFloorWorld(attachPressureWing(generateFloor('MAPTEST2')));
    const entry = world.stairEntry;
    expect(entry).not.toBeNull();
    if (!entry) return;
    const before = world.colliders[entry.room]?.length ?? 0;
    const insideDoor = (depth: number) =>
      world.colliders[entry.room].some(({ min, max }) => {
        const x = entry.world[0] + depth * entry.facing[0],
          z = entry.world[1] + depth * entry.facing[1];
        return x >= min[0] && x <= max[0] && z >= min[2] && z <= max[2];
      });
    expect(insideDoor(0)).toBe(true);
    expect(world.openStairEntry()).toEqual(entry);
    expect(world.openStairEntry()).toEqual(entry);
    expect(world.colliders[entry.room]).toHaveLength(before);
    expect(insideDoor(0)).toBe(false);
    expect(insideDoor(0.42)).toBe(true);
    expect(insideDoor(-0.8)).toBe(false);
    expect(world.group.getObjectByName(`sealed-${entry.room}-${entry.door}`)).toBeUndefined();
    expect(world.group.getObjectByName(`door-fill-${entry.room}-${entry.door}`)).toBeUndefined();
    world.dispose();
  });
});
