import { describe, expect, it } from 'vitest';
import { CombatController } from '../src/combat-view/controller.ts';
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
import { dieById } from '../src/content/dice.ts';
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
  PLAYER_ID,
  playCardWithSigil,
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
  if (def.dice === 'iron-d4') return 4;
  if (def.dice === 'crystal-d12') return 14;
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
  readonly pile?: 'discard' | 'exhaust' | 'mechanisms';
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
  'echo-glyph': { hp: [60, 60], steam: 1 },
  'echo-glyph+': { hp: [60, 60], steam: 2 },
  'lens-focus': { hp: [60, 60], enemyStatuses: [{ vulnerable: 3 }, {}], steam: 2 },
  'lens-focus+': { hp: [60, 60], enemyStatuses: [{ vulnerable: 4 }, {}], steam: 2 },
  counterstroke: { hp: [50, 60], block: 0, steam: 1 },
  'counterstroke+': { hp: [47, 60], block: 0, steam: 1 },
  'quench-seal': { hp: [60, 60], block: 4, steam: 2 },
  'quench-seal+': { hp: [60, 60], block: 5, steam: 2 },
  'brass-bulwark': { hp: [60, 60], block: 14, steam: 0 },
  'brass-bulwark+': { hp: [60, 60], block: 18, steam: 0 },
  'anchor-glyph': { hp: [60, 60], block: 8, steam: 2, playerStatuses: { plating: 2 } },
  'anchor-glyph+': { hp: [60, 60], block: 11, steam: 2, playerStatuses: { plating: 3 } },
  'iron-knuckle': { hp: [46, 60], steam: 1 },
  'iron-knuckle+': { hp: [42, 60], steam: 1 },
  'rivet-plate': { hp: [60, 60], steam: 2, playerStatuses: { plating: 3 } },
  'rivet-plate+': { hp: [60, 60], steam: 2, playerStatuses: { plating: 4 } },
  'shear-pin': { hp: [53, 60], steam: 2 },
  'shear-pin+': { hp: [51, 60], steam: 2 },
  'rust-spray': { hp: [60, 60], steam: 2, enemyStatuses: [{ rust: 2 }, { rust: 2 }] },
  'rust-spray+': { hp: [60, 60], steam: 2, enemyStatuses: [{ rust: 3 }, { rust: 3 }] },
  'torque-wrench': { hp: [54, 60], steam: 2, enemyStatuses: [{ rust: 1 }, {}] },
  'torque-wrench+': { hp: [51, 60], steam: 2, enemyStatuses: [{ rust: 2 }, {}] },
  counterweight: { hp: [60, 60], block: 12, steam: 1 },
  'counterweight+': { hp: [60, 60], block: 16, steam: 1 },
  'tension-coil': { hp: [60, 60], block: 4, steam: 2, playerStatuses: { 'wound-up': 1 } },
  'tension-coil+': { hp: [60, 60], block: 6, steam: 2, playerStatuses: { 'wound-up': 1 } },
  'spare-parts': { hp: [60, 60], steam: 2, drawn: 2 },
  'spare-parts+': { hp: [60, 60], steam: 2, drawn: 3 },
  'flywheel-swing': { hp: [48, 60], steam: 1 },
  'flywheel-swing+': { hp: [45, 60], steam: 1 },
  'patch-kit': { hp: [60, 60], steam: 2, pile: 'exhaust' },
  'patch-kit+': { hp: [60, 60], steam: 2, pile: 'exhaust' },
  'field-dressing': { hp: [60, 60], steam: 1, block: 9, pile: 'exhaust' },
  'field-dressing+': { hp: [60, 60], steam: 1, block: 12, pile: 'exhaust' },
  'redline-shot': { hp: [42, 60], steam: 2 },
  'redline-shot+': { hp: [37, 60], steam: 2 },
  'boiler-gamble': { hp: [60, 60], steam: 5, drawn: 1 },
  'boiler-gamble+': { hp: [60, 60], steam: 5, drawn: 2 },
  'grease-gun': { hp: [60, 60], steam: 3 },
  'grease-gun+': { hp: [60, 60], steam: 3, drawn: 1 },
  'escapement-break': { hp: [60, 60], steam: 2 },
  'escapement-break+': { hp: [57, 60], block: 3, steam: 2 },
  'lucky-strike': { hp: [54, 60], steam: 2 },
  'lucky-strike+': { hp: [52, 60], steam: 2 },
  capacitor: { hp: [60, 60], steam: 2, drawn: 1, playerStatuses: { charge: 2 } },
  'capacitor+': { hp: [60, 60], steam: 2, drawn: 1, playerStatuses: { charge: 3 } },
  'copper-coil': { hp: [55, 60], steam: 2, playerStatuses: { charge: 1 } },
  'copper-coil+': { hp: [53, 60], steam: 2, playerStatuses: { charge: 1 } },
  'flash-boiler': { hp: [60, 60], steam: 0, block: 12 },
  'flash-boiler+': { hp: [60, 60], steam: 0, block: 15 },
  'overdrive-piston': { hp: [39, 60], steam: 0 },
  'overdrive-piston+': { hp: [33, 60], steam: 0 },
  'reroll-lever': { hp: [60, 60], steam: 3 },
  'reroll-lever+': { hp: [60, 60], steam: 3, drawn: 1 },
  'loaded-die': { hp: [60, 60], steam: 3, drawn: 1, pile: 'exhaust' },
  'loaded-die+': { hp: [60, 60], steam: 3, drawn: 1 },
  'crystal-gambit': { hp: [46, 60], steam: 0 },
  'crystal-gambit+': { hp: [42, 60], steam: 0 },
  'gyro-stabilizer': { hp: [60, 60], steam: 1, pile: 'mechanisms' },
  'gyro-stabilizer+': { hp: [60, 60], steam: 1, pile: 'mechanisms' },
  'pressure-gauge': { hp: [60, 60], steam: 2, pile: 'mechanisms' },
  'pressure-gauge+': { hp: [60, 60], steam: 3, pile: 'mechanisms' },
  'clockwork-turret': { hp: [60, 60], steam: 1, pile: 'mechanisms' },
  'clockwork-turret+': { hp: [60, 60], steam: 1, pile: 'mechanisms' },
  'furnace-heart': { hp: [60, 60], steam: 0, pile: 'mechanisms' },
  'furnace-heart+': { hp: [60, 60], steam: 0, pile: 'mechanisms' },
  'arc-chain': { hp: [55, 57], steam: 2 },
  'arc-chain+': { hp: [53, 56], steam: 2 },
  'gear-grinder': { hp: [52, 60], steam: 2 },
  'gear-grinder+': { hp: [50, 60], steam: 2 },
  'pendulum-ward': { hp: [60, 60], steam: 1, block: 10, playerStatuses: { plating: 2 } },
  'pendulum-ward+': { hp: [60, 60], steam: 1, block: 14, playerStatuses: { plating: 3 } },
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
    if (def.echoSigil) {
      expect(() => apply(before, playAction(def))).toThrow('Cast a sigil successfully before Echo');
      return;
    }
    const played = apply(before, playAction(def));
    const settled = played.state.scry
      ? apply(played.state, { type: 'resolve-scry', discard: [] })
      : null;
    const state = settled?.state ?? played.state;
    const events = [...played.events, ...(settled?.events ?? [])];

    expect(state.enemies.map((e) => e.hp)).toEqual(expected.hp);
    expect(state.enemies.map((e) => e.statuses)).toEqual(expected.enemyStatuses ?? [{}, {}]);
    expect(state.player.block).toBe(expected.block ?? 0);
    expect(state.player.steam).toBe(expected.steam);
    expect(state.player.statuses).toEqual(expected.playerStatuses ?? {});
    expect(state.piles.hand).toHaveLength(before.piles.hand.length - 1 + (expected.drawn ?? 0));
    const pile = expected.pile ?? 'discard';
    const cards = pile === 'mechanisms' ? (state.mechanisms ?? []) : state.piles[pile];
    expect(cards.map((c) => c.uid)).toContain(0);
    expect(events).toContainEqual<CombatEvent>({
      type: 'card-played',
      uid: 0,
      cardId: def.id,
      target: def.target === 'enemy' ? 'a' : null,
      dice: rollFor(def) ?? null,
      ...(def.cost === 'X' ? { steamSpent: STEAM_PER_TURN } : {}),
    });
  });

  it.each([
    ['flywheel-swing', 16],
    ['flywheel-swing+', 20],
  ])('%s spends two steam and adds to one hit when the player has Block', (id, damage) => {
    const def = getCard(id);
    const before = begin(def);
    const result = apply({ ...before, player: { ...before.player, block: 1 } }, playAction(def));
    const hits = result.events.filter((event) => event.type === 'damage-dealt');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ amount: damage, hpLost: damage });
    expect(result.state.player.block).toBe(1);
    expect(result.state.player.steam).toBe(1);
  });

  it.each([
    ['patch-kit', 6],
    ['patch-kit+', 9],
    ['field-dressing', 5],
    ['field-dressing+', 7],
  ])('%s restores only missing HP and exhausts at full health too', (id, maxHeal) => {
    const def = getCard(id);
    for (const hp of [25, 38, 40]) {
      const before = begin(def);
      const result = apply({ ...before, player: { ...before.player, hp } }, playAction(def));
      const amount = Math.min(40 - hp, maxHeal);
      expect(result.state.player.hp).toBe(hp + amount);
      expect(result.events.filter((event) => event.type === 'healed')).toEqual(
        amount > 0 ? [{ type: 'healed', amount, target: PLAYER_ID }] : [],
      );
      expect(result.state.piles.exhaust).toHaveLength(1);
      expect(result.state.piles.discard).toHaveLength(0);
    }
  });

  it('Spare Parts can draw through a reshuffle and never draws itself or creates a card', () => {
    const def = getCard('spare-parts+');
    const before = begin(def);
    const [last, spare] = before.piles.draw;
    const played = apply(
      {
        ...before,
        piles: { ...before.piles, draw: [last], discard: [spare] },
      },
      playAction(def),
    );
    expect(
      played.events.filter((event) => event.type === 'card-drawn').map((event) => event.uid),
    ).toEqual([last.uid, spare.uid]);
    expect(played.state.piles.discard.map((card) => card.uid)).toEqual([0]);
    expect(played.state.piles.draw).toEqual([]);
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

describe('Overdrive', () => {
  it.each([0, 1, 6])(
    'spends the committed %i Steam and does no damage at zero despite Wound-up',
    (steam) => {
      const before = begin(getCard('overdrive-piston+'));
      const charged = {
        ...before,
        player: { ...before.player, steam, statuses: { 'wound-up': 2 } },
      };
      const { state, events } = apply(charged, { type: 'play-card', uid: 0, target: 'a' });
      expect(state.player.steam).toBe(0);
      expect(state.enemies[0].hp).toBe(ENEMY_HP - (steam === 0 ? 0 : steam * 9 + 2));
      expect(events.filter((e) => e.type === 'steam-changed')).toHaveLength(steam === 0 ? 0 : 1);
      expect(events.filter((e) => e.type === 'damage-dealt')).toHaveLength(steam === 0 ? 0 : 1);
      expect(events).toContainEqual({
        type: 'card-played',
        uid: 0,
        cardId: 'overdrive-piston+',
        target: 'a',
        dice: null,
        steamSpent: steam,
      });
      expect(state.piles.discard.some((c) => c.uid === 0)).toBe(true);
    },
  );

  it('scales later effects with the Steam spent before the card grants new Steam', () => {
    const before = begin({
      id: 'test-overdrive',
      cost: 'X',
      target: 'none',
      effects: [
        { type: 'gain-steam', amount: 1 },
        { type: 'block', amount: { perSteam: 4 } },
      ],
    });
    const { state } = apply(before, { type: 'play-card', uid: 0 });
    expect(state.player.steam).toBe(1);
    expect(state.player.block).toBe(12);
    const { events: empty } = apply(
      { ...before, player: { ...before.player, steam: 0 } },
      { type: 'play-card', uid: 0 },
    );
    expect(empty.some((event) => event.type === 'block-gained')).toBe(false);
  });

  it('rejects a per-Steam effect on a fixed-cost card', () => {
    expect(() =>
      begin({
        id: 'fixed-overdrive',
        cost: 1,
        target: 'none',
        effects: [{ type: 'block', amount: { perSteam: 4 } }],
      }),
    ).toThrow(/perSteam.*X cost/);
  });
});

describe('Wave A deck control', () => {
  it('Lens Focus scales its Eye cast, targets the enemy, then settles after Scry', () => {
    const before = begin(getCard('lens-focus+'));
    const first = before.piles.draw[0];
    const second = before.piles.draw[1];
    if (!first || !second) throw new Error('Lens Focus test needs two draw cards');
    const played = playCardWithSigil(before, { type: 'play-card', uid: 0, target: 'a' }, 1.25);
    expect(played.state.phase).toBe('scry');
    expect(played.state.enemies[0]?.statuses).toEqual({ vulnerable: 5 });
    expect(played.state.player.steam).toBe(2);
    expect(played.state.scry?.count).toBe(2);
    const settled = apply(played.state, { type: 'resolve-scry', discard: [first.uid] });
    expect(settled.state.piles.discard.map((card) => card.uid)).toEqual([first.uid, 0]);
    expect(settled.state.piles.draw[0]?.uid).toBe(second.uid);
    expect(settled.state.scry).toBeUndefined();
  });

  it('pauses combat, preserves reveal order and draws only after the discard choice', () => {
    const before = begin(getCard('grease-gun+'));
    const { state, events } = apply(before, { type: 'play-card', uid: 0 });
    expect(state.phase).toBe('scry');
    expect(state.scry).toMatchObject({ count: 4, drawAfter: 1 });
    expect(events).toContainEqual({ type: 'scry-ready', count: 4 });
    expect(state.piles.draw).toEqual(before.piles.draw);
    expect(state.piles.discard).toEqual([]);
    expect(validate(state, { type: 'end-turn' })).not.toBeNull();
    expect(validate(state, { type: 'play-card', uid: state.piles.hand[0].uid })).not.toBeNull();
    const [first, second, third, fourth, ...rest] = state.piles.draw;
    expect(
      validate(state, { type: 'resolve-scry', discard: [first.uid, first.uid] }),
    ).not.toBeNull();
    expect(validate(state, { type: 'resolve-scry', discard: [0] })).not.toBeNull();

    const done = apply(state, { type: 'resolve-scry', discard: [third.uid, first.uid] });
    expect(done.state.phase).toBe('player');
    expect(done.state.scry).toBeUndefined();
    expect(done.state.piles.draw).toEqual([fourth, ...rest]);
    expect(done.state.piles.hand.at(-1)).toEqual(second);
    expect(done.state.piles.discard.map(({ uid }) => uid)).toEqual([first.uid, third.uid, 0]);
    expect(done.events).toContainEqual({ type: 'scry-finished', discarded: 2 });
  });

  it('skips an empty Scry and shuffles the discard only to draw the upgrade card', () => {
    const before = begin(getCard('grease-gun+'));
    const { draw, ...piles } = before.piles;
    const { state, events } = apply(
      { ...before, piles: { ...piles, draw: [], discard: draw } },
      { type: 'play-card', uid: 0 },
    );
    expect(state.phase).toBe('player');
    expect(state.piles.hand.at(-1)?.uid).not.toBe(0);
    expect(state.piles.hand).toHaveLength(before.piles.hand.length);
    expect(state.piles.discard.map(({ uid }) => uid)).toEqual([0]);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'scry-ready' }));
  });

  it('uses current Block for one hit after the upgrade grants Block', () => {
    for (const [id, damage] of [
      ['escapement-break', 8],
      ['escapement-break+', 11],
    ] as const) {
      const before = begin(getCard(id));
      const { state, events } = apply(
        { ...before, player: { ...before.player, block: 8 } },
        { type: 'play-card', uid: 0, target: 'a' },
      );
      expect(state.player.block).toBe(damage);
      expect(state.enemies[0].hp).toBe(ENEMY_HP - damage);
      expect(events.filter((e) => e.type === 'damage-dealt')).toHaveLength(1);
    }
  });

  it.each([1, 4, 5, 6])('Lucky Strike resolves the threshold on a roll of %i', (dice) => {
    for (const [card, damage] of [
      ['lucky-strike', dice >= 5 ? 18 : 6],
      ['lucky-strike+', dice >= 5 ? 20 : 8],
    ] as const) {
      const { state } = apply(begin(getCard(card)), {
        type: 'play-card',
        uid: 0,
        target: 'a',
        dice,
      });
      expect(state.enemies[0].hp).toBe(ENEMY_HP - damage);
    }
  });
});

