import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateFloor, worldRooms } from '../src/floor/generate.ts';
import {
  buildFloorWorld,
  nearSet,
  neighbours,
  roomAt,
  shellSet,
  visibleSet,
} from '../src/world/floor-world.ts';

const SEEDS = ['SPIRE001', 'SPIRE002', 'GEARS777', 'BRASS042', 'VA1T9QZK'];

function centre(fp: { min: readonly [number, number]; max: readonly [number, number] }) {
  return [(fp.min[0] + fp.max[0]) / 2, (fp.min[1] + fp.max[1]) / 2] as const;
}

/** True when `o` and every ancestor are visible: what the renderer draws. */
function shownInWorld(o: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) if (!n.visible) return false;
  return true;
}

/** Every enemy body, coffer and hearth on the floor, with its room and whether it is drawn. */
function contentsShown(
  world: ReturnType<typeof buildFloorWorld>,
): Map<THREE.Object3D, { room: number; shown: boolean }> {
  const out = new Map<THREE.Object3D, { room: number; shown: boolean }>();
  for (const [room, bodies] of world.enemies) {
    for (const b of bodies) out.set(b, { room, shown: shownInWorld(b) });
  }
  for (const c of world.coffers) out.set(c.object, { room: c.room, shown: shownInWorld(c.object) });
  for (const h of world.hearths) out.set(h.object, { room: h.room, shown: shownInWorld(h.object) });
  return out;
}

describe('neighbours and visibleSet', () => {
  it('follow the plan connections both ways', () => {
    const plan = generateFloor('SPIRE001');
    for (const [a, b] of plan.connections) {
      expect(neighbours(plan, a.room)).toContain(b.room);
      expect(neighbours(plan, b.room)).toContain(a.room);
    }
    const near = nearSet(plan, 0);
    expect(near.has(0)).toBe(true);
    expect(near.size).toBe(1 + neighbours(plan, 0).length);
    // SPIRE001's entry looks down a corridor into a fight room two doors away.
    expect(visibleSet(plan, 0)).toEqual(new Set([...near, ...shellSet(plan, 0)]));
    expect(shellSet(plan, 0).size).toBeGreaterThan(0);
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

  it('shows corridor-seen rooms with their contents, keeps gameplay on the near rooms, and changes nothing on entry', () => {
    const plan = generateFloor('SHELL024');
    const world = buildFloorWorld(plan);
    const shell = shellSet(plan, 0);
    const near = nearSet(plan, 0);
    expect(shell.size).toBeGreaterThan(0);
    // SHELL024 shows a treasure room and a fight room down its corridors.
    expect(world.coffers.some((c) => shell.has(c.room))).toBe(true);
    expect([...shell].some((r) => (world.enemies.get(r) ?? []).length > 0)).toBe(true);
    const before = contentsShown(world);
    const shellContents = [...before].filter(([, v]) => shell.has(v.room));
    expect(shellContents.length).toBeGreaterThan(0);
    for (const [, v] of before) {
      expect(v.shown).toBe(near.has(v.room) || shell.has(v.room));
    }
    for (const r of shell) {
      const g = world.roomGroups[r];
      expect(g?.visible).toBe(true);
      expect(g?.getObjectByName('floor')?.visible).toBe(true);
    }

    // Colliders and teleport landings reach the near rooms only.
    const nearColliders = [...near].flatMap((i) => world.colliders[i] ?? []);
    expect(world.nearbyColliders()).toEqual(nearColliders);
    const shellRects = [...shell].flatMap((i) => world.rooms[i]?.template.walkable ?? []).length;
    expect(world.nearbyWalkable().length).toBe(
      [...near].flatMap((i) => world.rooms[i]?.template.walkable ?? []).length,
    );
    expect(shellRects).toBeGreaterThan(0);

    // A body swapped in while its room is a shell is shown in its place.
    const fightShell = [...shell].find((r) => (world.enemies.get(r) ?? []).length > 0) as number;
    const body = world.enemies.get(fightShell)?.[0] as THREE.Object3D;
    const model = new THREE.Group();
    expect(world.replaceEnemy(fightShell, body, model)).toBe(true);
    expect(shownInWorld(model)).toBe(true);

    // Stepping into the corridor makes the room beyond it near: everything seen before and after
    // is the same object, shown the same way.
    const seen = contentsShown(world);
    const corridor = neighbours(plan, 0).find((n) =>
      neighbours(plan, n).includes(fightShell),
    ) as number;
    expect(plan.rooms[corridor]?.role).toBe('corridor');
    const [x, z] = centre(world.rooms[corridor]?.footprint ?? { min: [0, 0], max: [0, 0] });
    expect(world.update(x, z)).toBe(true);
    expect(nearSet(plan, corridor).has(fightShell)).toBe(true);
    expect(world.enemies.get(fightShell)?.[0]).toBe(model);
    expect(shownInWorld(model)).toBe(true);
    const after = contentsShown(world);
    const both = new Set([...visibleSet(plan, 0)].filter((r) => visibleSet(plan, corridor).has(r)));
    expect(both.has(fightShell)).toBe(true);
    for (const [object, v] of seen) {
      if (both.has(v.room)) expect(after.get(object)?.shown).toBe(true);
    }
    // Rooms out of sight are hidden whole, through their room group.
    for (const [i, g] of world.roomGroups.entries()) {
      expect(g.visible).toBe(visibleSet(plan, corridor).has(i));
    }
    for (const [, v] of after) expect(v.shown).toBe(visibleSet(plan, corridor).has(v.room));
    world.dispose();
  });

  it('shows a rest room hearth while the room is only seen down a corridor', () => {
    const plan = generateFloor('SHELL018');
    const world = buildFloorWorld(plan);
    const shell = shellSet(plan, 0);
    const hearths = world.hearths.filter((h) => shell.has(h.room));
    expect(hearths.length).toBeGreaterThan(0);
    for (const h of hearths) expect(shownInWorld(h.object)).toBe(true);
    world.dispose();
  });
});
