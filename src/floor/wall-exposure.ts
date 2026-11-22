import { FACINGS, type Facing, rotatePoint, templateById } from '../content/rooms.ts';
import { type FloorPlan, type PlacedRoom, worldRoom } from './generate.ts';

/** A span of an unrotated wall needs its full width clear of any adjoining room. */
export function wallSpanIsExposed(
  plan: FloorPlan,
  room: PlacedRoom,
  wall: Facing,
  along: number,
  halfWidth: number,
): boolean {
  const { min, max } = templateById(room.templateId).footprint;
  const northSouth = wall === 'N' || wall === 'S';
  const fixed = wall === 'N' ? min[1] : wall === 'S' ? max[1] : wall === 'W' ? min[0] : max[0];
  const a = along - halfWidth;
  const b = along + halfWidth;
  const [ax, , az] = rotatePoint(northSouth ? [a, 0, fixed] : [fixed, 0, a], room.turns);
  const [bx, , bz] = rotatePoint(northSouth ? [b, 0, fixed] : [fixed, 0, b], room.turns);
  const minX = Math.min(ax, bx) + room.position[0];
  const maxX = Math.max(ax, bx) + room.position[0];
  const minZ = Math.min(az, bz) + room.position[1];
  const maxZ = Math.max(az, bz) + room.position[1];
  const facing = FACINGS[(FACINGS.indexOf(wall) + room.turns) % FACINGS.length];
  const close = (lhs: number, rhs: number) => Math.abs(lhs - rhs) < 1e-5;
  const overlaps = (low: number, high: number, start: number, end: number) =>
    Math.min(high, end) - Math.max(low, start) > 1e-5;
  return !plan.rooms.some((other) => {
    if (other.index === room.index) return false;
    const { min: start, max: end } = worldRoom(
      templateById(other.templateId),
      other.turns,
      other.position,
    ).footprint;
    switch (facing) {
      case 'N':
        return close(end[1], minZ) && overlaps(minX, maxX, start[0], end[0]);
      case 'E':
        return close(start[0], minX) && overlaps(minZ, maxZ, start[1], end[1]);
      case 'S':
        return close(start[1], minZ) && overlaps(minX, maxX, start[0], end[0]);
      case 'W':
        return close(end[0], minX) && overlaps(minZ, maxZ, start[1], end[1]);
    }
    return false;
  });
}