const STATUS_NAMES: Readonly<Record<StatusId, string>> = {
  weak: 'Weak',
  vulnerable: 'Vulnerable',
  overheat: 'Overheat',
  'wound-up': 'Wound-up',
  plating: 'Plating',
  rust: 'Rust',
  charge: 'Charge',
};

function amountText(amount: Amount): string {
  if (typeof amount === 'number') return String(amount);
  if ('atLeast' in amount || 'perSteam' in amount)
    throw new Error('Variable damage has its own wording');
  const roll = amount.dice === 1 ? 'roll' : `${amount.dice} × roll`;
  return amount.base ? `${amount.base} + ${roll}` : roll;
}

function effectText(effect: Effect): string {
  switch (effect.type) {
    case 'damage': {
      if (typeof effect.amount === 'object' && 'perSteam' in effect.amount)
        return `Deal ${effect.amount.perSteam} damage per Steam spent.`;
      if (typeof effect.amount === 'object' && 'atLeast' in effect.amount) {
        const { atLeast, high, low } = effect.amount;
        return `Deal ${high} damage on a ${atLeast} or 6, otherwise ${low}.`;
      }
      const all =
        effect.target === 'all-opponents'
          ? ' to all enemies'
          : effect.target === 'other-opponents'
            ? ' to each other enemy'
            : '';
      const hits = (effect.hits ?? 1) > 1 ? ` ${effect.hits} times` : '';
      const bonus = effect.bonusIfSelfBlock
        ? ` If you have Block, deal ${amountText(effect.bonusIfSelfBlock.amount)} more damage.`
        : '';
      const rust =
        effect.extraHitsIfTargetRust === 1 ? ' Hit once more if the target has Rust.' : '';
      return `Deal ${amountText(effect.amount)} damage${all}${hits}.${bonus}${rust}`;
    }
    case 'damage-from-block':
      return 'Deal damage equal to your Block.';
    case 'scry':
      return `Scry ${effect.count}.${effect.drawAfter ? ` Draw ${effect.drawAfter} card${effect.drawAfter === 1 ? '' : 's'}.` : ''}`;
    case 'load-die':
      return 'Your next die this turn is Loaded.';
    case 'allow-reroll':
      return 'You may reroll your next throw once.';
    case 'block':
      if (typeof effect.amount === 'object' && 'perSteam' in effect.amount)
        return `Gain ${effect.amount.perSteam} Block per Steam spent.`;
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
    case 'conditional-block':
      return `If its intent hits twice or more, gain ${amountText(effect.amount)} Block.`;
    case 'heal':
      return `Heal ${amountText(effect.amount)} HP.`;
    case 'block-from-status':
      return `Trace Quench. Remove up to ${effect.maxStacks} enemy Overheat. Gain ${effect.base} Block + ${effect.perStack} per stack spent.`;
  }
}

