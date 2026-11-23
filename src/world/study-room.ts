import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { derivedFiles as corridorFiles } from '../../assets-source/rooms/corridor/provenance.json';
import { derivedFiles as vaultFiles } from '../../assets-source/rooms/guardian-vault/provenance.json';
import { GREYBOX_TEMPLATES, parseRoomTemplate, type RoomTemplate } from '../content/rooms.ts';
import {
  dressCandleFlames,
  dressFireplace,
  HALL_CANDLE_NICHES,
  removeHallCandleNiches,
} from './fireplace.ts';
import { closeLanternRoofs } from './lantern-roofs.ts';
import {
  configureLightmapTexture,
  loadRoomLightmap,
  parseTemplateManifest,
  type TemplateManifest,
} from './lightmap.ts';
import { type CompressedTextureLoader, configurePbrTexture, type PbrSet } from './materials.ts';
import { loadBookBindings, studyBookGeometry } from './study-books.ts';

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
 * A metal has no diffuse lobe, so the lightmap would never reach it and it would show only the
 * neutral probe; metals instead reflect the baked light as a uniform environment of radiance E/π,
 * weighted by metalness. The bake holds that irradiance because it zeroes Metallic while baking.
 */
export function bakedRoomMaterial<T extends THREE.MeshStandardMaterial>(material: T): T {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_fragment_begin>', () => roomLightsFragmentBegin())
      .replace(
        '#include <lights_fragment_maps>',
        [
          'irradiance = vec3( 0.0 );',
          '#include <lights_fragment_maps>',
          'iblIrradiance = vec3( 0.0 );',
          '#if defined( USE_LIGHTMAP ) && defined( RE_IndirectSpecular )',
          'radiance += metalnessFactor * lightMapIrradiance * RECIPROCAL_PI;',
          '#endif',
        ].join('\n'),
      )
      .replace(
        '#include <lights_fragment_end>',
        '#include <lights_fragment_end>\nreflectedLight.directDiffuse = vec3( 0.0 );',
      );
  };
  material.customProgramCacheKey = () => 'baked-room';
  return material;
}

/**
 * How an emitting slot meets the display transform and the probe, so it shows the bake's colour.
 * Constant emitters (flames, coals, lamp glass) emit above 1.0 linear, where AgX's shoulder pulls
 * them toward white, while the bake and its Standard-view review clip them and keep the hue; so they
 * skip tone mapping, and therefore also ignore `toneMappingExposure`. Emissive-mapped glass shows
 * transmitted light, which in a dark room outweighs any reflection of the interior, and the
 * placeholder probe is a lit studio whose panels mirror in the smooth glass; so glass takes no probe.
 */
export function emitterSlot(material: THREE.MeshStandardMaterial): {
  toneMapped: boolean;
  reflectsProbe: boolean;
} {
  const glows =
    material.emissiveIntensity > 0 &&
    Math.max(material.emissive.r, material.emissive.g, material.emissive.b) > 0;
  return {
    toneMapped: !(glows && !material.emissiveMap),
    reflectsProbe: !(glows && material.emissiveMap),
  };
}

/**
 * An untone-mapped emitter's output clips per channel at 1.0, which shifts its hue toward yellow
 * and white once a second channel passes 1.0 (fire (0.25, 0.125, 0.035) x 5.6 clips to lemon).
 * Capping the intensity so the strongest channel lands at 1.0 keeps the authored hue at the same
 * peak brightness the clip would have shown.
 */
export function untonedEmitterIntensity(material: THREE.MeshStandardMaterial): number {
  const peak = Math.max(material.emissive.r, material.emissive.g, material.emissive.b);
  return peak > 0 ? Math.min(material.emissiveIntensity, 1 / peak) : material.emissiveIntensity;
}

/**
 * A flame card is pure emission. Its lit term (albedo x lightmap) adds to the capped emission and
 * clips past 1.0 again beside the bake lights, which turned the vault's fire lemon (h46.5 vs 32.9).
 */
