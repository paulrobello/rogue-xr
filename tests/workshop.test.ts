// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { PERMANENT_CARD_IDS, REWARD_POOL } from '../src/content/rewards.ts';
import type { PersistDb } from '../src/persist/db.ts';
import {
  closeDb,
  DEFAULT_SETTINGS,
  loadSettings,
  openDb,
  saveSettings,
} from '../src/persist/db.ts';
import {
  clearRunSnapshot,
  exportSave,
  importSave,
  loadRunSnapshot,
  loadWorkshop,
  type RunSnapshot,
  SaveError,
  saveRunSnapshot,
  saveWorkshop,
  snapshotRun,
  validateSnapshot,
} from '../src/persist/saves.ts';
import {
  bankRunCogs,
  buyPermanentCard,
  buyUpgrade,
  canBuyPermanentCard,
  chooseReward,
  createRun,
  createWorkshop,
  maxTier,
  nextCost,
  REWARD_CHOICES,
  RulesError,
  type RunState,
  rewardOffer,
  runOptionsFrom,
  UPGRADE_IDS,
  UPGRADES,
  type WorkshopState,
} from '../src/rules/index.ts';

const SEED = 'SP1RE001';
const WORLD = {
  phase: 'explore',
  floorSeed: 'FL00R001',
  roomIndex: 4,
  clearedEncounters: ['enc-1', 'enc-3'],
} as const;

const open: PersistDb[] = [];
async function freshDb(factory = new IDBFactory()): Promise<PersistDb> {
  const handle = await openDb(factory);
  expect(handle.persistent).toBe(true);
  open.push(handle);
  return handle;
}
afterEach(() => {
  for (const handle of open.splice(0)) closeDb(handle);
});

const withCogs = (ws: WorkshopState, cogs: number): WorkshopState => ({
  ...ws,
  cogsBanked: ws.cogsBanked + cogs,
});

/** One deterministic reward step: roll an elite offer, take its first card. */
function step(run: RunState): RunState {
  const { run: rolled, offer } = rewardOffer(run, 'elite', REWARD_POOL);
  return chooseReward(rolled, offer, offer.cards[0] as string);
}
const steps = (run: RunState, n: number): RunState =>
  Array.from({ length: n }).reduce<RunState>((r) => step(r), run);

describe('upgrade table', () => {
  it('defines three upgrades with positive increasing costs', () => {
    expect(UPGRADE_IDS).toHaveLength(3);
    for (const id of UPGRADE_IDS) {
      const { costs } = UPGRADES[id];
      expect(UPGRADES[id].id).toBe(id);
      expect(costs.length).toBeGreaterThan(0);
      expect(costs.every((c, i) => c > 0 && (i === 0 || c > (costs[i - 1] as number)))).toBe(true);
    }
  });
});

describe('buyUpgrade', () => {
  it('spends the tier cost and advances the tier', () => {
    const ws = buyUpgrade(withCogs(createWorkshop(), 100), 'sturdy-frame');
    expect(ws.purchased['sturdy-frame']).toBe(1);
    expect(ws.cogsBanked).toBe(100 - (UPGRADES['sturdy-frame'].costs[0] as number));
  });

  it('charges each tier its own price and stops at the cap', () => {
    let ws = withCogs(createWorkshop(), 1000);
    const start = ws.cogsBanked;
    for (let tier = 0; tier < maxTier('sturdy-frame'); tier++) {
      expect(nextCost(ws, 'sturdy-frame')).toBe(UPGRADES['sturdy-frame'].costs[tier]);
      ws = buyUpgrade(ws, 'sturdy-frame');
    }
    expect(nextCost(ws, 'sturdy-frame')).toBeNull();
    expect(ws.cogsBanked).toBe(start - UPGRADES['sturdy-frame'].costs.reduce((a, b) => a + b, 0));
    expect(() => buyUpgrade(ws, 'sturdy-frame')).toThrow(RulesError);
  });

  it('throws when cogs are insufficient and leaves the input untouched', () => {
    const ws = withCogs(createWorkshop(), (UPGRADES['spare-die'].costs[0] as number) - 1);
    expect(() => buyUpgrade(ws, 'spare-die')).toThrow(RulesError);
    expect(ws.purchased['spare-die']).toBe(0);
  });

  it('throws for an unknown upgrade id', () => {
    expect(() => buyUpgrade(withCogs(createWorkshop(), 999), 'nope' as never)).toThrow(RulesError);
  });
});

describe('bankRunCogs', () => {
  it('adds the run purse to the bank', () => {
    const run = { ...createRun(SEED, STARTER_DECK), cogs: 42 };
    expect(bankRunCogs(withCogs(createWorkshop(), 8), run).cogsBanked).toBe(50);
  });
});