/** Canonical rules text; every card's hand-written description must equal it. */
function rulesText(def: SliceCard): string {
  if (def.echoSigil) return def.description;
  if (def.diceCount === 2) {
    const effect = def.effects[0];
    if (
      effect?.type !== 'damage' ||
      typeof effect.amount !== 'object' ||
      !('dice' in effect.amount)
    )
      throw Error(`Missing sum damage for ${def.id}`);
    return effect.amount.base
      ? `Roll two d12s. Deal their sum + ${effect.amount.base} damage.`
      : 'Roll two d12s. Deal their sum as damage.';
  }
  if (def.mechanism) {
    const { timing, effects, target } = def.mechanism;
    const phase = timing === 'start-turn' ? 'start' : 'end';
    const text = effects
      .map((effect) => {
        if (effect.type === 'damage' && target === 'least-hp')
          return `Deal ${amountText(effect.amount)} damage to the enemy with the least HP.`;
        return effectText(effect);
      })
      .join(' ');
    return `At turn ${phase}, ${text[0].toLowerCase()}${text.slice(1)}`;
  }
  const parts: string[] = [];
  if (def.dice)
    parts.push(
      `Roll ${def.dice === 'iron-d4' ? 'an iron d4' : `a ${def.dice === 'brass-d6' ? 'd6' : 'd8'}`}.`,
    );
  if (def.rollRisk) {
    const success = def.effects.map((effect) => effectText(effect).slice(0, -1)).join(' and ');
    const miss = effectText(def.rollRisk.miss);
    parts.push(
      `On ${def.rollRisk.minimum}+, ${success[0].toLowerCase()}${success.slice(1)}. Otherwise ${miss[0].toLowerCase()}${miss.slice(1)}`,
    );
  } else parts.push(...def.effects.map(effectText));
  if (def.exhaust) parts.push('Exhaust.');
  if (def.pinned) parts.push('Pinned.');
  return parts.join(' ');
}

