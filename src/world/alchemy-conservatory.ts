import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import { DECOR_TABLES } from '../floor/table-decor.ts';
import { flightGoal, flightPose, flightScale } from '../flow/card-flight.ts';
import {
  alchemyRecipe,
  conservatoryFormula,
  type FollowupRecipe,
  type Ingredient,
  ingredientsFor,
  NEW_SPECIMENS,
  type StoredAlchemyState,
  type StoredConservatoryFormula,
} from '../rules/alchemy.ts';
import { ClockInscription } from './clock-inscription.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart } from './puzzle-placement.ts';

export const INGREDIENT_ROOTS = [
  'Mooncap',
  'StarThistle',
  'EmberSalt',
  'Bellcap',
  'Silverleaf',
] as const;
const POTION_COLORS: Readonly<Record<'thornwake' | FollowupRecipe, number>> = {
  thornwake: 0x73bb49,
  'lantern-ink': 0x4d84ea,
  stillwind: 0xf48624,
  'looking-glass': 0xd566da,
};

function tintVial(source: THREE.MeshStandardMaterial, color: number): THREE.MeshStandardMaterial {
  const material = source.clone();
  material.emissive.setHex(color);
  material.emissiveIntensity = 0.24;
  // Undo the pigment in the GLB's base-color map while keeping its painted bands and grain.
  const { r, g, b } = material.emissive;
  material.color.setRGB(r / 0.16, g / 0.55, b / 0.48);
  return material;
}

const HALL_BENCHES = DECOR_TABLES.hall.map(
  ({ x, z, halfX, halfZ, top }) =>
    new THREE.Box3(
      new THREE.Vector3(x - halfX, 0, z - halfZ),
      new THREE.Vector3(x + halfX, top, z + halfZ),
    ),
);
type Input =
  | { action: 'collect' | 'add'; ingredient: Ingredient }
  | { action: 'apply' }
  | { action: 'take-potion' };
export type AlchemyPick = Input & { distance: number };
interface Cradle {
  node: THREE.Object3D;
  home: THREE.Vector3;
  available: boolean;
  flight: number | null;
}
interface PickupFlight {
  node: THREE.Object3D;
  collector: THREE.Object3D;
  start: THREE.Vector3;
  scale: THREE.Vector3;
  room: number;
  time: number;
}

export class AlchemyConservatory {
  readonly cauldron: THREE.Object3D;
  readonly tablet: THREE.Group;
  readonly potion: THREE.Object3D;
  readonly ward: THREE.Group;
  readonly cauldronRoom: number;
  readonly tabletRoom: number;
  private readonly leaves: THREE.Object3D[] = [];
  private readonly cradles: Cradle[] = [];
  private readonly pickups = new Set<PickupFlight>();
  private readonly swirl: THREE.Object3D;
  private readonly bubbles: THREE.Object3D[];
  private simmer = 0;
  private splash = 0;
  private potionReady = false;
  private readonly vialGlass: {
    mesh: THREE.Mesh;
    thornwake: THREE.MeshStandardMaterial;
    archive: THREE.MeshStandardMaterial;
  }[] = [];
  private readonly targets: { node: THREE.Object3D; room: number; input: Input }[] = [];
  private readonly fixtures: THREE.Object3D[] = [];
  private readonly boxes: (() => void)[] = [];
  private readonly ray = new THREE.Raycaster();
  private readonly cube = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly smallTargetHit = new THREE.Vector3();
  private readonly owned = new Set<THREE.BufferGeometry>();
  private opened = false;
  private progress = 0;
  private windInscription?: ClockInscription;
  private windNeedle: THREE.Object3D | null = null;
  private readonly quietHour: number;
  private still = false;
  get inStillInterval(): boolean {
    return this.still;
  }
  private readonly bronze: THREE.Material;
  private readonly wood: THREE.Material;

