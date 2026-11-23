// @vitest-environment node
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CONSERVATORY_SPECIMENS_VERSION } from '../src/combat/encounter-choice.ts';
import { conservatoryPlan } from '../src/floor/conservatory.ts';
import { DECOR_TABLES } from '../src/floor/table-decor.ts';
import { alchemyRecipe, conservatoryFormula } from '../src/rules/alchemy.ts';
import { AlchemyConservatory, INGREDIENT_ROOTS } from '../src/world/alchemy-conservatory.ts';
import { mountFloorView } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';
import { kitPart } from '../src/world/puzzle-placement.ts';
import { roomStyleKitFromScene } from '../src/world/room-styles.ts';
import { nodeGeometryLoader } from './helpers/gltf-node.ts';

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
    for (const name of INGREDIENT_ROOTS.slice(0, 3))
      expect(a.world.group.getObjectByName(`IngredientCradle${name}`)).toBeTruthy();
    expect(a.world.group.getObjectByName('stillwind-lab-dial')).toBeUndefined();
    a.puzzle.dispose();
    a.world.dispose();
    b.puzzle.dispose();
    b.world.dispose();
  });
  it('dresses both new specimens only on versions that can collect them', async () => {
    const bytes = Uint8Array.from(
      await readFile('public/assets/props/conservatory-specimens/conservatory-specimens.glb'),
    );
    const specimens = (await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene;
    const withSpecimens = art();
    for (const name of INGREDIENT_ROOTS.slice(3)) {
      for (const prefix of ['Ingredient', 'RecipeTile']) {
        withSpecimens.getObjectByName(prefix + name)?.removeFromParent();
      }
    }
    withSpecimens.add(specimens);
    for (const version of [CONSERVATORY_SPECIMENS_VERSION - 1, CONSERVATORY_SPECIMENS_VERSION]) {
      const seed = 'MAPTEST2';
      const world = buildFloorWorld(conservatoryPlan(seed));
      const puzzle = new AlchemyConservatory(world, withSpecimens, seed, true, [], version);
      const expanded = version === CONSERVATORY_SPECIMENS_VERSION;
      expect(Boolean(world.group.getObjectByName('conservatory-specimen-stand'))).toBe(expanded);
      for (const name of INGREDIENT_ROOTS.slice(3)) {
        expect(Boolean(world.group.getObjectByName('FoundIngredient' + name))).toBe(expanded);
        expect(Boolean(world.group.getObjectByName('IngredientCradle' + name))).toBe(expanded);
        expect(specimens.getObjectByName('RecipeTile' + name)).toBeDefined();
      }
      puzzle.dispose();
      world.dispose();
    }
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
  it.each(['00000007', 'MAPTEST2'])('fits the dressed Stillwind lab on %s', async (seed) => {
    const load = async (path: string) => {
      const bytes = Uint8Array.from(await readFile(path));
      return (await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene;
    };
    const [hall, finishes, alchemy] = await Promise.all([
      load('public/assets/rooms/hall/hall.glb'),
      load('public/assets/props/architectural-finishes/architectural-finishes.glb'),
      load('public/assets/props/alchemy-kit/alchemy-kit.glb'),
    ]);
    const view = mountFloorView(new THREE.Scene(), new THREE.Group(), seed, { floorNumber: 3 });
    view.useRoomAsset('hall', () => hall.clone(true), [], roomStyleKitFromScene(finishes));
    const { world } = view;
    const puzzle = new AlchemyConservatory(world, alchemy, seed, false);
    const lab = kitPart(world.group, 'brew-bench');
    const room = world.roomGroups[puzzle.cauldronRoom];
    const labBounds = new THREE.Box3().setFromObject(lab);
    const toLab = lab.matrixWorld.clone().invert();
    const cauldronBounds = new THREE.Box3().setFromObject(puzzle.cauldron).applyMatrix4(toLab);
    const trayBounds = new THREE.Box3()
      .setFromObject(kitPart(lab, 'alchemy-tray-top'))
      .applyMatrix4(toLab);
    expect(trayBounds.min.z - cauldronBounds.max.z).toBeGreaterThan(0.04);
    world.current = puzzle.cauldronRoom;
    const ingredient = alchemyRecipe(seed)[0];
    puzzle.sync({ found: [ingredient], added: [], brewed: false, opened: false }, true);
    const cradle = kitPart(lab, `IngredientCradle${INGREDIENT_ROOTS[ingredient]}`);
    const target = new THREE.Box3().setFromObject(cradle).getCenter(new THREE.Vector3());
    const rayOrigin = target
      .clone()
      .addScaledVector(lab.getWorldDirection(new THREE.Vector3()), 0.8);
    expect(puzzle.pick(rayOrigin, target.sub(rayOrigin).normalize())).toMatchObject({
      action: 'add',
      ingredient,
    });
    for (const { x, z, halfX, halfZ, top } of DECOR_TABLES.hall) {
      const bench = new THREE.Box3(
        new THREE.Vector3(x - halfX, 0, z - halfZ),
        new THREE.Vector3(x + halfX, top, z + halfZ),
      ).applyMatrix4(room.matrixWorld);
      expect(labBounds.intersectsBox(bench)).toBe(false);
    }
    const dial = kitPart(lab, 'stillwind-lab-dial');
    const needle = kitPart(dial, 'ClockClueHand');
    expect(dial.visible).toBe(true);
    expect(kitPart(lab, 'stillwind-dial-inscription').userData.labelText).toContain('Stillwind');
    expect(new THREE.Box3().setFromObject(dial).min.y).toBeGreaterThan(
      new THREE.Box3().setFromObject(puzzle.cauldron).max.y,
    );
    const face = needle.getWorldPosition(new THREE.Vector3());
    const outward = dial.getWorldDirection(new THREE.Vector3());
    const ray = new THREE.Raycaster(
      face.clone().addScaledVector(outward, 1.1),
      outward.clone().negate(),
      0,
      1.35,
    );
    const front = ray.intersectObject(dial, true)[0];
    const roomHit = ray.intersectObject(room, true)[0];
    expect(front).toBeDefined();
    expect(roomHit?.object).toBe(front.object);
    const quiet = conservatoryFormula(seed).quietHour;
    puzzle.update(0, quiet + 0.5);
    expect(needle.rotation.z).toBeCloseTo((-(quiet + 0.5) * Math.PI) / 6);
    expect(puzzle.inStillInterval).toBe(true);
    puzzle.update(0, quiet + 2);
    expect(puzzle.inStillInterval).toBe(false);
    puzzle.dispose();
    view.dispose();
  });
  it('flies the claimed field specimen to a moving camera, outside reach of the eyes and without another hit', () => {
    const seed = 'ALCH3MY1';
    const { world, puzzle } = make(seed, false);
    const id = alchemyRecipe(seed)[0];
    const name = `FoundIngredient${INGREDIENT_ROOTS[id]}`;
    world.current = world.roomGroups.findIndex((group) => group.getObjectByName(name));
    const source = kitPart(world.roomGroups[world.current], name);
    const start = source.getWorldPosition(new THREE.Vector3());
    const camera = new THREE.PerspectiveCamera();
    camera.position.copy(start).add(new THREE.Vector3(0, 0.55, 2));
    puzzle.sync({ found: [id], added: [], brewed: false, opened: false });
    puzzle.animatePickup(id, camera);
    const flight = kitPart(world.group, `alchemy-pickup-${INGREDIENT_ROOTS[id]}`);
    expect(flight.visible).toBe(true);
    expect(flight.position.distanceTo(start)).toBeLessThan(0.001);
    expect(puzzle.near(start, 0.1)).toBeNull();
    puzzle.update(0.29);
    expect(flight.position.distanceTo(start)).toBeGreaterThan(0.55);
    expect(puzzle.near(flight.position, 0.1)).toBeNull();
    camera.position.x += 0.5;
    puzzle.update(0.3);
    expect(flight.position.x - start.x).toBeGreaterThan(0.3);
    expect(flight.position.distanceTo(camera.position)).toBeGreaterThan(0.3);
    puzzle.update(0.04);
    expect(flight.parent).toBeNull();
    expect(source.visible).toBe(false);
    puzzle.dispose();
    world.dispose();
  });
  it('starts the clock pickup at the scaled drawer socket and keeps reduced-motion feedback in place', () => {
    const { world, puzzle } = make('ALCH3MY1');
    const hand = new THREE.Group();
    hand.position.set(-1, 1.1, 2);
    const drawer = new THREE.Group();
    drawer.position.set(0.28, 0.8, -0.3);
    drawer.rotation.y = 0.4;
    world.roomGroups[world.current].add(drawer);
    const source = kitPart(art(), 'IngredientMooncap');
    source.position.z = 0.08;
    source.scale.setScalar(0.75);
    source.visible = false;
    drawer.add(source);
    puzzle.animatePickup(0, hand, source);
    const flight = kitPart(world.group, 'alchemy-pickup-Mooncap');
    const start = source.getWorldPosition(new THREE.Vector3());
    expect(flight.getWorldPosition(new THREE.Vector3()).distanceTo(start)).toBeLessThan(0.001);
    expect(flight.scale.x).toBeCloseTo(0.75);
    puzzle.update(0.1);
    expect(flight.position.distanceTo(start)).toBeLessThan(0.001);
    expect(flight.scale.x).toBeLessThan(0.6);
    puzzle.sync({ found: [0], added: [], brewed: false, opened: false }, true);
    expect(flight.parent).toBeNull();
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
    expect(ingredients[0].position.y - swirl.position.y).toBeGreaterThan(0.55);
    expect(ingredients[0].position.z).toBeLessThan(home[0].z - 0.1);
    expect(puzzle.near(ingredients[0].getWorldPosition(new THREE.Vector3()), 0.02)).toBeNull();
    puzzle.sync({ ...state, added: [...recipe], brewed: true });
    puzzle.animateIngredient(recipe[1]);
    puzzle.update(0.45);
    expect(ingredients.every((n) => n.visible)).toBe(true);
    expect(ingredients[1].position.y - swirl.position.y).toBeGreaterThan(0.55);
    expect(Math.abs(ingredients[0].position.z - puzzle.cauldron.position.z)).toBeLessThan(0.02);
    expect(puzzle.potion.visible).toBe(false);
    puzzle.update(0.5);
    expect(ingredients.every((n) => !n.visible)).toBe(true);
    expect(puzzle.potion.visible).toBe(true);
    const vialCenter = puzzle.potion.getWorldPosition(new THREE.Vector3());
    expect(puzzle.near(vialCenter, 0.02)?.action).toBe('take-potion');
    puzzle.sync({ ...state, added: [...recipe], brewed: true, carried: true }, true);
    expect(puzzle.potion.visible).toBe(false);
    expect(puzzle.near(vialCenter, 0.02)).toBeNull();
    puzzle.animatePotionPickup(new THREE.PerspectiveCamera());
    expect(world.group.getObjectByName('alchemy-pickup-potion')).toBeDefined();
    puzzle.update(1);
    expect(world.group.getObjectByName('alchemy-pickup-potion')).toBeUndefined();
    puzzle.dispose();
    world.dispose();
  });
  it('keeps recipe-specific vial colors through Continue and pickup without tinting the shared kit', async () => {
    const bytes = Uint8Array.from(
      await readFile('public/assets/props/alchemy-kit/alchemy-kit.glb'),
    );
    const kit = (await nodeGeometryLoader().parseAsync(bytes.buffer, '')).scene;
    const glass = (vial: THREE.Object3D): THREE.MeshStandardMaterial => {
      for (const node of vial.getObjectsByProperty('isMesh', true)) {
        const material = (node as THREE.Mesh).material;
        if (material instanceof THREE.MeshStandardMaterial && material.name === 'Potion glass')
          return material;
      }
      throw Error('Missing vial glass');
    };
    const source = glass(kitPart(kit, 'PotionVial'));
    const originalColor = source.emissive.getHex();
    const tints = new Set<number>();
    for (const seed of ['N0TE0032', 'MAPTEST2', 'BREW0001']) {
      const world = buildFloorWorld(conservatoryPlan(seed));
      const puzzle = new AlchemyConservatory(world, kit, seed, true);
      const plan = conservatoryFormula(seed);
      const recipe = alchemyRecipe(seed);
      const brewed = { found: [...recipe], added: [...recipe], brewed: true, opened: false };
      puzzle.sync(brewed, true);
      const primary = glass(puzzle.potion);
      tints.add(primary.emissive.getHex());
      expect(primary).not.toBe(source);

      puzzle.animatePotionPickup(new THREE.PerspectiveCamera());
      const pickup = kitPart(world.group, 'alchemy-pickup-potion');
      puzzle.sync({ ...brewed, opened: true }, false, {
        recipe: plan.recipe,
        clues: ['portrait', 'record'],
        added: plan.ingredients,
        brewed: true,
        revealed: false,
        opened: false,
      });
      const archive = glass(puzzle.potion);
      expect(archive).not.toBe(primary);
      tints.add(archive.emissive.getHex());
      expect(glass(pickup)).toBe(primary);
      expect(source.emissive.getHex()).toBe(originalColor);
      puzzle.dispose();
      world.dispose();
    }
    expect(tints.size).toBe(4);
  });

  it.each([false, true])(
    'throws one vial and applies its effect only on impact (reduced motion %s)',
    (reduced) => {
      const { world, puzzle } = make('ALCH3MY1', reduced);
      const thrower = new THREE.Object3D();
      const target = new THREE.Vector3(3, 1, 0);
      thrower.position.set(0, 1, 0);
      let impacts = 0;
      const impact = () => {
        impacts++;
      };
      puzzle.throwPotion(thrower, target, impact);
      puzzle.throwPotion(thrower, target, impact);
      const flight = kitPart(world.group, 'alchemy-thrown-potion');
      expect(world.group.children.filter(({ name }) => name === flight.name)).toHaveLength(1);
      puzzle.update(0.09);
      expect(flight.position.x).toBeGreaterThan(0.2);
      expect(flight.position.x).toBeLessThan(2.9);
      expect(flight.position.y).toBeGreaterThanOrEqual(1);
      expect(impacts).toBe(0);
      puzzle.update(1);
      expect(flight.position).toEqual(target);
      expect(flight.parent).toBeNull();
      puzzle.update(1);
      expect(impacts).toBe(1);

      puzzle.throwPotion(thrower, target, impact);
      world.current = (world.current + 1) % world.rooms.length;
      puzzle.update(1);
      expect(world.group.getObjectByName('alchemy-thrown-potion')).toBeUndefined();
      expect(impacts).toBe(1);
      puzzle.dispose();
      world.dispose();
    },
  );

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
