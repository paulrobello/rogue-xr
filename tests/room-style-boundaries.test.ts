// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { beforeAll, expect, it } from 'vitest';
import {
  applyRoomStyle,
  disposeRoomStyle,
  type RoomStyleKit,
  roomStyleKitFromScene,
} from '../src/world/room-styles.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

let kit: RoomStyleKit;
beforeAll(async () => {
  const bytes = await readFile(
    'public/assets/props/architectural-finishes/architectural-finishes.glb',
  );
  const { scene } = await nodeGeometryLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    '',
  );
  kit = roomStyleKitFromScene(scene);
});

it.each(['timber', 'boiler'] as const)(
  'keeps the assembled %s beams seated and their end faces off the neighbouring walls',
  (style) => {
    const room = new THREE.Group();
    applyRoomStyle(room, style, kit, [
      { facing: 'S', position: [-1, 0, 4] },
      { facing: 'E', position: [4, 0, -1] },
    ]);
    room.updateMatrixWorld(true);
    const axes = ['x', 'z'] as const;
    const matrix = new THREE.Matrix4(),
      a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      c = new THREE.Vector3();
    const ab = new THREE.Vector3(),
      ac = new THREE.Vector3();
    const externalFaces = new Set<string>();
    let farthest = 0;
    room.traverse((mesh) => {
      if (!(mesh instanceof THREE.Mesh)) return;
      const pos = mesh.geometry.getAttribute('position'),
        idx = mesh.geometry.index;
      for (let j = 0; j < (mesh instanceof THREE.InstancedMesh ? mesh.count : 1); j++) {
        matrix.copy(mesh.matrixWorld);
        if (mesh instanceof THREE.InstancedMesh) {
          mesh.getMatrixAt(j, matrix);
          matrix.premultiply(mesh.matrixWorld);
        }
        for (let i = 0; i < (idx?.count ?? pos.count); i += 3) {
          a.fromBufferAttribute(pos, idx?.getX(i) ?? i).applyMatrix4(matrix);
          b.fromBufferAttribute(pos, idx?.getX(i + 1) ?? i + 1).applyMatrix4(matrix);
          c.fromBufferAttribute(pos, idx?.getX(i + 2) ?? i + 2).applyMatrix4(matrix);
          const normal = ab.subVectors(b, a).cross(ac.subVectors(c, a));
          for (const axis of axes) {
            farthest = Math.max(farthest, Math.abs(a[axis]), Math.abs(b[axis]), Math.abs(c[axis]));
            const sign = Math.sign(normal[axis]);
            if (sign * a[axis] >= 3.99999 && sign * b[axis] >= 3.99999 && sign * c[axis] >= 3.99999)
              externalFaces.add(mesh.name);
          }
        }
      }
    });
    expect(farthest).toBeLessThanOrEqual(4.000001);
    expect([...externalFaces]).toEqual([]);
    // Sample up inside the 12 mm wall backing, beyond its inner surface at 3.988 m.
    const surfaces = room.getObjectByName(`${style}-deck-and-ceiling`);
    if (!surfaces) throw Error('Missing ceiling assembly');
    const ray = new THREE.Raycaster();
    for (const sign of [-1, 1]) {
      for (const [x, z] of [
        [sign * 3.99, 1],
        [style === 'timber' ? 0 : -2.28, sign * 3.99],
      ]) {
        ray.set(new THREE.Vector3(x, 3.3, z), new THREE.Vector3(0, 1, 0));
        const hit = ray.intersectObject(surfaces)[0];
        expect(hit?.point.y).toBeLessThan(3.92);
      }
    }
    disposeRoomStyle(room);
  },
);
