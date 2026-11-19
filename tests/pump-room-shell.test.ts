// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { templateById } from '../src/content/rooms.ts';
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

it.each([
  ['timber', 'gear-shaft', 's'],
  ['boiler', 'corridor', 'n'],
] as const)(
  'joins the %s jambs and lintel continuously with exactly one exposed reveal at each depth',
  async (style, neighbor, door) => {
    async function asset(path: string) {
      const bytes = await readFile('public/assets/' + path + '.glb');
      return (
        await nodeGeometryLoader().parseAsync(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
          '',
        )
      ).scene;
    }
    const kit = roomStyleKitFromScene(
      await asset('props/architectural-finishes/architectural-finishes'),
    );
    const a = new THREE.Group(),
      b = await asset('rooms/' + neighbor + '/' + neighbor);
    // Align each authored opening in one doorway frame, its centerline at x=z=0.
    applyRoomStyle(a, style, kit, [{ facing: 'S', position: [-1, 0, 4] }]);
    a.position.set(1, 0, -4);
    const d = templateById(neighbor).doors.find((d) => d.id === door);
    if (!d) throw Error('Expected connecting door');
    const plug = b.getObjectByName('door-plug-' + door);
    if (plug) plug.visible = false;
    const yaw = { N: 0, E: Math.PI / 2, S: Math.PI, W: -Math.PI / 2 }[d.facing];
    b.rotation.y = yaw;
    b.position
      .copy(new THREE.Vector3(...d.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw))
      .negate();
    const meshes = (root: THREE.Group) => {
      root.updateWorldMatrix(true, true);
      const result: THREE.Mesh[] = [];
      root.traverseVisible((n) => {
        if (n instanceof THREE.Mesh) result.push(n);
      });
      return result;
    };
    const sides = [meshes(a), meshes(b)],
      ray = new THREE.Raycaster();
    ray.far = 1;
    for (const depth of [-0.028, -0.0175, -0.008, -0.0002, 0.0002, 0.008, 0.0175, 0.028]) {
      for (const side of [-1, 0, 1]) {
        ray.set(
          new THREE.Vector3(0, side ? 1.6 : 2, depth),
          new THREE.Vector3(side, side ? 0 : 1, 0),
        );
        expect(
          sides.filter((m) => ray.intersectObjects(m, false).length > 0),
          `depth=${depth}, side=${side}`,
        ).toHaveLength(1);
      }
    }
    disposeRoomStyle(a);
  },
);
