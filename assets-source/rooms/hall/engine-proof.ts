// In-engine stills of the P5-T1 kit rooms (hall and corridor), loaded by
// assets-source/rooms/hall/engine_shot.py through the running Vite dev server (it serves and
// transforms this file; it is outside src/, biome and tsc). Uses the real runtime path:
// parseStudyManifest() and loadStudyAsset() with `base` pointed at the room's folder, the shared
// P4-T3 KTX2 set, the lightmap on UV1 and the baked-room shader patch; rooms are placed the way
// floor-world.ts places them (offset, clockwise quarter turns as negative Y rotation).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { generateFloor } from '/src/floor/generate.ts';
import { PALETTE } from '/src/palette.ts';
import { buildFloorWorld } from '/src/world/floor-world.ts';
import { createKtx2Loader } from '/src/world/ktx2.ts';
import { loadPbrSet } from '/src/world/materials.ts';
import { buildRoomLights, createHandLantern, DynamicLightBudget } from '/src/world/room-lights.ts';
import {
  heroTemplates,
  loadStudyAsset,
  parseStudyManifest,
  type StudyAsset,
  type StudyManifest,
} from '/src/world/study-room.ts';

export interface ShotRoom {
  id: string;
  position: [number, number];
  turns: 0 | 1 | 2 | 3;
}

export interface Shot {
  rooms: ShotRoom[];
  eye: [number, number, number];
  look: [number, number, number];
  vfov: number;
  /** Lightmap only: no tone mapping, no environment, metalness 0 (matches the Cycles diffuse reference). */
  diffuse: boolean;
  /**
   * Real floor-world path instead of `rooms`: generateFloor(seed) -> buildFloorWorld() with the kit
   * templates swapped in -> dressRoom() per kit room (as floor-view's useRoomAsset does), sealed
   * door caps included; `at` is the floor point that picks the current room.
   */
  floor?: { seed: string; at: [number, number]; kit?: string[] };
  /** Turns a named rigid node (e.g. the gear-shaft crown gear) about its local Y before the frame. */
  spin?: { node: string; angle: number };
  /**
   * Room-light investigation toggles (engine_shot.py --variants). Each defaults to the shipped
   * runtime, so shots without them render exactly as before.
   */
  light?: {
    /** No environment map on the room materials at all (lightmap only, still under AgX). */
    envOff?: boolean;
    /** false: zero `iblIrradiance` on the baked-room programs, so the probe adds specular only. */
    envDiffuse?: boolean;
    /** Overrides STUDY_ENV_INTENSITY on the room materials. */
    envIntensity?: number;
    /** Multiplies every room material's lightMapIntensity (the manifest value). */
    lightmapGain?: number;
    /** Overrides aoMapIntensity on room materials that have an ORM aoMap (0: no AO on the lightmap). */
    aoIntensity?: number;
    /** floor-view.ts greybox lights: DirectionalLight(candle, 1.4) at (6, 12, 4) and HemisphereLight(candle, void, 0.8). */
    gameLights?: boolean;
    /** room-lights.ts: each room's socket lights and the hand lantern 0.35 m below, 0.4 m ahead of the eye. */
    dynamicLights?: boolean;
    /** Colour-wash investigation: 'none' renders the full material path without AgX. */
    tone?: 'none';
    /** envMapIntensity 0 on room slots whose name contains any of these. */
    envOffSlots?: string[];
    /** toneMapped false on room slots whose name contains any of these. */
    untonedSlots?: string[];
    /** toneMapped true on room slots whose name contains any of these (undoes a runtime opt-out). */
    tonedSlots?: string[];
    /** Region mask: slots whose name contains any of these render white, everything else black. */
    mask?: string[];
  };
}