  constructor(
    private readonly world: FloorWorld,
    private readonly art: THREE.Object3D,
    seed: string,
    private readonly reducedMotion: boolean,
    private readonly placements: readonly InteriorPlacement[] = [],
    contentVersion = 1,
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
    const followup = conservatoryFormula(seed, contentVersion);
    const ingredients = ingredientsFor(contentVersion);
    const expanded = ingredients.length > 3;
    this.quietHour = followup.quietHour;
    const decoy = ([0, 1, 2] as const).find((id) => !recipe.includes(id))!;
    this.cauldronRoom = shuffled[0];
    this.tabletRoom = shuffled[1];
    const lab = this.bay(this.cauldronRoom, 'brew-bench', 0.95, 1.55);
    this.cauldron = this.clone('AlchemyCauldron');
    this.cauldron.position.set(0, 0, 0.54);
    this.swirl = kitPart(this.cauldron, 'CauldronSwirl');
    this.bubbles = [1, 2, 3, 4].map((i) => kitPart(this.cauldron, `CauldronBubble${i}`));
    lab.add(this.cauldron);
    const keyLight = new THREE.PointLight(0xffcd93, 4.0, 3.4, 2);
    keyLight.position.set(-0.72, 1.6, 1.03);
    lab.add(keyLight);
    const trayZ = 1.22;
    const trayWidth = expanded ? 1.23 : 1.05;
    const tray = this.block(lab, trayWidth, 0.06, 0.27, 0, 0.52, trayZ, this.wood);
    this.block(lab, trayWidth + 0.03, 0.025, 0.3, 0, 0.56, trayZ, this.bronze).name =
      'alchemy-tray-top';
    const leg = trayWidth / 2 - 0.085;
    for (const x of [-leg, leg]) this.block(lab, 0.05, 0.51, 0.06, x, 0.255, trayZ, this.bronze);
    for (const id of ingredients) {
      const ingredient = this.clone('Ingredient' + INGREDIENT_ROOTS[id]);
      ingredient.name = 'IngredientCradle' + INGREDIENT_ROOTS[id];
      ingredient.position.set(
        expanded ? (id - 2) * 0.245 : (id - 1) * 0.34,
        id >= NEW_SPECIMENS[0] ? 0.5725 : 0.58,
        trayZ,
      );
      this.cradles.push({
        node: ingredient,
        home: ingredient.position.clone(),
        available: false,
        flight: null,
      });
      lab.add(ingredient);
      this.targets.push({
        node: ingredient,
        room: this.cauldronRoom,
        input: { action: 'add', ingredient: id },
      });
    }
    this.potion = this.clone('PotionVial');
    this.potion.name = 'BrewedPotion';
    this.potion.traverse((mesh) => {
      if (
        !(mesh instanceof THREE.Mesh) ||
        !(mesh.material instanceof THREE.MeshStandardMaterial) ||
        mesh.material.name !== 'Potion glass'
      )
        return;
      this.vialGlass.push({
        mesh,
        thornwake: tintVial(mesh.material, POTION_COLORS.thornwake),
        archive: tintVial(mesh.material, POTION_COLORS[followup.recipe]),
      });
    });
    this.potion.position.set(0, 0.558, trayZ);
    lab.add(this.potion);
    this.targets.push({
      node: this.potion,
      room: this.cauldronRoom,
      input: { action: 'take-potion' },
    });
    if (followup.recipe === 'stillwind') {
      const dial = this.clone('ClockClueDial');
      dial.name = 'stillwind-lab-dial';
      dial.position.set(-0.55, 1.28, 0.42);
      this.windNeedle = kitPart(dial, 'ClockClueHand');
      this.block(lab, 0.07, 1.28, 0.065, -0.55, 0.64, 0.32, this.wood);
      this.block(lab, 0.23, 0.045, 0.22, -0.55, 0.0225, 0.32, this.bronze);
      lab.add(dial);
      this.windInscription = new ClockInscription(
        'stillwind-dial-inscription',
        0.65,
        'Stillwind Tincture',
        'Read the wind chart',
        'for the starting hour.',
      );
      this.windInscription.object.position.set(-0.55, 0.96, 0.36);
      lab.add(this.windInscription.object);
    }
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
    this.placeSpecimens(shuffled[2], 'specimen-' + recipe[0], [recipe[0]]);
    this.placeSpecimens(shuffled[3], 'specimen-' + decoy, [decoy]);
    if (expanded) this.placeSpecimens(shuffled[4], 'conservatory-specimen-stand', NEW_SPECIMENS);
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
  private placeSpecimens(room: number, key: string, specimens: readonly Ingredient[]): void {
    const width = specimens.length > 1 ? 0.6 : 0.52;
    const stand = this.bay(room, key, width / 2 + 0.07);
    this.block(stand, width, 0.07, 0.43, 0, 0.9, 0.33, this.wood);
    this.block(stand, width + 0.02, 0.018, 0.45, 0, 0.949, 0.33, this.bronze);
    for (const x of [-0.2, 0.2]) this.block(stand, 0.045, 0.88, 0.25, x, 0.44, 0.32, this.wood);
    for (const [index, id] of specimens.entries()) {
      const specimen = this.clone('Ingredient' + INGREDIENT_ROOTS[id]);
      specimen.name = 'FoundIngredient' + INGREDIENT_ROOTS[id];
      specimen.position.set((index - (specimens.length - 1) / 2) * 0.27, 0.96, 0.34);
      stand.add(specimen);
      this.targets.push({ node: specimen, room, input: { action: 'collect', ingredient: id } });
    }
    this.registerBox(room, stand);
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
  private bay(room: number, key: string, width: number, fullHeight?: number): THREE.Group {
    const m = findPuzzleMount(
      this.world,
      [room],
      this.placements,
      key,
      width,
      1.5,
      fullHeight,
      fullHeight ? HALL_BENCHES : [],
    );
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
      if (input.action === 'add' && this.cradles[input.ingredient].flight !== null) continue;
      node.updateWorldMatrix(true, true);
      let hit: THREE.Vector3 | undefined = this.ray.intersectObject(node, true)[0]?.point;
      if (
        !hit &&
        (input.action === 'take-potion' ||
          ('ingredient' in input && input.ingredient >= NEW_SPECIMENS[0]))
      ) {
        // Thin leaves and stems need a continuous pick surface at seated distance.
        this.cube.setFromObject(node).expandByScalar(0.015);
        hit = this.ray.ray.intersectBox(this.cube, this.smallTargetHit) ?? undefined;
      }
      if (!hit) continue;
      const distance = origin.distanceTo(hit);
      if (distance > this.ray.far || (nearest && distance >= nearest.distance)) continue;
      const blocked = this.world.colliders[room].some((b) => {
        this.cube.min.fromArray(b.min);
        this.cube.max.fromArray(b.max);
        return (
          !this.cube.containsPoint(hit) &&
          this.ray.ray.intersectBox(this.cube, this.point) !== null &&
          this.point.distanceTo(origin) < distance - 0.035
        );
      });
      if (!blocked) nearest = { ...input, distance };
    }
    return nearest;
  }
  near(point: THREE.Vector3, reach: number): AlchemyPick | null {
    for (const { node, room, input } of this.targets) {
      if (room !== this.world.current || !node.visible) continue;
      if (input.action === 'add' && this.cradles[input.ingredient].flight !== null) continue;
      node.updateWorldMatrix(true, true);
      const d = this.cube.setFromObject(node).distanceToPoint(point);
      if (d <= reach) return { ...input, distance: d };
    }
    return null;
  }
  sync(state: StoredAlchemyState, immediate = false, formula?: StoredConservatoryFormula): void {
    const second = state.opened && formula?.clues.length === 2 ? formula : null;
    const active = second ?? state;
    this.opened = state.opened;
    for (const { mesh, thornwake, archive } of this.vialGlass)
      mesh.material = second ? archive : thornwake;
    if (immediate) {
      this.splash = 0;
      this.clearPickups();
    }
    for (const { node, input } of this.targets) {
      if (input.action === 'add') {
        const cradle = this.cradles[input.ingredient];
        cradle.available =
          state.found.includes(input.ingredient) &&
          (input.ingredient < NEW_SPECIMENS[0] || second !== null) &&
          !active.added.includes(input.ingredient) &&
          !active.brewed;
        if (immediate) this.finishDrop(cradle);
        node.visible = cradle.available || cradle.flight !== null;
      } else if (input.action === 'collect') {
        node.visible = !state.found.includes(input.ingredient);
      } else if (input.action === 'apply') {
        node.visible = !state.opened;
      }
    }
    this.potionReady = second
      ? second.brewed && !second.carried && !second.revealed
      : state.brewed && !state.carried && !state.opened;
    this.updatePotion();
    if (immediate || this.reducedMotion) {
      this.progress = Number(this.opened);
      this.poseWard();
    }
  }
  private poseWard() {
    this.leaves[0].rotation.y = (this.progress * Math.PI) / 2;
    this.leaves[1].rotation.y = (-this.progress * Math.PI) / 2;
  }
  animatePickup(ingredient: Ingredient, collector: THREE.Object3D, source?: THREE.Object3D): void {
    const specimen =
      source ??
      this.targets.find(
        ({ input }) => input.action === 'collect' && input.ingredient === ingredient,
      )?.node;
    if (specimen) this.flyPickup(specimen, collector, INGREDIENT_ROOTS[ingredient]);
  }
  animatePotionPickup(collector: THREE.Object3D): void {
    this.flyPickup(this.potion, collector, 'potion');
  }
  private flyPickup(specimen: THREE.Object3D, collector: THREE.Object3D, name: string): void {
    if (!specimen.parent) return;
    const node = specimen.clone(true);
    node.name = 'alchemy-pickup-' + name;
    node.visible = true;
    specimen.parent.add(node);
    this.world.group.attach(node);
    this.pickups.add({
      node,
      collector,
      start: node.position.clone(),
      scale: node.scale.clone(),
      room: this.world.current,
      time: 0,
    });
  }
  private updatePickups(dt: number): void {
    for (const f of this.pickups) {
      f.time += dt / (this.reducedMotion ? 0.2 : 0.62);
      if (f.time >= 1 || this.world.current !== f.room) {
        f.node.removeFromParent();
        this.pickups.delete(f);
        continue;
      }
      if (this.reducedMotion) {
        f.node.scale.copy(f.scale).multiplyScalar(flightScale(f.time));
        continue;
      }
      this.world.group.worldToLocal(f.collector.getWorldPosition(this.point));
      flightGoal(
        f.start,
        this.point,
        f.collector instanceof THREE.Camera ? 0.35 : 0.04,
        this.point,
      );
      const k = flightPose(f.start, this.point, f.time, f.node.position);
      const lift = Math.min(0.22, f.start.distanceTo(this.point) * 0.18);
      f.node.position.y += Math.sin(k * Math.PI) * lift;
      f.node.scale.copy(f.scale).multiplyScalar(flightScale(k * k));
    }
  }
  private clearPickups(): void {
    for (const { node } of this.pickups) node.removeFromParent();
    this.pickups.clear();
  }
  animateIngredient(ingredient: Ingredient): void {
    const cradle = this.cradles[ingredient];
    cradle.flight = 0;
    cradle.node.visible = true;
    this.poseDrop(cradle, 0);
    this.updatePotion();
  }
  private poseDrop({ node, home }: Cradle, t: number): void {
    const surface = this.cauldron.position.y + this.swirl.position.y;
    if (this.reducedMotion) {
      node.position.set(home.x * 0.12, surface + 0.02 - 0.06 * t, this.cauldron.position.z);
      node.scale.setScalar(1 - 0.55 * t);
      return;
    }
    const travel = THREE.MathUtils.smootherstep(t, 0.12, 0.76);
    node.position.set(
      THREE.MathUtils.lerp(home.x, home.x * 0.1, travel),
      THREE.MathUtils.lerp(home.y, surface - 0.12, travel) + 3.1 * t * (1 - t),
      THREE.MathUtils.lerp(home.z, this.cauldron.position.z, travel),
    );
    node.rotation.z = (home.x > 0 ? 1 : -1) * 0.75 * travel;
    node.scale.setScalar(1 - 0.72 * THREE.MathUtils.smoothstep(t, 0.72, 1));
  }
  private finishDrop(cradle: Cradle): void {
    cradle.flight = null;
    cradle.node.position.copy(cradle.home);
    cradle.node.rotation.z = 0;
    cradle.node.scale.setScalar(1);
    cradle.node.visible = cradle.available;
  }
  private updatePotion(): void {
    this.potion.visible =
      this.potionReady && this.cradles.every((cradle) => cradle.flight === null);
  }
  private updateBrew(dt: number): void {
    for (const cradle of this.cradles) {
      if (cradle.flight === null) continue;
      cradle.flight += dt / (this.reducedMotion ? 0.4 : 0.86);
      if (cradle.flight >= 1 || this.world.current !== this.cauldronRoom) {
        this.finishDrop(cradle);
        this.updatePotion();
        this.splash = Number(this.world.current === this.cauldronRoom);
      } else this.poseDrop(cradle, cradle.flight);
    }
    if (this.reducedMotion || !this.world.roomGroups[this.cauldronRoom].visible) return;
    this.simmer += dt;
    this.splash = Math.max(0, this.splash - dt * 1.5);
    this.swirl.rotation.y += dt * (0.9 + 1.65 * this.splash);
    for (const [i, bubble] of this.bubbles.entries()) {
      const phase = (this.simmer / (1.45 + i * 0.22) + i * 0.37) % 1;
      const rise = phase * phase;
      bubble.position.y = this.swirl.position.y - 0.014 + (0.1 + 0.05 * this.splash) * rise;
      const size =
        THREE.MathUtils.smoothstep(phase, 0, 0.23) *
        (1 - THREE.MathUtils.smoothstep(phase, 0.82, 1));
      bubble.scale.set(size, size * (0.66 + 0.52 * phase), size);
    }
  }
  update(dt: number, dialHours?: number): void {
    if (dialHours !== undefined && this.windNeedle) {
      this.still = (dialHours - this.quietHour + 12) % 12 < 2;
      this.windNeedle.rotation.z = (-dialHours * Math.PI) / 6;
    }
    if (this.opened && this.progress < 1) {
      this.progress = Math.min(1, this.progress + dt * 1.35);
      this.poseWard();
    }
    if (dt > 0) {
      this.updatePickups(dt);
      this.updateBrew(dt);
    }
  }
  dispose(): void {
    this.clearPickups();
    this.windInscription?.dispose();
    for (const remove of this.boxes) remove();
    for (const root of this.fixtures) root.removeFromParent();
    for (const g of this.owned) g.dispose();
    for (const { thornwake, archive } of this.vialGlass) {
      thornwake.dispose();
      archive.dispose();
    }
  }
}
