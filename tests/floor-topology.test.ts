import { describe, expect, it } from 'vitest';
import { type FloorPlan, generateFloor, worldRooms } from '../src/floor/generate.ts';
import { attachFloorOneTopology } from '../src/floor/return-passages.ts';

function reachable(plan: FloorPlan): Set<number> {
  const links = new Map<number, number[]>();
  for (const [a, b] of plan.connections) {
    links.set(a.room, [...(links.get(a.room) ?? []), b.room]);
    links.set(b.room, [...(links.get(b.room) ?? []), a.room]);
  }
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length)
    for (const room of links.get(queue.shift() as number) ?? []) {
      if (!seen.has(room)) {
        seen.add(room);
        queue.push(room);
      }
    }
  return seen;
}

function distance(plan: FloorPlan, from: number, to: number, omit?: string): number {
  const edges = new Map<number, number[]>();
  for (const edge of plan.connections) {
    if (edge.puzzleGate === omit) continue;
    edges.set(edge[0].room, [...(edges.get(edge[0].room) ?? []), edge[1].room]);
    edges.set(edge[1].room, [...(edges.get(edge[1].room) ?? []), edge[0].room]);
  }
  const queue = [[from, 0]];
  const seen = new Set([from]);
  while (queue.length) {
    const [room, steps] = queue.shift()!;
    if (room === to) return steps;
    for (const next of edges.get(room) ?? [])
      if (!seen.has(next)) {
        seen.add(next);
        queue.push([next, steps + 1]);
      }
  }
  return Infinity;
}

describe('floor-one puzzle topology', () => {
  it('keeps MAPTEST2 deterministic with both independent gates', () => {
    const first = attachFloorOneTopology(generateFloor('MAPTEST2'));
    expect(first).toEqual(attachFloorOneTopology(generateFloor('MAPTEST2')));
    expect(reachable(first).size).toBe(first.rooms.length);
    expect(first.connections.some((edge) => edge.puzzleGate === 'pressure')).toBe(true);
    expect(first.connections.some((edge) => edge.puzzleGate === 'counterweight')).toBe(true);
  });

  it('keeps reward routes and closed pressure vaults valid across representative seeds', () => {
    const seeds = [
      'MAPTEST2',
      'MAPTEST3',
      ...Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(8, '0').toUpperCase()),
    ];
    for (const seed of seeds) {
      const plan = attachFloorOneTopology(generateFloor(seed));
      const shortcut = plan.connections.find((edge) => edge.puzzleGate === 'counterweight');
      const pressure = plan.connections.find((edge) => edge.puzzleGate === 'pressure');
      expect(shortcut).toBeTruthy();
      expect(pressure).toBeTruthy();
      expect(
        distance(plan, shortcut![0].room, shortcut![1].room, 'counterweight'),
      ).toBeGreaterThanOrEqual(2);
      expect(distance(plan, shortcut![0].room, shortcut![1].room)).toBe(1);
      expect(distance(plan, 0, pressure![1].room, 'pressure')).toBe(Infinity);
      expect(reachable(plan).size).toBe(plan.rooms.length);
    }
  });

  it('keeps every generated connection physically paired', () => {
    const plan = attachFloorOneTopology(generateFloor('20000000'));
    expect(reachable(plan).size).toBe(plan.rooms.length);
    const world = worldRooms(plan);
    for (const [a, b] of plan.connections) {
      const da = world[a.room]?.doors.find((door) => door.id === a.door);
      const db = world[b.room]?.doors.find((door) => door.id === b.door);
      expect(da?.world).toEqual(db?.world);
      const opposite = { N: 'S', S: 'N', E: 'W', W: 'E' } as const;
      expect(db?.facing).toBe(opposite[da?.facing ?? 'N']);
    }
  });
});
