// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CARDS_BY_ID, STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { STREAMS } from '../src/core/rng.ts';
import {
  chooseReward,
  createRun,
  REWARD_CHOICES,
  REWARD_COGS,
  type RewardTier,
  RulesError,
  type RunState,
  rewardOffer,
  TREASURE_COGS,
  treasureLoot,
} from '../src/rules/index.ts';

const SEED = 'SP1RE000';
const SEEDS = ['AAAAAAAA', 'BBBBBBBB', 'CCCCCCCC', 'DDDDDDDD', 'EEEEEEEE', 'FFFFFFFF'];
const TIERS: RewardTier[] = ['regular', 'elite', 'guardian'];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const newRun = (seed = SEED): RunState => createRun(seed, STARTER_DECK);

describe('REWARD_POOL', () => {
  it('holds real base cards without the starter basics', () => {
    expect(REWARD_POOL.length).toBeGreaterThanOrEqual(REWARD_CHOICES);
    expect(new Set(REWARD_POOL).size).toBe(REWARD_POOL.length);
    for (const id of REWARD_POOL) expect(CARDS_BY_ID.has(id)).toBe(true);
    expect(REWARD_POOL).not.toContain('strike');
    expect(REWARD_POOL).not.toContain('defend');
  });
});

describe('createRun', () => {
  it('copies the starter deck and starts with full hp and no cogs', () => {
    const run = newRun();
    expect(run.deck).toEqual(STARTER_DECK);
    expect(run.deck).not.toBe(STARTER_DECK);
    expect(run.cogs).toBe(0);
    expect(run.hp).toBe(run.maxHp);
    expect(Object.keys(run.rng).sort()).toEqual([...STREAMS].sort());
  });

  it('normalizes the seed and honors options', () => {
    const run = createRun('sp1re-000', [], { maxHp: 40, hp: 25, cogs: 7 });
    expect(run.seed).toBe(SEED);
    expect([run.maxHp, run.hp, run.cogs]).toEqual([40, 25, 7]);
  });

  it('rejects bad options', () => {
    expect(() => createRun(SEED, [], { maxHp: 0 })).toThrow(RulesError);
    expect(() => createRun(SEED, [], { maxHp: 10, hp: 11 })).toThrow(RulesError);
    expect(() => createRun(SEED, [], { cogs: -1 })).toThrow(RulesError);
  });
});

describe('rewardOffer', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = rewardOffer(newRun(), 'regular', REWARD_POOL).offer;
    const b = rewardOffer(newRun(), 'regular', REWARD_POOL).offer;
    expect(a).toEqual(b);
    const offers = new Set(
      SEEDS.map((seed) => JSON.stringify(rewardOffer(newRun(seed), 'regular', REWARD_POOL).offer)),
    );
    expect(offers.size).toBeGreaterThan(1);
  });

  it('offers three distinct pool cards', () => {
    for (const seed of [...SEEDS, SEED]) {
      for (const tier of TIERS) {
        const { cards } = rewardOffer(newRun(seed), tier, REWARD_POOL).offer;
        expect(cards).toHaveLength(REWARD_CHOICES);
        expect(new Set(cards).size).toBe(REWARD_CHOICES);
        for (const id of cards) expect(REWARD_POOL).toContain(id);
      }
    }
  });

  it('de-duplicates a pool with repeated ids', () => {
    const { cards } = rewardOffer(newRun(), 'regular', ['a', 'a', 'b', 'b', 'c']).offer;
    expect([...cards].sort()).toEqual(['a', 'b', 'c']);
  });

  it('throws when the pool has fewer than three distinct cards', () => {
    expect(() => rewardOffer(newRun(), 'regular', ['a', 'a', 'b'])).toThrow(RulesError);
  });

  it('advances only the loot stream', () => {
    const run = newRun();
    const next = rewardOffer(run, 'elite', REWARD_POOL).run;
    expect(next.rng.loot).not.toEqual(run.rng.loot);
    for (const name of STREAMS) {
      if (name !== 'loot') expect(next.rng[name]).toBe(run.rng[name]);
    }
    expect(next.deck).toBe(run.deck);
    expect(next.cogs).toBe(run.cogs);
  });

  it('pays cogs inside each tier range', () => {
    for (const tier of TIERS) {
      const { min, max } = REWARD_COGS[tier];
      for (const seed of SEEDS) {
        const { cogs } = rewardOffer(newRun(seed), tier, REWARD_POOL).offer;
        expect(cogs).toBeGreaterThanOrEqual(min);
        expect(cogs).toBeLessThanOrEqual(max);
      }
    }
    expect(rewardOffer(newRun(), 'guardian', REWARD_POOL).offer.cogs).toBe(60);
  });

  it('does not mutate frozen input', () => {
    const run = deepFreeze(newRun());
    const pool = deepFreeze([...REWARD_POOL]);
    expect(() => rewardOffer(run, 'regular', pool)).not.toThrow();
    expect(run.rng.loot).toEqual(newRun().rng.loot);
  });
});

