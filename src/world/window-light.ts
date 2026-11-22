import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import type { FloorWorld } from './floor-world.ts';
import type { WindowBay } from './window-bays.ts';

const TILE_HALF_X = 0.15;
const TILE_HALF_Z = 0.19;
const BAKE_X_SLOPE = 0.12 / 0.75;

export interface WindowKeySite extends WindowBay {
  readonly tileOffset: number;
}

function keyTileX(site: WindowKeySite): number {
  return site.x + site.tileOffset * BAKE_X_SLOPE;
}

export function windowCacheBay(
  world: FloorWorld,
  windows: readonly WindowBay[],
  seed: string,
): WindowKeySite | undefined {
  const candidates = Stream.fromKey(`${seed}:window-cache`).shuffle([...windows]);
  for (const bay of candidates) {
    if (world.plan.rooms[bay.room].role === 'guardian') continue;
    const parent = world.roomGroups[bay.room];
    parent.updateWorldMatrix(true, false);
    const { min, max } = world.rooms[bay.room].footprint;
    for (const tileOffset of [4.55, 4.15, 3.8]) {
      const site = { ...bay, tileOffset };
      const tileX = keyTileX(site);
      const tileZ = bay.z + tileOffset;
      const target = new THREE.Box3(
        new THREE.Vector3(tileX - 0.38, 0.025, tileZ - 0.38),
        new THREE.Vector3(tileX + 0.38, 0.48, tileZ + 0.38),
      ).applyMatrix4(parent.matrixWorld);
      if (
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
      )
        return site;
    }
  }
  return undefined;
}

/** Sample the same base texture and lightmap charts as the masonry below each corner of the lid. */
function matchFloorLid(
  geometry: THREE.PlaneGeometry,
  floor: THREE.Mesh,
  x: number,
  z: number,
): number {
  floor.updateWorldMatrix(true, false);
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const origin = new THREE.Vector3();
  const positions = geometry.getAttribute('position');
  const baseUv = geometry.getAttribute('uv');
  const lightUv = new THREE.Float32BufferAttribute(new Float32Array(positions.count * 2), 2);
  let height = 0;
  for (let i = 0; i < positions.count; i++) {
    origin.set(x + positions.getX(i), 0.3, z + positions.getZ(i));
    ray.set(origin, down);
    const hit = ray.intersectObject(floor, false)[0];
    if (!hit) continue;
    height = Math.max(height, hit.point.y);
    if (hit.uv) baseUv.setXY(i, hit.uv.x, hit.uv.y);
    if (hit.uv1) lightUv.setXY(i, hit.uv1.x, hit.uv1.y);
  }
  geometry.setAttribute('uv1', lightUv);
  return height;
}

export class WindowKeyCache {
  readonly object = new THREE.Group();
  private readonly hinge = new THREE.Group();
  private readonly plateGeometry = new THREE.PlaneGeometry(
    TILE_HALF_X * 2,
    TILE_HALF_Z * 2,
  ).rotateX(-Math.PI / 2);
  private readonly edgeGeometry = new THREE.BoxGeometry(0.308, 0.01, 0.388);
  private readonly stone = new THREE.MeshStandardMaterial({ color: 0x86725e, roughness: 0.93 });
  private readonly pocket = new THREE.MeshStandardMaterial({ color: 0x34281f, roughness: 0.9 });
  private readonly plate: THREE.Mesh;
  private readonly ray = new THREE.Raycaster();
  private readonly bound = new THREE.Box3();
  private readonly contact = new THREE.Vector3();
  private opened = false;

  constructor(
    private readonly world: FloorWorld,
    private readonly bay: WindowKeySite,
    model: THREE.Object3D,
  ) {
    const x = keyTileX(bay);
    const z = bay.z + bay.tileOffset;
    model.updateWorldMatrix(true, true);
    let floor: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> | undefined;
    model.traverse((node) => {
      if (
        node instanceof THREE.Mesh &&
        node.material instanceof THREE.MeshStandardMaterial &&
        node.material.name.endsWith('_stone-floor')
      )
        floor = node;
    });
    const height = floor ? matchFloorLid(this.plateGeometry, floor, x, z) : 0;
    if (floor) {
      this.stone.copy(floor.material);
      this.stone.color.multiplyScalar(0.95);
      this.stone.onBeforeCompile = floor.material.onBeforeCompile;
      this.stone.customProgramCacheKey = floor.material.customProgramCacheKey;
    }
    this.stone.side = THREE.DoubleSide;
    this.plate = new THREE.Mesh(this.plateGeometry, this.stone);
    this.plate.name = 'window-cache-tile';
    this.object.name = 'window-key-cache';
    this.object.position.set(x, height + 0.003, z);
    const base = new THREE.Mesh(this.edgeGeometry, this.pocket);
    base.name = 'window-cache-seam';
    this.hinge.position.z = -TILE_HALF_Z;
    this.plate.position.set(0, 0.009, TILE_HALF_Z);
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
    this.stone.dispose();
    this.pocket.dispose();
  }
}
