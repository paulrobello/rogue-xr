// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import {
  applyRoomStyle,
  disposeRoomStyle,
  roomStyleKitFromScene,
} from '../src/world/room-styles.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

it('keeps the real door aperture clear and covers the old window and sealed doorway with cast iron', async () => {
  const bytes = await readFile(
    'public/assets/props/architectural-finishes/architectural-finishes.glb',
  );
  const { scene } = await nodeGeometryLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    '',
  );
  const pump = new THREE.Group();
  applyRoomStyle(pump, 'boiler', roomStyleKitFromScene(scene), [
    { facing: 'S', position: [-1, 0, 4] },
    { facing: 'E', position: [4, 0, -1], closed: true },
  ]);
  pump.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  ray.far = 1.2;
  const hit = (x: number, y: number, z: number, dx: number, dz: number) => {
    ray.set(new THREE.Vector3(x, y, z), new THREE.Vector3(dx, 0, dz));
    return ray.intersectObject(pump, true)[0];
  };
  for (const offset of [-0.76, -0.43, 0, 0.43, 0.76])
    for (const y of [0.15, 1, 1.65, 2.36]) {
      expect(hit(-1 + offset, y, 3.4, 0, 1)).toBeUndefined();
      expect(hit(3.4, y, -1 + offset, 1, 0)?.object.userData.roomStylePiece).toBe('BoilerBay');
      expect(hit(offset, y, -3.4, 0, -1)?.object.userData.roomStylePiece).toBe('BoilerBay');
    }
  expect(hit(-1, 2.6, 3.4, 0, 1)?.object.userData.roomStylePiece).toBe('BoilerDoor');
  disposeRoomStyle(pump);
});
