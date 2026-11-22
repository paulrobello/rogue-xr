import { Stream } from '../core/rng.ts';
import type { FloorPlan } from './generate.ts';
import { attachRoom } from './return-passages.ts';
import { placeStairEntry } from './stairs.ts';

/** Add an open Lower Works side room while keeping the established route and fixture reservations. */
export function attachShadowStencil(
  base: FloorPlan,
  canPlace: (candidate: FloorPlan) => boolean,
): FloorPlan {
  if (base.shadowStencil) return base;
  const stair = placeStairEntry(base);
  const stream = Stream.fromKey(`${base.seed}:shadow-stencil-layout`);
  const reachable = new Set([0]);
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
        door.room !== base.floatElevator?.room &&
        (door.room !== stair?.room || door.door !== stair.door),
    ),
  );
  for (const source of sources) {
    for (const turns of stream.shuffle([0, 1, 2, 3] as const)) {
      const next = attachRoom(base, source, turns, 'treasure', undefined, stair);
      if (!next) continue;
      const candidate: FloorPlan = { ...next, shadowStencil: { room: base.rooms.length } };
      if (canPlace(candidate)) return candidate;
    }
  }
  return base;
}
