import { RunRng, type RunRngState, Stream } from '../core/rng.ts';
import { RulesError } from './types.ts';

/**
 * Run-level state that outlives a single combat: the run's RNG snapshot, the deck as a list of card
 * ids, and the cog purse. Immutable, like `CombatState`. The card pool is always a parameter (a list of
 * card ids), so this module never imports content.
 */
export interface RunState {
  readonly seed: string;
  /** All five stream snapshots. Reward and treasure rolls advance only `loot`. */
  readonly rng: RunRngState;
  /** Card ids in deck order. Duplicates allowed. */
  readonly deck: readonly string[];
  /** Run currency. Never negative. */
  readonly cogs: number;
  readonly hp: number;
  readonly maxHp: number;
  /** Extra dice the combat layer adds to the starting loadout. Absent means 0. Set by workshop upgrades. */
  readonly bonusDice?: number;
  /** Cards `rewardOffer` offers. Absent means `REWARD_CHOICES`. Set by workshop upgrades. */
  readonly rewardChoices?: number;
  /** Keys (`lootKey`) of the treasure pickups already opened this run. Absent means none. */
  readonly openedLoot?: readonly string[];
}

/** Mirrors `EncounterTier` in `floor/generate.ts`; rules may not import from `floor/`. */
export type RewardTier = 'regular' | 'elite' | 'guardian';
/** Mirrors `LootKind` in `floor/generate.ts`. */
export type TreasureKind = 'cogs' | 'card';

/** Inclusive cog range rolled from the `loot` stream. */
export interface CogRange {
  readonly min: number;
  readonly max: number;
}

/** Cogs awarded after an encounter, by tier. The guardian pays a flat sum. */
export const REWARD_COGS: Readonly<Record<RewardTier, CogRange>> = {
  regular: { min: 10, max: 15 },
  elite: { min: 25, max: 35 },
  guardian: { min: 60, max: 60 },
};
/** Cogs found in a `cogs` treasure room. */
export const TREASURE_COGS: CogRange = { min: 15, max: 25 };
/** Cards offered after a fight. */
export const REWARD_CHOICES = 3;
export const SKIP_REWARD = 'skip';
export const DEFAULT_MAX_HP = 60;

export interface RunOptions {
  /** Defaults to `DEFAULT_MAX_HP`. */
  readonly maxHp?: number;
  /** Defaults to `maxHp`. */
  readonly hp?: number;
  /** Defaults to 0. */
  readonly cogs?: number;
  /** Stored on the run when given. Non-negative integer. */
  readonly bonusDice?: number;
  /** Stored on the run when given. Positive integer; `rewardOffer` falls back to `REWARD_CHOICES`. */
  readonly rewardChoices?: number;
}

/** What a finished fight offers: three distinct card ids (pool order is not preserved) and a cog payout. */
export interface RewardOffer {
  readonly tier: RewardTier;
  readonly cards: readonly string[];
  readonly cogs: number;
}

export interface RewardOfferResult {
  /** The input run with only `rng.loot` advanced. */
  readonly run: RunState;
  readonly offer: RewardOffer;
}

export type RewardChoice = string | typeof SKIP_REWARD;

/** A treasure-room pickup, already applied to the returned run. */
export type TreasureLoot =
  | { readonly kind: 'cogs'; readonly cogs: number }
  | { readonly kind: 'card'; readonly card: string };

export interface TreasureLootResult {
  readonly run: RunState;
  readonly loot: TreasureLoot;
}

/** The key a treasure pickup is recorded under in `RunState.openedLoot`: its room and loot socket. */
export function lootKey(room: number, socketId: string): string {
  return `${room}/${socketId}`;
}

/** A fresh run: all streams seeded from `seed` (see `RunRng`), the starter deck copied in. */
export function createRun(
  seed: string,
  starterDeck: readonly string[],
  opts: RunOptions = {},
): RunState {
  const rng = new RunRng(seed);
  const maxHp = opts.maxHp ?? DEFAULT_MAX_HP;
  const hp = opts.hp ?? maxHp;
  const cogs = opts.cogs ?? 0;
  if (!Number.isInteger(maxHp) || maxHp <= 0)
    throw new RulesError('maxHp must be a positive integer');
  if (!Number.isInteger(hp) || hp < 0 || hp > maxHp)
    throw new RulesError('hp must be in [0, maxHp]');
  if (!Number.isInteger(cogs) || cogs < 0)
    throw new RulesError('cogs must be a non-negative integer');
  const { bonusDice, rewardChoices } = opts;
  if (bonusDice !== undefined && (!Number.isInteger(bonusDice) || bonusDice < 0))
    throw new RulesError('bonusDice must be a non-negative integer');
  if (rewardChoices !== undefined && (!Number.isInteger(rewardChoices) || rewardChoices < 1))
    throw new RulesError('rewardChoices must be a positive integer');
  return {
    seed: rng.seed,
    rng: rng.snapshot(),
    deck: [...starterDeck],
    cogs,
    hp,
    maxHp,
    ...(bonusDice === undefined ? {} : { bonusDice }),
    ...(rewardChoices === undefined ? {} : { rewardChoices }),
  };
}

