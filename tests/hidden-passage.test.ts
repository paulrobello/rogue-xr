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
it('exposes the specific catch on discovery and stows the opened leaf past the hinge', () => {
  const plan = playableFloorPlan('MAPTEST3', 6, 2),
    world = buildFloorWorld(plan),
    art = new THREE.Group();
  const frame = new THREE.Group(),
    leaf = new THREE.Group(),
    latch = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.15, 0.045), new THREE.MeshBasicMaterial());
  frame.name = 'PanelFrame';
  leaf.name = 'PanelLeaf';
  latch.name = 'PanelCatch';
  latch.position.set(1.25, 1.05, 0.018);
  leaf.add(latch);
  art.add(frame, leaf);
  const panels = new ServicePanels(world, art, true),
    p = panels.panels[0];
  world.current = p.room;
  expect(panels.near(p.catch.getWorldPosition(new THREE.Vector3()), 0.04)?.action).toBe('knock');
  panels.sync({ discovered: true, opened: false }, true);
  expect(p.catch.position.z).toBeGreaterThan(0.06);
  expect(panels.near(p.catch.getWorldPosition(new THREE.Vector3()), 0.04)?.action).toBe('unlatch');
  panels.sync({ discovered: true, opened: true }, true);
  expect(p.leaf.rotation.y).toBeGreaterThan(Math.PI / 2);
  expect(panels.near(p.catch.getWorldPosition(new THREE.Vector3()), 0.2)).toBeNull();
  panels.dispose();
  world.dispose();
});
