// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { mountFloorView } from '../src/world/floor-view.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

async function loadHall(directory: 'hall' | 'hall-closed'): Promise<THREE.Group> {
  const bytes = Uint8Array.from(await readFile(`public/assets/rooms/${directory}/hall.glb`));
  return (await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene;
}

it('mounts the shipped glass in exterior bays and points the MAPTEST2 projection at an accessible tile', async () => {
  const art = await loadHall('hall');
  const view = mountFloorView(new THREE.Scene(), new THREE.Group(), 'MAPTEST2');
  view.useRoomAsset('hall', () => art.clone(true));
  const entry = view.world.roomGroups[0];
  const filled = entry.getObjectByName('window-bay-0');
  expect(filled?.userData.windowBay.exposed).toBe(false);
  expect(filled?.getObjectByName('shared-window-wall')).toBeDefined();
  expect(entry.getObjectByName('window-colored-light')).toBeUndefined();
  let glassTriangles = 0;
  entry.traverse((node) => {
    if (node instanceof THREE.Mesh && node.material.name.includes('stained-glass'))
      glassTriangles += (node.geometry.index?.count ?? node.geometry.attributes.position.count) / 3;
  });
  expect(glassTriangles).toBe(0);

  const cache = view.windowCache;
  const room = view.world.roomGroups[12];
  const key = room.getObjectByName('window-key-projection');
  const window = room.getObjectByName('window-bay-0');
  const tile = room.getObjectByName('window-cache-tile');
  if (!cache || !key || !window || !tile) throw new Error('Missing the MAPTEST2 cache scene');
  expect(window.userData.windowBay.exposed).toBe(true);
  expect(
    window.children.some(
      (node) => node instanceof THREE.Mesh && node.material.name.includes('stained-glass'),
    ),
  ).toBe(true);
  expect(key.position.x).toBeCloseTo(cache.object.position.x);
  expect(cache.object.position.z - key.position.z).toBeCloseTo(2.58);

  const target = tile.getWorldPosition(new THREE.Vector3());
  const rayOrigin = room.localToWorld(
    cache.object.position.clone().add(new THREE.Vector3(0, 1.5, 1)),
  );
  const aim = target.sub(rayOrigin).normalize();
  expect(cache.pick(rayOrigin, aim)).toBeNull();
  view.world.current = 12;
  expect(cache.pick(rayOrigin, aim)?.distance).toBeGreaterThan(1);
  cache.sync(true);
  expect(cache.pick(rayOrigin, aim)).toBeNull();
  view.dispose();
});

it('selects the continuous, separately baked hall at blocked bays and keeps the original exterior clue', async () => {
  const [open, closed] = await Promise.all([loadHall('hall'), loadHall('hall-closed')]);
  closed.updateWorldMatrix(true, true);
  const ray = new THREE.Raycaster();
  for (const x of [2.17, 2.6, 3.03]) {
    for (const y of [1.52, 2.4, 3.45]) {
      ray.set(new THREE.Vector3(x, y, -4.7), new THREE.Vector3(0, 0, -1));
      const hit = ray.intersectObject(closed, true)[0];
      expect(hit?.distance).toBeCloseTo(0.3, 3);
      const surface = hit?.object;
      if (!(surface instanceof THREE.Mesh) || Array.isArray(surface.material))
        throw Error('The closed bay must have a continuous wallpaper surface');
      expect(surface.material.name).toBe('hall_wallpaper');
    }
  }
  const view = mountFloorView(new THREE.Scene(), new THREE.Group(), 'MAPTEST2');
  view.useRoomAsset(
    'hall',
    () => open.clone(true),
    [],
    undefined,
    () => {
      const model = closed.clone(true);
      model.name = 'test-closed-hall';
      return model;
    },
  );
  expect(view.world.roomGroups[0].getObjectByName('test-closed-hall')).toBeDefined();
  expect(view.world.roomGroups[0].getObjectByName('shared-window-wall')).toBeUndefined();
  expect(view.world.roomGroups[12].getObjectByName('test-closed-hall')).toBeUndefined();
  expect(view.world.roomGroups[12].getObjectByName('window-key-projection')).toBeDefined();
  view.dispose();
});
