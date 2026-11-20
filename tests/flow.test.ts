import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { normalizeSeed } from '../src/core/rng.ts';
import { FLOW_TRANSITIONS, type FlowEvent, type FlowPhase, RunFlow } from '../src/flow/flow.ts';
import { bindFlowPersistence } from '../src/flow/persist.ts';
import { openDb } from '../src/persist/db.ts';
import {
  exportSave,
  importSave,
  loadRunSnapshot,
  loadWorkshop,
  validateSnapshot,
} from '../src/persist/saves.ts';
import { pressureTarget, readPressure } from '../src/rules/pressure.ts';
import { REWARD_COGS, SKIP_REWARD } from '../src/rules/run.ts';
import { createWorkshop, type WorkshopState } from '../src/rules/workshop.ts';
import { mountFloorView, playableFloorPlan } from '../src/world/floor-view.ts';

const SEED = 'SPIRE001';

function flowWith(workshop: WorkshopState = createWorkshop()): RunFlow {
  return new RunFlow({ workshop, starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });
}

function phases(flow: RunFlow): FlowPhase[] {
  const seen: FlowPhase[] = [];
  flow.onChange((e: FlowEvent) => {
    if (e.type === 'phase') seen.push(e.to);
  });
  return seen;
}

/** Plays one won regular fight in `room` and returns to exploring with `card` (or skip). */
function winRegular(flow: RunFlow, room: number, pick: 'first' | 'skip' = 'first'): string | null {
  expect(flow.fightStarted(room)).toBe(true);
  expect(flow.fightEnded({ room, outcome: 'win', tier: 'regular' })).toBe(true);
  const card = pick === 'first' ? (flow.offer?.cards[0] ?? null) : null;
  expect(flow.pickReward(card ?? SKIP_REWARD)).toBe(true);
  return card;
}

