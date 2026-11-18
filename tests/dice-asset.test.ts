// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { DICE } from '../src/content/dice.ts';
import {
  DICE_ASSET_IDS,
  DICE_GLOW_INTENSITY,
  type DiceAsset,
  type DiceManifest,
  faceGlowIntensity,
  parseDice,
  parseDiceManifest,
} from '../src/dice/dice-asset.ts';
import {
  correctionRotation,
  D6_HALF_EXTENT,
  D8_CIRCUMRADIUS,
  type DieKind,
  faceNormals,
  upFace,
} from '../src/dice/faces.ts';
import { QUAT_IDENTITY } from '../src/dice/quat.ts';
import { dieFace, type UiAtlasManifest } from '../src/ui/icon-atlas.ts';

const KINDS: readonly ('d6' | 'd8')[] = ['d6', 'd8'];
const root = new URL('../public/assets/', import.meta.url);
const atlas = JSON.parse(
  readFileSync(new URL('ui/ui-atlas.json', root), 'utf8'),
) as UiAtlasManifest;

interface Gltf {
  nodes: { name: string; mesh?: number; extras?: { die?: { faces?: unknown } } }[];
  materials: { name: string; doubleSided?: boolean }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  accessors: { count: number }[];
  images?: unknown[];
  textures?: unknown[];
}

function readGlbJson(bytes: Buffer): Gltf {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8'));
}

const files = Object.fromEntries(
  KINDS.map((kind) => {
    const id = DICE_ASSET_IDS[kind];
    const base = new URL(`dice/${id}/`, root);
    const manifest = parseDiceManifest(
      JSON.parse(readFileSync(new URL(`${id}.manifest.json`, base), 'utf8')),
    );
    const bytes = readFileSync(new URL(manifest.glb, base));
    return [kind, { manifest, bytes, gltf: readGlbJson(bytes) }];
  }),
) as Record<'d6' | 'd8', { manifest: DiceManifest; bytes: Buffer; gltf: Gltf }>;

function arrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
const glbs = () =>
  ({ d6: arrayBuffer(files.d6.bytes), d8: arrayBuffer(files.d8.bytes) }) as Record<
    'd6' | 'd8',
    ArrayBuffer
  >;
const manifests = () => ({ d6: files.d6.manifest, d8: files.d8.manifest });
const faceSlotOf = (manifest: DiceManifest) => {
  const slot = Object.values(manifest.materialSlots).find((s) => s.role === 'face');
  if (!slot) throw new Error(`${manifest.id}: no face slot`);
  return slot;
};

let asset: DiceAsset | null = null;
afterEach(() => {
  asset?.dispose();
  asset = null;
});

describe('dice asset metadata', () => {
  for (const kind of KINDS) {
    const id = DICE_ASSET_IDS[kind];
    it(`${id}: the GLB face table matches faces.ts normals and content/dice.ts values`, () => {
      const { gltf, manifest } = files[kind];
      const node = gltf.nodes.find((n) => n.name === manifest.node);
      const faces = node?.extras?.die?.faces as
        | { index: number; value: number; normal: number[] }[]
        | undefined;
      const normals = faceNormals(kind);
      const values = DICE[id].faces;
      expect(faces).toHaveLength(normals.length);
      expect(values).toHaveLength(normals.length);
      faces?.forEach((face, i) => {
        expect(face.index).toBe(i);
        expect(face.value).toBe(values[i]);
        const n = normals[i] as { x: number; y: number; z: number };
        expect(face.normal[0]).toBeCloseTo(n.x, 12);
        expect(face.normal[1]).toBeCloseTo(n.y, 12);
        expect(face.normal[2]).toBeCloseTo(n.z, 12);
        expect(manifest.faces[i]?.normal).toEqual(face.normal);
        expect(manifest.faces[i]?.value).toBe(face.value);
        expect(manifest.faces[i]?.atlas.uv).toEqual(dieFace(atlas, id, i).uv);
      });
    });

    it(`${id}: meets the dice budgets (<= 1,500 tris, <= 2 materials, image-free, single-sided)`, () => {
      const { gltf, manifest } = files[kind];
      let tris = 0;
      for (const mesh of gltf.meshes) {
        for (const p of mesh.primitives) tris += (gltf.accessors[p.indices ?? -1]?.count ?? 0) / 3;
      }
      expect(tris).toBeLessThanOrEqual(1500);
      expect(gltf.materials.length).toBeLessThanOrEqual(2);
      expect(gltf.materials.some((m) => m.doubleSided)).toBe(false);
      expect(gltf.images ?? []).toHaveLength(0);
      expect(gltf.textures ?? []).toHaveLength(0);
      expect(manifest.budget.tris).toBe(tris);
      expect(manifest.budget.materials).toBe(gltf.materials.length);
      expect(manifest.budget.texturesProduced).toBe(0);
    });
  }
});

