// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DUNGEON_CONTENT_VERSION } from '../src/combat/encounter-choice.ts';
import { stoneRoomsFor } from '../src/floor/stone-rooms.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { mountFloorView, playableFloorPlan } from '../src/world/floor-view.ts';
import { lightRoomStyle } from '../src/world/room-style-lighting.ts';
import { stoneRoomKitFromScene } from '../src/world/stone-rooms.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

const seed = 'MAPTEST2';
const current = DUNGEON_CONTENT_VERSION;
const previous = current - 1;
const file = 'public/assets/props/stone-dungeon-kit/stone-dungeon-kit.glb';

async function loadKit() {
  const bytes = Uint8Array.from(await readFile(file));
  return stoneRoomKitFromScene((await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene);
}

it('selects the two stone looks only for new content without altering the room routes', () => {
  for (const floor of [2, 3] as const) {
    const levelSeed = floorSeedFor(seed, floor);
    const oldPlan = playableFloorPlan(levelSeed, previous, floor);
    const newPlan = playableFloorPlan(levelSeed, current, floor);
    expect(newPlan).toEqual(oldPlan);
    const legacy = mountFloorView(new THREE.Scene(), new THREE.Group(), levelSeed, {
      floorNumber: floor,
      contentVersion: previous,
    });
    expect(legacy.stoneRooms.size).toBe(0);
    legacy.dispose();
    const looks = stoneRoomsFor(newPlan, floor);
    if (floor === 2) expect(looks.get(newPlan.dispatchRoom?.vaultRoom ?? -1)).toBe('dungeon');
    else expect(looks.get(newPlan.prismAnnex?.annexRoom ?? -1)).toBe('cloister');
  }
});

describe('the authored stone kit', () => {
  it('keeps the 1.6 by 2.4 m doorway clear below its arch', async () => {
    const kit = await loadKit();
    kit.StoneDoor.updateWorldMatrix(true, true);
    const ray = new THREE.Raycaster();
    for (const x of [-0.77, 0, 0.77]) {
      for (const y of [0.05, 1.2, 2.36]) {
        ray.set(new THREE.Vector3(x, y, 1), new THREE.Vector3(0, 0, -1));
        expect(ray.intersectObject(kit.StoneDoor, true)).toHaveLength(0);
      }
    }
    for (const x of [0.35, 0.5, 0.6]) {
      for (const height of [3.163, 3.17, 3.177]) {
        ray.set(new THREE.Vector3(x, height, 1), new THREE.Vector3(0, 0, -1));
        expect(ray.intersectObject(kit.StoneDoor, true).length).toBeGreaterThan(0);
      }
    }
    expect(new THREE.Box3().setFromObject(kit.StoneFloor).max.y).toBeCloseTo(0, 3);
  });

  it('assembles each look with a real skylight opening and modular furnishings in actual floor geometry', async () => {
    const kit = await loadKit();
    for (const floor of [2, 3] as const) {
      const view = mountFloorView(new THREE.Scene(), new THREE.Group(), floorSeedFor(seed, floor), {
        floorNumber: floor,
        contentVersion: current,
      });
      const layout = view.world.plan;
      const roomId = floor === 2 ? layout.dispatchRoom?.vaultRoom : layout.prismAnnex?.annexRoom;
      if (roomId === undefined) throw Error('Missing stone room');
      view.useRoomAsset('hall', () => new THREE.Group(), [], undefined, undefined, kit);
      view.dressStoneFurnishings(kit);
      const model = view.styledRooms.find((room) => room.userData.room === roomId);
      if (!model) throw Error('Missing authored stone finish');
      expect(model.getObjectByName('StoneShelf')?.getObjectByName('StoneDishes')).toBeTruthy();
      expect(model.getObjectByName('StoneShelf')?.getObjectByName('StonePlanter')).toBeTruthy();
      expect(view.stoneTorches.get(roomId)?.name).toBe('SocketTorchLight');
      expect(Boolean(model.getObjectByName('StoneSkylightDaylight'))).toBe(floor === 3);
      let triangles = 0;
      model.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        const indices = node.geometry.index?.count ?? node.geometry.getAttribute('position').count;
        triangles += (indices / 3) * (node instanceof THREE.InstancedMesh ? node.count : 1);
      });
      expect(triangles).toBeLessThanOrEqual(100_000);
      lightRoomStyle(model, []);
      expect(model.userData.finishLightMap).toBeInstanceOf(THREE.DataTexture);
      view.dispose();
    }
  });
});
