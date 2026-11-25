// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { beforeAll, expect, it } from 'vitest';
import { guardedConnection } from '../src/floor/generate.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { lightRoomStyle } from '../src/world/room-style-lighting.ts';
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

it('steps the capital clear of the shaft and gives each timber side face a single depth', () => {
  const ray = new THREE.Raycaster();
  for (const piece of [kit.TimberBay, kit.TimberCarvedBay, kit.TimberDoor]) {
    for (const side of [-1, 1]) {
      for (const height of [3.418, 3.476, 3.531, 3.58]) {
        ray.set(new THREE.Vector3(side * 0.83, height, 0.047), new THREE.Vector3(side, 0, 0));
        const sides = ray.intersectObject(piece).filter((hit) => hit.distance < 0.1);
        expect(sides.length).toBeGreaterThan(0);
        expect(Math.abs(sides[0].point.x)).toBeLessThan(0.89);
        for (let i = 1; i < sides.length; i++)
          expect(sides[i].distance - sides[i - 1].distance).toBeGreaterThan(0.0001);
      }
    }
  }
});

it('keeps the two finished faces and pull of the open Conservatory lock outside the walkable portal', () => {
  const view = mountFloorView(new THREE.Scene(), new THREE.Group(), 'MAPTEST2', { floorNumber: 3 });
  const world = view.world;
  const passage = guardedConnection(world.plan);
  if (!passage) throw Error('Expected a guarded Conservatory door');
  const [from] = passage;
  const door = world.rooms[from.room].doors.find((d) => d.id === from.door);
  if (!door) throw Error('Missing guarded door socket');
  view.useRoomAsset('hall', () => new THREE.Group(), [], kit);
  const mount = world.group.getObjectByName(`encounter-lock-${from.room}-${from.door}`);
  const leaf = mount?.getObjectByName('EncounterDoorLeaf');
  if (!mount || !(leaf instanceof THREE.Mesh)) throw Error('Conservatory door was not dressed');
  const geometry = leaf.geometry;
  const pos = geometry.getAttribute('position');
  const ray = new THREE.Raycaster();
  const closingFace = mount.getObjectByName('encounter-lock-leaf');
  expect(closingFace?.getObjectByName('encounter-lock-rebate')).toBeDefined();
  if (!closingFace) throw Error('Missing door closing face');
  closingFace.updateWorldMatrix(true, true);
  const nearEdge = closingFace.localToWorld(new THREE.Vector3(0.795, 1.2, 0.4));
  const oppositeEdge = closingFace.localToWorld(new THREE.Vector3(0.795, 1.2, -0.4));
  ray.set(nearEdge, oppositeEdge.sub(nearEdge).normalize());
  expect(ray.intersectObject(closingFace)[0]?.object.name).toBe('encounter-lock-rebate');
  for (const side of [-1, 1]) {
    ray.set(new THREE.Vector3(0.3, 1.554, side * 0.2), new THREE.Vector3(0, 0, -side));
    const hit = ray.intersectObject(kit.EncounterDoorLeaf)[0];
    if (!hit) throw Error('Missing door panel face');
    expect(hit.point.z * side).toBeGreaterThan(0.05);
  }
  expect(world.releaseGuardedDoor(from.room, true)).toBeTruthy();
  mount.updateWorldMatrix(true, true);
  const intoMount = mount.matrixWorld.clone().invert().multiply(leaf.matrixWorld);
  const point = new THREE.Vector3();
  const leftEdge =
    mount.worldToLocal(new THREE.Vector3(door.world[0], 0, door.world[1])).x - door.width / 2;
  for (let i = 0; i < pos.count; i++)
    expect(point.fromBufferAttribute(pos, i).applyMatrix4(intoMount).x).toBeLessThan(leftEdge);
  view.dispose();
});

it('blocks rays from behind the Conservatory timber jambs and lintel while keeping the opening clear', () => {
  const room = new THREE.Group();
  applyRoomStyle(room, 'timber', kit, [{ facing: 'N', position: [-1, 0, -4] }]);
  room.userData.conservatory = true;
  lightRoomStyle(room, []);
  room.updateMatrixWorld(true);
  const frame = room.children.filter((node) => node.userData.roomStylePiece === 'TimberDoor');
  expect(frame.length).toBeGreaterThan(0);
  const ray = new THREE.Raycaster();
  for (const [x, y] of [
    [-1.834, 1.3],
    [-0.166, 1.3],
    [-1, 2.44],
  ]) {
    ray.set(new THREE.Vector3(x, y, -4.05), new THREE.Vector3(0, 0, 1));
    expect(ray.intersectObjects(frame)[0]?.distance).toBeLessThan(0.22);
  }
  ray.set(new THREE.Vector3(-1, 1.6, -4.05), new THREE.Vector3(0, 0, 1));
  expect(ray.intersectObjects(frame)).toEqual([]);
  disposeRoomStyle(room);
});
