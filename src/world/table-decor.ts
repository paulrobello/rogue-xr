import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FloorPlan } from '../floor/generate.ts';
import {
  DECOR_KINDS,
  DECOR_RADIUS,
  DECOR_TABLES,
  DECOR_VARIANTS,
  type DecorKind,
  type DecorPlacement,
  type DecorTable,
  placeTableDecor,
} from '../floor/table-decor.ts';
import { type CompressedTextureLoader, configurePbrTexture, type PbrRole } from './materials.ts';

/** Where the table decorations live (scripts/assets/build-table-decor.py). */
export const TABLE_DECOR_BASE = '/assets/props/table-decor';

/** The rectangle of a prop where it meets the table, prop-local runtime metres (x, z). */
export interface DecorContact {
  x: number;
  z: number;
  halfX: number;
  halfZ: number;
  /** Corner radius: half the short side for a round base. */
  corner: number;
}

export interface DecorVariantEntry {
  node: string;
  tris: number;
  radius: number;
  height: number;
  contact: DecorContact;
}

export interface TableDecorManifest {
  glb: string;
  maps: Record<'basecolor' | 'normal' | 'orm' | 'emissive', string>;
  emissiveIntensity: number;
  envMapIntensity: number;
  /** Probe reflection on metallic texels (brass, gilt); `envMapIntensity` holds everywhere else. */
  metalEnvMapIntensity: number;
  kinds: Record<DecorKind, { variants: DecorVariantEntry[] }>;
}

function isContact(c: unknown): c is DecorContact {
  const k = c as Partial<DecorContact> | undefined;
  return ['x', 'z', 'halfX', 'halfZ', 'corner'].every((f) =>
    Number.isFinite(k?.[f as keyof DecorContact]),
  );
}

/**
 * Parses `table-decor.manifest.json`. A kind must ship exactly its `DECOR_VARIANTS` meshes, and a
 * mesh wider than its placement footprint is refused.
 */
export function parseTableDecorManifest(raw: unknown): TableDecorManifest {
  const r = raw as Partial<TableDecorManifest>;
  const maps = r.maps;
  if (typeof r.glb !== 'string' || !maps || !r.kinds)
    throw new Error('table-decor manifest: glb, maps and kinds required');
  for (const role of ['basecolor', 'normal', 'orm', 'emissive'] as const) {
    if (typeof maps[role] !== 'string') throw new Error(`table-decor manifest: maps.${role}`);
  }
  for (const kind of DECOR_KINDS) {
    const variants = r.kinds[kind]?.variants;
    if (!Array.isArray(variants) || variants.length !== DECOR_VARIANTS[kind])
      throw new Error(`table-decor manifest: kinds.${kind} needs ${DECOR_VARIANTS[kind]} variants`);
    for (const v of variants) {
      if (typeof v.node !== 'string' || typeof v.radius !== 'number' || !isContact(v.contact))
        throw new Error(`table-decor manifest: kinds.${kind} variant ${v.node}`);
      if (v.radius > DECOR_RADIUS[kind] + 1e-3)
        throw new Error(
          `table-decor manifest: ${kind} radius ${v.radius} exceeds its footprint ${DECOR_RADIUS[kind]}`,
        );
    }
  }
  const env = r.envMapIntensity ?? 0.3;
  return {
    glb: r.glb,
    maps,
    emissiveIntensity: r.emissiveIntensity ?? 1,
    envMapIntensity: env,
    metalEnvMapIntensity: r.metalEnvMapIntensity ?? env,
    kinds: r.kinds,
  };
}

/** Marks a merged decoration mesh, whose geometry belongs to its floor (`disposeTableDecor`). */
const DECOR_MESH = 'tableDecor';
/** Marks the decal child of a decoration mesh (freed with its parent's geometry). */
const DECAL_MESH = 'tableDecorDecals';

/** Candle amber #F3BE65 (docs/art-bible.md), linear. */
const AMBER = new THREE.Color('#F3BE65');
/** The candle's light pool on its table: radius (m) and linear amber at the centre. */
const POOL_RADIUS = 0.36;
const POOL_STRENGTH = 0.05;
/** Halo behind the flame: half width and height (m), height of its centre, strength, push back. */
const HALO = { halfW: 0.032, halfH: 0.046, y: 0.183, strength: 0.2, back: 0.012 };
/** Contact shadow: darkening at the base and the soft run past the footprint (m). */
const SHADOW_ALPHA = 0.7;
const SHADOW_SOFT = 0.03;
/** Lift off the table top against z-fighting (with polygon offset), metres. */
const DECAL_LIFT = 0.0015;

