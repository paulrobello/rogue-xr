// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { STREAMS } from '../src/core/rng.ts';
import { type FlowEvent, RunFlow } from '../src/flow/flow.ts';
import { bindFlowPersistence } from '../src/flow/persist.ts';
import { openDb } from '../src/persist/db.ts';
import { loadRunSnapshot, SaveError, snapshotRun, validateSnapshot } from '../src/persist/saves.ts';
import {
  claimTreasure,
  createRun,
  lootKey,
  openTreasure,
  type RunState,
} from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const SEED = 'SPIRE001';
/** SPIRE001's only treasure pickup: a card coffer (see `treasure-loot.test.ts`). */
const ROOM = 3;
const SOCKET = 'desk-drawer';
const KEY = lootKey(ROOM, SOCKET);
/**
 * The card each seed rolled before cards waited to be claimed (captured from the previous
 * `openTreasure`, which added it to the deck on open), with the `loot` stream after the draw.
 */
const ROLLED: Record<string, { card: string; loot: readonly number[] }> = {
  SPIRE001: { card: 'furnace-brand', loot: [1483294244, 2371642548, 4175475884, 3270100271] },
  SPIRE002: { card: 'cogstorm', loot: [1077963653, 2652091926, 1061691496, 1394955649] },
  BRASS042: { card: 'iron-knuckle', loot: [1306531626, 3920134790, 1112530678, 3891371150] },
};

const newRun = (seed = SEED): RunState => createRun(seed, STARTER_DECK);

function newFlow(): RunFlow {
  return new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
}

function opened(seed = SEED): RunState {
  const result = openTreasure(newRun(seed), KEY, 'card', REWARD_POOL);
  if (!result) throw new Error('open refused');
  return result.run;
}

describe('openTreasure then claimTreasure', () => {
  it('rolls the same card on the same loot draw as before claiming existed', () => {
    for (const [seed, want] of Object.entries(ROLLED)) {
      const result = openTreasure(newRun(seed), KEY, 'card', REWARD_POOL);
      expect(result?.loot).toMatchObject({ kind: 'card', card: want.card });
      expect(result?.run.rng.loot).toEqual(want.loot);
      expect(result?.run.pendingLoot).toEqual([{ key: KEY, card: want.card }]);
    }
  });

  it('adds the card to the deck only on claim, and drops the pending entry', () => {
    const run = Object.freeze(opened());
    expect(run.deck).toEqual(STARTER_DECK);
    const claimed = claimTreasure(run, KEY);
    expect(claimed?.card).toBe('furnace-brand');
    expect(claimed?.run.deck).toEqual([...STARTER_DECK, 'furnace-brand']);
    expect(claimed?.run.pendingLoot).toBeUndefined();
    expect('pendingLoot' in (claimed?.run ?? {})).toBe(false);
    expect(claimed?.run.openedLoot).toEqual([KEY]);
    expect(claimed?.run.rng).toEqual(run.rng);
    expect(run.pendingLoot).toHaveLength(1);
  });

  it('refuses a second claim and changes nothing', () => {
    const once = claimTreasure(opened(), KEY)?.run as RunState;
    expect(claimTreasure(once, KEY)).toBeNull();
    expect(once.deck).toHaveLength(STARTER_DECK.length + 1);
  });

  it('refuses an unknown key, an unopened coffer and a cog coffer', () => {
    const run = opened();
    expect(claimTreasure(run, lootKey(9, SOCKET))).toBeNull();
    expect(claimTreasure(newRun(), KEY)).toBeNull();
    const cogs = openTreasure(newRun(), KEY, 'cogs', REWARD_POOL)?.run as RunState;
    expect(cogs.pendingLoot).toBeUndefined();
    expect(claimTreasure(cogs, KEY)).toBeNull();
  });

  it('keeps other pending cards when one is claimed', () => {
    const other = lootKey(5, SOCKET);
    const both = openTreasure(opened(), other, 'card', REWARD_POOL)?.run as RunState;
    expect(both.pendingLoot?.map((p) => p.key)).toEqual([KEY, other]);
    const claimed = claimTreasure(both, other)?.run;
    expect(claimed?.pendingLoot?.map((p) => p.key)).toEqual([KEY]);
  });
});

