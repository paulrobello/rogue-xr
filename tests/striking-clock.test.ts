// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { conservatoryPlan } from '../src/floor/conservatory.ts';
import { generateUpperFloor } from '../src/floor/generate.ts';
import { alchemyRecipe } from '../src/rules/alchemy.ts';
import { INGREDIENT_ROOTS } from '../src/world/alchemy-conservatory.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { kitPart } from '../src/world/puzzle-placement.ts';
import { CLOCK_CYCLE, StrikingClock } from '../src/world/striking-clock.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

function artKit(): THREE.Group {
  const art = new THREE.Group();
  const clock = new THREE.Group();
  clock.name = 'GrandfatherClock';
  for (const name of [
    'ClockIngredientSocket',
    'ClockCompartment',
    'ClockPendulum',
    'ClockHourHand',
    'ClockMinuteHand',
  ]) {
    const node = new THREE.Group();
    node.name = name;
    clock.add(node);
  }
  art.add(clock);
  const clue = new THREE.Group();
  clue.name = 'ClockClueDial';
  const clueHand = new THREE.Group();
  clueHand.name = 'ClockClueHand';
  clue.add(clueHand);
  art.add(clue);
  for (const root of Object.values(INGREDIENT_ROOTS)) {
    const ingredient = new THREE.Mesh(
      new THREE.SphereGeometry(0.08),
      new THREE.MeshBasicMaterial(),
    );
    ingredient.name = `Ingredient${root}`;
    art.add(ingredient);
  }
  return art;
}

function world(): { current: number; roomGroups: THREE.Group[]; rooms: object[] } {
  return { current: 0, roomGroups: [new THREE.Group(), new THREE.Group()], rooms: [{}, {}] };
}

function nextStrike(clock: StrikingClock): boolean {
  for (let i = 0; i < CLOCK_CYCLE + 2; i++) if (clock.update(1)) return true;
  return false;
}

