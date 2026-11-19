import { type Facing, GREYBOX_TEMPLATES, type Rect, type RoomTemplate } from '../content/rooms.ts';
import { type FloorPlan, rectsOverlap, type WorldRoom, worldRooms } from './generate.ts';

export interface StairEntry {
  /** Reachable host room containing the open doorway. */
  readonly room: number;
  /** Sealed doorway opened for the stair landing. */
  readonly door: string;
  /** Door centre in world x/z coordinates. */
  readonly world: readonly [number, number];
  /** Unit vector from the room towards the stair alcove. */
  readonly facing: readonly [number, number];
  /** Safe point just inside the doorway for a seated player approach. */
  readonly approach: readonly [number, number];
  /** The 3 m wide by 5 m deep outside alcove. */
  readonly alcove: Rect;
}

const ALCOVE_WIDTH = 3;
const ALCOVE_DEPTH = 5;
const OUTWARD: Record<Facing, readonly [number, number]> = {
  N: [0, -1],
  S: [0, 1],
  E: [1, 0],
  W: [-1, 0],
};

function alcoveFor(room: number, door: WorldRoom['doors'][number]): StairEntry {
  const outward = OUTWARD[door.facing];
  const [x, z] = door.world;
  const half = ALCOVE_WIDTH / 2;
  const alcove: Rect =
    door.facing === 'N' || door.facing === 'S'
      ? {
          min: [x - half, outward[1] < 0 ? z - ALCOVE_DEPTH : z],
          max: [x + half, outward[1] < 0 ? z : z + ALCOVE_DEPTH],
        }
      : {
          min: [outward[0] < 0 ? x - ALCOVE_DEPTH : x, z - half],
          max: [outward[0] < 0 ? x : x + ALCOVE_DEPTH, z + half],
        };
  return {
    room,
    door: door.id,
    world: [x, z],
    facing: outward,
    approach: [x - outward[0] * 0.8, z - outward[1] * 0.8],
    alcove,
  };
}

/** All placed rooms are connected. Prefer an encounter-free landing near the entry; only
 * use a busier room when there is no clear outside space at a quieter doorway. */
export function placeStairEntry(
  plan: FloorPlan,
  templates: readonly RoomTemplate[] = GREYBOX_TEMPLATES,
): StairEntry | null {
  const rooms = worldRooms(plan, templates);
  const rank = (i: number) =>
    Number(Boolean(plan.rooms[i].encounter)) * 2 + Number(plan.rooms[i].loot.length > 0);
  const ordered = [...plan.sealed].sort(
    (a, b) =>
      rank(a.room) - rank(b.room) ||
      plan.rooms[a.room].depth - plan.rooms[b.room].depth ||
      a.room - b.room ||
      a.door.localeCompare(b.door),
  );
  for (const seal of ordered) {
    if (seal.room === plan.pressureWing?.pumpRoom || seal.room === plan.pressureWing?.gallery)
      continue;
    const door = rooms[seal.room]?.doors.find((d) => d.id === seal.door);
    if (!door) continue;
    const entry = alcoveFor(seal.room, door);
    if (!rooms.some((r) => rectsOverlap(r.footprint, entry.alcove))) return entry;
  }
  return null;
}
