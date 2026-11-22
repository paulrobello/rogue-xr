// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { mountFloorView } from '../src/world/floor-view.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

async function loadHall(directory: 'hall' | 'hall-closed'): Promise<THREE.Group> {
  const bytes = Uint8Array.from(await readFile(`public/assets/rooms/${directory}/hall.glb`));
  const scene = (await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene;
  scene.traverse((node) => {
    if (
      node instanceof THREE.Mesh &&
      node.material instanceof THREE.MeshStandardMaterial &&
      node.material.name === 'hall_stone-floor'
    )
      node.material.lightMap = new THREE.Texture();
  });
  return scene;
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
  const window = room.getObjectByName('window-bay-0');
  const tile = room.getObjectByName('window-cache-tile');
  if (!cache || !window || !(tile instanceof THREE.Mesh))
    throw new Error('Missing the MAPTEST2 cache scene');
  expect(window.userData.windowBay.exposed).toBe(true);
  expect(
    window.children.some(
      (node) => node instanceof THREE.Mesh && node.material.name.includes('stained-glass'),
    ),
  ).toBe(true);
  expect(room.getObjectByName('window-colored-light')).toBeUndefined();
  expect(room.getObjectByName('window-key-projection')).toBeUndefined();
  let floor: THREE.MeshStandardMaterial | undefined;
  room.traverse((node) => {
    if (node instanceof THREE.Mesh && node.material.name === 'hall_stone-floor')
      floor = node.material;
  });
  expect(floor?.customProgramCacheKey()).toContain('lancetKey(2.6000, -5.0000)');
  expect(tile.material.lightMap).toBe(floor?.lightMap);
  expect(tile.geometry.getAttribute('uv1').array.some((coordinate: number) => coordinate > 0)).toBe(
    true,
  );
  const { x, z } = window.userData.windowBay;
  const travel = cache.object.position.z - z;
  expect(travel).toBeGreaterThan(3.3);
  expect(cache.object.position.x - x).toBeCloseTo(travel * (0.12 / 0.75));

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
    for (const y of [1.52, 2.4, 3.36]) {
      ray.set(new THREE.Vector3(x, y, -4.7), new THREE.Vector3(0, 0, -1));
      const hit = ray.intersectObject(closed, true)[0];
      expect(hit?.distance).toBeCloseTo(0.3, 3);
      const surface = hit?.object;
      if (!(surface instanceof THREE.Mesh) || Array.isArray(surface.material))
        throw Error('The closed bay must have a continuous wallpaper surface');
      expect(surface.material.name).toBe('hall_wallpaper');
    }
  }
  open.updateWorldMatrix(true, true);
  const northFriezeAt = (model: THREE.Group, x: number): string | undefined => {
    ray.set(new THREE.Vector3(x, 3.55, -4.55), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObject(model, true)[0]?.object;
    return hit instanceof THREE.Mesh && !Array.isArray(hit.material)
      ? hit.material.name
      : undefined;
  };
  for (const x of [1.86, 2.2, 2.6, 3, 3.34]) expect(northFriezeAt(closed, x)).toBe('hall_walnut');
  for (const x of [-4.3, -3.55, -2.8]) {
    const openChimney = northFriezeAt(open, x);
    expect(openChimney).not.toBe('hall_walnut');
    expect(northFriezeAt(closed, x)).toBe(openChimney);
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
  expect(view.world.roomGroups[12].getObjectByName('window-cache-tile')).toBeDefined();
  view.dispose();
});
