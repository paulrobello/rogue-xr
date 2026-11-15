import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** Lightmap contract (PRD "Lightmap contract"): scaled irradiance on UV1, sRGB-encoded 8-bit. */
export interface LightmapSpec {
  file: string;
  uv: 1;
  encoding: 'srgb-scaled';
  scale: number;
  /** PI x scale: three's indirect diffuse divides by PI, the Cycles colourless diffuse pass does not. */
  intensity: number;
}

export interface TemplateManifest {
  template: string;
  glb: string;
  lightmap: LightmapSpec;
}

export function parseTemplateManifest(value: unknown): TemplateManifest {
  const m = value as Partial<TemplateManifest> | null;
  const lm = m?.lightmap as Partial<LightmapSpec> | undefined;
  if (!m || typeof m.template !== 'string' || !m.template)
    throw new Error('manifest: missing template');
  if (m.glb !== `${m.template}.glb`) throw new Error(`manifest: glb must be ${m.template}.glb`);
  if (!lm) throw new Error('manifest: missing lightmap');
  // Bound by exact filename, never inferred from a substring of some other map's name.
  const allowed = [`${m.template}.lightmap.png`, `${m.template}.lightmap.ktx2`];
  if (typeof lm.file !== 'string' || !allowed.includes(lm.file)) {
    throw new Error(`manifest: lightmap file must be one of ${allowed.join(', ')}`);
  }
  if (lm.uv !== 1) throw new Error('manifest: lightmap must use UV channel 1');
  if (lm.encoding !== 'srgb-scaled') throw new Error(`manifest: unknown encoding ${lm.encoding}`);
  for (const key of ['scale', 'intensity'] as const) {
    const v = lm[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`manifest: lightmap ${key} must be a positive number`);
    }
  }
  return m as TemplateManifest;
}

/** Prepares a decoded lightmap image texture for the contract's UV channel and encoding. */
export function configureLightmapTexture(
  texture: THREE.Texture,
  spec: LightmapSpec,
): THREE.Texture {
  texture.channel = spec.uv;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Binds one lightmap to every mesh under `root`. Throws when a mesh lacks UV1, because a lightmap
 * read through UV0 lands on the wrong texels without any visible error.
 */
export function bindLightmap(
  root: THREE.Object3D,
  texture: THREE.Texture,
  spec: LightmapSpec,
): number {
  let bound = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (!mesh.geometry.getAttribute('uv1')) {
      throw new Error(`Lightmapped mesh "${mesh.name}" has no uv1 attribute`);
    }
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const lit = material as THREE.MeshStandardMaterial;
      if (!('lightMap' in lit))
        throw new Error(`Material "${material.name}" cannot take a lightmap`);
      lit.lightMap = texture;
      lit.lightMapIntensity = spec.intensity;
      lit.needsUpdate = true;
      bound++;
    }
  });
  return bound;
}

/** Loads a room template GLB with its lightmap from `<base>/<template>.manifest.json`. */
export async function loadLightmappedTemplate(
  base: string,
  template: string,
): Promise<THREE.Group> {
  const response = await fetch(`${base}/${template}.manifest.json`);
  if (!response.ok) throw new Error(`manifest ${template}: HTTP ${response.status}`);
  const manifest = parseTemplateManifest(await response.json());
  const [gltf, texture] = await Promise.all([
    new GLTFLoader().loadAsync(`${base}/${manifest.glb}`),
    new THREE.TextureLoader().loadAsync(`${base}/${manifest.lightmap.file}`),
  ]);
  configureLightmapTexture(texture, manifest.lightmap);
  bindLightmap(gltf.scene, texture, manifest.lightmap);
  gltf.scene.name = template;
  return gltf.scene;
}