/** Triangles of the face-material group, as world-free arrays, after `q` rotates the die. */
function faceTriangles(mesh: THREE.Mesh, q: THREE.Quaternion) {
  const g = mesh.geometry;
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const index = g.getIndex();
  const materials = mesh.material as THREE.MeshStandardMaterial[];
  const faceGroup = g.groups.find((gr) => materials[gr.materialIndex ?? 0]?.name.endsWith('-face'));
  if (!index || !faceGroup) throw new Error('no face group');
  const out: { normal: THREE.Vector3; top: number; uv: THREE.Vector2; uvArea: number }[] = [];
  const p = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const t = [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()];
  for (let i = faceGroup.start; i < faceGroup.start + faceGroup.count; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = index.getX(i + k);
      (p[k] as THREE.Vector3).fromBufferAttribute(pos, v).applyQuaternion(q);
      (t[k] as THREE.Vector2).fromBufferAttribute(uv, v);
    }
    const [a, b, c] = p as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
    const [ta, tb, tc] = t as [THREE.Vector2, THREE.Vector2, THREE.Vector2];
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    const uvArea = (tb.x - ta.x) * (tc.y - ta.y) - (tb.y - ta.y) * (tc.x - ta.x);
    out.push({
      normal,
      top: Math.max(a.y, b.y, c.y),
      uv: ta.clone().add(tb).add(tc).divideScalar(3),
      uvArea,
    });
  }
  return out;
}

describe('dice asset geometry', () => {
  for (const kind of KINDS) {
    const id = DICE_ASSET_IDS[kind];

    it(`${id}: correcting toward each face puts that face's atlas cell up on the real geometry`, async () => {
      asset = await parseDice(glbs(), manifests());
      const mesh = asset.spawn(kind);
      const normals = asset.diceAssetFaces(kind);
      expect(normals).toEqual(faceNormals(kind));
      normals.forEach((_, i) => {
        // The presenter's correction from an unrotated die, exactly as world.ts applies it.
        const c = correctionRotation(QUAT_IDENTITY, normals, i);
        expect(upFace(c, faceNormals(kind))).toBe(i);
        const q = new THREE.Quaternion(c.x, c.y, c.z, c.w);
        const tris = faceTriangles(mesh, q);
        const up = tris.filter((t) => t.normal.y > 0.999);
        expect(up.length).toBeGreaterThan(0);
        const cell = dieFace(atlas, id, i).uv;
        for (const t of up) {
          expect(t.uv.x).toBeGreaterThan(cell.u0);
          expect(t.uv.x).toBeLessThan(cell.u1);
          expect(t.uv.y).toBeGreaterThan(cell.v0);
          expect(t.uv.y).toBeLessThan(cell.v1);
        }
        // Those up-facing triangles are the face that shows: nothing of the face art sits higher.
        const highest = Math.max(...tris.map((t) => t.top));
        expect(Math.max(...up.map((t) => t.top))).toBeCloseTo(highest, 6);
        // The value shown is the one content/dice.ts prints on face i.
        expect(asset?.manifest(kind).faces[i]?.value).toBe(DICE[id].faces[i]);
      });
    });

    it(`${id}: face art is never mirrored (UV winding follows the outward winding)`, async () => {
      asset = await parseDice(glbs(), manifests());
      const tris = faceTriangles(asset.spawn(kind), new THREE.Quaternion());
      expect(tris.length).toBeGreaterThan(0);
      expect(tris.every((t) => t.uvArea > 0)).toBe(true);
    });

    it(`${id}: bounds match the DiceWorld collider exactly`, async () => {
      asset = await parseDice(glbs(), manifests());
      const box = asset.spawn(kind).geometry.boundingBox as THREE.Box3;
      const e = kind === 'd6' ? D6_HALF_EXTENT : D8_CIRCUMRADIUS;
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(box.min[axis]).toBeCloseTo(-e, 6);
        expect(box.max[axis]).toBeCloseTo(e, 6);
      }
    });
  }
});

