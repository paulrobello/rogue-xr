import { Stream } from '../core/rng.ts';
import { type DoorRef, type FloorPlan, SHOWCASE_UPPER_SEED } from './generate.ts';
import { attachRoom } from './return-passages.ts';
import { placeStairEntry } from './stairs.ts';

/** Only spare outward sockets can host a recess. The public staircase always keeps its alcove. */
export function attachHiddenPassage(base: FloorPlan): FloorPlan {
  if (base.hiddenPassage) return base;
  const stream = Stream.fromKey(base.seed + ':hollow-service-wall');
  if (base.seed !== SHOWCASE_UPPER_SEED && stream.int(0, 2) === 0) return base;
  const stair = placeStairEntry(base);
  const same = (a: DoorRef, b: DoorRef) => a.room === b.room && a.door === b.door;
  const candidates = stream.shuffle(
    base.sealed.filter((s) => {
      const room = base.rooms[s.room];
      return (
        s.room !== base.guardianRoom &&
        (room.templateId === 'hall' || room.templateId === 'study') &&
        (!stair || !same(stair, s))
      );
    }),
  );
  for (const source of candidates) {
    for (const turns of stream.shuffle([0, 1, 2, 3] as const)) {
      const extended = attachRoom(base, source, turns, 'treasure', 'panel', stair, 'study');
      if (!extended) continue;
      const decoys: DoorRef[] = [];
      for (const other of candidates) {
        if (other.room === source.room || decoys.some((d) => d.room === other.room)) continue;
        decoys.push({ room: other.room, door: other.door });
        if (decoys.length === 2) break;
      }
      return {
        ...extended,
        hiddenPassage: {
          source: { room: source.room, door: source.door },
          decoys,
          treasureRoom: base.rooms.length,
        },
      };
    }
  }
  return base;
}
