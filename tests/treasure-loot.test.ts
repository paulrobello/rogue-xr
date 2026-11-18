// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { STREAMS } from '../src/core/rng.ts';
import { generateFloor } from '../src/floor/generate.ts';
import { type FlowEvent, RunFlow } from '../src/flow/flow.ts';
import { bindFlowPersistence } from '../src/flow/persist.ts';
import { openDb } from '../src/persist/db.ts';
import { loadRunSnapshot, SaveError, snapshotRun, validateSnapshot } from '../src/persist/saves.ts';
import {
  createRun,
  lootKey,
  openTreasure,
  parseLootKey,
  REWARD_COGS,
  type RunState,
  rewardOffer,
  TREASURE_COGS,
} from '../src/rules/index.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const SEED = 'SPIRE001';
const KEY = lootKey(3, 'desk-drawer');

/** The treasure pickups the generator places on `seed`, as `[room, socketId, kind]`. */
function treasureOf(seed: string) {
  return generateFloor(seed)
    .rooms.filter((r) => r.role === 'treasure')
    .flatMap((r) => r.loot.map((l) => ({ room: r.index, socketId: l.socketId, kind: l.kind })));
}

function newFlow(): RunFlow {
  return new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
}

const newRun = (seed = SEED): RunState => createRun(seed, STARTER_DECK);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('treasure pickups in the generated floors', () => {
  it('SPIRE001 holds a card coffer and SPIRE002 a cog coffer, in treasure rooms only', () => {
    expect(treasureOf('SPIRE001')).toEqual([{ room: 3, socketId: 'desk-drawer', kind: 'card' }]);
    expect(treasureOf('SPIRE002')).toEqual([{ room: 5, socketId: 'desk-drawer', kind: 'cogs' }]);
  });
});

describe('openTreasure', () => {
  it('applies a cog pickup once, records it, and refuses a second open', () => {
    const run = deepFreeze(newRun());
    const first = openTreasure(run, KEY, 'cogs', REWARD_POOL);
    expect(first).not.toBeNull();
    if (first?.loot.kind !== 'cogs') throw new Error('expected cogs');
    expect(first.loot.cogs).toBeGreaterThanOrEqual(TREASURE_COGS.min);
    expect(first.loot.cogs).toBeLessThanOrEqual(TREASURE_COGS.max);
    expect(first.run.cogs).toBe(run.cogs + first.loot.cogs);
    expect(first.run.deck).toEqual(run.deck);
    expect(first.run.openedLoot).toEqual([KEY]);
    expect(openTreasure(first.run, KEY, 'cogs', REWARD_POOL)).toBeNull();
    expect(run.openedLoot).toBeUndefined();
  });

  it('rolls one pool card for a card pickup, once, and leaves it pending outside the deck', () => {
    const run = newRun();
    const first = openTreasure(run, KEY, 'card', REWARD_POOL);
    if (first?.loot.kind !== 'card') throw new Error('expected a card');
    expect(REWARD_POOL).toContain(first.loot.card);
    expect(first.run.deck).toEqual(run.deck);
    expect(first.run.pendingLoot).toEqual([{ key: KEY, card: first.loot.card }]);
    expect(first.loot.cogs).toBeGreaterThanOrEqual(2);
    expect(first.loot.cogs).toBeLessThanOrEqual(4);
    expect(first.run.cogs).toBe(run.cogs + (first.loot.cogs ?? 0));
    expect(openTreasure(first.run, KEY, 'card', REWARD_POOL)).toBeNull();
  });

  it('opens other pickups independently', () => {
    const a = openTreasure(newRun(), lootKey(3, 'desk-drawer'), 'cogs', REWARD_POOL);
    const b = a && openTreasure(a.run, lootKey(5, 'desk-drawer'), 'cogs', REWARD_POOL);
    expect(b?.run.openedLoot).toEqual([lootKey(3, 'desk-drawer'), lootKey(5, 'desk-drawer')]);
  });

  it('gives the same loot for the same seed and the same history', () => {
    for (const kind of ['cogs', 'card'] as const) {
      const a = openTreasure(newRun(), KEY, kind, REWARD_POOL);
      const b = openTreasure(newRun(), KEY, kind, REWARD_POOL);
      expect(a).toEqual(b);
      expect(a).not.toBeNull();
    }
    const other = openTreasure(newRun('SPIRE002'), KEY, 'card', REWARD_POOL);
    const seeds = ['SPIRE001', 'SPIRE002', 'SPIRE003', 'SPIRE004', 'SPIRE005', 'SPIRE006'];
    const cards = new Set(
      seeds.map((s) => {
        const r = openTreasure(newRun(s), KEY, 'card', REWARD_POOL);
        return r?.loot.kind === 'card' ? r.loot.card : '';
      }),
    );
    expect(other).not.toBeNull();
    expect(cards.size).toBeGreaterThan(1);
  });

  it('advances only the loot stream', () => {
    const run = newRun();
    for (const kind of ['cogs', 'card'] as const) {
      const result = openTreasure(run, KEY, kind, REWARD_POOL);
      expect(result).not.toBeNull();
      for (const name of STREAMS) {
        if (name === 'loot') expect(result?.run.rng[name]).not.toEqual(run.rng[name]);
        else expect(result?.run.rng[name]).toEqual(run.rng[name]);
      }
    }
  });

  it('leaves the run untouched on a refused open, so no stream moves either', () => {
    const opened = openTreasure(newRun(), KEY, 'cogs', REWARD_POOL)?.run as RunState;
    const again = openTreasure(opened, KEY, 'cogs', REWARD_POOL);
    expect(again).toBeNull();
    expect(opened.rng.loot).toEqual(openTreasure(newRun(), KEY, 'cogs', REWARD_POOL)?.run.rng.loot);
  });

  it('shifts later reward offers the way any loot draw does, never the other streams', () => {
    const plain = rewardOffer(newRun(), 'regular', REWARD_POOL);
    const opened = openTreasure(newRun(), KEY, 'cogs', REWARD_POOL)?.run as RunState;
    const later = rewardOffer(opened, 'regular', REWARD_POOL);
    expect(later.offer.cogs).toBeGreaterThanOrEqual(REWARD_COGS.regular.min);
    expect(later.run.rng.deck).toEqual(plain.run.rng.deck);
    expect(later.run.rng.floor).toEqual(plain.run.rng.floor);
  });
});