export function flameSlot(name: string): boolean {
  return name.endsWith('_flame');
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
/** Seat boundary wall faces on their own side of a shared room plane. Keep floor and ceiling edges. */
function seatBakedWalls(scene: THREE.Object3D, template: RoomTemplate): void {
  const { min, max } = template.footprint;
  const inset = 0.003;
  const exact = 0.0001;
  const seatWall = (node: THREE.Object3D) => {
    if (!(node instanceof THREE.Mesh)) return;
    const position = node.geometry.getAttribute('position');
    const normal = node.geometry.getAttribute('normal');
    if (!normal) return;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i),
        z = position.getZ(i);
      if (Math.abs(normal.getX(i)) > 0.999) {
        if (Math.abs(x - min[0]) < exact) position.setX(i, x + inset);
        else if (Math.abs(x - max[0]) < exact) position.setX(i, x - inset);
      } else if (Math.abs(normal.getZ(i)) > 0.999) {
        if (Math.abs(z - min[1]) < exact) position.setZ(i, z + inset);
        else if (Math.abs(z - max[1]) < exact) position.setZ(i, z - inset);
      }
    }
    position.needsUpdate = true;
  };
  scene.getObjectByName(template.id)?.traverse(seatWall);
  for (const door of template.doors)
    scene.getObjectByName(`door-plug-${door.id}`)?.traverse(seatWall);
}

