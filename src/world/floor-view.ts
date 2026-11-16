import * as THREE from 'three';
import { isValidSeed, normalizeSeed, randomSeed } from '../core/rng.ts';
import { generateFloor } from '../floor/generate.ts';
import { PALETTE } from '../palette.ts';
import { buildFloorWorld, type FloorWorld } from './floor-world.ts';

/** The run seed from `?seed=`, or a fresh random one when it is missing or malformed. */
export function seedFromQuery(search: string): string {
  const raw = new URLSearchParams(search).get('seed');
  if (raw && isValidSeed(raw)) return normalizeSeed(raw);
  if (raw) console.warn(`ignoring invalid seed "${raw}"`);
  return randomSeed();
}

export interface FloorView {
  world: FloorWorld;
  seed: string;
  /** Streams rooms around the rig; call once per frame with the rig's world position. */
  update(position: THREE.Vector3): void;
}

/** Greybox exploration view: the generated floor, flat greybox lighting, the rig at the entry. */
export function mountFloorView(scene: THREE.Scene, rig: THREE.Object3D, seed: string): FloorView {
  const world = buildFloorWorld(generateFloor(seed));
  scene.add(world.group);
  // Greybox lighting is two global lights; per-room sockets get real lights with the lightmaps (P4-T7).
  const sun = new THREE.DirectionalLight(PALETTE.candle, 1.4);
  sun.position.set(6, 12, 4);
  scene.add(sun, new THREE.HemisphereLight(PALETTE.candle, PALETTE.void, 0.8));
  rig.position.copy(world.spawnPoint());
  return {
    world,
    seed,
    update(position) {
      world.update(position.x, position.z);
    },
  };
}
