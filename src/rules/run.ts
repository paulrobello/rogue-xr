import { hashString, normalizeSeed, RunRng, type RunRngState, Stream } from '../core/rng.ts';
import { type Difficulty, isDifficulty } from './difficulty.ts';
import {
  type BrassKeyState,
  RulesError,
  type StoredAlchemyState,
  type StoredBellChimesState,
  type StoredCalibrationState,
  type StoredCommissionState,
  type StoredConservatoryFormula,
  type StoredCounterweightState,
  type StoredDispatchState,
  type StoredHiddenPanelState,
  type StoredPressureState,
  type StoredPrismState,
  type StoredSpeakingPipesState,
} from './types.ts';

/**
 * Run-level state that outlives a single combat: the run's RNG snapshot, the deck as a list of card
 * ids, and the cog purse. Immutable, like `CombatState`. The card pool is always a parameter (a list of
 * card ids), so this module never imports content.
 */
export interface RunState {
  readonly seed: string;
  /** Seed of the active generated floor. Legacy runs omit it and use `seed`. */
  readonly floorSeed?: string;
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
  /** Cards found in opened coffers and not yet claimed into the deck, oldest first. Absent means none. */
  readonly pendingLoot?: readonly PendingLoot[];
  /** Keys (`lootKey`) of the rest-room hearths already used this run. Absent means none. */
  readonly usedHearths?: readonly string[];
  /** The level chosen for this run. Absent (every save made before levels existed) means `DEFAULT_DIFFICULTY`. */
  readonly difficulty?: Difficulty;
  /** The pressure regulator state. Absent in saves made before the regulator existed. */
  readonly pressure?: StoredPressureState;
  readonly dispatch?: StoredDispatchState;
  /** Upper Works counterweight lock progress. */
  readonly counterweight?: StoredCounterweightState;
  readonly alchemy?: StoredAlchemyState;
  readonly conservatoryFormula?: StoredConservatoryFormula;
  readonly commission?: StoredCommissionState;
  readonly calibration?: StoredCalibrationState;
  readonly hiddenPanel?: StoredHiddenPanelState;
  /** Cross-floor bell puzzle progress. Absent in older saves and treated as idle. */
  readonly bellChimes?: StoredBellChimesState;
  /** Rooms whose marked book caches have paid out. */
  readonly bookSecretOpenedRooms?: readonly number[];
  /** Rooms whose red-book key has been collected but not necessarily used. */
  readonly bookSecretKeyRooms?: readonly number[];
  /** Rooms whose cache cabinet was unlocked with its key. */
  readonly bookSecretCabinetRooms?: readonly number[];
  /** Cross-floor portable brass key. Absent in pre-v7 saves and treated as missing. */
  readonly brassKey?: BrassKeyState;
  readonly brassCacheSeen?: boolean;
  /** Whether the one-shot floor-one Light window cache has paid its key reward. */
  readonly windowCacheOpened?: boolean;
  readonly patrolDefeated?: true;
  /** Floor-three Prism Annex receiver progress. */
  readonly prismSignal?: StoredPrismState;
  readonly speakingPipes?: StoredSpeakingPipesState;
  /** Upper Works rubbing and seal state, retained in the journal across floor travel. */
  readonly reliquarySeal?: 'hidden' | 'known' | 'open';
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
/** Cogs awarded by the one-shot floor-one Light window cache. */
export const WINDOW_CACHE_COGS = 12;
/** Cards offered after a fight. */
export const REWARD_CHOICES = 3;
export const SKIP_REWARD = 'skip';
export const DEFAULT_MAX_HP = 60;

/** Stable eight-character seed for a floor in a multi-floor run. */
export function floorSeedFor(runSeed: string, floorNumber: number): string {
  if (!Number.isInteger(floorNumber) || floorNumber < 1)
    throw new RulesError('floor number must be positive');
  const normalized = normalizeSeed(runSeed);
  if (floorNumber === 1) return normalized;
  if (normalized === 'MAPTEST2' && floorNumber === 2) return 'MAPTEST3';
  return hashString(`${normalized}:floor:${floorNumber}`)
    .toString(16)
    .toUpperCase()
    .padStart(8, '0');
}

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
  /** Stored on the run when given. Scales nothing here: callers apply it to max hp and enemies. */
  readonly difficulty?: Difficulty;
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

/** A card waiting in an opened coffer: the coffer's `lootKey` and the card id it rolled. */
export interface PendingLoot {
  readonly key: string;
  readonly card: string;
}

/** A treasure-room pickup. Cogs are already paid; `openTreasure` leaves a card pending (`claimTreasure`). */
export type TreasureLoot =
  | { readonly kind: 'cogs'; readonly cogs: number }
  | { readonly kind: 'card'; readonly card: string; readonly cogs?: number };

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
  const { bonusDice, rewardChoices, difficulty } = opts;
  if (bonusDice !== undefined && (!Number.isInteger(bonusDice) || bonusDice < 0))
    throw new RulesError('bonusDice must be a non-negative integer');
  if (rewardChoices !== undefined && (!Number.isInteger(rewardChoices) || rewardChoices < 1))
    throw new RulesError('rewardChoices must be a positive integer');
  if (difficulty !== undefined && !isDifficulty(difficulty))
    throw new RulesError(`Unknown difficulty ${String(difficulty)}`);
  return {
    seed: rng.seed,
    floorSeed: rng.seed,
    rng: rng.snapshot(),
    deck: [...starterDeck],
    cogs,
    hp,
    maxHp,
    ...(bonusDice === undefined ? {} : { bonusDice }),
    ...(rewardChoices === undefined ? {} : { rewardChoices }),
    ...(difficulty === undefined ? {} : { difficulty }),
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
 * it, so a second call can never re-roll or pay twice. Otherwise rolls it with `treasureLoot` (the
 * same single `loot` draw) and records the key. Cogs are paid at once; a card waits in
 * `pendingLoot` until `claimTreasure` takes it.
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
  const recorded: RunState = { ...result.run, openedLoot: [...opened, key] };
  if (result.loot.kind === 'cogs') return { run: recorded, loot: result.loot };
  const pending = [...(run.pendingLoot ?? []), { key, card: result.loot.card }];
  // The card chest purse has its own draw so existing seeded card and treasure rolls stay stable.
  const cogs = Stream.fromKey(`${run.seed}:card-chest-cogs:${key}`).int(2, 4);
  return {
    run: { ...recorded, deck: run.deck, cogs: recorded.cogs + cogs, pendingLoot: pending },
    loot: { ...result.loot, cogs },
  };
}

export interface ClaimResult {
  readonly run: RunState;
  /** The card id now at the end of the deck. */
  readonly card: string;
}

/**
 * Claims the card pending in the opened coffer `key`: appends it to the deck and drops the pending
 * entry (the field is omitted once none are left). Returns null, touching nothing, when no card is
 * pending under `key` (never opened, a cog coffer, or already claimed). No random draw.
 */
export function claimTreasure(run: RunState, key: string): ClaimResult | null {
  const pending = run.pendingLoot ?? [];
  const found = pending.find((p) => p.key === key);
  if (!found) return null;
  const { pendingLoot: _pending, ...rest } = run;
  const left = pending.filter((p) => p !== found);
  return {
    run: {
      ...rest,
      deck: [...run.deck, found.card],
      ...(left.length === 0 ? {} : { pendingLoot: left }),
    },
    card: found.card,
  };
}

/** Claims the floor-one Light window cache once. No random draw. */
export function claimWindowCache(run: RunState): RunState | null {
  if (run.windowCacheOpened === true) return null;
  return { ...run, cogs: run.cogs + WINDOW_CACHE_COGS, windowCacheOpened: true };
}

/**
 * Share of max hp a rest-room hearth restores. Rest-room rule (default pending the owner): one
 * constant, so changing the number is a one-line edit and `0` turns the heal off.
 */
export const HEARTH_HEAL_FRACTION = 0.3;

/** Hp a hearth restores to `run` now: `HEARTH_HEAL_FRACTION` of max hp rounded down, capped at the missing hp. */
export function hearthHeal(run: Pick<RunState, 'hp' | 'maxHp'>): number {
  return Math.max(0, Math.min(run.maxHp - run.hp, Math.floor(run.maxHp * HEARTH_HEAL_FRACTION)));
}

export interface HearthResult {
  readonly run: RunState;
  /** Hp actually restored, the number the in-scene panel shows. */
  readonly healed: number;
}

/**
 * Uses the hearth `key` (see `lootKey`) once. Returns null, touching nothing, when the run already
 * used it. Otherwise heals by `hearthHeal` and records the key. No random draw: every stream is
 * left as it was.
 */
export function useHearth(run: RunState, key: string): HearthResult | null {
  const used = run.usedHearths ?? [];
  if (used.includes(key)) return null;
  const healed = hearthHeal(run);
  return { run: { ...run, hp: run.hp + healed, usedHearths: [...used, key] }, healed };
}