function rollCogs(stream: Stream, range: CogRange): number {
  return stream.int(range.min, range.max);
}

function withLoot(run: RunState, stream: Stream): Pick<RunState, 'rng'> {
  return { rng: { ...run.rng, loot: stream.snapshot() } };
}

function distinctPool(pool: readonly string[], needed: number): string[] {
  const ids = [...new Set(pool)];
  if (ids.length < needed) {
    throw new RulesError(`Reward pool has ${ids.length} distinct cards, need at least ${needed}`);
  }
  return ids;
}

/**
 * Rolls the post-combat reward from the `loot` stream only. Draw order: the cog payout (one draw), then
 * a Fisher-Yates shuffle of the de-duplicated pool whose first `run.rewardChoices ?? REWARD_CHOICES` ids
 * are offered. Every tier draws uniformly: the pool carries no rarity, so elites and guardians pay more
 * cogs, not rarer cards. Throws `RulesError` when the pool has fewer distinct ids than the offer size.
 */
export function rewardOffer(
  run: RunState,
  tier: RewardTier,
  pool: readonly string[],
): RewardOfferResult {
  const choices = run.rewardChoices ?? REWARD_CHOICES;
  const ids = distinctPool(pool, choices);
  const stream = new Stream(run.rng.loot);
  const cogs = rollCogs(stream, REWARD_COGS[tier]);
  const cards = stream.shuffle(ids).slice(0, choices);
  return { run: { ...run, ...withLoot(run, stream) }, offer: { tier, cards, cogs } };
}

/**
 * Claims `offer`: the cogs are always paid, and `choice` either adds one offered card to the end of the
 * deck or is `'skip'`. Does not touch the RNG. Throws `RulesError` when `choice` is not in the offer.
 * The caller owns the offer, so claim each one once.
 */
export function chooseReward(run: RunState, offer: RewardOffer, choice: RewardChoice): RunState {
  const skipped = choice === SKIP_REWARD;
  if (!skipped && !offer.cards.includes(choice)) {
    throw new RulesError(`Card ${choice} is not in the reward offer`);
  }
  return {
    ...run,
    cogs: run.cogs + offer.cogs,
    deck: skipped ? run.deck : [...run.deck, choice],
  };
}

/**
 * Opens a treasure pickup from the `loot` stream and applies it. `'cogs'` adds `TREASURE_COGS` (one
 * draw). `'card'` adds one card drawn uniformly from the pool (one draw). Throws `RulesError` for an
 * empty pool on a card pickup.
 */
export function treasureLoot(
  run: RunState,
  kind: TreasureKind,
  pool: readonly string[],
): TreasureLootResult {
  const stream = new Stream(run.rng.loot);
  if (kind === 'cogs') {
    const cogs = rollCogs(stream, TREASURE_COGS);
    return {
      run: { ...run, ...withLoot(run, stream), cogs: run.cogs + cogs },
      loot: { kind, cogs },
    };
  }
  const ids = distinctPool(pool, 1);
  const card = stream.pick(ids);
  return {
    run: { ...run, ...withLoot(run, stream), deck: [...run.deck, card] },
    loot: { kind, card },
  };
}

/** The room and socket a `lootKey` names, or null for a malformed key. */
export function parseLootKey(key: string): { room: number; socketId: string } | null {
  const at = key.indexOf('/');
  const room = Number(key.slice(0, at));
  return at > 0 && at < key.length - 1 && Number.isInteger(room) && room >= 0
    ? { room, socketId: key.slice(at + 1) }
    : null;
}

/**
 * Opens the treasure pickup `key` once. Returns null, touching nothing, when the run already opened
 * it, so a second call can never re-roll or pay twice. Otherwise applies `treasureLoot` and records
 * the key, advancing only the `loot` stream.
 */
export function openTreasure(
  run: RunState,
  key: string,
  kind: TreasureKind,
  pool: readonly string[],
): TreasureLootResult | null {
  const opened = run.openedLoot ?? [];
  if (opened.includes(key)) return null;
  const result = treasureLoot(run, kind, pool);
  return { run: { ...result.run, openedLoot: [...opened, key] }, loot: result.loot };
}