describe('flow transitions', () => {
  it('locks the same optional coffer in the rules and the first-floor world for each seed', () => {
    const sites = new Set<string>();
    for (const seed of [SEED, 'MAPTEST2', 'WIND0000', 'KEEP0010', 'N0TE0032', 'BREW0001']) {
      const flow = flowWith();
      flow.newRun(seed);
      const cache = flow.brassCache;
      expect(playableFloorPlan(seed, 7, 1).brassCache).toEqual(cache);
      expect(playableFloorPlan(seed, 6, 1)).not.toHaveProperty('brassCache');
      expect(playableFloorPlan(seed, 7, 2)).not.toHaveProperty('brassCache');
      if (cache) sites.add(JSON.stringify(cache));
    }
    expect(sites.size).toBeGreaterThan(1);
  });

  it('carries the key through Continue and spends it once before opening the lower coffer', () => {
    let flow = flowWith();
    flow.newRun(SEED);
    const target = flow.brassCache;
    if (!target) throw Error('Seed requires an optional coffer');
    const { room, socketId } = target;
    expect(flow.takeBrassKey()).toBe(false);
    expect(flow.run?.brassCacheSeen).toBeUndefined();
    expect(flow.inspectBrassLock(room, socketId)).toBe(true);
    expect(flow.run?.brassCacheSeen).toBe(true);
    expect(flow.brassKey).toBe('missing');
    expect(flow.openLoot(room, socketId, 'card')).toBeNull();
    expect(flow.travelToFloor(2, 0)).toBe(true);
    expect(flow.takeBrassKey()).toBe(true);
    expect(flow.takeBrassKey()).toBe(false);
    expect(flow.inspectBrassLock(room, socketId)).toBe(false);
    const upstairs = validateSnapshot(flow.snapshot());
    flow = flowWith();
    expect(flow.continueRun(upstairs)).toBe(true);
    expect(flow.brassKey).toBe('held');
    expect(flow.run?.brassCacheSeen).toBe(true);
    expect(flow.travelToFloor(1, 0)).toBe(true);
    expect(flow.inspectBrassLock(room, 'unrelated-socket')).toBe(false);
    expect(flow.openLoot(room, socketId, 'card')).toBeNull();
    expect(flow.inspectBrassLock(room, socketId)).toBe(true);
    expect(flow.isLootOpened(room, socketId)).toBe(false);
    const paid = validateSnapshot(flow.snapshot());
    flow = flowWith();
    flow.continueRun(paid);
    expect(flow.brassKey).toBe('spent');
    expect(flow.inspectBrassLock(room, socketId)).toBe(false);
    expect(flow.openLoot(room, socketId, 'card')).not.toBeNull();
    expect(flow.openLoot(room, socketId, 'card')).toBeNull();
  });

  it('rejects pressure actions on the upper floor', () => {
    const flow = flowWith();
    expect(flow.newRun(SEED)).toBe(true);
    expect(flow.travelToFloor(2, 0)).toBe(true);
    expect(flow.collectPressureNote(0, 'A')).toBeNull();
    expect(flow.turnPressureValve(0, 0)).toBeNull();
    expect(flow.primePressure(0)).toBeNull();
    expect(flow.openPressureDrawer(0)).toBeNull();
    expect(flow.claimPressureReward(0)).toBeNull();
    expect(flow.run?.pressure).toBeUndefined();
  });

  it('walks title, workshop and settings and back', () => {
    const flow = flowWith();
    const seen = phases(flow);
    expect(flow.phase).toBe('title');
    expect(flow.openWorkshop()).toBe(true);
    expect(flow.openSettings()).toBe(false);
    expect(flow.toTitle()).toBe(true);
    expect(flow.openSettings()).toBe(true);
    expect(flow.toTitle()).toBe(true);
    expect(flow.toTitle()).toBe(false);
    expect(seen).toEqual(['workshop', 'title', 'settings', 'title']);
  });

  it('rejects run actions outside their phase', () => {
    const flow = flowWith();
    expect(flow.fightStarted(1)).toBe(false);
    expect(flow.fightEnded({ room: 1, outcome: 'win', tier: 'regular' })).toBe(false);
    expect(flow.pickReward(SKIP_REWARD)).toBe(false);
    expect(flow.snapshot()).toBeNull();
    expect(flow.newRun(SEED)).toBe(true);
    expect(flow.newRun(SEED)).toBe(false);
    expect(flow.openWorkshop()).toBe(false);
    expect(flow.toTitle()).toBe(false);
  });

  it('starts a run with the workshop upgrades applied', () => {
    const ws: WorkshopState = {
      ...createWorkshop(),
      purchased: { 'sturdy-frame': 2, 'spare-die': 1, 'wide-catalog': 1 },
    };
    const flow = flowWith(ws);
    // Hard keeps the workshop's max hp unscaled.
    flow.newRun(SEED, 'hard');
    expect(flow.phase).toBe('explore');
    expect(flow.run).toMatchObject({
      seed: normalizeSeed(SEED),
      maxHp: 70,
      hp: 70,
      bonusDice: 1,
      rewardChoices: 4,
    });
    expect(flow.run?.deck).toEqual(STARTER_DECK);
  });

  it('a win opens the reward, and the chosen card joins the deck with the cogs', () => {
    const flow = flowWith();
    const seen = phases(flow);
    flow.newRun(SEED);
    flow.fightStarted(2);
    expect(flow.fightEnded({ room: 2, outcome: 'win', tier: 'regular', playerHp: 41 })).toBe(true);
    expect(flow.phase).toBe('reward');
    const offer = flow.offer;
    expect(offer?.cards).toHaveLength(3);
    for (const id of offer?.cards ?? []) expect(REWARD_POOL).toContain(id);
    expect(flow.pickReward('not-offered')).toBe(false);
    const card = offer?.cards[1] as string;
    expect(flow.pickReward(card)).toBe(true);
    expect(flow.phase).toBe('explore');
    expect(flow.run?.deck).toEqual([...STARTER_DECK, card]);
    expect(flow.run?.cogs).toBe(offer?.cogs);
    expect(flow.run?.hp).toBe(41);
    expect(flow.cleared).toEqual([2]);
    // A cleared room never starts another fight.
    expect(flow.fightStarted(2)).toBe(false);
    expect(seen).toEqual(['explore', 'combat', 'reward', 'explore']);
  });

  it('fleeing returns to exploring without clearing the room', () => {
    const flow = flowWith();
    flow.newRun(SEED);
    flow.fightStarted(3);
    expect(flow.fightEnded({ room: 3, outcome: 'flee', tier: 'regular' })).toBe(true);
    expect(flow.phase).toBe('explore');
    expect(flow.cleared).toEqual([]);
  });

  it('a defeat goes to the death screen once, banks the purse once, and never fights again', () => {
    const flow = flowWith();
    const events: FlowEvent[] = [];
    flow.onChange((e) => events.push(e));
    flow.newRun(SEED);
    flow.enterRoom(1);
    winRegular(flow, 2);
    const purse = flow.run?.cogs ?? 0;
    expect(purse).toBeGreaterThan(0);
    flow.fightStarted(4);
    expect(flow.fightEnded({ room: 4, outcome: 'defeat', tier: 'regular', playerHp: 0 })).toBe(
      true,
    );
    expect(flow.phase).toBe('death');
    expect(flow.workshop.cogsBanked).toBe(purse);
    expect(flow.summary).toEqual({
      outcome: 'death',
      seed: normalizeSeed(SEED),
      difficulty: 'normal',
      roomsReached: 4,
      fightsWon: 1,
      cogsEarned: purse,
      bankTotal: purse,
    });
    // A second end call for the same fight, or a stray trigger, changes nothing.
    expect(flow.fightEnded({ room: 4, outcome: 'defeat', tier: 'regular' })).toBe(false);
    expect(flow.fightStarted(4)).toBe(false);
    expect(flow.workshop.cogsBanked).toBe(purse);
    expect(events.filter((e) => e.type === 'phase' && e.to === 'death')).toHaveLength(1);
    expect(flow.toTitle()).toBe(true);
    expect(flow.run).toBeNull();
    expect(flow.workshop.cogsBanked).toBe(purse);
  });

  it('clearing the guardian room offers a required card before post-boss exploration', () => {
    const flow = flowWith();
    flow.newRun(SEED);
    winRegular(flow, 1, 'skip');
    const before = flow.run?.cogs ?? 0;
    flow.fightStarted(6);
    expect(flow.fightEnded({ room: 6, outcome: 'win', tier: 'guardian' })).toBe(true);
    expect(flow.phase).toBe('reward');
    expect(flow.guardianDefeated).toBe(true);
    const guardianPurse = flow.run?.cogs;
    expect(flow.finishVictory()).toBe(false);
    expect(flow.toTitle()).toBe(false);
    expect(flow.phase).toBe('reward');
    expect(flow.run?.cogs).toBe(guardianPurse);
    expect(flow.offer).not.toBeNull();
    expect(flow.pickReward(SKIP_REWARD)).toBe(false);
    const card = flow.offer?.cards[0] as string;
    expect(flow.pickReward(card)).toBe(true);
    expect(flow.phase).toBe('guardian-cleared');
    expect(flow.run?.cogs).toBe(before + REWARD_COGS.guardian.min);
    expect(flow.exploreAfterGuardian()).toBe(true);
    expect(flow.phase).toBe('explore');
    expect(flow.finishVictory()).toBe(true);
    expect(flow.phase).toBe('victory');
    expect(flow.finishVictory()).toBe(false);
    expect(flow.summary).toMatchObject({
      outcome: 'victory',
      fightsWon: 2,
      cogsEarned: before + 60,
      bankTotal: before + 60,
    });
    expect(flow.toTitle()).toBe(true);
    expect(flow.phase).toBe('title');
  });

  it('buys upgrades only in the workshop and only when affordable', () => {
    const flow = flowWith({ ...createWorkshop(), cogsBanked: 40 });
    expect(flow.buy('sturdy-frame')).toBe(false);
    flow.openWorkshop();
    expect(flow.canBuy('spare-die')).toBe(false);
    expect(flow.buy('spare-die')).toBe(false);
    expect(flow.buy('sturdy-frame')).toBe(true);
    expect(flow.workshop).toMatchObject({ cogsBanked: 10, purchased: { 'sturdy-frame': 1 } });
    expect(flow.buy('sturdy-frame')).toBe(false);
  });

  it('applies permanent cards once to each new run and preserves a previously saved deck', async () => {
    const card = 'ratchet-flurry';
    const db = await openDb();
    const flow = flowWith({ ...createWorkshop(), cogsBanked: 140 });
    const persistence = bindFlowPersistence(flow, db);
    expect(flow.buyPermanentCard(card)).toBe(false);
    flow.newRun(SEED);
    const oldRun = flow.snapshot();
    if (!oldRun) throw new Error('Expected an active run snapshot');
    flow.abandonRun();
    flow.openWorkshop();
    expect(flow.buyPermanentCard(card)).toBe(true);
    expect(flow.buyPermanentCard(card)).toBe(true);
    await persistence.flushed();
    persistence.dispose();

    const loaded = flowWith(await loadWorkshop(db));
    expect(loaded.workshop.cogsBanked).toBe(20);
    loaded.continueRun(oldRun);
    expect(loaded.run?.deck).toEqual(STARTER_DECK);
    loaded.abandonRun();
    for (const seed of [SEED, 'SPIRE002']) {
      loaded.newRun(seed);
      expect(loaded.run?.deck).toEqual([...STARTER_DECK, card, card]);
      loaded.abandonRun();
    }
  });

  it('every declared transition is reachable from the title', () => {
    const reachable = new Set<FlowPhase>(['title']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const from of reachable) {
        for (const to of FLOW_TRANSITIONS[from]) {
          if (!reachable.has(to)) {
            reachable.add(to);
            grew = true;
          }
        }
      }
    }
    expect([...reachable].sort()).toEqual(Object.keys(FLOW_TRANSITIONS).sort());
  });
});

