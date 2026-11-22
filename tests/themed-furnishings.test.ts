// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  ENCOUNTER_CONTENT_VERSION,
  THEMED_FURNISHINGS_VERSION,
} from '../src/combat/encounter-choice.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { roomStyleKitFromScene } from '../src/world/room-styles.ts';
import { stoneRoomKitFromScene } from '../src/world/stone-rooms.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

async function loadScene(path: string): Promise<THREE.Group> {
  const bytes = Uint8Array.from(await readFile(path));
  return (await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene;
}

describe('non-stone modular furnishings', () => {
  it('exports the v34 gate and keeps the kit roots independent', async () => {
    expect(THEMED_FURNISHINGS_VERSION).toBe(34);
    expect(ENCOUNTER_CONTENT_VERSION).toBeGreaterThanOrEqual(THEMED_FURNISHINGS_VERSION);
    const kit = stoneRoomKitFromScene(
      await loadScene('public/assets/props/stone-dungeon-kit/stone-dungeon-kit.glb'),
    );
    expect(kit.StoneShelf.getObjectByName('SocketShelfDish')).toBeTruthy();
    expect(kit.StoneShelf.getObjectByName('SocketShelfPlant')).toBeTruthy();
    expect(kit.StoneTorch.getObjectByName('SocketTorchLight')).toBeTruthy();
    expect(kit.StoneShelf).not.toBe(kit.StoneTorch);
  });

  it('adds at most one themed shelf and wall light per styled room', async () => {
    const finishes = roomStyleKitFromScene(
      await loadScene('public/assets/props/architectural-finishes/architectural-finishes.glb'),
    );
    const kit = stoneRoomKitFromScene(
      await loadScene('public/assets/props/stone-dungeon-kit/stone-dungeon-kit.glb'),
    );
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), 'MAPTEST2', {
      floorNumber: 2,
      contentVersion: THEMED_FURNISHINGS_VERSION,
    });
    view.useRoomAsset('hall', () => new THREE.Group(), [], finishes);
    view.dressThemedFurnishings(kit);
    view.dressThemedFurnishings(kit);
    let shelfCount = 0;
    let lightCount = 0;
    for (const room of view.styledRooms) {
      shelfCount += room.children.filter((node) => node.name.startsWith('ThemedShelf-')).length;
      lightCount += room.children.filter((node) => node.name.startsWith('ThemedWallLight-')).length;
      expect(
        room.children.filter((node) => node.name.startsWith('ThemedShelf-')).length,
      ).toBeLessThanOrEqual(1);
      expect(
        room.children.filter((node) => node.name.startsWith('ThemedWallLight-')).length,
      ).toBeLessThanOrEqual(1);
    }
    expect(shelfCount).toBeGreaterThan(0);
    expect(lightCount).toBeGreaterThan(0);
    view.dispose();
  });

  it('dresses walnut, boiler and Conservatory rooms with separate sockets and usable clearance', async () => {
    const finishes = roomStyleKitFromScene(
      await loadScene('public/assets/props/architectural-finishes/architectural-finishes.glb'),
    );
    const kit = stoneRoomKitFromScene(
      await loadScene('public/assets/props/stone-dungeon-kit/stone-dungeon-kit.glb'),
    );
    const tones = new Set<number>();
    for (const [floorNumber, profile, dishes, pots] of [
      [1, 'walnut', 1, 1],
      [2, 'steel', 3, 0],
      [3, 'glazed', 1, 2],
    ] as const) {
      const view = mountFloorView(new THREE.Scene(), new THREE.Group(), 'MAPTEST2', {
        floorNumber,
        contentVersion: THEMED_FURNISHINGS_VERSION,
      });
      try {
        for (const template of ['hall', 'study'])
          view.useRoomAsset(template, () => new THREE.Group(), [], finishes);
        const prior = view.world.colliders.map((row) => [...row]);
        view.dressThemedFurnishings(kit);
        const shelves = view.world.roomGroups.flatMap((room, index) => {
          const shelf = room.getObjectByName(`ThemedShelf-${profile}`);
          return shelf ? [{ shelf, index }] : [];
        });
        expect(shelves.length).toBeGreaterThan(0);
        for (const { shelf, index } of shelves) {
          expect(shelf.getObjectsByProperty('name', 'ThemedDishes')).toHaveLength(dishes);
          expect(
            shelf.getObjectByName('SocketShelfDish')?.getObjectByName('ThemedDishes'),
          ).toBeDefined();
          const planters = shelf.getObjectsByProperty('name', 'ThemedPlanter');
          expect(planters).toHaveLength(pots);
          const batches = new Map<string, number>();
          shelf.traverse((node) => {
            if (node instanceof THREE.InstancedMesh && !Array.isArray(node.material))
              batches.set(node.material.name, node.count);
          });
          expect(batches.get(`themed-${profile}-dishes`)).toBe(dishes);
          expect(batches.get('Stone leaves') ?? 0).toBe(pots);
          expect(batches.get(`themed-${profile}-planter`) ?? 0).toBe(pots);
          const surface = shelf.getObjectByName('StoneShelf_Visual') as THREE.Mesh<
            THREE.BufferGeometry,
            THREE.MeshStandardMaterial
          >;
          expect(surface.material.name).toBe(`themed-${profile}-shelf`);
          tones.add(surface.material.color.getHex());
          const styled = view.styledRooms.some((room) => room.userData.room === index);
          expect(Boolean(shelf.getObjectByName('ThemedShelfContact'))).toBe(!styled);
          expect(view.world.colliders[index].length).toBe(prior[index].length + 1);
          const [collider] = view.world.colliders[index].slice(prior[index].length);
          const box = ({ min, max }: typeof collider) =>
            new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max));
          expect(collider.min[1]).toBeCloseTo(0, 2);
          expect(collider.max[1]).toBeLessThan(1.73);
          expect(prior[index].some((obstacle) => box(collider).intersectsBox(box(obstacle)))).toBe(
            false,
          );
        }
        const lights = view.world.roomGroups
          .map((room) => room.getObjectByName(`ThemedWallLight-${profile}`))
          .filter((light) => light !== undefined);
        for (const light of lights) {
          const flame = light.getObjectByName('StoneTorchFlame_Visual') as THREE.Mesh;
          expect((flame.material as THREE.Material).name).toBe('Stone flame');
        }
        if (floorNumber === 3)
          expect(view.world.roomGroups[0].getObjectByName('ThemedShelf-glazed')).toBeUndefined();
      } finally {
        view.dispose();
      }
    }
    expect(tones.size).toBe(3);
  });

  it('keeps the previous layout when continuing an older content version', async () => {
    const kit = stoneRoomKitFromScene(
      await loadScene('public/assets/props/stone-dungeon-kit/stone-dungeon-kit.glb'),
    );
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), 'MAPTEST2', {
      floorNumber: 1,
      contentVersion: THEMED_FURNISHINGS_VERSION - 1,
    });
    try {
      const prior = view.world.colliders.map((row) => row.length);
      view.dressThemedFurnishings(kit);
      expect(view.world.group.getObjectByName('ThemedShelf-walnut')).toBeUndefined();
      expect(view.world.colliders.map((row) => row.length)).toEqual(prior);
    } finally {
      view.dispose();
    }
  });
});
