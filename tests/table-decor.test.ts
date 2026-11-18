import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Stream } from '../src/core/rng.ts';
import { generateFloor } from '../src/floor/generate.ts';
import {
  DECOR_GAP,
  DECOR_KINDS,
  DECOR_RADIUS,
  DECOR_TABLES,
  type DecorPlacement,
  placeTableDecor,
} from '../src/floor/table-decor.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const seeds = (count: number): string[] => {
  const stream = Stream.fromKey('table-decor-property-test');
  return Array.from({ length: count }, () =>
    Array.from({ length: 8 }, () => CROCKFORD[stream.int(0, 31)]).join(''),
  );
};

/** Every table of every floor in `seedList`, with the props it received. */
function tablesOf(seedList: readonly string[]) {
  const out: { seed: string; room: number; table: string; props: DecorPlacement[] }[] = [];
  for (const seed of seedList) {
    const ids = generateFloor(seed).rooms.map((r) => r.templateId);
    const props = placeTableDecor(seed, ids);
    ids.forEach((id, room) => {
      for (const t of DECOR_TABLES[id] ?? [])
        out.push({
          seed,
          room,
          table: t.id,
          props: props.filter((p) => p.room === room && p.table === t.id),
        });
    });
  }
  return out;
}

describe('placeTableDecor', () => {
  const list = seeds(1000);
  const tables = tablesOf(list);

  it('replays exactly from the seed', () => {
    for (const seed of list.slice(0, 50)) {
      const ids = generateFloor(seed).rooms.map((r) => r.templateId);
      expect(placeTableDecor(seed, ids)).toEqual(placeTableDecor(seed, ids));
    }
  });

  it('gives every table 0 to 3 distinct props, and every count occurs', () => {
    const counts = new Set<number>();
    for (const t of tables) {
      expect(t.props.length).toBeLessThanOrEqual(3);
      expect(new Set(t.props.map((p) => p.kind)).size).toBe(t.props.length);
      counts.add(t.props.length);
    }
    expect([...counts].sort()).toEqual([0, 1, 2, 3]);
  });

  it('dresses only rooms that have a table', () => {
    for (const seed of list.slice(0, 200)) {
      const ids = generateFloor(seed).rooms.map((r) => r.templateId);
      for (const p of placeTableDecor(seed, ids))
        expect(DECOR_TABLES[ids[p.room] as string]?.some((t) => t.id === p.table)).toBe(true);
    }
  });

  it('keeps every prop on its table top, inside the margin, upright on the surface', () => {
    for (const { seed, room, table, props } of tables) {
      const ids = generateFloor(seed).rooms.map((r) => r.templateId);
      const t = DECOR_TABLES[ids[room] as string]?.find((c) => c.id === table);
      if (!t) throw new Error('table missing');
      for (const p of props) {
        const r = DECOR_RADIUS[p.kind];
        expect(Math.abs(p.x - t.x) + r).toBeLessThanOrEqual(t.halfX - t.margin + 1e-9);
        expect(Math.abs(p.z - t.z) + r).toBeLessThanOrEqual(t.halfZ - t.margin + 1e-9);
        expect(p.y).toBe(t.top);
        expect(p.yaw).toBeGreaterThanOrEqual(0);
        expect(p.yaw).toBeLessThan(Math.PI * 2);
      }
    }
  }, 30000);

  it('never overlaps two props on one table', () => {
    for (const { props } of tables) {
      for (let i = 0; i < props.length; i++)
        for (let j = i + 1; j < props.length; j++) {
          const a = props[i] as DecorPlacement;
          const b = props[j] as DecorPlacement;
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(
            DECOR_RADIUS[a.kind] + DECOR_RADIUS[b.kind] + DECOR_GAP - 1e-9,
          );
        }
    }
  });

  it('varies props per table: kinds, spots and yaw all spread', () => {
    const dressed = tables.filter((t) => t.props.length > 0);
    const kindsSeen = new Set(dressed.flatMap((t) => t.props.map((p) => p.kind)));
    expect([...kindsSeen].sort()).toEqual([...DECOR_KINDS].sort());
    const yaws = dressed.flatMap((t) => t.props.map((p) => p.yaw));
    expect(Math.max(...yaws) - Math.min(...yaws)).toBeGreaterThan(5);
    const layouts = new Set(dressed.map((t) => JSON.stringify(t.props.map((p) => [p.kind, p.x]))));
    expect(layouts.size).toBeGreaterThan(dressed.length * 0.9);
    // Two tables of one floor are dressed independently: same-room benches differ.
    const pairs = new Map<string, string[]>();
    for (const t of tables) {
      const key = `${t.seed}:${t.room}`;
      pairs.set(key, [...(pairs.get(key) ?? []), JSON.stringify(t.props)]);
    }
    const twins = [...pairs.values()].filter((v) => v.length === 2);
    expect(twins.filter(([a, b]) => a === b && a !== '[]').length).toBe(0);
  });

  it('leaves the floor plan untouched (the keyed stream is not a RunRng stream)', () => {
    const before = JSON.stringify(generateFloor('SPIRE002'));
    placeTableDecor('SPIRE002', ['hall', 'gear-shaft']);
    expect(JSON.stringify(generateFloor('SPIRE002'))).toBe(before);
  });
});

describe('DECOR_TABLES against the shipped room manifests', () => {
  for (const [id, list] of Object.entries(DECOR_TABLES)) {
    it(`${id}: every table top sits on a low collider of the baked room`, () => {
      const manifest = JSON.parse(
        readFileSync(join('public/assets/rooms', id, `${id}.manifest.json`), 'utf8'),
      ) as { colliders: { min: number[]; max: number[] }[] };
      for (const t of list) {
        const under = manifest.colliders.find(
          (c) =>
            (c.max[1] as number) < 1.5 &&
            (c.min[0] as number) <= t.x - t.halfX + 0.02 &&
            (c.max[0] as number) >= t.x + t.halfX - 0.02 &&
            (c.min[2] as number) <= t.z - t.halfZ + 0.02 &&
            (c.max[2] as number) >= t.z + t.halfZ - 0.02,
        );
        expect(under, `${id}/${t.id} has no collider under it`).toBeDefined();
        expect(Math.abs((under?.max[1] as number) - t.top)).toBeLessThanOrEqual(0.015);
      }
    });
  }
});
