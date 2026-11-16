import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

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

/** Extensions a template's lightmap may ship as, in preference order. */
const LIGHTMAP_EXTENSIONS = ['ktx2', 'png'] as const;

/** The only filenames that can be `template`'s lightmap, in preference order. */
export function lightmapFileNames(template: string): string[] {
  return LIGHTMAP_EXTENSIONS.map((ext) => `${template}.lightmap.${ext}`);
}

/**
 * Picks `template`'s lightmap from a directory listing by exact filename. Near misses such as
 * `xstudy.lightmap.ktx2` or `study-lightmap-old.ktx2` are never candidates, whatever they contain.
 */
export function selectLightmapFile(template: string, files: readonly string[]): string | undefined {
  return lightmapFileNames(template).find((name) => files.includes(name));
}

export function parseTemplateManifest(value: unknown): TemplateManifest {
  const m = value as Partial<TemplateManifest> | null;
  const lm = m?.lightmap as Partial<LightmapSpec> | undefined;
  if (!m || typeof m.template !== 'string' || !m.template)
    throw new Error('manifest: missing template');
  if (m.glb !== `${m.template}.glb`) throw new Error(`manifest: glb must be ${m.template}.glb`);
  if (!lm) throw new Error('manifest: missing lightmap');
  // Bound by exact filename, never inferred from a substring of some other map's name.
  const allowed = lightmapFileNames(m.template);
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
  texture.magFilter = THREE.LinearFilter;
  const compressed = texture as THREE.CompressedTexture;
  if (compressed.isCompressedTexture) {
    // A KTX2 file carries its own mip chain, and a compressed texture cannot generate one.
    texture.generateMipmaps = false;
    texture.minFilter =
      compressed.mipmaps.length > 1 ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  } else {
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
  }
  texture.needsUpdate = true;
  return texture;
}

/** Any loader with `loadAsync`, such as KTX2Loader or an ImageBitmap-backed texture loader. */
export interface LightmapLoader {
  loadAsync(url: string): Promise<THREE.Texture>;
}

/** Loaders by file kind. A `.ktx2` lightmap goes to `ktx2`, a `.png` one to `image`. */
export interface LightmapLoaders {
  ktx2?: LightmapLoader | KTX2Loader;
  image?: LightmapLoader;
}

/**
 * Decodes images off the main thread through `createImageBitmap` (PRD uploads budget). The bitmap
 * keeps its pixels as stored: no flip (the contract sets flipY false), no premultiply, no colour
 * space conversion, because the PNG is already sRGB-encoded data.
 */
export function createBitmapTextureLoader(): LightmapLoader {
  const loader = new THREE.ImageBitmapLoader().setOptions({
    imageOrientation: 'from-image',
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  return {
    async loadAsync(url) {
      const texture = new THREE.Texture(await loader.loadAsync(url));
      texture.needsUpdate = true;
      return texture;
    },
  };
}

export interface RoomLightmap {
  texture: THREE.Texture;
  url: string;
  /** Materials the lightmap was bound to, 0 when no `root` was given. */
  bound: number;
}

/**
 * Loads exactly the manifest's lightmap file from `baseUrl` and configures it for UV channel 1 at
 * the manifest intensity. The manifest is re-validated first, so a file that is not
 * `<template>.lightmap.ktx2|png` is rejected rather than guessed from a substring. With `root`,
 * also binds the texture to every mesh material under it.
 */
export async function loadRoomLightmap(
  manifest: TemplateManifest,
  baseUrl: string,
  loader: LightmapLoader | KTX2Loader,
  root?: THREE.Object3D,
): Promise<RoomLightmap> {
  const { lightmap } = parseTemplateManifest(manifest);
  const url = `${baseUrl.replace(/\/+$/, '')}/${lightmap.file}`;
  const texture = configureLightmapTexture(await loader.loadAsync(url), lightmap);
  return { texture, url, bound: root ? bindLightmap(root, texture, lightmap) : 0 };
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

/**
 * Loads a room template GLB with its lightmap from `<base>/<template>.manifest.json`. PNG
 * lightmaps decode through ImageBitmap unless `loaders.image` overrides it. A KTX2 lightmap needs
 * `loaders.ktx2`.
 */
export async function loadLightmappedTemplate(
  base: string,
  template: string,
  loaders: LightmapLoaders = {},
): Promise<THREE.Group> {
  const response = await fetch(`${base}/${template}.manifest.json`);
  if (!response.ok) throw new Error(`manifest ${template}: HTTP ${response.status}`);
  const manifest = parseTemplateManifest(await response.json());
  const isKtx2 = manifest.lightmap.file.endsWith('.ktx2');
  const loader = isKtx2 ? loaders.ktx2 : (loaders.image ?? createBitmapTextureLoader());
  if (!loader) throw new Error(`template ${template}: lightmap is KTX2 but no ktx2 loader given`);
  const gltf = await new GLTFLoader().loadAsync(`${base}/${manifest.glb}`);
  await loadRoomLightmap(manifest, base, loader, gltf.scene);
  gltf.scene.name = template;
  return gltf.scene;
}
