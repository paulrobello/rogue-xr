import { describe, expect, it } from 'vitest';
import {
  CARDS,
  CARDS_BY_ID,
  DIE_IDS,
  deckDefs,
  getCard,
  SIGIL_IDS,
  type SliceCard,
  STARTER_DECK,
  upgradedCard,
} from '../src/content/cards.ts';
import { RunRng } from '../src/core/rng.ts';
import {
  type Action,
  type Amount,
  apply,
  type CardDef,
  type CombatEvent,
  type CombatState,
  type Effect,
  type EnemySetup,
  STEAM_PER_TURN,
  type Statuses,
  type StatusId,
  startCombat,
  usesDice,
  validate,
} from '../src/rules/index.ts';

const ENEMY_HP = 60;
const D6_ROLL = 4;
const D8_ROLL = 7;

const filler: CardDef = {
  id: 'filler',
  cost: 1,
  target: 'none',
  effects: [{ type: 'block', amount: 1 }],
};
const dummy = (id: string): EnemySetup => ({
  id,
  name: id,
  hp: ENEMY_HP,
  moves: [{ id: 'wait', intent: 'unknown', effects: [] }],
});

const ALL_DEFS: readonly SliceCard[] = CARDS.flatMap((card) => [card, upgradedCard(card)]);

function rollFor(def: SliceCard): number | undefined {
  if (def.dice === 'brass-d6') return D6_ROLL;
  if (def.dice === 'glass-d8') return D8_ROLL;
  return undefined;
}

/** Starts a fight against dummies `a` and `b` with `def` (uid 0) plus 9 fillers, and opens turn 1. */
function begin(def: CardDef): CombatState {
  const deck = [def, ...Array.from({ length: 9 }, () => filler)];
  const { state } = startCombat({
    player: { hp: 40, maxHp: 40 },
    deck,
    enemies: [dummy('a'), dummy('b')],
    rng: new RunRng('C4RDS000').snapshot(),
  });
  return toHand(apply(state, { type: 'start-turn' }).state, 0);
}

/** Moves a card from the draw pile into the hand, so a test does not depend on the shuffle. */
function toHand(state: CombatState, uid: number): CombatState {
  const card = state.piles.draw.find((c) => c.uid === uid);
  if (!card) return state;
  const draw = state.piles.draw.filter((c) => c.uid !== uid);
  return { ...state, piles: { ...state.piles, draw, hand: [...state.piles.hand, card] } };
}

function playAction(def: SliceCard, uid = 0): Action {
  const dice = rollFor(def);
  return {
    type: 'play-card',
    uid,
    ...(def.target === 'enemy' ? { target: 'a' } : {}),
    ...(dice === undefined ? {} : { dice }),
  };
}

interface Outcome {
  readonly hp: readonly [number, number];
  readonly enemyStatuses?: readonly [Statuses, Statuses];
  readonly block?: number;
  readonly steam: number;
  readonly playerStatuses?: Statuses;
  readonly drawn?: number;
  readonly pile?: 'discard' | 'exhaust';
}

