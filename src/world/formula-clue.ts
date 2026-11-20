import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import {
  type FormulaClue as Clue,
  conservatoryFormula,
  type FollowupRecipe,
  formulaClueOrder,
} from '../rules/alchemy.ts';
import { INGREDIENT_ROOTS } from './alchemy-conservatory.ts';
import type { ConservatoryGallery } from './conservatory-gallery.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart } from './puzzle-placement.ts';

export const RECORD_NAMES: Readonly<Record<FollowupRecipe, string>> = {
  'lantern-ink': 'InkRubbing',
  stillwind: 'WindChart',
  'looking-glass': 'HandMirror',
};
export const RECORD_TITLES: Readonly<Record<FollowupRecipe, string>> = {
  'lantern-ink': 'Silversmith’s rubbing',
  stillwind: 'Draft engineer’s chart',
  'looking-glass': 'Apothecary’s mirror',
};

/** Both witnesses use the same engraved glyph language as the original cauldron tablet. */
export class FormulaEvidence {
  readonly object = new THREE.Group();
  private readonly ray = new THREE.Raycaster();
  private readonly box = new THREE.Box3();
  private readonly point = new THREE.Vector3();
  private readonly owned: THREE.BufferGeometry[] = [];
  private target: THREE.Object3D;
  private release?: () => void;
  private constructor(
    readonly world: FloorWorld,
    readonly room: number,
    readonly clue: Clue,
  ) {
    this.object.name = 'formula-evidence-' + clue;
    this.target = this.object;
  }

