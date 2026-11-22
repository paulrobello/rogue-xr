// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { RELIQUARY_VERSION, SPEAKING_PIPES_VERSION } from '../src/combat/encounter-choice.ts';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import { reliquaryGlyph } from '../src/rules/reliquary.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import type { Point } from '../src/sigil/types.ts';
import { mountFloorView, playableFloorPlan } from '../src/world/floor-view.ts';
import { stoneRoomKitFromScene } from '../src/world/stone-rooms.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

function flow() {
  return new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
}

function sampled(points: readonly Point[], jitter = false): Point[] {
  const converted: Point[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i];
    const segments = i * 8;
    for (let step = 0; step < segments; step++) {
      const t = step / segments;
      converted.push({
        x: THREE.MathUtils.lerp(a.x, b.x, t) * 0.42 + (jitter ? 0.012 * Math.sin(step) : 0),
        y: THREE.MathUtils.lerp(a.y, b.y, t) * 0.42 + (jitter ? 0.009 * Math.cos(step) : 0),
      });
    }
  }
  const end = points[points.length - 1];
  return [...converted, { x: end.x * 0.42, y: end.y * 0.42 }];
}

describe('Stone Reliquary', () => {
  it('adds only a reachable optional branch, and leaves all v12 room, stair and gate indices stable', () => {
    let layouts = 0;
    for (const seed of [
      'MAPTEST2',
      ...Array.from({ length: 96 }, (_, i) => `RE11C${String(i).padStart(3, '0')}`),
    ]) {
      const upper = floorSeedFor(seed, 2);
      const old = playableFloorPlan(upper, SPEAKING_PIPES_VERSION, 2);
      const next = playableFloorPlan(upper, RELIQUARY_VERSION, 2);
      expect(next.rooms.slice(0, old.rooms.length)).toEqual(old.rooms);
      expect(next.connections.slice(0, old.connections.length)).toEqual(old.connections);
      expect(next.speakingPipes).toEqual(old.speakingPipes);
      expect(placeStairEntry(next)).toEqual(placeStairEntry(old));
      const spec = next.reliquary;
      if (!spec) continue;
      layouts++;
      expect(spec.clueRoom).not.toBe(spec.source.room);
      expect(spec.reliquaryRoom).toBe(old.rooms.length);
      expect(next.rooms[spec.reliquaryRoom].loot).toHaveLength(1);
      expect(next.connections.at(-1)).toMatchObject({ puzzleGate: 'reliquary', 0: spec.source });
      const visited = new Set<number>([0]);
      for (const from of visited) {
        for (const edge of next.connections) {
          if (edge.puzzleGate) continue;
          if (edge[0].room === from) visited.add(edge[1].room);
          if (edge[1].room === from) visited.add(edge[0].room);
        }
      }
      expect(visited).toContain(spec.clueRoom);
      expect(visited).toContain(spec.source.room);
      expect(visited).toContain(next.guardianRoom);
      expect(visited).not.toContain(spec.reliquaryRoom);
    }
    expect(layouts).toBeGreaterThan(65);
  });

  it('matches the three distinct shapes, permits jitter and reverse drawing, and retains progress and the clue on Continue', () => {
    const seeds = Array.from({ length: 24 }, (_, i) => `RE11C${String(i).padStart(3, '0')}`);
    const glyphs = Array.from(
      new Map(seeds.map((seed) => [reliquaryGlyph(seed).name, seed])).values(),
    );
    expect(glyphs).toHaveLength(3);
    for (const [i, seed] of glyphs.entries()) {
      const game = flow();
      expect(game.newRun(seed)).toBe(true);
      const stroke = sampled(reliquaryGlyph(seed).points, true).reverse();
      const wrongShape = sampled(reliquaryGlyph(glyphs[(i + 1) % glyphs.length]).points);
      expect(game.rememberReliquaryRubbing()).toBe(false);
      expect(game.travelToFloor(2, 1)).toBe(true);
      expect(game.run?.floorSeed).not.toBe(seed);
      expect(game.submitReliquaryTrace(stroke)).toBe('ignored');
      expect(game.rememberReliquaryRubbing()).toBe(true);
      expect(game.submitReliquaryTrace(wrongShape)).toBe('wrong');
      expect(game.submitReliquaryTrace(stroke.slice(0, 9))).toBe('wrong');
      expect(game.submitReliquaryTrace(stroke.map(({ x, y }) => ({ x: x / 30, y: y / 30 })))).toBe(
        'wrong',
      );
      expect(game.reliquarySeal).toBe('known');
      const snapshot = validateSnapshot(game.snapshot(123, 1));
      const restored = flow();
      expect(restored.continueRun(snapshot)).toBe(true);
      expect(restored.submitReliquaryTrace(stroke)).toBe('opened');
      expect(restored.submitReliquaryTrace(stroke)).toBe('ignored');
      expect(restored.travelToFloor(1, 0)).toBe(true);
      const continued = flow();
      expect(continued.continueRun(validateSnapshot(restored.snapshot(200, 0)))).toBe(true);
      expect(continued.reliquarySeal).toBe('open');
      expect(continued.travelToFloor(2, 1)).toBe(true);
      expect(continued.reliquarySeal).toBe('open');
      expect(() =>
        validateSnapshot({
          ...snapshot,
          run: { ...snapshot.run, reliquarySeal: 'broken' },
        }),
      ).toThrow(/reliquarySeal/);
      const legacy = flow();
      expect(
        legacy.continueRun({
          ...snapshot,
          contentVersion: SPEAKING_PIPES_VERSION,
          run: { ...snapshot.run, reliquarySeal: undefined },
        }),
      ).toBe(true);
      expect(legacy.rememberReliquaryRubbing()).toBe(false);
      expect(legacy.submitReliquaryTrace(stroke)).toBe('ignored');
    }
  });

  it('mounts kit furnishings and gates the crossing until the visible stone leaf clears', async () => {
    const seed = 'MAPTEST2';
    const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), floorSeedFor(seed, 2), {
      floorNumber: 2,
    });
    const spec = floor.world.plan.reliquary;
    if (!spec) throw Error('missing Reliquary');
    const bytes = Uint8Array.from(
      await readFile('public/assets/props/stone-dungeon-kit/stone-dungeon-kit.glb'),
    );
    const art = (await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene;
    const kit = stoneRoomKitFromScene(art);
    const room = floor.world.plan.rooms[spec.reliquaryRoom];
    floor.useRoomAsset(room.templateId, () => new THREE.Group(), [], undefined, undefined, kit);
    floor.dressStoneFurnishings(kit);
    floor.dressReliquary(seed, false);
    const station = floor.reliquary;
    if (!station) throw Error('missing mounted Reliquary');
    const interior = floor.world.roomGroups[spec.reliquaryRoom];
    for (const part of ['StoneShelf', 'StoneDishes', 'StonePlanter', 'StoneTorch'])
      expect(interior.getObjectByName(part)).toBeDefined();
    const plate = station.plate;
    const rubbing = station.rubbing;
    const origin = new THREE.Vector3();
    const direction = new THREE.Vector3();
    function aim(parent: THREE.Group, x = 0, y = 0) {
      parent.localToWorld(origin.set(0, 1.23, 1.05));
      parent.localToWorld(direction.set(x, 1.19 + y, 0.065));
      direction.sub(origin).normalize();
    }
    floor.world.current = spec.clueRoom;
    aim(rubbing);
    expect(station.pick(origin, direction)?.action).toBe('rubbing');
    floor.world.current = spec.source.room;
    aim(plate);
    expect(station.begin(origin, direction)).toBe(false);
    station.sync('known');
    const points = sampled(reliquaryGlyph(seed).points);
    aim(plate, points[0].x, points[0].y);
    expect(station.begin(origin, direction)).toBe(true);
    for (const { x, y } of points.slice(1)) {
      aim(plate, x, y);
      station.sample(origin, direction);
    }
    const game = flow();
    game.newRun(seed);
    game.travelToFloor(2, spec.source.room);
    game.rememberReliquaryRubbing();
    expect(game.submitReliquaryTrace(station.finish())).toBe('opened');
    const leaf = station.gate.getObjectByName('reliquary-stone-leaf');
    const latch = station.gate.getObjectByName('reliquary-brass-latch');
    const blocked = floor.world.colliders[spec.source.room].length;
    station.sync('open');
    station.update(0.17);
    expect(latch?.position.x).toBeGreaterThan(0.2);
    expect(leaf?.position.y).toBeCloseTo(0);
    station.update(0.5);
    expect(leaf?.position.y).toBeLessThan(0);
    expect(floor.world.colliders[spec.source.room]).toHaveLength(blocked);
    station.update(0.7);
    expect(leaf?.visible).toBe(false);
    expect(floor.world.colliders[spec.source.room]).toHaveLength(blocked - 1);
    floor.dispose();
  });
});
