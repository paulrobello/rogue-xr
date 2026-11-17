import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GREYBOX_TEMPLATES, parseRoomTemplate, type RoomTemplate } from '../content/rooms.ts';
import { loadRoomLightmap, parseTemplateManifest, type TemplateManifest } from './lightmap.ts';
import { type CompressedTextureLoader, configurePbrTexture, type PbrSet } from './materials.ts';

/** The baked hero rooms (P4-T4, P5-T1, P5-T2): each is `<id>.glb`, its lightmap and its manifest. */
export const HERO_ROOMS = ['study', 'hall', 'corridor', 'gear-shaft', 'guardian-vault'] as const;
/** Where a baked room's files live. */
export const roomBase = (id: string): string => `/assets/rooms/${id}`;
/** Environment reflection strength on the study's surfaces, as calibrated in `?view=room-asset-proof`. */
const STUDY_ENV_INTENSITY = 0.12;

type SlotEntry =
  | { pbr: string; tileMeters: number }
  | { maps: { basecolor: string; normal: string; orm: string }; uv: 0 }
  | { color: string; roughness?: number; emissive?: string; emissiveIntensity?: number };

/** A model node the runtime turns at a constant rate about `axis` (room-local), unrotated at rest. */
export interface RigidNode {
  node: string;
  axis: [number, number, number];
  radPerSec: number;
}

export interface StudyManifest {
  manifest: TemplateManifest;
  template: RoomTemplate;
  materials: Record<string, SlotEntry>;
  glassEmissiveIntensity: number;
  rigidNodes: RigidNode[];
}

function parseRigidNodes(raw: unknown): RigidNode[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('room manifest: rigidNodes must be an array');
  return raw.map((entry: Partial<RigidNode>, i) => {
    const axis = entry.axis;
    const ok =
      typeof entry.node === 'string' &&
      typeof entry.radPerSec === 'number' &&
      Number.isFinite(entry.radPerSec) &&
      Array.isArray(axis) &&
      axis.length === 3 &&
      axis.every((v) => typeof v === 'number') &&
      Math.hypot(...axis) > 0;
    if (!ok) throw new Error(`room manifest: rigidNodes[${i}] needs node, axis and radPerSec`);
    return {
      node: entry.node as string,
      axis: axis as RigidNode['axis'],
      radPerSec: entry.radPerSec as number,
    };
  });
}

/** A rigid node's angle `seconds` into its spin, wrapped to [0, 2π) so long sessions keep precision. */
export function rigidAngle(radPerSec: number, seconds: number): number {
  const turn = Math.PI * 2;
  const a = (radPerSec * seconds) % turn;
  return a < 0 ? a + turn : a;
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
    rigidNodes: parseRigidNodes((raw as { rigidNodes?: unknown }).rigidNodes),
  };
}

/** Fetches and parses a baked room's manifest, `<base>/<id>.manifest.json`. */
export async function fetchStudyManifest(
  id = 'study',
  base = roomBase(id),
): Promise<StudyManifest> {
  const response = await fetch(`${base}/${id}.manifest.json`);
  if (!response.ok) throw new Error(`${id} manifest: HTTP ${response.status}`);
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

/** `heroTemplates` for every baked room that loaded; a null (failed) entry keeps its greybox. */
export function heroRoomTemplates(
  heroes: readonly (RoomTemplate | null)[],
  base: readonly RoomTemplate[] = GREYBOX_TEMPLATES,
): readonly RoomTemplate[] {
  return heroes.reduce<readonly RoomTemplate[]>(
    (templates, t) => heroTemplates(t, templates),
    base,
  );
}

/** The distant-light loops of three's lights_fragment_begin, which baked rooms compile out. */
const DISTANT_LIGHT_LOOPS = [
  '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )',
  '#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )',
] as const;

/** three's lights_fragment_begin with the directional and sun light loops disabled. */
export function roomLightsFragmentBegin(
  chunk: string = THREE.ShaderChunk.lights_fragment_begin,
): string {
  return DISTANT_LIGHT_LOOPS.reduce((src, loop) => {
    if (!src.includes(loop)) throw new Error(`bakedRoomMaterial: three chunk lacks "${loop}"`);
    return src.replace(loop, '#if 0');
  }, chunk);
}

/**
 * Lightmap contract (PRD): the bake already holds diffuse direct and indirect light, so the room's
 * surfaces take only the specular part of the dynamic lights and of the environment probe, and no
 * ambient, hemisphere or probe diffuse fill. three adds the probe's diffuse from `iblIrradiance`
 * (summed in lights_fragment_maps, spent in RE_IndirectSpecular), not from `irradiance`.
 * Directional (and sun) lights are skipped entirely: an interior room has no distant light, so the
 * greybox sun's specular is a sheen from nowhere in the bake. Point and spot lights (room sockets,
 * the hand lantern) keep their specular; the probe's specular carries brass and wet-stone gloss.
 */
export function bakedRoomMaterial<T extends THREE.MeshStandardMaterial>(material: T): T {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_begin>', () => roomLightsFragmentBegin())
      .replace(
        '#include <lights_fragment_maps>',
        'irradiance = vec3( 0.0 );\n#include <lights_fragment_maps>\niblIrradiance = vec3( 0.0 );',
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
  const id = study.manifest.template;
  const base = options.base ?? roomBase(id);
  const gltf = await new GLTFLoader().loadAsync(`${base}/${study.manifest.glb}`);
  const owned: THREE.Texture[] = [];
  const slots = new Map<string, THREE.MeshStandardMaterial>();
  for (const [name, entry] of Object.entries(study.materials)) {
    slots.set(name, await slotMaterial(name, entry, set, ktx2, base, study, owned, id));
  }
  gltf.scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const material = slots.get((mesh.material as THREE.Material).name);
    if (!material) throw new Error(`${id}: GLB slot ${(mesh.material as THREE.Material).name}`);
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
  id: string,
): Promise<THREE.MeshStandardMaterial> {
  if ('pbr' in entry) {
    const shared = set.materials.get(entry.pbr);
    if (!shared) throw new Error(`${id}: ${name} wants unknown material ${entry.pbr}`);
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
