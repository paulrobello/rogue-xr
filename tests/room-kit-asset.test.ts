// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUDGET_LIMITS,
  parseRoomTemplate,
  type RoomTemplate,
  rotateTemplate,
  templateById,
} from '../src/content/rooms.ts';
import { DEFAULT_FLOOR_PARAMS, generateFloor, worldRooms } from '../src/floor/generate.ts';
import { parseTemplateManifest, selectLightmapFile } from '../src/world/lightmap.ts';
import { heroTemplates, parseStudyManifest } from '../src/world/study-room.ts';

/** P5-T1 and P5-T2 kit rooms: baked templates that must stand in for their greybox twins unchanged. */
const KIT = ['hall', 'corridor', 'gear-shaft', 'guardian-vault'] as const;
/** Every baked template floor generation can place: the P4-T4 study plus the kit rooms. */
const BAKED = ['study', ...KIT] as const;

interface GltfJson {
  nodes: {
    name?: string;
    mesh?: number;
    translation?: number[];
    rotation?: number[];
    children?: number[];
  }[];
  scenes: { nodes: number[] }[];
  meshes: {
    primitives: { attributes: Record<string, number>; material?: number; indices?: number }[];
  }[];
  materials: { name: string }[];
  accessors: { count: number }[];
  images?: unknown[];
  textures?: unknown[];
}

const dir = (id: string) => new URL(`../public/assets/rooms/${id}/`, import.meta.url);
const rawManifest = (id: string): unknown =>
  JSON.parse(readFileSync(new URL(`${id}.manifest.json`, dir(id)), 'utf8'));

function glbJson(id: string): GltfJson {
  const bytes = readFileSync(new URL(`${id}.glb`, dir(id)));
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as GltfJson;
}

function ktx2Size(id: string): [number, number] {
  const bytes = readFileSync(new URL(`${id}.lightmap.ktx2`, dir(id)));
  return [bytes.readUInt32LE(20), bytes.readUInt32LE(24)];
}

const inside = (
  b: { min: readonly number[]; max: readonly number[] },
  x: number,
  z: number,
  m = 0,
) =>
  x >= (b.min[0] ?? 0) - m &&
  x <= (b.max[0] ?? 0) + m &&
  z >= (b.min[2] ?? 0) - m &&
  z <= (b.max[2] ?? 0) + m;

