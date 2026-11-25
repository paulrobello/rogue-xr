import { describe, expect, it } from 'vitest';
import { templateById } from '../src/content/rooms.ts';
import { type FloorPlan, worldRoom } from '../src/floor/generate.ts';
import { logbookDiscoveries } from '../src/flow/logbook-discoveries.ts';

const template = templateById('study');
const plan: FloorPlan = {
  seed: 'DISCOVERY',
  rooms: [
    {
      index: 0,
      templateId: template.id,
      turns: 1,
      position: [10, -4],
      role: 'treasure',
      wing: 0,
      depth: 0,
      encounter: null,
      loot: [{ socketId: template.lootSockets[0]?.id ?? 'missing', kind: 'card' }],
    },
  ],
  connections: [],
  sealed: [],
  guardianRoom: 0,
};

describe('logbook discoveries', () => {
  it('uses the placed loot socket and hides unopened chests', () => {
    const world = [worldRoom(template, 1, [10, -4])];
    const socket = world[0]?.template.lootSockets[0];
    if (!socket) throw new Error('study needs a loot socket');
    expect(logbookDiscoveries({ plan, worldRooms: world, explored: [0] })).toEqual([]);
    expect(
      logbookDiscoveries({
        plan,
        worldRooms: world,
        explored: [0],
        openedLoot: [`0/${socket.id}`],
      }),
    ).toEqual([
      {
        kind: 'chest',
        id: `chest:0/${socket.id}`,
        room: 0,
        position: [socket.position[0] + 10, socket.position[2] - 4],
      },
    ]);
  });

  it('only shows acquired notes and known symbols in explored rooms', () => {
    const world = [worldRoom(template, 0, [0, 0])];
    expect(
      logbookDiscoveries({
        plan,
        worldRooms: world,
        explored: [],
        knownNotes: [{ id: 'A', room: 0, position: [1, 2] }],
        knownRubbingRoom: 0,
        knownCacheRooms: [0],
      }),
    ).toEqual([]);
    expect(
      logbookDiscoveries({
        plan,
        worldRooms: world,
        explored: [0],
        knownNotes: [{ id: 'A', room: 0, position: [1, 2] }],
        knownRubbingRoom: 0,
        knownCacheRooms: [0],
      }),
    ).toMatchObject([
      { kind: 'note', id: 'note:A', room: 0, position: [1, 2] },
      { kind: 'rubbing', id: 'rubbing:reliquary', room: 0 },
      { kind: 'cache', id: 'cache:0', room: 0 },
    ]);
  });

  it('shows hearths only in explored rooms', () => {
    const world = [worldRoom(template, 0, [0, 0])];
    const hearth = { id: 'study-hearth', room: 0, position: [2, 3] as const };
    expect(
      logbookDiscoveries({ plan, worldRooms: world, explored: [], knownHearths: [hearth] }),
    ).toEqual([]);
    expect(
      logbookDiscoveries({ plan, worldRooms: world, explored: [0], knownHearths: [hearth] }),
    ).toEqual([{ kind: 'hearth', id: 'hearth:study-hearth', room: 0, position: [2, 3] }]);
  });

  it('shows interacted puzzles at their explored room centre only', () => {
    const world = [worldRoom(template, 0, [0, 0])];
    const knownPuzzles = [{ id: 'clock', room: 0 }];
    expect(logbookDiscoveries({ plan, worldRooms: world, explored: [], knownPuzzles })).toEqual([]);
    expect(logbookDiscoveries({ plan, worldRooms: world, explored: [0], knownPuzzles })).toEqual([
      { kind: 'puzzle', id: 'puzzle:0', room: 0, position: [0, 0] },
    ]);
  });
});
