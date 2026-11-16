import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GREYBOX_TEMPLATES, parseRoomTemplate, type RoomTemplate } from '../content/rooms.ts';
import { loadRoomLightmap, parseTemplateManifest, type TemplateManifest } from './lightmap.ts';
import { type CompressedTextureLoader, configurePbrTexture, type PbrSet } from './materials.ts';

/** The baked hero study (P4-T4): `study.glb`, its lightmap and its manifest. */
export const STUDY_BASE = '/assets/rooms/study';
/** Environment reflection strength on the study's surfaces, as calibrated in `?view=room-asset-proof`. */
const STUDY_ENV_INTENSITY = 0.12;

type SlotEntry =
  | { pbr: string; tileMeters: number }
  | { maps: { basecolor: string; normal: string; orm: string }; uv: 0 }
  | { color: string; roughness?: number; emissive?: string; emissiveIntensity?: number };

export interface StudyManifest {
  manifest: TemplateManifest;
  template: RoomTemplate;
  materials: Record<string, SlotEntry>;
  glassEmissiveIntensity: number;
}

/** Parses the study manifest: lightmap contract, room template and material slots. */
export function parseStudyManifest(raw: unknown): StudyManifest {
  const r = raw as Partial<Omit<StudyManifest, 'manifest' | 'template'>>;
  if (!r.materials || typeof r.materials !== 'object')
    throw new Error('study manifest: materials missing');
  return {
    manifest: parseTemplateManifest(raw),
    template: parseRoomTemplate(raw),
    materials: r.materials,
    glassEmissiveIntensity: r.glassEmissiveIntensity ?? 1,
  };
}

export async function fetchStudyManifest(base = STUDY_BASE): Promise<StudyManifest> {
  const response = await fetch(`${base}/study.manifest.json`);
  if (!response.ok) throw new Error(`study manifest: HTTP ${response.status}`);
  return parseStudyManifest(await response.json());
}

/** What floor generation relied on: a template with these may stand in for the greybox one. */
function layoutKey(t: RoomTemplate): string {
  return JSON.stringify([
    t.id,
    t.kinds,
    t.footprint,
    t.rotations,
    t.doors.map((d) => [d.id, d.facing, d.position, d.width]),
    t.enemySockets.map((s) => [s.id, s.position, s.yaw]),
    t.lootSockets.map((s) => [s.id, s.position]),
  ]);
}

/**
 * The templates the world is built from: `base` with the baked study's template (its extra desk and
 * shelf colliders) in place of the greybox study. Floor plans are generated from the greybox set, so
 * the swap happens only when the doors, sockets and footprint match exactly; otherwise `base` stays.
 */
export function heroTemplates(
  study: RoomTemplate | null,
  base: readonly RoomTemplate[] = GREYBOX_TEMPLATES,
): readonly RoomTemplate[] {
  if (!study) return base;
  const greybox = base.find((t) => t.id === study.id);
  if (!greybox || layoutKey(greybox) !== layoutKey(study)) {
    console.warn(`hero template ${study.id} does not match its greybox layout; greybox kept`);
    return base;
  }
  return base.map((t) => (t.id === study.id ? study : t));
}

/**
 * Lightmap contract (PRD): the bake already holds diffuse direct and indirect light, so the room's
 * surfaces take only the specular part of the dynamic lights and no ambient or hemisphere fill.
 */
export function bakedRoomMaterial<T extends THREE.MeshStandardMaterial>(material: T): T {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <lights_fragment_maps>',
        'irradiance = vec3( 0.0 );\n#include <lights_fragment_maps>',
      )
      .replace(
        '#include <lights_fragment_end>',
        '#include <lights_fragment_end>\nreflectedLight.directDiffuse = vec3( 0.0 );',
      );
  };
  material.customProgramCacheKey = () => 'baked-room';
  return material;
}

export interface StudyAsset {
  readonly manifest: StudyManifest;
  /** Every texture the instances read, for the load veil's spread uploads. */
  readonly textures: readonly THREE.Texture[];
  /** A new room-local study model. Instances share geometry, materials and the lightmap. */
  instantiate(): THREE.Object3D;
  dispose(): void;
}

