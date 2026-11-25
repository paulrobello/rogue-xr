import { Stream } from '../core/rng.ts';
import { DUNGEON_SHOWCASE_STONE_HALLS, DUNGEON_SHOWCASE_UPPER_SEED } from './dungeon-showcase.ts';
import type { FloorPlan } from './generate.ts';

export type StoneRoom =
  | 'dungeon'
  | 'cloister'
  | 'cistern'
  | 'valvehouse'
  | 'armory'
  | 'optics'
  | 'drum'
  | 'reservoir'
  | 'stencil'
  | 'spring'
  | 'circuit';

export function stoneRoomsFor(plan: FloorPlan, floor: 1 | 2 | 3): ReadonlyMap<number, StoneRoom> {
  const rooms = new Map<number, StoneRoom>();
  if (floor === 1) {
    if (plan.shadowStencil) rooms.set(plan.shadowStencil.room, 'stencil');
    if (plan.valvehouse) rooms.set(plan.valvehouse.valvehouseRoom, 'valvehouse');
    if (plan.floatElevator) rooms.set(plan.floatElevator.room, 'reservoir');
    return rooms;
  }
  if (floor === 3) {
    if (plan.prismAnnex) rooms.set(plan.prismAnnex.annexRoom, 'cloister');
    if (plan.pendulumGallery) rooms.set(plan.pendulumGallery.galleryRoom, 'cloister');
    if (plan.borrowedLight) {
      rooms.set(plan.borrowedLight.opticsRoom, 'optics');
      rooms.set(plan.borrowedLight.recessRoom, 'dungeon');
    }
    if (plan.drumGallery) {
      rooms.set(plan.drumGallery.gallery, 'drum');
      rooms.set(plan.drumGallery.recess, 'dungeon');
    }
    return rooms;
  }

  if (plan.dispatchRoom) rooms.set(plan.dispatchRoom.vaultRoom, 'dungeon');
  if (plan.speakingPipes) rooms.set(plan.speakingPipes.cisternRoom, 'cistern');
  if (plan.reliquary) rooms.set(plan.reliquary.reliquaryRoom, 'dungeon');
  if (plan.armoryAlcove) rooms.set(plan.armoryAlcove.room, 'armory');
  if (plan.springTension) {
    rooms.set(plan.springTension.workshop, 'spring');
    rooms.set(plan.springTension.recess, 'dungeon');
  }
  if (plan.darkCircuit) {
    rooms.set(plan.darkCircuit.switchboard, 'circuit');
    rooms.set(plan.darkCircuit.recess, 'dungeon');
  }
  const halls = plan.rooms.filter(
    (room) =>
      room.templateId === 'hall' &&
      room.encounter?.tier === 'regular' &&
      room.encounter.socketIds.length === 1 &&
      room.index !== plan.armoryAlcove?.room &&
      room.index !== plan.dispatchRoom?.source.room &&
      room.index !== plan.dispatchRoom?.replyRoom &&
      room.index !== plan.hiddenPassage?.source.room,
  );
  if (plan.seed === DUNGEON_SHOWCASE_UPPER_SEED) {
    for (const hall of halls) {
      if (DUNGEON_SHOWCASE_STONE_HALLS.includes(hall.index)) rooms.set(hall.index, 'dungeon');
    }
  } else if (halls.length) {
    const chosen = Stream.fromKey(`${plan.seed}:dungeon-combat-hall`).pick(halls);
    rooms.set(chosen.index, 'dungeon');
  }
  return rooms;
}
