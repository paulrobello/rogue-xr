import * as THREE from 'three';
import { EncounterDirector } from '../combat/encounter.ts';
import { isValidSeed, normalizeSeed, randomSeed } from '../core/rng.ts';
import { generateFloor } from '../floor/generate.ts';
import { PALETTE } from '../palette.ts';
import { yawFromMatrix } from '../xr/locomotion.ts';
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
  encounter: EncounterDirector;
  /** True while an encounter holds the player in place. */
  readonly locked: boolean;
  /**
   * Streams rooms around the head and triggers encounters. `head` is the camera; call once per
   * frame before rendering.
   */
  update(head: THREE.Object3D, dt: number): void;
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

  let locked = false;
  const encounter = new EncounterDirector({
    world,
    lockLocomotion: (l) => {
      locked = l;
    },
  });
  const at = new THREE.Vector3();
  return {
    world,
    seed,
    encounter,
    get locked() {
      return locked;
    },
    update(head, dt) {
      encounter.update(dt);
      head.getWorldPosition(at);
      // The fight owns the room until it ends, so streaming holds still meanwhile.
      if (encounter.phase !== 'idle') return;
      world.update(at.x, at.z);
      const hit = encounter.checkTrigger({ x: at.x, z: at.z });
      if (!hit) return;
      encounter.begin(hit.room, {
        x: at.x,
        z: at.z,
        yaw: yawFromMatrix(head.matrixWorld.elements),
        eyeHeight: at.y,
      });
    },
  };
}
