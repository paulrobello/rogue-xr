import { getCard, STARTER_DECK } from '../content/cards.ts';
import { DIFFICULTY_LABEL, runDifficulty } from '../rules/difficulty.ts';
import { deckStacks } from './deck-view.ts';
import type { RunFlow } from './flow.ts';

const CONTENT_LEFT = 77;
const CONTENT_WIDTH = 550;
const INK = '#3d291f';
const MUTED = '#6f5138';
const CATEGORY: Record<ReturnType<typeof getCard>['type'], string> = {
  attack: 'Attack',
  skill: 'Skill',
  sigil: 'Sigil',
  mechanism: 'Mechanism',
};

export type LogbookPage = (context: CanvasRenderingContext2D) => void;

function heading(context: CanvasRenderingContext2D, title: string, subtitle?: string): number {
  context.fillStyle = INK;
  context.textAlign = 'left';
  context.font = 'bold 42px Georgia, serif';
  context.fillText(title, CONTENT_LEFT, 112);
  context.fillRect(CONTENT_LEFT, 130, CONTENT_WIDTH, 2);
  if (subtitle) {
    context.fillStyle = MUTED;
    context.font = 'italic 25px Georgia, serif';
    context.fillText(subtitle, CONTENT_LEFT, 164);
  }
  return subtitle ? 211 : 181;
}

interface CardLine {
  readonly name: string;
  readonly count: number;
  readonly type: string;
  readonly cost: string;
  readonly section?: string;
}

// Ten entries leave room for the section label and the two-line card metadata inside the paper frame.
const CARD_LINES_PER_PAGE = 10;

function drawCardPage(
  context: CanvasRenderingContext2D,
  title: string,
  subtitle: string,
  lines: readonly CardLine[],
): void {
  let y = heading(context, title, subtitle);
  context.fillStyle = INK;
  for (const line of lines) {
    if (line.section) {
      context.font = 'bold 27px Georgia, serif';
      context.fillText(line.section, CONTENT_LEFT, y);
      y += 33;
    }
    context.font = '30px Georgia, serif';
    context.fillText(`${line.name} ×${line.count}`, CONTENT_LEFT, y, CONTENT_WIDTH);
    context.fillStyle = MUTED;
    context.font = '23px Georgia, serif';
    context.fillText(`${line.type} · ${line.cost}`, CONTENT_LEFT + 18, y + 25);
    context.fillStyle = INK;
    y += 59;
  }
}

function cardLines(ids: readonly string[], section?: string): CardLine[] {
  return deckStacks(ids, 'order').map((stack, index) => {
    const card = getCard(stack.id);
    return {
      name: card.name,
      count: stack.count,
      type: CATEGORY[card.type],
      cost: `${card.cost} steam`,
      section: index === 0 ? section : undefined,
    };
  });
}

function statsRows(context: CanvasRenderingContext2D, rows: readonly string[], y: number): void {
  context.fillStyle = INK;
  context.font = '32px Georgia, serif';
  for (const row of rows) {
    context.fillText(row, CONTENT_LEFT, y, CONTENT_WIDTH);
    y += 58;
  }
}

export function runCardPages(flow: RunFlow): readonly LogbookPage[] {
  const run = flow.run;
  if (!run) return [(context) => drawCardPage(context, 'Card Collection', '', [])];
  const pages: LogbookPage[] = [];
  const lines = cardLines(run.deck);
  for (let i = 0; i < lines.length; i += CARD_LINES_PER_PAGE) {
    const slice = lines.slice(i, i + CARD_LINES_PER_PAGE);
    pages.push((context) =>
      drawCardPage(context, 'Run deck', `${run.deck.length} cards carried this run`, slice),
    );
  }
  const owned = [
    ...cardLines(STARTER_DECK, 'Starter cards'),
    ...cardLines(flow.workshop.permanentCards, 'Unlocked cards'),
  ];
  for (let i = 0; i < owned.length; i += CARD_LINES_PER_PAGE) {
    const slice = owned.slice(i, i + CARD_LINES_PER_PAGE);
    pages.push((context) =>
      drawCardPage(context, 'Permanent Collection', 'Cards owned between runs', slice),
    );
  }
  return pages;
}

export function runStatsPages(flow: RunFlow): readonly LogbookPage[] {
  const run = flow.run;
  if (!run) return [(context) => heading(context, 'Run stats')];
  const floors: string[] = [];
  let rooms = 0;
  let fights = Number(run.patrolDefeated === true);
  let chests = 0;
  for (const floor of [1, 2, 3]) {
    const snapshot = flow.explorationOnFloor(floor);
    if (!snapshot) continue;
    rooms += snapshot.reachedRooms.length;
    fights += snapshot.clearedEncounters.length;
    chests += snapshot.openedLoot?.length ?? 0;
    floors.push(`Floor ${floor} · ${snapshot.reachedRooms.length} rooms`);
  }
  return [
    (context) => {
      const y = heading(
        context,
        'Run stats',
        `${DIFFICULTY_LABEL[runDifficulty(run)]} · Seed ${run.seed}`,
      );
      statsRows(
        context,
        [
          `Health · ${run.hp} / ${run.maxHp}`,
          `Cogs carried · ${run.cogs}`,
          `Cogs banked · ${flow.workshop.cogsBanked}`,
          `Cards in deck · ${run.deck.length}`,
        ],
        y,
      );
    },
    (context) => {
      const y = heading(context, 'Exploration');
      statsRows(
        context,
        [
          `Rooms explored · ${rooms}`,
          `Fights won · ${fights}`,
          `Chests opened · ${chests}`,
          ...floors,
        ],
        y,
      );
    },
  ];
}
