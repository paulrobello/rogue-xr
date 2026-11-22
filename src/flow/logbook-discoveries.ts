import type { FloorPlan, WorldRoom } from '../floor/generate.ts';
import type { MapPoint } from './logbook-map.ts';

/** A symbol that may be drawn over an explored-room map. */
export interface LogbookDiscovery {
  readonly kind: 'chest' | 'note' | 'rubbing' | 'cache';
  /** Stable id for the symbol, suitable for a11y labels or hit testing. */
  readonly id: string;
  readonly room: number;
  /** World-space floor coordinates, [x, z]. */
  readonly position: MapPoint;
}

export interface KnownNoteLocation {
  readonly id: string;
  readonly room: number;
  /** Runtime placement when available. Defaults to the room centre. */
  readonly position?: MapPoint;
}

/**
 * State needed to build optional logbook symbols for one floor. `openedLoot` comes from the active
 * RunState or the matching archived FloorSnapshot. Note locations are supplied by the runtime
 * PressureNotes/scene owner, so an undiscovered note never leaks its generated location here.
 */
export interface LogbookDiscoveryInput {
  readonly plan: FloorPlan;
  readonly worldRooms: readonly WorldRoom[];
  readonly explored: readonly number[];
  readonly openedLoot?: readonly string[];
  /** Acquired clue ids, for callers that pass the complete runtime placement table. */
  readonly acquiredNotes?: readonly string[];
  readonly knownNotes?: readonly KnownNoteLocation[];
  readonly knownRubbingRoom?: number;
  readonly knownCacheRooms?: readonly number[];
}

function roomCenter(room: WorldRoom): MapPoint {
  return [
    (room.footprint.min[0] + room.footprint.max[0]) / 2,
    (room.footprint.min[1] + room.footprint.max[1]) / 2,
  ];
}

function lootKey(room: number, socketId: string): string {
  return `${room}/${socketId}`;
}

/**
 * Returns only discoveries in explored rooms. Chest positions come from the placed room's rotated
 * loot socket, not from a guessed room centre. The result is deterministic and contains no hidden
 * loot or note locations.
 */
export function logbookDiscoveries(input: LogbookDiscoveryInput): readonly LogbookDiscovery[] {
  const explored = new Set(input.explored);
  const opened = new Set(input.openedLoot ?? []);
  const acquiredNotes = input.acquiredNotes && new Set(input.acquiredNotes);
  const result: LogbookDiscovery[] = [];

  for (const placed of input.plan.rooms) {
    if (!explored.has(placed.index)) continue;
    const room = input.worldRooms[placed.index];
    if (!room) continue;
    for (const loot of placed.loot) {
      if (!opened.has(lootKey(placed.index, loot.socketId))) continue;
      const socket = room.template.lootSockets.find(({ id }) => id === loot.socketId);
      if (!socket) continue;
      result.push({
        kind: 'chest',
        id: `chest:${placed.index}/${loot.socketId}`,
        room: placed.index,
        position: [
          socket.position[0] + placed.position[0],
          socket.position[2] + placed.position[1],
        ],
      });
    }
  }

  for (const note of input.knownNotes ?? []) {
    if (acquiredNotes && !acquiredNotes.has(note.id)) continue;
    const room = input.worldRooms[note.room];
    if (!room || !explored.has(note.room)) continue;
    result.push({
      kind: 'note',
      id: `note:${note.id}`,
      room: note.room,
      position: note.position ?? roomCenter(room),
    });
  }

  if (input.knownRubbingRoom !== undefined && explored.has(input.knownRubbingRoom)) {
    const room = input.worldRooms[input.knownRubbingRoom];
    if (room) {
      result.push({
        kind: 'rubbing',
        id: 'rubbing:reliquary',
        room: input.knownRubbingRoom,
        position: roomCenter(room),
      });
    }
  }

  for (const roomNumber of input.knownCacheRooms ?? []) {
    const room = input.worldRooms[roomNumber];
    if (!room || !explored.has(roomNumber)) continue;
    result.push({
      kind: 'cache',
      id: `cache:${roomNumber}`,
      room: roomNumber,
      position: roomCenter(room),
    });
  }

  return result;
}
