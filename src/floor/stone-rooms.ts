import { Stream } from '../core/rng.ts';
import type { FloorPlan } from './generate.ts';

export type StoneRoom = 'dungeon' | 'cloister' | 'cistern' | 'valvehouse';

export function stoneRoomsFor(plan: FloorPlan, floor: 1 | 2 | 3): ReadonlyMap<number, StoneRoom> {
  const rooms = new Map<number, StoneRoom>();
  if (floor === 1) {
    if (plan.valvehouse) rooms.set(plan.valvehouse.valvehouseRoom, 'valvehouse');
    return rooms;
  }
  if (floor === 3) {
    if (plan.prismAnnex) rooms.set(plan.prismAnnex.annexRoom, 'cloister');
    return rooms;
  }

  if (plan.dispatchRoom) rooms.set(plan.dispatchRoom.vaultRoom, 'dungeon');
  if (plan.speakingPipes) rooms.set(plan.speakingPipes.cisternRoom, 'cistern');
  if (plan.reliquary) rooms.set(plan.reliquary.reliquaryRoom, 'dungeon');
  const halls = plan.rooms.filter(
    (room) =>
      room.templateId === 'hall' &&
      room.encounter?.tier === 'regular' &&
      room.encounter.socketIds.length === 1 &&
      room.index !== plan.dispatchRoom?.source.room &&
      room.index !== plan.dispatchRoom?.replyRoom &&
      room.index !== plan.hiddenPassage?.source.room,
  );
  if (halls.length) {
    const chosen = Stream.fromKey(`${plan.seed}:dungeon-combat-hall`).pick(halls);
    rooms.set(chosen.index, 'dungeon');
  }
  return rooms;
}
