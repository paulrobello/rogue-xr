// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { beforeAll, expect, it } from 'vitest';
import { Stairwell } from '../src/world/stairwell.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

const entry = {
  room: 0,
  door: 'e',
  world: [6, -2],
  facing: [1, 0],
  approach: [5.2, -2],
  alcove: { min: [6, -3.5], max: [11, -0.5] },
} as const;
let scene: THREE.Group;
beforeAll(async () => {
  const bytes = await readFile('public/assets/props/stairwell/stairwell.glb');
  scene = (
    await nodeGeometryLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      '',
    )
  ).scene;
});
it.each([1, 2] as const)(
  'picks the physical handle and swings it with the door to Floor %s',
  (destination) => {
    const model = scene.getObjectByName(destination === 2 ? 'StairUp' : 'StairDown');
    if (!model) throw Error('Missing staircase');
    const stair = new Stairwell(entry, destination, { roomGroups: [new THREE.Group()] }, model);
    const rise = destination === 2 ? 1.62 : -1.62;
    const pick = (from: number[], to: number[], room = 0) => {
      const origin = stair.root.localToWorld(new THREE.Vector3(...from));
      const dir = stair.root
        .localToWorld(new THREE.Vector3(...to))
        .sub(origin)
        .normalize();
      return stair.pick(room, origin, dir);
    };
    const handle = [0.44, rise + 0.88, 4.775];
    expect(pick([0.18, 1.24, 0.5], [0, rise / 9, 1.1])).toBeNull();
    expect(pick([0.2, rise + 1.15, 4.05], [0, rise + 1.25, 4.76])).toBeNull();
    expect(pick([0.2, rise + 1.15, 4.05], handle)).not.toBeNull();
    expect(pick(handle, [0.44, rise + 0.88, 5.5])?.distance).toBe(0);
    expect(pick([0.44, rise + 0.88, 4.94], handle)).toBeNull();
    expect(pick([2, 1.3, 2], handle)).toBeNull();
    expect(pick([1.7, 1.3, -1], handle)).toBeNull();
    expect(pick([0, 1.3, -1], handle, 1)).toBeNull();
    const closed = stair.handle.getWorldPosition(new THREE.Vector3());
    stair.open(1);
    const opened = stair.root.worldToLocal(stair.handle.getWorldPosition(new THREE.Vector3()));
    expect(opened.z).toBeGreaterThan(5.7);
    expect(stair.hinge.rotation.y).toBeCloseTo((-Math.PI * 75) / 180);
    stair.open(0);
    expect(stair.handle.getWorldPosition(new THREE.Vector3()).distanceTo(closed)).toBeLessThan(
      0.001,
    );
    stair.dispose();
  },
);