describe('lootKey', () => {
  it('round-trips and rejects malformed keys', () => {
    expect(parseLootKey(lootKey(5, 'desk-drawer'))).toEqual({ room: 5, socketId: 'desk-drawer' });
    for (const bad of ['', 'x', '/a', '3/', 'a/b', '-1/a', '1.5/a'])
      expect(parseLootKey(bad)).toBeNull();
  });
});

describe('RunFlow.openLoot', () => {
  const [pickup] = treasureOf(SEED);
  if (!pickup) throw new Error('SPIRE001 has no treasure');

  it('works only while exploring', () => {
    const flow = newFlow();
    expect(flow.openLoot(pickup.room, pickup.socketId, pickup.kind)).toBeNull();
    flow.newRun(SEED);
    flow.fightStarted(2);
    expect(flow.phase).toBe('combat');
    expect(flow.openLoot(pickup.room, pickup.socketId, pickup.kind)).toBeNull();
    flow.fightEnded({ room: 2, outcome: 'win', tier: 'regular' });
    expect(flow.phase).toBe('reward');
    expect(flow.openLoot(pickup.room, pickup.socketId, pickup.kind)).toBeNull();
    expect(flow.run?.openedLoot).toBeUndefined();
  });

  it('applies the pickup exactly once and says what it found', () => {
    const flow = newFlow();
    const seen: FlowEvent[] = [];
    flow.onChange((e) => seen.push(e));
    flow.newRun(SEED);
    const before = flow.run as RunState;
    const found = flow.openLoot(pickup.room, pickup.socketId, pickup.kind);
    if (found?.kind !== 'card') throw new Error('SPIRE001 holds a card coffer');
    expect(flow.run?.deck).toEqual(before.deck);
    expect(flow.pendingCard(pickup.room, pickup.socketId)).toBe(found.card);
    expect(flow.run?.cogs).toBe(before.cogs + (found.cogs ?? 0));
    expect(flow.isLootOpened(pickup.room, pickup.socketId)).toBe(true);
    expect(flow.lastLoot).toEqual({ room: pickup.room, socketId: pickup.socketId, loot: found });
    expect(flow.openLoot(pickup.room, pickup.socketId, pickup.kind)).toBeNull();
    expect(flow.run?.deck).toHaveLength(before.deck.length);
    expect(seen.filter((e) => e.type === 'loot')).toHaveLength(1);
    expect(flow.phase).toBe('explore');
  });

  it('gives the same loot on the same seed and forgets it with the run', () => {
    const a = newFlow();
    const b = newFlow();
    a.newRun(SEED);
    b.newRun(SEED);
    expect(a.openLoot(pickup.room, pickup.socketId, pickup.kind)).toEqual(
      b.openLoot(pickup.room, pickup.socketId, pickup.kind),
    );
    expect(a.run).toEqual(b.run);
    a.fightStarted(2);
    a.fightEnded({ room: 2, outcome: 'defeat', tier: 'regular' });
    a.toTitle();
    a.newRun(SEED);
    expect(a.lastLoot).toBeNull();
    expect(a.isLootOpened(pickup.room, pickup.socketId)).toBe(false);
  });

  it('advances only the loot stream', () => {
    const flow = newFlow();
    flow.newRun(SEED);
    const before = flow.run?.rng as RunState['rng'];
    flow.openLoot(pickup.room, pickup.socketId, 'cogs');
    const after = flow.run?.rng as RunState['rng'];
    for (const name of STREAMS) {
      if (name === 'loot') expect(after[name]).not.toEqual(before[name]);
      else expect(after[name]).toEqual(before[name]);
    }
  });

  it('saves a snapshot at the pickup, and a resumed run cannot open or re-roll it', async () => {
    const db = await openDb(undefined);
    const flow = newFlow();
    const saved = bindFlowPersistence(flow, db);
    flow.newRun(SEED);
    flow.enterRoom(pickup.room);
    await saved.flushed();
    expect((await loadRunSnapshot(db))?.run.openedLoot).toBeUndefined();

    const found = flow.openLoot(pickup.room, pickup.socketId, pickup.kind);
    await saved.flushed();
    const snapshot = await loadRunSnapshot(db);
    expect(snapshot?.run.openedLoot).toEqual([lootKey(pickup.room, pickup.socketId)]);
    expect(snapshot?.run).toEqual(flow.run);
    expect(snapshot?.roomIndex).toBe(pickup.room);

    const resumed = newFlow();
    expect(resumed.continueRun(snapshot as NonNullable<typeof snapshot>)).toBe(true);
    const deck = resumed.run?.deck;
    const cogs = resumed.run?.cogs;
    expect(resumed.isLootOpened(pickup.room, pickup.socketId)).toBe(true);
    expect(resumed.openLoot(pickup.room, pickup.socketId, pickup.kind)).toBeNull();
    expect(resumed.openLoot(pickup.room, pickup.socketId, 'cogs')).toBeNull();
    expect(resumed.run?.deck).toEqual(deck);
    expect(resumed.run?.cogs).toBe(cogs);
    expect(resumed.run).toEqual(flow.run);
    expect(found?.kind).toBe('card');
    saved.dispose();
  });
});