describe('permanent cards', () => {
  it('buys an available card immutably and reports validity', () => {
    const ws = withCogs(createWorkshop(), 60);
    const id = PERMANENT_CARD_IDS[0] as string;
    expect(canBuyPermanentCard(ws, id, PERMANENT_CARD_IDS)).toBe(true);
    const bought = buyPermanentCard(ws, id, PERMANENT_CARD_IDS);
    expect(bought).toMatchObject({ cogsBanked: 0, permanentCards: [id] });
    expect(ws.permanentCards).toEqual([]);
    expect(canBuyPermanentCard(bought, id, PERMANENT_CARD_IDS)).toBe(false);
  });

  it('buys repeated copies at the same per-copy price', () => {
    const id = PERMANENT_CARD_IDS[0] as string;
    const twice = buyPermanentCard(
      buyPermanentCard(withCogs(createWorkshop(), 120), id, PERMANENT_CARD_IDS),
      id,
      PERMANENT_CARD_IDS,
    );
    expect(twice).toMatchObject({ cogsBanked: 0, permanentCards: [id, id] });
  });

  it('rejects a repeated copy when the remaining balance is insufficient', () => {
    const id = PERMANENT_CARD_IDS[0] as string;
    const once = buyPermanentCard(withCogs(createWorkshop(), 60), id, PERMANENT_CARD_IDS);
    expect(canBuyPermanentCard(once, id, PERMANENT_CARD_IDS)).toBe(false);
    expect(() => buyPermanentCard(once, id, PERMANENT_CARD_IDS)).toThrow(RulesError);
  });

  it('charges 120 cogs for a permanent Escapement Hammer', () => {
    const id = 'escapement-hammer';
    expect(canBuyPermanentCard(withCogs(createWorkshop(), 119), id, PERMANENT_CARD_IDS)).toBe(
      false,
    );
    expect(buyPermanentCard(withCogs(createWorkshop(), 120), id, PERMANENT_CARD_IDS)).toMatchObject(
      { cogsBanked: 0, permanentCards: [id] },
    );
  });

  it('rejects unavailable and unaffordable cards', () => {
    const id = PERMANENT_CARD_IDS[0] as string;
    expect(canBuyPermanentCard(createWorkshop(), id, PERMANENT_CARD_IDS)).toBe(false);
    expect(() => buyPermanentCard(createWorkshop(), id, PERMANENT_CARD_IDS)).toThrow(RulesError);
    expect(() =>
      buyPermanentCard(
        withCogs(createWorkshop(), 60),
        STARTER_DECK[0] as string,
        PERMANENT_CARD_IDS,
      ),
    ).toThrow(RulesError);
  });
});

describe('runOptionsFrom', () => {
  it('a fresh workshop reproduces the baseline run', () => {
    const base = createRun(SEED, STARTER_DECK);
    const run = createRun(SEED, STARTER_DECK, runOptionsFrom(createWorkshop()));
    expect(run.maxHp).toBe(base.maxHp);
    expect(run.hp).toBe(base.hp);
    expect(rewardOffer(run, 'regular', REWARD_POOL).offer).toEqual(
      rewardOffer(base, 'regular', REWARD_POOL).offer,
    );
  });

  it('applies hp, dice and reward-choice tiers to createRun', () => {
    let ws = withCogs(createWorkshop(), 2000);
    for (let i = 0; i < 2; i++) ws = buyUpgrade(ws, 'sturdy-frame');
    ws = buyUpgrade(ws, 'spare-die');
    ws = buyUpgrade(ws, 'wide-catalog');
    const run = createRun(SEED, STARTER_DECK, runOptionsFrom(ws));
    expect(run.maxHp).toBe(createRun(SEED, STARTER_DECK).maxHp + 10);
    expect(run.hp).toBe(run.maxHp);
    expect(run.bonusDice).toBe(1);
    expect(run.rewardChoices).toBe(REWARD_CHOICES + 1);
    expect(rewardOffer(run, 'regular', REWARD_POOL).offer.cards).toHaveLength(REWARD_CHOICES + 1);
  });

  it('a maxed workshop offers every tier of choice and the pool covers it', () => {
    let ws = withCogs(createWorkshop(), 5000);
    for (const id of UPGRADE_IDS) for (let t = 0; t < maxTier(id); t++) ws = buyUpgrade(ws, id);
    const opts = runOptionsFrom(ws);
    expect(opts.rewardChoices).toBe(REWARD_CHOICES + maxTier('wide-catalog'));
    expect(new Set(REWARD_POOL).size).toBeGreaterThanOrEqual(opts.rewardChoices);
  });
});

