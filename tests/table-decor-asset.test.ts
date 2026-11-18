// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { generateFloor } from '../src/floor/generate.ts';
import {
  DECOR_KINDS,
  DECOR_TABLES,
  DECOR_VARIANTS,
  type DecorKind,
  placeTableDecor,
} from '../src/floor/table-decor.ts';
import {
  buildDecals,
  disposeTableDecor,
  dressTableDecor,
  parseTableDecorManifest,
  TableDecor,
} from '../src/world/table-decor.ts';

const raw: unknown = JSON.parse(
  readFileSync(
    new URL('../public/assets/props/table-decor/table-decor.manifest.json', import.meta.url),
    'utf8',
  ),
);

function stubDecor(): TableDecor {
  const geometries = {} as Record<DecorKind, THREE.BufferGeometry[]>;
  for (const kind of DECOR_KINDS)
    geometries[kind] = Array.from(
      { length: DECOR_VARIANTS[kind] },
      () => new THREE.BoxGeometry(0.05, 0.1, 0.05),
    );
  return new TableDecor(geometries, new THREE.MeshStandardMaterial());
}

const variantCount = DECOR_KINDS.reduce((n, k) => n + DECOR_VARIANTS[k], 0);

describe('table-decor runtime asset', () => {
  it('parses the shipped manifest: every variant within its footprint and budget', () => {
    const m = parseTableDecorManifest(raw);
    expect(Object.keys(m.kinds).sort()).toEqual([...DECOR_KINDS].sort());
    for (const kind of DECOR_KINDS) {
      expect(m.kinds[kind].variants).toHaveLength(DECOR_VARIANTS[kind]);
      for (const v of m.kinds[kind].variants) {
        expect(v.tris).toBeLessThanOrEqual(600);
        expect(v.contact.halfX).toBeGreaterThan(0);
      }
    }
    expect(m.metalEnvMapIntensity).toBeGreaterThan(m.envMapIntensity);
  });

  it('refuses a prop wider than its footprint, or a missing variant', () => {
    const wide = structuredClone(raw) as {
      kinds: Record<string, { variants: { radius: number }[] }>;
    };
    (wide.kinds.vase?.variants[0] as { radius: number }).radius = 0.2;
    expect(() => parseTableDecorManifest(wide)).toThrow(/vase radius/);
    const short = structuredClone(raw) as { kinds: Record<string, { variants: unknown[] }> };
    short.kinds.books?.variants.pop();
    expect(() => parseTableDecorManifest(short)).toThrow(/books needs 3 variants/);
  });

  it('merges a room into one shadowless mesh with one decal child, or nothing for no props', () => {
    const decor = stubDecor();
    expect(decor.build([])).toBeNull();
    const mesh = decor.sample();
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);
    expect(mesh.material).toBe(decor.material);
    expect(mesh.geometry.attributes.position?.count).toBe(variantCount * 24);
    expect(mesh.children).toHaveLength(1);
    const decals = mesh.children[0] as THREE.Mesh;
    expect(decals.material).toBe(decor.decalMaterial);
    expect(decals.castShadow).toBe(false);
    expect(decals.userData.tableDecor).toBeUndefined();
  });

  it('frees the decals with the prop geometry', () => {
    const mesh = stubDecor().sample();
    const decals = mesh.children[0] as THREE.Mesh;
    const spy = vi.spyOn(decals.geometry, 'dispose');
    mesh.geometry.dispose();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('dresses only the dressed rooms that have tables, and frees their geometry', () => {
    const plan = generateFloor('SPIRE002');
    const roomGroups = plan.rooms.map(() => new THREE.Group());
    const decor = stubDecor();
    const added = dressTableDecor({ plan, roomGroups }, decor, new Set(['hall']));
    const hallRooms = new Set(
      placeTableDecor(
        plan.seed,
        plan.rooms.map((r) => r.templateId),
      )
        .filter((p) => plan.rooms[p.room]?.templateId === 'hall')
        .map((p) => p.room),
    );
    expect(hallRooms.size).toBeGreaterThan(0);
    expect(added).toBe(hallRooms.size);
    roomGroups.forEach((g, i) => {
      expect(g.children.length).toBe(hallRooms.has(i) ? 1 : 0);
    });
    const root = new THREE.Group();
    for (const g of roomGroups) root.add(g);
    const meshes: THREE.Mesh[] = [];
    root.traverse((n) => {
      if ((n as THREE.Mesh).isMesh) meshes.push(n as THREE.Mesh);
    });
    expect(meshes).toHaveLength(2 * hallRooms.size);
    const spies = meshes.map((m) => vi.spyOn(m.geometry, 'dispose'));
    disposeTableDecor(root);
    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
  });
});

describe('table-decor decals', () => {
  const placements = ['SPIRE002', 'SPIRE004', 'SPIRE011', 'SPIRE023'].flatMap((seed) =>
    placeTableDecor(
      seed,
      generateFloor(seed).rooms.map((r) => r.templateId),
    ),
  );
  const contact = () => ({ x: 0, z: 0, halfX: 0.05, halfZ: 0.05, corner: 0.05 });
  const g = buildDecals(placements, contact);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const corner = g.attributes.decalCorner as THREE.BufferAttribute;
  const shape = g.attributes.decalShape as THREE.BufferAttribute;
  const tint = g.attributes.decalTint as THREE.BufferAttribute;

  it('keeps every flat decal on its table top, clipped inside the edges', () => {
    const tables = Object.values(DECOR_TABLES).flat();
    let flat = 0;
    for (let i = 0; i < pos.count; i++) {
      if (corner.getX(i) !== 0 || corner.getY(i) !== 0) continue;
      flat++;
      const t = tables.find(
        (c) =>
          Math.abs(pos.getY(i) - c.top) < 0.01 &&
          Math.abs(pos.getX(i) - c.x) <= c.halfX + 1e-6 &&
          Math.abs(pos.getZ(i) - c.z) <= c.halfZ + 1e-6,
      );
      expect(t, `vertex ${i} off every table`).toBeDefined();
      expect(pos.getY(i)).toBeGreaterThan((t?.top as number) + 1e-4);
    }
    expect(flat).toBeGreaterThan(0);
  });

  it('gives each candle a light pool and a halo, and every prop a contact shadow', () => {
    const candles = placements.filter((p) => p.kind === 'candle').length;
    let pools = 0;
    let halos = 0;
    let shadows = 0;
    for (let i = 0; i < pos.count; i++) {
      if (shape.getW(i) < 0) pools++;
      else if (corner.getZ(i) > 0) halos++;
      else if (tint.getW(i) > 0) shadows++;
    }
    expect(halos).toBe(4 * candles);
    expect(pools).toBeGreaterThanOrEqual(3 * candles);
    expect(shadows).toBeGreaterThanOrEqual(3 * placements.length);
    // Light adds (rgb, no alpha); shadows only darken (alpha, no rgb).
    for (let i = 0; i < pos.count; i++) {
      if (tint.getW(i) > 0) expect(tint.getX(i) + tint.getY(i) + tint.getZ(i)).toBe(0);
      else expect(tint.getX(i)).toBeGreaterThan(0);
    }
  });
});
