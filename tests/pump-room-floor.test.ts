import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { lightRoomStyle } from '../src/world/room-style-lighting.ts';
import { disposeRoomStyle } from '../src/world/room-styles.ts';

it('bakes contact only under the current room’s furniture and preserves shared kit materials', () => {
  const room = new THREE.Group();
  room.userData.roomStyle = 'timber';
  room.userData.room = 2;
  const shared = new THREE.MeshStandardMaterial({ name: 'TimberFinish' });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(), shared);
  room.add(mesh);
  const chair = {
    room: 2,
    root: 'DiningChair',
    theme: 'dining',
    object: new THREE.Group(),
    position: new THREE.Vector3(1, 0, -2),
    yaw: 0,
  } as const;
  lightRoomStyle(room, [chair, { ...chair, room: 8, position: new THREE.Vector3(-1, 0, -2) }]);
  const map = room.userData.finishLightMap as THREE.DataTexture;
  const { data, width } = map.image;
  if (!(data instanceof Uint8Array)) throw new Error('Missing finish atlas bytes');
  const tile = width / 3;
  const floor = (x: number, z: number): number => {
    const i = tile + Math.round(((x + 4) * (tile - 1)) / 8),
      j = tile + Math.round(((z + 4) * (tile - 1)) / 8);
    return data[4 * (j * width + i)];
  };
  expect(floor(1, -2)).toBeLessThan(floor(-1, -2) * 0.72);
  expect(mesh.material).not.toBe(shared);
  const releaseMap = vi.spyOn(map, 'dispose'),
    releaseMaterial = vi.spyOn(mesh.material, 'dispose'),
    releaseShared = vi.spyOn(shared, 'dispose');
  disposeRoomStyle(room);
  expect(releaseMap).toHaveBeenCalledOnce();
  expect(releaseMaterial).toHaveBeenCalledOnce();
  expect(releaseShared).not.toHaveBeenCalled();
});
