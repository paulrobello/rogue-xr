import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE } from '../palette.ts';
import { loadPbrSet } from '../world/materials.ts';

/** Runtime contract of `public/assets/props/combat-table/` (scripts/assets/build-combat-table.py). */
export const TABLE_ASSET_BASE = '/assets/props/combat-table';
export const TABLE_ASSET_NODES = [
  'combat-table',
  'table-body',
  'leaf-left',
  'leaf-right',
  'socket-dice-tray',
  'socket-draw',
  'socket-discard',
  'socket-sigil-plate',
] as const;
export type TableLeaf = 'leaf-left' | 'leaf-right';
type Quat = [number, number, number, number];

export interface TableAssetManifest {
  glb: string;
  authoredTopHeight: number;
  nodes: Record<
    string,
    { parent: string | null; translation: number[]; rotation: Quat; scale: number[] }
  >;
  leaves: Record<TableLeaf, { hinge: number[]; foldedRotation: Quat; unfoldedRotation: Quat }>;
  materialSlots: Record<
    string,
    { set: string | null; factorOnly?: boolean; tileMeters?: number; normalScale?: number }
  >;
  ao: { png: string; ktx2: string | null; uv: number; channel: number; flipY: boolean };
}

export function parseTableAssetManifest(raw: unknown): TableAssetManifest {
  const m = raw as Partial<TableAssetManifest>;
  if (typeof m !== 'object' || m === null) throw new Error('table manifest: expected an object');
  for (const name of TABLE_ASSET_NODES) {
    if (!m.nodes?.[name]) throw new Error(`table manifest: node ${name} missing`);
  }
  for (const leaf of ['leaf-left', 'leaf-right'] as const) {
    if (m.leaves?.[leaf]?.foldedRotation?.length !== 4) {
      throw new Error(`table manifest: ${leaf}.foldedRotation missing`);
    }
  }
  if (!m.materialSlots || !m.ao?.png)
    throw new Error('table manifest: materialSlots or ao missing');
  return m as TableAssetManifest;
}

/** Leaf rotation for an unfold progress in [0, 1]: 0 is the folded rest pose, 1 is flat open. */
export function leafQuaternion(
  manifest: TableAssetManifest,
  leaf: TableLeaf,
  progress: number,
  out = new THREE.Quaternion(),
): THREE.Quaternion {
  const t = Math.min(1, Math.max(0, progress));
  const entry = manifest.leaves[leaf];
  const folded = new THREE.Quaternion(...entry.foldedRotation);
  const open = new THREE.Quaternion(...entry.unfoldedRotation);
  return out.slerpQuaternions(folded, open, t);
}

/**
 * Binds the shared P4-T3 sets onto the GLB by exact material name, on clones (the set's textures
 * are shared with the room), and the table's own AO on UV1. Slots with no set keep the GLB's
 * factor-only material, which is also the fallback when a set fails to load.
 */
