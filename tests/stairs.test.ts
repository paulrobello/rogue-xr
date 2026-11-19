import { describe, expect, it } from 'vitest';
import { attachPressureWing, generateFloor, worldRooms } from '../src/floor/generate.ts';
import {
  placeStairEntry,
  stairGroundHeight,
  stairLandingOccupancy,
  stairLocalPoint,
} from '../src/floor/stairs.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { moveWithCollision } from '../src/xr/locomotion.ts';

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
  it('opens the seal, permits the full flight, and owns the stair position by its host room', () => {
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
    expect(world.colliders[entry.room]).toHaveLength(before + 2);
    expect(insideDoor(0)).toBe(false);
    expect(insideDoor(0.42)).toBe(false);
    expect(insideDoor(-0.8)).toBe(false);
    const start: [number, number] = [entry.approach[0], entry.approach[1]];
    const toStairs = [entry.facing[0] * 5, entry.facing[1] * 5] as const;
    const end = moveWithCollision(start, toStairs, world.nearbyColliders());
    expect(stairLocalPoint(entry, end[0], end[1]).depth).toBeGreaterThan(3.5);
    expect(world.update(end[0], end[1])).toBe(false);
    expect(world.stairGroundHeight(end[0], end[1])).not.toBeNull();
    const retreat = moveWithCollision(
      end,
      [-entry.facing[0] * 5, -entry.facing[1] * 5],
      world.nearbyColliders(),
    );
    expect(retreat[0]).toBeCloseTo(start[0], 1);
    expect(retreat[1]).toBeCloseTo(start[1], 1);
    expect(stairLandingOccupancy(entry, end[0], end[1])).toBe(true);
    expect(world.group.getObjectByName(`sealed-${entry.room}-${entry.door}`)).toBeUndefined();
    expect(world.group.getObjectByName(`door-fill-${entry.room}-${entry.door}`)).toBeUndefined();
    world.dispose();
  });
});

it.each([1, 2] as const)(
  'keeps walkers between the rails and in front of the door on floor %i',
  (number) => {
    const world = buildFloorWorld(
      playableFloorPlan(number === 1 ? 'MAPTEST2' : 'MAPTEST3', 3, number),
    );
    const entry = world.openStairEntry(number);
    if (!entry) throw Error('Missing stair door');
    const [fx, fz] = entry.facing;
    world.update(...entry.approach);
    const boxes = world.nearbyColliders();
    const y = number === 1 ? 1.62 : -1.62;
    const end = moveWithCollision(entry.approach, [12 * fx, 12 * fz], boxes, { floorY: y });
    const loc = stairLocalPoint(entry, ...end);
    expect(loc.depth).toBeCloseTo(4.8 - 0.25, 4);
    expect(world.stairGroundHeight(...end)).toBeCloseTo(y);
    for (const side of [-1, 1]) {
      const stopped = moveWithCollision(end, [3 * side * fz, -3 * side * fx], boxes, { floorY: y });
      expect(Math.abs(stairLocalPoint(entry, ...stopped).across)).toBeCloseTo(0.98 - 0.25, 4);
    }
    world.current = (entry.room + 1) % world.rooms.length;
    expect(world.update(...end)).toBe(true);
    expect(world.current).toBe(entry.room);
    world.dispose();
  },
);

it.each([
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
] as const)('measures the signed stair profile along a rotated flight', (fx, fz) => {
  const template = placeStairEntry(attachPressureWing(generateFloor('MAPTEST2')));
  if (!template) throw Error('Missing stairwell');
  const entry = { ...template, world: [3, -4], facing: [fx, fz] } as const;
  for (const direction of [-1, 1] as const) {
    const height = (depth: number) =>
      stairGroundHeight(entry, 3 + fx * depth, -4 + fz * depth, direction);
    expect(height(0.4)).toBe(0 * direction);
    expect(height((0.94 + 3.71) / 2)).toBeCloseTo(0.81 * direction);
    expect(height(4.2)).toBeCloseTo(1.62 * direction);
  }
});
