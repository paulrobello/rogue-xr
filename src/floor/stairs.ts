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
  /** Reserved alcove footprint, including the recess behind the door. */
  readonly alcove: Rect;
}

/** Runtime dimensions measured from scripts/assets/build-stairwell.py and report.json. */
export const STAIR_THRESHOLD_DEPTH = 0.91;
export const STAIR_TREAD_PITCH = 0.34;
export const STAIR_TREAD_COUNT = 9;
export const STAIR_TREAD_RISE = 0.18;
export const STAIR_TOTAL_RISE = STAIR_TREAD_COUNT * STAIR_TREAD_RISE;
export const STAIR_FLIGHT_END = STAIR_THRESHOLD_DEPTH + STAIR_TREAD_COUNT * STAIR_TREAD_PITCH;
export const STAIR_LANDING_END = 4.95;
export const STAIR_WIDTH = 3;
export const STAIR_HALF_WIDTH = 0.98;
/** Keep the seated player's controller on the near side of the pull at full forward travel. */
export const STAIR_DOOR_BARRIER = 4.54;

export interface StairLocalPoint {
  readonly across: number;
  readonly depth: number;
}

/** Converts a world X/Z point into the entry's measured stairwell frame. */
export function stairLocalPoint(entry: StairEntry, x: number, z: number): StairLocalPoint {
  const dx = x - entry.world[0];
  const dz = z - entry.world[1];
  return {
    across: dx * entry.facing[1] - dz * entry.facing[0],
    depth: dx * entry.facing[0] + dz * entry.facing[1],
  };
}

export function stairHeightAtDepth(depth: number, direction: 1 | -1): number {
  const progress = Math.max(
    0,
    Math.min(1, (depth - STAIR_THRESHOLD_DEPTH) / (STAIR_FLIGHT_END - STAIR_THRESHOLD_DEPTH)),
  );
  return direction * STAIR_TOTAL_RISE * progress;
}

/** Discrete top surface used by teleport landings. Walking keeps the smooth support profile. */
export function stairTreadHeightAtDepth(depth: number, direction: 1 | -1): number | null {
  if (depth < 0 || depth > STAIR_LANDING_END) return null;
  const front = STAIR_THRESHOLD_DEPTH;
  if (depth < front) return 0;
  const tread = Math.min(STAIR_TREAD_COUNT, 1 + Math.floor((depth - front) / STAIR_TREAD_PITCH));
  return direction * tread * STAIR_TREAD_RISE;
}

/** World-space discrete tread/landing top, or null outside the open stairwell. */
export function stairTeleportHeight(
  entry: StairEntry,
  x: number,
  z: number,
  direction: 1 | -1,
): number | null {
  const point = stairLocalPoint(entry, x, z);
  if (Math.abs(point.across) > STAIR_HALF_WIDTH) return null;
  return stairTreadHeightAtDepth(point.depth, direction);
}

/** Smooth signed support height for a player inside the stair enclosure. */
export function stairGroundHeight(
  entry: StairEntry,
  x: number,
  z: number,
  direction: 1 | -1 = 1,
): number | null {
  const point = stairLocalPoint(entry, x, z);
  // A tracked head can lean beyond the rails even when virtual movement is constrained.
  if (
    Math.abs(point.across) > STAIR_WIDTH / 2 ||
    point.depth < 0 ||
    point.depth > STAIR_LANDING_END
  )
    return null;
  return stairHeightAtDepth(point.depth, direction);
}

const ALCOVE_DEPTH = 6.14;
const OUTWARD: Record<Facing, readonly [number, number]> = {
  N: [0, -1],
  S: [0, 1],
  E: [1, 0],
  W: [-1, 0],
};

function alcoveFor(room: number, door: WorldRoom['doors'][number]): StairEntry {
  const outward = OUTWARD[door.facing];
  const [x, z] = door.world;
  const half = STAIR_WIDTH / 2;
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
