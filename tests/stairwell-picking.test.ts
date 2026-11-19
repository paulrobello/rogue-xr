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
  'picks real steps and the destination on the flight to Floor %s',
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
    const door = [0, rise + 1.25, 4.76],
      tread = [0, rise / 9, 1.1];
    expect(pick([0.18, 1.24, 0.5], tread)).not.toBeNull();
    expect(pick([0.18, 1.24, 0.5], door)).not.toBeNull();
    expect(pick([0, 1.4, -6.5], door)).not.toBeNull();
    expect(pick([0.2, rise + 1.15, 4.05], door)).not.toBeNull();
    expect(pick([0.1, rise + 1.1, 4.94], [0.1, rise + 1.1, 5.5])?.distance).toBe(0);
    expect(pick([0, rise + 1.14, 4.2], [0, 0.5 * rise, 2.3])).not.toBeNull();
    expect(pick([2, 1.3, 2], door)).toBeNull();
    expect(pick([1.7, 1.3, -1], door)).toBeNull();
    expect(pick([0, 1.3, -1], door, 1)).toBeNull();
    expect(pick([0, 1.3, 0.55], [0, 1.3, -1])).toBeNull();
    stair.dispose();
  },
);
