import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { parseRoomTemplate } from '../content/rooms.ts';
import { createKtx2Loader } from './ktx2.ts';
import { createBitmapTextureLoader, loadRoomLightmap, parseTemplateManifest } from './lightmap.ts';
import { configurePbrTexture, loadPbrSet } from './materials.ts';

const BASE = '/assets/rooms/study';
/** Dev-only: the PNG twins of the shipped KTX2 maps, kept beside the generator's staging output. */
const STAGING = '/assets-source/rooms/study/staging';

/** Blender cameras from scripts/assets/build-room-study.py, as runtime (x, y, z) = Blender (x, z, -y). */
const CAMERAS = {
  hero: { eye: [1.6, 1.6, 3.2], look: [-0.4, 2.2, -4.0] },
  desk: { eye: [-2.8, 1.6, -0.6], look: [2.4, 0.9, 2.4] },
} as const;

type SlotEntry =
  | { pbr: string; tileMeters: number }
  | { maps: { basecolor: string; normal: string; orm: string }; uv: 0 }
  | { color: string; roughness?: number; emissive?: string; emissiveIntensity?: number };

interface StudyManifest {
  materials: Record<string, SlotEntry>;
  glassEmissiveIntensity: number;
}

/**
 * `?view=room-asset-proof`: the baked hero study (P4-T4) with the approved P4-T3 materials bound
 * by slot name and its lightmap on UV1. `&cam=hero|desk` matches the Blender review cameras,
 * `&tex=ktx2|png` picks the shipped KTX2 maps or their staged PNG twins, `&tone=none` turns tone
 * mapping off and `&diffuse=1` zeroes metalness, which together match the Cycles diffuse reference.
 */
export async function mountRoomAssetProof(
  scene: THREE.Scene,
  rig: THREE.Group,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
): Promise<THREE.Object3D> {
  const params = new URLSearchParams(location.search);
  const usePng = params.get('tex') === 'png';
  const diffuseOnly = params.get('diffuse') === '1';
  if (params.get('tone') === 'none') renderer.toneMapping = THREE.NoToneMapping;
  scene.background = new THREE.Color().setRGB(0.004, 0.003, 0.002, THREE.LinearSRGBColorSpace);

  const raw: unknown = await (await fetch(`${BASE}/study.manifest.json`)).json();
  const manifest = parseTemplateManifest(raw);
  parseRoomTemplate(raw);
  const study = raw as StudyManifest;

  const ktx2 = createKtx2Loader(renderer);
  const [gltf, pbr] = await Promise.all([
    new GLTFLoader().loadAsync(`${BASE}/${manifest.glb}`),
    loadPbrSet('/assets/materials', {
      anisotropy: renderer.capabilities.getMaxAnisotropy(),
      ...(usePng ? {} : { ktx2 }),
    }),
  ]);

  const slots = new Map<string, THREE.MeshStandardMaterial>();
  for (const [name, entry] of Object.entries(study.materials)) {
    slots.set(name, await slotMaterial(name, entry, pbr.materials, usePng, ktx2, study));
  }
  gltf.scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const name = (mesh.material as THREE.Material).name;
    const material = slots.get(name);
    if (!material) throw new Error(`room-asset-proof: GLB slot ${name} is not in the manifest`);
    if (diffuseOnly) {
      const flat = material.clone();
      flat.metalness = 0;
      flat.metalnessMap = null;
      mesh.material = flat;
    } else {
      mesh.material = material;
    }
  });

  if (usePng) {
    const pngManifest = {
      ...manifest,
      lightmap: { ...manifest.lightmap, file: `${manifest.template}.lightmap.png` },
    };
    await loadRoomLightmap(pngManifest, STAGING, createBitmapTextureLoader(), gltf.scene);
  } else {
    await loadRoomLightmap(manifest, BASE, ktx2, gltf.scene);
  }
  ktx2.dispose();
  gltf.scene.name = manifest.template;
  scene.add(gltf.scene);

  if (!diffuseOnly) {
    // Brass reads through reflections only; a dim neutral room stands in for the baked probe.
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.12;
    pmrem.dispose();
  }

  const view = CAMERAS[(params.get('cam') ?? 'hero') as keyof typeof CAMERAS] ?? CAMERAS.hero;
  rig.position.set(view.eye[0], 0, view.eye[2]);
  camera.position.set(0, view.eye[1], 0);
  camera.fov = 70;
  camera.updateProjectionMatrix();
  rig.updateMatrixWorld(true);
  camera.lookAt(view.look[0], view.look[1], view.look[2]);
  (window as unknown as { __roomAssetProofReady: boolean }).__roomAssetProofReady = true;
  return gltf.scene;
}

/**
 * Renders the proof into its own canvas outside the app shell, for headless review shots that
 * must not depend on a `main.ts` hook. Resolves after two rendered frames.
 */
export async function mountStandaloneRoomAssetProof(
  width: number,
  height: number,
): Promise<{ calls: number; triangles: number }> {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene();
  const rig = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(70, width / height, 0.05, 100);
  rig.add(camera);
  scene.add(rig);
  await mountRoomAssetProof(scene, rig, camera, renderer);
  renderer.render(scene, camera);
  await new Promise((resolve) => requestAnimationFrame(resolve));
  renderer.render(scene, camera);
  return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
}

async function slotMaterial(
  name: string,
  entry: SlotEntry,
  pbr: Map<string, THREE.MeshStandardMaterial>,
  usePng: boolean,
  ktx2: { loadAsync(url: string): Promise<THREE.Texture> },
  study: StudyManifest,
): Promise<THREE.MeshStandardMaterial> {
  if ('pbr' in entry) {
    const material = pbr.get(entry.pbr);
    if (!material) throw new Error(`room-asset-proof: ${name} wants unknown material ${entry.pbr}`);
    if (material.emissiveMap) material.emissiveIntensity = study.glassEmissiveIntensity;
    return material;
  }
  if ('maps' in entry) {
    // Baked on the GLB's own UV0, so these keep glTF orientation: flipY false.
    const load = async (file: string, role: 'basecolor' | 'normal' | 'orm') => {
      const texture = usePng
        ? await new THREE.TextureLoader().loadAsync(`${STAGING}/${file.replace(/\.ktx2$/, '.png')}`)
        : await ktx2.loadAsync(`${BASE}/${file}`);
      texture.flipY = false;
      configurePbrTexture(texture, role);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
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
