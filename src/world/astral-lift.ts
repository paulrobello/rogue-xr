import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart } from './puzzle-placement.ts';

/** The same engraved medallion marks both ends of the Conservatory lift. */
export class AstralLift {
  readonly object = new THREE.Group();
  readonly target: THREE.Object3D;
  private readonly label: CanvasLabel | null;
  private readonly ray = new THREE.Raycaster();
  private constructor(
    readonly world: FloorWorld,
    readonly room: number,
    readonly destination: 2 | 3,
    art: THREE.Object3D,
  ) {
    this.object.name = 'astral-lift';
    const medallion = kitPart(art, 'AstralLiftMedallion');
    this.target = medallion.clone(true);
    this.target.name = 'astral-lift-medallion';
    this.target.rotation.x = Math.PI / 2;
    this.target.position.z = 0.07;
    this.object.add(this.target);
    this.label =
      typeof document === 'undefined' || !document.createElement('canvas').getContext('2d')
        ? null
        : new CanvasLabel(680, 106, 0.82, false);
    if (this.label) {
      this.label.draw((ctx, w, h) => {
        ctx.fillStyle = '#24363e';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#b9945e';
        ctx.lineWidth = 4;
        ctx.strokeRect(5, 5, w - 10, h - 10);
        ctx.fillStyle = '#f5dfb4';
        ctx.font = 'bold 49px Georgia';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          destination === 3 ? 'Ⅲ · Conservatory' : 'Ⅱ · Upper Works',
          w / 2,
          h / 2,
          w - 28,
        );
      });
      this.label.mesh.position.set(0, -0.52, 0.12);
      this.object.add(this.label.mesh);
    }
  }
  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    destination: 2 | 3,
    props: readonly InteriorPlacement[] = [],
  ): AstralLift {
    const rooms =
      destination === 2
        ? [0]
        : [
            world.stairEntry?.room ?? 0,
            ...world.plan.rooms.filter((r) => !r.encounter).map((r) => r.index),
          ];
    const spot = findPuzzleMount(world, rooms, props, undefined, 0.52, 0.85);
    if (!spot) throw Error('No accessible astral lift bay');
    const lift = new AstralLift(world, spot.room, destination, art);
    lift.object.position.copy(spot.center);
    lift.object.rotation.y = spot.yaw;
    world.roomGroups[spot.room].add(lift.object);
    lift.object.updateWorldMatrix(true, true);
    return lift;
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3) {
    if (this.world.current !== this.room) return null;
    this.ray.set(origin, direction);
    this.ray.far = 3.5;
    const hit = this.ray.intersectObject(this.target, true)[0];
    return hit ? { distance: hit.distance } : null;
  }
  dispose() {
    this.label?.dispose();
    this.object.removeFromParent();
  }
}
