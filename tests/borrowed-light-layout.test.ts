import { describe, expect, it } from 'vitest';
import { BORROWED_LIGHT_VERSION } from '../src/combat/encounter-choice.ts';
import { attachBorrowedLight } from '../src/floor/borrowed-light.ts';
import { rectsOverlap, worldRooms } from '../src/floor/generate.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';

describe('borrowed light layout', () => {
  it('is deterministic, additive, connected, and gated at the optics side', () => {
    let count = 0;
    for (const seed of [
      'MAPTEST2',
      ...Array.from({ length: 48 }, (_, i) => `R3LAY${String(i).padStart(3, '0')}`),
    ]) {
      const floorSeed = floorSeedFor(seed, 3);
      const base = playableFloorPlan(floorSeed, BORROWED_LIGHT_VERSION - 1, 3);
      const plan = playableFloorPlan(floorSeed, BORROWED_LIGHT_VERSION, 3);
      if (!plan.borrowedLight) {
        expect(plan).toEqual(base);
        continue;
      }
      count++;
      expect(plan.rooms.slice(0, base.rooms.length)).toEqual(base.rooms);
      expect(plan.connections.slice(0, base.connections.length)).toEqual(base.connections);
      expect(plan.borrowedLight).toEqual({
        opticsRoom: base.rooms.length,
        recessRoom: base.rooms.length + 1,
        gate: expect.objectContaining({ room: base.rooms.length }),
      });
      const gate = plan.connections.find((edge) => edge.puzzleGate === 'borrowed-light');
      expect(gate?.[0]).toEqual(plan.borrowedLight?.gate);
      expect(gate?.[1].room).toBe(plan.borrowedLight?.recessRoom);
      expect(attachBorrowedLight(plan)).toEqual(plan);
      expect(plan.rooms[plan.borrowedLight.recessRoom].loot).toHaveLength(1);
      expect(plan.connections.at(-2)?.[1].room).toBe(plan.borrowedLight.opticsRoom);
      expect(plan.connections.at(-2)?.puzzleGate).toBeUndefined();
      const bounds = worldRooms(plan);
      for (const [i, room] of bounds.entries())
        expect(
          bounds.slice(0, i).some((other) => rectsOverlap(room.footprint, other.footprint)),
        ).toBe(false);
      expect(placeStairEntry(plan)).toEqual(placeStairEntry(base));
    }
    expect(count).toBeGreaterThan(40);
  });
});
