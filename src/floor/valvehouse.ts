import { Stream } from '../core/rng.ts';
import type { FloorPlan } from './generate.ts';
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

export function attachValvehouse(base: FloorPlan): FloorPlan {
  if (base.valvehouse) return base;
  const seen = reachable(base);
  const stair = placeStairEntry(base);
  const occupied = new Set([
    base.guardianRoom,
    base.pressureWing?.gallery,
    base.pressureWing?.pumpRoom,
    base.brassCache?.room,
  ]);
  const stream = Stream.fromKey(`${base.seed}:valvehouse`);
  const sources = stream.shuffle(
    base.sealed.filter(
      (door) =>
        seen.has(door.room) &&
        !occupied.has(door.room) &&
        !(stair && door.room === stair.room && door.door === stair.door),
    ),
  );
  const supply = stream
    .shuffle(base.rooms.filter((room) => seen.has(room.index) && !occupied.has(room.index)))
    .sort((a, b) => Number(!!a.encounter) - Number(!!b.encounter));
  for (const { room, door } of sources) {
    const source = { room, door };
    const supplyRoom = supply.find((room) => room.index !== source.room)?.index;
    if (supplyRoom === undefined) continue;
    const rotations = stream.shuffle([0, 1, 2, 3] as const);
    for (const template of ['study', 'hall']) {
      for (const turns of rotations) {
        const next = attachRoom(base, source, turns, 'treasure', 'valvehouse', stair, template);
        if (next)
          return {
            ...next,
            valvehouse: {
              source,
              supplyRoom,
              valvehouseRoom: base.rooms.length,
            },
          };
      }
    }
  }
  return base;
}
