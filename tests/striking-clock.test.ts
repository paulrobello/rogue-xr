import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { alchemyRecipe } from '../src/rules/alchemy.ts';
import { INGREDIENT_ROOTS } from '../src/world/alchemy-conservatory.ts';
import { CLOCK_CYCLE, StrikingClock } from '../src/world/striking-clock.ts';

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
  it('covers all twelve deterministic hours and matches clue and clock hands', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 96 && seen.size < 12; i++) {
      const seed = i.toString(32).padStart(8, '0').toUpperCase();
      const clock = new StrikingClock(world() as never, 0, 1, artKit(), seed);
      expect(clock.clueObject.getObjectByName('ClockClueHand')?.rotation.z).toBeCloseTo(
        -((clock.hour % 12) * Math.PI) / 6,
      );
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
