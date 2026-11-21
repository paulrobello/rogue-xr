import { Stream } from '../core/rng.ts';
import type { FloorPlan } from './generate.ts';
import { attachRoom } from './return-passages.ts';

function reachable(plan: FloorPlan): ReadonlySet<number> {
  const seen = new Set([0]);
  for (const room of seen)
    for (const edge of plan.connections) {
      if (edge.puzzleGate) continue;
      if (edge[0].room === room) seen.add(edge[1].room);
      if (edge[1].room === room) seen.add(edge[0].room);
    }
  return seen;
}

/** Adds the v16 Conservatory gallery without changing any existing indices. */
export function attachPendulumGallery(base: FloorPlan): FloorPlan {
  if (base.pendulumGallery) return base;
  const seen = reachable(base);
  const stream = Stream.fromKey(`${base.seed}:pendulum-gallery`);
  const sources = stream.shuffle(
    base.sealed.filter(
      (door) =>
        seen.has(door.room) &&
        door.room !== 0 &&
        door.room !== base.guardianRoom &&
        door.room !== base.pressureWing?.gallery &&
        door.room !== base.pressureWing?.pumpRoom &&
        door.room !== base.prismAnnex?.annexRoom,
    ),
  );
  for (const source of sources) {
    for (const turns of stream.shuffle([0, 1, 2, 3] as const)) {
      for (const template of ['study', 'hall'] as const) {
        const extended = attachRoom(
          base,
          source,
          turns,
          'treasure',
          'pendulum',
          undefined,
          template,
        );
        if (extended)
          return {
            ...extended,
            pendulumGallery: {
              source: { room: source.room, door: source.door },
              galleryRoom: base.rooms.length,
            },
          };
      }
    }
  }
  return base;
}
