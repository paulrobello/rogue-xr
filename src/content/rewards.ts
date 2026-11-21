import { CARDS, STARTER_DECK } from './cards.ts';

/** Starter-only basics: the deck already holds four of each, so they are never offered as rewards. */
const BASICS: ReadonlySet<string> = new Set(['strike', 'defend']);

/**
 * Card ids the slice can offer as rewards and treasure: every base card except the starter basics.
 * Base ids only, upgrades come from the workshop. `cog-toss` and `warding-glyph` start in the deck but
 * stay in the pool, so duplicates of them are a real choice.
 */
export const REWARD_POOL: readonly string[] = CARDS.filter((card) => !BASICS.has(card.id)).map(
  (card) => card.id,
);

/** Added rewards that existing runs skip when they roll new offers. */
export const DUNGEON_REWARD_IDS: ReadonlySet<string> = new Set([
  'torque-wrench',
  'counterweight',
  'tension-coil',
]);

/** Cards added by Wave A, excluded from offers for pre-v14 snapshots. */
export const WAVE_A_REPAIR_IDS: ReadonlySet<string> = new Set([
  'spare-parts',
  'flywheel-swing',
  'patch-kit',
]);

/** Reward pool used before the Foundry expansion. Existing saves keep this boundary for new rolls. */
export const LEGACY_REWARD_POOL: readonly string[] = [
  'cog-toss',
  'ratchet-flurry',
  'rivet-volley',
  'escapement-hammer',
  'lucky-rivets',
  'release-valve',
  'overwind',
  'spanner-jam',
  'cogstorm',
  'furnace-brand',
  'warding-glyph',
  'arc-bolt',
  'time-spiral',
];

/** Cards available for permanent purchase, excluding cards already in the starter deck. */
export const PERMANENT_CARD_IDS: readonly string[] = REWARD_POOL.filter(
  (id) => !STARTER_DECK.includes(id),
);
