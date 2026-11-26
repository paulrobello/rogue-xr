import { CARDS, STARTER_DECK } from './cards.ts';

export const WAVE_B_OVERDRIVE_IDS: ReadonlySet<string> = new Set([
  'flash-boiler',
  'overdrive-piston',
]);

export const WAVE_B_CHARGE_IDS: ReadonlySet<string> = new Set(['capacitor', 'copper-coil']);

export const WAVE_B_DICE_IDS: ReadonlySet<string> = new Set(['loaded-die', 'reroll-lever']);

/** Mechanism cards added in content v25, excluded from offers in v24 and older snapshots. */
export const WAVE_B_MECHANISM_IDS: ReadonlySet<string> = new Set([
  'gyro-stabilizer',
  'pressure-gauge',
  'clockwork-turret',
  'furnace-heart',
]);

/** Wave B combat cards added in content v27. Existing v26 snapshots retain prior offers. */
export const WAVE_B_CHAIN_IDS: ReadonlySet<string> = new Set([
  'arc-chain',
  'gear-grinder',
  'pendulum-ward',
]);

/** Crystal Gambit reward content added in version 28. */
export const CRYSTAL_GAMBIT_IDS: ReadonlySet<string> = new Set(['crystal-gambit']);

/** Echo Glyph reward content added in version 30. */
export const ECHO_GLYPH_IDS: ReadonlySet<string> = new Set(['echo-glyph']);

/** Lens Focus reward content added in version 33. */
export const LENS_FOCUS_IDS: ReadonlySet<string> = new Set(['lens-focus']);

/** Field Dressing reward content added in version 36. */
export const FIELD_DRESSING_ID = 'field-dressing';

/** Risk cards available from reward content version 37 onward. */
export const RISK_CARD_IDS: ReadonlySet<string> = new Set([
  'redline-shot',
  'boiler-gamble',
  'steam-sweep',
  'plated-stand',
  'last-reserve',
]);
/** Risk cards added in reward content version 38. */
export const RISK_CARD_EXPANSION_IDS: ReadonlySet<string> = new Set([
  'steam-sweep',
  'plated-stand',
  'last-reserve',
]);

/** Starter-only basics are never offered as rewards. */
const BASICS: ReadonlySet<string> = new Set(['strike', 'defend']);

/**
 * Card ids the slice can offer as rewards and treasure: every base card except the starter basics.
 * Base ids only, upgrades come from the workshop. Cog Toss, Warding Glyph and Patch Kit
 * start in the deck and stay in the pool.
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
export const WAVE_A_COMPLETE_IDS: ReadonlySet<string> = new Set([
  'grease-gun',
  'escapement-break',
  'lucky-strike',
]);

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

/** Keep Patch Kit purchasable so existing permanent copies stay valid. */
export const PERMANENT_CARD_IDS: readonly string[] = REWARD_POOL.filter(
  (id) => id === 'patch-kit' || !STARTER_DECK.includes(id),
);