describe('chooseReward', () => {
  it('appends the chosen card and pays the cogs', () => {
    const { run, offer } = rewardOffer(newRun(), 'regular', REWARD_POOL);
    const pick = offer.cards[1] as string;
    const after = chooseReward(run, offer, pick);
    expect(after.deck).toEqual([...run.deck, pick]);
    expect(after.deck).toHaveLength(run.deck.length + 1);
    expect(after.cogs).toBe(run.cogs + offer.cogs);
    expect(after.rng).toBe(run.rng);
  });

  it('skip keeps the deck but still pays the cogs', () => {
    const { run, offer } = rewardOffer(newRun(), 'elite', REWARD_POOL);
    const after = chooseReward(run, offer, 'skip');
    expect(after.deck).toBe(run.deck);
    expect(after.cogs).toBe(offer.cogs);
  });

  it('throws RulesError for a card outside the offer and pays nothing', () => {
    const { run, offer } = rewardOffer(newRun(), 'regular', REWARD_POOL);
    const outside = REWARD_POOL.find((id) => !offer.cards.includes(id)) as string;
    expect(() => chooseReward(run, offer, outside)).toThrow(RulesError);
    expect(() => chooseReward(run, offer, 'no-such-card')).toThrow(RulesError);
    expect(run.cogs).toBe(0);
  });

  it('does not mutate frozen input', () => {
    const { run, offer } = rewardOffer(newRun(), 'regular', REWARD_POOL);
    deepFreeze(run);
    deepFreeze(offer);
    expect(() => chooseReward(run, offer, offer.cards[0] as string)).not.toThrow();
    expect(() => chooseReward(run, offer, 'skip')).not.toThrow();
  });

  it('totals cogs and deck growth over a scripted sequence of encounters, replayably', () => {
    const script: { tier: RewardTier; pick: boolean }[] = [
      { tier: 'regular', pick: true },
      { tier: 'regular', pick: false },
      { tier: 'elite', pick: true },
      { tier: 'regular', pick: true },
      { tier: 'guardian', pick: false },
    ];
    const play = (): { run: RunState; paid: number } => {
      let run = newRun();
      let paid = 0;
      for (const { tier, pick } of script) {
        const rolled = rewardOffer(run, tier, REWARD_POOL);
        paid += rolled.offer.cogs;
        run = chooseReward(
          rolled.run,
          rolled.offer,
          pick ? (rolled.offer.cards[0] as string) : 'skip',
        );
        expect(run.cogs).toBe(paid);
      }
      return { run, paid };
    };
    const first = play();
    expect(first.run.deck).toHaveLength(STARTER_DECK.length + 3);
    expect(first.paid).toBeGreaterThanOrEqual(10 + 10 + 25 + 10 + 60);
    expect(first.paid).toBeLessThanOrEqual(15 + 15 + 35 + 15 + 60);
    expect(play().run).toEqual(first.run);
  });
});

describe('treasureLoot', () => {
  it('cogs pickup pays inside the treasure range and moves only loot', () => {
    const run = newRun();
    const { run: after, loot } = treasureLoot(run, 'cogs', REWARD_POOL);
    expect(loot.kind).toBe('cogs');
    const cogs = loot.kind === 'cogs' ? loot.cogs : -1;
    expect(cogs).toBeGreaterThanOrEqual(TREASURE_COGS.min);
    expect(cogs).toBeLessThanOrEqual(TREASURE_COGS.max);
    expect(after.cogs).toBe(cogs);
    expect(after.deck).toBe(run.deck);
    for (const name of STREAMS) {
      if (name !== 'loot') expect(after.rng[name]).toBe(run.rng[name]);
    }
    expect(after.rng.loot).not.toEqual(run.rng.loot);
  });

  it('card pickup adds one pool card to the deck and is deterministic', () => {
    const a = treasureLoot(newRun(), 'card', REWARD_POOL);
    const b = treasureLoot(newRun(), 'card', REWARD_POOL);
    expect(a).toEqual(b);
    expect(a.loot.kind).toBe('card');
    const card = a.loot.kind === 'card' ? a.loot.card : '';
    expect(REWARD_POOL).toContain(card);
    expect(a.run.deck).toEqual([...STARTER_DECK, card]);
    expect(a.run.cogs).toBe(0);
  });

  it('throws on an empty pool for a card pickup and ignores the pool for cogs', () => {
    expect(() => treasureLoot(newRun(), 'card', [])).toThrow(RulesError);
    expect(() => treasureLoot(newRun(), 'cogs', [])).not.toThrow();
  });

  it('does not mutate frozen input', () => {
    const run = deepFreeze(newRun());
    expect(() => treasureLoot(run, 'card', REWARD_POOL)).not.toThrow();
    expect(() => treasureLoot(run, 'cogs', REWARD_POOL)).not.toThrow();
  });
});

describe('rules/run.ts purity', () => {
  it('imports only rules/ siblings and core/rng.ts', () => {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), '../src/rules/run.ts');
    const source = readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers.sort()).toEqual(['../core/rng.ts', './difficulty.ts', './types.ts']);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});
