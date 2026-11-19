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
  it('requires key, unlock, then claim in order and never replays a stage', () => {
    const run = flow();
    expect(run.newRun('B00K001A')).toBe(true);
    expect(run.unlockBookSecret(2)).toBe(false);
    expect(run.claimBookSecret(2)).toBe(false);
    expect(run.findBookSecretKey(2)).toBe(true);
    expect(run.findBookSecretKey(2)).toBe(false);
    expect(run.claimBookSecret(2)).toBe(false);
    expect(run.unlockBookSecret(2)).toBe(true);
    expect(run.unlockBookSecret(2)).toBe(false);
    expect(run.findBookSecretKey(2)).toBe(false);
    expect(run.claimBookSecret(2)).toBe(true);
    expect(run.run?.cogs).toBe(10);
    expect(run.claimBookSecret(2)).toBe(false);
    const snapshot = run.snapshot(1, 2);
    expect(snapshot?.run.bookSecretOpenedRooms).toEqual([2]);
    expect(validateSnapshot(snapshot).run.bookSecretOpenedRooms).toEqual([2]);
  });

  it('pays independently for marked books in different rooms', () => {
    const run = flow();
    run.newRun('B00K003A');
    for (const room of [1, 2]) {
      expect(run.findBookSecretKey(room)).toBe(true);
      expect(run.unlockBookSecret(room)).toBe(true);
      expect(run.claimBookSecret(room)).toBe(true);
    }
    expect(run.run?.cogs).toBe(20);
    expect(run.findBookSecretKey(1)).toBe(false);
    expect(run.unlockBookSecret(1)).toBe(false);
    expect(run.claimBookSecret(1)).toBe(false);
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

  it('continues correctly after key and unlock checkpoints', () => {
    const keyed = flow();
    keyed.newRun('B00K005A');
    keyed.findBookSecretKey(3);
    const keySnapshot = keyed.snapshot(1, 3);
    const afterKey = flow();
    expect(afterKey.continueRun(keySnapshot as NonNullable<typeof keySnapshot>)).toBe(true);
    expect(afterKey.findBookSecretKey(3)).toBe(false);
    expect(afterKey.unlockBookSecret(3)).toBe(true);

    const unlockedSnapshot = afterKey.snapshot(2, 3);
    const afterUnlock = flow();
    expect(afterUnlock.continueRun(unlockedSnapshot as NonNullable<typeof unlockedSnapshot>)).toBe(
      true,
    );
    expect(afterUnlock.unlockBookSecret(3)).toBe(false);
    expect(afterUnlock.claimBookSecret(3)).toBe(true);
  });

  it('round-trips opened rooms through export/import without a duplicate payout', async () => {
    const sourceDb = await openDb(new IDBFactory());
    const source = flow();
    const persistence = bindFlowPersistence(source, sourceDb);
    source.newRun('B00K004A');
    expect(source.findBookSecretKey(3)).toBe(true);
    expect(source.unlockBookSecret(3)).toBe(true);
    expect(source.claimBookSecret(3)).toBe(true);
    await persistence.flushed();
    const exported = await exportSave(sourceDb, 123);
    const targetDb = await openDb(new IDBFactory());
    await importSave(targetDb, exported);
    const snapshot = await loadRunSnapshot(targetDb);
    expect(snapshot?.run.bookSecretOpenedRooms).toEqual([3]);
    const restored = flow();
    expect(restored.continueRun(snapshot as NonNullable<typeof snapshot>)).toBe(true);
    expect(restored.findBookSecretKey(3)).toBe(false);
    expect(restored.unlockBookSecret(3)).toBe(false);
    expect(restored.claimBookSecret(3)).toBe(false);
    expect(restored.findBookSecretKey(4)).toBe(true);
    expect(restored.unlockBookSecret(4)).toBe(true);
    expect(restored.claimBookSecret(4)).toBe(true);
    expect(restored.run?.cogs).toBe(20);
    persistence.dispose();
  });

  it('keeps legacy pre-paid rooms paid without requiring a key migration', () => {
    const run = flow();
    run.newRun('B00K006A');
    run.findBookSecretKey(1);
    run.unlockBookSecret(1);
    run.claimBookSecret(1);
    const raw = run.snapshot(1, 1) as NonNullable<ReturnType<RunFlow['snapshot']>>;
    const legacyRun = raw.run as unknown as Record<string, unknown>;
    delete legacyRun.bookSecretKeyRooms;
    delete legacyRun.bookSecretCabinetRooms;
    const restored = flow();
    expect(restored.continueRun(validateSnapshot(raw))).toBe(true);
    expect(restored.claimBookSecret(1)).toBe(false);
    expect(restored.run?.cogs).toBe(10);
  });
});
