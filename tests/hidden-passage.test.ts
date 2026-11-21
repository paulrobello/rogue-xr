import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { generateUpperFloor, worldRooms } from '../src/floor/generate.ts';
import { attachHiddenPassage } from '../src/floor/hidden-passage.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { ServicePanels } from '../src/world/service-panels.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

it('reserves the original staircase, with an optional seeded, connected and stocked recess', () => {
  let count = 0;
  for (let i = 0; i < 140; i++) {
    const seed = 'H' + String(i).padStart(7, '0'),
      base = generateUpperFloor(seed),
      next = attachHiddenPassage(base);
    expect(next.rooms.slice(0, base.rooms.length)).toEqual(base.rooms);
    expect(placeStairEntry(next)).toEqual(placeStairEntry(base));
    if (!next.hiddenPassage) continue;
    count++;
    const edge = next.connections.find((e) => e.puzzleGate === 'panel')!;
    const r = worldRooms(next);
    const door = (i: 0 | 1) => r[edge[i].room].doors.find((d) => d.id === edge[i].door)!;
    expect(door(0).world).toEqual(door(1).world);
    expect(next.rooms[edge[1].room].loot).toHaveLength(1);
    expect(next.sealed).not.toContainEqual(expect.objectContaining(edge[0]));
  }
  expect(count).toBeGreaterThan(20);
  expect(count).toBeLessThan(140);
  expect(playableFloorPlan('MAPTEST3', 5, 2).hiddenPassage).toBeUndefined();
});
it('restores the sprung latch and the open passage without repeating discovery', () => {
  const make = () =>
    new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: ['strike'] });
  let flow = make();
  flow.newRun('MAPTEST2');
  expect(flow.discoverHiddenPanel()).toBe(false);
  flow.travelToFloor(2, 0);
  expect(flow.openHiddenPanel()).toBe(false);
  expect(flow.discoverHiddenPanel()).toBe(true);
  expect(flow.discoverHiddenPanel()).toBe(false);
  const first = validateSnapshot(flow.snapshot());
  flow = make();
  flow.continueRun(first);
  expect(flow.hiddenPanel.discovered).toBe(true);
  expect(flow.openHiddenPanel()).toBe(true);
  flow.travelToFloor(1, 0);
  flow.travelToFloor(2, 0);
  expect(flow.hiddenPanel.opened).toBe(true);
  expect(() =>
    validateSnapshot({
      ...first,
      run: { ...first.run, hiddenPanel: { discovered: false, opened: true } },
    }),
  ).toThrow();
});
it('accepts three knocks inside the circle and stows the opened leaf past the hinge', async () => {
  const plan = playableFloorPlan('MAPTEST3', 6, 2),
    world = buildFloorWorld(plan);
  const bytes = await readFile('public/assets/props/panel-kit/panel-kit.glb');
  const { scene } = await nodeGeometryLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    '',
  );
  const panels = new ServicePanels(world, scene, true),
    p = panels.panel;
  const circle = p.leaf.getObjectByName('service-knock-target');
  const latch = p.leaf.getObjectByName('service-catch-' + p.room);
  if (!circle || !latch) throw Error('Missing the service door controls');
  const aim = (target: THREE.Vector3) => {
    const inward = p.root.getWorldDirection(new THREE.Vector3());
    return panels.pick(target.clone().addScaledVector(inward, 1.6), inward.negate());
  };
  world.current = p.room;
  const center = circle.getWorldPosition(new THREE.Vector3());
  const outside = circle.localToWorld(new THREE.Vector3(0.12, 0.02, 0.12));
  expect(aim(outside)).toBeNull();
  expect(panels.near(outside, 0.04)).toBeNull();
  expect(panels.near(center, 0.04)?.action).toBe('knock');
  expect(aim(latch.getWorldPosition(new THREE.Vector3()))).toBeNull();
  const hinge = new THREE.Vector3(0, 0.053, 0);
  const hingeBefore = latch.localToWorld(hinge.clone());
  const lipBefore = latch.localToWorld(new THREE.Vector3(0, -0.05, 0));
  const flow = new RunFlow({
    workshop: createWorkshop(),
    starterDeck: ['strike'],
    rewardPool: ['strike'],
  });
  flow.newRun('MAPTEST2');
  flow.travelToFloor(2, p.room);
  for (let count = 1; count <= 3; count++) {
    expect(aim(center)?.action).toBe('knock');
    const struck = panels.knock();
    expect(struck?.count).toBe(count);
    if (struck?.count === 3) flow.discoverHiddenPanel();
    panels.sync(flow.hiddenPanel, true);
    expect(flow.hiddenPanel.discovered).toBe(count === 3);
    const handle = aim(latch.getWorldPosition(new THREE.Vector3()));
    expect(handle?.action ?? null).toBe(count === 3 ? 'unlatch' : null);
  }
  expect(panels.knock()).toBeNull();
  expect(aim(center)).toBeNull();
  expect(latch.localToWorld(hinge.clone()).distanceTo(hingeBefore)).toBeLessThan(0.001);
  expect(latch.localToWorld(new THREE.Vector3(0, -0.05, 0)).distanceTo(lipBefore)).toBeGreaterThan(
    0.085,
  );
  expect(panels.near(latch.getWorldPosition(new THREE.Vector3()), 0.04)?.action).toBe('unlatch');
  panels.sync({ discovered: true, opened: true }, true);
  expect(p.leaf.rotation.y).toBeGreaterThan(Math.PI / 2);
  expect(panels.near(latch.getWorldPosition(new THREE.Vector3()), 0.2)).toBeNull();
  panels.dispose();
  world.dispose();
});