describe('snapshots carry pending cards', () => {
  const world = {
    phase: 'explore' as const,
    floorSeed: SEED,
    roomIndex: ROOM,
    clearedEncounters: [],
    pendingReward: null,
  };

  it('round-trips a pending card through snapshotRun and JSON', () => {
    const run = opened();
    const snap = snapshotRun(run, world, 1);
    expect(snap.run.pendingLoot).toEqual([{ key: KEY, card: 'furnace-brand' }]);
    expect(validateSnapshot(JSON.parse(JSON.stringify(snap))).run).toEqual(run);
  });

  it('loads a save made before the field existed with nothing pending', () => {
    const raw = JSON.parse(JSON.stringify(snapshotRun(newRun(), world, 1))) as {
      run: Record<string, unknown>;
    };
    expect('pendingLoot' in raw.run).toBe(false);
    expect(validateSnapshot(raw).run.pendingLoot).toBeUndefined();
  });

  it('rejects a malformed pending list', () => {
    const raw = JSON.parse(JSON.stringify(snapshotRun(newRun(), world, 1))) as {
      run: Record<string, unknown>;
    };
    for (const bad of ['x', [3], [{ key: KEY }], [{ key: KEY, card: 4 }]]) {
      raw.run.pendingLoot = bad;
      expect(() => validateSnapshot(raw)).toThrow(SaveError);
    }
  });
});

describe('RunFlow.claimLoot', () => {
  it('claims only while exploring, once, after the coffer was opened', () => {
    const flow = newFlow();
    const seen: FlowEvent[] = [];
    flow.onChange((e) => seen.push(e));
    expect(flow.claimLoot(ROOM, SOCKET)).toBeNull();
    flow.newRun(SEED);
    expect(flow.claimLoot(ROOM, SOCKET)).toBeNull();
    flow.openLoot(ROOM, SOCKET, 'card');
    const deck = flow.run?.deck ?? [];
    expect(flow.pendingCard(ROOM, SOCKET)).toBe('furnace-brand');
    flow.fightStarted(2);
    expect(flow.claimLoot(ROOM, SOCKET)).toBeNull();
    flow.fightEnded({ room: 2, outcome: 'flee', tier: 'regular' });
    expect(flow.claimLoot(ROOM, SOCKET)).toBe('furnace-brand');
    expect(flow.run?.deck).toEqual([...deck, 'furnace-brand']);
    expect(flow.pendingCard(ROOM, SOCKET)).toBeNull();
    expect(flow.claimLoot(ROOM, SOCKET)).toBeNull();
    expect(flow.run?.deck).toHaveLength(deck.length + 1);
    const loot = seen.filter((e) => e.type === 'loot');
    expect(loot.map((e) => (e.type === 'loot' ? e.stage : ''))).toEqual(['opened', 'claimed']);
    expect(loot[1]).toEqual({
      type: 'loot',
      stage: 'claimed',
      room: ROOM,
      socketId: SOCKET,
      loot: { kind: 'card', card: 'furnace-brand' },
    });
  });

  it('claims advance no stream', () => {
    const flow = newFlow();
    flow.newRun(SEED);
    flow.openLoot(ROOM, SOCKET, 'card');
    const before = flow.run?.rng as RunState['rng'];
    flow.claimLoot(ROOM, SOCKET);
    for (const name of STREAMS) expect(flow.run?.rng[name]).toEqual(before[name]);
  });

  it('saves an unclaimed card, resumes it still pending, and claims it once after resume', async () => {
    const db = await openDb(undefined);
    const flow = newFlow();
    const saved = bindFlowPersistence(flow, db);
    flow.newRun(SEED);
    flow.enterRoom(ROOM);
    flow.openLoot(ROOM, SOCKET, 'card');
    await saved.flushed();
    const snapshot = await loadRunSnapshot(db);
    expect(snapshot?.run.pendingLoot).toEqual([{ key: KEY, card: 'furnace-brand' }]);
    expect(snapshot?.run.cogs).toBe(flow.run?.cogs);
    expect(snapshot?.run.deck).toEqual(STARTER_DECK);

    const resumed = newFlow();
    const resumedSave = bindFlowPersistence(resumed, db);
    expect(resumed.continueRun(snapshot as NonNullable<typeof snapshot>)).toBe(true);
    expect(resumed.isLootOpened(ROOM, SOCKET)).toBe(true);
    expect(resumed.pendingCard(ROOM, SOCKET)).toBe('furnace-brand');
    expect(resumed.openLoot(ROOM, SOCKET, 'card')).toBeNull();
    expect(resumed.claimLoot(ROOM, SOCKET)).toBe('furnace-brand');
    expect(resumed.claimLoot(ROOM, SOCKET)).toBeNull();
    await resumedSave.flushed();
    const after = await loadRunSnapshot(db);
    expect(after?.run.deck).toEqual([...STARTER_DECK, 'furnace-brand']);
    expect(after?.run.pendingLoot).toBeUndefined();
    expect(after?.run).toEqual(resumed.run);
    saved.dispose();
    resumedSave.dispose();
  });
});
