import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { DieId } from '../content/dice.ts';
import type { UvRect } from '../ui/icon-atlas.ts';
import type { PbrSet } from '../world/materials.ts';
import type { DieKind } from './faces.ts';
import type { Vec3 } from './quat.ts';

/**
 * Runtime contract of `public/assets/dice/<id>/` (scripts/assets/build-dice.py). Each die is one
 * image-free GLB in the `src/dice/faces.ts` die-local frame (origin at the centre, +Y up), so a
 * spawned mesh takes the physics pose directly, exactly as `DicePresenter`'s greybox mesh does.
 * Face UVs point into the shared UI atlas page named by the manifest (`dice-d6`, `dice-d8`); the
 * caller binds that page with `bindFaceMaps`, and the asset never disposes it.
 */
export const DICE_ASSET_BASE = '/assets/dice';
export const DICE_ASSET_IDS = { d6: 'brass-d6', d8: 'glass-d8' } as const satisfies Record<
  DieKind,
  DieId
>;
const KINDS: readonly DieKind[] = ['d6', 'd8'];
/** Factor colour of each face slot until its atlas page is bound (art-bible walnut and sapphire). */
const FACE_FALLBACK: Readonly<Record<DieKind, string>> = { d6: '#583c26', d8: '#2d4a93' };

export interface DiceFace {
  index: number;
  value: number;
  normal: [number, number, number];
  atlas: { page: string; uv: UvRect };
}

export interface DiceMaterialSlot {
  role: 'body' | 'face';
  set?: string | null;
  tileMeters?: number;
  factorOnly?: boolean;
  atlasPage?: string;
  roughness?: number;
  metalness?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
}

export interface DiceManifest {
  id: DieId;
  version: number;
  kind: DieKind;
  glb: string;
  node: string;
  frame: { units: string; up: string; origin: string };
  collider: { shape: 'cuboid' | 'convexHull'; halfExtent?: number; circumradius?: number };
  bounds: { min: number[]; max: number[] };
  faces: DiceFace[];
  materialSlots: Record<string, DiceMaterialSlot>;
  budget: { tris: number; materials: number; texturesProduced: number };
}

function isVec(v: unknown): v is [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x));
}

export function parseDiceManifest(raw: unknown): DiceManifest {
  const m = raw as Partial<DiceManifest>;
  if (typeof m !== 'object' || m === null) throw new Error('dice manifest: expected an object');
  if (m.kind !== 'd6' && m.kind !== 'd8') throw new Error('dice manifest: kind must be d6 or d8');
  if (m.id !== DICE_ASSET_IDS[m.kind])
    throw new Error(`dice manifest: id ${m.id} is not a ${m.kind}`);
  if (typeof m.glb !== 'string' || typeof m.node !== 'string')
    throw new Error('dice manifest: glb or node missing');
  if (m.frame?.up !== '+Y') throw new Error('dice manifest: frame must be +Y up');
  const count = m.kind === 'd6' ? 6 : 8;
  if (!Array.isArray(m.faces) || m.faces.length !== count)
    throw new Error(`dice manifest: expected ${count} faces`);
  m.faces.forEach((face, i) => {
    if (face.index !== i || !Number.isInteger(face.value) || !isVec(face.normal) || !face.atlas?.uv)
      throw new Error(`dice manifest: face ${i} invalid`);
  });
  const slots = Object.values(m.materialSlots ?? {});
  if (slots.filter((s) => s.role === 'face').length !== 1 || slots.length > 2)
    throw new Error('dice manifest: needs one face slot and at most two slots');
  return m as DiceManifest;
}

interface GlbFace {
  index: number;
  value: number;
  normal: number[];
}

/** Throws unless the GLB node's face table (extras) is the manifest's, value for value. */
function checkFaceTable(manifest: DiceManifest, glbFaces: unknown): void {
  const faces = glbFaces as GlbFace[] | undefined;
  if (!Array.isArray(faces) || faces.length !== manifest.faces.length)
    throw new Error(`${manifest.id} glb: face table missing from node extras`);
  manifest.faces.forEach((face, i) => {
    const g = faces[i];
    if (
      !g ||
      g.index !== face.index ||
      g.value !== face.value ||
      !isVec(g.normal) ||
      g.normal.some((x, k) => Math.abs(x - (face.normal[k] as number)) > 1e-9)
    )
      throw new Error(`${manifest.id} glb: face ${i} differs from the manifest`);
  });
}

