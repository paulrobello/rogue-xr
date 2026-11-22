import { Stream } from '../core/rng.ts';
import type { FloorPlan } from './generate.ts';
import { attachRoom } from './return-passages.ts';
import { placeStairEntry } from './stairs.ts';

/** Adds the Lower Works reservoir as a stable, open treasure hall. */
export function attachFloatElevator(
  base: FloorPlan,
  canPlace: (candidate: FloorPlan) => boolean,
): FloorPlan {
  if (base.floatElevator) return base;
  const stair = placeStairEntry(base);
  const stream = Stream.fromKey(`${base.seed}:float-elevator`);
  const reachable = new Set<number>([0]);
  for (const room of reachable) {
    for (const edge of base.connections) {
      if (edge.puzzleGate) continue;
      if (edge[0].room === room) reachable.add(edge[1].room);
      if (edge[1].room === room) reachable.add(edge[0].room);
    }
  }
  const sources = stream.shuffle(
    base.sealed.filter(
      (door) =>
        reachable.has(door.room) &&
        door.room !== base.guardianRoom &&
        (!stair || door.room !== stair.room || door.door !== stair.door),
    ),
  );
  for (const source of sources) {
    for (const turns of stream.shuffle([0, 1, 2, 3] as const)) {
      const next = attachRoom(base, source, turns, 'treasure', undefined, stair);
      if (!next) continue;
      const room = next.rooms.length - 1;
      const candidate = { ...next, floatElevator: { room } };
      if (canPlace(candidate)) return candidate;
    }
  }
  return base;
}