/** Baked wallpaper underneath a removed niche retains its enclosure shadow in UV1. */
function repairHallNicheIrradiance(scene: THREE.Object3D, material: THREE.MeshStandardMaterial) {
  const wallpaper: THREE.Mesh[] = [];
  scene.getObjectByName('hall')?.traverse((node) => {
    if (node instanceof THREE.Mesh && node.material === material) wallpaper.push(node);
  });
  scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster();
  const number = (value: number) => value.toFixed(6);
  const patches = HALL_CANDLE_NICHES.flatMap(([x, z]) => {
    const northSouth = Math.abs(z) === 5;
    const inward = new THREE.Vector3(
      northSouth ? 0 : -Math.sign(x),
      0,
      northSouth ? -Math.sign(z) : 0,
    );
    const along = northSouth ? x : z;
    const fixed = northSouth ? z : x;
    const sample = (offset: number, y: number) => {
      const start = new THREE.Vector3(northSouth ? x + offset : x, y, northSouth ? z : z + offset);
      ray.set(start.add(inward), inward.clone().negate());
      return ray.intersectObjects(wallpaper, false)[0]?.uv1;
    };
    const corners = [
      sample(-0.66, 1.32),
      sample(-0.66, 2.6),
      sample(0.66, 1.32),
      sample(0.66, 2.6),
    ];
    if (!corners.every((uv) => uv !== undefined)) return [];
    const [leftLow, leftHigh, rightLow, rightHigh] = corners.map(
      (uv) => `vec2(${number(uv.x)}, ${number(uv.y)})`,
    );
    const horizontal = northSouth ? 'x' : 'z';
    const depth = northSouth ? 'z' : 'x';
    return [
      `{
      float along = vNichePosition.${horizontal} - (${number(along)});
      float edge = abs(vNichePosition.${depth} - (${number(fixed)}));
      float y = vNichePosition.y;
      float blend = (1.0 - smoothstep(0.39, 0.53, abs(along)))
        * smoothstep(1.32, 1.43, y) * (1.0 - smoothstep(2.45, 2.6, y));
      blend *= 1.0 - smoothstep(0.0, 0.06, edge);
      if (blend > 0.0) {
        float height = clamp((y - 1.32) / 1.28, 0.0, 1.0);
        vec3 leftLight = texture2D(lightMap, mix(${leftLow}, ${leftHigh}, height)).rgb;
        vec3 rightLight = texture2D(lightMap, mix(${rightLow}, ${rightHigh}, height)).rgb;
        vec3 wallLight = mix(leftLight, rightLight, clamp((along + 0.66) / 1.32, 0.0, 1.0));
        lightMapIrradiance = mix(lightMapIrradiance, wallLight * lightMapIntensity, blend);
      }
    }`,
    ];
  });
  if (!patches.length) return;
  const baked = material.onBeforeCompile;
  material.customProgramCacheKey = () => `baked-hall-niche:${patches.join('')}`;
  material.onBeforeCompile = (shader, renderer) => {
    baked(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNichePosition;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNichePosition = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vNichePosition;')
      .replace(
        '#include <lights_fragment_maps>',
        THREE.ShaderChunk.lights_fragment_maps.replace(
          'irradiance += lightMapIrradiance;',
          `${patches.join('\n')}\nirradiance += lightMapIrradiance;`,
        ),
      );
  };
}

export async function loadStudyAsset(options: {
  study: StudyManifest;
  bookBindings?: THREE.Texture | null;
  set: PbrSet;
  ktx2: CompressedTextureLoader;
  envMap?: THREE.Texture | null;
  base?: string;
  /** Softens the live fireplace fire's motion (the OS reduced-motion preference). */
  reducedMotion?: boolean;
}): Promise<StudyAsset> {
  const { study, set, ktx2 } = options;
  const id = study.manifest.template;
  const base = options.base ?? roomBase(id);
  const files = id === 'corridor' ? corridorFiles : id === 'guardian-vault' ? vaultFiles : [];
  const revision = (file: string) =>
    files.find((entry) => entry.path === `public/assets/rooms/${id}/${file}`)?.sha256;
  const glbHash = revision(study.manifest.glb);
  const gltf = await new GLTFLoader().loadAsync(
    `${base}/${study.manifest.glb}${glbHash ? `?v=${glbHash}` : ''}`,
  );
  const owned: THREE.Texture[] = [];
  const slots = new Map<string, THREE.MeshStandardMaterial>();
  for (const [name, entry] of Object.entries(study.materials)) {
    if (id === 'study' && name === 'study_books') {
      const atlas = options.bookBindings ?? (await loadBookBindings(ktx2));
      if (!options.bookBindings) owned.push(atlas);
      slots.set(name, new THREE.MeshStandardMaterial({ name, map: atlas, roughness: 0.78 }));
    } else {
      slots.set(name, await slotMaterial(name, entry, set, ktx2, base, study, owned, id));
    }
  }
  gltf.scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const authored = mesh.material as THREE.Material;
    const material = slots.get(authored.name);
    if (!material) throw new Error(`${id}: GLB slot ${authored.name}`);
    // Flame cards are authored double-sided; the slot material replaces the GLB's, so carry it over.
    if (authored.side === THREE.DoubleSide) material.side = THREE.DoubleSide;
    if (id === 'study' && authored.name === 'study_books') {
      const proxy = mesh.geometry;
      mesh.geometry = studyBookGeometry(proxy);
      proxy.dispose();
    }
    if ((id === 'gear-shaft' || id === 'corridor') && authored.name === `${id}_brass-aged`) {
      const original = mesh.geometry;
      mesh.geometry = closeLanternRoofs(id, original);
      if (original !== mesh.geometry) original.dispose();
    }
    mesh.material = material;
  });
  const lightmap = await loadRoomLightmap(
    study.manifest,
    base,
    ktx2,
    gltf.scene,
    revision(study.manifest.lightmap.file),
  );
  owned.push(lightmap.texture);
  const books = slots.get('study_books');
  if (id === 'study' && books) {
    // The room bake contains the old books' individual shadows. Use its shelf-level irradiance
    // on the new bindings so shadows from the previous silhouettes cannot cross their pages.
    const shelfLight = await ktx2.loadAsync(`/assets/props/study-books/book-irradiance.ktx2`);
    books.lightMap = configureLightmapTexture(shelfLight, study.manifest.lightmap);
    owned.push(shelfLight);
  }
  for (const [name, material] of slots) {
    bakedRoomMaterial(material);
    if (flameSlot(name)) material.color.setRGB(0, 0, 0);
    const slot = emitterSlot(material);
    material.toneMapped = slot.toneMapped;
    if (!slot.toneMapped) material.emissiveIntensity = untonedEmitterIntensity(material);
    if (options.envMap) material.envMap = options.envMap;
    material.envMapIntensity = slot.reflectsProbe ? STUDY_ENV_INTENSITY : 0;
  }
  const frameMaterials = new Map<THREE.MeshStandardMaterial, THREE.MeshStandardMaterial>();
  for (const door of study.template.doors) {
    gltf.scene.getObjectByName(`door-frame-${door.id}`)?.traverse((node) => {
      if (!(node instanceof THREE.Mesh) || !(node.material instanceof THREE.MeshStandardMaterial))
        return;
      const source = node.material;
      let twoSided = frameMaterials.get(source);
      if (!twoSided) {
        twoSided = bakedRoomMaterial(source.clone());
        twoSided.side = THREE.DoubleSide;
        frameMaterials.set(source, twoSided);
      }
      node.material = twoSided;
    });
  }
  // After the lightmap binding, which wants uv1 on every mesh: the fire is unlit.
  if (id === 'hall') {
    removeHallCandleNiches(gltf.scene);
    const wallpaper = slots.get('hall_wallpaper');
    if (wallpaper) repairHallNicheIrradiance(gltf.scene, wallpaper);
  }
  const fire = dressFireplace(id, gltf.scene, flameSlot, options.reducedMotion ?? false);
  const candles =
    id === 'hall' ? dressCandleFlames(gltf.scene, flameSlot, options.reducedMotion ?? false) : null;
  seatBakedWalls(gltf.scene, study.template);
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
      for (const material of frameMaterials.values()) material.dispose();
      fire?.dispose();
      candles?.material.dispose();
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
