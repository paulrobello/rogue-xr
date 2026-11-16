// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUDGET_LIMITS, parseRoomTemplate, templateById } from '../src/content/rooms.ts';
import { parseTemplateManifest } from '../src/world/lightmap.ts';

const DIR = new URL('../public/assets/rooms/study/', import.meta.url);
const raw: unknown = JSON.parse(readFileSync(new URL('study.manifest.json', DIR), 'utf8'));

interface GltfJson {
  meshes: { primitives: { attributes: Record<string, number>; material?: number }[] }[];
  materials: { name: string }[];
  images?: unknown[];
}

function glbJson(): GltfJson {
  const bytes = readFileSync(new URL('study.glb', DIR));
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as GltfJson;
}

describe('hero study room asset (P4-T4)', () => {
  const room = parseRoomTemplate(raw);
  const lightmap = parseTemplateManifest(raw);
  const greybox = templateById('study');

  it('drops into floor generation in place of the greybox study', () => {
    expect(room.id).toBe(greybox.id);
    expect(room.kinds).toEqual(greybox.kinds);
    expect(room.footprint).toEqual(greybox.footprint);
    expect(room.doors).toEqual(greybox.doors);
    expect(room.rotations).toEqual(greybox.rotations);
    expect(room.enemySockets).toEqual(greybox.enemySockets);
    expect(room.lootSockets).toEqual(greybox.lootSockets);
    expect(room.dressingSockets).toEqual(greybox.dressingSockets);
    expect(room.lightSockets).toEqual(greybox.lightSockets);
    expect(room.probe).toEqual(greybox.probe);
    expect(room.walkable).toEqual(greybox.walkable);
  });

  it('keeps every greybox collider and adds the dressing', () => {
    // The greybox computes door gaps in floats (-1 + 0.8), the manifest stores them rounded.
    const same = (a: readonly number[], b: readonly number[]) =>
      a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) < 1e-6);
    for (const box of greybox.colliders) {
      expect(room.colliders.some((c) => same(c.min, box.min) && same(c.max, box.max))).toBe(true);
    }
    expect(room.colliders.length).toBeGreaterThan(greybox.colliders.length);
  });

  it('binds its lightmap by exact filename on UV1 at pi x scale', () => {
    expect(lightmap.glb).toBe('study.glb');
    expect(lightmap.lightmap.file).toBe('study.lightmap.ktx2');
    expect(lightmap.lightmap.intensity).toBeCloseTo(Math.PI * lightmap.lightmap.scale, 5);
  });

  it('stays inside the PRD room budgets', () => {
    expect(room.budget.tris).toBeLessThanOrEqual(BUDGET_LIMITS.tris);
    expect(room.budget.materials).toBeLessThanOrEqual(BUDGET_LIMITS.materials);
    expect(room.budget.texturePx).toBeLessThanOrEqual(BUDGET_LIMITS.texturePx);
  });

  it('ships an image-free GLB whose every primitive has UV1 and a manifest slot', () => {
    const gltf = glbJson();
    const slots = (raw as { materials: Record<string, unknown> }).materials;
    expect(gltf.images ?? []).toHaveLength(0);
    expect(gltf.materials.length).toBeLessThanOrEqual(BUDGET_LIMITS.materials);
    for (const mesh of gltf.meshes) {
      for (const primitive of mesh.primitives) {
        expect(primitive.attributes).toHaveProperty('TEXCOORD_1');
        const name = gltf.materials[primitive.material ?? -1]?.name ?? '';
        expect(Object.keys(slots)).toContain(name);
      }
    }
  });
});
