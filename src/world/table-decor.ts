import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FloorPlan } from '../floor/generate.ts';
import {
  DECOR_KINDS,
  DECOR_RADIUS,
  type DecorKind,
  type DecorPlacement,
  placeTableDecor,
} from '../floor/table-decor.ts';
import { type CompressedTextureLoader, configurePbrTexture, type PbrRole } from './materials.ts';

/** Where the table decorations live (scripts/assets/build-table-decor.py). */
export const TABLE_DECOR_BASE = '/assets/props/table-decor';

export interface TableDecorManifest {
  glb: string;
  maps: Record<'basecolor' | 'normal' | 'orm' | 'emissive', string>;
  emissiveIntensity: number;
  envMapIntensity: number;
  kinds: Record<DecorKind, { node: string; tris: number; radius: number; height: number }>;
}

/** Parses `table-decor.manifest.json`; a prop wider than its placement footprint is refused. */
export function parseTableDecorManifest(raw: unknown): TableDecorManifest {
  const r = raw as Partial<TableDecorManifest>;
  const maps = r.maps;
  if (typeof r.glb !== 'string' || !maps || !r.kinds)
    throw new Error('table-decor manifest: glb, maps and kinds required');
  for (const role of ['basecolor', 'normal', 'orm', 'emissive'] as const) {
    if (typeof maps[role] !== 'string') throw new Error(`table-decor manifest: maps.${role}`);
  }
  for (const kind of DECOR_KINDS) {
    const k = r.kinds[kind];
    if (!k || typeof k.node !== 'string' || typeof k.radius !== 'number')
      throw new Error(`table-decor manifest: kinds.${kind}`);
    if (k.radius > DECOR_RADIUS[kind] + 1e-3)
      throw new Error(
        `table-decor manifest: ${kind} radius ${k.radius} exceeds its footprint ${DECOR_RADIUS[kind]}`,
      );
  }
  return {
    glb: r.glb,
    maps,
    emissiveIntensity: r.emissiveIntensity ?? 1,
    envMapIntensity: r.envMapIntensity ?? 0.3,
    kinds: r.kinds,
  };
}

/** Marks a merged decoration mesh, whose geometry belongs to its floor (`disposeTableDecor`). */
const DECOR_MESH = 'tableDecor';

/**
 * The loaded props: one base-centred geometry per kind sharing one atlas material. `build` merges a
 * room's props into a single mesh, so a dressed room costs one draw call.
 */
export class TableDecor {
  constructor(
    readonly geometries: Readonly<Record<DecorKind, THREE.BufferGeometry>>,
    readonly material: THREE.MeshStandardMaterial,
    readonly textures: readonly THREE.Texture[] = [],
  ) {}

  /** One merged mesh of `placements` (room-local), or null when there are none. */
  build(placements: readonly DecorPlacement[]): THREE.Mesh | null {
    if (placements.length === 0) return null;
    const m = new THREE.Matrix4();
    const parts = placements.map((p) =>
      this.geometries[p.kind]
        .clone()
        .applyMatrix4(m.makeRotationY(p.yaw).setPosition(p.x, p.y, p.z)),
    );
    const merged = mergeGeometries(parts);
    for (const g of parts) g.dispose();
    if (!merged) throw new Error('table-decor: props do not share attributes');
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, this.material);
    mesh.name = 'table-decor';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData[DECOR_MESH] = true;
    mesh.userData.placements = placements;
    return mesh;
  }

  /** One of each prop in a row, for the load veil's program warm-up. */
  sample(): THREE.Mesh {
    const row = DECOR_KINDS.map(
      (kind, i): DecorPlacement => ({
        room: -1,
        table: 'sample',
        kind,
        x: i * 0.3,
        y: 0,
        z: 0,
        yaw: 0,
      }),
    );
    return this.build(row) as THREE.Mesh;
  }
}

/** Keeps only the attributes every prop has, so the three merge into one buffer. */
function mergeable(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name);
  }
  return geometry;
}

/** Loads the decoration GLB and its KTX2 atlas. */
export async function loadTableDecor(
  ktx2: CompressedTextureLoader,
  base = TABLE_DECOR_BASE,
): Promise<TableDecor> {
  const response = await fetch(`${base}/table-decor.manifest.json`);
  if (!response.ok) throw new Error(`table-decor manifest: HTTP ${response.status}`);
  const manifest = parseTableDecorManifest(await response.json());
  // Baked on the GLB's own UV0, so the maps keep glTF orientation (flipY false), like the study books.
  const load = async (role: PbrRole) => {
    const texture = await ktx2.loadAsync(
      `${base}/${manifest.maps[role as keyof typeof manifest.maps]}`,
    );
    texture.flipY = false;
    configurePbrTexture(texture, role);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  };
  const [gltf, map, normalMap, orm, emissiveMap] = await Promise.all([
    new GLTFLoader().loadAsync(`${base}/${manifest.glb}`),
    load('basecolor'),
    load('normal'),
    load('orm'),
    load('emissive'),
  ]);
  gltf.scene.updateMatrixWorld(true);
  const geometries = {} as Record<DecorKind, THREE.BufferGeometry>;
  for (const kind of DECOR_KINDS) {
    const node = gltf.scene.getObjectByName(manifest.kinds[kind].node) as THREE.Mesh | undefined;
    if (!node?.isMesh) throw new Error(`table-decor: node ${manifest.kinds[kind].node} missing`);
    geometries[kind] = mergeable(node.geometry.clone().applyMatrix4(node.matrixWorld));
  }
  for (const node of gltf.scene.children) {
    (node as THREE.Mesh).geometry?.dispose();
  }
  const material = new THREE.MeshStandardMaterial({
    name: 'table-decor',
    map,
    normalMap,
    aoMap: orm,
    roughnessMap: orm,
    metalnessMap: orm,
    roughness: 1,
    metalness: 1,
    emissiveMap,
    emissive: new THREE.Color(1, 1, 1),
    emissiveIntensity: manifest.emissiveIntensity,
    envMapIntensity: manifest.envMapIntensity,
  });
  // No vertex tangents: three derives them from UV derivatives, so glTF's flipped V flips green.
  material.normalScale.set(1, -1);
  return new TableDecor(geometries, material, [map, normalMap, orm, emissiveMap]);
}

/**
 * Puts each dressed room's seeded props on its tables, as one mesh under the room group (which
 * already turns the template into place). Rooms whose template is not in `dressed` keep their
 * greybox and get none. Returns the number of meshes added.
 */
export function dressTableDecor(
  world: { plan: FloorPlan; roomGroups: readonly THREE.Group[] },
  decor: TableDecor,
  dressed: ReadonlySet<string>,
): number {
  const ids = world.plan.rooms.map((r) => r.templateId);
  const placements = placeTableDecor(world.plan.seed, ids);
  let added = 0;
  ids.forEach((id, room) => {
    const group = world.roomGroups[room];
    if (!group || !dressed.has(id)) return;
    const mesh = decor.build(placements.filter((p) => p.room === room));
    if (!mesh) return;
    group.add(mesh);
    added++;
  });
  return added;
}

/** Frees the merged decoration geometry under `root` (the shared material stays loaded). */
export function disposeTableDecor(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (node.userData[DECOR_MESH]) (node as THREE.Mesh).geometry.dispose();
  });
}
