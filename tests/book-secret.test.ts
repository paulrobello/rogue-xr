import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { bindFlowPersistence } from '../src/flow/persist.ts';
import { openDb } from '../src/persist/db.ts';
import { exportSave, importSave, loadRunSnapshot, validateSnapshot } from '../src/persist/saves.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const flow = (): RunFlow =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });

describe('red book secret', () => {
  it('pays once and persists its opened marker in a snapshot', () => {
    const run = flow();
    expect(run.newRun('B00K001A')).toBe(true);
    expect(run.openBookSecret(2)).toBe(true);
    expect(run.run?.cogs).toBe(10);
    expect(run.openBookSecret(2)).toBe(false);
    const snapshot = run.snapshot(1, 2);
    expect(snapshot?.run.bookSecretOpenedRooms).toEqual([2]);
    expect(validateSnapshot(snapshot).run.bookSecretOpenedRooms).toEqual([2]);
  });

  it('pays independently for marked books in different rooms', () => {
    const run = flow();
    run.newRun('B00K003A');
    expect(run.openBookSecret(1)).toBe(true);
    expect(run.openBookSecret(2)).toBe(true);
    expect(run.run?.cogs).toBe(20);
    expect(run.openBookSecret(1)).toBe(false);
    expect(run.run?.bookSecretOpenedRooms).toEqual([1, 2]);
  });

  it('accepts a pre-secret snapshot without the optional field', () => {
    const run = flow();
    run.newRun('B00K002A');
    const snapshot = run.snapshot(1, 0);
    expect(snapshot).not.toBeNull();
    const legacy = structuredClone(snapshot) as unknown as Record<string, unknown>;
    delete (legacy.run as Record<string, unknown>).bookSecretOpenedRooms;
    expect(validateSnapshot(legacy).run.bookSecretOpenedRooms).toBeUndefined();
  });

  it('round-trips opened rooms through export/import without a duplicate payout', async () => {
    const sourceDb = await openDb(new IDBFactory());
    const source = flow();
    const persistence = bindFlowPersistence(source, sourceDb);
    source.newRun('B00K004A');
    expect(source.openBookSecret(3)).toBe(true);
    await persistence.flushed();
    const exported = await exportSave(sourceDb, 123);
    const targetDb = await openDb(new IDBFactory());
    await importSave(targetDb, exported);
    const snapshot = await loadRunSnapshot(targetDb);
    expect(snapshot?.run.bookSecretOpenedRooms).toEqual([3]);
    const restored = flow();
    expect(restored.continueRun(snapshot as NonNullable<typeof snapshot>)).toBe(true);
    expect(restored.openBookSecret(3)).toBe(false);
    expect(restored.openBookSecret(4)).toBe(true);
    expect(restored.run?.cogs).toBe(20);
    persistence.dispose();
  });
});
