import { Stream } from '../core/rng.ts';
import type { FloorPlan } from './generate.ts';
import { attachRoom } from './return-passages.ts';

/** Adds one optional treasure hall without changing any existing room or connection index. */
export function attachPrismAnnex(base: FloorPlan): FloorPlan {
  if (base.prismAnnex) return base;
  const stream = Stream.fromKey(`${base.seed}:prism-annex`);
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
  const candidates = stream.shuffle(
    base.sealed.filter((door) => {
      const room = base.rooms[door.room];
      return (
        room !== undefined &&
        reachable.has(door.room) &&
        door.room !== base.guardianRoom &&
        door.room !== 0 &&
        door.room !== base.pressureWing?.gallery &&
        door.room !== base.pressureWing?.pumpRoom
      );
    }),
  );
  for (const source of candidates) {
    for (const turns of stream.shuffle([0, 1, 2, 3] as const)) {
      const extended = attachRoom(base, source, turns, 'treasure', 'prism');
      if (!extended) continue;
      const annexRoom = base.rooms.length;
      const clueCandidates = base.rooms
        .filter(
          (room) =>
            reachable.has(room.index) &&
            room.index !== source.room &&
            room.index !== base.guardianRoom,
        )
        .sort((a, b) => a.depth - b.depth || a.index - b.index);
      const clueRoom = clueCandidates[0]?.index;
      if (clueRoom === undefined || clueRoom === annexRoom) continue;
      return {
        ...extended,
        prismAnnex: { source: { room: source.room, door: source.door }, clueRoom, annexRoom },
      };
    }
  }
  return base;
}
