// In-engine stills of the P5-T1 kit rooms (hall and corridor), loaded by
// assets-source/rooms/hall/engine_shot.py through the running Vite dev server (it serves and
// transforms this file; it is outside src/, biome and tsc). Uses the real runtime path:
// parseStudyManifest() and loadStudyAsset() with `base` pointed at the room's folder, the shared
// P4-T3 KTX2 set, the lightmap on UV1 and the baked-room shader patch; rooms are placed the way
// floor-world.ts places them (offset, clockwise quarter turns as negative Y rotation).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { generateFloor } from '/src/floor/generate.ts';
import { buildFloorWorld } from '/src/world/floor-world.ts';
import { createKtx2Loader } from '/src/world/ktx2.ts';
import { loadPbrSet } from '/src/world/materials.ts';
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
  floor?: { seed: string; at: [number, number] };
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
  if (!shot.diffuse) {
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
  const ids = shot.floor ? ['hall', 'corridor'] : shot.rooms.map((r) => r.id);
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
  renderer.render(scene, camera);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  renderer.render(scene, camera);
  return {
    calls: renderer.info.render.calls,
    triangles,
    sealed,
    programs: renderer.info.programs?.length ?? 0,
  };
}