const DECAL_VERTEX = /* glsl */ `
attribute vec2 decalLocal;
attribute vec4 decalShape;
attribute vec4 decalTint;
attribute vec3 decalCorner;
varying vec2 vLocal;
varying vec4 vShape;
varying vec4 vTint;
void main() {
  vLocal = decalLocal;
  vShape = decalShape;
  vTint = decalTint;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  mv.xyz += vec3( decalCorner.xy, -decalCorner.z );
  gl_Position = projectionMatrix * mv;
}
`;

// Premultiplied output: rgb adds light (pool, halo), alpha darkens what is behind (contact).
// A negative softness marks a light pool of that radius: a flame's falloff over the table.
const DECAL_FRAGMENT = /* glsl */ `
varying vec2 vLocal;
varying vec4 vShape;
varying vec4 vTint;
void main() {
  float f;
  if ( vShape.w < 0.0 ) {
    float r = length( vLocal ) / -vShape.w;
    f = pow( 1.0 + 3.5 * r * r, -1.5 ) * ( 1.0 - smoothstep( 0.55, 1.0, r ) );
  } else {
    vec2 q = abs( vLocal ) - vShape.xy + vShape.z;
    float d = length( max( q, 0.0 ) ) + min( max( q.x, q.y ), 0.0 ) - vShape.z;
    f = 1.0 - smoothstep( 0.0, 1.0, clamp( d / vShape.w, 0.0, 1.0 ) );
    f *= f;
  }
  gl_FragColor = vTint * f;
  #include <colorspace_fragment>
}
`;

/** The shared decal material: one extra draw call per dressed room. */
export function createDecalMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'table-decor-decals',
    vertexShader: DECAL_VERTEX,
    fragmentShader: DECAL_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    toneMapped: false,
  });
}

/** The table a placement stands on, by id (ids are unique across templates). */
function tableOf(id: string): DecorTable | undefined {
  for (const list of Object.values(DECOR_TABLES)) {
    const t = list.find((c) => c.id === id);
    if (t) return t;
  }
  return undefined;
}

type Pt = [number, number];

/** `poly` clipped to the axis-aligned rectangle (Sutherland-Hodgman). */
function clipToRect(poly: Pt[], x0: number, x1: number, z0: number, z1: number): Pt[] {
  const edges: ((p: Pt) => number)[] = [
    (p) => p[0] - x0,
    (p) => x1 - p[0],
    (p) => p[1] - z0,
    (p) => z1 - p[1],
  ];
  let out = poly;
  for (const inside of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const a = src[i] as Pt;
      const b = src[(i + 1) % src.length] as Pt;
      const da = inside(a);
      const db = inside(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    if (out.length < 3) return [];
  }
  return out;
}

class DecalBuilder {
  readonly position: number[] = [];
  readonly local: number[] = [];
  readonly shape: number[] = [];
  readonly tint: number[] = [];
  readonly corner: number[] = [];
  readonly index: number[] = [];

  private vertex(
    p: readonly number[],
    local: readonly number[],
    shape: readonly number[],
    tint: readonly number[],
    corner: readonly number[],
  ): number {
    this.position.push(...p);
    this.local.push(...local);
    this.shape.push(...shape);
    this.tint.push(...tint);
    this.corner.push(...corner);
    return this.position.length / 3 - 1;
  }

  /**
   * A flat decal on the table top `y`: the rectangle ±(hx, hz) about (cx, cz) turned by `yaw`,
   * clipped to `table` so it never hangs past the edge. `local` stays the unclipped frame.
   */
  ground(
    cx: number,
    cz: number,
    yaw: number,
    hx: number,
    hz: number,
    y: number,
    table: DecorTable | undefined,
    shape: readonly number[],
    tint: readonly number[],
  ): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const square: Pt[] = [
      [-hx, -hz],
      [hx, -hz],
      [hx, hz],
      [-hx, hz],
    ];
    let poly = square.map(([x, z]): Pt => [cx + x * c + z * s, cz - x * s + z * c]);
    if (table)
      poly = clipToRect(
        poly,
        table.x - table.halfX,
        table.x + table.halfX,
        table.z - table.halfZ,
        table.z + table.halfZ,
      );
    if (poly.length < 3) return;
    const ids = poly.map(([x, z]) => {
      const dx = x - cx;
      const dz = z - cz;
      return this.vertex(
        [x, y + DECAL_LIFT, z],
        [dx * c - dz * s, dx * s + dz * c],
        shape,
        tint,
        [0, 0, 0],
      );
    });
    // Winding faces up (+y) for any convex polygon from the clip.
    for (let i = 1; i + 1 < ids.length; i++)
      this.index.push(ids[0] as number, ids[i + 1] as number, ids[i] as number);
  }

  /** A camera-facing quad about `centre`, pushed `back` metres away from the eye. */
  billboard(
    centre: readonly number[],
    hw: number,
    hh: number,
    back: number,
    tint: readonly number[],
  ): void {
    const corners: Pt[] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const ids = corners.map(([u, v]) =>
      this.vertex(centre, [u, v], [0, 0, 0, 1], tint, [u * hw, v * hh, back]),
    );
    this.index.push(
      ids[0] as number,
      ids[1] as number,
      ids[2] as number,
      ids[0] as number,
      ids[2] as number,
      ids[3] as number,
    );
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.position, 3));
    g.setAttribute('decalLocal', new THREE.Float32BufferAttribute(this.local, 2));
    g.setAttribute('decalShape', new THREE.Float32BufferAttribute(this.shape, 4));
    g.setAttribute('decalTint', new THREE.Float32BufferAttribute(this.tint, 4));
    g.setAttribute('decalCorner', new THREE.Float32BufferAttribute(this.corner, 3));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    // Billboards reach past their vertex positions by their corner offsets.
    if (g.boundingSphere) g.boundingSphere.radius += Math.hypot(HALO.halfW, HALO.halfH);
    return g;
  }
}