export async function mountKitProof(w: number, h: number, shot: Shot) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = shot.diffuse ? THREE.NoToneMapping : THREE.AgXToneMapping;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color().setRGB(0.004, 0.003, 0.002, THREE.LinearSRGBColorSpace);
  let env: THREE.Texture | null = null;
  if (!shot.diffuse && !shot.light?.envOff) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
  }
  const ktx2 = createKtx2Loader(renderer);
  const set = await loadPbrSet('/assets/materials', {
    anisotropy: renderer.capabilities.getMaxAnisotropy(),
    ktx2,
  });
  const assets = new Map<string, StudyAsset>();
  const manifests: StudyManifest[] = [];
  const ids = shot.floor ? (shot.floor.kit ?? ['hall', 'corridor']) : shot.rooms.map((r) => r.id);
  for (const id of ids) {
    if (assets.has(id)) continue;
    const base = `/assets/rooms/${id}`;
    const raw: unknown = await (await fetch(`${base}/${id}.manifest.json`)).json();
    const study = parseStudyManifest(raw);
    manifests.push(study);
    assets.set(id, await loadStudyAsset({ study, set, ktx2, envMap: env, base }));
  }
  ktx2.dispose();
  let triangles = 0;
  let sealed = 0;
  const models: THREE.Object3D[] = [];
  if (shot.floor) {
    const kit = manifests.reduce<ReturnType<typeof heroTemplates>>(
      (t, m) => heroTemplates(m.template, t),
      heroTemplates(null),
    );
    const world = buildFloorWorld(generateFloor(shot.floor.seed), kit);
    world.plan.rooms.forEach((room, index) => {
      const asset = assets.get(room.templateId);
      if (!asset) return;
      const model = asset.instantiate();
      world.dressRoom(index, model);
      models.push(model);
    });
    // Sealed doorways get the game's walnut leaf (src/main.ts sealedDoorMaterial).
    const walnut = set.materials.get('walnut');
    const tileMeters = set.manifest.walnut?.tileMeters;
    if (walnut && tileMeters) {
      const leaf = walnut.clone();
      leaf.name = 'sealed-door';
      if (env) {
        leaf.envMap = env;
        leaf.envMapIntensity = 0.12;
      }
      world.dressSealedDoors(leaf, tileMeters);
    }
    world.update(...shot.floor.at);
    scene.add(world.group);
    world.group.traverseVisible((node) => {
      if (node.name.startsWith('sealed-')) sealed++;
    });
  } else {
    for (const room of shot.rooms) {
      const model = assets.get(room.id)?.instantiate();
      if (!model) throw new Error(`kit proof: ${room.id} missing`);
      const group = new THREE.Group();
      group.position.set(room.position[0], 0, room.position[1]);
      group.rotation.y = (-Math.PI / 2) * room.turns;
      group.add(model);
      scene.add(group);
      models.push(model);
    }
  }
  let spun = 0;
  if (shot.spin) {
    for (const model of models) {
      const node = model.getObjectByName(shot.spin.node);
      if (!node) continue;
      node.rotation.y = shot.spin.angle;
      spun++;
    }
    if (spun === 0) throw new Error(`kit proof: no node ${shot.spin.node}`);
  }
  for (const model of models) {
    model.traverse((node) => {
      const mesh = node as THREE.Mesh;
      if (!mesh.isMesh) return;
      triangles += (mesh.geometry.index?.count ?? 0) / 3;
      if (shot.diffuse) {
        const m = mesh.material as THREE.MeshStandardMaterial;
        m.metalness = 0;
        m.metalnessMap = null;
        m.needsUpdate = true;
      }
    });
  }
  const camera = new THREE.PerspectiveCamera(shot.vfov, w / h, 0.05, 100);
  camera.position.set(...shot.eye);
  camera.lookAt(...shot.look);
  const light = shot.light;
  let dynamicLights = 0;
  if (light) {
    const seen = new Set<THREE.MeshStandardMaterial>();
    for (const model of models) {
      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = mesh.material as THREE.MeshStandardMaterial;
        if (seen.has(m)) return;
        seen.add(m);
        if (light.envIntensity !== undefined && m.envMap) m.envMapIntensity = light.envIntensity;
        if (light.lightmapGain !== undefined) m.lightMapIntensity *= light.lightmapGain;
        if (light.aoIntensity !== undefined && m.aoMap) m.aoMapIntensity = light.aoIntensity;
        const hit = (names?: string[]) => !!names?.some((s) => m.name.includes(s));
        if (hit(light.envOffSlots)) m.envMapIntensity = 0;
        if (hit(light.untonedSlots)) m.toneMapped = false;
        if (hit(light.tonedSlots)) m.toneMapped = true;
        if (light.envDiffuse === false) {
          const baked = m.onBeforeCompile;
          m.onBeforeCompile = (shader, r) => {
            baked.call(m, shader, r);
            shader.fragmentShader = shader.fragmentShader.replace(
              '#include <lights_fragment_end>',
              'iblIrradiance = vec3( 0.0 );\n#include <lights_fragment_end>',
            );
          };
          m.customProgramCacheKey = () => 'baked-room-no-ibl-diffuse';
        }
        m.needsUpdate = true;
      });
    }
    if (light.tone === 'none') renderer.toneMapping = THREE.NoToneMapping;
    if (light.mask) {
      const on = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
      const off = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
      const names = light.mask;
      scene.background = new THREE.Color(0x000000);
      for (const model of models) {
        model.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (!mesh.isMesh) return;
          const n = (mesh.material as THREE.Material).name;
          mesh.material = names.some((s) => n.includes(s)) ? on : off;
        });
      }
    }
    if (light.gameLights) {
      const sun = new THREE.DirectionalLight(PALETTE.candle, 1.4);
      sun.position.set(6, 12, 4);
      scene.add(sun, new THREE.HemisphereLight(PALETTE.candle, PALETTE.void, 0.8));
    }
    if (light.dynamicLights) {
      const placed = shot.floor ? [] : shot.rooms;
      for (const room of placed) {
        const template = manifests.find((m) => m.template.id === room.id)?.template;
        if (!template) continue;
        const rig = buildRoomLights(template, { budget: new DynamicLightBudget() });
        rig.group.position.set(room.position[0], 0, room.position[1]);
        rig.group.rotation.y = (-Math.PI / 2) * room.turns;
        scene.add(rig.group);
        dynamicLights += rig.lights.length;
      }
      const lantern = createHandLantern();
      const ahead = new THREE.Vector3();
      camera.getWorldDirection(ahead);
      ahead.y = 0;
      ahead.normalize().multiplyScalar(0.4);
      lantern.group.position.set(shot.eye[0] + ahead.x, shot.eye[1] - 0.35, shot.eye[2] + ahead.z);
      scene.add(lantern.group);
      dynamicLights += 1;
    }
  }
  renderer.render(scene, camera);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  renderer.render(scene, camera);
  return {
    calls: renderer.info.render.calls,
    triangles,
    sealed,
    spun,
    dynamicLights,
    programs: renderer.info.programs?.length ?? 0,
  };
}
