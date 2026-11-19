// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { expect, it } from 'vitest';
import { closePumpRoomWindow } from '../src/world/pump-room-wall.ts';

it('replaces the pump lancet and projecting trim with continuous wallpaper while the adjacent study keeps its window', async () => {
  const bytes = await readFile('public/assets/rooms/study/study.glb');
  const study = (
    await new GLTFLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      '',
    )
  ).scene;
  const pump = study.clone(true);
  const owned = closePumpRoomWindow(pump);
  function materialHit(root: THREE.Object3D, x: number, y: number): THREE.Intersection {
    const wall: THREE.Mesh[] = [];
    root.traverseVisible((n) => {
      if (n instanceof THREE.Mesh) wall.push(n);
    });
    return new THREE.Raycaster(
      new THREE.Vector3(x, y, -3.5),
      new THREE.Vector3(0, 0, -1),
    ).intersectObjects(wall, false)[0];
  }
  expect(
    (materialHit(study, 0, 2.4).object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material
      .name,
  ).toBe('study_stained-glass');
  const points = [
    [-0.66, 2.4],
    [0, 1.36],
    [0, 2.4],
    [0.64, 3.55],
    [0.85, 2.7],
    [2, 3.8],
  ];
  for (const [x, y] of points) {
    const hit = materialHit(pump, x, y);
    expect((hit.object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material.name).toBe(
      'study_wallpaper',
    );
    expect(hit.point.z).toBeCloseTo(-4, 5);
    expect(hit.uv?.x).toBeCloseTo(x / 0.75, 4);
    expect(hit.uv?.y).toBeCloseTo(1 + y / 0.75, 4);
  }
  expect(owned.length).toBeGreaterThan(0);
  for (const g of owned) g.dispose();
});
