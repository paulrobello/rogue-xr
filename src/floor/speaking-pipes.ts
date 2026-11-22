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

/** Adds the optional cistern bay without changing existing room or connection indices. */
export function attachSpeakingPipes(base: FloorPlan): FloorPlan {
  if (base.speakingPipes) return base;
  const seen = reachable(base);
  const stair = placeStairEntry(base);
  const same = (a: DoorRef, b: DoorRef) => a.room === b.room && a.door === b.door;
  const stream = Stream.fromKey(`${base.seed}:speaking-pipes`);
  const sources = stream.shuffle(
    base.sealed.filter((door) => {
      const room = base.rooms[door.room];
      return (
        room &&
        seen.has(door.room) &&
        door.room !== base.guardianRoom &&
        (!stair || !same(door, stair)) &&
        door.room !== base.pressureWing?.gallery &&
        door.room !== base.pressureWing?.pumpRoom &&
        door.room !== base.dispatchRoom?.vaultRoom
      );
    }),
  );
  const receivers = base.rooms.filter(
    (room) =>
      seen.has(room.index) &&
      room.index !== base.guardianRoom &&
      room.role !== 'combat' &&
      room.index !== base.pressureWing?.gallery &&
      room.index !== base.pressureWing?.pumpRoom &&
      room.index !== base.dispatchRoom?.replyRoom &&
      room.index !== base.dispatchRoom?.vaultRoom &&
      room.index !== base.dispatchRoom?.source.room,
  );
  for (const source of sources) {
    for (const receiver of receivers) {
      if (receiver.index === source.room) continue;
      for (const turns of stream.shuffle([0, 1, 2, 3] as const)) {
        const extended = attachRoom(base, source, turns, 'treasure', 'cistern', stair);
        if (extended)
          return {
            ...extended,
            speakingPipes: {
              source: { room: source.room, door: source.door },
              receiverRoom: receiver.index,
              cisternRoom: base.rooms.length,
            },
          };
      }
    }
  }
  return base;
}
