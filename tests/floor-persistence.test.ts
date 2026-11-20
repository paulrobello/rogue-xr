import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { bindFlowPersistence } from '../src/flow/persist.ts';
import { closeDb, openDb } from '../src/persist/db.ts';
import { loadRunSnapshot, validateSnapshot } from '../src/persist/saves.ts';
import { pressureTarget } from '../src/rules/pressure.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { playableFloorPlan, restoreUpperRoomLocations } from '../src/world/floor-view.ts';

const make = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });

describe('two-floor run persistence', () => {
  it('preserves shared loot and health and remembers each floor independently through Continue', async () => {
    const factory = new IDBFactory();
    let db = await openDb(factory);
    let flow = make();
    // During travel the renderer still owns the outgoing room when the save event fires.
    let worldRoom = 17;
    let persistence = bindFlowPersistence(flow, db, () => worldRoom);
    async function reload() {
      await persistence.flushed();
      closeDb(db);
      db = await openDb(factory);
      const snap = await loadRunSnapshot(db);
      if (!snap) throw Error('Travel did not save');
      persistence.dispose();
      flow = make();
      persistence = bindFlowPersistence(flow, db, () => worldRoom);
      worldRoom = snap.roomIndex;
      expect(flow.continueRun(snap)).toBe(true);
      return snap;
    }
    flow.newRun('MAPTEST2');
    flow.enterRoom(2);
    flow.fightStarted(2);
    flow.fightEnded({ room: 2, outcome: 'win', tier: 'regular', playerHp: 42 });
    flow.pickReward('skip');
    flow.openLoot(2, 'same-socket', 'card');
    const card = flow.claimLoot(2, 'same-socket');
    expect(card).toBeTruthy();
    const deck = flow.run?.deck;
    expect(flow.findBookSecretKey(2)).toBe(true);
    expect(flow.travelToFloor(2, 1)).toBe(true);
    let s = await reload();
    expect(s).toMatchObject({ floorNumber: 2, floorSeed: 'MAPTEST3', roomIndex: 1 });
    expect(flow.cleared).toEqual([]);
    expect(flow.isLootOpened(2, 'same-socket')).toBe(false);
    expect(flow.run?.bookSecretKeyRooms ?? []).toEqual([]);
    expect(flow.pressure.solved).toBe(false);
    expect(flow.collectPressureNote(2, 'A')).toBeNull();
    worldRoom = 2;
    expect(flow.travelToFloor(1, 0)).toBe(true);
    s = await reload();
    expect(s).toMatchObject({ floorNumber: 1, roomIndex: 0 });
    expect(flow.cleared).toEqual([2]);
    expect(flow.pressure.solved).toBe(false);
    expect(flow.floorNumber).toBe(1);
    flow.enterRoom(2);
    for (const [i, id] of (['A', 'B', 'C'] as const).entries()) {
      flow.collectPressureNote(2, id);
      const target = pressureTarget(flow.floorSeed)[i];
      for (let j = 1; j < target; j++) flow.turnPressureValve(2, i as 0 | 1 | 2);
    }
    expect(flow.primePressure(2)?.solved).toBe(true);
    const purse = flow.run?.cogs;
    worldRoom = 2;
    expect(flow.travelToFloor(2, 1)).toBe(true);
    s = await reload();
    expect(s).toMatchObject({ floorNumber: 2, roomIndex: 1 });
    expect(flow.pressure.solved).toBe(false);
    expect(flow.travelToFloor(1, 0)).toBe(true);
    s = await reload();
    expect(s).toMatchObject({ floorNumber: 1, roomIndex: 0 });
    expect(flow.pressure.solved).toBe(true);
    expect(flow.run).toMatchObject({ hp: 42, cogs: purse, deck, bookSecretKeyRooms: [2] });
    expect(flow.openLoot(2, 'same-socket', 'card')).toBeNull();
    expect(flow.travelToFloor(2, 1)).toBe(true);
    s = await reload();
    expect(flow.pressure.solved).toBe(false);
    expect(flow.run?.cogs).toBe(purse);
    expect(flow.openLoot(2, 'same-socket', 'cogs')).toMatchObject({ kind: 'cogs' });
    expect(flow.cleared).toEqual([]);
    expect(flow.travelToFloor(2, 7)).toBe(false);
    expect(flow.travelToFloor(1, 0)).toBe(true);
    s = await reload();
    expect(flow.pressure.solved).toBe(true);
    const archived = s.floors?.[0];
    if (!archived) throw Error('Missing first floor archive');
    expect(() => validateSnapshot({ ...s, floors: [archived, archived] })).toThrow();
    expect(() =>
      validateSnapshot({ ...s, floors: [{ ...archived, floorSeed: 'BAD00001' }] }),
    ).toThrow();
    expect(() => validateSnapshot({ ...s, floorSeed: 'BAD00002' })).toThrow();
    await persistence.flushed();
    persistence.dispose();
    closeDb(db);
  });
});

it.each([3, 4])('recovers a version %i save inside the retired upper wing', (version) => {
  const flow = make();
  flow.newRun('MAPTEST2');
  flow.listenToChimes();
  const upper = playableFloorPlan('MAPTEST3', version, 2);
  const stair = placeStairEntry(upper);
  if (!stair) throw Error('Missing upper return stairs');
  const removed = upper.rooms.length + 1;
  flow.travelToFloor(2, removed);
  const upstairs = flow.snapshot(10);
  if (!upstairs) throw Error('Missing upstairs save');
  const adjusted = restoreUpperRoomLocations({
    ...upstairs,
    contentVersion: version,
    reachedRooms: [0, 1, removed],
  });
  expect(adjusted.roomIndex).toBe(stair.room);
  expect(adjusted.reachedRooms).toEqual([0, 1]);
  expect(adjusted.run).toBe(upstairs.run);
  flow.travelToFloor(1, 0);
  const down = flow.snapshot(11);
  if (!down) throw Error('Missing downstairs save');
  const archived = restoreUpperRoomLocations({ ...down, contentVersion: version });
  expect(archived.roomIndex).toBe(down.roomIndex);
  expect(archived.floors?.find((f) => f.floorNumber === 2)?.reachedRooms).not.toContain(removed);
});
