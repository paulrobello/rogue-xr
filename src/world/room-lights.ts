import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MAX_LIGHT_SOCKETS, type RoomTemplate } from '../content/rooms.ts';
import { PALETTE } from '../palette.ts';

/**
 * Dynamic-light budget (PRD "Dynamic lights"): at most 4 per room, plus the hand lantern, so 5
 * point lights exist at once. Every light is a shader-program input, so the count is fixed and
 * the veil precompiles for exactly this worst case.
 *
 * Rule: a room that has more light sockets than `MAX_LIGHT_SOCKETS` is a content error and
 * `buildRoomLights` throws (silently dropping sockets would change an authored room's lighting).
 * The budget is global: a streamed-in room must be built after the room it replaces has been
 * disposed, otherwise the build throws instead of putting a sixth light in the scene.
 */
export const MAX_DYNAMIC_LIGHTS = MAX_LIGHT_SOCKETS + 1;

/** Tracks how many dynamic lights are alive across rooms and the lantern. */
export class DynamicLightBudget {
  private used = 0;

  constructor(readonly limit = MAX_DYNAMIC_LIGHTS) {}

  get inUse(): number {
    return this.used;
  }

  /** Reserves `count` lights. Returns a release function that is safe to call more than once. */
  reserve(count: number, what: string): () => void {
    if (this.used + count > this.limit) {
      throw new Error(
        `dynamic light budget: ${what} needs ${count}, ${this.used} of ${this.limit} in use`,
      );
    }
    this.used += count;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= count;
    };
  }
}

export interface LightOptions {
  budget?: DynamicLightBudget;
  color?: THREE.ColorRepresentation;
  /** Point light intensity in candela. */
  intensity?: number;
  /** Cut-off distance in metres, 0 for none. */
  distance?: number;
  decay?: number;
}

export interface LightRig {
  /** Room-local group holding the lights. Add it under the room root. */
  group: THREE.Group;
  lights: readonly THREE.PointLight[];
  /** Removes the lights and returns their budget. Safe to call more than once. */
  dispose(): void;
}

const SOCKET_DEFAULTS = { color: PALETTE.candle, intensity: 6, distance: 8, decay: 1.6 };
const LANTERN_DEFAULTS = { color: PALETTE.candle, intensity: 4, distance: 6, decay: 1.6 };

function makeRig(lights: THREE.PointLight[], group: THREE.Group, release: () => void): LightRig {
  return {
    group,
    lights,
    dispose() {
      group.removeFromParent();
      group.clear();
      release();
    },
  };
}

/**
 * One PointLight per light socket of `template`, at the socket's room-local position. No light
 * casts shadows, because baked direct light is not double-counted (PRD lightmap contract).
 */
export function buildRoomLights(template: RoomTemplate, options: LightOptions = {}): LightRig {
  const count = template.lightSockets.length;
  if (count > MAX_LIGHT_SOCKETS) {
    throw new Error(
      `room ${template.id}: ${count} light sockets, at most ${MAX_LIGHT_SOCKETS} dynamic lights per room`,
    );
  }
  const { budget = new DynamicLightBudget(), ...rest } = options;
  const { color, intensity, distance, decay } = { ...SOCKET_DEFAULTS, ...rest };
  const release = budget.reserve(count, `room ${template.id}`);
  const group = new THREE.Group();
  group.name = `lights-${template.id}`;
  const lights = template.lightSockets.map((socket) => {
    const light = new THREE.PointLight(color, intensity, distance, decay);
    light.name = `light-${socket.id}`;
    light.position.set(...socket.position);
    light.castShadow = false;
    group.add(light);
    return light;
  });
  return makeRig(lights, group, release);
}

/** The hand lantern: one PointLight that counts against the same global budget as room lights. */
export function createHandLantern(options: LightOptions = {}): LightRig {
  const { budget = new DynamicLightBudget(), ...rest } = options;
  const { color, intensity, distance, decay } = { ...LANTERN_DEFAULTS, ...rest };
  const release = budget.reserve(1, 'hand lantern');
  const group = new THREE.Group();
  group.name = 'hand-lantern';
  const light = new THREE.PointLight(color, intensity, distance, decay);
  light.name = 'lantern-light';
  light.castShadow = false;
  group.add(light);
  return makeRig([light], group, release);
}

/** A baked environment probe: the texture to assign to `scene.environment` and its disposer. */
export interface RoomProbe {
  texture: THREE.Texture;
  dispose(): void;
}

/** Height of the RoomEnvironment floor inside its own scene, so the floor lands on room y = 0. */
const ENVIRONMENT_FLOOR = 0.93;

/**
 * Bakes a PMREM from three's RoomEnvironment with the capture point at `template.probe`, with the
 * environment's floor on the room floor. A neutral studio stands in for the room until the
 * Blender bake ships probes, so metals reflect something plausible at the right height.
 */
export function createPmremProbeBaker(
  renderer: THREE.WebGLRenderer,
): (template: RoomTemplate) => RoomProbe {
  return (template) => {
    const generator = new THREE.PMREMGenerator(renderer);
    const environment = new RoomEnvironment();
    environment.position.y = ENVIRONMENT_FLOOR;
    const target = generator.fromScene(environment, 0.04, 0.1, 100, {
      position: new THREE.Vector3(...template.probe),
    });
    generator.dispose();
    for (const child of environment.children) {
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as THREE.Material | undefined;
      material?.dispose();
    }
    return { texture: target.texture, dispose: () => target.dispose() };
  };
}

/**
 * One probe per room template id, shared by every placement of that template. Reference counted:
 * a room acquires on load and releases on unload, and the GPU target is freed when the last
 * placement of the template unloads.
 */
export class RoomProbeCache {
  private readonly entries = new Map<string, { probe: RoomProbe; refs: number }>();

  constructor(private readonly bake: (template: RoomTemplate) => RoomProbe) {}

  get size(): number {
    return this.entries.size;
  }

  acquire(template: RoomTemplate): THREE.Texture {
    let entry = this.entries.get(template.id);
    if (!entry) {
      entry = { probe: this.bake(template), refs: 0 };
      this.entries.set(template.id, entry);
    }
    entry.refs++;
    return entry.probe.texture;
  }

  release(template: RoomTemplate): void {
    const entry = this.entries.get(template.id);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    entry.probe.dispose();
    this.entries.delete(template.id);
  }

  dispose(): void {
    for (const { probe } of this.entries.values()) probe.dispose();
    this.entries.clear();
  }
}
