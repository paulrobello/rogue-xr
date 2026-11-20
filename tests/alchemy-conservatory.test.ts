import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { conservatoryPlan } from '../src/floor/conservatory.ts';
import { alchemyRecipe } from '../src/rules/alchemy.ts';
import { AlchemyConservatory, INGREDIENT_ROOTS } from '../src/world/alchemy-conservatory.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

function art(): THREE.Group {
  const root = new THREE.Group();
  const names = [
    'AlchemyCauldron',
    'PotionVial',
    'GrandfatherClock',
    'ThornWardLeft',
    'ThornWardRight',
    ...INGREDIENT_ROOTS.map((n) => `Ingredient${n}`),
    ...INGREDIENT_ROOTS.map((n) => `RecipeTile${n}`),
  ];
  for (const name of names) {
    const node = new THREE.Group();
    node.name = name;
    node.add(
      new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.12, 0.12),
        new THREE.MeshStandardMaterial({ color: 0x886644 }),
      ),
    );
    root.add(node);
  }
  return root;
}
function make(seed: string) {
  const world = buildFloorWorld(conservatoryPlan(seed));
  return { world, puzzle: new AlchemyConservatory(world, art(), seed, true) };
}

describe('alchemy conservatory authored puzzle', () => {
  it('uses stable distinct rooms and presents the seeded recipe in order', () => {
    const a = make('ALCH3MY1');
    const b = make('ALCH3MY1');
    expect(a.puzzle.cauldronRoom).not.toBe(a.puzzle.tabletRoom);
    expect(a.puzzle.cauldronRoom).toBe(b.puzzle.cauldronRoom);
    expect(a.puzzle.tabletRoom).toBe(b.puzzle.tabletRoom);
    const recipe = alchemyRecipe('ALCH3MY1');
    expect(
      a.puzzle.tablet.getObjectByName(`RecipeTile${INGREDIENT_ROOTS[recipe[0]]}Order1`),
    ).toBeTruthy();
    expect(
      a.puzzle.tablet.getObjectByName(`RecipeTile${INGREDIENT_ROOTS[recipe[1]]}Order2`),
    ).toBeTruthy();
    for (const name of INGREDIENT_ROOTS)
      expect(a.world.group.getObjectByName(`IngredientCradle${name}`)).toBeTruthy();
    a.puzzle.dispose();
    a.world.dispose();
    b.puzzle.dispose();
    b.world.dispose();
  });
  it('hides collected ingredients and keeps both ward leaves present', () => {
    const { world, puzzle } = make('ALCH3MY2');
    const found: THREE.Object3D[] = [];
    world.group.traverse((node) => {
      if (node.name.startsWith('FoundIngredient')) found.push(node);
    });
    expect(found).toHaveLength(2);
    const collected = alchemyRecipe('ALCH3MY2')[0];
    puzzle.sync({ found: [collected], added: [], brewed: false, opened: false }, true);
    expect(found.filter((node) => node.visible)).toHaveLength(1);
    world.current = puzzle.cauldronRoom;
    expect(puzzle.near(new THREE.Vector3(0, 0, 0), 0.01)).toBeNull();
    expect(puzzle.ward.getObjectByName('ThornWardLeft')).toBeTruthy();
    expect(puzzle.ward.getObjectByName('ThornWardRight')).toBeTruthy();
    puzzle.dispose();
    world.dispose();
  });
});