describe('continue from a snapshot', () => {
  it('keeps a legacy content boundary through a follow-up save, then resets it for a fresh run', () => {
    const source = flowWith();
    source.newRun(SEED);
    const raw = source.snapshot(1, 0) as NonNullable<ReturnType<RunFlow['snapshot']>>;
    const legacy = { ...raw, contentVersion: 1 };
    const resumed = flowWith();
    expect(resumed.continueRun(legacy)).toBe(true);
    expect(resumed.snapshot()?.contentVersion).toBe(1);
    expect(resumed.abandonRun()).toBe(true);
    expect(resumed.newRun('SPIRE002')).toBe(true);
    expect(resumed.snapshot()?.contentVersion).toBe(7);
  });

  it('restores the same run and offer, and continues identically', () => {
    const a = flowWith();
    a.newRun(SEED);
    winRegular(a, 1);
    a.fightStarted(3);
    a.fightEnded({ room: 3, outcome: 'win', tier: 'elite', playerHp: 30 });
    const snap = a.snapshot(1000, 3);
    expect(snap?.phase).toBe('reward');
    expect(snap?.pendingReward).toEqual(a.offer);

    const b = flowWith();
    expect(b.continueRun(structuredClone(snap) as NonNullable<typeof snap>)).toBe(true);
    expect(b.phase).toBe('reward');
    expect(b.run).toEqual(a.run);
    expect(b.offer).toEqual(a.offer);
    expect(b.cleared).toEqual([1, 3]);
    expect(b.room).toBe(3);

    // Same choice, same next fight: identical continuation, including the loot stream.
    const card = a.offer?.cards[2] as string;
    a.pickReward(card);
    b.pickReward(card);
    expect(b.run).toEqual(a.run);
    a.fightStarted(5);
    b.fightStarted(5);
    a.fightEnded({ room: 5, outcome: 'win', tier: 'regular' });
    b.fightEnded({ room: 5, outcome: 'win', tier: 'regular' });
    expect(b.offer).toEqual(a.offer);
    expect(b.run).toEqual(a.run);
  });

  it('resumes an explore snapshot into exploring', () => {
    const a = flowWith();
    a.newRun(SEED);
    winRegular(a, 2);
    const snap = a.snapshot(5, 2);
    const b = flowWith();
    b.continueRun(snap as NonNullable<typeof snap>);
    expect(b.phase).toBe('explore');
    expect(b.offer).toBeNull();
    expect(b.fightStarted(2)).toBe(false);
  });
});

