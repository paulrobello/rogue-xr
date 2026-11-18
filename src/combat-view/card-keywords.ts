/**
 * The keywords a card's effects use and what each means, for the card tip the pointer shows over a
 * card (the hand fan, the held card, the reward board and the deck view). Keywords are read from the
 * card's data (its effects and its `exhaust`, `dice` and `sigil` fields), never from its text. A
 * status keyword explains through `statusExplanation`, the badge tooltip's own wording.
 */

import type { SliceCard } from '../content/cards.ts';
import { dieById } from '../content/dice.ts';
import type { StatusId } from '../rules/types.ts';
import { STEAM_PER_TURN } from '../rules/types.ts';
import { STATUS_NAME, statusExplanation, type TipEntry } from './status-info.ts';

/** A card keyword: a status the card applies, or a mechanic its data uses. */
export type CardKeyword = 'block' | 'steam' | 'draw' | 'exhaust' | 'dice' | 'sigil' | StatusId;

/** Display name of each mechanic keyword (statuses take `STATUS_NAME`). Exhaustive. */
const MECHANIC_NAME: Readonly<Record<Exclude<CardKeyword, StatusId>, string>> = {
  block: 'Block',
  steam: 'Steam',
  draw: 'Draw',
  exhaust: 'Exhaust',
  dice: 'Roll',
  sigil: 'Sigil',
};

/** What each mechanic keyword does. Exhaustive: a new keyword fails the type check until it has one. */
const MECHANIC_TEXT: Readonly<Record<Exclude<CardKeyword, StatusId | 'dice'>, string>> = {
  block: 'Absorbs incoming damage until the start of your next turn.',
  steam: `Pays for cards. Refills to ${STEAM_PER_TURN} at the start of your turn.`,
  draw: 'Takes cards from your draw pile into your hand.',
  exhaust: 'Removed from this fight once played, instead of going to the discard pile.',
  sigil: 'Trace its glyph on the sigil plate to cast it; a cleaner trace casts it stronger.',
};

const isStatus = (k: CardKeyword): k is StatusId => k in STATUS_NAME;

/** Display name of `keyword`. */
export function keywordName(keyword: CardKeyword): string {
  return isStatus(keyword) ? STATUS_NAME[keyword] : MECHANIC_NAME[keyword];
}

/** The keywords `card` uses, in effect order, each once. */
export function cardKeywords(card: SliceCard): CardKeyword[] {
  const out: CardKeyword[] = [];
  const add = (k: CardKeyword) => {
    if (!out.includes(k)) out.push(k);
  };
  if (card.sigil) add('sigil');
  if (card.dice) add('dice');
  for (const effect of card.effects) {
    if (effect.type === 'block') add('block');
    else if (effect.type === 'gain-steam' || effect.type === 'lose-steam') add('steam');
    else if (effect.type === 'draw') add('draw');
    else if (effect.type === 'apply-status') add(effect.status);
  }
  if (card.exhaust) add('exhaust');
  return out;
}

/** What `keyword` means on `card` (a status on the player when the card applies it to itself). */
export function keywordExplanation(keyword: CardKeyword, card: SliceCard): string {
  if (keyword === 'dice') {
    const die = card.dice ? dieById(card.dice) : null;
    return die
      ? `Throw the ${die.name} (1 to ${die.faces.length}) when you play it; the roll adds to the effect.`
      : 'Throw a die when you play it; the roll adds to the effect.';
  }
  if (!isStatus(keyword)) return MECHANIC_TEXT[keyword];
  const self = card.effects.some(
    (e) => e.type === 'apply-status' && e.status === keyword && e.target === 'self',
  );
  return statusExplanation(keyword, null, self ? 'you' : 'it');
}

/** The tip entries for `card`: one per keyword, titled with its name. Empty when it uses none. */
export function cardTip(card: SliceCard): TipEntry[] {
  return cardKeywords(card).map((k) => ({
    title: keywordName(k),
    text: keywordExplanation(k, card),
  }));
}
