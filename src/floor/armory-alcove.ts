import { Stream } from '../core/rng.ts';
import type { FloorPlan } from './generate.ts';
import { attachRoom } from './return-passages.ts';
import { placeStairEntry } from './stairs.ts';

/** Appends an open side room while leaving the old paths, stair and reward sites in place. */
export function attachArmoryAlcove(base: FloorPlan): FloorPlan {
  if (base.armoryAlcove) return base;
  const reached = new Set([0]);
  const paths = base.connections.filter((edge) => !edge.puzzleGate);
  for (const room of reached) {
    for (const [a, b] of paths) {
      if (a.room === room) reached.add(b.room);
      if (b.room === room) reached.add(a.room);
    }
  }
  const stair = placeStairEntry(base);
  const stream = Stream.fromKey(`${base.seed}:armory-alcove`);
  const wakes = stream.int(0, 2) !== 0;
  const sources = stream.shuffle(
    base.sealed.filter(
      (door) =>
        reached.has(door.room) &&
        door.room !== base.guardianRoom &&
        (door.room !== stair?.room || door.door !== stair.door),
    ),
  );
  for (const source of sources) {
    for (const turn of stream.shuffle([0, 1, 2, 3] as const)) {
      const extended = attachRoom(base, source, turn, 'treasure', undefined, stair);
      if (!extended) continue;
      const index = base.rooms.length;
      const room = {
        ...extended.rooms[index],
        encounter: wakes ? { tier: 'regular' as const, socketIds: ['enemy-a'] } : null,
        loot: wakes
          ? []
          : extended.rooms[index].loot.map(({ socketId }) => ({ socketId, kind: 'cogs' as const })),
      };
      return {
        ...extended,
        rooms: [...base.rooms, room],
        armoryAlcove: { room: index },
      };
    }
  }
  return base;
}
