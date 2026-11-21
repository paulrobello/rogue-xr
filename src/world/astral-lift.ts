import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart } from './puzzle-placement.ts';

/** A wall-mounted lift with two sliding leaves and a destination call button. */
export class AstralLift {
  readonly object = new THREE.Group();
  readonly target: THREE.Object3D;
  private readonly label: CanvasLabel | null;
  private readonly ray = new THREE.Raycaster();
  private readonly materials = {
    dark: new THREE.MeshStandardMaterial({
      color: 0x3b4140,
      emissive: 0x202a29,
      metalness: 0.38,
      roughness: 0.57,
      toneMapped: false,
    }),
    enamel: new THREE.MeshStandardMaterial({
      color: 0x41716a,
      emissive: 0x30534e,
      metalness: 0.32,
      roughness: 0.4,
      toneMapped: false,
    }),
    brass: new THREE.MeshStandardMaterial({
      color: 0xc19a65,
      emissive: 0x775839,
      metalness: 0.55,
      roughness: 0.42,
      toneMapped: false,
    }),
    interior: new THREE.MeshBasicMaterial({ color: 0x000000, fog: false, toneMapped: false }),
  };
  private readonly geometries = new Set<THREE.BufferGeometry>();
  private readonly leaves: THREE.Group[] = [];
  private removeCollider?: () => void;
  private opening = 0;

  private constructor(
    readonly world: FloorWorld,
    readonly room: number,
    readonly destination: 2 | 3,
    art: THREE.Object3D,
  ) {
    this.object.name = 'astral-lift';
    this.buildCase();

    this.target = kitPart(art, 'AstralLiftMedallion').clone(true);
    this.target.name = 'astral-lift-medallion';
    this.target.rotation.x = Math.PI / 2;
    this.target.scale.setScalar(0.19);
    this.target.position.set(0.69, 1.23, 0.284);
    this.object.add(this.target);

    this.label =
      typeof document === 'undefined' || !document.createElement('canvas').getContext('2d')
        ? null
        : new CanvasLabel(840, 176, 1.03, false);
    if (this.label) {
      this.label.draw((ctx, w, h) => {
        ctx.fillStyle = '#24363e';
        ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = '#b9945e';
        ctx.lineWidth = 4;
        ctx.strokeRect(6, 6, w - 12, h - 12);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#dfb975';
        ctx.font = 'bold 40px Georgia';
        ctx.fillText('ASTRAL LIFT', w / 2, 51);
        ctx.fillStyle = '#f5dfb4';
        ctx.font = 'bold 53px Georgia';
        ctx.fillText(
          destination === 3 ? 'Ⅲ · Conservatory' : 'Ⅱ · Upper Works',
          w / 2,
          123,
          w - 40,
        );
      });
      this.label.mesh.name = 'astral-lift-destination';
      this.label.mesh.position.set(0, 2.201, 0.294);
      this.object.add(this.label.mesh);
    }
    this.open(0);
  }

  private buildCase(): void {
    this.boxes(this.object, this.materials.dark, [
      [1.84, 2.3, 0.055, 0, 1.15, 0.026],
      [0.32, 2.09, 0.245, -0.76, 1.065, 0.127],
      [0.32, 2.09, 0.245, 0.76, 1.065, 0.127],
      [1.84, 0.234, 0.279, 0, 2.204, 0.14],
      [1.82, 0.031, 0.318, 0, 0.016, 0.137],
    ]);
    this.boxes(this.object, this.materials.enamel, [
      [0.26, 1.995, 0.059, -0.751, 1.066, 0.246],
      [0.26, 1.995, 0.059, 0.751, 1.066, 0.246],
      [1.15, 0.06, 0.024, 0, 2.06, 0.238],
    ]);
    this.boxes(this.object, this.materials.brass, [
      [0.098, 2.065, 0.147, -0.557, 1.054, 0.224],
      [0.098, 2.065, 0.147, 0.557, 1.054, 0.224],
      [1.24, 0.033, 0.057, 0, 2.073, 0.267],
      [1.86, 0.025, 0.066, 0, 2.326, 0.264],
      [1.84, 0.013, 0.039, 0, 0.033, 0.278],
    ]);
    // The backing sits in front of the chair rail and behind the closed leaves.
    const interior = this.boxes(this.object, this.materials.interior, [
      [1.21, 2.11, 0.006, 0, 1.053, 0.125],
    ]);
    interior.name = 'astral-lift-interior';

    for (const side of [-1, 1]) {
      const leaf = new THREE.Group();
      leaf.name = side < 0 ? 'astral-lift-door-left' : 'astral-lift-door-right';
      this.boxes(leaf, this.materials.enamel, [[0.501, 2.015, 0.076, 0, 0, 0]]);
      this.boxes(leaf, this.materials.dark, [
        [0.343, 0.515, 0.016, 0, 0.683, 0.045],
        [0.343, 0.708, 0.016, 0, -0.495, 0.045],
      ]);
      this.boxes(leaf, this.materials.brass, [
        [0.013, 1.998, 0.014, -side * 0.239, 0, 0.043],
        [0.011, 1.961, 0.012, side * 0.202, 0, 0.042],
        [0.361, 0.014, 0.016, 0, 0.409, 0.045],
        [0.361, 0.014, 0.016, 0, -0.122, 0.045],
        [0.029, 0.255, 0.044, -side * 0.131, 0.117, 0.06],
        [0.008, 0.288, 0.008, 0, 0.694, 0.057],
        [0.008, 0.19, 0.008, -0.042, 0.694, 0.057],
        [0.008, 0.19, 0.008, 0.042, 0.694, 0.057],
      ]);
      this.object.add(leaf);
      this.leaves.push(leaf);
    }
  }

  private boxes(
    parent: THREE.Group,
    material: THREE.Material,
    pieces: readonly (readonly [number, number, number, number, number, number])[],
  ): THREE.Mesh {
    const parts = pieces.map(([w, h, d, x, y, z]) =>
      new THREE.BoxGeometry(w, h, d).translate(x, y, z),
    );
    const geometry = mergeGeometries(parts);
    for (const part of parts) part.dispose();
    this.geometries.add(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    parent.add(mesh);
    return mesh;
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
    const spot = findPuzzleMount(world, rooms, props, undefined, 0.94, 0.59, 2.34);
    if (!spot) throw Error('No accessible astral lift bay');
    const lift = new AstralLift(world, spot.room, destination, art);
    lift.object.position.copy(spot.wallSurface);
    lift.object.position.y = 0;
    lift.object.rotation.y = spot.yaw;
    world.roomGroups[spot.room].add(lift.object);
    lift.object.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(lift.object);
    lift.removeCollider = world.addFixtureCollider(spot.room, {
      min: bounds.min.toArray(),
      max: bounds.max.toArray(),
    });
    return lift;
  }

  open(fraction: number): void {
    this.opening = fraction;
    for (const [index, leaf] of this.leaves.entries())
      leaf.position.set((index === 0 ? -1 : 1) * (0.256 + 0.41 * fraction), 1.052, 0.179);
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): { distance: number } | null {
    if (this.world.current !== this.room || this.opening > 0) return null;
    this.ray.set(origin, direction);
    this.ray.far = 3.5;
    const hit = this.ray.intersectObject(this.object, true)[0];
    if (!hit) return null;
    for (let node: THREE.Object3D | null = hit.object; node; node = node.parent)
      if (node === this.target || this.leaves.includes(node as THREE.Group))
        return { distance: hit.distance };
    return null;
  }

  dispose(): void {
    this.removeCollider?.();
    this.label?.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    this.object.removeFromParent();
  }
}
