import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { EncounterDirector } from '../src/combat/encounter.ts';
import {
  combatRoom,
  DEFAULT_TABLE_DISTANCE,
  headingDelta,
  headingTo,
  planEncounter,
  TABLE_HALF_WIDTH,
} from '../src/combat/placement.ts';
import { TABLE_NODES } from '../src/combat/table-greybox.ts';
import { generateFloor, type WorldRoom } from '../src/floor/generate.ts';
import { buildFloorWorld, type FloorWorld } from '../src/world/floor-world.ts';

const SEEDS = ['SPIRE001', 'SPIRE002', 'GEARS777', 'BRASS042', 'VA1T9QZK'];
const DEG = Math.PI / 180;

function worldWithEncounter(seed: string, pick: 'regular' | 'any' = 'any') {
  const plan = generateFloor(seed);
  const room = plan.rooms.findIndex(
    (r) => r.encounter && (pick === 'any' || r.encounter.tier === pick),
  );
  if (room < 0) throw new Error(`seed ${seed} has no encounter`);
  const world = buildFloorWorld(plan);
  world.current = room;
  world.group.updateMatrixWorld(true);
  return { world, room };
}

function enemyWorld(e: THREE.Object3D): THREE.Vector3 {
  return e.getWorldPosition(new THREE.Vector3());
}

/** A player spot 1 m from the first enemy, toward the room centre. */
function playerNear(world: FloorWorld, room: number, distance = 1) {
  const e = world.enemies.get(room)?.[0] as THREE.Object3D;
  const p = enemyWorld(e);
  const fp = world.rooms[room]?.footprint as { min: [number, number]; max: [number, number] };
  const cx = (fp.min[0] + fp.max[0]) / 2;
  const cz = (fp.min[1] + fp.max[1]) / 2;
  const len = Math.hypot(cx - p.x, cz - p.z) || 1;
  const x = p.x + ((cx - p.x) / len) * distance;
  const z = p.z + ((cz - p.z) / len) * distance;
  return { x, z, yaw: headingTo([x, z], [p.x, p.z]) };
}

function run(director: EncounterDirector, seconds: number, dt = 0.05) {
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) director.update(dt);
}

function leaf(director: EncounterDirector, name: string): THREE.Object3D {
  return director.table.getObjectByName(name) as THREE.Object3D;
}

describe('EncounterDirector trigger', () => {
  it('fires inside the radius in the current room only, and not once cleared', () => {
    const { world, room } = worldWithEncounter('SPIRE001');
    const director = new EncounterDirector({ world, lockLocomotion: () => {} });
    const near = playerNear(world, room);
    const hit = director.checkTrigger(near);
    expect(hit?.room).toBe(room);
    expect(hit?.distance).toBeCloseTo(1, 5);
    expect(director.checkTrigger({ x: near.x + 3, z: near.z + 3 })).toBeNull();

    // A different current room has no live encounter under the player.
    const other = world.plan.rooms.findIndex((r, i) => i !== room && !r.encounter);
    world.current = other;
    expect(director.checkTrigger(near)).toBeNull();
    world.current = room;
    expect(director.checkTrigger(near)).not.toBeNull();
  });

  it('honours a custom trigger radius', () => {
    const { world, room } = worldWithEncounter('SPIRE001');
    const director = new EncounterDirector({ world, lockLocomotion: () => {}, triggerRadius: 0.5 });
    expect(director.checkTrigger(playerNear(world, room))).toBeNull();
  });

  it('starts a fight beyond the old 1.2 m trigger from inside the room', () => {
    const { world, room } = worldWithEncounter('SPIRE001');
    for (const other of world.enemies.get(room)?.slice(1) ?? []) other.removeFromParent();
    const director = new EncounterDirector({ world, lockLocomotion: () => {} });
    const hit = director.checkTrigger(playerNear(world, room, 2.2));
    expect(hit?.distance).toBeCloseTo(2.2);
    expect(director.checkTrigger(playerNear(world, room, 2.8))).toBeNull();
  });

  it('releases guarded content on a win and never on a flee', () => {
    const { world, room } = worldWithEncounter('SPIRE001');
    const onCleared = vi.fn<(room: number) => void>();
    const director = new EncounterDirector({ world, lockLocomotion: () => {}, onCleared });
    const player = playerNear(world, room);
    expect(director.begin(room, player).ok).toBe(true);
    director.end('flee');
    run(director, 2);
    expect(onCleared).not.toHaveBeenCalled();
    expect(director.begin(room, player).ok).toBe(true);
    director.end('win');
    expect(onCleared).toHaveBeenCalledExactlyOnceWith(room);
    director.markCleared(room);
    expect(onCleared).toHaveBeenCalledTimes(1);
  });
});