describe('dice asset lifecycle', () => {
  it('spawns meshes that share geometry and a two-slot material array', async () => {
    asset = await parseDice(glbs(), manifests());
    for (const kind of KINDS) {
      const a = asset.spawn(kind);
      const b = asset.spawn(kind);
      expect(a).toBeInstanceOf(THREE.Mesh);
      expect(a.geometry).toBe(b.geometry);
      expect(a.material).toBe(b.material);
      expect(a.geometry.groups).toHaveLength(2);
      expect(a.name).toBe(DICE_ASSET_IDS[kind]);
    }
  });

  it('binds and unbinds the atlas pages on the face slot only', async () => {
    asset = await parseDice(glbs(), manifests());
    const page = new THREE.Texture();
    asset.bindFaceMaps({ d6: page });
    const d6 = asset.spawn('d6').material as THREE.MeshStandardMaterial[];
    const d8 = asset.spawn('d8').material as THREE.MeshStandardMaterial[];
    expect(d6.filter((m) => m.map === page)).toHaveLength(1);
    expect(d6.find((m) => m.map === page)?.name).toBe('brass-d6-face');
    expect(d8.some((m) => m.map)).toBe(false);
    asset.bindFaceMaps({ d6: null });
    expect(d6.some((m) => m.map)).toBe(false);
    page.dispose();
  });

  it('binds the glow page as the emissive map and the colour page as the map', async () => {
    asset = await parseDice(glbs(), manifests());
    const colour = { d6: new THREE.Texture(), d8: new THREE.Texture() };
    const glow = { d6: new THREE.Texture(), d8: new THREE.Texture() };
    asset.bindFaceMaps(colour, glow);
    for (const kind of KINDS) {
      const mats = asset.spawn(kind).material as THREE.MeshStandardMaterial[];
      const face = mats.find((m) => m.name.endsWith('-face'));
      expect(face?.map).toBe(colour[kind]);
      expect(face?.emissiveMap).toBe(glow[kind]);
      expect(face?.emissive.getHex()).toBe(0xffffff);
      const slot = faceSlotOf(files[kind].manifest);
      expect(face?.emissiveIntensity).toBe(faceGlowIntensity(slot));
      expect(face?.color.getHexString()).toBe(
        new THREE.Color(slot.color ?? '#ffffff').getHexString(),
      );
      // Swept in engine (assets-source/dice/engine_shot.py framing): below about 0.5 the d8 numeral
      // drops under 4.5:1 against the glass; above 2 AgX washes the amber toward white.
      expect(face?.emissiveIntensity).toBeGreaterThanOrEqual(0.5);
      expect(face?.emissiveIntensity).toBeLessThanOrEqual(2);
      expect(DICE_GLOW_INTENSITY).toBeGreaterThanOrEqual(1.5);
      expect(DICE_GLOW_INTENSITY).toBeLessThanOrEqual(2);
      // The body never samples either page.
      for (const m of mats.filter((m) => m !== face)) {
        expect(m.map).not.toBe(colour[kind]);
        expect(m.emissiveMap).not.toBe(glow[kind]);
      }
    }
    asset.bindFaceMaps({ d6: null, d8: null }, glow);
    for (const kind of KINDS) {
      const face = (asset.spawn(kind).material as THREE.MeshStandardMaterial[]).find((m) =>
        m.name.endsWith('-face'),
      );
      expect(face?.map).toBeNull();
      expect(face?.emissiveMap).toBeNull();
      expect(face?.emissiveIntensity).toBe(0);
    }
  });

  it('applies the face slot tint and glow intensity the manifest names (pass-2 fields)', async () => {
    const d6 = structuredClone(files.d6.manifest);
    const d8 = structuredClone(files.d8.manifest);
    Object.assign(faceSlotOf(d6), {
      color: '#fff6d1',
      glowPage: 'dice-d6-glow',
      emissiveIntensity: 1.6,
    });
    // No glowPage: the slot's intensity was tuned for a whole-page emissive map, so it is ignored.
    Object.assign(faceSlotOf(d8), { color: '#463a30', emissiveIntensity: 0.7 });
    delete faceSlotOf(d8).glowPage;
    const local = await parseDice(glbs(), { d6: parseDiceManifest(d6), d8: parseDiceManifest(d8) });
    asset = local;
    const colour = { d6: new THREE.Texture(), d8: new THREE.Texture() };
    const glow = { d6: new THREE.Texture(), d8: new THREE.Texture() };
    local.bindFaceMaps(colour, glow);
    const faceOf = (kind: DieKind) =>
      (local.spawn(kind).material as THREE.MeshStandardMaterial[]).find((m) =>
        m.name.endsWith('-face'),
      );
    expect(faceOf('d6')?.color.getHexString()).toBe(new THREE.Color('#fff6d1').getHexString());
    expect(faceOf('d6')?.emissiveIntensity).toBe(1.6);
    expect(faceOf('d8')?.color.getHexString()).toBe(new THREE.Color('#463a30').getHexString());
    expect(faceOf('d8')?.emissiveIntensity).toBe(DICE_GLOW_INTENSITY);
    // Unbound faces fall back to the art-bible factor colours, not the tint.
    local.bindFaceMaps({ d6: null, d8: null });
    expect(faceOf('d6')?.color.getHexString()).toBe('583c26');
    expect(faceOf('d8')?.color.getHexString()).toBe('2d4a93');
    expect(() =>
      parseDiceManifest({
        ...files.d6.manifest,
        materialSlots: { x: { ...faceSlotOf(files.d6.manifest), color: 'amber' } },
      }),
    ).toThrow(/not #rrggbb/);
  });

  it('applies slot toneMapped and envMapScale to the dice materials only (pass-3 fields)', async () => {
    const d6 = structuredClone(files.d6.manifest);
    const d8 = structuredClone(files.d8.manifest);
    const bodyOf = (m: DiceManifest) => {
      const slot = Object.values(m.materialSlots).find((s) => s.role === 'body');
      if (!slot) throw new Error(`${m.id}: no body slot`);
      return slot;
    };
    Object.assign(faceSlotOf(d6), { toneMapped: false, envMapScale: 0.3 });
    Object.assign(bodyOf(d6), { envMapScale: 2 });
    // d8 keeps both fields absent: tone mapped, unscaled.
    delete faceSlotOf(d8).toneMapped;
    delete faceSlotOf(d8).envMapScale;
    delete bodyOf(d8).envMapScale;
    const local = await parseDice(glbs(), { d6: parseDiceManifest(d6), d8: parseDiceManifest(d8) });
    asset = local;
    const env = new THREE.Texture();
    local.setEnvironment(env, 0.35);
    const mats = (kind: DieKind) => local.spawn(kind).material as THREE.MeshStandardMaterial[];
    const d6Face = mats('d6').find((m) => m.name.endsWith('-face'));
    const d6Body = mats('d6').find((m) => !m.name.endsWith('-face'));
    expect(d6Face?.toneMapped).toBe(false);
    expect(d6Face?.envMap).toBe(env);
    expect(d6Face?.envMapIntensity).toBeCloseTo(0.105, 12);
    expect(d6Body?.toneMapped).toBe(true);
    expect(d6Body?.envMapIntensity).toBeCloseTo(0.7, 12);
    for (const m of mats('d8')) {
      expect(m.toneMapped).toBe(true);
      expect(m.envMapIntensity).toBeCloseTo(0.35, 12);
    }
    // Binding the pages keeps the slot's tone mapping.
    local.bindFaceMaps({ d6: new THREE.Texture() }, { d6: new THREE.Texture() });
    expect(d6Face?.toneMapped).toBe(false);
    for (const bad of [{ envMapScale: -1 }, { envMapScale: Number.NaN }, { toneMapped: 'no' }]) {
      expect(() =>
        parseDiceManifest({
          ...files.d6.manifest,
          materialSlots: { x: { ...faceSlotOf(files.d6.manifest), ...bad } },
        }),
      ).toThrow(/envMapScale|toneMapped/);
    }
    env.dispose();
  });

  it('the shipped face slots apply their manifest tone mapping and env scale', async () => {
    asset = await parseDice(glbs(), manifests());
    asset.setEnvironment(new THREE.Texture(), 0.35);
    for (const kind of KINDS) {
      const slots = files[kind].manifest.materialSlots;
      for (const m of asset.spawn(kind).material as THREE.MeshStandardMaterial[]) {
        const slot = slots[m.name];
        expect(slot).toBeDefined();
        expect(m.toneMapped).toBe(slot?.toneMapped ?? true);
        expect(m.envMapIntensity).toBeCloseTo(0.35 * (slot?.envMapScale ?? 1), 12);
      }
    }
  });

  it('emits nothing when a colour page is bound without a glow page', async () => {
    const local = await parseDice(glbs(), manifests());
    asset = local;
    const colour = new THREE.Texture();
    const glow = new THREE.Texture();
    local.bindFaceMaps({ d6: colour, d8: colour }, { d8: glow });
    const faceOf = (kind: DieKind) =>
      (local.spawn(kind).material as THREE.MeshStandardMaterial[]).find((m) =>
        m.name.endsWith('-face'),
      );
    const d6 = faceOf('d6');
    expect(d6?.map).toBe(colour);
    expect(d6?.emissiveMap).toBeNull();
    expect(d6?.emissive.getHex()).toBe(0x000000);
    expect(d6?.emissiveIntensity).toBe(0);
    expect(faceOf('d8')?.emissiveMap).toBe(glow);
    local.bindFaceMaps({ d6: colour, d8: colour });
    expect(faceOf('d8')?.emissiveMap).toBeNull();
    expect(faceOf('d8')?.emissiveIntensity).toBe(0);
  });

  it('dispose releases geometry and materials but not bound textures, then refuses spawn', async () => {
    const local = await parseDice(glbs(), manifests());
    const page = new THREE.Texture();
    let pageDisposed = false;
    page.addEventListener('dispose', () => {
      pageDisposed = true;
    });
    local.bindFaceMaps({ d6: page, d8: page });
    const meshes = KINDS.map((k) => local.spawn(k));
    const disposed: string[] = [];
    for (const m of meshes) {
      m.geometry.addEventListener('dispose', () => disposed.push('geometry'));
      for (const mat of m.material as THREE.Material[]) {
        mat.addEventListener('dispose', () => disposed.push('material'));
      }
    }
    local.dispose();
    local.dispose();
    expect(disposed.filter((d) => d === 'geometry')).toHaveLength(2);
    expect(disposed.filter((d) => d === 'material')).toHaveLength(4);
    expect(pageDisposed).toBe(false);
    expect(() => local.spawn('d6')).toThrow(/disposed/);
  });

  it('rejects corrupt GLB bytes', async () => {
    const bad = glbs();
    const bytes = new Uint8Array(bad.d8.slice(0));
    bytes.fill(0x5a, 24, 400);
    await expect(parseDice({ ...bad, d8: bytes.buffer }, manifests())).rejects.toThrow();
    await expect(parseDice({ ...bad, d6: new ArrayBuffer(16) }, manifests())).rejects.toThrow();
  });

  it('rejects a manifest whose face table disagrees with the GLB or the frame', async () => {
    const tampered = structuredClone(files.d6.manifest);
    (tampered.faces[0] as { normal: number[] }).normal = [1, 0, 0];
    await expect(parseDice(glbs(), { ...manifests(), d6: tampered })).rejects.toThrow(
      /face 0 differs/,
    );
    expect(() => parseDiceManifest({ ...files.d8.manifest, faces: [] })).toThrow(/8 faces/);
    expect(() => parseDiceManifest({ ...files.d6.manifest, kind: 'd8' })).toThrow(/not a d8/);
    await expect(
      parseDice(glbs(), { d6: files.d8.manifest, d8: files.d8.manifest }),
    ).rejects.toThrow();
  });
});