/** A round contact shadow for a freestanding prop on a lightmapped floor. */
export function createFloorContactShadow(
  radius: number,
  softness: number,
): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> {
  const b = new DecalBuilder();
  const extent = radius + softness;
  b.ground(
    0,
    0,
    0,
    extent,
    extent,
    0,
    undefined,
    [radius, radius, radius, softness],
    [0, 0, 0, SHADOW_ALPHA],
  );
  return new THREE.Mesh(b.geometry(), createDecalMaterial());
}

/**
 * Light pools under candles, a halo behind each flame and a contact shadow under every prop, as one
 * geometry: pools first, so a prop's shadow darkens the light it stands in.
 */
export function buildDecals(
  placements: readonly DecorPlacement[],
  contactOf: (p: DecorPlacement) => DecorContact,
): THREE.BufferGeometry {
  const b = new DecalBuilder();
  const amber = (k: number) => [AMBER.r * k, AMBER.g * k, AMBER.b * k, 0];
  for (const p of placements) {
    if (p.kind !== 'candle') continue;
    b.ground(
      p.x,
      p.z,
      0,
      POOL_RADIUS,
      POOL_RADIUS,
      p.y,
      tableOf(p.table),
      [0, 0, 0, -POOL_RADIUS],
      amber(POOL_STRENGTH),
    );
  }
  for (const p of placements) {
    const c = contactOf(p);
    const cos = Math.cos(p.yaw);
    const sin = Math.sin(p.yaw);
    const cx = p.x + c.x * cos + c.z * sin;
    const cz = p.z - c.x * sin + c.z * cos;
    b.ground(
      cx,
      cz,
      p.yaw,
      c.halfX + SHADOW_SOFT,
      c.halfZ + SHADOW_SOFT,
      p.y,
      tableOf(p.table),
      [c.halfX, c.halfZ, Math.min(c.corner, c.halfX, c.halfZ), SHADOW_SOFT],
      [0, 0, 0, SHADOW_ALPHA],
    );
  }
  for (const p of placements) {
    if (p.kind !== 'candle') continue;
    b.billboard([p.x, p.y + HALO.y, p.z], HALO.halfW, HALO.halfH, HALO.back, amber(HALO.strength));
  }
  return b.geometry();
}

/** A contact rectangle from a prop's bounding box, for props built without a manifest. */
function boxContact(g: THREE.BufferGeometry): DecorContact {
  g.computeBoundingBox();
  const box = g.boundingBox as THREE.Box3;
  const halfX = (box.max.x - box.min.x) / 2;
  const halfZ = (box.max.z - box.min.z) / 2;
  return {
    x: (box.max.x + box.min.x) / 2,
    z: (box.max.z + box.min.z) / 2,
    halfX,
    halfZ,
    corner: Math.min(halfX, halfZ),
  };
}

/**
 * The loaded props: base-centred geometries per kind and variant sharing one atlas material. `build`
 * merges a room's props into a single mesh (one draw call) with one decal child (one more).
 */
export class TableDecor {
  readonly contacts: Readonly<Record<DecorKind, readonly DecorContact[]>>;

  constructor(
    readonly geometries: Readonly<Record<DecorKind, readonly THREE.BufferGeometry[]>>,
    readonly material: THREE.MeshStandardMaterial,
    readonly textures: readonly THREE.Texture[] = [],
    contacts?: Readonly<Record<DecorKind, readonly DecorContact[]>>,
    readonly decalMaterial: THREE.ShaderMaterial = createDecalMaterial(),
  ) {
    this.contacts =
      contacts ??
      (Object.fromEntries(
        DECOR_KINDS.map((k) => [k, geometries[k].map((g) => boxContact(g))]),
      ) as Record<DecorKind, DecorContact[]>);
  }