describe('EncounterDirector begin and end', () => {
  it('freezes, locks locomotion, unfolds the table in 0.6 s and places the enemies 2 to 3 m beyond it', () => {
    const { world, room } = worldWithEncounter('SPIRE001');
    const lock = vi.fn();
    const director = new EncounterDirector({ world, lockLocomotion: lock });
    expect(director.frozen).toBe(false);
    expect(director.timeScale).toBe(1);
    expect(director.table.visible).toBe(false);

    const player = playerNear(world, room);
    const r = director.begin(room, { ...player, eyeHeight: 1.6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(director.phase).toBe('unfolding');
    expect(director.frozen).toBe(true);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock).toHaveBeenLastCalledWith(true);
    expect(director.checkTrigger(player)).toBeNull();
    expect(director.begin(room, player).ok).toBe(false);

    // Mid-unfold: visible, leaves still swinging.
    run(director, 0.3);
    expect(director.table.visible).toBe(true);
    expect(Math.abs(leaf(director, TABLE_NODES.leafLeft).rotation.z)).toBeGreaterThan(0.05);
    expect(director.phase).toBe('unfolding');

    // The unfold completes at about 0.6 s: both leaves are flat.
    run(director, 0.3);
    expect(leaf(director, TABLE_NODES.leafLeft).rotation.z).toBeCloseTo(0, 6);
    expect(leaf(director, TABLE_NODES.leafRight).rotation.z).toBeCloseTo(0, 6);
    expect(director.table.scale.x).toBeCloseTo(1, 6);

    // The enemy tween finishes at 0.8 s and the fight is active.
    run(director, 0.3);
    expect(director.phase).toBe('active');
    expect(lock).toHaveBeenCalledTimes(1);

    const pose = director.tablePose;
    expect(pose).not.toBeNull();
    if (!pose) return;
    // Table at the seat: waist height and on the player's facing side.
    expect(director.table.position.x).toBeCloseTo(pose.x);
    expect(director.table.position.z).toBeCloseTo(pose.z);
    expect(pose.height).toBeCloseTo(0.85);
    expect(Math.hypot(pose.x - player.x, pose.z - player.z)).toBeLessThanOrEqual(
      DEFAULT_TABLE_DISTANCE + 1e-9,
    );
    expect(headingDelta(pose.yaw, headingTo([player.x, player.z], [pose.x, pose.z]))).toBeLessThan(
      1e-6,
    );
    // The table root's -Z axis points along its heading.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(director.table.quaternion);
    expect(headingDelta(Math.atan2(fwd.x, -fwd.z) / DEG, pose.yaw)).toBeLessThan(1e-4);
    expect(TABLE_HALF_WIDTH).toBeGreaterThan(0.7);

    const enemies = world.enemies.get(room) ?? [];
    expect(enemies.length).toBeGreaterThan(0);
    world.group.updateMatrixWorld(true);
    enemies.forEach((e, i) => {
      const p = enemyWorld(e);
      const d = Math.hypot(p.x - pose.x, p.z - pose.z);
      expect(d).toBeGreaterThanOrEqual(2 - 1e-6);
      expect(d).toBeLessThanOrEqual(3 + 1e-6);
      expect(p.y).toBeCloseTo(e.userData.tier === 'guardian' ? 1.5 : 0.95, 6);
      // World -Z of the placeholder points at the player.
      const dir = new THREE.Vector3(0, 0, -1).transformDirection(e.matrixWorld);
      expect(
        headingDelta(Math.atan2(dir.x, -dir.z) / DEG, headingTo([p.x, p.z], [player.x, player.z])),
      ).toBeLessThan(0.01);
      expect(i).toBeLessThan(enemies.length);
    });

    // Ambient time has ramped down to the frozen scale by now.
    expect(director.timeScale).toBeCloseTo(0.05, 6);
    expect(director.scaledDt(1)).toBeCloseTo(0.05, 6);
  });

  it('reverses on a win: automatons removed, room cleared, table folds, locomotion unlocks', () => {
    const { world, room } = worldWithEncounter('SPIRE002');
    const lock = vi.fn();
    const director = new EncounterDirector({ world, lockLocomotion: lock });
    const player = playerNear(world, room);
    expect(director.begin(room, player).ok).toBe(true);
    run(director, 1);
    expect(director.phase).toBe('active');
    const enemies = [...(world.enemies.get(room) ?? [])];

    director.end('win');
    expect(director.phase).toBe('folding');
    expect(director.frozen).toBe(true);
    expect(lock).toHaveBeenCalledTimes(1);
    for (const e of enemies) expect(e.parent).toBeNull();
    expect(director.isCleared(room)).toBe(true);

    run(director, 0.3);
    expect(director.table.visible).toBe(true);
    expect(director.phase).toBe('folding');
    run(director, 0.4);
    expect(director.phase).toBe('idle');
    expect(director.frozen).toBe(false);
    expect(director.table.visible).toBe(false);
    expect(lock).toHaveBeenCalledTimes(2);
    expect(lock).toHaveBeenLastCalledWith(false);
    expect(director.timeScale).toBeCloseTo(1, 6);
    expect(director.tablePose).toBeNull();

    // Nothing left to trigger, even after the cooldown.
    run(director, 3);
    expect(director.checkTrigger(player)).toBeNull();
  });

  it('on a flee the automatons walk home and the room stays live', () => {
    const { world, room } = worldWithEncounter('SPIRE001');
    const lock = vi.fn();
    const director = new EncounterDirector({ world, lockLocomotion: lock });
    const enemies = world.enemies.get(room) ?? [];
    const home = enemies.map((e) => e.position.clone());
    const homeRot = enemies.map((e) => e.rotation.y);
    const player = playerNear(world, room);

    expect(director.begin(room, player).ok).toBe(true);
    run(director, 1);
    enemies.forEach((e, i) => {
      expect(e.position.distanceTo(home[i] as THREE.Vector3)).toBeGreaterThan(0.1);
    });

    director.end('flee');
    run(director, 1);
    expect(director.phase).toBe('idle');
    expect(lock).toHaveBeenLastCalledWith(false);
    enemies.forEach((e, i) => {
      expect(e.parent).not.toBeNull();
      expect(e.position.distanceTo(home[i] as THREE.Vector3)).toBeLessThan(1e-6);
      expect(Math.abs(e.rotation.y - (homeRot[i] as number))).toBeLessThan(1e-6);
    });
    expect(director.isCleared(room)).toBe(false);

    // The cooldown holds the trigger briefly, then it fires again.
    expect(director.checkTrigger(playerNear(world, room))).toBeNull();
    run(director, 2);
    expect(director.checkTrigger(playerNear(world, room))).not.toBeNull();
  });

  it('can end during the unfold without a jump and still fully restores', () => {
    const { world, room } = worldWithEncounter('GEARS777');
    const lock = vi.fn();
    const director = new EncounterDirector({ world, lockLocomotion: lock });
    expect(director.begin(room, playerNear(world, room)).ok).toBe(true);
    run(director, 0.2);
    const before = director.table.scale.x;
    director.end('defeat');
    director.update(0.01);
    expect(Math.abs(director.table.scale.x - before)).toBeLessThan(0.1);
    run(director, 1.5);
    expect(director.phase).toBe('idle');
    expect(lock.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it('ramps the time scale down and back instead of snapping', () => {
    const { world, room } = worldWithEncounter('SPIRE001');
    const director = new EncounterDirector({ world, lockLocomotion: () => {} });
    expect(director.begin(room, playerNear(world, room)).ok).toBe(true);
    director.update(0.1);
    expect(director.timeScale).toBeLessThan(1);
    expect(director.timeScale).toBeGreaterThan(0.05);
    run(director, 1);
    expect(director.timeScale).toBeCloseTo(0.05, 6);
    director.end('flee');
    director.update(0.1);
    expect(director.timeScale).toBeGreaterThan(0.05);
    expect(director.timeScale).toBeLessThan(1);
  });

  it('fails without touching anything when the player is outside any walkable space', () => {
    const { world, room } = worldWithEncounter('SPIRE001');
    const lock = vi.fn();
    const director = new EncounterDirector({ world, lockLocomotion: lock });
    const r = director.begin(room, { x: 1e4, z: 1e4, yaw: 0 });
    expect(r.ok).toBe(false);
    expect(director.phase).toBe('idle');
    expect(director.frozen).toBe(false);
    expect(lock).not.toHaveBeenCalled();
    expect(director.table.visible).toBe(false);
    // The retry cooldown stops the trigger firing every frame.
    expect(director.checkTrigger(playerNear(world, room))).toBeNull();
  });

  it('places the table and enemies for the first encounter room of several floors', () => {
    for (const seed of SEEDS) {
      const { world, room } = worldWithEncounter(seed);
      const director = new EncounterDirector({ world, lockLocomotion: () => {} });
      const r = director.begin(room, playerNear(world, room));
      expect(r.ok).toBe(true);
      run(director, 1);
      expect(director.phase).toBe('active');
      director.dispose();
    }
  });
});

describe('EncounterDirector table distance setting (F3)', () => {
  it('defaults to 1.1 m and reports no seat distance outside a fight', () => {
    const { world } = worldWithEncounter('SPIRE001');
    const director = new EncounterDirector({ world, lockLocomotion: () => {} });
    expect(director.tableDistance).toBe(DEFAULT_TABLE_DISTANCE);
    expect(director.seatDistance).toBeNull();
    const configured = new EncounterDirector({
      world,
      lockLocomotion: () => {},
      tableDistance: 1.3,
    });
    expect(configured.tableDistance).toBe(1.3);
  });

  it.each([0.9, 1.3])(
    'plans the table from the chosen %s m and reports where it stood',
    (distance) => {
      let placed = 0;
      for (const seed of SEEDS) {
        const { world, room } = worldWithEncounter(seed);
        const director = new EncounterDirector({ world, lockLocomotion: () => {} });
        director.tableDistance = distance;
        const player = { ...playerNear(world, room), eyeHeight: 1.6 };
        const enemies = (world.enemies.get(room) ?? []).length;
        const guardian = (world.enemies.get(room) ?? []).some(
          (e) => e.userData.tier === 'guardian',
        );
        const expected = planEncounter(
          player,
          enemies,
          combatRoom(world.rooms[room] as WorldRoom),
          {
            table: { distance },
            enemies: { radius: guardian ? 0.8 : 0.5 },
          },
        );
        const r = director.begin(room, player);
        expect(r.ok).toBe(expected.ok);
        if (!r.ok || !expected.ok) continue;
        placed += 1;
        expect(r.table.distance).toBeCloseTo(expected.table.distance);
        expect(r.table.distance).toBeLessThanOrEqual(distance + 1e-9);
        expect(director.seatDistance).toBeCloseTo(r.table.distance);
        const pose = director.tablePose;
        if (!pose) throw new Error('no table pose');
        expect(Math.hypot(pose.x - player.x, pose.z - player.z)).toBeCloseTo(r.table.distance);
        director.end('flee');
        run(director, 2);
        expect(director.seatDistance).toBeNull();
      }
      expect(placed).toBeGreaterThan(0);
    },
  );
});