/**
 * Loads the study GLB and binds its slots. Set-backed slots are clones of `set`'s materials, so they
 * share its textures but own their lightmap binding and never touch materials the table, the sentry
 * or another template use. Every instance shares the one lightmap, because it is the template's bake.
 */
export async function loadStudyAsset(options: {
  study: StudyManifest;
  set: PbrSet;
  ktx2: CompressedTextureLoader;
  envMap?: THREE.Texture | null;
  base?: string;
}): Promise<StudyAsset> {
  const { study, set, ktx2 } = options;
  const base = options.base ?? STUDY_BASE;
  const gltf = await new GLTFLoader().loadAsync(`${base}/${study.manifest.glb}`);
  const owned: THREE.Texture[] = [];
  const slots = new Map<string, THREE.MeshStandardMaterial>();
  for (const [name, entry] of Object.entries(study.materials)) {
    slots.set(name, await slotMaterial(name, entry, set, ktx2, base, study, owned));
  }
  gltf.scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = slots.get((mesh.material as THREE.Material).name);
    if (!material) throw new Error(`study: GLB slot ${(mesh.material as THREE.Material).name}`);
    mesh.material = material;
  });
  const lightmap = await loadRoomLightmap(study.manifest, base, ktx2, gltf.scene);
  owned.push(lightmap.texture);
  for (const material of slots.values()) {
    bakedRoomMaterial(material);
    if (options.envMap) {
      material.envMap = options.envMap;
      material.envMapIntensity = STUDY_ENV_INTENSITY;
    }
  }
  gltf.scene.name = `${study.manifest.template}-model`;
  const textures = new Set<THREE.Texture>();
  for (const material of slots.values()) {
    for (const t of [
      material.map,
      material.normalMap,
      material.roughnessMap,
      material.emissiveMap,
      material.lightMap,
    ]) {
      if (t) textures.add(t);
    }
  }
  return {
    manifest: study,
    textures: [...textures],
    instantiate: () => gltf.scene.clone(true),
    dispose() {
      gltf.scene.traverse((node) => {
        if ((node as THREE.Mesh).isMesh) (node as THREE.Mesh).geometry.dispose();
      });
      for (const material of slots.values()) material.dispose();
      for (const texture of owned) texture.dispose();
    },
  };
}

async function slotMaterial(
  name: string,
  entry: SlotEntry,
  set: PbrSet,
  ktx2: CompressedTextureLoader,
  base: string,
  study: StudyManifest,
  owned: THREE.Texture[],
): Promise<THREE.MeshStandardMaterial> {
  if ('pbr' in entry) {
    const shared = set.materials.get(entry.pbr);
    if (!shared) throw new Error(`study: ${name} wants unknown material ${entry.pbr}`);
    const material = shared.clone();
    material.name = name;
    if (material.emissiveMap) material.emissiveIntensity = study.glassEmissiveIntensity;
    return material;
  }
  if ('maps' in entry) {
    // Baked on the GLB's own UV0, so these keep glTF orientation: flipY false.
    const load = async (file: string, role: 'basecolor' | 'normal' | 'orm') => {
      const texture = await ktx2.loadAsync(`${base}/${file}`);
      texture.flipY = false;
      configurePbrTexture(texture, role);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      owned.push(texture);
      return texture;
    };
    const [map, normalMap, orm] = await Promise.all([
      load(entry.maps.basecolor, 'basecolor'),
      load(entry.maps.normal, 'normal'),
      load(entry.maps.orm, 'orm'),
    ]);
    const material = new THREE.MeshStandardMaterial({
      name,
      map,
      normalMap,
      aoMap: orm,
      roughnessMap: orm,
      metalnessMap: orm,
      roughness: 1,
      metalness: 1,
    });
    // No vertex tangents: three derives them from UV derivatives, so glTF's flipped V flips green.
    material.normalScale.set(1, -1);
    return material;
  }
  const material = new THREE.MeshStandardMaterial({
    name,
    color: entry.color,
    roughness: entry.roughness ?? 0.6,
  });
  if (entry.emissive) {
    material.emissive = new THREE.Color(entry.emissive);
    material.emissiveIntensity = entry.emissiveIntensity ?? 1;
  }
  return material;
}
