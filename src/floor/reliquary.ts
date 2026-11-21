import { Stream } from '../core/rng.ts';
import type { DoorRef, FloorPlan } from './generate.ts';
import { attachRoom } from './return-passages.ts';
import { placeStairEntry } from './stairs.ts';

function reachable(plan: FloorPlan): Set<number> {
  const seen = new Set([0]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of plan.connections) {
      if (edge.puzzleGate) continue;
      const [a, b] = edge;
      if (seen.has(a.room) && !seen.has(b.room)) {
        seen.add(b.room);
        changed = true;
      }
      if (seen.has(b.room) && !seen.has(a.room)) {
        seen.add(a.room);
        changed = true;
      }
    }
  }
  return seen;
}

const same = (a: DoorRef, b: DoorRef) => a.room === b.room && a.door === b.door;

/** Appends one optional Reliquary coffer room while preserving all prior indices. */
export function attachReliquary(base: FloorPlan): FloorPlan {
  if (base.reliquary) return base;
  const seen = reachable(base);
  const stair = placeStairEntry(base);
  const stream = Stream.fromKey(`${base.seed}:stone-reliquary`);
  const occupied = new Set([
    base.guardianRoom,
    base.pressureWing?.gallery,
    base.pressureWing?.pumpRoom,
    base.dispatchRoom?.replyRoom,
    base.dispatchRoom?.vaultRoom,
    base.speakingPipes?.receiverRoom,
  ]);
  const sources = stream
    .shuffle(
      base.sealed.filter(
        (door) => seen.has(door.room) && !occupied.has(door.room) && (!stair || !same(door, stair)),
      ),
    )
    .sort((a, b) => Number(a.room === 0) - Number(b.room === 0));
  const clues = stream
    .shuffle(
      base.rooms.filter(
        (room) =>
          seen.has(room.index) &&
          (!occupied.has(room.index) || room.index === 0) &&
          !room.encounter,
      ),
    )
    .sort((a, b) => Number(a.index === 0) - Number(b.index === 0));
  for (const source of sources) {
    const clueRoom = clues.find((room) => room.index !== source.room)?.index;
    if (clueRoom === undefined) continue;
    const turns = stream.shuffle([0, 1, 2, 3] as const);
    for (const template of ['hall', 'study']) {
      for (const turn of turns) {
        const extended = attachRoom(base, source, turn, 'treasure', 'reliquary', stair, template);
        if (!extended) continue;
        return {
          ...extended,
          reliquary: {
            source: { room: source.room, door: source.door },
            clueRoom,
            reliquaryRoom: base.rooms.length,
          },
        };
      }
    }
  }
  return base;
}