interface DieResources {
  manifest: DiceManifest;
  geometry: THREE.BufferGeometry;
  /** Per geometry group, in GLB primitive order. */
  materials: THREE.Material[];
  face: THREE.MeshStandardMaterial;
  normals: readonly Vec3[];
}

/**
 * The loaded dice: one merged geometry (a group per material) and one material array per kind,
 * shared by every spawned mesh. `dispose()` releases them; bound atlas pages and shared brass-set
 * textures stay owned by their loaders.
 */
export class DiceAsset {
  private disposed = false;

  constructor(private readonly dice: ReadonlyMap<DieKind, DieResources>) {}

  private die(kind: DieKind): DieResources {
    if (this.disposed) throw new Error('dice asset disposed');
    const die = this.dice.get(kind);
    if (!die) throw new RangeError(`dice asset has no ${kind}`);
    return die;
  }

  manifest(kind: DieKind): DiceManifest {
    return this.die(kind).manifest;
  }

  /** Outward face normals in die-local space by face index, read from the GLB's face table. */
  diceAssetFaces(kind: DieKind): readonly Vec3[] {
    return this.die(kind).normals;
  }

  /**
   * A die mesh in the `faces.ts` frame: drop-in for the presenter's greybox mesh. Geometry and
   * materials are shared, so never dispose them through the mesh.
   */
  spawn(kind: DieKind): THREE.Mesh {
    const die = this.die(kind);
    const mesh = new THREE.Mesh(die.geometry, die.materials);
    mesh.name = die.manifest.id;
    // A transparent shell would cast an opaque shadow, so a glass die casts none.
    mesh.castShadow = !die.materials.some((m) => m.transparent);
    return mesh;
  }

  /**
   * Lights the dice from `envMap` at `intensity` on every standard material. The metal body reads
   * black without a reflection source, and the combat scene has no `scene.environment`. The map
   * stays owned by the caller.
   */
  setEnvironment(envMap: THREE.Texture | null, intensity: number): void {
    if (this.disposed) return;
    for (const die of this.dice.values()) {
      for (const m of die.materials) {
        const lit = m as THREE.MeshStandardMaterial;
        if (!lit.isMeshStandardMaterial) continue;
        lit.envMap = envMap;
        lit.envMapIntensity = intensity;
        lit.needsUpdate = true;
      }
    }
  }

  /** Binds the UI atlas pages (`dice-d6`, `dice-d8`) to the face slots. Pass null to unbind. */
  bindFaceMaps(maps: Partial<Record<DieKind, THREE.Texture | null>>): void {
    for (const kind of KINDS) {
      if (!(kind in maps) || this.disposed) continue;
      const die = this.dice.get(kind);
      if (!die) continue;
      const slot = Object.values(die.manifest.materialSlots).find((s) => s.role === 'face');
      const map = maps[kind] ?? null;
      const face = die.face;
      face.map = map;
      face.emissiveMap = map;
      face.color.set(map ? '#ffffff' : FACE_FALLBACK[kind]);
      face.emissive.set(map ? '#ffffff' : '#000000');
      face.emissiveIntensity = map ? (slot?.emissiveIntensity ?? 0) : 0;
      face.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const die of this.dice.values()) {
      die.geometry.dispose();
      for (const m of die.materials) m.dispose();
    }
  }
}

function faceMaterial(kind: DieKind, name: string, slot: DiceMaterialSlot) {
  return new THREE.MeshStandardMaterial({
    name,
    color: FACE_FALLBACK[kind],
    roughness: slot.roughness ?? 0.5,
    metalness: slot.metalness ?? 0,
    transparent: slot.transparent ?? false,
    opacity: slot.opacity ?? 1,
    side: THREE.FrontSide,
  });
}

