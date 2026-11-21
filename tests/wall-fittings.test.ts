// @vitest-environment node
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { conservatoryPlan } from '../src/floor/conservatory.ts';
import { generateFloor, generateUpperFloor } from '../src/floor/generate.ts';
import { AstralLift } from '../src/world/astral-lift.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { WallVentSteam } from '../src/world/wall-vent-steam.ts';

it.each([
  { plan: generateUpperFloor('MAPTEST2'), destination: 3 as const },
  { plan: conservatoryPlan('MAPTEST2'), destination: 2 as const },
])(
  'mounts accessible lift doors that slide open on the route to floor $destination',
  ({ plan, destination }) => {
    const world = buildFloorWorld(plan);
    const art = new THREE.Group();
    const plate = new THREE.Mesh(new THREE.SphereGeometry(0.43), new THREE.MeshBasicMaterial());
    plate.name = 'AstralLiftMedallion';
    art.add(plate);
    const lift = AstralLift.mount(world, art, destination);
    world.current = lift.room;
    world.roomGroups[lift.room].visible = true;
    lift.object.updateWorldMatrix(true, true);
    const back = new THREE.Box3().setFromObject(lift.object);
    expect(back.min.y).toBeCloseTo(0, 2);
    expect(back.max.y).toBeGreaterThan(2.3);
    const inward = lift.object.getWorldDirection(new THREE.Vector3());
    const point = (x: number, y: number, z: number) =>
      lift.object.localToWorld(new THREE.Vector3(x, y, z));
    const masonry = world.roomGroups[lift.room].children.filter((o) => o !== lift.object);
    const mount = new THREE.Raycaster(point(0, 1.48, 0.5), inward.clone().negate());
    expect(mount.intersectObjects(masonry, true)[0]?.distance).toBeCloseTo(0.5, 4);
    for (const x of [-0.35, 0.35, lift.target.position.x])
      expect(lift.pick(point(x, 1.23, 1.65), inward.clone().negate())?.distance).toBeLessThan(1.5);
    const left = lift.object.getObjectByName('astral-lift-door-left');
    const right = lift.object.getObjectByName('astral-lift-door-right');
    if (!left || !right) throw Error('Missing lift doors');
    const before = right.position.x - left.position.x;
    lift.open(1);
    lift.object.updateWorldMatrix(true, true);
    expect(right.position.x - left.position.x).toBeGreaterThan(before + 0.8);
    for (const x of [-0.33, 0, 0.33]) {
      for (const y of [0.2, 1.3, 1.9]) {
        const origin = point(x + 0.42, y, 1.65);
        const direction = point(x, y, 0.13).sub(origin).normalize();
        const ray = new THREE.Raycaster(origin, direction);
        const surface = ray.intersectObject(lift.object, true)[0]?.object;
        expect(surface?.name).toBe('astral-lift-interior');
        if (
          !(surface instanceof THREE.Mesh) ||
          !(surface.material instanceof THREE.MeshBasicMaterial)
        )
          throw Error('Missing the dark aperture backing');
        expect(surface.material.color.getHex()).toBe(0);
        expect(surface.material.fog).toBe(false);
        expect(lift.pick(origin, direction)).toBeNull();
      }
    }
    lift.dispose();
    expect(lift.object.parent).toBeNull();
    plate.geometry.dispose();
    plate.material.dispose();
    world.dispose();
  },
);

it('emits intermittent steam from the mounted bay and respects reduced motion', () => {
  const world = buildFloorWorld(generateFloor('MAPTEST2'));
  const room = world.roomGroups[world.current];
  const model = new THREE.Group();
  const pose = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(-4, 0, 1);
  model.userData.serviceVentPoses = [pose];
  room.add(model);
  const effect = new WallVentSteam(world);
  const active = [];
  for (let i = 0; i < 150; i++) {
    effect.update(0.1);
    const plume = room.getObjectByName('wall-louver-steam');
    active.push(plume?.visible === true);
    if (plume?.visible)
      expect(plume.matrix.elements).toEqual(
        pose.clone().multiply(new THREE.Matrix4().makeTranslation(0, 2.103, 0.122)).elements,
      );
  }
  expect(active.filter(Boolean).length).toBeGreaterThan(12);
  expect(active.filter(Boolean).length).toBeLessThan(50);
  effect.setReducedMotion(true);
  for (let i = 0; i < 150; i++) {
    effect.update(0.1);
    expect(room.getObjectByName('wall-louver-steam')?.visible).toBe(false);
  }
  effect.dispose();
  expect(room.getObjectByName('wall-louver-steam')).toBeUndefined();
  world.dispose();
});
