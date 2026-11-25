// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DRUM_GALLERY_VERSION } from '../src/combat/encounter-choice.ts';
import { rectsOverlap, worldRooms } from '../src/floor/generate.ts';
import { stoneRoomsFor } from '../src/floor/stone-rooms.ts';
import {
  type DrumBeat,
  drumPattern,
  EMPTY_DRUM_GALLERY,
  windDrum,
} from '../src/rules/drum-gallery.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import type { BellNote } from '../src/rules/types.ts';
import { DRUM_BEAT_SECONDS, DRUM_GATE_SECONDS } from '../src/world/drum-gallery.ts';
import { mountFloorView, playableFloorPlan } from '../src/world/floor-view.ts';
import { exposedWindowBays } from '../src/world/window-bays.ts';

const SEED = 'DR0M0000';
const FLOOR = floorSeedFor(SEED, 3);

describe('Drum Gallery in the Conservatory', () => {
  it('appends its unlocked approach and optional gated coffer while preserving older routes and windows', () => {
    let placed = 0;
    for (let i = 0; i < 32; i++) {
      const seed = floorSeedFor(`DR0M${String(i).padStart(4, '0')}`, 3);
      const old = playableFloorPlan(seed, DRUM_GALLERY_VERSION - 1, 3);
      const next = playableFloorPlan(seed, DRUM_GALLERY_VERSION, 3);
      expect(exposedWindowBays(next, 3)).toEqual(exposedWindowBays(old, 3));
      expect(old.drumGallery).toBeUndefined();
      if (!next.drumGallery) {
        expect(next).toEqual(old);
        continue;
      }
      placed++;
      const { gallery, recess, gate } = next.drumGallery;
      expect(next.rooms.slice(0, gallery)).toEqual(old.rooms);
      expect(next.connections.slice(0, -2)).toEqual(old.connections);
      const approach = next.connections.at(-2)!;
      expect(approach[0].room).not.toBe(0);
      expect(approach[1].room).toBe(gallery);
      expect(approach.puzzleGate).toBeUndefined();
      expect(next.connections.at(-1)).toMatchObject({
        0: gate,
        1: { room: recess },
        puzzleGate: 'drum-gallery',
      });
      const resolved = worldRooms(next);
      for (const index of [gallery, recess])
        expect(
          resolved
            .slice(0, index)
            .some((room) => rectsOverlap(room.footprint, resolved[index].footprint)),
        ).toBe(false);
      expect(next.rooms[recess]?.loot).toHaveLength(1);
      const stone = stoneRoomsFor(next, 3);
      expect(stone.get(gallery)).toBe('drum');
      expect(stone.get(recess)).toBe('dungeon');
    }
    expect(placed).toBeGreaterThan(0);
    expect(placed).toBeLessThan(32);
    expect(playableFloorPlan(FLOOR, DRUM_GALLERY_VERSION, 3).drumGallery).toBeDefined();
  });

  it.each([false, true])(
    'plays four beats before releasing collision with reduced motion %s',
    (reduced) => {
      const heard: (readonly BellNote[])[] = [];
      let releases = 0;
      const view = mountFloorView(new THREE.Scene(), new THREE.Group(), FLOOR, { floorNumber: 3 });
      try {
        const art = new THREE.Group();
        const shell = new THREE.Group();
        shell.name = 'pinned_drum';
        const decorativePins = ['pin.001', 'pin002'].map((name) => {
          const node = new THREE.Object3D();
          node.name = name;
          shell.add(node);
          return node;
        });
        art.add(shell);
        view.dressDrumGallery(
          art,
          SEED,
          reduced,
          null,
          (notes, at) => {
            heard.push(notes);
            expect(at.toArray().every(Number.isFinite)).toBe(true);
          },
          () => releases++,
        );
        const station = view.drumGallery;
        if (!station) throw Error('No Drum Gallery for this seed');
        expect(station.object.getObjectByName('pinned_drum')?.visible).toBe(true);
        for (const original of decorativePins) {
          expect(original.visible).toBe(true);
          expect(station.object.getObjectByName(original.name)?.visible).toBe(false);
        }
        const { gallery, recess } = station.layout;
        expect(station.clueRoom).not.toBe(gallery);
        expect(station.clueObject.parent).toBe(view.world.roomGroups[station.clueRoom]);
        view.world.current = gallery;
        const colliders = () => [gallery, recess].map((room) => view.world.colliders[room].length);
        const closed = colliders();
        const pattern = drumPattern(SEED);
        const pin = { beat: pattern.gap, note: pattern.notes[pattern.gap] };
        const socket = station.object.getObjectByName(`drum-gallery-pin-${pin.beat}-${pin.note}`);
        if (!socket?.parent) throw Error('The repair socket is missing');
        const at = socket.getWorldPosition(new THREE.Vector3());
        const eye = socket.parent.localToWorld(new THREE.Vector3(socket.position.x, 0.135, 1.7));
        expect(station.pick(eye, at.clone().sub(eye).normalize())?.action).toEqual({
          kind: 'pin',
          pin,
        });
        expect(station.near(at, 0.12)?.action).toEqual({ kind: 'pin', pin });
        station.play();
        for (let i = 0; i < 4; i++) station.update(DRUM_BEAT_SECONDS);
        expect(station.playing).toBe(false);
        expect(heard).toEqual([[], [], [], []]);
        expect(colliders()).toEqual(closed);
        expect(releases).toBe(0);

        const pins = pattern.notes.map((note, beat) => ({ beat: beat as DrumBeat, note }));
        const repaired = windDrum(pattern, { ...EMPTY_DRUM_GALLERY, pin, pins });
        station.sync(repaired);
        station.play();
        for (let i = 0; i < 3; i++) station.update(DRUM_BEAT_SECONDS);
        expect(releases).toBe(0);
        expect(colliders()).toEqual(closed);
        station.update(DRUM_BEAT_SECONDS);
        expect(heard.slice(4)).toEqual(pattern.notes.map((note) => [note]));
        expect(releases).toBe(1);
        if (!reduced) {
          station.update(DRUM_GATE_SECONDS / 2);
          expect(station.leaf.position.y).toBeLessThan(0);
          expect(colliders()).toEqual(closed);
          station.update(DRUM_GATE_SECONDS / 2);
        }
        expect(station.released).toBe(true);
        expect(station.leaf.visible).toBe(false);
        expect(colliders()).toEqual(closed.map((count) => count - 1));
        station.sync(repaired, true);
        station.play();
        station.update(DRUM_BEAT_SECONDS * 4);
        expect(releases).toBe(1);
      } finally {
        view.dispose();
      }
    },
  );
});