  private pick<T>(list: readonly T[], variant: number): T {
    return (list[variant] ?? list[0]) as T;
  }

  /** One merged mesh of `placements` (room-local) with its decals as a child, or null when none. */
  build(placements: readonly DecorPlacement[]): THREE.Mesh | null {
    if (placements.length === 0) return null;
    const m = new THREE.Matrix4();
    const parts = placements.map((p) =>
      this.pick(this.geometries[p.kind], p.variant)
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
    const decalGeometry = buildDecals(placements, (p) =>
      this.pick(this.contacts[p.kind], p.variant),
    );
    const decals = new THREE.Mesh(decalGeometry, this.decalMaterial);
    decals.name = 'table-decor-decals';
    decals.castShadow = false;
    decals.receiveShadow = false;
    decals.userData[DECAL_MESH] = true;
    mesh.add(decals);
    merged.addEventListener('dispose', () => decalGeometry.dispose());
    return mesh;
  }

  /** One of each prop variant in a row, for the load veil's program warm-up. */
  sample(): THREE.Mesh {
    const row: DecorPlacement[] = [];
    for (const kind of DECOR_KINDS) {
      this.geometries[kind].forEach((_, variant) => {
        row.push({
          room: -1,
          table: 'sample',
          kind,
          x: row.length * 0.3,
          y: 0,
          z: 0,
          yaw: 0,
          variant,
        });
      });
    }
    return this.build(row) as THREE.Mesh;
  }
}

/** Keeps only the attributes every prop has, so they merge into one buffer. */
function mergeable(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name);
  }
  return geometry;
}

/**
 * The flame skips tone mapping: AgX's shoulder pulls an emitter above about 0.5 linear toward cream
 * (the study's flames follow the same rule, src/world/study-room.ts `emitterSlot`). Only the lit
 * term is tone-mapped; the emission is added after it at the authored texel colour, deepening
 * toward the silhouette. Metallic texels reflect the probe `metalEnv` times as strongly as the rest.
 */
function patchDecorShader(material: THREE.MeshStandardMaterial, metalEnv: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.decorMetalEnv = { value: metalEnv };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float decorMetalEnv;')
      .replace(
        '#include <lights_fragment_end>',
        [
          '#if defined( RE_IndirectSpecular )',
          '\tradiance *= mix( 1.0, decorMetalEnv, metalnessFactor );',
          '#endif',
          '#include <lights_fragment_end>',
        ].join('\n'),
      )
      .replace(
        '#include <tonemapping_fragment>',
        [
          'vec3 decorGlow = totalEmissiveRadiance;',
          'float decorPeak = max( decorGlow.r, max( decorGlow.g, decorGlow.b ) );',
          '#if defined( TONE_MAPPING )',
          '\tgl_FragColor.rgb = toneMapping( max( gl_FragColor.rgb - decorGlow, 0.0 ) );',
          '#endif',
          'if ( decorPeak > 0.0 ) {',
          '\tfloat decorFacing = saturate( dot( geometryNormal, geometryViewDir ) );',
          '\tdecorGlow *= mix( 0.72, 1.0, smoothstep( 0.1, 0.6, decorFacing ) ) / max( 1.0, decorPeak );',
          '}',
          'gl_FragColor.rgb = min( gl_FragColor.rgb + decorGlow, vec3( 1.0 ) );',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => 'table-decor';
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
  const geometries = {} as Record<DecorKind, THREE.BufferGeometry[]>;
  const contacts = {} as Record<DecorKind, DecorContact[]>;
  for (const kind of DECOR_KINDS) {
    const variants = manifest.kinds[kind].variants;
    geometries[kind] = variants.map((v) => {
      const node = gltf.scene.getObjectByName(v.node) as THREE.Mesh | undefined;
      if (!node?.isMesh) throw new Error(`table-decor: node ${v.node} missing`);
      return mergeable(node.geometry.clone().applyMatrix4(node.matrixWorld));
    });
    contacts[kind] = variants.map((v) => v.contact);
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
  patchDecorShader(
    material,
    manifest.metalEnvMapIntensity / Math.max(manifest.envMapIntensity, 1e-3),
  );
  return new TableDecor(geometries, material, [map, normalMap, orm, emissiveMap], contacts);
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

/** Frees the merged decoration geometry under `root`, and with it the decals (shared materials stay). */
export function disposeTableDecor(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (node.userData[DECOR_MESH]) (node as THREE.Mesh).geometry.dispose();
  });
}
