// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

const SOCKETS = ['socket-hit', 'socket-eye', 'socket-weapon'] as const;

it.each([
  { id: 'mortar-scarab', stature: [0.55, 0.64], feet: 6 },
  { id: 'lantern-bailiff', stature: [1.6, 1.75], feet: 2 },
])(
  'reimports the $id neutral draft with each foot planted and all socket markers',
  async ({ id, stature, feet }) => {
    const bytes = Uint8Array.from(
      await readFile(`assets-source/enemies/${id}/staging/base/${id}-base.glb`),
    );
    const { scene, animations } = await nodeGeometryLoader().parseAsync(bytes.buffer, '');
    const bounds = new THREE.Box3().setFromObject(scene, true);
    expect(animations).toHaveLength(0);
    expect(Math.abs(bounds.min.y)).toBeLessThanOrEqual(0.002);
    expect(bounds.max.y).toBeGreaterThanOrEqual(stature[0]);
    expect(bounds.max.y).toBeLessThanOrEqual(stature[1]);
    const contacts = new Set<string>();
    scene.traverse((object) => {
      expect(object).not.toBeInstanceOf(THREE.SkinnedMesh);
      if (!/^leg-(left|right)(-\d)?-foot$/.test(object.name)) return;
      const sole = new THREE.Box3().setFromObject(object, true);
      expect(Math.abs(sole.min.y), object.name).toBeLessThanOrEqual(0.002);
      contacts.add(`${sole.min.x.toFixed(3)}:${sole.min.z.toFixed(3)}`);
    });
    expect(contacts.size).toBe(feet);
    for (const name of SOCKETS) {
      const socket = scene.getObjectByName(name);
      if (!socket) throw new Error(`missing socket ${name}`);
      const position = socket.getWorldPosition(new THREE.Vector3());
      expect(position.toArray().every(Number.isFinite)).toBe(true);
      expect(position.y).toBeGreaterThan(0);
      if (id === 'lantern-bailiff') {
        expect(socket.parent?.name).toBe(
          name === 'socket-weapon' ? 'outer-lantern-root' : 'torso-root',
        );
      }
    }
  },
);