describe('striking clock', () => {
  it('ticks at each pendulum crossing only within earshot in the clock room', () => {
    const clock = new StrikingClock(world() as never, 0, 1, artKit(), 'MAPTEST2');
    clock.object.position.set(2, 0, -3);
    const pivot = kitPart(clock.object, 'ClockPendulum');
    pivot.position.y = 1.47;
    const origin = pivot.getWorldPosition(new THREE.Vector3());
    const ticks: { time: number; volume: number }[] = [];
    let time = 0;
    const listen = (room: number, distance: number, seconds: number) => {
      clock.setWitness(room);
      const listener = origin.clone().add(new THREE.Vector3(0, 0, distance));
      for (let frame = 0; frame < Math.round(seconds * 100); frame++) {
        time += 0.01;
        clock.update(0.01, listener, (at, volume) => {
          expect(at).toEqual(origin);
          ticks.push({ time, volume });
        });
      }
    };
    listen(1, 1, 2);
    listen(0, 3, 2);
    expect(ticks).toHaveLength(0);
    listen(0, 1, 2.4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < ticks.length; i++)
      expect(Math.abs(ticks[i].time - ticks[i - 1].time - 1 / 1.3)).toBeLessThan(0.011);
    const near = ticks.at(-1)?.volume ?? 0;
    listen(0, 2.25, 1);
    const farther = ticks.at(-1)?.volume ?? 0;
    expect(farther).toBeGreaterThan(0);
    expect(farther).toBeLessThan(near);
    expect(
      clock.update(0, origin, () => {
        throw Error('Paused clocks are silent');
      }),
    ).toBe(false);
    clock.dispose();
  });
  it('keeps the exported brass pin in front of both pointers at every angle', async () => {
    const bytes = await readFile('public/assets/props/alchemy-kit/alchemy-kit.glb');
    const art = (
      await nodeGeometryLoader().parseAsync(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        '',
      )
    ).scene;
    const clock = new StrikingClock(world() as never, 0, 1, art, 'MAPTEST2');
    const hour = kitPart(clock.object, 'ClockHourHand');
    const minute = kitPart(clock.object, 'ClockMinuteHand');
    const cap = kitPart(clock.object, 'ClockHandHub');
    const origin = cap.getWorldPosition(new THREE.Vector3());
    const ray = new THREE.Raycaster(
      origin.clone().add(new THREE.Vector3(0, 0, 0.2)),
      new THREE.Vector3(0, 0, -1),
    );
    for (const hand of [hour, minute]) {
      expect(hand.position.x).toBeCloseTo(origin.x, 5);
      expect(hand.position.y).toBeCloseTo(origin.y, 5);
    }
    clock.update(((12 - clock.dialHours) * CLOCK_CYCLE) / 12);
    const h = new THREE.Box3().setFromObject(hour, true);
    const m = new THREE.Box3().setFromObject(minute, true);
    expect(h.max.y - origin.y).toBeCloseTo(0.11);
    expect(m.max.y - origin.y).toBeCloseTo(0.166);
    expect(h.max.x).toBeLessThan(0.014);
    expect(h.max.x).toBeGreaterThan(m.max.x);
    for (const advance of [0, 10.8, 22.7, 18.5]) {
      clock.update(advance);
      clock.object.updateWorldMatrix(true, true);
      expect(cap.getWorldPosition(new THREE.Vector3())).toEqual(origin);
      const pinHit = ray.intersectObject(cap, true)[0];
      expect(pinHit).toBeDefined();
      expect(ray.intersectObject(clock.object, true)[0]?.object).toBe(pinHit.object);
      const hours = clock.dialHours;
      expect(hour.rotation.z).toBeCloseTo((-hours * Math.PI) / 6);
      expect(minute.rotation.z).toBeCloseTo(-(hours % 1) * 2 * Math.PI);
    }
    clock.dispose();
  });
  it('seats the entire inscription ahead of projecting wall moldings', () => {
    const seed = 'MAPTEST2';
    const floor = buildFloorWorld(generateUpperFloor(seed));
    const first = StrikingClock.mount(floor, artKit(), seed, false)!;
    const trim = new THREE.Group();
    trim.position.copy(first.clueObject.position);
    trim.quaternion.copy(first.clueObject.quaternion);
    floor.roomGroups[first.clueRoom].add(trim);
    first.dispose();
    for (const [y, front] of [
      [0.27, 0.015],
      [-0.27, -0.012],
    ]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.035, 0.07));
      rail.position.set(0, y, front - 0.035);
      trim.add(rail);
    }
    floor.group.updateMatrixWorld(true);
    const clock = StrikingClock.mount(floor, artKit(), seed, false)!;
    const plate = clock.clueObject.getObjectByName(
      'striking-clock-inscription',
    ) as THREE.Mesh<THREE.BoxGeometry>;
    const halfDepth = (plate.geometry.parameters.depth * plate.scale.z) / 2;
    expect(clock.clueObject.position).toEqual(first.clueObject.position);
    expect(plate.position.y).toBeCloseTo(-0.32);
    expect(plate.position.z + halfDepth).toBeGreaterThan(-0.012);
    expect(plate.position.z - halfDepth).toBeCloseTo(-0.07, 2);
    clock.dispose();
    floor.dispose();
  });

  it('prefers the authored cauldron room when one is supplied', () => {
    const floor = buildFloorWorld(conservatoryPlan('DNGS80EC'));
    const near = floor.roomGroups[4].localToWorld(new THREE.Vector3(-3, 0, -3));
    const clock = StrikingClock.mount(floor, artKit(), 'DNGS80EC', false, [], 4, near);
    expect(clock).not.toBeNull();
    expect(clock?.room).toBe(4);
    expect(clock?.object.getWorldPosition(new THREE.Vector3()).distanceTo(near)).toBeLessThan(5);
    clock?.dispose();
    floor.dispose();
  });

  it('covers all twelve deterministic hours and matches clue and clock hands', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 96 && seen.size < 12; i++) {
      const seed = i.toString(32).padStart(8, '0').toUpperCase();
      const clock = new StrikingClock(world() as never, 0, 1, artKit(), seed);
      expect(clock.clueObject.getObjectByName('ClockClueHand')?.rotation.z).toBeCloseTo(
        -((clock.hour % 12) * Math.PI) / 6,
      );
      const inscription = clock.clueObject.getObjectByName('striking-clock-inscription');
      expect(inscription?.userData.labelText).toContain(`until ${clock.hour} o’clock`);
      expect(inscription?.userData.labelText).toContain('drawer');
      expect(Number.isFinite(clock.object.getObjectByName('ClockHourHand')?.rotation.z)).toBe(true);
      expect(Number.isFinite(clock.object.getObjectByName('ClockMinuteHand')?.rotation.z)).toBe(
        true,
      );
      seen.add(clock.hour);
      clock.dispose();
    }
    expect(seen.size).toBe(12);
  });

  it('requires the witness at strike, opens briefly, rejects late arrival, and sync hides permanently', () => {
    const fixture = world();
    const clock = new StrikingClock(fixture as never, 0, 1, artKit(), '0123ABCD');
    fixture.current = 0;
    clock.setWitness(1);
    expect(nextStrike(clock)).toBe(false);
    clock.setWitness(0);
    expect(nextStrike(clock)).toBe(true);
    const target = clock.object.getObjectByName('clock-ingredient');
    const drawer = clock.object.getObjectByName('ClockCompartment');
    expect(target?.visible).toBe(true);
    expect(drawer?.position.z).toBeGreaterThan(0);
    fixture.current = 1;
    expect(
      clock.near(target?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(), 1),
    ).toBeNull();
    clock.setWitness(0);
    clock.update(9);
    expect(target?.visible).toBe(false);
    clock.sync(true);
    fixture.current = 0;
    expect(
      clock.near(target?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3(), 1),
    ).toBeNull();
    expect(clock.ingredient).toBe(alchemyRecipe('0123ABCD')[1]);
    clock.dispose();
  });
});
