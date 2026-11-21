// @vitest-environment node
/**
 * Playtest 2026-11-17: "effects on cards need a laser point explanation of what they do". Every card
 * in the catalogue (and its upgrade) lists each keyword it uses with an explanation, the keywords are
 * read from the card's data, and the card text agrees with them.
 */
import { describe, expect, it } from 'vitest';
import { cardKeywords, cardTip, keywordExplanation } from '../src/combat-view/card-keywords.ts';
import { STATUS_NAME, statusExplanation } from '../src/combat-view/status-info.ts';
import { CARDS, getCard, upgradedCard } from '../src/content/cards.ts';

const ALL = CARDS.flatMap((c) => (c.upgrade ? [c, upgradedCard(c)] : [c]));

/** Words of the card text that name each keyword, read independently of the card data. */
const TEXT_WORDS: Record<string, RegExp> = {
  block: /\bBlock\b/,
  steam: /\bSteam\b/,
  draw: /\bDraw\b/,
  heal: /\bHeal\b/,
  exhaust: /\bExhaust\b/,
  dice: /\bRoll (?:a d(6|8)|an iron d4)\b/,
  weak: /\bWeak\b/,
  vulnerable: /\bVulnerable\b/,
  overheat: /\bOverheat\b/,
  'wound-up': /\bWound-up\b/,
  plating: /\bPlating\b/,
  rust: /\bRust\b/,
};

describe('card keywords', () => {
  it('explains every keyword every catalogue card uses', () => {
    expect(ALL.length).toBeGreaterThan(CARDS.length);
    for (const card of ALL) {
      for (const k of cardKeywords(card)) {
        const text = keywordExplanation(k, card);
        expect(text.length, `${card.id} ${k}`).toBeGreaterThan(20);
        expect(text, `${card.id} ${k}`).not.toMatch(/undefined|NaN/);
      }
    }
  });

  it('agrees with each card text (the keywords are read from data, not text)', () => {
    for (const card of ALL) {
      const keywords = cardKeywords(card);
      for (const [k, word] of Object.entries(TEXT_WORDS)) {
        expect(keywords.includes(k as never), `${card.id}: "${card.description}" ${k}`).toBe(
          word.test(card.description),
        );
      }
      // Sigil spells are traced, which their text does not say.
      expect(keywords.includes('sigil'), card.id).toBe(card.type === 'sigil');
    }
  });

  it('covers every status the catalogue applies, with the badge tooltip wording', () => {
    const seen = new Set(ALL.flatMap((c) => cardKeywords(c)));
    for (const id of ['weak', 'vulnerable', 'overheat', 'wound-up', 'plating', 'rust'] as const) {
      expect(seen.has(id), id).toBe(true);
      expect(id in STATUS_NAME).toBe(true);
    }
    // Overheat is Paul's "burn" (Furnace Brand); its stacks are a roll, so it explains per stack.
    const brand = getCard('furnace-brand');
    expect(keywordExplanation('overheat', brand)).toBe(statusExplanation('overheat', null, 'it'));
    expect(keywordExplanation('overheat', brand)).toContain('1 HP per stack');
    // Overwind winds the player up: the tip speaks to them.
    expect(keywordExplanation('wound-up', getCard('overwind'))).toBe(
      statusExplanation('wound-up', null, 'you'),
    );
  });

  it('shows a sample card its keywords, in order, with their text', () => {
    const valve = getCard('release-valve');
    const tip = cardTip(valve);
    expect(tip.map((e) => e.title)).toEqual(['Steam', 'Draw', 'Exhaust']);
    expect(tip[0]?.text).toContain('Refills to 3');
    expect(tip[2]?.text).toContain('Removed from this fight');
    const arc = cardTip(getCard('arc-bolt'));
    expect(arc.map((e) => e.title)).toEqual(['Sigil', 'Roll']);
    expect(arc[1]?.text).toContain('Glass d8 (1 to 8)');
    expect(cardTip(getCard('strike'))).toEqual([]);
  });
});
