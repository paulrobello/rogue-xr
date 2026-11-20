// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { closeLanternRoofs } from '../src/world/lantern-roofs.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

it.each([
  {
    id: 'gear-shaft',
    centers: [
      [3.6, 2.53, -5.6],
      [-3.6, 2.53, 5.6],
    ],
  },
  {
    id: 'corridor',
    centers: [
      [0.8, 2.33, 0],
      [-0.8, 2.33, -3],
      [-0.8, 2.33, 3],
    ],
  },
])('closes each $id lantern roof when viewed from inside the cage', async ({ id, centers }) => {
  const data = new Uint8Array(await readFile(`public/assets/rooms/${id}/${id}.glb`));
  const gltf = await nodeGeometryLoader().parseAsync(data.buffer, '');
  let addedIndices = 0;
  gltf.scene.traverse((mesh) => {
    if (mesh instanceof THREE.Mesh && mesh.material.name === `${id}_brass-aged`) {
      const before = mesh.geometry.index.count;
      mesh.geometry = closeLanternRoofs(id, mesh.geometry);
      addedIndices += mesh.geometry.index.count - before;
    }
  });
  expect(addedIndices).toBe(centers.length * 12);
  gltf.scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  for (const [x, y, z] of centers)
    for (const offset of [-0.046, 0.046]) {
      ray.set(new THREE.Vector3(x + offset, y - 0.05, z), new THREE.Vector3(0, 1, 0));
      const hit = ray.intersectObject(gltf.scene, true)[0];
      expect(hit.distance).toBeCloseTo(0.05, 4);
      expect(hit.face?.normal.y).toBeLessThan(-0.99);
    }
});