describe.each(KIT)('kit room asset %s (P5-T1, P5-T2)', (id) => {
  const raw = rawManifest(id);
  const room = parseRoomTemplate(raw);
  const greybox = templateById(id);

  it('parses as a room template, a lightmap manifest and a hero manifest', () => {
    expect(room.id).toBe(id);
    expect(parseTemplateManifest(raw).template).toBe(id);
    expect(Object.keys(parseStudyManifest(raw).materials).length).toBe(room.budget.materials);
  });

  it('copies the greybox layout exactly: doors, sockets, footprint, walkable', () => {
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

  it('keeps the greybox perimeter colliders bit for bit and adds dressing clear of play', () => {
    expect(room.colliders.slice(0, greybox.colliders.length)).toEqual(greybox.colliders);
    const extra = room.colliders.slice(greybox.colliders.length);
    const fp = room.footprint;
    for (const c of extra) {
      expect(c.min[0]).toBeGreaterThanOrEqual(fp.min[0]);
      expect(c.max[0]).toBeLessThanOrEqual(fp.max[0]);
      expect(c.min[2]).toBeGreaterThanOrEqual(fp.min[1]);
      expect(c.max[2]).toBeLessThanOrEqual(fp.max[1]);
      for (const s of [...room.enemySockets, ...room.lootSockets]) {
        expect(inside(c, s.position[0], s.position[2], 0.4)).toBe(false);
      }
      for (const d of room.doors) {
        // A 1 m deep apron in front of every doorway stays free.
        const [x, , z] = d.position;
        const step = { N: [0, 0.5], S: [0, -0.5], E: [-0.5, 0], W: [0.5, 0] }[d.facing];
        expect(inside(c, x + (step[0] ?? 0), z + (step[1] ?? 0), 0.5)).toBe(false);
      }
    }
  });

  it('stays inside the PRD room budgets and reports measured figures', () => {
    const gltf = glbJson(id);
    const tris = gltf.meshes
      .flatMap((m) => m.primitives)
      .reduce((n, p) => n + (gltf.accessors[p.indices ?? -1]?.count ?? 0) / 3, 0);
    expect(room.budget.tris).toBe(tris);
    expect(room.budget.tris).toBeLessThanOrEqual(BUDGET_LIMITS.tris);
    expect(room.budget.materials).toBe(gltf.materials.length);
    expect(room.budget.materials).toBeLessThanOrEqual(BUDGET_LIMITS.materials);
    expect(room.budget.texturePx).toBeLessThanOrEqual(BUDGET_LIMITS.texturePx);
  });

  it('binds its lightmap by exact filename on UV1 at pi x scale', () => {
    const lightmap = parseTemplateManifest(raw);
    expect(lightmap.glb).toBe(`${id}.glb`);
    expect(lightmap.lightmap.file).toBe(`${id}.lightmap.ktx2`);
    expect(lightmap.lightmap.uv).toBe(1);
    expect(lightmap.lightmap.intensity).toBeCloseTo(Math.PI * lightmap.lightmap.scale, 5);
    const near = [`x${id}.lightmap.ktx2`, `${id}-lightmap-old.ktx2`, 'study.lightmap.ktx2'];
    expect(selectLightmapFile(id, near)).toBeUndefined();
    expect(selectLightmapFile(id, [...near, `${id}.lightmap.ktx2`])).toBe(`${id}.lightmap.ktx2`);
    const [w, h] = ktx2Size(id);
    expect(w).toBe(h);
    expect([1024, 2048]).toContain(w);
    expect(room.budget.texturePx).toBe(w);
  });

  it('ships an image-free GLB whose every primitive has UV1 and a manifest slot', () => {
    const gltf = glbJson(id);
    const slots = Object.keys((raw as { materials: Record<string, unknown> }).materials);
    expect(gltf.images ?? []).toHaveLength(0);
    expect(gltf.textures ?? []).toHaveLength(0);
    for (const primitive of gltf.meshes.flatMap((m) => m.primitives)) {
      expect(primitive.attributes).toHaveProperty('TEXCOORD_1');
      expect(slots).toContain(gltf.materials[primitive.material ?? -1]?.name ?? '');
    }
  });
});

describe('gear-shaft crown gear (P5-T2 rigid node)', () => {
  const raw = rawManifest('gear-shaft') as {
    rigidNodes?: { node: string; pivot: number[]; axis: number[]; radPerSec: number }[];
  };
  const gltf = glbJson('gear-shaft');

  it('names one root mesh node on the spin axis, unrotated at rest', () => {
    expect(raw.rigidNodes).toHaveLength(1);
    const ring = raw.rigidNodes?.[0];
    expect(ring?.node).toBe('gear-shaft_gear_ring');
    expect(ring?.axis).toEqual([0, 1, 0]);
    expect(ring?.radPerSec).toBeGreaterThan(0);
    const index = gltf.nodes.findIndex((n) => n.name === ring?.node);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(gltf.scenes[0]?.nodes).toContain(index);
    const node = gltf.nodes[index];
    expect(node?.mesh).toBeTypeOf('number');
    expect(node?.children ?? []).toHaveLength(0);
    expect(node?.rotation ?? [0, 0, 0, 1]).toEqual([0, 0, 0, 1]);
    node?.translation?.forEach((v, i) => {
      expect(v).toBeCloseTo(ring?.pivot[i] ?? Number.NaN, 5);
    });
    expect(ring?.pivot[0]).toBe(0);
    expect(ring?.pivot[2]).toBe(0);
  });
});

describe('kit rooms in floor generation (1,000-seed property run)', () => {
  const baked = Object.fromEntries(
    BAKED.map((id) => [id, parseRoomTemplate(rawManifest(id))]),
  ) as Record<(typeof BAKED)[number], RoomTemplate>;
  const kit = BAKED.reduce<readonly RoomTemplate[]>(
    (templates, id) => heroTemplates(baked[id], templates),
    heroTemplates(null),
  );

  it('swaps every baked template in (not silently kept greybox)', () => {
    for (const id of BAKED) expect(kit.find((t) => t.id === id)).toBe(baked[id]);
  });

  it('places every baked room where the greybox would, on 1,000 seeds', () => {
    const counts = Object.fromEntries(BAKED.map((id) => [id, 0])) as Record<string, number>;
    for (let i = 0; i < 1000; i++) {
      const seed = `KA${i.toString().padStart(6, '0')}`;
      const grey = generateFloor(seed);
      const plan = generateFloor(seed, { ...DEFAULT_FLOOR_PARAMS, templates: kit });
      expect(plan).toEqual(grey);
      const before = worldRooms(grey);
      const after = worldRooms(plan, kit);
      plan.rooms.forEach((r, index) => {
        if (!(r.templateId in counts)) return;
        counts[r.templateId] = (counts[r.templateId] ?? 0) + 1;
        const asset = baked[r.templateId as (typeof BAKED)[number]];
        expect(after[index]?.template).toEqual(rotateTemplate(asset, r.turns));
        expect(after[index]?.footprint).toEqual(before[index]?.footprint);
        expect(after[index]?.doors).toEqual(before[index]?.doors);
      });
    }
    expect(counts.hall).toBeGreaterThanOrEqual(1000);
    for (const id of BAKED) expect(counts[id]).toBeGreaterThan(0);
  });
});
