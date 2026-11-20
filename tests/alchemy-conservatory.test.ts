import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { conservatoryPlan } from '../src/floor/conservatory.ts';
import { alchemyRecipe } from '../src/rules/alchemy.ts';
import { AlchemyConservatory, INGREDIENT_ROOTS } from '../src/world/alchemy-conservatory.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { kitPart } from '../src/world/puzzle-placement.ts';

function art(): THREE.Group {
  const root = new THREE.Group();
  const names = [
    'AlchemyCauldron',
    'PotionVial',
    'GrandfatherClock',
    'ClockClueDial',
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
    if (name === 'ClockClueDial') {
      const hand = new THREE.Group();
      hand.name = 'ClockClueHand';
      node.add(hand);
    }
    if (name === 'AlchemyCauldron') {
      for (const part of ['CauldronSwirl', ...[1, 2, 3, 4].map((i) => `CauldronBubble${i}`)]) {
        const child = new THREE.Group();
        child.name = part;
        child.position.y = 0.657;
        node.add(child);
      }
    }
    root.add(node);
  }
  return root;
}
function make(seed: string, reducedMotion = true) {
  const world = buildFloorWorld(conservatoryPlan(seed));
  return { world, puzzle: new AlchemyConservatory(world, art(), seed, reducedMotion) };
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
  it('simmers with independent bubbles and carries both ingredients from tray to liquid before showing the potion', () => {
    const { world, puzzle } = make('ALCH3MY1', false);
    world.current = puzzle.cauldronRoom;
    world.roomGroups[world.current].visible = true;
    const recipe = alchemyRecipe('ALCH3MY1');
    const state = { found: [...recipe], added: [], brewed: false, opened: false };
    puzzle.sync(state, true);
    const ingredients = recipe.map((id) =>
      kitPart(world.group, `IngredientCradle${INGREDIENT_ROOTS[id]}`),
    );
    const home = ingredients.map((n) => n.position.clone());
    const swirl = kitPart(puzzle.cauldron, 'CauldronSwirl');
    const bubbles = [1, 2, 3, 4].map((i) => kitPart(puzzle.cauldron, `CauldronBubble${i}`));
    puzzle.sync({ ...state, added: [recipe[0]] });
    puzzle.animateIngredient(recipe[0]);
    puzzle.update(0.35);
    expect(swirl.rotation.y).toBeGreaterThan(0.2);
    expect(new Set(bubbles.map((b) => b.position.y)).size).toBe(4);
    expect(ingredients[0].position.y - home[0].y).toBeGreaterThan(0.3);
    expect(ingredients[0].position.z).toBeLessThan(home[0].z - 0.1);
    expect(puzzle.near(ingredients[0].getWorldPosition(new THREE.Vector3()), 0.02)).toBeNull();
    puzzle.sync({ ...state, added: [...recipe], brewed: true });
    puzzle.animateIngredient(recipe[1]);
    puzzle.update(0.45);
    expect(ingredients.every((n) => n.visible)).toBe(true);
    expect(Math.abs(ingredients[0].position.z - puzzle.cauldron.position.z)).toBeLessThan(0.02);
    expect(puzzle.potion.visible).toBe(false);
    puzzle.update(0.5);
    expect(ingredients.every((n) => !n.visible)).toBe(true);
    expect(puzzle.potion.visible).toBe(true);
    puzzle.dispose();
    world.dispose();
  });
  it('settles mistaken ingredients back on the tray and never replays a saved addition', () => {
    const { world, puzzle } = make('ALCH3MY1');
    world.current = puzzle.cauldronRoom;
    const node = kitPart(world.group, 'IngredientCradleMooncap');
    const home = node.position.clone();
    const state = { found: [0 as const], added: [], brewed: false, opened: false };
    puzzle.sync(state);
    puzzle.animateIngredient(0);
    puzzle.update(0.15);
    expect(node.visible).toBe(true);
    expect(Math.abs(node.position.z - puzzle.cauldron.position.z)).toBeLessThan(0.01);
    expect(kitPart(puzzle.cauldron, 'CauldronSwirl').rotation.y).toBe(0);
    puzzle.update(0.4);
    expect(node.position).toEqual(home);
    expect(node.visible).toBe(true);
    puzzle.animateIngredient(0);
    puzzle.sync({ ...state, added: [0] }, true);
    expect(node.visible).toBe(false);
    expect(node.position).toEqual(home);
    puzzle.sync(state);
    puzzle.animateIngredient(0);
    world.current = puzzle.tabletRoom;
    puzzle.update(0.01);
    world.current = puzzle.cauldronRoom;
    expect(node.position).toEqual(home);
    expect(node.visible).toBe(true);
    puzzle.dispose();
    world.dispose();
  });
});