export async function bindTableMaterials(
  root: THREE.Object3D,
  manifest: TableAssetManifest,
  renderer: THREE.WebGLRenderer,
): Promise<void> {
  const set = await loadPbrSet('/assets/materials', {
    anisotropy: renderer.capabilities.getMaxAnisotropy(),
  });
  const ao = await new THREE.TextureLoader().loadAsync(`${TABLE_ASSET_BASE}/${manifest.ao.png}`);
  ao.flipY = manifest.ao.flipY;
  ao.channel = manifest.ao.channel;
  ao.colorSpace = THREE.NoColorSpace;
  const bound = new Map<string, THREE.MeshStandardMaterial>();
  const bind = (source: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial => {
    const cached = bound.get(source.name);
    if (cached) return cached;
    const slot = manifest.materialSlots[source.name];
    const shared = slot?.set ? set.materials.get(slot.set) : undefined;
    let material: THREE.MeshStandardMaterial;
    if (shared) {
      material = shared.clone();
      material.map = shared.map?.clone() ?? null;
      material.normalMap = shared.normalMap?.clone() ?? null;
      const orm = shared.roughnessMap?.clone() ?? null;
      material.roughnessMap = orm;
      material.metalnessMap = orm;
      const s = slot?.normalScale ?? 1;
      material.normalScale.set(s, s);
    } else {
      material = source.clone();
    }
    material.name = source.name;
    material.aoMap = ao;
    bound.set(source.name, material);
    return material;
  };
  root.traverse((o) => {
    if (o instanceof THREE.Mesh && o.material instanceof THREE.MeshStandardMaterial) {
      o.material = bind(o.material);
    }
  });
}

/**
 * Proof view for the P4-T5 table asset: loads the GLB, binds the materials and sweeps the unfold.
 * Hook in src/main.ts: `} else if (view === 'table-asset-proof') { await mountTableAssetProof(scene, rig, renderer); }`
 * Query: `&unfold=<0..1>` freezes the unfold (otherwise it loops), `&light=grazing|warm`,
 * `&cam=player|three-quarter|side`.
 */
export async function mountTableAssetProof(
  scene: THREE.Scene,
  rig: THREE.Group,
  renderer: THREE.WebGLRenderer,
): Promise<{ root: THREE.Object3D; manifest: TableAssetManifest; setUnfold(t: number): void }> {
  const params = new URLSearchParams(location.search);
  scene.background = new THREE.Color(PALETTE.void);
  const manifest = parseTableAssetManifest(
    await (await fetch(`${TABLE_ASSET_BASE}/combat-table.manifest.json`)).json(),
  );
  const gltf = await new GLTFLoader().loadAsync(`${TABLE_ASSET_BASE}/${manifest.glb}`);
  const root = gltf.scene.getObjectByName('combat-table') ?? gltf.scene;
  await bindTableMaterials(gltf.scene, manifest, renderer);
  scene.add(gltf.scene);

  const leaves = (['leaf-left', 'leaf-right'] as const).map(
    (name) => [name, gltf.scene.getObjectByName(name)] as const,
  );
  const setUnfold = (t: number): void => {
    for (const [name, node] of leaves) if (node) leafQuaternion(manifest, name, t, node.quaternion);
  };
  const fixed = params.get('unfold');
  setUnfold(fixed === null ? 1 : Number(fixed));
  if (fixed === null) {
    const clock = new THREE.Clock();
    // onBeforeRender fires only on renderables, so the loop hangs off the body mesh.
    const body = gltf.scene.getObjectByName('table-body');
    const mesh =
      body instanceof THREE.Mesh ? body : body?.children.find((c) => c instanceof THREE.Mesh);
    if (mesh)
      mesh.onBeforeRender = () => {
        const phase = (clock.getElapsedTime() % 4) / 2;
        setUnfold(phase <= 1 ? phase : 2 - phase);
      };
  }

  const light = params.get('light') ?? 'warm';
  if (light === 'grazing') {
    const sun = new THREE.DirectionalLight('#ffffff', 3);
    sun.position.set(-2, 0.95, 0.4);
    scene.add(sun, new THREE.AmbientLight('#ffffff', 0.05));
  } else {
    const candle = new THREE.PointLight(PALETTE.candle, 4, 0, 1.6);
    candle.position.set(-0.8, 1.5, 0.9);
    const key = new THREE.DirectionalLight('#ffe2b8', 1.6);
    key.position.set(1.2, 2.2, 1.6);
    scene.add(candle, key, new THREE.HemisphereLight('#ffe8c8', '#2a2018', 0.35));
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = light === 'grazing' ? 0.1 : 0.45;
  pmrem.dispose();

  // Rig-local eye height is 1.6 m (desktop); these place the eye as a seated player would see it.
  const cam = params.get('cam') ?? 'player';
  if (cam === 'three-quarter') rig.position.set(1.3, -0.15, 1.6);
  else if (cam === 'side') rig.position.set(2.4, -0.6, 0);
  else rig.position.set(0, -0.4, 0.65);
  (window as unknown as { __tableAssetProofReady: boolean }).__tableAssetProofReady = true;
  return { root, manifest, setUnfold };
}
