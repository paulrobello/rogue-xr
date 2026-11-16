import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateFloor, worldRooms } from '../src/floor/generate.ts';
import { buildFloorWorld, neighbours, roomAt, visibleSet } from '../src/world/floor-world.ts';

const SEEDS = ['SPIRE001', 'SPIRE002', 'GEARS777', 'BRASS042', 'VA1T9QZK'];

function centre(fp: { min: readonly [number, number]; max: readonly [number, number] }) {
  return [(fp.min[0] + fp.max[0]) / 2, (fp.min[1] + fp.max[1]) / 2] as const;
}

describe('neighbours and visibleSet', () => {
  it('follow the plan connections both ways', () => {
    const plan = generateFloor('SPIRE001');
    for (const [a, b] of plan.connections) {
      expect(neighbours(plan, a.room)).toContain(b.room);
      expect(neighbours(plan, b.room)).toContain(a.room);
    }
    const visible = visibleSet(plan, 0);
    expect(visible.has(0)).toBe(true);
    expect(visible.size).toBe(1 + neighbours(plan, 0).length);
  });
});

describe('roomAt', () => {
  it('finds each room from its centre, prefers the hint on a shared wall, and misses outside', () => {
    const plan = generateFloor('SPIRE001');
    const rooms = worldRooms(plan);
    rooms.forEach((r, i) => {
      const [x, z] = centre(r.footprint);
      expect(roomAt(rooms, x, z)).toBe(i);
    });
    const [a, b] = plan.connections[0] ?? [];
    const door = rooms[a?.room ?? 0]?.doors.find((d) => d.id === a?.door);
    expect(door).toBeDefined();
    const [dx, dz] = door?.world ?? [0, 0];
    expect(roomAt(rooms, dx, dz, a?.room)).toBe(a?.room);
    expect(roomAt(rooms, dx, dz, b?.room)).toBe(b?.room);
    expect(roomAt(rooms, 1e4, 1e4)).toBe(-1);
  });
});

describe('buildFloorWorld', () => {
  for (const seed of SEEDS) {
    it(`builds ${seed} with rooms, enemies and sealed caps where the plan puts them`, () => {
      const plan = generateFloor(seed);
      const world = buildFloorWorld(plan);
      world.group.updateMatrixWorld(true);
      expect(world.roomGroups).toHaveLength(plan.rooms.length);

      const at = new THREE.Vector3();
      for (const [index, bodies] of world.enemies) {
        expect(bodies).toHaveLength(plan.rooms[index]?.encounter?.socketIds.length ?? 0);
        const fp = world.rooms[index]?.footprint;
        for (const body of bodies) {
          body.getWorldPosition(at);
          // A rotation sign mismatch would swing sockets out of their room.
          expect(roomAt(world.rooms, at.x, at.z, index)).toBe(index);
          expect(at.x).toBeGreaterThanOrEqual((fp?.min[0] ?? 0) - 1e-6);
          expect(at.x).toBeLessThanOrEqual((fp?.max[0] ?? 0) + 1e-6);
        }
      }

      const caps: THREE.Object3D[] = [];
      world.group.traverse((o) => {
        if (o.name.startsWith('sealed-')) caps.push(o);
      });
      expect(caps).toHaveLength(plan.sealed.length);
      for (const s of plan.sealed) {
        const cap = world.group.getObjectByName(`sealed-${s.room}-${s.door}`);
        const door = world.rooms[s.room]?.doors.find((d) => d.id === s.door);
        cap?.getWorldPosition(at);
        expect(at.x).toBeCloseTo(door?.world[0] ?? Number.NaN, 5);
        expect(at.z).toBeCloseTo(door?.world[1] ?? Number.NaN, 5);
        expect(cap?.parent).toBe(world.roomGroups[s.room]);
      }
      world.dispose();
    });
  }

  it('shows the current room and its neighbours, and moves with the player', () => {
    const plan = generateFloor('SPIRE001');
    const world = buildFloorWorld(plan);
    const shown = () => new Set(world.roomGroups.flatMap((g, i) => (g.visible ? [i] : [])));
    expect(world.current).toBe(0);
    expect(shown()).toEqual(visibleSet(plan, 0));

    const spawn = world.spawnPoint();
    expect(roomAt(world.rooms, spawn.x, spawn.z)).toBe(0);
    expect(world.update(spawn.x, spawn.z)).toBe(false);

    const next = neighbours(plan, 0)[0] as number;
    const [x, z] = centre(world.rooms[next]?.footprint ?? { min: [0, 0], max: [0, 0] });
    expect(world.update(x, z)).toBe(true);
    expect(world.current).toBe(next);
    expect(shown()).toEqual(visibleSet(plan, next));
    // Leaving the map keeps the last room rather than blanking the world.
    expect(world.update(1e4, 1e4)).toBe(false);
    expect(world.current).toBe(next);
    world.dispose();
    expect(world.group.parent).toBeNull();
  });
});