/** Hand-computed results of playing each card once with a d6 roll of 4 or a d8 roll of 7. */
const EXPECTED: Readonly<Record<string, Outcome>> = {
  strike: { hp: [54, 60], steam: 2 },
  'strike+': { hp: [51, 60], steam: 2 },
  'cog-toss': { hp: [54, 60], steam: 2 },
  'cog-toss+': { hp: [52, 60], steam: 2 },
  'ratchet-flurry': { hp: [54, 60], steam: 2 },
  'ratchet-flurry+': { hp: [51, 60], steam: 2 },
  'rivet-volley': { hp: [56, 56], steam: 2 },
  'rivet-volley+': { hp: [54, 54], steam: 2 },
  'escapement-hammer': { hp: [49, 60], enemyStatuses: [{ vulnerable: 1 }, {}], steam: 0 },
  'escapement-hammer+': { hp: [46, 60], enemyStatuses: [{ vulnerable: 2 }, {}], steam: 0 },
  defend: { hp: [60, 60], block: 5, steam: 2 },
  'defend+': { hp: [60, 60], block: 8, steam: 2 },
  'lucky-rivets': { hp: [60, 60], block: 6, steam: 2 },
  'lucky-rivets+': { hp: [60, 60], block: 8, steam: 2 },
  'release-valve': { hp: [60, 60], steam: 4, drawn: 1, pile: 'exhaust' },
  'release-valve+': { hp: [60, 60], steam: 5, drawn: 1, pile: 'exhaust' },
  overwind: { hp: [60, 60], steam: 2, playerStatuses: { 'wound-up': 2 }, pile: 'exhaust' },
  'overwind+': { hp: [60, 60], steam: 2, playerStatuses: { 'wound-up': 3 }, pile: 'exhaust' },
  'spanner-jam': { hp: [60, 60], enemyStatuses: [{ weak: 1, vulnerable: 1 }, {}], steam: 2 },
  'spanner-jam+': { hp: [60, 60], enemyStatuses: [{ weak: 2, vulnerable: 2 }, {}], steam: 2 },
  cogstorm: { hp: [52, 52], steam: 0 },
  'cogstorm+': { hp: [48, 48], steam: 0 },
  'furnace-brand': { hp: [56, 60], enemyStatuses: [{ overheat: 4 }, {}], steam: 2 },
  'furnace-brand+': { hp: [54, 60], enemyStatuses: [{ overheat: 5 }, {}], steam: 2 },
  'warding-glyph': { hp: [60, 60], block: 8, steam: 2 },
  'warding-glyph+': { hp: [60, 60], block: 11, steam: 2 },
  'arc-bolt': { hp: [50, 60], steam: 2 },
  'arc-bolt+': { hp: [48, 60], steam: 2 },
  'time-spiral': { hp: [60, 60], enemyStatuses: [{ weak: 1 }, { weak: 1 }], steam: 2, drawn: 2 },
  'time-spiral+': { hp: [60, 60], enemyStatuses: [{ weak: 2 }, { weak: 2 }], steam: 2, drawn: 3 },
};

