/**
 * The keywords a card's effects use and what each means, for the card tip the pointer shows over a
 * card (the hand fan, the held card, the reward board and the deck view). Keywords are read from the
 * card's data (its effects and its `exhaust`, `dice` and `sigil` fields), never from its text. A
 * status keyword explains through `statusExplanation`, the badge tooltip's own wording.
 */

import type { SliceCard } from '../content/cards.ts';
import { dieById } from '../content/dice.ts';
import { resolveAmount, STEAM_PER_TURN } from '../rules/index.ts';
import type { StatusId } from '../rules/types.ts';
import { STATUS_NAME, statusExplanation, type TipEntry } from './status-info.ts';

/** A card keyword: a status the card applies, or a mechanic its data uses. */
export type CardKeyword =
  | 'block'
  | 'steam'
  | 'overdrive'
  | 'mechanism'
  | 'draw'
  | 'scry'
  | 'heal'
  | 'exhaust'
  | 'dice'
  | 'loaded'
  | 'reroll'
  | 'sigil'
  | 'echo'
  | 'pinned'
  | 'counterstroke'
  | 'quench'
  | StatusId;

/** Display name of each mechanic keyword (statuses take `STATUS_NAME`). Exhaustive. */
const MECHANIC_NAME: Readonly<Record<Exclude<CardKeyword, StatusId>, string>> = {
  block: 'Block',
  steam: 'Steam',
  overdrive: 'Overdrive',
  mechanism: 'Mechanism',
  draw: 'Draw',
  scry: 'Scry',
  heal: 'Heal',
  exhaust: 'Exhaust',
  dice: 'Roll',
  loaded: 'Loaded',
  reroll: 'Reroll',
  sigil: 'Sigil',
  echo: 'Echo',
  pinned: 'Pinned',
  counterstroke: 'Counterstroke',
  quench: 'Quench Seal',
};

/** What each mechanic keyword does. Exhaustive: a new keyword fails the type check until it has one. */
const MECHANIC_TEXT: Readonly<Record<Exclude<CardKeyword, StatusId | 'dice'>, string>> = {
  block: 'Absorbs incoming damage until the start of your next turn.',
  steam: `Pays for cards. Refills to ${STEAM_PER_TURN} at the start of your turn.`,
  overdrive: 'Spend all remaining Steam. The effect uses the amount spent.',
  mechanism:
    'Installs on the table and repeats its effect each turn. A fourth device replaces the oldest.',
  draw: 'Takes cards from your draw pile into your hand.',
  scry: 'Reveal the top cards of your draw pile. Mark any to discard and confirm.',
  heal: 'Restores missing HP, up to your maximum.',
  exhaust: 'Removed from this fight once played, instead of going to the discard pile.',
  loaded: 'Adds one roll to your next dice card this turn. Keep the highest initial result.',
  reroll:
    'After your next throw, you can keep the result or throw one die again. The new roll replaces the first result.',
  sigil: 'Trace its glyph on the sigil plate to cast it; a cleaner trace casts it stronger.',
  echo: 'Repeat the last successful spell at its original strength, including its die result. Aim again if the original needed a target.',
  pinned: 'Stays in your hand when you end your turn. Playing it still discards it normally.',
  counterstroke: 'Checks the target’s shown intent when played. Two or more hits grant the shield.',
  quench: 'Removes Overheat from the target before calculating its Block gain.',
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
  if (card.cost === 'X') add('overdrive');
  if (card.mechanism) add('mechanism');
  if (card.sigil) add('sigil');
  if (card.echoSigil) add('echo');
  if (card.dice) add('dice');
  if (card.pinned) add('pinned');
  if (card.id.replace(/\+$/, '') === 'counterstroke') add('counterstroke');
  if (card.id.replace(/\+$/, '') === 'quench-seal') add('quench');
  for (const effect of card.mechanism?.effects ?? card.effects) {
    if (effect.type === 'damage' && effect.extraHitsIfTargetRust) add('rust');
    if (
      effect.type === 'block' ||
      effect.type === 'damage-from-block' ||
      (effect.type === 'damage' && effect.bonusIfSelfBlock)
    )
      add('block');
    else if (effect.type === 'gain-steam' || effect.type === 'lose-steam') add('steam');
    else if (effect.type === 'draw') add('draw');
    else if (effect.type === 'scry') {
      add('scry');
      if (effect.drawAfter) add('draw');
    } else if (effect.type === 'heal') add('heal');
    else if (effect.type === 'load-die') add('loaded');
    else if (effect.type === 'allow-reroll') add('reroll');
    else if (effect.type === 'apply-status') add(effect.status);
    else if (effect.type === 'block-from-status') {
      add('quench');
      add('block');
      add(effect.status);
    } else if (effect.type === 'conditional-block') {
      add('counterstroke');
      add('block');
    }
  }
  if (card.rollRisk) add(card.rollRisk.miss.status);
  if (card.exhaust) add('exhaust');
  return out;
}

/** What `keyword` means on `card` (a status on the player when the card applies it to itself). */
export function keywordExplanation(keyword: CardKeyword, card: SliceCard, steam?: number): string {
  if (keyword === 'sigil' && card.echoSigil)
    return 'Draw a recognizable spiral to trigger the repeat. A fizzle still spends the card and its Steam.';
  if (keyword === 'overdrive' && steam !== undefined) {
    for (const effect of card.effects) {
      if (
        (effect.type === 'block' || effect.type === 'damage') &&
        typeof effect.amount === 'object' &&
        'perSteam' in effect.amount
      ) {
        const amount = resolveAmount(effect.amount, null, steam);
        const unit = effect.type === 'block' ? 'Block' : 'damage';
        return `${MECHANIC_TEXT.overdrive} At ${steam} Steam, the base effect is ${amount} ${unit}.`;
      }
    }
  }
  if (keyword === 'dice') {
    if (card.rollRisk) {
      return `Succeed on a kept roll of ${card.rollRisk.minimum} or higher. A lower roll triggers the penalty.`;
    }
    const die = card.dice ? dieById(card.dice) : null;
    if (die && card.diceCount === 2)
      return 'Throw two crystal d12s. Add both results. Loaded, Spare Die, and Reroll affect the first die.';
    return die
      ? `Throw the ${die.name} (1 to ${die.faces.length}) when you play it; the roll adds to the effect.`
      : 'Throw a die when you play it; the roll adds to the effect.';
  }
  if (!isStatus(keyword)) return MECHANIC_TEXT[keyword];
  const self =
    card.rollRisk?.miss.status === keyword ||
    (card.mechanism?.effects ?? card.effects).some(
      (e) => e.type === 'apply-status' && e.status === keyword && e.target === 'self',
    );
  return statusExplanation(keyword, null, self ? 'you' : 'it');
}

/** The tip entries for `card`: one per keyword, titled with its name. Empty when it uses none. */
export function cardTip(card: SliceCard, steam?: number): TipEntry[] {
  return cardKeywords(card).map((k) => ({
    title: keywordName(k),
    text: keywordExplanation(k, card, steam),
  }));
}
