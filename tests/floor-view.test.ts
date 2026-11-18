import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { combatRoom, headingDelta, planEncounter } from '../src/combat/placement.ts';
import type { Box } from '../src/content/rooms.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { DEFAULT_VIGNETTE, yawFromMatrix } from '../src/xr/locomotion.ts';

function step(view: ReturnType<typeof mountFloorView>, head: THREE.Object3D, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    head.updateMatrixWorld(true);
    view.update(head, 1 / 60);
  }
}

describe('floor view encounters', () => {
  it('freezes, locks and unfolds the table near an automaton, then releases on a win', () => {
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    const view = mountFloorView(scene, rig, 'SPIRE001');
    const [room, bodies] = [...view.world.enemies].find(([, b]) => b.length > 0) ?? [];
    expect(room).toBeDefined();
    const target = new THREE.Vector3();
    bodies?.[0]?.getWorldPosition(target);

    const head = new THREE.Object3D();
    scene.add(head);
    // Stand 1 m south of the automaton, eyes at 1.2 m, looking north at it.
    head.position.set(target.x, 1.2, target.z + 1);
    view.world.update(head.position.x, head.position.z);
    expect(view.world.current).toBe(room);

    step(view, head, 1 / 60);
    expect(view.encounter.phase).toBe('unfolding');
    expect(view.encounter.frozen).toBe(true);
    expect(view.locked).toBe(true);

    step(view, head, 1.2);
    expect(view.encounter.phase).toBe('active');
    const table = view.encounter.tablePose;
    expect(table).not.toBeNull();
    // The table sits in front of the player, toward the automaton (north is -Z).
    expect(table?.z ?? 0).toBeLessThan(head.position.z);

    view.encounter.end('win');
    step(view, head, 1.2);
    expect(view.encounter.phase).toBe('idle');
    expect(view.locked).toBe(false);
    expect(view.encounter.isCleared(room as number)).toBe(true);
    // A cleared room does not trigger again.
    step(view, head, 2);
    expect(view.encounter.phase).toBe('idle');
  });

  it('snaps the rig about the head to face a table that had to turn off the head heading', () => {
    const DEG = Math.PI / 180;
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    scene.add(rig);
    // An XR head: tracked off the rig origin, as a seated player leaning to one side is.
    const head = new THREE.PerspectiveCamera();
    head.position.set(0.25, 1.6, -0.15);
    rig.add(head);
    const view = mountFloorView(scene, rig, 'SPIRE001');

    // A seat 1 m from an automaton, facing a heading whose table must turn at least 45 degrees.
    let seat: { x: number; z: number; yaw: number; room: number; offset: number } | null = null;
    const p = new THREE.Vector3();
    search: for (const [room, bodies] of view.world.enemies) {
      const wr = view.world.rooms[room];
      if (!wr || bodies.length === 0 || !view.world.plan.rooms[room]?.encounter) continue;
      const guardian = bodies.some((b) => b.userData.tier === 'guardian');
      for (const body of bodies) {
        body.getWorldPosition(p);
        for (let k = 0; k < 8; k++) {
          const x = p.x + Math.sin(k * 45 * DEG);
          const z = p.z - Math.cos(k * 45 * DEG);
          for (let yaw = 0; yaw < 360; yaw += 15) {
            const plan = planEncounter(
              { x, z, yaw, eyeHeight: 1.6 },
              bodies.length,
              combatRoom(wr),
              {
                enemies: { radius: guardian ? 0.8 : 0.5 },
              },
            );
            if (!plan.ok || Math.abs(plan.table.offsetDeg) < 45) continue;
            view.world.update(x, z);
            if (view.world.current !== room) continue;
            seat = { x, z, yaw, room, offset: plan.table.offsetDeg };
            break search;
          }
        }
      }
    }
    expect(seat).not.toBeNull();
    if (!seat) return;

    // Put the head at the seat, looking along `yaw`.
    rig.rotation.y = -seat.yaw * DEG;
    rig.position.set(0, 0, 0);
    rig.updateMatrixWorld(true);
    const local = head.getWorldPosition(new THREE.Vector3());
    rig.position.set(seat.x - local.x, 0, seat.z - local.z);
    rig.updateMatrixWorld(true);
    const before = head.getWorldPosition(new THREE.Vector3());
    expect(yawFromMatrix(head.matrixWorld.elements)).toBeCloseTo(seat.yaw, 6);

    view.update(head, 1 / 60);
    expect(view.encounter.phase).toBe('unfolding');
    expect(view.encounter.activeRoom).toBe(seat.room);
    const table = view.encounter.tablePose;
    if (!table) throw new Error('no table pose');
    // The head stays put and now faces the table, which sits straight ahead of it.
    const after = head.getWorldPosition(new THREE.Vector3());
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.z).toBeCloseTo(before.z, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    const facing = yawFromMatrix(head.matrixWorld.elements);
    expect(headingDelta(facing, seat.yaw + seat.offset)).toBeLessThan(1e-6);
    expect(headingDelta(facing, table.yaw)).toBeLessThan(1e-6);
    // The snap shows behind the comfort vignette, which then fades.
    expect(view.turnVignette).toBeCloseTo(DEFAULT_VIGNETTE.maxStrength, 9);
    for (let t = 0; t < 0.5; t += 1 / 60) view.update(head, 1 / 60);
    expect(view.turnVignette).toBe(0);
    // Locked in the fight, the rig turns no further.
    expect(headingDelta(yawFromMatrix(head.matrixWorld.elements), table.yaw)).toBeLessThan(1e-6);
  });

  it('keeps the rig still on straight-ahead entry and moves the seat when distance changes', () => {
    const scene = new THREE.Scene();
    const rig = new THREE.Group();
    scene.add(rig);
    const head = new THREE.PerspectiveCamera();
    rig.add(head);
    const view = mountFloorView(scene, rig, 'SPIRE001');
    // A seat 1 m due south of an automaton, looking north at it, whose table fits straight ahead.
    let seat: { x: number; z: number } | null = null;
    const p = new THREE.Vector3();
    search: for (const [room, bodies] of view.world.enemies) {
      const wr = view.world.rooms[room];
      if (!wr || bodies.length === 0 || !view.world.plan.rooms[room]?.encounter) continue;
      const guardian = bodies.some((b) => b.userData.tier === 'guardian');
      for (const body of bodies) {
        body.getWorldPosition(p);
        const plan = planEncounter(
          { x: p.x, z: p.z + 1, yaw: 0, eyeHeight: 1.6 },
          bodies.length,
          combatRoom(wr),
          { enemies: { radius: guardian ? 0.8 : 0.5 } },
        );
        if (!plan.ok || plan.table.offsetDeg !== 0) continue;
        view.world.update(p.x, p.z + 1);
        if (view.world.current !== room) continue;
        seat = { x: p.x, z: p.z + 1 };
        break search;
      }
    }
    if (!seat) throw new Error('no straight-ahead seat on this floor');
    head.position.set(0, 1.6, 0);
    rig.position.set(seat.x, 0, seat.z);
    rig.updateMatrixWorld(true);
    const rigBefore = rig.position.clone();
    view.update(head, 1 / 60);
    expect(view.encounter.phase).toBe('unfolding');
    const r = view.encounter.tablePose;
    if (!r) throw new Error('no table pose');
    expect(headingDelta(r.yaw, 0)).toBeLessThan(1e-6);
    expect(rig.position.distanceTo(rigBefore)).toBeLessThan(1e-12);
    expect(rig.rotation.y).toBe(0);
    expect(view.turnVignette).toBe(0);

    step(view, head, 1.2);
    expect(view.encounter.phase).toBe('active');
    const startDistance = view.encounter.seatDistance as number;
    const tableBefore = view.encounter.table.position.clone();
    view.setTableDistance(1.3, head);
    expect(rig.position.x).toBeCloseTo(rigBefore.x);
    expect(rig.position.z).toBeCloseTo(rigBefore.z + 0.2);
    expect(rig.position.y).toBe(rigBefore.y);
    expect(view.encounter.seatDistance).toBeCloseTo(startDistance + 0.2);
    expect(view.encounter.table.position.equals(tableBefore)).toBe(true);
    expect(view.turnVignette).toBeCloseTo(DEFAULT_VIGNETTE.maxStrength);

    view.setTableDistance(1.3, head);
    expect(rig.position.z).toBeCloseTo(rigBefore.z + 0.2);
    view.setTableDistance(1.1, head);
    expect(rig.position.distanceTo(rigBefore)).toBeLessThan(1e-12);

    const colliders = view.world.colliders[view.encounter.activeRoom] as Box[];
    colliders.push({
      min: [seat.x - 0.4, 0, seat.z + 0.26],
      max: [seat.x + 0.4, 1.8, seat.z + 0.3],
    });
    view.setTableDistance(1.3, head);
    expect(rig.position.distanceTo(rigBefore)).toBeLessThan(1e-12);
    expect(view.encounter.seatDistance).toBeCloseTo(startDistance);
    expect(view.encounter.tableDistance).toBe(1.3);
  });
});
