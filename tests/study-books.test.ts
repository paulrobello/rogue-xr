// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { expect, it } from 'vitest';
import { studyBookGeometry } from '../src/world/study-books.ts';

it('gives the baked study individual lit page tops, covers and spines within its book rows', async () => {
  const base = new URL('../public/assets/rooms/study/', import.meta.url);
  const data = Uint8Array.from(readFileSync(new URL('study.glb', base)));
  const { scene } = await new GLTFLoader().parseAsync(data.buffer, '');
  const proxy = scene
    .getObjectsByProperty('isMesh', true)
    .find((node) => ((node as THREE.Mesh).material as THREE.Material).name === 'study_books');
  expect(proxy).toBeDefined();
  const original = (proxy as THREE.Mesh).geometry;
  const geometry = studyBookGeometry(original);
  original.computeBoundingBox();
  geometry.computeBoundingBox();
  if (!original.boundingBox || !geometry.boundingBox) throw Error('Missing book bounds');
  expect(original.boundingBox.expandByScalar(0.005).containsBox(geometry.boundingBox)).toBe(true);
  const normals = geometry.getAttribute('normal');
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const light = geometry.getAttribute('uv1');
  const topHeights = new Set<number>();
  const atlasRows = new Set<number>();
  for (let i = 0; i < normals.count; i++) {
    const tile = Math.floor(uv.getY(i) * 4);
    atlasRows.add(tile);
    if (normals.getY(i) > 0.99) {
      if (tile !== 3) throw Error('An upward-facing page block is sampling a spine or cover');
      topHeights.add(Math.round(pos.getY(i) * 1000));
    }
    for (const value of [light.getX(i), light.getY(i)]) {
      if (!(value >= 0 && value <= 1)) throw Error('Book outside its room lightmap');
    }
  }
  expect(atlasRows).toEqual(new Set([0, 1, 2, 3]));
  expect(topHeights.size).toBeGreaterThan(200);
  expect((geometry.index?.count ?? 0) / 3).toBeLessThan(12_000);
  const atlas = readFileSync(new URL('../../props/study-books/book-bindings.ktx2', base));
  expect([atlas.readUInt32LE(20), atlas.readUInt32LE(24), atlas.readUInt32LE(40)]).toEqual([
    1024, 1024, 11,
  ]);
});

it('ships the binding atlas and shelf irradiance derived from the current study bake', () => {
  const root = new URL('../', import.meta.url);
  const { files } = JSON.parse(
    readFileSync(new URL('assets-source/props/study-books/provenance.json', root), 'utf8'),
  ) as { files: Record<string, string> };
  for (const [path, hash] of Object.entries(files)) {
    expect(
      createHash('sha256')
        .update(readFileSync(new URL(path, root)))
        .digest('hex'),
      path,
    ).toBe(hash);
  }
  const light = readFileSync(new URL('public/assets/props/study-books/book-irradiance.ktx2', root));
  expect([light.readUInt32LE(20), light.readUInt32LE(24), light.readUInt32LE(40)]).toEqual([
    512, 512, 10,
  ]);
});
