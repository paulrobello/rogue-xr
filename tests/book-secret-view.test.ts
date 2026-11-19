// @vitest-environment node

import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { generateFloor } from '../src/floor/generate.ts';
import { BookSecret } from '../src/world/book-secret.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import {
  bindBookcaseAtlas,
  InteriorFurnishings,
  type InteriorFurnishingsAsset,
} from '../src/world/interior-furnishings.ts';

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
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(start, end), '');
  const roots = {} as Record<(typeof ROOTS)[number], THREE.Object3D>;
  for (const name of ROOTS) roots[name] = gltf.scene.getObjectByName(name) as THREE.Object3D;
  return { scene: gltf.scene, roots };
}

describe('book secret view geometry', () => {
  it('loads the real marked book and resolves a front ray while rejecting a side ray', async () => {
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
    const world = buildFloorWorld(generateFloor('N0TE0032'));
    const furnishings = new InteriorFurnishings(world, asset);
    const placement = furnishings.placements.find(
      (entry) => entry.root === 'Bookcase' && entry.object.getObjectByName('Bookcase_PullBook'),
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
    secret.update(1);
    panel.updateMatrix();
    expect(panel.matrix.equals(before)).toBe(true);
    secret.dispose();
    texture.dispose();
    furnishings.dispose();
    world.dispose();
  });
});
