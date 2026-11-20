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
  let count = 0,
    decoys = 0;
  for (let i = 0; i < 140; i++) {
    const seed = 'H' + String(i).padStart(7, '0'),
      base = generateUpperFloor(seed),
      next = attachHiddenPassage(base);
    expect(next.rooms.slice(0, base.rooms.length)).toEqual(base.rooms);
    expect(placeStairEntry(next)).toEqual(placeStairEntry(base));
    if (!next.hiddenPassage) continue;
    count++;
    if (next.hiddenPassage.decoys.length) decoys++;
    const edge = next.connections.find((e) => e.puzzleGate === 'panel')!;
    const r = worldRooms(next);
    const door = (i: 0 | 1) => r[edge[i].room].doors.find((d) => d.id === edge[i].door)!;
    expect(door(0).world).toEqual(door(1).world);
    expect(next.rooms[edge[1].room].loot).toHaveLength(1);
    expect(next.sealed).not.toContainEqual(expect.objectContaining(edge[0]));
  }
  expect(count).toBeGreaterThan(20);
  expect(count).toBeLessThan(140);
  expect(decoys).toBeGreaterThan(10);
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
it('exposes the specific catch on discovery and stows the opened leaf past the hinge', async () => {
  const plan = playableFloorPlan('MAPTEST3', 6, 2),
    world = buildFloorWorld(plan);
  const bytes = await readFile('public/assets/props/panel-kit/panel-kit.glb');
  const { scene } = await nodeGeometryLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    '',
  );
  const panels = new ServicePanels(world, scene, true),
    p = panels.panels[0];
  const aim = (panel: (typeof panels.panels)[number]) => {
    world.current = panel.room;
    const target = panel.catch.getWorldPosition(new THREE.Vector3());
    const inward = panel.root.getWorldDirection(new THREE.Vector3());
    return panels.pick(target.addScaledVector(inward, 1.6), inward.negate());
  };
  for (const panel of panels.panels) expect(aim(panel)?.action).toBe('knock');
  world.current = p.room;
  expect(panels.near(p.catch.getWorldPosition(new THREE.Vector3()), 0.04)?.action).toBe('knock');
  const hinge = new THREE.Vector3(0, 0.053, 0);
  const hingeBefore = p.catch.localToWorld(hinge.clone());
  const lipBefore = p.catch.localToWorld(new THREE.Vector3(0, -0.05, 0));
  panels.sync({ discovered: true, opened: false }, true);
  expect(p.catch.localToWorld(hinge.clone()).distanceTo(hingeBefore)).toBeLessThan(0.001);
  expect(
    p.catch.localToWorld(new THREE.Vector3(0, -0.05, 0)).distanceTo(lipBefore),
  ).toBeGreaterThan(0.085);
  for (const decoy of panels.panels.slice(1)) {
    expect(decoy.catch.rotation.x).toBe(0);
    expect(aim(decoy)?.action).toBe('knock');
  }
  expect(aim(p)?.action).toBe('unlatch');
  expect(panels.near(p.catch.getWorldPosition(new THREE.Vector3()), 0.04)?.action).toBe('unlatch');
  panels.sync({ discovered: true, opened: true }, true);
  expect(p.leaf.rotation.y).toBeGreaterThan(Math.PI / 2);
  expect(panels.near(p.catch.getWorldPosition(new THREE.Vector3()), 0.2)).toBeNull();
  panels.dispose();
  world.dispose();
});
