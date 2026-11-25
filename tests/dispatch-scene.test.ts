// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { DISPATCH_ROOM_VERSION } from '../src/combat/encounter-choice.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { dispatchDestination } from '../src/rules/dispatch.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { mountFloorView, playableFloorPlan } from '../src/world/floor-view.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

const seed = 'MAPTEST2';
const floorSeed = floorSeedFor(seed, 2);

it('only adds the dispatch vault on new Upper Works layouts', () => {
  const legacy = playableFloorPlan(floorSeed, DISPATCH_ROOM_VERSION - 1, 2);
  const active = playableFloorPlan(floorSeed, DISPATCH_ROOM_VERSION, 2);
  expect(legacy.dispatchRoom).toBeUndefined();
  expect(active.dispatchRoom?.vaultRoom).toBe(legacy.rooms.length);
  expect(active.rooms.slice(0, legacy.rooms.length)).toEqual(legacy.rooms);
  expect(placeStairEntry(active)).toEqual(placeStairEntry(legacy));
});

it('mounts the original instruments and allows picking the reply only after dispatch', async () => {
  const bytes = Uint8Array.from(
    await readFile('public/assets/props/puzzle-instruments/puzzle-instruments.glb'),
  );
  const { scene } = await nodeGeometryLoader().parseAsync(bytes.buffer, '');
  const authoredCapsule = scene.getObjectByName('carrier_capsule');
  if (!authoredCapsule) throw Error('Missing carrier capsule in puzzle instruments');
  const orientedCapsule = authoredCapsule.clone(true);
  orientedCapsule.rotation.x = Math.PI / 2;
  orientedCapsule.scale.setScalar(0.72);
  orientedCapsule.updateMatrixWorld(true);
  const orientedBounds = new THREE.Box3().setFromObject(orientedCapsule);
  expect(orientedBounds.max.z - orientedBounds.min.z).toBeCloseTo(0.2016, 4);
  expect(0.018 + orientedBounds.max.z - orientedBounds.min.z).toBeLessThan(0.22);
  const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), floorSeed, { floorNumber: 2 });
  floor.dressDispatch(scene, seed, false);
  const station = floor.dispatchRoom;
  const spec = floor.world.plan.dispatchRoom;
  if (!station || !spec) throw Error('Missing dispatch room');
  const get = (name: string) => {
    const node = floor.world.group.getObjectByName(name);
    if (!node) throw Error(`Missing ${name}`);
    return node;
  };
  const pick = (anchor: string, name: string) => {
    const rig = get(anchor);
    const at = get(name).getWorldPosition(new THREE.Vector3());
    const eye = rig.localToWorld(new THREE.Vector3(0, 1.6, 1.05));
    return station.pick(eye, at.sub(eye).normalize());
  };
  const route = dispatchDestination(seed);
  expect(get('dispatch-routing-slip').userData.labelText).toContain(`Route ${route + 1}`);
  expect(get('dispatch-route-scale').userData.labelText).toContain('Find the return slip');
  for (const [anchor, tube, x] of [
    ['dispatch-room', 'dispatch-intake', 0.02],
    ['dispatch-reply-station', 'dispatch-delivery', 0],
  ] as const) {
    const console = get(anchor);
    const eye = console.localToWorld(new THREE.Vector3(x, 0.955, 0.44));
    const direction = new THREE.Vector3(0, 0, -1).transformDirection(console.matrixWorld);
    const ray = new THREE.Raycaster(eye, direction);
    const castings = console.children.filter((child) => child instanceof THREE.Mesh);
    expect(ray.intersectObjects(castings, false)[0]?.object.name).toBe(`${tube}-wall-recess`);
    expect(get(`${tube}-wall-recess`).position.z).toBeGreaterThan(-0.32);
  }
  const carrier = get('dispatch-travel-capsule');
  expect(carrier.position.z).toBeCloseTo(0.018, 6);
  expect(carrier.position.y + orientedBounds.min.y).toBeCloseTo(1.05 - 0.12, 3);
  expect(get('dispatch-delivery').position.z + 0.5 * (0.22 + 0.308)).toBeCloseTo(0.22);

  const gate = get('dispatch-vault-shutter');
  expect(gate.visible).toBe(true);
  floor.world.current = spec.source.room;
  expect(pick('dispatch-room', 'dispatch-selector')).toMatchObject({ action: 'turn' });
  expect(pick('dispatch-room', 'dispatch-send')).toMatchObject({ action: 'send' });
  floor.world.current = spec.replyRoom;
  expect(pick('dispatch-reply-station', 'dispatch-capsule')).toBeNull();
  station.sync({ route, sent: true, opened: false });
  expect(pick('dispatch-reply-station', 'dispatch-capsule')).toMatchObject({ action: 'open' });
  expect(get('dispatch-capsule').position.z).toBeCloseTo(0.018, 6);
  station.sendFeedback(false);
  for (let i = 0; i < 120; i++) station.update(1 / 60);
  expect(get('dispatch-capsule').position.z).toBeCloseTo(0.018, 6);
  expect(
    station.near(get('dispatch-capsule').getWorldPosition(new THREE.Vector3()), 0.1),
  ).toMatchObject({ action: 'open' });
  station.sync({ route, sent: true, opened: true });
  floor.world.setPuzzleGateOpen('dispatch', true);
  for (let i = 0; i < 60; i++) station.update(1 / 60);
  expect(gate.visible).toBe(false);
  expect(pick('dispatch-reply-station', 'dispatch-capsule')).toBeNull();
  floor.dispose();
});
