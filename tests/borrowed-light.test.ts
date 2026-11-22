// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BORROWED_LIGHT_VERSION } from '../src/combat/encounter-choice.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import {
  BORROWED_MIRRORS,
  BORROWED_RECEIVER,
  BORROWED_SCREEN,
  borrowedLightTarget,
  operateBorrowedLight,
  readBorrowedLight,
  traceBorrowedLight,
} from '../src/rules/borrowed-light.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { BorrowedLight } from '../src/world/borrowed-light.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

const SEED = 'MAPTEST2';
const DETENTS = [0, 1, 2, 3] as const;
const fresh = () =>
  new RunFlow({
    workshop: createWorkshop(),
    starterDeck: ['strike'],
    rewardPool: ['defend', 'cog-toss', 'ratchet-flurry'],
  });
const planFor = (seed = SEED) =>
  playableFloorPlan(floorSeedFor(seed, 3), BORROWED_LIGHT_VERSION, 3);

describe('Borrowed Light', () => {
  it('has exactly one unobstructed route to the receiver in each seeded detent layout', () => {
    const barriers = new THREE.Box3(
      new THREE.Vector3(...BORROWED_SCREEN.min),
      new THREE.Vector3(...BORROWED_SCREEN.max),
    );
    const point = new THREE.Vector3();
    const found = new Set<string>();
    for (let i = 0; i < 48; i++) {
      const seed = `R3LAY${String(i).padStart(3, '0')}`;
      const target = borrowedLightTarget(seed);
      found.add(target.join(','));
      const start = readBorrowedLight({ seed });
      expect(start.open).toBe(false);
      expect(traceBorrowedLight(seed, start.detents).reachesReceiver).toBe(false);
      const lit = DETENTS.flatMap((a) =>
        DETENTS.filter((b) => traceBorrowedLight(seed, [a, b]).reachesReceiver).map(
          (b) => [a, b] as const,
        ),
      );
      expect(lit).toEqual([target]);
      const { points } = traceBorrowedLight(seed, target);
      expect(points).toHaveLength(4);
      points.at(-1)?.forEach((value, axis) => {
        expect(value).toBeCloseTo(BORROWED_RECEIVER[axis]);
      });
      for (let p = 0; p < points.length - 1; p++) {
        const first = new THREE.Vector3(...points[p]);
        const direction = new THREE.Vector3(...points[p + 1]).sub(first);
        const max = direction.length();
        const hit = new THREE.Ray(first, direction.normalize()).intersectBox(barriers, point);
        expect(hit === null || hit.distanceTo(first) > max).toBe(true);
      }
    }
    expect(found.size).toBeGreaterThan(8);
    const first = new THREE.Vector3(...BORROWED_MIRRORS[0]);
    const receiver = new THREE.Vector3(...BORROWED_RECEIVER);
    expect(
      new THREE.Ray(first, receiver.clone().sub(first).normalize()).intersectBox(barriers, point),
    ).not.toBeNull();
  });

  it('restores an unfinished setting, releases once, and keeps the latch through resetting and Continue', () => {
    const layout = planFor().borrowedLight;
    if (!layout) throw Error('Missing Borrowed Light fixture');
    const flow = fresh();
    flow.newRun(SEED);
    expect(flow.operateBorrowedLight(0)).toBe('ignored');
    expect(flow.travelToFloor(2, 0)).toBe(true);
    expect(flow.travelToFloor(3, layout.opticsRoom)).toBe(true);
    const partial = flow.operateBorrowedLight(1);
    expect(partial).toBe('adjusted');
    const unfinished = validateSnapshot(flow.snapshot(12));
    const restored = fresh();
    expect(restored.continueRun(unfinished)).toBe(true);
    expect(restored.borrowedLight).toEqual(flow.borrowedLight);
    const opens: string[] = [];
    restored.onChange((event) => {
      if (event.type === 'borrowed-light') opens.push(event.result);
    });
    const target = borrowedLightTarget(SEED);
    for (const axis of [0, 1] as const) {
      const turns = (target[axis] - restored.borrowedLight.detents[axis] + 4) % 4;
      for (let steps = 0; steps < turns; steps++) restored.operateBorrowedLight(axis);
    }
    expect(restored.borrowedLight).toEqual({ detents: target, open: true });
    expect(restored.operateBorrowedLight('reset')).toBe('adjusted');
    expect(restored.borrowedLight).toEqual({ ...readBorrowedLight({ seed: SEED }), open: true });
    expect(restored.operateBorrowedLight('reset')).toBe('ignored');
    expect(opens.filter((event) => event === 'opened')).toHaveLength(1);
    expect(restored.travelToFloor(2, 1)).toBe(true);
    const cleared = validateSnapshot(restored.snapshot(30));
    const continued = fresh();
    expect(continued.continueRun(cleared)).toBe(true);
    expect(continued.travelToFloor(3, layout.recessRoom)).toBe(true);
    expect(continued.borrowedLight).toEqual(restored.borrowedLight);
  });

  it('runs the floor stencil and the door collider from the same solved state', () => {
    const plan = planFor();
    const layout = plan.borrowedLight;
    if (!layout) throw Error('Missing Borrowed Light fixture');
    const world = buildFloorWorld(plan);
    world.current = layout.opticsRoom;
    const stage = new BorrowedLight(world, layout, SEED, false);
    try {
      const leaf = stage.gate.getObjectByName('borrowed-light-stone-leaf');
      const clue = stage.object.getObjectByName('borrowed-light-floor-message');
      const mirror = stage.object.getObjectByName('borrowed-light-turn-0');
      expect(mirror).toBeDefined();
      if (!leaf || !clue || !mirror) throw Error('Missing stage geometry');
      const start = readBorrowedLight({ seed: SEED });
      const position = mirror.getWorldPosition(new THREE.Vector3());
      const eye = stage.object.localToWorld(new THREE.Vector3(-1, 1.25, 2.8));
      expect(stage.pick(eye, position.sub(eye).normalize())?.action).toBe(0);
      const glass = stage.object.getObjectByName('borrowed-light-mirror-face-0');
      if (!glass) throw Error('Missing mirror face target');
      for (const x of [-0.1, 0.1]) {
        const point = glass.localToWorld(new THREE.Vector3(x, 0.055, 0));
        const frontOfGlass = glass.localToWorld(new THREE.Vector3(x, 0.055, 0.75));
        expect(stage.pick(frontOfGlass, point.sub(frontOfGlass).normalize())?.action).toBe(0);
      }
      const front = world.colliders[layout.opticsRoom].length;
      const back = world.colliders[layout.recessRoom].length;
      expect(clue.visible).toBe(false);
      stage.sync({ detents: borrowedLightTarget(SEED), open: true });
      stage.update(0.45);
      expect(clue.visible).toBe(true);
      expect(leaf.visible).toBe(true);
      expect(world.colliders[layout.opticsRoom]).toHaveLength(front);
      stage.update(0.7);
      expect(leaf.visible).toBe(false);
      expect(world.colliders[layout.opticsRoom]).toHaveLength(front - 1);
      expect(world.colliders[layout.recessRoom]).toHaveLength(back - 1);
      stage.sync(
        operateBorrowedLight(SEED, { detents: borrowedLightTarget(SEED), open: true }, 'reset'),
      );
      stage.update(0.4);
      expect(clue.visible).toBe(false);
      expect(leaf.visible).toBe(false);
      expect(world.colliders[layout.opticsRoom]).toHaveLength(front - 1);
      expect(readBorrowedLight({ seed: SEED })).toEqual(start);
    } finally {
      stage.dispose();
      world.dispose();
    }
  });
});
