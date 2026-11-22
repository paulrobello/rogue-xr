// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SHADOW_STENCIL_VERSION } from '../src/combat/encounter-choice.ts';
import { rectsOverlap, worldRooms } from '../src/floor/generate.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import {
  operateShadowStencil,
  readShadowStencil,
  shadowStencilTarget,
} from '../src/rules/shadow-stencil.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { mountFloorView, playableFloorPlan } from '../src/world/floor-view.ts';
import { STENCIL_RELEASE_SECONDS, STENCIL_SLIDE_SECONDS } from '../src/world/shadow-stencil.ts';
import { exposedWindowBays } from '../src/world/window-bays.ts';

const SEED = 'MAPTEST2';
const fresh = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: ['cog-toss'] });

describe('shadow stencil', () => {
  it('starts closed and derives a stable target', () => {
    expect(readShadowStencil({})).toEqual({ detent: 0, pitch: 0, opened: false });
    expect(shadowStencilTarget('ALPHA')).toEqual(shadowStencilTarget('ALPHA'));
  });

  it('moves only by valid detents and releases on the aligned tile', () => {
    const seed = 'ALPHA';
    const target = shadowStencilTarget(seed);
    const moved = operateShadowStencil(
      seed,
      { detent: 0, opened: false },
      { kind: 'slide', detent: target.detent },
    );
    expect(moved).toEqual({ detent: target.detent, opened: false });
    expect(operateShadowStencil(seed, moved, { kind: 'tile', tile: target.tile })).toEqual(moved);
    const pitched = operateShadowStencil(seed, moved, { kind: 'pitch', pitch: target.pitch });
    expect(pitched).toEqual({ detent: target.detent, pitch: target.pitch, opened: false });
    expect(
      operateShadowStencil(seed, pitched, {
        kind: 'tile',
        tile: ((target.tile + 1) % 3) as 0 | 1 | 2,
      }),
    ).toEqual(pitched);
    expect(operateShadowStencil(seed, pitched, { kind: 'tile', tile: target.tile })).toEqual({
      detent: target.detent,
      pitch: target.pitch,
      opened: true,
    });
    expect(
      operateShadowStencil(
        seed,
        { detent: target.detent, opened: true },
        { kind: 'slide', detent: 0 },
      ),
    ).toEqual({ detent: target.detent, opened: true });
  });

  it('adds the hall without changing rooms, stairs, exposed windows, or puzzle-gated routes', () => {
    let placed = 0;
    for (const seed of [
      SEED,
      ...Array.from({ length: 48 }, (_, i) => `STENC${String(i).padStart(3, '0')}`),
    ]) {
      const earlier = playableFloorPlan(seed, SHADOW_STENCIL_VERSION - 1, 1);
      const latest = playableFloorPlan(seed, SHADOW_STENCIL_VERSION, 1);
      expect(placeStairEntry(latest)).toEqual(placeStairEntry(earlier));
      expect(exposedWindowBays(latest, 1)).toEqual(exposedWindowBays(earlier, 1));
      if (!latest.shadowStencil) {
        expect(latest).toEqual(earlier);
        continue;
      }
      placed++;
      const { room } = latest.shadowStencil;
      expect(room).toBe(earlier.rooms.length);
      expect(latest.rooms.slice(0, room)).toEqual(earlier.rooms);
      expect(latest.rooms[room].loot).toEqual([{ socketId: 'chest', kind: 'card' }]);
      expect(latest.connections.slice(0, -1)).toEqual(earlier.connections);
      const entry = latest.connections.at(-1);
      expect(entry?.[1].room).toBe(room);
      expect(entry?.puzzleGate).toBeUndefined();
      const reachable = new Set([0]);
      for (const visited of reachable) {
        for (const edge of latest.connections) {
          if (edge.puzzleGate) continue;
          if (edge[0].room === visited) reachable.add(edge[1].room);
          if (edge[1].room === visited) reachable.add(edge[0].room);
        }
      }
      expect(reachable.has(room)).toBe(true);
      const footprints = worldRooms(latest).map((entry) => entry.footprint);
      expect(footprints.slice(0, room).some((area) => rectsOverlap(area, footprints[room]))).toBe(
        false,
      );
    }
    expect(placed).toBeGreaterThan(35);
  });

  it('preserves the detent and release through save validation and floor travel', () => {
    const flow = fresh();
    flow.newRun(SEED);
    const target = shadowStencilTarget(SEED);
    expect(flow.operateShadowStencil({ kind: 'tile', tile: target.tile })).toBe('ignored');
    expect(flow.operateShadowStencil({ kind: 'slide', detent: target.detent })).toBe('moved');
    const draft = validateSnapshot(flow.snapshot(10));
    const continued = fresh();
    expect(continued.continueRun(draft)).toBe(true);
    expect(continued.shadowStencil).toEqual({ detent: target.detent, pitch: 0, opened: false });
    expect(continued.operateShadowStencil({ kind: 'pitch', pitch: target.pitch })).toBe('moved');
    expect(continued.operateShadowStencil({ kind: 'tile', tile: target.tile })).toBe('released');
    expect(continued.travelToFloor(2, 0)).toBe(true);
    expect(continued.operateShadowStencil({ kind: 'slide', detent: 0 })).toBe('ignored');
    const restored = fresh();
    expect(restored.continueRun(validateSnapshot(continued.snapshot(20)))).toBe(true);
    expect(restored.travelToFloor(1, 0)).toBe(true);
    expect(restored.shadowStencil).toEqual({
      detent: target.detent,
      pitch: target.pitch,
      opened: true,
    });
    expect(restored.operateShadowStencil({ kind: 'tile', tile: target.tile })).toBe('ignored');
  });

  it('slides the projection, then releases the coffer padlock before allowing loot', () => {
    const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), SEED);
    try {
      floor.dressShadowStencil(undefined, SEED, false, null);
      const station = floor.shadowStencil;
      if (!station) throw Error('Missing the showcase station');
      floor.world.current = station.room;
      const slider = station.object.getObjectByName('shadow-stencil-slider');
      const cast = station.object.getObjectByName('stencil-floor-projection');
      const crest = station.object.getObjectByName('stencil-crest-shadow');
      const detent = station.object.getObjectByName(`stencil-detent-${station.target.detent}`);
      const tile = station.object.getObjectByName(`stencil-tile-${station.target.tile}`);
      if (!slider || !cast || !crest || !detent || !tile) throw Error('Missing mounted targets');
      const eye = station.object.localToWorld(new THREE.Vector3(0, 1.54, 1.86));
      const aimAt = (target: THREE.Object3D) =>
        target.getWorldPosition(new THREE.Vector3()).sub(eye).normalize();
      expect(station.pick(eye, aimAt(detent))?.action).toEqual({
        kind: 'slide',
        detent: station.target.detent,
      });
      expect(station.near(detent.getWorldPosition(new THREE.Vector3()), 0.24)?.action.kind).toBe(
        'slide',
      );
      expect(crest.visible).toBe(false);
      expect(station.aligned).toBe(false);
      const from = slider.position.x;
      const magnification = cast.position.x / from;
      station.sync({ detent: station.target.detent, pitch: station.target.pitch, opened: false });
      station.update(STENCIL_SLIDE_SECONDS / 2);
      expect(slider.position.x).toBeGreaterThan(from);
      expect(cast.position.x).toBeCloseTo(slider.position.x * magnification);
      expect(crest.visible).toBe(false);
      station.update(STENCIL_SLIDE_SECONDS / 2);
      expect(cast.position.x).toBeCloseTo(0);
      expect(crest.visible).toBe(true);
      expect(station.pick(eye, aimAt(tile))?.action).toEqual({
        kind: 'tile',
        tile: station.target.tile,
      });
      const reward = { kind: 'card', card: 'cog-toss' } as const;
      const coffer = floor.loot.coffers.find((entry) => entry.room === station.room);
      const lock = coffer?.object.getObjectByName('coffer-padlock');
      expect(lock?.visible).toBe(true);
      expect(
        floor.world.roomGroups[station.room].getObjectByName('stencil-lock-crossbar'),
      ).toBeUndefined();
      expect(floor.loot.open(station.room, 'chest', reward)).toBe(false);
      station.sync({ detent: station.target.detent, opened: true });
      station.update(STENCIL_RELEASE_SECONDS / 2);
      expect(floor.loot.open(station.room, 'chest', reward)).toBe(false);
      station.update(STENCIL_RELEASE_SECONDS / 2);
      expect(station.released).toBe(true);
      coffer?.update(STENCIL_RELEASE_SECONDS);
      expect(lock?.visible).toBe(false);
      coffer?.open(false);
      expect(coffer?.opened).toBe(true);
      expect(station.pick(eye, aimAt(tile))).toBeNull();
    } finally {
      floor.dispose();
    }
  });
});