describe('pressure regulator', () => {
  it('collects notes, turns independently, then primes, opens, and claims once', () => {
    const flow = flowWith();
    flow.newRun(SEED);
    const beforeRng = flow.run?.rng;
    const target = pressureTarget(SEED);
    const events: FlowEvent[] = [];
    flow.onChange((event) => events.push(event));

    const firstValve = target.findIndex((value) => value !== 1) as 0 | 1 | 2;
    expect(flow.collectPressureNote(4, 'dispatch')).toMatchObject({
      action: 'note',
      note: 'dispatch',
      reward: 0,
    });
    expect(flow.collectPressureNote(4, 'A')).toMatchObject({ action: 'note', note: 'A' });
    expect(flow.collectPressureNote(4, 'A')).toBeNull();
    expect(flow.collectPressureNote(4, 'B')).toMatchObject({ action: 'note', note: 'B' });
    expect(flow.collectPressureNote(4, 'C')).toMatchObject({ action: 'note', note: 'C' });
    const first = flow.turnPressureValve(4, firstValve);
    expect(first).toMatchObject({ type: 'pressure', action: 'turn', reward: 0, solved: false });
    expect(flow.run?.rng).toEqual(beforeRng);

    for (let valve = 0; valve < 3; valve++) {
      const index = valve as 0 | 1 | 2;
      while (readPressure(flow.run as NonNullable<RunFlow['run']>).dials[valve] !== target[valve]) {
        flow.turnPressureValve(4, index);
      }
    }
    expect(readPressure(flow.run as NonNullable<RunFlow['run']>)).toMatchObject({
      dials: target,
      solved: false,
    });
    expect(flow.run?.cogs).toBe(0);
    expect(flow.primePressure(4)).toMatchObject({ action: 'prime', solved: true, reward: 0 });
    expect(flow.openPressureDrawer(4)).toMatchObject({
      action: 'open',
      drawerOpen: true,
      reward: 0,
    });
    expect(flow.claimPressureReward(4)).toMatchObject({
      action: 'claim',
      reward: 20,
      rewardClaimed: true,
    });
    expect(events.at(-1)).toMatchObject({
      type: 'pressure',
      action: 'claim',
      reward: 20,
      solved: true,
    });
    expect(flow.claimPressureReward(4)).toBeNull();
    expect(flow.run?.cogs).toBe(20);
  });

  it('persists a partial turn and restores it across export-shaped snapshots', async () => {
    const db = await openDb();
    const source = flowWith();
    const saved = bindFlowPersistence(source, db);
    source.newRun(SEED);
    const target = pressureTarget(SEED);
    const valve = target.findIndex((value) => value !== 1) as 0 | 1 | 2;
    expect(source.turnPressureValve(2, valve)).not.toBeNull();
    await saved.flushed();
    const stored = await loadRunSnapshot(db);
    expect(stored?.run.pressure?.solved).toBe(false);
    expect(stored?.run.pressure?.dials).toEqual(
      readPressure(source.run as NonNullable<RunFlow['run']>).dials,
    );

    const restored = flowWith();
    expect(restored.continueRun(structuredClone(stored) as NonNullable<typeof stored>)).toBe(true);
    expect(restored.pressure).toEqual(source.pressure);
    expect(restored.turnPressureValve(2, valve)).not.toBeNull();
    saved.dispose();
  });

  it('round-trips collected, solved-closed, and open-unclaimed pressure without awarding twice', async () => {
    const db = await openDb();
    const source = flowWith();
    const saved = bindFlowPersistence(source, db);
    source.newRun(SEED);
    source.collectPressureNote(1, 'A');
    await saved.flushed();
    const collected = await loadRunSnapshot(db);
    expect(collected?.run.pressure).toMatchObject({
      notes: ['A'],
      solved: false,
      drawerOpen: false,
      rewardClaimed: false,
    });
    const imported = await exportSave(db);
    await importSave(db, imported);
    expect((await loadRunSnapshot(db))?.run.pressure).toMatchObject({ notes: ['A'] });

    for (const id of ['B', 'C'] as const) source.collectPressureNote(1, id);
    const target = pressureTarget(SEED);
    for (let i = 0; i < 3; i++)
      while (source.pressure.dials[i] !== target[i]) source.turnPressureValve(1, i as 0 | 1 | 2);
    source.primePressure(1);
    await saved.flushed();
    const solvedClosed = await loadRunSnapshot(db);
    expect(solvedClosed?.run.pressure).toMatchObject({
      solved: true,
      drawerOpen: false,
      rewardClaimed: false,
    });
    const restored = flowWith();
    restored.continueRun(structuredClone(solvedClosed) as NonNullable<typeof solvedClosed>);
    expect(restored.claimPressureReward(1)).toBeNull();
    expect(restored.openPressureDrawer(1)?.reward).toBe(0);
    expect(restored.claimPressureReward(1)?.reward).toBe(20);
    expect(restored.claimPressureReward(1)).toBeNull();
    expect(restored.run?.cogs).toBe(20);
    saved.dispose();
  });

  it('normalizes legacy solved saves as already paid and rejects invalid combinations', () => {
    const source = flowWith();
    source.newRun(SEED);
    const raw = source.snapshot(1, 0) as NonNullable<ReturnType<RunFlow['snapshot']>>;
    const legacy = structuredClone(raw) as unknown as Record<string, unknown>;
    const run = legacy.run as Record<string, unknown>;
    legacy.contentVersion = 3;
    run.pressure = { dials: pressureTarget(SEED, 3), solved: true };
    const validated = validateSnapshot(legacy);
    expect(validated.run.pressure).toMatchObject({
      solved: true,
      notes: [],
      drawerOpen: true,
      rewardClaimed: true,
    });
    const restored = flowWith();
    restored.continueRun(validated);
    expect(restored.snapshot()?.run.pressure).toMatchObject({
      solved: true,
      notes: [],
      drawerOpen: true,
      rewardClaimed: true,
    });
    expect(restored.openPressureDrawer(0)).toBeNull();
    expect(restored.claimPressureReward(0)).toBeNull();
    expect(restored.run?.cogs).toBe(0);

    for (const pressure of [
      { dials: pressureTarget(SEED), solved: false, rewardClaimed: true },
      { dials: pressureTarget(SEED), solved: false, drawerOpen: true },
      { dials: pressureTarget(SEED), solved: true, drawerOpen: false, rewardClaimed: true },
      { dials: pressureTarget(SEED), solved: false, notes: ['A', 'A'] },
      { dials: pressureTarget(SEED), solved: false, notes: ['D'] },
    ]) {
      const bad = structuredClone(raw) as unknown as Record<string, unknown>;
      (bad.run as Record<string, unknown>).pressure = pressure;
      expect(() => validateSnapshot(bad)).toThrow();
    }
  });

  it('accepts v1/v2 snapshots without pressure and refuses pressure outside exploration', () => {
    const source = flowWith();
    source.newRun(SEED);
    const raw = source.snapshot(1, 0) as NonNullable<ReturnType<RunFlow['snapshot']>>;
    const legacy = structuredClone(raw) as unknown as Record<string, unknown>;
    legacy.contentVersion = 2;
    const legacyRun = legacy.run as unknown as Record<string, unknown>;
    delete legacyRun.pressure;
    const validated = validateSnapshot(legacy);
    expect(validated.run.pressure).toBeUndefined();
    const restored = flowWith();
    expect(restored.continueRun(validated)).toBe(true);
    expect(restored.snapshot()?.contentVersion).toBe(2);
    const events: FlowEvent[] = [];
    restored.onChange((event) => events.push(event));
    expect(restored.turnPressureValve(0, 0)).toBeNull();
    expect(events).toEqual([]);
    expect(restored.fightStarted(1)).toBe(true);
    expect(restored.turnPressureValve(0, 0)).toBeNull();

    const missingVersion = structuredClone(raw) as unknown as Record<string, unknown>;
    delete missingVersion.contentVersion;
    const missing = flowWith();
    expect(missing.continueRun(validateSnapshot(missingVersion))).toBe(true);
    expect(missing.turnPressureValve(0, 0)).toBeNull();

    const fresh = flowWith();
    fresh.newRun(SEED);
    expect(fresh.turnPressureValve(-1, 0)).toBeNull();
    expect(fresh.turnPressureValve(1.5, 0)).toBeNull();
    expect(fresh.turnPressureValve(0, 3 as 0 | 1 | 2)).toBeNull();
  });
});

