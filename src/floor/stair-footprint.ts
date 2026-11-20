import type { Facing, Rect } from '../content/rooms.ts';

export const STAIR_WIDTH = 3;
const DEPTH = 6.14; // Includes the recess for the open door.
export const STAIR_OUTWARD: Record<Facing, readonly [number, number]> = {
  N: [0, -1],
  S: [0, 1],
  E: [1, 0],
  W: [-1, 0],
};

export function stairFootprint(door: { facing: Facing; world: readonly [number, number] }): Rect {
  const [x, z] = door.world;
  const [dx, dz] = STAIR_OUTWARD[door.facing];
  const half = STAIR_WIDTH / 2;
  return {
    min: [
      x + Math.min(0, dx * DEPTH) - Math.abs(dz) * half,
      z + Math.min(0, dz * DEPTH) - Math.abs(dx) * half,
    ],
    max: [
      x + Math.max(0, dx * DEPTH) + Math.abs(dz) * half,
      z + Math.max(0, dz * DEPTH) + Math.abs(dx) * half,
    ],
  };
}
