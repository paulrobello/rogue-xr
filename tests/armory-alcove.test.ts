// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARMORY_ALCOVE_VERSION } from '../src/combat/encounter-choice.ts';
import { ARMORY_ENCOUNTER, encounterSetups } from '../src/content/enemies.ts';
import { rectsOverlap, worldRooms } from '../src/floor/generate.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { mountFloorView, playableFloorPlan } from '../src/world/floor-view.ts';

const LIVE = 'ARM0R005';
const PASSIVE = 'ARM0R003';

const running = () =>
  new RunFlow({
    workshop: createWorkshop(),
    starterDeck: ['strike'],
    rewardPool: ['defend', 'cog-toss', 'ratchet-flurry'],
  });

describe('Armory Alcove', () => {
  it('appends only an open and non-overlapping branch and keeps the stair reservation', () => {
    const variants = new Set<boolean>();
    for (let i = 0; i < 40; i++) {
      const seed = floorSeedFor(`ARM0R${String(i).padStart(3, '0')}`, 2);
      const old = playableFloorPlan(seed, ARMORY_ALCOVE_VERSION - 1, 2);
      const next = playableFloorPlan(seed, ARMORY_ALCOVE_VERSION, 2);
      expect(next.rooms.slice(0, old.rooms.length)).toEqual(old.rooms);
      expect(next.connections.slice(0, old.connections.length)).toEqual(old.connections);
      expect(placeStairEntry(next)).toEqual(placeStairEntry(old));
      if (!next.armoryAlcove) continue;
      const { room } = next.armoryAlcove;
      expect(room).toBe(old.rooms.length);
      expect(next.connections.at(-1)?.[1].room).toBe(room);
      expect(next.connections.at(-1)?.puzzleGate).toBeUndefined();
      const bounds = worldRooms(next);
      expect(
        bounds
          .slice(0, room)
          .some((other) => rectsOverlap(other.footprint, bounds[room].footprint)),
      ).toBe(false);
      variants.add(Boolean(next.rooms[room].encounter));
    }
    expect(variants).toEqual(new Set([false, true]));
  });

  it.each([
    [LIVE, true],
    [PASSIVE, false],
  ] as const)(
    'uses an explicit wind and challenge only for the live variant (%s)',
    (seed, live) => {
      const scene = new THREE.Scene();
      const rig = new THREE.Group();
      scene.add(rig);
      const floor = mountFloorView(scene, rig, floorSeedFor(seed, 2), {
        floorNumber: 2,
        contentVersion: ARMORY_ALCOVE_VERSION,
      });
      try {
        const armory = floor.armoryAlcove;
        expect(armory?.object).toBeDefined();
        if (!armory) throw Error('No armory in fixture');
        floor.world.current = armory.room;
        const body = floor.world.enemies.get(armory.room)?.[0];
        expect(body?.userData.enemyKind).toBe(live ? 'waking-armor' : undefined);
        const head = new THREE.Object3D();
        head.position.copy(armory.object.localToWorld(new THREE.Vector3(0, 1.4, 2.55)));
        head.lookAt(armory.object.localToWorld(new THREE.Vector3(0, 1.4, 0)));
        const target = armory.object
          .getObjectByName('armory-wind')
          ?.getWorldPosition(new THREE.Vector3());
        if (!target) throw Error('Missing winding target');
        expect(Boolean(armory.pick(head.position, target.sub(head.position).normalize()))).toBe(
          live,
        );
        expect(floor.challengeArmor(head)).toBe(false);
        expect(floor.encounter.checkTrigger({ x: head.position.x, z: head.position.z })).toBeNull();
        if (!live) return;
        armory.sync(true, false);
        armory.wind();
        expect(floor.challengeArmor(head)).toBe(false);
        armory.update(0.8);
        expect(floor.challengeArmor(head)).toBe(true);
        expect(body?.visible).toBe(true);
        floor.encounter.update(1);
        expect(floor.encounter.phase).toBe('active');
        floor.encounter.end('win');
        floor.update(head, 1);
        expect(floor.encounter.isCleared(armory.room)).toBe(true);
        expect(body?.parent).toBeNull();
        expect(floor.challengeArmor(head)).toBe(false);
      } finally {
        floor.dispose();
      }
    },
  );

  it('saves awakening before combat, keeps a fled fight retryable and retains a clear on Continue', () => {
    const active = running();
    const room = playableFloorPlan(floorSeedFor(LIVE, 2), ARMORY_ALCOVE_VERSION, 2).armoryAlcove
      ?.room;
    if (room === undefined) throw Error('Missing armory fixture');
    active.newRun(LIVE);
    expect(active.awakenArmory()).toBe(false);
    expect(active.travelToFloor(2, room)).toBe(true);
    expect(active.awakenArmory()).toBe(true);
    expect(active.awakenArmory()).toBe(false);
    const snapshot = validateSnapshot(active.snapshot(1));
    expect(snapshot.run.armoryAwakened).toBe(true);
    const resumed = running();
    expect(resumed.continueRun(snapshot)).toBe(true);
    expect(resumed.fightStarted(room)).toBe(true);
    expect(resumed.fightEnded({ room, outcome: 'flee', tier: 'regular', playerHp: 40 })).toBe(true);
    expect(resumed.run?.armoryAwakened).toBe(true);
    expect(resumed.fightStarted(room)).toBe(true);
    expect(resumed.fightEnded({ room, outcome: 'win', tier: 'regular', playerHp: 40 })).toBe(true);
    const cleared = running();
    const after = validateSnapshot(resumed.snapshot(2));
    expect(after.clearedEncounters).toContain(String(room));
    expect(cleared.continueRun(after)).toBe(true);
    expect(cleared.fightStarted(room)).toBe(false);
  });

  it('has a guarded lock followed by an exposed two-hit move', () => {
    const [armor] = encounterSetups(ARMORY_ENCOUNTER);
    const lock = armor.moves.find((move) => move.id === 'lock-plates');
    const counter = armor.moves.find((move) => move.id === lock?.followUp);
    expect(lock).toMatchObject({ stance: 'guarded', intent: 'defend' });
    expect(counter).toMatchObject({ stance: 'exposed', effects: [{ type: 'damage', hits: 2 }] });
  });
});
