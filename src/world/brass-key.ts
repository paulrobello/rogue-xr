import * as THREE from 'three';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import { findPuzzleMount, kitPart, type PuzzleMount } from './puzzle-placement.ts';

export class BrassKeyStand {
  readonly object: THREE.Object3D;
  readonly key: THREE.Object3D;
  readonly room: number;
  private readonly ray = new THREE.Raycaster();
  private readonly target = new THREE.Box3();
  private readonly obstacle = new THREE.Box3();
  private readonly point = new THREE.Vector3();

  static mount(
    world: FloorWorld,
    art: THREE.Object3D,
    props: readonly InteriorPlacement[],
  ): BrassKeyStand {
    const rooms = world.plan.rooms
      .filter((r) => r.role !== 'guardian' && !r.encounter)
      .map((r) => r.index);
    const site =
      findPuzzleMount(world, rooms, props, 'brass-key', 0.34, 0.85) ??
      findPuzzleMount(
        world,
        world.plan.rooms.filter((r) => r.role !== 'guardian').map((r) => r.index),
        props,
        'brass-key',
        0.34,
        0.85,
      );
    if (!site) throw Error('No reachable Upper Works key rack site');
    return new BrassKeyStand(world, art, site);
  }

  private constructor(
    private readonly world: FloorWorld,
    art: THREE.Object3D,
    site: PuzzleMount,
  ) {
    this.room = site.room;
    this.object = kitPart(art, 'BrassKeyRack').clone(true);
    this.object.name = 'brass-key-rack';
    this.key = kitPart(art, 'BrassCacheKey').clone(true);
    this.key.name = 'brass-cache-key';
    this.key.position.set(0, 0, 0);
    kitPart(this.object, 'BrassKeySocket').add(this.key);
    this.object.position.copy(site.wallSurface);
    this.object.rotation.y = site.yaw;
    world.roomGroups[this.room].add(this.object);
    this.object.updateWorldMatrix(true, true);
    this.target.setFromObject(this.key).expandByScalar(0.012);
    this.ray.far = 4;
  }
  sync(collected: boolean): void {
    this.key.visible = !collected;
  }
  pick(origin: THREE.Vector3, direction: THREE.Vector3): { distance: number } | null {
    if (!this.key.visible || this.world.current !== this.room) return null;
    this.ray.set(origin, direction);
    if (!this.ray.ray.intersectBox(this.target, this.point)) return null;
    const distance = this.point.distanceTo(origin);
    if (distance > this.ray.far) return null;
    for (const b of this.world.colliders[this.room]) {
      this.obstacle.min.fromArray(b.min);
      this.obstacle.max.fromArray(b.max);
      if (this.obstacle.intersectsBox(this.target)) continue;
      if (
        this.ray.ray.intersectBox(this.obstacle, this.point) &&
        this.point.distanceTo(origin) < distance - 0.02
      )
        return null;
    }
    return { distance };
  }
  near(point: THREE.Vector3, reach: number): boolean {
    return (
      this.key.visible &&
      this.world.current === this.room &&
      this.target.distanceToPoint(point) <= reach
    );
  }
  dispose(): void {
    this.object.removeFromParent();
  }
}