describe('card effects through the engine', () => {
  it('has an expectation for every base and upgraded card', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(ALL_DEFS.map((d) => d.id).sort());
  });

  it.each(ALL_DEFS.map((def) => [def.id, def] as const))('%s', (_id, def) => {
    const expected = EXPECTED[def.id];
    if (!expected) throw new Error(`No expectation for ${def.id}`);
    const before = begin(def);
    expect(before.player.steam).toBe(STEAM_PER_TURN);
    const { state, events } = apply(before, playAction(def));

    expect(state.enemies.map((e) => e.hp)).toEqual(expected.hp);
    expect(state.enemies.map((e) => e.statuses)).toEqual(expected.enemyStatuses ?? [{}, {}]);
    expect(state.player.block).toBe(expected.block ?? 0);
    expect(state.player.steam).toBe(expected.steam);
    expect(state.player.statuses).toEqual(expected.playerStatuses ?? {});
    expect(state.piles.hand).toHaveLength(before.piles.hand.length - 1 + (expected.drawn ?? 0));
    const pile = expected.pile ?? 'discard';
    expect(state.piles[pile].map((c) => c.uid)).toContain(0);
    expect(events).toContainEqual<CombatEvent>({
      type: 'card-played',
      uid: 0,
      cardId: def.id,
      target: def.target === 'enemy' ? 'a' : null,
      dice: rollFor(def) ?? null,
    });
  });

  it('Furnace Brand overheat burns the enemy at the start of its turn', () => {
    const played = apply(begin(getCard('furnace-brand')), playAction(getCard('furnace-brand')));
    const ended = apply(played.state, { type: 'end-turn' });
    const { state } = apply(ended.state, { type: 'enemy-act' });
    expect(state.enemies[0]?.hp).toBe(56 - D6_ROLL);
    expect(state.enemies[0]?.statuses).toEqual({ overheat: D6_ROLL - 1 });
  });

  it('Overwind adds its Wound-up stacks to every later attack hit', () => {
    const strike = getCard('strike');
    const overwind = getCard('overwind');
    const deck = [overwind, strike, ...Array.from({ length: 8 }, () => filler)];
    const opened = startCombat({
      player: { hp: 40, maxHp: 40 },
      deck,
      enemies: [dummy('a')],
      rng: new RunRng('C4RDS000').snapshot(),
    });
    let state = toHand(toHand(apply(opened.state, { type: 'start-turn' }).state, 0), 1);
    state = apply(state, playAction(overwind, 0)).state;
    state = apply(state, playAction(strike, 1)).state;
    expect(state.enemies[0]?.hp).toBe(ENEMY_HP - 6 - 2);
  });

  it('Escapement Hammer leaves the target Vulnerable for the next hit', () => {
    const hammer = getCard('escapement-hammer');
    const strike = getCard('strike');
    const valve = getCard('release-valve');
    const deck = [hammer, strike, valve, ...Array.from({ length: 7 }, () => filler)];
    const opened = startCombat({
      player: { hp: 40, maxHp: 40 },
      deck,
      enemies: [dummy('a')],
      rng: new RunRng('C4RDS000').snapshot(),
    });
    let state = toHand(toHand(apply(opened.state, { type: 'start-turn' }).state, 0), 1);
    state = apply(toHand(state, 2), playAction(valve, 2)).state;
    state = apply(state, playAction(hammer, 0)).state;
    state = apply(state, playAction(strike, 1)).state;
    expect(state.enemies[0]?.hp).toBe(ENEMY_HP - 11 - 9);
  });

  it('rejects a dice card played without a roll', () => {
    for (const def of ALL_DEFS.filter((d) => d.dice !== undefined)) {
      const state = begin(def);
      const action: Action = {
        type: 'play-card',
        uid: 0,
        ...(def.target === 'enemy' ? { target: 'a' } : {}),
      };
      expect(validate(state, action)).toBe(`Card ${def.id} needs a dice result`);
    }
  });
});

const STATUS_NAMES: Readonly<Record<StatusId, string>> = {
  weak: 'Weak',
  vulnerable: 'Vulnerable',
  overheat: 'Overheat',
  'wound-up': 'Wound-up',
};

function amountText(amount: Amount): string {
  if (typeof amount === 'number') return String(amount);
  const roll = amount.dice === 1 ? 'roll' : `${amount.dice} × roll`;
  return amount.base ? `${amount.base} + ${roll}` : roll;
}

function effectText(effect: Effect): string {
  switch (effect.type) {
    case 'damage': {
      const all = effect.target === 'all-opponents' ? ' to all enemies' : '';
      const hits = (effect.hits ?? 1) > 1 ? ` ${effect.hits} times` : '';
      return `Deal ${amountText(effect.amount)} damage${all}${hits}.`;
    }
    case 'block':
      return `Gain ${amountText(effect.amount)} Block.`;
    case 'gain-steam':
      return `Gain ${amountText(effect.amount)} Steam.`;
    case 'lose-steam':
      return `Lose ${amountText(effect.amount)} Steam.`;
    case 'draw':
      return `Draw ${amountText(effect.amount)} card${effect.amount === 1 ? '' : 's'}.`;
    case 'apply-status': {
      const status = STATUS_NAMES[effect.status];
      if (effect.target === 'self') return `Gain ${amountText(effect.stacks)} ${status}.`;
      const all = effect.target === 'all-opponents' ? ' to all enemies' : '';
      return `Apply ${amountText(effect.stacks)} ${status}${all}.`;
    }
  }
}