describe('risk cards', () => {
  it.each([
    ['redline-shot', 3, 'overheat', 3],
    ['redline-shot+', 1, 'overheat', 3],
    ['boiler-gamble', 4, 'vulnerable', 2],
    ['boiler-gamble+', 1, 'vulnerable', 2],
  ] as const)('%s on %i spends Steam and applies only its penalty', (id, dice, status, stacks) => {
    const card = getCard(id);
    const state = begin(card);
    const action = {
      type: 'play-card' as const,
      uid: 0,
      ...(card.target === 'enemy' ? { target: 'a' } : {}),
    };
    expect(validate(state, action)).toContain('needs a dice result');
    const result = apply(state, { ...action, dice });
    expect(result.state.player.steam).toBe(2);
    expect(result.state.player.statuses).toEqual({ [status]: stacks });
    expect(result.state.enemies).toEqual(state.enemies);
    expect(result.state.piles.draw).toEqual(state.piles.draw);
    expect(result.state.piles.discard[0].def.id).toBe(id);
  });

  it.each([5, 8])('Boiler Gamble succeeds on %i without applying Vulnerable', (dice) => {
    const state = begin(getCard('boiler-gamble'));
    const result = apply(state, { type: 'play-card', uid: 0, dice });
    expect(result.state.player.steam).toBe(5);
    expect(result.state.player.statuses).toEqual({});
    expect(result.state.piles.draw).toHaveLength(state.piles.draw.length - 1);
  });

  it('uses the kept Loaded result and applies a rerolled penalty only after confirmation', () => {
    const fight = (reroll: boolean) => {
      const combat = new CombatController({
        seed: 'R1SK0019',
        setups: [dummy('a')],
        deck: ['loaded-die', 'reroll-lever', 'redline-shot', 'strike', 'defend'],
      });
      const select = (id: string) => {
        const card = combat.state.piles.hand.find((entry) => entry.def.id === id);
        if (!card) throw Error(`Missing ${id}`);
        expect(combat.select(card.uid).ok).toBe(true);
      };
      select('loaded-die');
      expect(combat.table().ok).toBe(true);
      if (reroll) {
        select('reroll-lever');
        expect(combat.table().ok).toBe(true);
      }
      select('redline-shot');
      expect(combat.target('a').ok).toBe(true);
      expect(combat.lastDice).toMatchObject({ rolls: [3, 4], value: 4 });
      return combat;
    };
    expect(fight(false).state.enemies[0].hp).toBe(42);
    const rerolled = fight(true);
    expect(rerolled.state.enemies[0].hp).toBe(60);
    expect(rerolled.state.player.statuses).toEqual({});
    expect(rerolled.rerollDice()).toBe(true);
    expect(rerolled.lastDice?.value).toBe(2);
    expect(rerolled.confirmDice()).toBe(true);
    expect(rerolled.confirmDice()).toBe(false);
    expect(rerolled.state.enemies[0].hp).toBe(60);
    expect(rerolled.state.player.statuses.overheat).toBe(3);
  });
});

