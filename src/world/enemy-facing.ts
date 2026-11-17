import type { Rect } from '../content/rooms.ts';

/** An enemy closer than this to its entry doorway faces the room centre instead. */
const DOOR_NEAR_M = 1.5;
const RAD = Math.PI / 180;

/**
 * Compass heading in degrees (0 = north, -Z; clockwise from above) an idle enemy at floor point
 * `at` faces: toward the room's entry doorway, or the footprint centre when there is no entry
 * door (the entry hall) or the enemy stands right at the door. All points are world-space [x, z].
 */
export function enemyHeading(
  at: readonly [number, number],
  entryDoor: readonly [number, number] | null,
  footprint: Rect,
): number {
  const centre: [number, number] = [
    (footprint.min[0] + footprint.max[0]) / 2,
    (footprint.min[1] + footprint.max[1]) / 2,
  ];
  const door = entryDoor && Math.hypot(entryDoor[0] - at[0], entryDoor[1] - at[1]) >= DOOR_NEAR_M;
  const [tx, tz] = door && entryDoor ? entryDoor : centre;
  return Math.atan2(tx - at[0], -(tz - at[1])) / RAD;
}

/**
 * `rotation.y` (radians) to give an enemy model that faces local -Z, so it looks along world
 * compass `heading` while parented to a room group turned `turns` quarter-turns clockwise.
 */
export function enemyLocalRotationY(heading: number, turns: number): number {
  return -heading * RAD + (Math.PI / 2) * turns;
}
