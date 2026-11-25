// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { gasketFor } from '../src/rules/valvehouse.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { stoneRoomKitFromScene } from '../src/world/stone-rooms.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

it('mounts the keyed gasket, pressure controls and chamber independently and only clears a fully lowered gate', async () => {
  const seed = 'MAPTEST2';
  const view = mountFloorView(new THREE.Scene(), new THREE.Group(), seed);
  const spec = view.world.plan.valvehouse;
  if (!spec) throw new Error('Missing Valvehouse layout');
  const bytes = Uint8Array.from(
    await readFile('public/assets/props/stone-dungeon-kit/stone-dungeon-kit.glb'),
  );
  const kit = stoneRoomKitFromScene(
    (await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene,
  );
  const room = view.world.plan.rooms[spec.valvehouseRoom];
  view.useRoomAsset(room.templateId, () => new THREE.Group(), [], undefined, undefined, kit);
  view.dressValvehouse(seed, false);
  view.dressStoneFurnishings(kit);
  const station = view.valvehouse;
  if (!station) throw new Error('Missing Valvehouse fixtures');

  const node = (name: string) => {
    const found = view.world.group.getObjectByName(name);
    if (!found) throw new Error(`Missing scene object ${name}`);
    return found;
  };
  const pick = (
    root: THREE.Group,
    name: string,
    offset: readonly [number, number, number] = [0, 0, 0],
  ) => {
    const eye = root.localToWorld(new THREE.Vector3(0, 1.31, 1.45));
    const aim = node(name).localToWorld(new THREE.Vector3(...offset));
    return station.pick(eye, aim.sub(eye).normalize())?.action;
  };

  expect(station.controls.parent).toBe(view.world.roomGroups[spec.source.room]);
  expect(station.supply.parent).toBe(view.world.roomGroups[spec.supplyRoom]);
  expect(station.chamber.parent).toBe(view.world.roomGroups[spec.valvehouseRoom]);
  expect(view.stoneRooms.get(spec.valvehouseRoom)).toBe('valvehouse');
  for (const name of ['StoneShelf', 'StoneDishes', 'StonePlanter', 'StoneTorch'])
    expect(station.chamber.parent?.getObjectByName(name)).toBeDefined();

  const held = node('valvehouse-gasket');
  const seated = node('valvehouse-seated-gasket');
  expect(held.userData.profile).toBe(gasketFor(seed));
  expect(seated.userData.profile).toBe(held.userData.profile);
  expect(held.visible).toBe(true);
  expect(seated.visible).toBe(false);
  view.world.current = spec.supplyRoom;
  expect(pick(station.supply, held.name)).toBe('collect');
  expect(station.near(held.getWorldPosition(new THREE.Vector3()), 0.1)?.action).toBe('collect');

  view.world.current = spec.source.room;
  const leaf = node('valvehouse-grille');
  const plume = node('valvehouse-leak-plume');
  const needle = node('valvehouse-gauge-needle');
  expect(pick(station.controls, 'valvehouse-test-lever', [0, 0.16, 0.08])).toBe('test');
  station.vent();
  station.update(0.12);
  expect(plume.visible).toBe(true);
  expect(needle.rotation.z).toBeGreaterThan(0);
  const blocked = view.world.colliders[spec.source.room].length;
  expect(leaf.position.y).toBe(0);
  station.sync('held');
  expect(held.visible).toBe(false);
  expect(pick(station.controls, 'valvehouse-joint')).toBe('seat');
  station.sync('seated');
  station.update(0.1);
  expect(seated.visible).toBe(true);
  expect(station.leaking).toBe(false);
  expect(plume.visible).toBe(false);
  station.sync('open');
  station.update(0.6);
  expect(leaf.visible).toBe(true);
  expect(leaf.position.y).toBeLessThan(-1);
  expect(view.world.colliders[spec.source.room]).toHaveLength(blocked);
  station.update(0.6);
  expect(leaf.visible).toBe(false);
  expect(needle.rotation.z).toBeCloseTo(-0.76);
  expect(view.world.colliders[spec.source.room]).toHaveLength(blocked - 1);
  view.dispose();
});
