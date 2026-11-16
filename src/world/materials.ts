import * as THREE from 'three';

/** Map roles written by scripts/assets/build_materials.py. ORM packs AO in R, roughness in G, metallic in B. */
export const PBR_ROLES = ['basecolor', 'normal', 'orm', 'emissive'] as const;
export type PbrRole = (typeof PBR_ROLES)[number];

export interface PbrMaterialEntry {
  /** World-space edge length one texture tile covers. */
  tileMeters: number;
  maps: Partial<Record<PbrRole, string>> & { basecolor: string; normal: string; orm: string };
}

export type PbrManifest = Record<string, PbrMaterialEntry>;

export function parsePbrManifest(raw: unknown): PbrManifest {
  if (typeof raw !== 'object' || raw === null)
    throw new Error('materials.json: expected an object');
  const out: PbrManifest = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Partial<PbrMaterialEntry>;
    if (typeof entry.tileMeters !== 'number' || !(entry.tileMeters > 0)) {
      throw new Error(`materials.json: ${name}.tileMeters must be a positive number`);
    }
    const maps = entry.maps as Record<string, unknown> | undefined;
    for (const role of ['basecolor', 'normal', 'orm'] as const) {
      if (typeof maps?.[role] !== 'string')
        throw new Error(`materials.json: ${name}.maps.${role} missing`);
    }
    for (const role of Object.keys(maps ?? {})) {
      if (!PBR_ROLES.includes(role as PbrRole))
        throw new Error(`materials.json: ${name}.maps.${role} unknown role`);
    }
    out[name] = entry as PbrMaterialEntry;
  }
  return out;
}

/** Colour roles are sRGB; normal and ORM are data. Every role tiles. */
export function configurePbrTexture(
  texture: THREE.Texture,
  role: PbrRole,
  anisotropy = 4,
): THREE.Texture {
  texture.colorSpace =
    role === 'basecolor' || role === 'emissive' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  return texture;
}

export function createPbrMaterial(
  textures: Partial<Record<PbrRole, THREE.Texture>> &
    Record<'basecolor' | 'normal' | 'orm', THREE.Texture>,
): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    map: textures.basecolor,
    normalMap: textures.normal,
    aoMap: textures.orm,
    roughnessMap: textures.orm,
    metalnessMap: textures.orm,
    // The maps carry the values; these scalars multiply them.
    roughness: 1,
    metalness: 1,
  });
  if (textures.emissive) {
    material.emissiveMap = textures.emissive;
    material.emissive = new THREE.Color(1, 1, 1);
    material.emissiveIntensity = 0;
  }
  return material;
}

/** UV repeat for a surface `widthMeters` x `heightMeters` whose UVs span 0..1. */
export function tileRepeat(
  entry: PbrMaterialEntry,
  widthMeters: number,
  heightMeters: number,
): THREE.Vector2 {
  return new THREE.Vector2(widthMeters / entry.tileMeters, heightMeters / entry.tileMeters);
}

export interface PbrSet {
  manifest: PbrManifest;
  /** One material per name. Textures are shared, so set `repeat` per surface on a clone. */
  materials: Map<string, THREE.MeshStandardMaterial>;
}

export async function loadPbrSet(base: string, anisotropy = 4): Promise<PbrSet> {
  const manifest = parsePbrManifest(await (await fetch(`${base}/materials.json`)).json());
  const loader = new THREE.TextureLoader();
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  await Promise.all(
    Object.entries(manifest).map(async ([name, entry]) => {
      const loaded = await Promise.all(
        Object.entries(entry.maps).map(async ([role, file]) => {
          const texture = await loader.loadAsync(`${base}/${name}/${file}`);
          return [role, configurePbrTexture(texture, role as PbrRole, anisotropy)] as const;
        }),
      );
      const textures = Object.fromEntries(loaded) as Parameters<typeof createPbrMaterial>[0];
      const material = createPbrMaterial(textures);
      material.name = name;
      materials.set(name, material);
    }),
  );
  return { manifest, materials };
}
