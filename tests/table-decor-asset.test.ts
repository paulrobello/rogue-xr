// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { generateFloor } from '../src/floor/generate.ts';
import { DECOR_KINDS, type DecorKind, placeTableDecor } from '../src/floor/table-decor.ts';
import {
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
  const geometries = {} as Record<DecorKind, THREE.BufferGeometry>;
  for (const kind of DECOR_KINDS) geometries[kind] = new THREE.BoxGeometry(0.05, 0.1, 0.05);
  return new TableDecor(geometries, new THREE.MeshStandardMaterial());
}

describe('table-decor runtime asset', () => {
  it('parses the shipped manifest within the placement footprints', () => {
    const m = parseTableDecorManifest(raw);
    expect(Object.keys(m.kinds).sort()).toEqual([...DECOR_KINDS].sort());
    for (const kind of DECOR_KINDS) expect(m.kinds[kind].tris).toBeLessThanOrEqual(600);
  });

  it('refuses a prop wider than its footprint', () => {
    const wide = structuredClone(raw) as { kinds: Record<string, { radius: number }> };
    (wide.kinds.vase as { radius: number }).radius = 0.2;
    expect(() => parseTableDecorManifest(wide)).toThrow(/vase radius/);
  });

  it('merges a room into one shadowless mesh, or nothing for no props', () => {
    const decor = stubDecor();
    expect(decor.build([])).toBeNull();
    const mesh = decor.sample();
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);
    expect(mesh.material).toBe(decor.material);
    expect(mesh.geometry.attributes.position?.count).toBe(3 * 24);
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
    const spies = meshes.map((m) => vi.spyOn(m.geometry, 'dispose'));
    disposeTableDecor(root);
    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
  });
});
