// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { expect, it } from 'vitest';
import { RunFlow } from '../src/flow/flow.ts';
import { pendulumTarget, pendulumTrialSeconds } from '../src/rules/pendulum-gallery.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { stoneRoomKitFromScene } from '../src/world/stone-rooms.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

async function load(file: string): Promise<THREE.Group> {
  const bytes = Uint8Array.from(await readFile(file));
  return (await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene;
}

it.each([false, true])(
  'mounts both pendulums and times the catch, authored instruments %s',
  async (authored) => {
    const seed = 'MAPTEST2';
    const floor = mountFloorView(new THREE.Scene(), new THREE.Group(), floorSeedFor(seed, 3), {
      floorNumber: 3,
    });
    const spec = floor.world.plan.pendulumGallery;
    if (!spec) throw Error('Missing Pendulum Gallery layout');
    const stone = stoneRoomKitFromScene(
      await load('public/assets/props/stone-dungeon-kit/stone-dungeon-kit.glb'),
    );
    const room = floor.world.plan.rooms[spec.galleryRoom];
    const baseRoom = await load(`public/assets/rooms/${room.templateId}/${room.templateId}.glb`);
    floor.useRoomAsset(
      room.templateId,
      () => baseRoom.clone(true),
      [],
      undefined,
      undefined,
      stone,
    );
    const art = authored
      ? await load('public/assets/props/puzzle-instruments/puzzle-instruments.glb')
      : undefined;
    const game = new RunFlow({
      workshop: createWorkshop(),
      starterDeck: ['strike'],
      rewardPool: ['strike'],
    });
    game.newRun(seed);
    game.travelToFloor(2, 0);
    game.travelToFloor(3, 0);
    const results: string[] = [];
    floor.dressPendulumGallery(
      art,
      seed,
      false,
      () => {
        const result = game.completePendulumTrial();
        results.push(result);
        floor.pendulumGallery?.sync(game.pendulumGallery);
        return result;
      },
      () => {},
    );
    floor.dressStoneFurnishings(stone);
    const gallery = floor.pendulumGallery;
    if (!gallery) throw Error('Missing mounted instruments');
    const chamber = floor.world.roomGroups[spec.galleryRoom];
    expect(chamber.getObjectByName('StoneSkylightDaylight')).toBeDefined();
    const bays = (part: string) => {
      const centers: THREE.Vector3[] = [];
      chamber.traverse((node) => {
        if (!(node instanceof THREE.InstancedMesh) || !node.name.startsWith(`finish-${part}-`))
          return;
        const pose = new THREE.Matrix4();
        for (let i = 0; i < node.count; i++) {
          node.getMatrixAt(i, pose);
          centers.push(new THREE.Vector3().setFromMatrixPosition(pose));
        }
      });
      return centers;
    };
    const alongsideOldConservatory = (p: THREE.Vector3) =>
      Math.abs(p.x + 5) < 0.2 && p.z > 2 && p.z < 4;
    expect(bays('StoneBay').some(alongsideOldConservatory)).toBe(true);
    expect(bays('StoneNicheBay').some(alongsideOldConservatory)).toBe(false);
    for (const part of ['StoneShelf', 'StoneDishes', 'StonePlanter', 'StoneTorch'])
      expect(chamber.getObjectByName(part)).toBeDefined();
    expect(gallery.reference).not.toBe(gallery.adjustable);
    expect(gallery.reference.parent).toBe(gallery.adjustable.parent);
    expect(gallery.reference.children.some((n) => n.name === 'bob')).toBe(authored);

    floor.world.current = spec.source.room;
    const position = gallery.station.localToWorld(new THREE.Vector3(0, 1.37, 1.38));
    for (const [name, action] of [
      ['pendulum-adjustment', 'adjust'],
      ['pendulum-test-release', 'release'],
    ]) {
      const target = gallery.station.getObjectByName(name);
      if (!target) throw Error('Missing ' + name);
      const direction = target.getWorldPosition(new THREE.Vector3()).sub(position).normalize();
      expect(gallery.pick(position, direction)?.action).toBe(action);
    }
    const blocked = floor.world.colliders[spec.source.room].length;
    const target = pendulumTarget(seed);
    expect(gallery.start()).toBe(true);
    expect(gallery.start()).toBe(false);
    const controls = new THREE.Box3().makeEmpty();
    for (const name of ['pendulum-adjustment', 'pendulum-test-release']) {
      const object = gallery.station.getObjectByName(name);
      if (!object) throw Error('Missing ' + name);
      controls.union(new THREE.Box3().setFromObject(object));
    }
    const armBounds = new THREE.Box3();
    for (const angle of [-0.34, -0.17, 0, 0.17, 0.34]) {
      for (const arm of [gallery.reference, gallery.adjustable]) {
        arm.rotation.z = angle;
        expect(armBounds.setFromObject(arm).intersectsBox(controls)).toBe(false);
      }
    }
    gallery.update(7, true);
    expect(results).toEqual([]);
    gallery.update(0.44, false);
    expect(gallery.reference.rotation.z).not.toBeCloseTo(gallery.adjustable.rotation.z);
    gallery.update(4, false);
    expect(results).toEqual(['wrong']);
    expect(game.pendulumGallery.open).toBe(false);
    expect(gallery.station.getObjectByName('pendulum-caption-wrong')?.visible).toBe(true);

    // Leaving the station during a pending trial cancels it without solving.
    expect(gallery.start()).toBe(true);
    floor.world.current = (spec.source.room + 1) % floor.world.rooms.length;
    gallery.update(4, false);
    expect(results).toEqual(['wrong']);
    floor.world.current = spec.source.room;
    while (game.pendulumGallery.detent !== target) expect(game.advancePendulumDetent()).toBe(true);
    gallery.sync(game.pendulumGallery);
    expect(gallery.start()).toBe(true);
    const finish = pendulumTrialSeconds(target, target);
    gallery.update(finish - 0.01, false);
    expect(results).toEqual(['wrong']);
    gallery.update(0.02, false);
    expect(results).toEqual(['wrong', 'opened']);
    expect(gallery.reference.rotation.z).toBeCloseTo(0);
    expect(gallery.adjustable.rotation.z).toBeCloseTo(0);
    const left = gallery.gate.getObjectByName('pendulum-leaf-left');
    gallery.update(0.57, false);
    expect(left?.rotation.y).toBeGreaterThan(0);
    expect(floor.world.colliders[spec.source.room]).toHaveLength(blocked);
    gallery.update(0.67, false);
    expect(left?.rotation.y).toBeCloseTo(Math.PI / 2);
    expect(floor.world.colliders[spec.source.room]).toHaveLength(blocked - 1);
    floor.dispose();
  },
);