describe('flow persistence', () => {
  it('snapshots at explore and reward, then clears it and banks exactly once at run end', async () => {
    const db = await openDb(undefined);
    const flow = flowWith();
    const saved = bindFlowPersistence(flow, db);
    flow.newRun(SEED);
    await saved.flushed();
    expect((await loadRunSnapshot(db))?.phase).toBe('explore');

    flow.fightStarted(2);
    flow.fightEnded({ room: 2, outcome: 'win', tier: 'regular' });
    await saved.flushed();
    const atReward = await loadRunSnapshot(db);
    expect(atReward?.phase).toBe('reward');
    expect(atReward?.pendingReward).toEqual(flow.offer);

    flow.pickReward(SKIP_REWARD);
    const purse = flow.run?.cogs ?? 0;
    flow.fightStarted(4);
    flow.fightEnded({ room: 4, outcome: 'defeat', tier: 'regular' });
    flow.fightEnded({ room: 4, outcome: 'defeat', tier: 'regular' });
    flow.toTitle();
    await saved.flushed();
    expect(await loadRunSnapshot(db)).toBeNull();
    expect((await loadWorkshop(db)).cogsBanked).toBe(purse);

    flow.openWorkshop();
    flow.buy('sturdy-frame');
    await saved.flushed();
    const ws = await loadWorkshop(db);
    expect(ws.purchased['sturdy-frame']).toBe(purse >= 30 ? 1 : 0);
    saved.dispose();
  });
});

