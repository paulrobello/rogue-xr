import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import type { FloorWorld } from './floor-world.ts';
import type { WindowBay } from './window-bays.ts';

const CAST_START = 0.72;
const TILE_OFFSET = 3.3;
const TILE_HALF_X = 0.15;
const TILE_HALF_Z = 0.19;

export function windowCacheBay(
  world: FloorWorld,
  windows: readonly WindowBay[],
  seed: string,
): WindowBay | undefined {
  return Stream.fromKey(`${seed}:window-cache`)
    .shuffle([...windows])
    .find((bay) => {
      if (world.plan.rooms[bay.room].role === 'guardian') return false;
      const parent = world.roomGroups[bay.room];
      parent.updateWorldMatrix(true, false);
      const target = new THREE.Box3(
        new THREE.Vector3(bay.x - 0.49, 0.025, bay.z + CAST_START),
        new THREE.Vector3(bay.x + 0.49, 0.48, bay.z + TILE_OFFSET + 0.34),
      ).applyMatrix4(parent.matrixWorld);
      const { min, max } = world.rooms[bay.room].footprint;
      return (
        target.min.x > min[0] + 0.16 &&
        target.max.x < max[0] - 0.16 &&
        target.min.z > min[1] + 0.16 &&
        target.max.z < max[1] - 0.16 &&
        !world.colliders[bay.room].some(
          (b) =>
            b.min[0] < target.max.x &&
            b.max[0] > target.min.x &&
            b.min[1] < target.max.y &&
            b.max[1] > target.min.y &&
            b.min[2] < target.max.z &&
            b.max[2] > target.min.z,
        )
      );
    });
}

/** Projected color is a single floor mesh per window, so it needs neither shadow maps nor extra lights. */
export function mountWindowCast(parent: THREE.Object3D, bay: WindowBay, key: boolean): () => void {
  const vertices: number[] = [];
  const colors: number[] = [];
  const patch = (tint: number, points: readonly (readonly [number, number])[]): void => {
    const color = new THREE.Color(tint);
    for (let i = 1; i < points.length - 1; i++) {
      for (const [x, z] of [points[0], points[i], points[i + 1]]) {
        vertices.push(x, 0, z);
        colors.push(color.r, color.g, color.b);
      }
    }
  };
  if (key) {
    const ring = (angle: number, radius: number): [number, number] => [
      radius * Math.cos(angle),
      0.48 + radius * Math.sin(angle),
    ];
    const enamel = [0xf48c68, 0x7bcce5, 0xfacd79, 0x72d5ac];
    for (let i = 0; i < 32; i++) {
      const a = (i * Math.PI * 2) / 32;
      const b = ((i + 1) * Math.PI * 2) / 32;
      patch(enamel[Math.floor(i / 8)], [
        ring(a, 0.35),
        ring(b, 0.35),
        ring(b, 0.21),
        ring(a, 0.21),
      ]);
    }
    patch(0xfacb7b, [
      [-0.09, 0.8],
      [0.09, 0.8],
      [0.09, 2.12],
      [-0.09, 2.12],
    ]);
    for (const [i, tint] of enamel.slice(0, 3).entries()) {
      const z = 1.2 + i * 0.28;
      patch(tint, [
        [0.09, z],
        [0.31, z + 0.05],
        [0.31, z + 0.17],
        [0.09, z + 0.19],
      ]);
    }
    patch(0xffd08b, [
      [-0.16, 2.11],
      [0.16, 2.11],
      [0, 2.39],
    ]);
  } else {
    patch(0x9c516a, [
      [-0.62, 0],
      [-0.21, 0],
      [-0.1, 1.57],
      [-0.47, 1.21],
    ]);
    patch(0x8275b9, [
      [-0.18, 0],
      [0.17, 0],
      [0.1, 1.57],
      [0, 1.79],
      [-0.07, 1.6],
    ]);
    patch(0x3c968d, [
      [0.2, 0],
      [0.62, 0],
      [0.48, 1.17],
      [0.13, 1.53],
    ]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: key ? 0.8 : 0.24,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const cast = new THREE.Mesh(geometry, material);
  cast.name = key ? 'window-key-projection' : 'window-colored-light';
  cast.position.set(bay.x, 0.009, bay.z + CAST_START);
  parent.add(cast);
  return () => {
    cast.removeFromParent();
    geometry.dispose();
    material.dispose();
  };
}

export class WindowKeyCache {
  readonly object = new THREE.Group();
  private readonly hinge = new THREE.Group();
  private readonly plateGeometry = new THREE.BoxGeometry(TILE_HALF_X * 2, 0.024, TILE_HALF_Z * 2);
  private readonly edgeGeometry = new THREE.BoxGeometry(0.34, 0.026, 0.42);
  private readonly pullGeometry = new THREE.BoxGeometry(0.1, 0.018, 0.026);
  private readonly brass = new THREE.MeshStandardMaterial({
    color: 0xbb8544,
    metalness: 0.66,
    roughness: 0.37,
  });
  private readonly pocket = new THREE.MeshStandardMaterial({ color: 0x29221a, roughness: 0.84 });
  private readonly plate = new THREE.Mesh(this.plateGeometry, this.brass);
  private readonly ray = new THREE.Raycaster();
  private readonly bound = new THREE.Box3();
  private readonly contact = new THREE.Vector3();
  private opened = false;

  constructor(
    private readonly world: FloorWorld,
    private readonly bay: WindowBay,
  ) {
    this.object.name = 'window-key-cache';
    this.object.position.set(bay.x, 0.017, bay.z + TILE_OFFSET);
    const base = new THREE.Mesh(this.edgeGeometry, this.pocket);
    base.position.y = 0.003;
    this.hinge.position.z = -TILE_HALF_Z;
    this.plate.name = 'window-cache-tile';
    this.plate.position.set(0, 0.024, TILE_HALF_Z);
    const pull = new THREE.Mesh(this.pullGeometry, this.pocket);
    pull.position.set(0, 0.012, 0.128);
    this.plate.add(pull);
    this.hinge.add(this.plate);
    this.object.add(base, this.hinge);
    world.roomGroups[bay.room].add(this.object);
  }

  sync(opened: boolean): void {
    this.opened = opened;
    this.hinge.rotation.x = opened ? -Math.PI * 0.47 : 0;
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): { distance: number } | null {
    if (this.opened || this.world.current !== this.bay.room) return null;
    this.object.updateWorldMatrix(true, true);
    this.ray.set(origin, direction);
    this.ray.far = 3.6;
    const hit = this.ray.intersectObject(this.plate, true)[0];
    if (!hit) return null;
    const blocked = this.world.colliders[this.bay.room].some((box) => {
      this.bound.min.fromArray(box.min);
      this.bound.max.fromArray(box.max);
      return (
        this.ray.ray.intersectBox(this.bound, this.contact) !== null &&
        this.contact.distanceTo(origin) < hit.distance - 0.02
      );
    });
    return blocked ? null : { distance: hit.distance };
  }

  dispose(): void {
    this.object.removeFromParent();
    this.plateGeometry.dispose();
    this.edgeGeometry.dispose();
    this.pullGeometry.dispose();
    this.brass.dispose();
    this.pocket.dispose();
  }
}
