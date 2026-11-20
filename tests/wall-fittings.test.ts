// @vitest-environment node
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { generateFloor } from '../src/floor/generate.ts';
import { AstralLift } from '../src/world/astral-lift.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { WallVentSteam } from '../src/world/wall-vent-steam.ts';

it('seats the astral lift against the probed masonry', () => {
  const world = buildFloorWorld(generateFloor('MAPTEST2'));
  const art = new THREE.Group(),
    medallion = new THREE.Group();
  medallion.name = 'AstralLiftMedallion';
  art.add(medallion);
  const lift = AstralLift.mount(world, art, 2);
  const center = lift.target.getWorldPosition(new THREE.Vector3());
  const inward = lift.object.getWorldDirection(new THREE.Vector3());
  const ray = new THREE.Raycaster(center.clone().addScaledVector(inward, 0.25), inward.negate());
  const hit = ray.intersectObjects(
    world.roomGroups[lift.room].children.filter((o) => o !== lift.object),
    true,
  )[0];
  expect(hit.distance).toBeCloseTo(0.25, 4);
  lift.dispose();
  world.dispose();
});

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
