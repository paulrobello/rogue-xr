import { Stream } from '../core/rng.ts';
import type { FloorPlan } from './generate.ts';
import { attachRoom } from './return-passages.ts';
import { placeStairEntry } from './stairs.ts';

/** Append both parts of the Upper Works workshop without changing its existing route. */
export function attachSpringTension(
  base: FloorPlan,
  canPlace: (candidate: FloorPlan) => boolean,
): FloorPlan {
  if (base.springTension) return base;
  const stair = placeStairEntry(base);
  const reachable = new Set([0]);
  for (const room of reachable) {
    for (const edge of base.connections) {
      if (edge.puzzleGate) continue;
      if (edge[0].room === room) reachable.add(edge[1].room);
      if (edge[1].room === room) reachable.add(edge[0].room);
    }
  }
  const occupied = new Set([base.guardianRoom, base.armoryAlcove?.room]);
  const topology = Stream.fromKey(`${base.seed}:spring-tension:topology`);
  const sources = topology.shuffle(
    base.sealed.filter(
      (source) =>
        reachable.has(source.room) &&
        !occupied.has(source.room) &&
        (source.room !== stair?.room || source.door !== stair.door),
    ),
  );
  for (const source of sources) {
    for (const template of ['study', 'hall']) {
      for (const turn of topology.shuffle([0, 1, 2, 3] as const)) {
        const wing = attachRoom(base, source, turn, 'corridor', undefined, stair, template);
        if (!wing) continue;
        const workshop = base.rooms.length;
        for (const exit of topology.shuffle(wing.sealed.filter((door) => door.room === workshop))) {
          for (const studyTurn of topology.shuffle([0, 1, 2, 3] as const)) {
            const next = attachRoom(
              wing,
              exit,
              studyTurn,
              'treasure',
              'spring-tension',
              stair,
              'study',
            );
            if (!next) continue;
            const candidate = {
              ...next,
              springTension: {
                workshop,
                recess: workshop + 1,
                gate: { room: workshop, door: exit.door },
              },
            };
            if (canPlace(candidate)) return candidate;
          }
        }
      }
    }
  }
  return base;
}
