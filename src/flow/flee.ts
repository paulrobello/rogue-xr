import type { FloorPlan, WorldRoom } from '../floor/generate.ts';

/** How far inside the room from its entry doorway a fleeing player is put, metres. */
export const FLEE_INSET = 1;

/**
 * Where a player who fled `room` stands: `inset` metres inside the room from the doorway they came
 * in by (the door the floor plan connects to the room's parent), on the line to the room's centre.
 * The entry room has no parent, so its first door stands in. Null for an unknown room; the room
 * centre for one without doors.
 */
export function fleeStandPoint(
  plan: Pick<FloorPlan, 'connections'>,
  rooms: readonly WorldRoom[],
  room: number,
  inset: number = FLEE_INSET,
): { x: number; z: number } | null {
  const r = rooms[room];
  if (!r) return null;
  const { min, max } = r.footprint;
  const cx = (min[0] + max[0]) / 2;
  const cz = (min[1] + max[1]) / 2;
  const entryId = plan.connections.find(([, own]) => own.room === room)?.[1].door;
  const door = (r.doors.find((d) => d.id === entryId) ?? r.doors[0])?.world;
  if (!door) return { x: cx, z: cz };
  const dx = cx - door[0];
  const dz = cz - door[1];
  const len = Math.hypot(dx, dz) || 1;
  const step = Math.min(inset, len);
  return { x: door[0] + (dx / len) * step, z: door[1] + (dz / len) * step };
}
