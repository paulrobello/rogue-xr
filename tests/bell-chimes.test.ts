// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { beforeAll, expect, it } from 'vitest';
import { BellChimes } from '../src/world/bell-chimes.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

let art: THREE.Object3D;
beforeAll(async () => {
  const b = await readFile('public/assets/props/puzzle-instruments/puzzle-instruments.glb');
  art = (
    await nodeGeometryLoader().parseAsync(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      '',
    )
  ).scene;
});

it.each([1, 2] as const)(
  'mounts the station on a reachable wall and restores its state on floor %s',
  (floor) => {
    const world = buildFloorWorld(
      playableFloorPlan(floor === 1 ? 'MAPTEST2' : 'MAPTEST3', 4, floor),
    );
    const station = BellChimes.mount(world, floor, art);
    if (!station) throw Error('missing station');
    expect(station.room).toBe(0);
    const group = station.object;
    const target = group.getObjectByName(floor === 1 ? 'music-box-target' : 'bell-1-target');
    if (!target) throw Error('missing interaction');
    group.updateWorldMatrix(true, true);
    const at = target.getWorldPosition(new THREE.Vector3());
    const from = group.localToWorld(new THREE.Vector3(0, 0, 1.25));
    expect(station.pick(from, at.clone().sub(from).normalize())?.action).toBe(
      floor === 1 ? 'listen' : 'strike',
    );
    world.current = 1;
    expect(station.near(at, 0.2)).toBeNull();
    world.current = 0;
    if (floor === 2) {
      expect(group.getObjectByName('bell-payout-cog')?.visible).toBe(false);
      station.sync({ clueHeard: true, progress: [0, 1, 2, 0], solved: true, rewardClaimed: false });
      expect(group.getObjectByName('bell-payout-cog')?.visible).toBe(true);
      expect(station.near(at, 0.05)).toBeNull();
      station.sync({ clueHeard: true, progress: [0, 1, 2, 0], solved: true, rewardClaimed: true });
      expect(group.getObjectByName('bell-payout-cog')?.visible).toBe(false);
    } else {
      const lamp = group.getObjectByName('music-box-note-3') as THREE.Mesh<
        THREE.SphereGeometry,
        THREE.MeshBasicMaterial
      >;
      const resting = lamp.material.color.clone();
      station.cue(2);
      expect(lamp.material.color.equals(resting)).toBe(false);
      station.update(0.7);
      expect(lamp.material.color.equals(resting)).toBe(true);
    }
    station.dispose();
    expect(group.parent).toBeNull();
    world.dispose();
  },
);
