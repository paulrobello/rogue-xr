import * as THREE from 'three';
import { Stream } from '../core/rng.ts';
import { cogGeometry } from './cog-geometry.ts';
import type { FloorWorld } from './floor-world.ts';
import type { WindowBay } from './window-bays.ts';

const TILE_HALF_X = 0.15;
const TILE_HALF_Z = 0.19;
const BAKE_X_SLOPE = 0.12 / 0.75;
const POCKET_DEPTH = 0.145;
const POCKET_WALL = 0.012;

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
  private readonly compartmentGeometry: THREE.BoxGeometry[] = [];
  private readonly cogGeometry = cogGeometry(0.055);
  private readonly opening = { value: 0 };
  private floorCut?: {
    floor: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
    original: THREE.MeshStandardMaterial;
    material: THREE.MeshStandardMaterial;
  };
  private readonly stone = new THREE.MeshStandardMaterial({ color: 0x86725e, roughness: 0.93 });
  private readonly pocket = new THREE.MeshStandardMaterial({
    color: 0x34281f,
    emissive: 0x241911,
    roughness: 0.9,
  });
  private readonly brass = new THREE.MeshStandardMaterial({
    color: 0xb47b32,
    emissive: 0x4b2f0e,
    metalness: 0.78,
    roughness: 0.32,
  });
  private readonly plate: THREE.Mesh;
  private readonly compartment: THREE.Group;
  private readonly cogs = new THREE.Group();
  private readonly ray = new THREE.Raycaster();
  private readonly bound = new THREE.Box3();
  private readonly contact = new THREE.Vector3();
  private revealed = false;
  private claimed = false;

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
      this.cutOpening(floor, x, z);
    }
    this.stone.side = THREE.DoubleSide;
    this.plate = new THREE.Mesh(this.plateGeometry, this.stone);
    this.plate.name = 'window-cache-tile';
    this.object.name = 'window-key-cache';
    this.object.position.set(x, height + 0.003, z);
    const compartment = new THREE.Group();
    compartment.name = 'window-cache-compartment';
    const addWall = (
      width: number,
      height: number,
      depth: number,
      px: number,
      py: number,
      pz: number,
    ): void => {
      const geometry = new THREE.BoxGeometry(width, height, depth);
      this.compartmentGeometry.push(geometry);
      const mesh = new THREE.Mesh(geometry, this.pocket);
      mesh.position.set(px, py, pz);
      compartment.add(mesh);
    };
    addWall(2 * TILE_HALF_X, 0.016, 2 * TILE_HALF_Z, 0, -POCKET_DEPTH, 0);
    for (const side of [-1, 1]) {
      addWall(
        POCKET_WALL,
        POCKET_DEPTH,
        2 * TILE_HALF_Z,
        side * (TILE_HALF_X - POCKET_WALL / 2),
        -POCKET_DEPTH / 2,
        0,
      );
      addWall(
        2 * (TILE_HALF_X - POCKET_WALL),
        POCKET_DEPTH,
        POCKET_WALL,
        0,
        -POCKET_DEPTH / 2,
        side * (TILE_HALF_Z - POCKET_WALL / 2),
      );
    }
    compartment.visible = false;
    this.compartment = compartment;
    for (const [x, z, scale] of [
      [-0.07, -0.06, 0.9],
      [0.07, -0.01, 0.72],
      [-0.01, 0.08, 0.78],
    ] as const) {
      const cog = new THREE.Mesh(this.cogGeometry, this.brass);
      cog.name = 'window-cache-cog';
      cog.rotation.x = -Math.PI / 2;
      cog.position.set(x, -POCKET_DEPTH + 0.017, z);
      cog.scale.setScalar(scale);
      this.cogs.add(cog);
    }
    this.cogs.name = 'window-cache-cogs';
    this.cogs.visible = false;
    this.hinge.position.z = -TILE_HALF_Z;
    this.plate.position.set(0, 0.009, TILE_HALF_Z);
    this.hinge.add(this.plate);
    this.object.add(compartment, this.cogs, this.hinge);
    world.roomGroups[bay.room].add(this.object);
  }

  private cutOpening(
    floor: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
    x: number,
    z: number,
  ): void {
    const original = floor.material;
    const material = original.clone();
    // The baked model is still in room coordinates when the cache is built.
    const toRoom = floor.matrixWorld.clone();
    const bounds = new THREE.Vector4(
      x - TILE_HALF_X,
      z - TILE_HALF_Z,
      x + TILE_HALF_X,
      z + TILE_HALF_Z,
    );
    material.onBeforeCompile = (shader, renderer) => {
      original.onBeforeCompile.call(material, shader, renderer);
      shader.uniforms.windowCacheOpening = this.opening;
      shader.uniforms.windowCacheBounds = { value: bounds };
      shader.uniforms.windowCacheToRoom = { value: toRoom };
      shader.vertexShader =
        'varying vec2 vWindowCacheSurface;\nuniform mat4 windowCacheToRoom;\n' +
        shader.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvWindowCacheSurface = (windowCacheToRoom * vec4(position, 1.0)).xz;',
        );
      shader.fragmentShader =
        'varying vec2 vWindowCacheSurface;\nuniform float windowCacheOpening;\nuniform vec4 windowCacheBounds;\n' +
        shader.fragmentShader.replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
          if (windowCacheOpening > 0.5 &&
              all(greaterThan(vWindowCacheSurface, windowCacheBounds.xy)) &&
              all(lessThan(vWindowCacheSurface, windowCacheBounds.zw))) discard;`,
        );
    };
    material.customProgramCacheKey = () => original.customProgramCacheKey() + ':window-cache';
    floor.material = material;
    this.floorCut = { floor, original, material };
  }

  sync(revealed: boolean, claimed = false): void {
    this.revealed = revealed || claimed;
    this.claimed = claimed;
    this.compartment.visible = this.revealed;
    this.opening.value = Number(this.revealed);
    this.cogs.visible = this.revealed && !this.claimed;
    this.hinge.rotation.x = this.revealed ? -Math.PI * 0.47 : 0;
  }

  pick(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
  ): { action: 'open' | 'claim'; distance: number } | null {
    if (this.claimed || this.world.current !== this.bay.room) return null;
    this.object.updateWorldMatrix(true, true);
    this.ray.set(origin, direction);
    this.ray.far = 3.6;
    const target = this.revealed ? this.cogs : this.plate;
    const hit = this.ray.intersectObject(target, true)[0];
    if (!hit) return null;
    const blocked = this.world.colliders[this.bay.room].some((box) => {
      this.bound.min.fromArray(box.min);
      this.bound.max.fromArray(box.max);
      return (
        this.ray.ray.intersectBox(this.bound, this.contact) !== null &&
        this.contact.distanceTo(origin) < hit.distance - 0.02
      );
    });
    return blocked ? null : { action: this.revealed ? 'claim' : 'open', distance: hit.distance };
  }

  dispose(): void {
    this.object.removeFromParent();
    this.plateGeometry.dispose();
    for (const geometry of this.compartmentGeometry) geometry.dispose();
    if (this.floorCut) {
      const { floor, original, material } = this.floorCut;
      if (floor.material === material) floor.material = original;
      material.dispose();
    }
    this.cogGeometry.dispose();
    this.stone.dispose();
    this.pocket.dispose();
    this.brass.dispose();
  }
}
