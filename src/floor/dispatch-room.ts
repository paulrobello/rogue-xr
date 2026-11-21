import { Stream } from '../core/rng.ts';
import type { FloorPlan } from './generate.ts';
import { attachRoom } from './return-passages.ts';
import { placeStairEntry } from './stairs.ts';

/** Adds the optional dispatch vault without changing existing room or connection indices. */
export function attachDispatchRoom(base: FloorPlan): FloorPlan {
  if (base.dispatchRoom) return base;
  const reachable = new Set<number>([0]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of base.connections) {
      if (edge.puzzleGate) continue;
      const [a, b] = edge;
      if (reachable.has(a.room) && !reachable.has(b.room)) {
        reachable.add(b.room);
        changed = true;
      }
      if (reachable.has(b.room) && !reachable.has(a.room)) {
        reachable.add(a.room);
        changed = true;
      }
    }
  }
  const stream = Stream.fromKey(`${base.seed}:dispatch-room`);
  const stair = placeStairEntry(base);
  const sources = stream.shuffle(
    base.sealed.filter((door) => {
      const room = base.rooms[door.room];
      return (
        room !== undefined &&
        reachable.has(door.room) &&
        door.room !== 0 &&
        door.room !== base.guardianRoom &&
        !(door.room === stair?.room && door.door === stair.door) &&
        door.room !== base.pressureWing?.gallery &&
        door.room !== base.pressureWing?.pumpRoom
      );
    }),
  );
  const quietSources = sources.filter((door) => base.rooms[door.room]?.role !== 'combat');
  const orderedSources = [
    ...quietSources,
    ...sources.filter((door) => !quietSources.includes(door)),
  ];
  const replies = base.rooms
    .filter(
      (room) =>
        reachable.has(room.index) &&
        room.index !== 0 &&
        room.index !== base.guardianRoom &&
        room.role !== 'combat' &&
        room.index !== base.pressureWing?.gallery &&
        room.index !== base.pressureWing?.pumpRoom,
    )
    .sort((a, b) => a.depth - b.depth || a.index - b.index);
  for (const source of orderedSources) {
    const replyRoom = replies.find((room) => room.index !== source.room)?.index;
    if (replyRoom === undefined) continue;
    for (const turns of stream.shuffle([0, 1, 2, 3] as const)) {
      const extended = attachRoom(base, source, turns, 'treasure', 'dispatch', stair);
      if (extended) {
        return {
          ...extended,
          dispatchRoom: {
            source: { room: source.room, door: source.door },
            replyRoom,
            vaultRoom: base.rooms.length,
          },
        };
      }
    }
  }
  return base;
}
