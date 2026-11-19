// @vitest-environment node

import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { generateFloor } from '../src/floor/generate.ts';
import { BookSecret } from '../src/world/book-secret.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import {
  bindBookcaseAtlas,
  InteriorFurnishings,
  type InteriorFurnishingsAsset,
} from '../src/world/interior-furnishings.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

const ROOTS = [
  'DoorSingle',
  'DoorDouble',
  'DoorArched',
  'Curtain',
  'DiningChair',
  'DiningTable',
  'Bookcase',
  'Candelabrum',
  'WallClock',
  'ClockworkArmor',
  'FramedPainting',
] as const;

async function realAsset(): Promise<InteriorFurnishingsAsset> {
  const bytes = await readFile('public/assets/props/interior-furnishings/interior-furnishings.glb');
  const start = bytes.byteOffset;
  const end = start + bytes.byteLength;
  const gltf = await nodeGeometryLoader().parseAsync(bytes.buffer.slice(start, end), '');
  const roots = {} as Record<(typeof ROOTS)[number], THREE.Object3D>;
  for (const name of ROOTS) roots[name] = gltf.scene.getObjectByName(name) as THREE.Object3D;
  return { scene: gltf.scene, roots };
}

describe('book secret view geometry', () => {
  it('keeps the first clue visible to both eyes, then changes on a later unseen frame', async () => {
    const world = buildFloorWorld(generateFloor('MAPTEST2'));
    const furnishings = new InteriorFurnishings(world, await realAsset(), {
      paintings: Array.from({ length: 5 }, () => new THREE.Texture()),
    });
    const clue = furnishings.placements.find(
      (p) => p.root === 'FramedPainting' && p.object.userData.paintingIndex === 0,
    );
    expect(clue).toBeDefined();
    if (!clue) return;
    const center = clue.object.getWorldPosition(new THREE.Vector3());
    const eye = new THREE.PerspectiveCamera(70, 1, 0.01, 20);
    eye.position.copy(center).add(new THREE.Vector3(0, 0, 2));
    eye.lookAt(center);
    eye.updateMatrixWorld(true);
    const secondEye = eye.clone();
    secondEye.position.x += 0.064;
    secondEye.lookAt(center);
    secondEye.updateMatrixWorld(true);
    furnishings.update(0, false, [eye, secondEye]);
    world.current = clue.room;
    furnishings.update(0, false, [eye, secondEye]);
    world.current = clue.room === 0 ? 1 : 0;
    furnishings.update(0, false, [eye, secondEye]);
    world.current = clue.room;
    furnishings.update(0, false, [eye, secondEye]);
    expect(clue.object.userData.paintingIndex).toBe(0);
    // The central ray can miss while a small part of the picture is still in one eye.
    const rightEdge = new THREE.Box3().setFromObject(clue.object).max.x;
    secondEye.position.set(rightEdge + 1.38, center.y, center.z + 2);
    secondEye.lookAt(rightEdge + 1.38, center.y, center.z);
    secondEye.updateMatrixWorld(true);
    eye.lookAt(eye.position.clone().add(new THREE.Vector3(0, 0, 1)));
    eye.updateMatrixWorld(true);
    furnishings.update(0, false, [eye, secondEye]);
    expect(clue.object.userData.paintingIndex).toBe(0);
    secondEye.lookAt(secondEye.position.clone().add(new THREE.Vector3(0, 0, 1)));
    secondEye.updateMatrixWorld(true);
    furnishings.update(0, false, [eye, secondEye]);
    expect(clue.object.userData.paintingIndex).toBe(1);
    furnishings.dispose();
    world.dispose();
  });

  it('keeps the fitted cabinet locked, then opens and claims its cogs', async () => {
    const asset = await realAsset();
    const texture = new THREE.Texture();
    bindBookcaseAtlas(asset, texture);
    for (const parent of [
      asset.roots.Bookcase,
      asset.roots.Bookcase.getObjectByName('Bookcase_PullBook'),
    ]) {
      const surfaces =
        parent?.children.filter(
          (node): node is THREE.Mesh =>
            node instanceof THREE.Mesh && node.material.name === 'LibraryBindingAtlas',
        ) ?? [];
      expect(surfaces.length).toBe(1);
      const material = surfaces[0].material;
      if (!(material instanceof THREE.MeshStandardMaterial)) throw Error('Missing book material');
      expect(material.map).toBe(texture);
      expect(surfaces[0].geometry.getAttribute('uv')).toBeDefined();
    }
    const world = buildFloorWorld(generateFloor('MAPTEST2'));
    const furnishings = new InteriorFurnishings(world, asset);
    const placement = furnishings.placements.find(
      (entry) =>
        entry.root === 'Bookcase' &&
        entry.object.getObjectByName('Bookcase_PullBook')?.userData.bookSecret,
    );
    expect(placement).toBeDefined();
    if (!placement) throw Error('Missing marked case');
    const marked = placement.object.getObjectByName('Bookcase_PullBook') as THREE.Object3D;
    const secret = new BookSecret(world, furnishings);
    (world as unknown as { current: number }).current = placement?.room ?? 0;
    world.group.updateMatrixWorld(true);
    const center = marked.getWorldPosition(new THREE.Vector3());
    const front = new THREE.Vector3(0, 0, 1).transformDirection(placement.object.matrixWorld);
    expect(
      secret.pick(center.clone().addScaledVector(front, 1.2), front.clone().negate())?.object,
    ).toBe(marked);
    expect(secret.near(center, 0.05)?.object).toBe(marked);
    expect(secret.pick(center.clone().addScaledVector(front, -0.7), front)).toBeNull();
    const panel = placement.object.getObjectByName('Bookcase_Slider');
    if (!panel) throw Error('Missing secret door');
    const before = panel.matrix.clone();
    expect(
      secret.pick(center.clone().addScaledVector(front, 1.2), front.clone().negate())?.kind,
    ).toBe('book');
    secret.setStage(placement.room, 'key');
    secret.update(0.4);
    panel.updateMatrix();
    expect(panel.matrix.equals(before)).toBe(true);

    const cabinetProbe = new THREE.Vector3(0, 0.31, 0.044);
    panel.localToWorld(cabinetProbe);
    expect(secret.near(cabinetProbe, 0.2)?.kind).toBe('cabinet');
    expect(secret.pick(cabinetProbe.clone().addScaledVector(front, -0.7), front)).toBeNull();
    expect(
      secret.pick(cabinetProbe.clone().addScaledVector(front, 1), front.clone().negate())?.kind,
    ).toBe('cabinet');
    const during = panel.matrix.clone();
    secret.setStage(placement.room, 'unlock');
    secret.update(0.2);
    panel.updateMatrix();
    expect(panel.matrix.equals(during)).toBe(false);
    expect(
      secret.pick(center.clone().addScaledVector(front, 1.2), front.clone().negate()),
    ).toBeNull();
    secret.update(0.3);
    world.group.updateMatrixWorld(true);
    const cogProbe = new THREE.Vector3(0, 0.16, 0.115);
    placement.object.localToWorld(cogProbe);
    const cogs = secret.near(cogProbe, 0.4);
    expect(cogs?.kind).toBe('cog');
    expect(
      secret.pick(cogProbe.clone().addScaledVector(front, 1), front.clone().negate())?.kind,
    ).toBe('cog');
    const coins = placement.object.getObjectByName('book-secret-cogs');
    if (!coins) throw Error('Expected collectible inside cabinet');
    const start = coins.position.clone();
    const flightTarget = new THREE.Object3D();
    flightTarget.position.copy(cogProbe).addScaledVector(front, 1.5);
    secret.setStage(placement.room, 'cogs');
    secret.update(0.28, flightTarget);
    expect(coins.position.distanceTo(start)).toBeGreaterThan(0.08);
    expect(coins.scale.x).toBeLessThan(1);
    secret.update(1, flightTarget);
    expect(coins.parent).toBeNull();
    expect(secret.near(cogProbe, 0.4)).toBeNull();
    secret.dispose();
    texture.dispose();
    furnishings.dispose();
    world.dispose();
  });

  it.each([
    { run: { bookSecretKeyRooms: [0] }, open: false, coins: false },
    { run: { bookSecretKeyRooms: [0], bookSecretCabinetRooms: [0] }, open: true, coins: true },
    { run: { bookSecretOpenedRooms: [0] }, open: true, coins: false },
  ])('restores $run before the furnishing asset arrives', async ({ run, open, coins }) => {
    const world = buildFloorWorld(generateFloor('N0TE0032'));
    const secret = new BookSecret(world, null);
    secret.restore(run);
    const furnishings = new InteriorFurnishings(world, await realAsset(), {
      preservedBookRooms: [0],
    });
    secret.mount(furnishings);
    const shelf = furnishings.placements.find((p) => p.root === 'Bookcase' && p.room === 0)?.object;
    expect(shelf?.getObjectByName('Bookcase_PullBook')?.userData.bookSecretOpened).toBe(true);
    expect(shelf?.getObjectByName('Bookcase_Slider')?.rotation.x).toBeCloseTo(
      open ? Math.PI / 2 : 0,
    );
    expect(Boolean(shelf?.getObjectByName('book-secret-cogs'))).toBe(coins);
    expect(shelf?.getObjectByName('clockmakers-key')).toBeUndefined();
    secret.dispose();
    furnishings.dispose();
    world.dispose();
  });
});
