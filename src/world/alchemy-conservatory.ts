import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import { alchemyRecipe, type Ingredient, type StoredAlchemyState } from '../rules/alchemy.ts';
import type { FloorWorld } from './floor-world.ts';
import { findPuzzleMount, kitPart } from './puzzle-placement.ts';

export const INGREDIENT_ROOTS = ['Mooncap', 'StarThistle', 'EmberSalt'] as const;
export type AlchemyPick = (
  | { action: 'collect' | 'add'; ingredient: Ingredient }
  | { action: 'apply' }
) & { distance: number };
type Input = { action: 'collect' | 'add'; ingredient: Ingredient } | { action: 'apply' };

export class AlchemyConservatory {
  readonly cauldron: THREE.Object3D;
  readonly tablet: THREE.Group;
  readonly potion: THREE.Object3D;
  readonly ward: THREE.Group;
  readonly cauldronRoom: number;
  readonly tabletRoom: number;
  private readonly leaves: THREE.Object3D[] = [];
  private readonly targets: { node: THREE.Object3D; room: number; input: Input }[] = [];
  private readonly fixtures: THREE.Object3D[] = [];
  private readonly boxes: (() => void)[] = [];
  private readonly ray = new THREE.Raycaster();
  private readonly cube = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly owned = new Set<THREE.BufferGeometry>();
  private opened = false;
  private progress = 0;
  private readonly bronze: THREE.Material;
  private readonly wood: THREE.Material;

