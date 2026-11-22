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

const same = (a: DoorRef, b: DoorRef): boolean => a.room === b.room && a.door === b.door;

/** Adds the v20 optics room and its gated reward recess without mutating the old topology. */
export function attachBorrowedLight(base: FloorPlan): FloorPlan {
  if (base.borrowedLight) return base;
  const seen = reachable(base);
  const stair = placeStairEntry(base);
  const occupied = new Set([
    base.guardianRoom,
    base.pressureWing?.gallery,
    base.pressureWing?.pumpRoom,
    base.dispatchRoom?.replyRoom,
    base.dispatchRoom?.vaultRoom,
    base.speakingPipes?.receiverRoom,
    base.reliquary?.reliquaryRoom,
    base.valvehouse?.valvehouseRoom,
    base.pendulumGallery?.galleryRoom,
    base.armoryAlcove?.room,
  ]);
  const stream = Stream.fromKey(`${base.seed}:borrowed-light`);
  const sources = stream.shuffle(
    base.sealed.filter(
      (door) => seen.has(door.room) && !occupied.has(door.room) && (!stair || !same(door, stair)),
    ),
  );
  for (const source of sources) {
    for (const turns of stream.shuffle([0, 1, 2, 3] as const)) {
      const optics = attachRoom(
        base,
        { room: source.room, door: source.door },
        turns,
        'corridor',
        undefined,
        stair,
        'hall',
      );
      if (!optics) continue;
      const opticsRoom = base.rooms.length;
      const exits = optics.sealed.filter((door) => door.room === opticsRoom);
      for (const exit of stream.shuffle(exits)) {
        const recess = attachRoom(
          optics,
          { room: exit.room, door: exit.door },
          turns,
          'treasure',
          'borrowed-light',
          stair,
          'study',
        );
        if (!recess) continue;
        return {
          ...recess,
          borrowedLight: {
            opticsRoom,
            recessRoom: opticsRoom + 1,
            gate: { room: opticsRoom, door: exit.door },
          },
        };
      }
    }
  }
  return base;
}
