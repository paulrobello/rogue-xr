import * as THREE from 'three';
import { expect, it } from 'vitest';
import { generateFloor } from '../src/floor/generate.ts';
import { CounterweightStation } from '../src/world/counterweight-station.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

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