  constructor(
    private readonly world: FloorWorld,
    private readonly art: THREE.Object3D,
    seed: string,
    private readonly reducedMotion: boolean,
  ) {
    const source = (name: string) => {
      let mat: THREE.Material | undefined;
      art.traverse((n) => {
        if (n instanceof THREE.Mesh && !Array.isArray(n.material) && n.material.name === name)
          mat = n.material;
      });
      return mat;
    };
    this.bronze = source('Alchemical brass') ?? this.firstMaterial('PotionVial');
    this.wood = source('Clock case walnut') ?? this.firstMaterial('GrandfatherClock');
    const shuffled = Stream.fromKey(seed + ':alchemy-bays').shuffle([0, 1, 2, 3, 4]);
    const recipe = alchemyRecipe(seed);
    const decoy = ([0, 1, 2] as const).find((id) => !recipe.includes(id))!;
    this.cauldronRoom = shuffled[0];
    this.tabletRoom = shuffled[1];
    const lab = this.bay(this.cauldronRoom, 'brew-bench', 1.15);
    this.cauldron = this.clone('AlchemyCauldron');
    this.cauldron.position.set(0, 0, 0.54);
    lab.add(this.cauldron);
    const keyLight = new THREE.PointLight(0xffcd93, 4.0, 3.4, 2);
    keyLight.position.set(-0.72, 1.6, 1.03);
    lab.add(keyLight);
    const tray = this.block(lab, 1.05, 0.06, 0.27, 0, 0.52, 1.04, this.wood);
    this.block(lab, 1.08, 0.025, 0.3, 0, 0.56, 1.04, this.bronze);
    for (const x of [-0.44, 0.44]) this.block(lab, 0.05, 0.51, 0.06, x, 0.255, 1.04, this.bronze);
    for (const id of [0, 1, 2] as const) {
      const ingredient = this.clone('Ingredient' + INGREDIENT_ROOTS[id]);
      ingredient.name = 'IngredientCradle' + INGREDIENT_ROOTS[id];
      ingredient.position.set((id - 1) * 0.34, 0.58, 1.04);
      lab.add(ingredient);
      this.targets.push({
        node: ingredient,
        room: this.cauldronRoom,
        input: { action: 'add', ingredient: id },
      });
    }
    this.potion = this.clone('PotionVial');
    this.potion.name = 'PocketedPotion';
    this.potion.position.set(0, 0.58, 1.04);
    lab.add(this.potion);
    this.registerBox(this.cauldronRoom, lab);
    this.tablet = this.bay(this.tabletRoom, 'recipe-tablet', 0.42);
    this.tablet.name = 'RecipeTablet';
    this.block(this.tablet, 0.83, 0.48, 0.062, 0, 1.43, 0.045, this.bronze);
    this.block(this.tablet, 0.79, 0.44, 0.04, 0, 1.43, 0.093, this.wood);
    recipe.forEach((id, i) => {
      const tile = this.clone('RecipeTile' + INGREDIENT_ROOTS[id]);
      tile.name = 'RecipeTile' + INGREDIENT_ROOTS[id] + 'Order' + (i + 1);
      tile.userData.recipeOrder = i + 1;
      tile.position.set((i - 0.5) * 0.36, 1.46, 0.125);
      tile.scale.setScalar(1.38);
      tile.rotation.x = Math.PI / 2;
      this.tablet.add(tile);
      for (let k = 0; k <= i; k++)
        this.block(
          this.tablet,
          0.014,
          0.057,
          0.016,
          (i - 0.5) * 0.36 + (k - i / 2) * 0.031,
          1.27,
          0.127,
          this.bronze,
        );
    });
    [recipe[0], decoy].forEach((id, i) => {
      const room = shuffled[i + 2],
        stand = this.bay(room, 'specimen-' + id, 0.33);
      this.block(stand, 0.52, 0.07, 0.43, 0, 0.9, 0.33, this.wood);
      this.block(stand, 0.54, 0.018, 0.45, 0, 0.949, 0.33, this.bronze);
      for (const x of [-0.2, 0.2]) this.block(stand, 0.045, 0.88, 0.25, x, 0.44, 0.32, this.wood);
      const plant = this.clone('Ingredient' + INGREDIENT_ROOTS[id]);
      plant.name = 'FoundIngredient' + INGREDIENT_ROOTS[id];
      plant.position.set(0, 0.96, 0.34);
      stand.add(plant);
      this.targets.push({ node: plant, room, input: { action: 'collect', ingredient: id } });
      this.registerBox(room, stand);
    });
    const edge = world.plan.connections.find((c) => c.puzzleGate === 'thorn')!;
    const endpoint = edge[0],
      door = world.rooms[endpoint.room].doors.find((d) => d.id === endpoint.door)!;
    this.ward = new THREE.Group();
    this.ward.name = 'ThornWard';
    this.ward.position.set(door.world[0], 0, door.world[1]);
    this.ward.rotation.y = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 }[door.facing];
    for (const [side, sign] of [
      ['Left', -1],
      ['Right', 1],
    ] as const) {
      const leaf = this.clone('ThornWard' + side);
      leaf.position.x = sign * 0.8;
      this.ward.add(leaf);
      this.leaves.push(leaf);
    }
    const seal = this.clone('RecipeTileStarThistle');
    seal.name = 'ThornWardSeal';
    seal.rotation.x = Math.PI / 2;
    seal.scale.setScalar(1.65);
    seal.position.set(0, 1.15, 0.14);
    this.ward.add(seal);
    world.roomGroups[endpoint.room].attach(this.ward);
    this.fixtures.push(this.ward);
    this.targets.push({ node: seal, room: endpoint.room, input: { action: 'apply' } });
    this.sync({ found: [], added: [], brewed: false, opened: false }, true);
    tray.name = 'alchemy-mixing-tray';
  }
  private clone(name: string): THREE.Object3D {
    return kitPart(this.art, name).clone(true);
  }
  private firstMaterial(root: string): THREE.Material {
    let result: THREE.Material | undefined;
    this.art.getObjectByName(root)?.traverse((n) => {
      if (!result && n instanceof THREE.Mesh)
        result = Array.isArray(n.material) ? n.material[0] : n.material;
    });
    if (!result) throw Error('Missing alchemy surface ' + root);
    return result;
  }
  private bay(room: number, key: string, width: number): THREE.Group {
    const m = findPuzzleMount(this.world, [room], [], key, width, 1.5);
    if (!m) throw Error('No clear alchemy site for ' + key);
    const group = new THREE.Group();
    group.name = key;
    group.position.copy(m.center);
    group.position.y = 0;
    group.rotation.y = m.yaw;
    this.world.roomGroups[room].add(group);
    this.fixtures.push(group);
    return group;
  }
  private block(
    parent: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
  ): THREE.Mesh {
    const g = new THREE.BoxGeometry(w, h, d);
    this.owned.add(g);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  }
  private registerBox(room: number, o: THREE.Object3D): void {
    o.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(o);
    this.boxes.push(
      this.world.addFixtureCollider(room, { min: box.min.toArray(), max: box.max.toArray() }),
    );
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): AlchemyPick | null {
    this.ray.set(origin, direction);
    this.ray.far = 4;
    let nearest: AlchemyPick | null = null;
    for (const { node, room, input } of this.targets) {
      if (room !== this.world.current || !node.visible) continue;
      node.updateWorldMatrix(true, true);
      const hit = this.ray.intersectObject(node, true)[0];
      if (!hit || (nearest && hit.distance >= nearest.distance)) continue;
      const blocked = this.world.colliders[room].some((b) => {
        this.cube.min.fromArray(b.min);
        this.cube.max.fromArray(b.max);
        return (
          !this.cube.containsPoint(hit.point) &&
          this.ray.ray.intersectBox(this.cube, this.point) !== null &&
          this.point.distanceTo(origin) < hit.distance - 0.035
        );
      });
      if (!blocked) nearest = { ...input, distance: hit.distance };
    }
    return nearest;
  }
  near(point: THREE.Vector3, reach: number): AlchemyPick | null {
    for (const { node, room, input } of this.targets) {
      if (room !== this.world.current || !node.visible) continue;
      node.updateWorldMatrix(true, true);
      const d = this.cube.setFromObject(node).distanceToPoint(point);
      if (d <= reach) return { ...input, distance: d };
    }
    return null;
  }
  sync(state: StoredAlchemyState, immediate = false): void {
    this.opened = state.opened;
    for (const { node, input } of this.targets)
      node.visible =
        input.action === 'collect'
          ? !state.found.includes(input.ingredient)
          : input.action === 'add'
            ? state.found.includes(input.ingredient) &&
              !state.added.includes(input.ingredient) &&
              !state.brewed
            : !state.opened;
    this.potion.visible = state.brewed && !state.opened;
    if (immediate || this.reducedMotion) {
      this.progress = Number(this.opened);
      this.poseWard();
    }
  }
  private poseWard() {
    this.leaves[0].rotation.y = (this.progress * Math.PI) / 2;
    this.leaves[1].rotation.y = (-this.progress * Math.PI) / 2;
  }
  update(dt: number): void {
    if (this.opened && this.progress < 1) {
      this.progress = Math.min(1, this.progress + dt * 1.35);
      this.poseWard();
    }
  }
  dispose(): void {
    for (const remove of this.boxes) remove();
    for (const root of this.fixtures) root.removeFromParent();
    for (const g of this.owned) g.dispose();
  }
}
