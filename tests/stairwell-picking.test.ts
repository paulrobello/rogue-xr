// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { beforeAll, expect, it } from 'vitest';
import { Stairwell } from '../src/world/stairwell.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

const entry = {
  room: 0,
  door: 'e',
  world: [6, -2],
  facing: [1, 0],
  approach: [5.2, -2],
  alcove: { min: [6, -3.5], max: [11, -0.5] },
} as const;
let scene: THREE.Group;
beforeAll(async () => {
  const bytes = await readFile('public/assets/props/stairwell/stairwell.glb');
  scene = (
    await nodeGeometryLoader().parseAsync(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      '',
    )
  ).scene;
});
it.each([1, 2] as const)(
  'picks the physical handle and swings it with the door to Floor %s',
  (destination) => {
    const model = scene.getObjectByName(destination === 2 ? 'StairUp' : 'StairDown');
    if (!model) throw Error('Missing staircase');
    const stair = new Stairwell(entry, destination, { roomGroups: [new THREE.Group()] }, model);
    const rise = destination === 2 ? 1.62 : -1.62;
    const pick = (from: number[], to: number[], room = 0) => {
      const origin = stair.root.localToWorld(new THREE.Vector3(...from));
      const dir = stair.root
        .localToWorld(new THREE.Vector3(...to))
        .sub(origin)
        .normalize();
      return stair.pick(room, origin, dir);
    };
    const handle = [0.44, rise + 0.88, 4.775];
    expect(pick([0.18, 1.24, 0.5], [0, rise / 9, 1.1])).toBeNull();
    expect(pick([0.2, rise + 1.15, 4.05], [0, rise + 1.25, 4.76])).toBeNull();
    expect(pick([0.2, rise + 1.15, 4.05], handle)).not.toBeNull();
    expect(pick(handle, [0.44, rise + 0.88, 5.5])?.distance).toBe(0);
    expect(pick([0.44, rise + 0.88, 4.94], handle)).toBeNull();
    expect(pick([2, 1.3, 2], handle)).toBeNull();
    expect(pick([1.7, 1.3, -1], handle)).toBeNull();
    expect(pick([0, 1.3, -1], handle, 1)).toBeNull();
    const closed = stair.handle.getWorldPosition(new THREE.Vector3());
    stair.open(1);
    for (const side of [-0.35, 0.35]) {
      const from = stair.root.localToWorld(new THREE.Vector3(side, rise + 1.32, 3.7));
      for (const y of [0.08, 0.65, 1.8]) {
        const through = stair.root.localToWorld(new THREE.Vector3(0.35, rise + y, 4.79));
        const ray = new THREE.Raycaster(from, through.sub(from).normalize());
        stair.root.updateWorldMatrix(true, true);
        const contact = ray.intersectObject(stair.root)[0];
        const firstHit = contact?.object;
        expect(firstHit).toBeInstanceOf(THREE.Mesh);
        const material = (firstHit as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material;
        if (y === 0.08) {
          expect(material.name).toBe('Stairwell walnut');
          expect(stair.root.worldToLocal(contact.point.clone()).y).toBeCloseTo(rise, 3);
        } else {
          expect(material).toBeInstanceOf(THREE.MeshBasicMaterial);
          expect((material as THREE.MeshBasicMaterial).color.getHex()).toBe(0);
        }
      }
    }
    const opened = stair.root.worldToLocal(stair.handle.getWorldPosition(new THREE.Vector3()));
    expect(opened.z).toBeGreaterThan(5.7);
    expect(stair.hinge.rotation.y).toBeCloseTo((-Math.PI * 75) / 180);
    stair.open(0);
    expect(stair.handle.getWorldPosition(new THREE.Vector3()).distanceTo(closed)).toBeLessThan(
      0.001,
    );
    stair.dispose();
  },
);

it.each(['StairUp', 'StairDown'])('keeps the black liner behind the wooden faces of %s', (name) => {
  const flight = scene.getObjectByName(name);
  if (!flight) throw Error('missing staircase');
  flight.updateWorldMatrix(true, true);
  const floor = name === 'StairUp' ? 1.62 : -1.62;
  for (const [x, h] of [
    [-0.615, 1],
    [0.615, 1],
    [0, 2.158],
  ]) {
    const target = new THREE.Vector3(x, floor + h, 4.75);
    for (const dx of [-0.4, 0, 0.4]) {
      const eye = target.clone().add(new THREE.Vector3(dx, 0, -1));
      const direction = target.clone().sub(eye).normalize();
      const hits = new THREE.Raycaster(eye, direction).intersectObject(flight);
      const face = hits[0];
      expect(face?.point.z).toBeCloseTo(4.75, 2);
      // Coplanar wood and black can return in either order from the renderer.
      const atFace = hits.filter((hit) => hit.distance - face.distance < 0.004);
      for (const hit of atFace) {
        expect((hit.object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material.name).toBe(
          'Stairwell walnut',
        );
      }
    }
  }
});

it.each(['StairUp', 'StairDown'])(
  'continues the walnut floor under the closed leaf on %s',
  (name) => {
    const model = scene.getObjectByName(name);
    if (!model) throw Error('missing staircase');
    const level = name === 'StairUp' ? 1.62 : -1.62;
    model.updateWorldMatrix(true, true);
    for (const x of [-0.3, 0, 0.3])
      for (const z of [4.74, 4.76, 4.81, 4.92, 4.93, 5.0]) {
        // Exclude the leaf itself to inspect the surface as it swings clear.
        const shell = model.children.filter((o) => !o.name.endsWith('_DoorPivot'));
        const hit = new THREE.Raycaster(
          new THREE.Vector3(x, level + 0.06, z),
          new THREE.Vector3(0, -1, 0),
        ).intersectObjects(shell, true)[0];
        expect(hit?.point.y).toBeCloseTo(level, 2);
        expect((hit.object as THREE.Mesh<THREE.BufferGeometry, THREE.Material>).material.name).toBe(
          z < 4.935 ? 'Stairwell walnut' : 'Stairwell dark recess',
        );
      }
  },
);
