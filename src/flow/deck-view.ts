import { getCard, type SliceCard } from '../content/cards.ts';

export const DECK_SORTS = ['order', 'offense', 'defense', 'utility'] as const;
export type DeckSort = (typeof DECK_SORTS)[number];
export interface DeckStack {
  readonly id: string;
  readonly count: number;
}

function matchesRole(card: SliceCard, role: Exclude<DeckSort, 'order'>): boolean {
  const offense = card.effects.some(
    (e) =>
      e.type === 'damage' ||
      (e.type === 'apply-status' && e.status === 'overheat' && e.target !== 'self'),
  );
  const defense = card.effects.some(
    (e) =>
      e.type === 'block' ||
      e.type === 'conditional-block' ||
      e.type === 'block-from-status' ||
      (e.type === 'apply-status' && e.status === 'plating' && e.target === 'self'),
  );
  if (role === 'offense') return offense;
  if (role === 'defense') return defense;
  return !offense && !defense;
}

/** Keep the run's original order within both the selected role and the rest of the deck. */
export function deckStacks(deck: readonly string[], sort: DeckSort): DeckStack[] {
  const counts = new Map<string, number>();
  for (const id of deck) counts.set(id, (counts.get(id) ?? 0) + 1);
  const first: DeckStack[] = [];
  const rest: DeckStack[] = [];
  for (const [id, count] of counts) {
    const group = sort === 'order' || matchesRole(getCard(id), sort) ? first : rest;
    group.push({ id, count });
  }
  return first.concat(rest);
}
