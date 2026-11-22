import { Stream } from '../core/rng.ts';
import type { DoorRef, FloorPlan } from './generate.ts';
import { attachRoom } from './return-passages.ts';
import { placeStairEntry } from './stairs.ts';

function reachable(plan: FloorPlan): ReadonlySet<number> {
  const seen = new Set([0]);
  for (const room of seen) {
    for (const edge of plan.connections) {
      if (edge.puzzleGate) continue;
      if (edge[0].room === room) seen.add(edge[1].room);
      if (edge[1].room === room) seen.add(edge[0].room);
    }
  }
  return seen;
}

const same = (a: DoorRef, b: DoorRef): boolean => a.room === b.room && a.door === b.door;

/** Adds the deterministic Drum Gallery and its gated treasure recess to a Conservatory plan. */
export function attachDrumGallery(
  base: FloorPlan,
  canPlace: (candidate: FloorPlan) => boolean,
): FloorPlan {
  if (base.drumGallery) return base;
  const stair = placeStairEntry(base);
  const seen = reachable(base);
  const reserved = new Set([
    0,
    base.guardianRoom,
    base.prismAnnex?.source.room,
    base.prismAnnex?.annexRoom,
    base.pendulumGallery?.source.room,
    base.pendulumGallery?.galleryRoom,
    base.borrowedLight?.opticsRoom,
    base.borrowedLight?.recessRoom,
  ]);
  const stream = Stream.fromKey(`${base.seed}:drum-gallery:layout`);
  const sources = stream.shuffle(
    base.sealed.filter(
      (source) =>
        seen.has(source.room) &&
        !reserved.has(source.room) &&
        (!stair || !same(source, stair)) &&
        !base.connections.some(
          (edge) =>
            edge.puzzleGate && (edge[0].room === source.room || edge[1].room === source.room),
        ),
    ),
  );
  for (const source of sources) {
    for (const template of stream.shuffle(['hall', 'study'] as const)) {
      for (const turns of stream.shuffle([0, 1, 2, 3] as const)) {
        const galleryPlan = attachRoom(base, source, turns, 'corridor', undefined, stair, template);
        if (!galleryPlan) continue;
        const gallery = base.rooms.length;
        for (const exit of stream.shuffle(
          galleryPlan.sealed.filter((door) => door.room === gallery),
        )) {
          for (const recessTurns of stream.shuffle([0, 1, 2, 3] as const)) {
            const recessPlan = attachRoom(
              galleryPlan,
              exit,
              recessTurns,
              'treasure',
              'drum-gallery',
              stair,
              'study',
            );
            if (!recessPlan) continue;
            const candidate = {
              ...recessPlan,
              drumGallery: {
                gallery,
                recess: gallery + 1,
                gate: { room: gallery, door: exit.door },
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