describe('workshop persistence', () => {
  it('starts fresh, then survives close and reopen', async () => {
    const factory = new IDBFactory();
    const first = await freshDb(factory);
    expect(await loadWorkshop(first)).toEqual(createWorkshop());
    const ws = buyUpgrade(withCogs(createWorkshop(), 75), 'sturdy-frame');
    await saveWorkshop(first, ws);
    closeDb(first);

    const second = await freshDb(factory);
    expect(await loadWorkshop(second)).toEqual(ws);
  });

  it('refuses to load a corrupt stored workshop', async () => {
    const handle = await freshDb();
    const { putWorkshop } = await import('../src/persist/db.ts');
    await putWorkshop(handle, { version: 1, cogsBanked: -5, purchased: {} });
    await expect(loadWorkshop(handle)).rejects.toBeInstanceOf(SaveError);
  });

  it('loads old workshop saves with purchases defaulted without changing upgrades', async () => {
    const handle = await freshDb();
    const { putWorkshop } = await import('../src/persist/db.ts');
    await putWorkshop(handle, {
      version: 1,
      cogsBanked: 17,
      purchased: { 'sturdy-frame': 2, 'spare-die': 1, 'wide-catalog': 0 },
    });
    await expect(loadWorkshop(handle)).resolves.toEqual({
      ...createWorkshop(),
      cogsBanked: 17,
      purchased: { 'sturdy-frame': 2, 'spare-die': 1, 'wide-catalog': 0 },
    });
  });

  it('loads repeated permanent cards and rejects unavailable cards', async () => {
    const handle = await freshDb();
    const { putWorkshop } = await import('../src/persist/db.ts');
    const id = PERMANENT_CARD_IDS[0] as string;
    await putWorkshop(handle, { ...createWorkshop(), permanentCards: [id, id] });
    await expect(loadWorkshop(handle)).resolves.toMatchObject({ permanentCards: [id, id] });
    for (const permanentCards of [[STARTER_DECK[0]], ['not-a-card']]) {
      await putWorkshop(handle, { ...createWorkshop(), permanentCards });
      await expect(loadWorkshop(handle)).rejects.toBeInstanceOf(SaveError);
    }
  });

  it('refuses to save an over-maxed workshop', async () => {
    const handle = await freshDb();
    const bad: WorkshopState = {
      ...createWorkshop(),
      purchased: { 'sturdy-frame': 99, 'spare-die': 0, 'wide-catalog': 0 },
    };
    await expect(saveWorkshop(handle, bad)).rejects.toBeInstanceOf(SaveError);
  });
});

describe('run snapshots', () => {
  const startRun = (): RunState =>
    createRun(
      SEED,
      STARTER_DECK,
      runOptionsFrom(buyUpgrade(withCogs(createWorkshop(), 100), 'sturdy-frame')),
    );

  it('resumes to an identical continuation through JSON and IndexedDB', async () => {
    const factory = new IDBFactory();
    const before = await freshDb(factory);
    const midRun = steps(startRun(), 2);
    await saveRunSnapshot(before, snapshotRun(midRun, WORLD, 1_700_000_000_000));
    closeDb(before);

    const after = await freshDb(factory);
    const loaded = await loadRunSnapshot(after);
    expect(loaded).not.toBeNull();
    const snapshot = loaded as RunSnapshot;
    expect(snapshot.run).toEqual(midRun);
    expect(snapshot).toMatchObject({ ...WORLD, pendingReward: null, savedAt: 1_700_000_000_000 });

    const viaJson = validateSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(steps(viaJson.run, 3)).toEqual(steps(midRun, 3));
  });

  it('keeps a pending reward so resuming does not re-roll the loot stream', () => {
    const { run, offer } = rewardOffer(startRun(), 'regular', REWARD_POOL);
    const snap = validateSnapshot(
      JSON.parse(
        JSON.stringify(snapshotRun(run, { ...WORLD, phase: 'reward', pendingReward: offer })),
      ),
    );
    expect(snap.pendingReward).toEqual(offer);
    const pick = offer.cards[1] as string;
    expect(chooseReward(snap.run, snap.pendingReward as typeof offer, pick)).toEqual(
      chooseReward(run, offer, pick),
    );
  });

  it('detaches the snapshot from the live run', () => {
    const run = startRun();
    const snap = snapshotRun(run, WORLD);
    expect(snap.run).toEqual(run);
    expect(snap.run).not.toBe(run);
    expect(snap.run.deck).not.toBe(run.deck);
  });

  it('clears a stored snapshot', async () => {
    const handle = await freshDb();
    await saveRunSnapshot(handle, snapshotRun(startRun(), WORLD));
    await clearRunSnapshot(handle);
    expect(await loadRunSnapshot(handle)).toBeNull();
  });

  it('rejects wrong versions and corrupt payloads', () => {
    const good = JSON.parse(JSON.stringify(snapshotRun(startRun(), WORLD))) as Record<
      string,
      unknown
    >;
    const run = good.run as Record<string, unknown>;
    const rng = run.rng as Record<string, unknown>;
    const corrupt: unknown[] = [
      null,
      'snapshot',
      { ...good, version: 2 },
      { ...good, phase: 'combat' },
      { ...good, phase: 'reward' },
      { ...good, roomIndex: -1 },
      { ...good, clearedEncounters: [1] },
      { ...good, run: { ...run, seed: 'UUUUUUUU' } },
      { ...good, run: { ...run, hp: (run.maxHp as number) + 1 } },
      { ...good, run: { ...run, deck: 'strike' } },
      { ...good, run: { ...run, rng: { ...rng, loot: [1, 2, 3] } } },
      { ...good, run: { ...run, rng: { ...rng, ai: [1, 2, 3, 1.5] } } },
      { ...good, run: { ...run, rng: { ...rng, dice: undefined } } },
    ];
    for (const raw of corrupt) expect(() => validateSnapshot(raw)).toThrow(SaveError);
  });
});