async function parseDie(
  glb: ArrayBuffer,
  manifest: DiceManifest,
  set: PbrSet | null,
): Promise<DieResources> {
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  const node = gltf.scene.getObjectByName(manifest.node);
  if (!node) throw new Error(`${manifest.id} glb: node ${manifest.node} missing`);
  checkFaceTable(manifest, (node.userData as { die?: { faces?: unknown } }).die?.faces);
  const meshes: THREE.Mesh[] = [];
  node.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  if (meshes.length === 0) throw new Error(`${manifest.id} glb: no mesh`);
  const geometries = meshes.map((m) => m.geometry as THREE.BufferGeometry);
  const geometry = mergeGeometries(geometries, true);
  for (const g of geometries) g.dispose();
  if (!geometry) throw new Error(`${manifest.id} glb: primitives cannot be merged`);
  // glTF stores v downward; the atlas rects (and its KTX2 pages) are bottom-left texture space.
  const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
  if (!uv) throw new Error(`${manifest.id} glb: TEXCOORD_0 missing`);
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const faces: THREE.MeshStandardMaterial[] = [];
  const materials = meshes.map((m) => {
    const source = m.material as THREE.MeshStandardMaterial;
    const slot = manifest.materialSlots[source.name];
    if (!slot) throw new Error(`${manifest.id} glb: material ${source.name} not in the manifest`);
    if (slot.role === 'face') {
      source.dispose();
      const face = faceMaterial(manifest.kind, source.name, slot);
      faces.push(face);
      return face;
    }
    const shared = slot.set ? set?.materials.get(slot.set) : undefined;
    if (!shared) {
      source.side = THREE.FrontSide;
      return source;
    }
    source.dispose();
    const clone = shared.clone();
    clone.name = source.name;
    return clone;
  });
  const face = faces[0];
  if (faces.length !== 1 || !face)
    throw new Error(`${manifest.id} glb: expected one face material`);
  const normals = manifest.faces.map(({ normal: [x, y, z] }) => ({ x, y, z }));
  return { manifest, geometry, materials, face, normals };
}

/** Builds the asset from GLB bytes and manifests (both dice). Rejects corrupt or mismatched bytes. */
export async function parseDice(
  glbs: Readonly<Record<DieKind, ArrayBuffer>>,
  manifests: Readonly<Record<DieKind, DiceManifest>>,
  set: PbrSet | null = null,
): Promise<DiceAsset> {
  const dice = new Map<DieKind, DieResources>();
  try {
    for (const kind of KINDS) {
      const manifest = manifests[kind];
      if (manifest.kind !== kind)
        throw new Error(`dice manifest for ${kind} is a ${manifest.kind}`);
      dice.set(kind, await parseDie(glbs[kind], manifest, set));
    }
  } catch (error) {
    new DiceAsset(dice).dispose();
    throw error;
  }
  return new DiceAsset(dice);
}

/**
 * Fetches both manifests and GLBs. `materials` may pass the loaded P4-T3 set so the brass slots
 * bind `brass-polished`; by default they keep the GLB's polished-brass factors.
 */
export async function loadDice(
  options: { base?: string; materials?: PbrSet | null; fetchFn?: typeof fetch } = {},
): Promise<DiceAsset> {
  const base = options.base ?? DICE_ASSET_BASE;
  const fetchFn = options.fetchFn ?? fetch;
  const get = async (url: string) => {
    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`dice asset ${url}: HTTP ${response.status}`);
    return response;
  };
  const entries = await Promise.all(
    KINDS.map(async (kind) => {
      const id = DICE_ASSET_IDS[kind];
      const manifest = parseDiceManifest(
        await (await get(`${base}/${id}/${id}.manifest.json`)).json(),
      );
      const glb = await (await get(`${base}/${id}/${manifest.glb}`)).arrayBuffer();
      return { kind, manifest, glb };
    }),
  );
  const pick = <T>(f: (e: (typeof entries)[number]) => T) =>
    Object.fromEntries(entries.map((e) => [e.kind, f(e)])) as Record<DieKind, T>;
  return parseDice(
    pick((e) => e.glb),
    pick((e) => e.manifest),
    options.materials ?? null,
  );
}
