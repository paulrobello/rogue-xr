import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import { alchemyRecipe, type Ingredient } from '../rules/alchemy.ts';
import { INGREDIENT_ROOTS } from './alchemy-conservatory.ts';
import { ClockInscription } from './clock-inscription.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart } from './puzzle-placement.ts';

export const CLOCK_CYCLE = 60;
export const strikingHour = (seed: string): number =>
  Stream.fromKey(seed + ':striking-clock-hour').int(1, 12);
export type ClockPick = { ingredient: Ingredient; distance: number } | null;
export class StrikingClock {
  readonly object: THREE.Object3D;
  readonly clueObject: THREE.Object3D;
  readonly hour: number;
  readonly ingredient: Ingredient;
  readonly target: THREE.Object3D;
  private readonly hourHand: THREE.Object3D;
  private readonly minuteHand: THREE.Object3D;
  private readonly pendulum: THREE.Object3D;
  private readonly drawer: THREE.Object3D;
  private readonly inscription: ClockInscription;
  private readonly closedZ: number;
  private readonly ray = new THREE.Raycaster();
  private elapsed: number;
  private remaining = 0;
  private taken = false;
  private witnessed = false;
  private removeCollider?: () => void;
  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    seed: string,
    reducedMotion: boolean,
    props: readonly InteriorPlacement[] = [],
  ): StrikingClock | null {
    const rooms = [0, 1, 2, 3, 4];
    const spot = findPuzzleMount(world, rooms, props, 'striking-clock', 0.52, 1.15);
    if (!spot) return null;
    const clue = findPuzzleMount(
      world,
      rooms.filter((i) => i !== spot.room),
      props,
      'striking-clock-clue',
      0.38,
      0.5,
    );
    if (!clue) return null;
    const clock = new StrikingClock(world, spot.room, clue.room, art, seed, reducedMotion);
    clock.object.position.copy(spot.center);
    clock.object.position.y = 0;
    clock.object.rotation.y = spot.yaw;
    clock.object.translateZ(0.21);
    world.roomGroups[spot.room].add(clock.object);
    clock.clueObject.position.copy(clue.wallSurface);
    clock.clueObject.rotation.y = clue.yaw;
    clock.clueObject.translateZ(0.069);
    world.roomGroups[clue.room].add(clock.clueObject);
    clock.seatInscription();
    clock.object.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(clock.object);
    clock.removeCollider = world.addFixtureCollider(spot.room, {
      min: bounds.min.toArray(),
      max: bounds.max.toArray(),
    });
    return clock;
  }
  constructor(
    private readonly world: FloorWorld,
    readonly room: number,
    readonly clueRoom: number,
    art: THREE.Object3D,
    seed: string,
    private readonly reducedMotion = false,
  ) {
    this.hour = strikingHour(seed);
    this.elapsed = Stream.fromKey(seed + ':clock-start').int(0, 59);
    this.object = kitPart(art, 'GrandfatherClock').clone(true);
    this.clueObject = kitPart(art, 'ClockClueDial').clone(true);
    kitPart(this.clueObject, 'ClockClueHand').rotation.z = (-(this.hour % 12) * Math.PI) / 6;
    this.inscription = new ClockInscription(
      'striking-clock-inscription',
      0.74,
      'Grandfather clock',
      `Wait beside it until ${this.hour} o’clock.`,
      'Take the ingredient from its drawer.',
    );
    this.inscription.object.position.set(0, 0.32, -0.056);
    this.clueObject.add(this.inscription.object);
    this.hourHand = kitPart(this.object, 'ClockHourHand');
    this.minuteHand = kitPart(this.object, 'ClockMinuteHand');
    this.pendulum = kitPart(this.object, 'ClockPendulum');
    this.drawer = kitPart(this.object, 'ClockCompartment');
    this.closedZ = this.drawer.position.z;
    this.ingredient = alchemyRecipe(seed)[1];
    this.target = kitPart(art, 'Ingredient' + INGREDIENT_ROOTS[this.ingredient]).clone(true);
    this.target.name = 'clock-ingredient';
    this.target.scale.setScalar(0.75);
    kitPart(this.object, 'ClockIngredientSocket').add(this.target);
    this.target.visible = false;
    this.pose();
  }
  private seatInscription(): void {
    const surfaces: THREE.Object3D[] = [];
    for (const child of this.world.roomGroups[this.clueRoom].children) {
      if (child === this.clueObject) continue;
      child.traverseVisible((node) => {
        if (node instanceof THREE.Mesh && !node.material?.transparent) surfaces.push(node);
      });
    }
    const inward = this.clueObject.getWorldDirection(new THREE.Vector3()).negate();
    const point = new THREE.Vector3();
    this.ray.far = 1.2;
    const plate = this.inscription.object;
    const { width, height, depth } = plate.geometry.parameters;
    let bestRelief = Infinity;
    for (const y of [0.32, -0.32]) {
      let low = Infinity;
      let high = -Infinity;
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 4; j++) {
          point.set(width * (i / 8 - 0.5), y + height * (j / 4 - 0.5), 0.65);
          this.ray.set(this.clueObject.localToWorld(point), inward);
          const hit = this.ray.intersectObjects(surfaces, false)[0];
          if (!hit) continue;
          const z = this.clueObject.worldToLocal(hit.point).z;
          low = Math.min(low, z);
          high = Math.max(high, z);
        }
      }
      if (low > high || high - low >= bestRelief - 0.002) continue;
      bestRelief = high - low;
      const thickness = bestRelief + depth;
      plate.scale.z = thickness / depth;
      plate.position.set(0, y, low + thickness / 2 - 0.001);
      if (bestRelief < 0.002) break;
    }
  }
  setWitness(room: number) {
    this.witnessed = room === this.room;
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): ClockPick {
    if (this.world.current !== this.room || !this.target.visible) return null;
    this.ray.set(origin, direction);
    this.ray.far = 4;
    const hit = this.ray.intersectObject(this.target, true)[0];
    return hit ? { ingredient: this.ingredient, distance: hit.distance } : null;
  }
  near(point: THREE.Vector3, reach: number): ClockPick {
    if (this.world.current !== this.room || !this.target.visible) return null;
    const distance = new THREE.Box3().setFromObject(this.target).distanceToPoint(point);
    return distance <= reach ? { ingredient: this.ingredient, distance } : null;
  }
  sync(taken: boolean) {
    this.taken = taken;
    if (taken) {
      this.remaining = 0;
      this.target.visible = false;
    }
  }
  get dialHours(): number {
    return ((this.elapsed * 12) / CLOCK_CYCLE) % 12;
  }
  private pose() {
    const hours = (this.elapsed * 12) / CLOCK_CYCLE;
    this.hourHand.rotation.z = (-(hours % 12) * Math.PI) / 6;
    this.minuteHand.rotation.z = -(hours % 1) * Math.PI * 2;
    if (!this.reducedMotion)
      this.pendulum.rotation.z = 0.18 * Math.sin(this.elapsed * Math.PI * 1.3);
  }
  update(dt: number): boolean {
    if (dt <= 0) return false;
    const offset = ((this.hour % 12) * CLOCK_CYCLE) / 12;
    const before = Math.floor((this.elapsed - offset) / CLOCK_CYCLE);
    this.elapsed += dt;
    const struck = Math.floor((this.elapsed - offset) / CLOCK_CYCLE) > before && this.witnessed;
    this.remaining = struck && !this.taken ? 8 : Math.max(0, this.remaining - dt);
    if (!this.witnessed) this.remaining = 0;
    const open = this.remaining > 0 && !this.taken;
    const z = this.closedZ + (open ? 0.23 : 0);
    this.drawer.position.z = this.reducedMotion
      ? z
      : THREE.MathUtils.damp(this.drawer.position.z, z, 12, dt);
    this.target.visible = open;
    this.pose();
    return struck;
  }
  dispose() {
    this.removeCollider?.();
    this.inscription.dispose();
    this.object.removeFromParent();
    this.clueObject.removeFromParent();
  }
}