describe('floor triggers after a defeat', () => {
  it('a lost fight never re-triggers while the flow holds the death screen', () => {
    const scene = new THREE.Scene();
    const view = mountFloorView(scene, new THREE.Group(), SEED);
    const [room, bodies] = [...view.world.enemies].find(([, b]) => b.length > 0) ?? [];
    const target = new THREE.Vector3();
    bodies?.[0]?.getWorldPosition(target);
    const head = new THREE.Object3D();
    scene.add(head);
    head.position.set(target.x, 1.2, target.z + 1);
    view.world.update(head.position.x, head.position.z);
    const step = (seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / 60) {
        head.updateMatrixWorld(true);
        view.update(head, 1 / 60);
      }
    };
    step(1.2);
    expect(view.encounter.phase).toBe('active');
    expect(view.encounter.activeRoom).toBe(room);

    view.suspendTriggers = true;
    view.encounter.end('defeat');
    step(4);
    expect(view.encounter.phase).toBe('idle');
    expect(view.locked).toBe(false);

    // A defeat leaves the automatons on their combat slots, clear of the seat (H1). Walking up to
    // one stays quiet while suspended; without the suspension it fights again, which the flow prevents.
    bodies?.[0]?.getWorldPosition(target);
    head.position.set(target.x, 1.2, target.z + 1);
    step(2);
    expect(view.encounter.phase).toBe('idle');
    view.suspendTriggers = false;
    step(0.5);
    expect(view.encounter.phase).not.toBe('idle');
    view.dispose();
    expect(scene.children.filter((c) => c !== head)).toHaveLength(0);
  });

  it('markCleared removes a room from the encounter triggers', () => {
    const scene = new THREE.Scene();
    const view = mountFloorView(scene, new THREE.Group(), SEED);
    const [room, bodies] = [...view.world.enemies].find(([, b]) => b.length > 0) ?? [];
    const target = new THREE.Vector3();
    bodies?.[0]?.getWorldPosition(target);
    view.markCleared(room as number);
    view.world.update(target.x, target.z + 1);
    expect(view.encounter.checkTrigger({ x: target.x, z: target.z + 1 })).toBeNull();
    expect(view.standPoint(room as number)).not.toBeNull();
    expect(view.standPoint(999)).toBeNull();
    view.dispose();
  });
});
