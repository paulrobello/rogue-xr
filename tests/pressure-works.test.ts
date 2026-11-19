// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { mountFloorView } from '../src/world/floor-view.ts';

describe('Pressure Works on a playable floor', () => {
  it('retains original saved layouts and only adds new rooms to a current floor', () => {
    for (const contentVersion of [1, 2, 3]) {
      const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), 'P1PE0028', {
        contentVersion,
      });
      expect(Boolean(floor.pressure)).toBe(contentVersion === 3);
      expect(Boolean(floor.world.plan.pressureWing)).toBe(contentVersion === 3);
      floor.dispose();
    }
  });
  it('animates the shared candle emitter from the floor clock', () => {
    const rig = new THREE.Group();
    const view = mountFloorView(new THREE.Scene(), rig, 'N0TE0032');
    const material = new THREE.MeshStandardMaterial({
      emissive: 0xffca70,
      emissiveIntensity: 0.85,
    });
    view.setCandleMaterials([material], false);
    view.update(rig, 0.22);
    expect(material.emissiveIntensity).toBeGreaterThan(0.85);
    view.dispose();
    material.dispose();
  });
  it('picks individual front-facing valves within reach, respects obstructions, and locks the solved station', () => {
    const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), 'P1PE0028');
    const works = floor.pressure,
      wing = floor.world.plan.pressureWing;
    if (!works || !wing) throw new Error('Expected the entry hall pressure wing');
    const origin = works.pump.localToWorld(new THREE.Vector3(0, 1.58, 2.35));
    const dir = (i: number) =>
      works.targets[i].getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
    expect(works.pick(origin, dir(0))).toBeNull();
    floor.world.update(origin.x, origin.z);
    expect(floor.world.current).toBe(wing.pumpRoom);
    for (const i of [0, 1, 2]) {
      const picked = works.pick(origin, dir(i));
      expect(picked?.action).toBe('turn');
      if (picked?.action === 'turn') expect(picked.valve).toBe(i);
    }
    const rear = works.pump.localToWorld(new THREE.Vector3(0, 1.19, -0.7));
    const centre = works.targets[1].getWorldPosition(new THREE.Vector3());
    expect(works.pick(rear, centre.clone().sub(rear).normalize())).toBeNull();
    const far = works.pump.localToWorld(new THREE.Vector3(0, 1.19, 5));
    expect(works.pick(far, centre.clone().sub(far).normalize())).toBeNull();
    const wheel = works.pump.getObjectByName('valve-1');
    if (!wheel) throw new Error('Valve pivot missing');
    const start = wheel.quaternion.clone();
    works.sync({ dials: [1, 2, 1], solved: false }, true);
    expect(wheel.quaternion.angleTo(start)).toBeCloseTo(0);
    works.update(0.3);
    expect(wheel.quaternion.angleTo(start)).toBeCloseTo((2 * Math.PI) / 3);
    works.sync({ dials: [1, 3, 2], solved: true });
    expect(works.pick(origin, dir(1))).toBeNull();
    floor.dispose();
    expect(works.pump.parent).toBeNull();
  });
  it('isolates the primer handle from all three wheel rims for near grip and oblique controller rays', () => {
    const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), 'MAPTEST2');
    const works = floor.pressure;
    if (!works) throw Error('missing pump');
    const point = (x: number, y: number, z: number) =>
      works.pump.localToWorld(new THREE.Vector3(x, y, z));
    const front = point(0.5, 1.5, 2.2);
    floor.world.update(front.x, front.z);
    const shot = (origin: THREE.Vector3, at: THREE.Vector3) =>
      works.pick(origin, at.clone().sub(origin).normalize());
    const handle = point(1.1, 0.81, 0.527);
    for (const eye of [front, point(-0.48, 1.24, 1.7), point(1.58, 1.75, 2.15)]) {
      expect(shot(eye, handle)?.action).toBe('prime');
      for (const [i, x] of [-0.82, 0, 0.82].entries()) {
        for (const dx of [0, 0.2, -0.2]) {
          const rim = point(x + dx, 1.05, 0.412);
          expect(shot(eye, rim)).toMatchObject({ action: 'turn', valve: i });
          expect(works.near(rim)).toMatchObject({ action: 'turn', valve: i });
        }
        expect(shot(eye, point(x, 1.49, 0.412))).toBeNull();
      }
    }
    expect(works.near(handle)?.action).toBe('prime');
    expect(works.near(point(1.06, 0.839, 0.5))?.action).toBe('prime');
    expect(works.near(point(0.82, 1.39, 0.412))).toBeNull();
    floor.dispose();
  });
});
