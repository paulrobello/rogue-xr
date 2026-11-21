import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { FloorPlan, PlacedRoom } from '../src/floor/generate.ts';
import { dressWindowBays, exposedWindowBays } from '../src/world/window-bays.ts';

function room(
  index: number,
  templateId: string,
  position: [number, number],
  turns: 0 | 1 | 2 | 3 = 0,
): PlacedRoom {
  return {
    index,
    templateId,
    position,
    turns,
    role: 'combat',
    wing: 0,
    depth: 0,
    encounter: null,
    loot: [],
  };
}
function plan(rooms: PlacedRoom[]): FloorPlan {
  return { seed: 'test', rooms, connections: [], sealed: [], guardianRoom: 0 };
}

describe('window bays', () => {
  it('blocks partial shared wall overlaps without a doorway, including rotated rooms', () => {
    const north = plan([room(0, 'hall', [0, 0]), room(1, 'corridor', [3, -9])]);
    expect(exposedWindowBays(north, 1)).toEqual([]);
    const east = plan([room(0, 'hall', [0, 0], 1), room(1, 'corridor', [9, 3], 1)]);
    expect(exposedWindowBays(east, 1)).toEqual([]);
    const beside = plan([room(0, 'hall', [0, 0]), room(1, 'corridor', [-3, -9])]);
    expect(exposedWindowBays(beside, 1)).toEqual([{ room: 0, x: 2.6, z: -5 }]);
  });
  it('extracts the original glazing per instance and releases its owned geometry', () => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([2.3, 1.5, -4.99, 2.9, 1.5, -4.99, 2.6, 2.5, -4.99], 3),
    );
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2));
    const material = new THREE.MeshStandardMaterial();
    material.name = 'hall_stained-glass';
    const source = new THREE.Mesh(geometry, material);
    const model = new THREE.Group();
    model.add(source);
    const exposed = plan([room(0, 'hall', [0, 0])]);
    const cleanup = dressWindowBays(model, exposed, 0, 1);
    const part = model.getObjectByName('window-bay-0')?.children[0] as THREE.Mesh;
    expect(part.material).toBe(material);
    expect(part.geometry.getAttribute('uv')).toBeDefined();
    expect(part.geometry.index?.count).toBe(3);
    expect(source.geometry.index?.count).toBe(0);
    cleanup();
    expect(source.geometry).toBe(geometry);
    expect(model.getObjectByName('window-bay-0')).toBeUndefined();
    const closed = plan([room(0, 'hall', [0, 0]), room(1, 'corridor', [3, -9])]);
    const closeCleanup = dressWindowBays(model, closed, 0, 1);
    expect(model.getObjectByName('shared-window-wall')).toBeDefined();
    expect(source.geometry.index?.count).toBe(0);
    closeCleanup();
    expect(source.geometry).toBe(geometry);
  });
});