/** Canonical rules text; every card's hand-written description must equal it. */
function rulesText(def: SliceCard): string {
  const parts: string[] = [];
  if (def.dice) parts.push(`Roll a ${def.dice === 'brass-d6' ? 'd6' : 'd8'}.`);
  parts.push(...def.effects.map(effectText));
  if (def.exhaust) parts.push('Exhaust.');
  return parts.join(' ');
}

describe('card schema', () => {
  it('has 15 cards with unique ids, split 5 attacks, 5 skills, 5 sigil spells', () => {
    expect(CARDS).toHaveLength(15);
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(15);
    expect(CARDS_BY_ID.size).toBe(15);
    for (const type of ['attack', 'skill', 'sigil'] as const) {
      expect(CARDS.filter((c) => c.type === type)).toHaveLength(5);
    }
  });

  it('has at least 4 dice cards, and the dice hook is set exactly when an effect uses a roll', () => {
    expect(CARDS.filter((c) => c.dice !== undefined).length).toBeGreaterThanOrEqual(4);
    for (const def of ALL_DEFS) {
      expect(def.dice !== undefined, def.id).toBe(usesDice(def.effects));
      if (def.dice) expect(DIE_IDS).toContain(def.dice);
    }
  });

  it('gives every sigil spell, and only sigil spells, one of the 5 sigil ids', () => {
    const sigils = CARDS.filter((c) => c.type === 'sigil').map((c) => c.sigil);
    expect([...sigils].sort()).toEqual([...SIGIL_IDS].sort());
    for (const def of ALL_DEFS) {
      if (def.type === 'sigil') expect(SIGIL_IDS).toContain(def.sigil);
      else expect(def.sigil, def.id).toBeUndefined();
    }
  });

  it('matches every description to the card effects', () => {
    for (const def of ALL_DEFS) expect(def.description, def.id).toBe(rulesText(def));
  });

  it('gives every card an upgrade that changes it', () => {
    for (const card of CARDS) {
      const up = upgradedCard(card);
      expect(up.id).toBe(`${card.id}+`);
      expect(up.name).toBe(`${card.name}+`);
      expect(up.upgraded).toBe(true);
      expect(up.upgrade).toBeUndefined();
      expect(up.type).toBe(card.type);
      expect(up.sigil).toBe(card.sigil);
      const changed =
        up.cost !== card.cost ||
        up.exhaust !== card.exhaust ||
        JSON.stringify(up.effects) !== JSON.stringify(card.effects);
      expect(changed, card.id).toBe(true);
      expect(() => upgradedCard(up)).toThrow();
    }
  });

  it('resolves base and upgraded ids, and rejects unknown ones', () => {
    expect(getCard('strike')).toBe(CARDS_BY_ID.get('strike'));
    expect(getCard('arc-bolt+')).toEqual(upgradedCard(getCard('arc-bolt')));
    expect(() => getCard('nope')).toThrow('Unknown card nope');
    expect(() => getCard('nope+')).toThrow('Unknown card nope+');
  });

  it('defines a starter deck of 10 valid ids, mostly strikes and defends', () => {
    expect(STARTER_DECK).toHaveLength(10);
    for (const id of STARTER_DECK) expect(CARDS_BY_ID.has(id), id).toBe(true);
    const basics = STARTER_DECK.filter((id) => id === 'strike' || id === 'defend');
    expect(basics.length).toBeGreaterThanOrEqual(8);
    const { state } = startCombat({
      player: { hp: 40, maxHp: 40 },
      deck: deckDefs(STARTER_DECK),
      enemies: [dummy('a')],
      rng: new RunRng('C4RDS000').snapshot(),
    });
    expect(state.piles.draw).toHaveLength(10);
  });

  it('passes engine setup validation for every base and upgraded card', () => {
    expect(() =>
      startCombat({
        player: { hp: 40, maxHp: 40 },
        deck: ALL_DEFS,
        enemies: [dummy('a')],
        rng: new RunRng('C4RDS000').snapshot(),
      }),
    ).not.toThrow();
  });
});
