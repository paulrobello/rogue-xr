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
  private plate?: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
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
      this.label.mesh.name = 'astral-lift-destination';
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
    lift.object.position.copy(spot.wallSurface);
    lift.object.rotation.y = spot.yaw;
    world.roomGroups[spot.room].add(lift.object);
    lift.object.updateWorldMatrix(true, true);
    lift.seatNameplate();
    return lift;
  }
  private seatNameplate(): void {
    if (!this.label) return;
    const walls: THREE.Object3D[] = [];
    for (const child of this.world.roomGroups[this.room].children) {
      if (child === this.object) continue;
      child.traverseVisible((node) => {
        if (node instanceof THREE.Mesh && !node.material?.transparent) walls.push(node);
      });
    }
    const outward = this.object.getWorldDirection(new THREE.Vector3()).negate();
    this.ray.far = 0.65;
    let best: { y: number; back: number; relief: number } | undefined;
    for (const y of [0.54, -0.54]) {
      const depths: number[] = [];
      for (const x of [-0.405, -0.2, 0, 0.2, 0.405]) {
        for (const dy of [-0.062, 0, 0.062]) {
          const from = this.object.localToWorld(new THREE.Vector3(x, y + dy, 0.42));
          this.ray.set(from, outward);
          const hit = this.ray.intersectObjects(walls, false)[0];
          if (hit) depths.push(this.object.worldToLocal(hit.point).z);
        }
      }
      if (depths.length !== 15) continue;
      const back = Math.min(...depths),
        relief = Math.max(...depths) - back;
      if (!best || relief < best.relief - 0.002) best = { y, back, relief };
      if (relief < 0.002) break;
    }
    const { y, back, relief } = best ?? { y: 0.54, back: 0, relief: 0 };
    const depth = relief + 0.009;
    this.plate = new THREE.Mesh(
      new THREE.BoxGeometry(0.827, 0.135, depth),
      new THREE.MeshStandardMaterial({ color: 0x624733, roughness: 0.48, metalness: 0.59 }),
    );
    this.plate.name = 'astral-lift-nameplate';
    this.plate.position.set(0, y, back + depth / 2 - 0.001);
    this.object.add(this.plate);
    this.label.mesh.position.set(0, y, back + depth);
    this.object.updateWorldMatrix(true, true);
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
    this.plate?.geometry.dispose();
    this.plate?.material.dispose();
    this.object.removeFromParent();
  }
}
