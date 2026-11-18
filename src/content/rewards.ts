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

/** Cards available for permanent purchase, excluding cards already in the starter deck. */
export const PERMANENT_CARD_IDS: readonly string[] = REWARD_POOL.filter(
  (id) => !STARTER_DECK.includes(id),
);