describe('export and import', () => {
  async function populated(): Promise<{ handle: PersistDb; ws: WorkshopState; snap: RunSnapshot }> {
    const handle = await freshDb();
    const upgraded = buyUpgrade(
      buyUpgrade(withCogs(createWorkshop(), 360), 'spare-die'),
      'wide-catalog',
    );
    const card = PERMANENT_CARD_IDS[0] as string;
    const ws = buyPermanentCard(
      buyPermanentCard(upgraded, card, PERMANENT_CARD_IDS),
      card,
      PERMANENT_CARD_IDS,
    );
    const snap = snapshotRun(
      steps(createRun(SEED, STARTER_DECK, runOptionsFrom(ws)), 2),
      WORLD,
      1_700_000_000_000,
    );
    await saveWorkshop(handle, ws);
    await saveRunSnapshot(handle, snap);
    await saveSettings(handle, { ...DEFAULT_SETTINGS, snapDegrees: 45, vignette: false });
    return { handle, ws, snap };
  }

  it('round-trips workshop, run snapshot and settings into a fresh database', async () => {
    const { handle, ws, snap } = await populated();
    const json = await exportSave(handle, 1_700_000_001_000);
    expect(JSON.parse(json)).toMatchObject({ format: 'rogue-xr-save', schemaVersion: 1 });

    const target = await freshDb();
    await importSave(target, json);
    expect(await loadWorkshop(target)).toEqual(ws);
    expect(await loadRunSnapshot(target)).toEqual(snap);
    expect((await loadSettings(target)).snapDegrees).toBe(45);
    expect(await exportSave(target, 1_700_000_001_000)).toBe(json);
  });

  it('import replaces existing saves and clears a snapshot the export lacks', async () => {
    const { handle } = await populated();
    await clearRunSnapshot(handle);
    const json = await exportSave(handle);
    const target = await freshDb();
    await saveRunSnapshot(target, snapshotRun(createRun(SEED, STARTER_DECK), WORLD));
    await importSave(target, json);
    expect(await loadRunSnapshot(target)).toBeNull();
  });

  it('rejects corrupt imports without writing anything', async () => {
    const { handle } = await populated();
    const good = JSON.parse(await exportSave(handle)) as Record<string, unknown>;
    const target = await freshDb();
    const ws = buyUpgrade(withCogs(createWorkshop(), 50), 'sturdy-frame');
    await saveWorkshop(target, ws);

    const bad: string[] = [
      '',
      '{not json',
      '[]',
      JSON.stringify({ ...good, format: 'other' }),
      JSON.stringify({ ...good, schemaVersion: 99 }),
      JSON.stringify({ ...good, workshop: { version: 1, cogsBanked: 'lots', purchased: {} } }),
      JSON.stringify({
        ...good,
        workshop: { version: 1, cogsBanked: 0, purchased: { 'sturdy-frame': 9 } },
      }),
      JSON.stringify({ ...good, run: { ...(good.run as object), version: 7 } }),
    ];
    for (const json of bad) {
      await expect(importSave(target, json)).rejects.toBeInstanceOf(SaveError);
    }
    expect(await loadWorkshop(target)).toEqual(ws);
    expect(await loadRunSnapshot(target)).toBeNull();
  });
});

describe('rules/workshop.ts purity', () => {
  it('imports only rules siblings', () => {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '../src/rules/workshop.ts');
    const source = readFileSync(file, 'utf8');
    const specs = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const spec of specs) expect(spec).toMatch(/^\.\/[\w-]+\.ts$/);
    expect(source).not.toMatch(/\b(?:Math\.random|Date\.now|indexedDB|crypto\.)/);
  });
});
