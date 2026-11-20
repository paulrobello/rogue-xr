// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { generateFloor } from '../src/floor/generate.ts';
import { CounterweightStation } from '../src/world/counterweight-station.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { kitPart } from '../src/world/puzzle-placement.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

it('weighs the selected candidate against the reference then hangs it on the chain', () => {
  const art = new THREE.Group(),
    scale = new THREE.Group(),
    rack = new THREE.Group(),
    beam = new THREE.Group();
  scale.name = 'balance_scale';
  rack.name = 'scale_weights';
  beam.name = 'balance_beam_pivot';
  art.add(scale, rack);
  scale.add(beam);
  for (const name of ['weight', 'knob']) {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.11, 0.1),
      new THREE.MeshStandardMaterial(),
    );
    m.name = name;
    rack.add(m);
  }
  const world = buildFloorWorld(generateFloor('MAPTEST2'));
  const station = new CounterweightStation(world, 0, art);
  const moving = station.object.getObjectByName('counterweight-b-target')!;
  const from = moving.getWorldPosition(new THREE.Vector3());
  station.sync(1, 0, false);
  expect(moving.getWorldPosition(new THREE.Vector3()).distanceTo(from)).toBeLessThan(1e-5);
  station.update(0.2);
  const lifted = moving.getWorldPosition(new THREE.Vector3());
  expect(lifted.y).toBeGreaterThan(from.y + 0.025);
  station.update(0.8);
  expect(Math.abs(station.beam.rotation.z)).toBeGreaterThan(0.15);
  station.sync(0, 0, false);
  station.update(1);
  expect(station.beam.rotation.z).toBeCloseTo(0);
  const target = station.object.getObjectByName('counterweight-a-target')!;
  expect(target.parent?.parent).toBe(station.beam);
  station.sync(0, 0, true);
  expect(target.parent?.parent).toBe(station.object);
  expect(station.near(target.getWorldPosition(new THREE.Vector3()), 0.3)).toBeNull();
  station.dispose();
  world.dispose();
});

it('seats the shipped weights on level pans and keeps parked weights clear throughout each swing', async () => {
  const [instrument, calibration] = await Promise.all(
    ['puzzle-instruments', 'calibration-kit'].map(async (name) => {
      const data = await readFile(`public/assets/props/${name}/${name}.glb`);
      return (
        await nodeGeometryLoader().parseAsync(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.length),
          '',
        )
      ).scene;
    }),
  );
  const world = buildFloorWorld(generateFloor('MAPTEST2'));
  const station = new CounterweightStation(world, 0, instrument);
  station.dress(calibration);
  const pans = station.beam.children.filter((part) => part.name === 'AssayPan');
  expect(pans).toHaveLength(2);
  const dishes = pans.map((pan) => kitPart(pan, 'AssayPan_Visual'));
  const rack = kitPart(station.object, 'AssayCase_Visual');
  const weights = ['AssayWeightA', 'AssayWeightB'].map((n) => kitPart(station.object, n));
  const reference = kitPart(station.object, 'counterweight-reference');
  const downward = new THREE.Vector3(0, -1, 0);
  const bounds = (part: THREE.Object3D) => new THREE.Box3().setFromObject(part, true);
  const seated = (weight: THREE.Object3D, support: THREE.Object3D) => {
    const body = bounds(weight);
    const center = body.getCenter(new THREE.Vector3());
    for (const offset of [-0.036, 0, 0.036]) {
      const start = new THREE.Vector3(center.x + offset, body.min.y + 0.02, center.z);
      const surface = new THREE.Raycaster(start, downward).intersectObject(support)[0];
      expect(surface?.point.y).toBeCloseTo(body.min.y, 5);
    }
  };
  const checkPans = (parked: readonly number[]) => {
    station.object.updateWorldMatrix(true, true);
    for (const pan of pans) {
      const up = new THREE.Vector3(0, 1, 0).transformDirection(pan.matrixWorld);
      expect(up.y).toBeCloseTo(1, 6);
    }
    seated(reference, dishes[1]);
    for (const i of parked) {
      seated(weights[i], rack);
      const body = bounds(weights[i]);
      const dish = bounds(dishes[i]);
      const separation = i === 0 ? dish.min.x - body.max.x : body.min.x - dish.max.x;
      expect(separation).toBeGreaterThan(0.01);
    }
  };
  checkPans([0, 1]);
  for (const [selected, correct] of [
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const) {
    station.sync(null, correct, false, true);
    station.sync(selected, correct, false);
    for (let frame = 0; frame < 120; frame++) {
      station.update(1 / 60);
      checkPans([1 - selected]);
    }
    seated(weights[selected], dishes[0]);
    expect(station.beam.rotation.z).toBeCloseTo(
      selected === correct ? 0 : selected ? -0.21 : 0.21,
      4,
    );
  }
  station.sync(1, 1, true);
  for (let frame = 0; frame < 100; frame++) station.update(1 / 60);
  checkPans([0]);
  expect(weights[1].parent?.parent?.name).toBe('AssayHanger');
  station.dispose();
  world.dispose();
});