  static mount(
    world: FloorWorld,
    kit: THREE.Object3D,
    archiveKit: THREE.Object3D,
    seed: string,
    gallery: ConservatoryGallery | null,
    props: readonly InteriorPlacement[] = [],
  ): FormulaEvidence {
    const plan = conservatoryFormula(seed);
    const source = gallery ? 'portrait' : 'record';
    const order = formulaClueOrder(plan.recipe, source);
    const ingredient = plan.ingredients[order];
    let evidence: FormulaEvidence;
    let socket: THREE.Object3D;
    if (gallery) {
      const index = Stream.fromKey(seed + ':portrait-sigil').int(0, 1);
      evidence = new FormulaEvidence(world, gallery.roomIds[index], source);
      const frame = gallery.portraitGroups[index];
      frame.add(evidence.object);
      evidence.object.position.set(0, -0.615, 0.177);
      evidence.target = frame;
      socket = evidence.object;
    } else {
      const rooms = world.plan.rooms
        .filter((r) => r.role !== 'guardian' && !r.encounter)
        .map((r) => r.index);
      const width = plan.recipe === 'stillwind' ? 0.55 : 0.46;
      const point =
        findPuzzleMount(world, rooms, props, 'archive-record', width, 0.9) ??
        findPuzzleMount(
          world,
          world.plan.rooms.filter((r) => r.role !== 'guardian').map((r) => r.index),
          props,
          'archive-record',
          width,
          0.9,
        );
      if (!point) throw Error('Missing an accessible Upper Works record shelf');
      evidence = new FormulaEvidence(world, point.room, source);
      evidence.object.position.copy(plan.recipe === 'stillwind' ? point.wallSurface : point.center);
      evidence.object.position.y = 1.13;
      evidence.object.rotation.y = point.yaw;
      world.roomGroups[point.room].add(evidence.object);
      const name = RECORD_NAMES[plan.recipe];
      const relic = kitPart(archiveKit, name).clone(true);
      relic.name = 'archive-clue-' + name;
      relic.scale.setScalar(1.75);
      relic.position.set(0, 0.05, 0.19);
      relic.rotation.x = 0.88;
      evidence.object.add(relic);
      const material = kitPart(kit, 'ClockCompartment').getObjectsByProperty(
        'isMesh',
        true,
      )[0] as THREE.Mesh;
      const rail = new THREE.BoxGeometry(plan.recipe === 'stillwind' ? 1.01 : 0.64, 0.055, 0.47);
      evidence.owned.push(rail);
      const shelf = new THREE.Mesh(rail, material.material);
      shelf.position.set(0, -0.13, 0.22);
      evidence.object.add(shelf);
      socket = kitPart(relic, name + 'Socket2');
      if (plan.recipe === 'stillwind') {
        relic.scale.setScalar(1.5);
        relic.position.set(0.02, 0.032, 0.18);
        const backing = (width: number, depth: number, x: number, y: number, z: number) => {
          const shape = new THREE.BoxGeometry(width, 0.033, depth);
          evidence.owned.push(shape);
          const rest = new THREE.Mesh(shape, material.material);
          rest.rotation.x = relic.rotation.x;
          rest.position.set(x, y, z);
          evidence.object.add(rest);
          const height = y + Math.sin(relic.rotation.x) * depth * 0.34 + 0.091;
          const supportShape = new THREE.BoxGeometry(width * 0.84, height, 0.024);
          evidence.owned.push(supportShape);
          const support = new THREE.Mesh(supportShape, material.material);
          support.position.set(
            x,
            -0.103 + height / 2,
            z - Math.cos(relic.rotation.x) * depth * 0.34,
          );
          evidence.object.add(support);
          return rest;
        };
        backing(0.5, 0.29, 0.02, 0.016, 0.16);
        const glyphRest = backing(0.17, 0.2, 0.388, -0.021, 0.175);
        socket = new THREE.Group();
        socket.position.y = 0.018;
        glyphRest.add(socket);
        const dial = kitPart(kit, 'ClockClueDial').clone(true);
        dial.scale.setScalar(0.46);
        dial.position.set(-0.354, -0.008, 0.035);
        kitPart(dial, 'ClockClueHand').rotation.z = (-plan.quietHour * Math.PI) / 6;
        evidence.object.add(dial);
        const bounds = new THREE.Box3().setFromObject(evidence.object);
        evidence.release = world.addFixtureCollider(point.room, {
          min: bounds.min.toArray(),
          max: bounds.max.toArray(),
        });
      }
    }
    const tile = kitPart(kit, 'RecipeTile' + INGREDIENT_ROOTS[ingredient]).clone(true);
    tile.name = 'formula-glyph-' + source;
    tile.scale.setScalar(gallery ? 0.91 : 0.64);
    if (gallery) tile.rotation.x = Math.PI / 2;
    socket.add(tile);
    const mesh = tile.getObjectsByProperty('isMesh', true)[0] as THREE.Mesh;
    const markers = new THREE.BoxGeometry(0.014, 0.008, 0.038);
    evidence.owned.push(markers);
    for (let i = 0; i <= order; i++) {
      const tick = new THREE.Mesh(markers, mesh.material);
      tick.position.set((i - order / 2) * 0.024, 0.023, -0.1);
      tile.add(tick);
    }
    return evidence;
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): { clue: Clue; distance: number } | null {
    if (this.world.current !== this.room) return null;
    this.target.updateWorldMatrix(true, true);
    this.ray.set(origin, direction);
    this.ray.far = 4;
    const hit = this.ray.intersectObject(this.target, true)[0];
    if (!hit) return null;
    for (const b of this.world.colliders[this.room]) {
      this.box.min.fromArray(b.min);
      this.box.max.fromArray(b.max);
      if (
        !this.box.containsPoint(hit.point) &&
        this.ray.ray.intersectBox(this.box, this.point) &&
        this.point.distanceTo(origin) < hit.distance - 0.03
      )
        return null;
    }
    return { clue: this.clue, distance: hit.distance };
  }
  near(hand: THREE.Vector3, reach: number) {
    if (this.world.current !== this.room) return null;
    const distance = this.box.setFromObject(this.object).distanceToPoint(hand);
    return distance <= reach ? { clue: this.clue, distance } : null;
  }
  dispose() {
    this.release?.();
    this.object.removeFromParent();
    for (const geometry of this.owned) geometry.dispose();
  }
}
