import { expect, it } from 'vitest';
import { CARDS, getCard, STARTER_DECK } from '../src/content/cards.ts';
import { PERMANENT_CARD_IDS, REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { type LogbookPage, runCardPages, runStatsPages } from '../src/flow/logbook-run-pages.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

function textOn(paint: LogbookPage): string[] {
  const printed: string[] = [];
  const page = {
    fillRect() {},
    fillText(text: string, _x: number, y: number) {
      expect(y).toBeLessThan(880);
      printed.push(text);
    },
  } as unknown as CanvasRenderingContext2D;
  paint(page);
  return printed;
}

it('paginates a large run deck and permanent collection without dropping cards or copies', () => {
  const permanentCards = [...PERMANENT_CARD_IDS.slice(0, 16), PERMANENT_CARD_IDS[0]];
  const flow = new RunFlow({
    workshop: { ...createWorkshop(), permanentCards },
    starterDeck: [...CARDS.map(({ id }) => id)],
    rewardPool: REWARD_POOL,
  });
  flow.newRun('MAPTEST2');

  const pages = runCardPages(flow).map(textOn);
  const deck = pages.filter(([heading]) => heading === 'Run deck');
  expect(deck.length).toBeGreaterThan(1);
  for (const card of CARDS) {
    const copies = 1 + permanentCards.filter((id) => id === card.id).length;
    expect(deck.flat()).toContain(`${card.name} ×${copies}`);
  }
  const owned = pages.filter(([heading]) => heading === 'Permanent Collection');
  expect(owned.length).toBeGreaterThan(1);
  expect(owned.flat()).toContain(`${getCard(permanentCards[0]).name} ×2`);
  expect(owned.flat()).toContain(`${getCard(permanentCards.at(-2) as string).name} ×1`);
});

it('uses the run and archived floors for the stats spread', () => {
  const flow = new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
  flow.newRun('MAPTEST2');
  flow.enterRoom(1);
  flow.travelToFloor(2, 0);
  flow.enterRoom(3);

  const [run, exploration] = runStatsPages(flow).map(textOn);
  expect(run).toContain(`Cards in deck · ${STARTER_DECK.length}`);
  expect(exploration).toEqual([
    'Exploration',
    'Rooms explored · 4',
    'Fights won · 0',
    'Chests opened · 0',
    'Floor 1 · 2 rooms',
    'Floor 2 · 2 rooms',
  ]);
});