describe('snapshots carry opened loot', () => {
  const world = {
    phase: 'explore' as const,
    floorSeed: SEED,
    roomIndex: 3,
    clearedEncounters: [],
    pendingReward: null,
  };

  it('round-trips through snapshotRun and JSON', () => {
    const opened = openTreasure(newRun(), KEY, 'cogs', REWARD_POOL)?.run as RunState;
    const snap = snapshotRun(opened, world, 1);
    expect(snap.run.openedLoot).toEqual([KEY]);
    expect(validateSnapshot(JSON.parse(JSON.stringify(snap))).run).toEqual(opened);
  });

  it('loads a version 1 snapshot saved before the field existed', () => {
    const raw = JSON.parse(JSON.stringify(snapshotRun(newRun(), world, 1))) as {
      run: Record<string, unknown>;
    };
    expect('openedLoot' in raw.run).toBe(false);
    const snap = validateSnapshot(raw);
    expect(snap.run.openedLoot).toBeUndefined();
    expect(snap.run).toEqual(newRun());
  });

  it('rejects an opened-loot list that is not strings', () => {
    const raw = JSON.parse(JSON.stringify(snapshotRun(newRun(), world, 1))) as {
      run: Record<string, unknown>;
    };
    raw.run.openedLoot = [3];
    expect(() => validateSnapshot(raw)).toThrow(SaveError);
    raw.run.openedLoot = 'x';
    expect(() => validateSnapshot(raw)).toThrow(SaveError);
  });
});
