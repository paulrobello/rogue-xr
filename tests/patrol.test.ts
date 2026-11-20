import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EncounterDirector } from '../src/combat/encounter.ts';
import { generateUpperFloor, guardedConnection } from '../src/floor/generate.ts';
import {
  PATROL_GAIT,
  type PatrolRoute,
  patrolPeriod,
  planPatrol,
  samplePatrol,
} from '../src/floor/patrol.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

const route: PatrolRoute = {
  rooms: [1, 2],
  ends: [
    [0, -1.89],
    [0, 1.89],
  ],
  cycles: 3,
};

describe('roaming sentry', () => {
  it('uses whole gait loops at confirmed travel speed and turns at rest without a root jump', () => {
    const pauseAt = PATROL_GAIT.start + PATROL_GAIT.walk * route.cycles + PATROL_GAIT.stop;
    const end = samplePatrol(route, pauseAt + 0.1);
    expect(end.motion).toBe('idle');
    expect(end.z).toBeCloseTo(route.ends[1][1]);
    expect(end.speed).toBe(0);
    const turn = samplePatrol(route, pauseAt + 1.2 + 0.6);
    expect(turn.motion).toBe('turn-left');
    expect(turn.z).toBeCloseTo(end.z);
    expect(turn.yaw - end.yaw).toBeCloseTo(Math.PI / 4);
    const walking = samplePatrol(route, 1);
    expect(walking.speed).toBeCloseTo(0.9);
    expect(samplePatrol(route, patrolPeriod(route))).toEqual(samplePatrol(route, 0));
    for (let t = 0; t < patrolPeriod(route); t += 0.017) {
      const a = samplePatrol(route, t);
      const b = samplePatrol(route, t + 0.017);
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.016);
    }
  });

  it('picks repeatable routes across ordinary doorways and excludes rooms already occupied by encounters', () => {
    const seeds = ['W1ND0000', 'W1ND0001', 'KEEP0000', 'CASE0042', 'N0TE0032'];
    const available = [];
    for (const seed of seeds) {
      const world = buildFloorWorld(generateUpperFloor(seed));
      try {
        const planned = planPatrol(world.plan, world.rooms, world.colliders);
        if (!planned) continue;
        available.push(planned);
        expect(planPatrol(world.plan, world.rooms, world.colliders)).toEqual(planned);
        const edge = world.plan.connections.find((e) =>
          e.every((ref) => planned.rooms.includes(ref.room)),
        );
        expect(edge?.puzzleGate).toBeUndefined();
        expect(edge).not.toBe(guardedConnection(world.plan));
        for (const room of planned.rooms) {
          expect(room).not.toBe(0);
          expect(world.plan.rooms[room].encounter).toBeNull();
        }
      } finally {
        world.dispose();
      }
    }
    expect(available.length).toBeGreaterThan(1);
  });

  it('uses the room for positioning without clearing its encounter or unlocking its coffer', () => {
    const world = buildFloorWorld(generateUpperFloor('W1ND0000'));
    world.current = 1;
    const body = new THREE.Group();
    world.group.add(body);
    const cleared: number[] = [];
    const director = new EncounterDirector({
      world,
      lockLocomotion: () => {},
      onCleared: (room) => cleared.push(room),
    });
    try {
      const [x, z] = world.plan.rooms[1].position;
      const at = { x, z };
      body.position.set(at.x, 0, at.z - 0.82);
      const result = director.begin(
        world.current,
        { x: at.x, z: at.z, yaw: 0, eyeHeight: 1.55 },
        body,
      );
      if (!result.ok) throw Error(result.reason);
      expect(director.activePatrol).toBe(body);
      expect(director.table.visible).toBe(false);
      const contact = body.position.clone();
      const facing = body.rotation.y;
      director.update(0.25);
      expect(body.position.distanceTo(contact)).toBeLessThan(1e-6);
      expect(body.rotation.y).toBeCloseTo(facing);
      let hiddenAtSlot = false;
      for (let i = 0; i < 900 && director.phase === 'unfolding'; i++) {
        director.update(1 / 60);
        if (!director.patrolAtSlot && director.phase === 'unfolding') {
          expect(director.table.visible).toBe(false);
        } else {
          const slot = result.enemies[0];
          expect(Math.hypot(body.position.x - slot.x, body.position.z - slot.z)).toBeLessThan(1e-5);
          if (!director.table.visible) hiddenAtSlot = true;
        }
      }
      expect(hiddenAtSlot).toBe(true);
      expect(director.phase).toBe('active');
      expect(director.table.visible).toBe(true);
      const slot = body.position.clone();
      director.end('flee');
      let walkedBack = false;
      for (let i = 0; i < 900 && director.phase === 'folding'; i++) {
        director.update(1 / 60);
        if (director.table.visible) {
          expect(body.position.distanceTo(slot)).toBeLessThan(1e-6);
        } else if (
          director.patrolApproachPose?.returning &&
          body.position.distanceTo(slot) > 0.01
        ) {
          walkedBack = true;
          expect(Math.hypot(body.position.x - x, body.position.z - z)).toBeGreaterThan(0.65);
        }
      }
      expect(walkedBack).toBe(true);
      expect(director.phase).toBe('idle');
      expect(body.parent).toBe(world.group);
      expect(body.position.distanceTo(contact)).toBeLessThan(1e-6);
      expect(Math.cos(body.rotation.y - facing)).toBeCloseTo(1);
      expect(cleared).toEqual([]);
      const seat = { x, z, yaw: 0, eyeHeight: 1.55 };
      expect(director.begin(world.current, seat, body).ok).toBe(false);
      director.update(1.6);
      expect(director.begin(world.current, seat, body).ok).toBe(true);
      director.end('win');
      expect(body.parent).toBeNull();
      expect(cleared).toEqual([]);
      expect(director.isCleared(world.current)).toBe(false);
    } finally {
      director.dispose();
      world.dispose();
    }
  });
});
