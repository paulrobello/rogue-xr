import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashString, Stream } from '../src/core/rng.ts';
import {
  attachPressureWing,
  type FloorPlan,
  generateFloor,
  guardedConnection,
  rectsOverlap,
  worldRooms,
} from '../src/floor/generate.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function seeds(count: number): string[] {
  const stream = Stream.fromKey('floor-property-test');
  return Array.from({ length: count }, () =>
    Array.from({ length: 8 }, () => CROCKFORD[stream.int(0, 31)]).join(''),
  );
}

function reachable(plan: FloorPlan): Set<number> {
  const adjacent = new Map<number, number[]>();
  for (const [a, b] of plan.connections) {
    adjacent.set(a.room, [...(adjacent.get(a.room) ?? []), b.room]);
    adjacent.set(b.room, [...(adjacent.get(b.room) ?? []), a.room]);
  }
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length > 0) {
    for (const next of adjacent.get(queue.shift() as number) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe('generateFloor over 1,000 seeds', () => {
  const plans = seeds(1000).map((seed) => generateFloor(seed));

  it('reaches every room from the entry', () => {
    for (const plan of plans) expect(reachable(plan).size).toBe(plan.rooms.length);
  });

  it('has 6 to 8 rooms, 2 to 3 wings and exactly one guardian vault at the deepest point', () => {
    for (const plan of plans) {
      expect(plan.rooms.length).toBeGreaterThanOrEqual(6);
      expect(plan.rooms.length).toBeLessThanOrEqual(8);
      const wings = new Set(plan.rooms.filter((r) => r.wing >= 0).map((r) => r.wing));
      expect(wings.size).toBeGreaterThanOrEqual(2);
      expect(wings.size).toBeLessThanOrEqual(3);
      const guardians = plan.rooms.filter((r) => r.role === 'guardian');
      expect(guardians).toHaveLength(1);
      expect(guardians[0]?.index).toBe(plan.guardianRoom);
      const deepest = Math.max(...plan.rooms.map((r) => r.depth));
      expect(plan.rooms[plan.guardianRoom]?.depth).toBe(deepest);
      expect(plan.rooms[0]?.role).toBe('entry');
    }
  });

  it('places no two room footprints over each other', () => {
    for (const plan of plans) {
      const world = worldRooms(plan);
      for (let i = 0; i < world.length; i++) {
        for (let j = i + 1; j < world.length; j++) {
          expect(
            rectsOverlap(
              (world[i] as (typeof world)[0]).footprint,
              (world[j] as (typeof world)[0]).footprint,
            ),
          ).toBe(false);
        }
      }
    }
  });

  it('pairs every door with an opposite door at the same spot, or seals it', () => {
    for (const plan of plans) {
      const world = worldRooms(plan);
      const accounted = new Set<string>();
      for (const [a, b] of plan.connections) {
        const da = world[a.room]?.doors.find((d) => d.id === a.door);
        const db = world[b.room]?.doors.find((d) => d.id === b.door);
        expect(da && db).toBeTruthy();
        expect(da?.world).toEqual(db?.world);
        const opposite = { N: 'S', S: 'N', E: 'W', W: 'E' } as const;
        expect(db?.facing).toBe(opposite[da?.facing ?? 'N']);
        accounted.add(`${a.room}:${a.door}`).add(`${b.room}:${b.door}`);
      }
      for (const s of plan.sealed) accounted.add(`${s.room}:${s.door}`);
      const doorCount = world.reduce((n, r) => n + r.doors.length, 0);
      expect(accounted.size).toBe(doorCount);
      expect(plan.connections.length * 2 + plan.sealed.length).toBe(doorCount);
    }
  });

  it('gives the guardian vault its encounter and keeps the entry calm', () => {
    for (const plan of plans) {
      expect(plan.rooms[plan.guardianRoom]?.encounter?.tier).toBe('guardian');
      expect(plan.rooms[0]?.encounter).toBeNull();
      expect(plan.rooms.filter((r) => r.encounter?.tier === 'elite').length).toBeLessThanOrEqual(1);
      for (const r of plan.rooms) {
        if (r.encounter) expect(r.encounter.socketIds.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('determinism', () => {
  it('repeats exactly for a repeated seed and differs across seeds', () => {
    expect(generateFloor('SPIRE001')).toEqual(generateFloor('SPIRE001'));
    expect(JSON.stringify(generateFloor('SPIRE001'))).toBe(
      JSON.stringify(generateFloor('spire-001')),
    );
    expect(generateFloor('SPIRE001')).not.toEqual(generateFloor('SPIRE002'));
  });
});

describe('floor/ stays pure', () => {
  it('imports only floor/, content/rooms.ts and core/rng.ts', () => {
    const dir = join(process.cwd(), 'src/floor');
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const [, spec] of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const allowed =
          spec === '../content/rooms.ts' || spec === '../core/rng.ts' || spec?.startsWith('./');
        expect(allowed, `${file} imports ${spec}`).toBe(true);
      }
    }
  });
});

describe('sealed door styles', () => {
  it('closes dead ends with wall, boarding up at most one door per floor outside the entry', () => {
    let boardedFloors = 0;
    for (const seed of seeds(200)) {
      const plan = generateFloor(seed);
      const boarded = plan.sealed.filter((s) => s.style === 'boarded');
      expect(plan.sealed.every((s) => s.style === 'wall' || s.style === 'boarded')).toBe(true);
      expect(boarded.length).toBeLessThanOrEqual(1);
      expect(boarded.every((s) => s.room !== 0)).toBe(true);
      expect(generateFloor(seed).sealed).toEqual(plan.sealed);
      if (boarded.length === 1) boardedFloors += 1;
    }
    // BOARDED_DOOR_CHANCE is one half, so roughly half the floors board up one door.
    expect(boardedFloors).toBeGreaterThan(60);
    expect(boardedFloors).toBeLessThan(140);
  });

  it('keeps the layouts of existing seeds', () => {
    // Fingerprints of rooms, connections, sealed doors and guardian room from before door styles.
    const before: Record<string, number> = {
      SP1RE001: 3329191451,
      C1KW0RK2: 3967666655,
      BRASS777: 4256974880,
      '0000000A': 886306418,
      ZZZZZZZZ: 897884495,
    };
    for (const [seed, hash] of Object.entries(before)) {
      const p = generateFloor(seed);
      const key = JSON.stringify({
        rooms: p.rooms.map((room) => (room.role === 'combat' ? { ...room, loot: [] } : room)),
        connections: p.connections,
        sealed: p.sealed.map((s) => [s.room, s.door]),
        g: p.guardianRoom,
      });
      expect(hashString(key)).toBe(hash);
    }
  });
});

describe('optional pressure wing', () => {
  it('adds a reachable corridor and treasure study without changing the original floor', () => {
    let attached = 0;
    for (const seed of seeds(500)) {
      const original = generateFloor(seed);
      const plan = attachPressureWing(original);
      if (!plan.pressureWing) continue;
      attached += 1;
      const { gallery, pumpRoom, source } = plan.pressureWing;
      expect(gallery).toBe(original.rooms.length);
      expect(pumpRoom).toBe(gallery + 1);
      expect(plan.rooms.slice(0, original.rooms.length)).toEqual(original.rooms);
      expect(plan.connections.slice(0, original.connections.length)).toEqual(original.connections);
      expect(plan.rooms[gallery]?.role).toBe('corridor');
      expect(plan.rooms[pumpRoom]?.role).toBe('treasure');
      expect(plan.rooms[gallery]?.encounter).toBeNull();
      expect(plan.rooms[pumpRoom]?.encounter).toBeNull();
      expect(plan.rooms[gallery]?.loot).toEqual([]);
      expect(plan.rooms[pumpRoom]?.loot).toEqual([]);
      expect(plan.sealed.some((s) => s.room === source.room && s.door === source.door)).toBe(false);
      expect(guardedConnection(plan)).toEqual(guardedConnection(original));
      expect(reachable(plan).size).toBe(plan.rooms.length);
      const world = worldRooms(plan);
      for (let i = 0; i < world.length; i++) {
        for (let j = i + 1; j < world.length; j++) {
          expect(rectsOverlap(world[i]?.footprint, world[j]?.footprint)).toBe(false);
        }
      }
      for (const [a, b] of plan.connections.slice(original.connections.length)) {
        const exit = world[a.room].doors.find((d) => d.id === a.door);
        const entry = world[b.room].doors.find((d) => d.id === b.door);
        expect(exit).toBeDefined();
        expect(entry?.world).toEqual(exit?.world);
        expect(entry?.facing).not.toBe(exit?.facing);
      }
    }
    // Geometry is authored as a side-wing fit, so a high rate is expected while custom manifests
    // remain allowed to decline gracefully.
    expect(attached).toBeGreaterThan(450);
  });

  it('is deterministic and declines gracefully without both wing templates', () => {
    const original = generateFloor('SP1RE001');
    expect(attachPressureWing(original, [])).toBe(original);
    expect(attachPressureWing(original)).toEqual(attachPressureWing(original));
  });
});