describe('card schema', () => {
  it('has the complete card roster with unique ids', () => {
    expect(CARDS).toHaveLength(51);
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(CARDS.length);
    expect(CARDS_BY_ID.size).toBe(CARDS.length);
    expect(CARDS.filter((c) => c.type === 'attack')).toHaveLength(17);
    expect(CARDS.filter((c) => c.type === 'skill')).toHaveLength(19);
    expect(CARDS.filter((c) => c.type === 'sigil')).toHaveLength(11);
    expect(CARDS.filter((c) => c.type === 'mechanism')).toHaveLength(4);
  });

  it('has at least 4 dice cards, and the dice hook is set exactly when an effect uses a roll', () => {
    expect(CARDS.filter((c) => c.dice !== undefined).length).toBeGreaterThanOrEqual(4);
    for (const def of ALL_DEFS) {
      expect(def.dice !== undefined, def.id).toBe(Boolean(def.rollRisk) || usesDice(def.effects));
      if (def.dice) expect(DIE_IDS).toContain(def.dice);
      if (def.dice && def.rollRisk) {
        const faces = dieById(def.dice).faces;
        expect(def.rollRisk.minimum).toBeGreaterThan(Math.min(...faces));
        expect(def.rollRisk.minimum).toBeLessThanOrEqual(Math.max(...faces));
      }
    }
  });

  it('gives every sigil spell, and only sigil spells, a known sigil id', () => {
    const sigils = CARDS.filter((c) => c.type === 'sigil').map((c) => c.sigil);
    expect(
      new Set([...sigils, ...CARDS.flatMap((c) => (c.upgrade?.sigil ? [c.upgrade.sigil] : []))])
        .size,
    ).toBeGreaterThanOrEqual(SIGIL_IDS.length);
    for (const def of ALL_DEFS) {
      if (def.type === 'sigil') expect(SIGIL_IDS).toContain(def.sigil);
      else expect(def.sigil, def.id).toBeUndefined();
    }
  });

  it('assigns every shipped sigil card id, including upgrades, a unique glyph pattern', () => {
    const ids = CARDS.filter((card) => card.type === 'sigil').flatMap((card) => [
      card.id,
      `${card.id}+`,
    ]);
    const sigils = ids.map((id) => getCard(id).sigil);
    expect(ids).toHaveLength(22);
    expect(new Set(sigils).size).toBe(SIGIL_IDS.length);
    expect(new Set(sigils).size).toBe(SIGIL_IDS.length);
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
      expect(up.sigil).toBe(card.upgrade?.sigil ?? card.sigil);
      const changed =
        up.cost !== card.cost ||
        up.exhaust !== card.exhaust ||
        JSON.stringify(up.effects) !== JSON.stringify(card.effects) ||
        JSON.stringify(up.mechanism) !== JSON.stringify(card.mechanism);
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
    expect(basics).toHaveLength(7);
    expect(STARTER_DECK.filter((id) => id === 'patch-kit')).toHaveLength(1);
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
