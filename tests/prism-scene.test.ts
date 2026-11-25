// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { prismOrder } from '../src/rules/prism-signal.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

it('keeps all three authored prism controls reachable before the gate and aims the selected beam', async () => {
  const bytes = Uint8Array.from(
    await readFile('public/assets/props/puzzle-instruments/puzzle-instruments.glb'),
  );
  const { scene } = await nodeGeometryLoader().parseAsync(bytes.buffer, '');
  const seed = 'MAPTEST2';
  const view = mountFloorView(new THREE.Scene(), new THREE.Group(), floorSeedFor(seed, 3), {
    floorNumber: 3,
  });
  view.dressPrism(scene, seed, false);
  const prism = view.prismAnnex;
  const plan = view.world.plan.prismAnnex;
  if (!prism || !plan) throw Error('Missing the Prism Annex');
  const gate = view.world.group.getObjectByName('prism-annex-gate');
  if (!gate) throw Error('Missing the optical gate');
  const door = view.world.rooms[plan.source.room].doors.find(
    (site) => site.id === plan.source.door,
  )!;
  const center = gate.getWorldPosition(new THREE.Vector3());
  expect(center.x).toBeCloseTo(door.world[0]);
  expect(center.z).toBeCloseTo(door.world[1]);
  gate.updateWorldMatrix(true, true);
  const closedBounds = new THREE.Box3().setFromObject(gate);
  expect(closedBounds.min.y).toBeCloseTo(0, 6);
  expect(closedBounds.max.y).toBeCloseTo(2.4, 6);
  const width = closedBounds.getSize(new THREE.Vector3());
  expect(Math.max(width.x, width.z)).toBeCloseTo(door.width - 0.016, 6);
  expect(prism.object.parent).toBe(view.world.roomGroups[plan.source.room]);
  const clue = view.world.roomGroups[plan.clueRoom].getObjectByName('prism-annex-clue');
  expect(clue?.userData.labelText).toContain(
    prismOrder(seed)
      .map((i) => ['Notch', 'Star', 'Ring'][i])
      .join('  ·  '),
  );
  const aimAt = (node: THREE.Object3D) => {
    const target = node.getWorldPosition(new THREE.Vector3());
    const origin = target
      .clone()
      .addScaledVector(prism.object.getWorldDirection(new THREE.Vector3()), 1.55);
    return prism.pick(origin, target.clone().sub(origin).normalize());
  };
  view.world.current = prism.annexRoom;
  expect(aimAt(prism.object.getObjectByName('prism-turn')!)).toBeNull();
  view.world.current = prism.room;
  expect(aimAt(prism.object.getObjectByName('prism-turn')!)).toMatchObject({ action: 'turn' });
  for (const channel of [0, 1, 2] as const) {
    const receiver = prism.object.getObjectByName(`prism-receiver-${channel}`)!;
    expect(aimAt(receiver)).toMatchObject({ action: 'receiver', channel });
    expect(prism.near(receiver.getWorldPosition(new THREE.Vector3()), 0.08)).toMatchObject({
      action: 'receiver',
      channel,
    });
    prism.sync({ orientation: channel, progress: 0 }, true);
    const beam = prism.object.getObjectByName('prism-light-path')!;
    const endpoint = new THREE.Vector3(0, 0, beam.scale.z / 2)
      .applyQuaternion(beam.quaternion)
      .add(beam.position);
    expect(endpoint.distanceTo(receiver.position)).toBeLessThan(0.0001);
  }
  const remaining = view.world.colliders[plan.annexRoom].length;
  prism.sync({ orientation: 2, progress: 3 });
  prism.update(0.1);
  expect(gate.visible).toBe(true);
  const movingTop = new THREE.Box3().setFromObject(gate).max.y;
  expect(movingTop).toBeLessThan(closedBounds.max.y);
  expect(movingTop).toBeGreaterThan(0);
  prism.update(1);
  expect(new THREE.Box3().setFromObject(gate).max.y).toBeLessThan(0);
  view.world.setPuzzleGateOpen('prism', true, true);
  expect(view.world.colliders[plan.annexRoom]).toHaveLength(remaining - 1);
  expect(gate.visible).toBe(false);
  expect(aimAt(prism.object.getObjectByName('prism-turn')!)).toBeNull();
  view.dispose();
});
