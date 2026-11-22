import { describe, expect, it } from 'vitest';
import { RunRng } from '../src/core/rng.ts';
import {
  apply,
  type CardDef,
  type CombatState,
  clampMultiplier,
  type Effect,
  playCardWithSigil,
  RulesError,
  SIGIL_MAX_MULTIPLIER,
  SIGIL_MIN_MULTIPLIER,
  scaleAmount,
  scaleEffects,
  startCombat,
} from '../src/rules/index.ts';

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('clampMultiplier', () => {
  it('clamps to [0.5, 1.25]', () => {
    expect(SIGIL_MIN_MULTIPLIER).toBe(0.5);
    expect(SIGIL_MAX_MULTIPLIER).toBe(1.25);
    expect(clampMultiplier(0.2)).toBe(0.5);
    expect(clampMultiplier(-3)).toBe(0.5);
    expect(clampMultiplier(2)).toBe(1.25);
    expect(clampMultiplier(0.8)).toBe(0.8);
    expect(clampMultiplier(0.5)).toBe(0.5);
    expect(clampMultiplier(1.25)).toBe(1.25);
  });

  it('throws for a non-finite multiplier', () => {
    for (const m of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => clampMultiplier(m)).toThrow(RulesError);
      expect(() => scaleEffects([], m)).toThrow(RulesError);
    }
  });
});

describe('scaleAmount rounding (round half up, never below 0)', () => {
  it.each([
    [7, 0.5, 4],
    [6, 1.25, 8],
    [10, 0.75, 8],
    [6, 0.75, 5],
    [5, 0.7, 4],
    [5, 1.1, 6],
    [8, 1, 8],
    [9, 0.6, 5],
    [3, 1.15, 3],
    [1, 0.5, 1],
    [0, 1.25, 0],
  ])('%s × %s → %s', (amount, multiplier, expected) => {
    expect(scaleAmount(amount, multiplier)).toBe(expected);
  });

  it('applies the clamp before rounding', () => {
    expect(scaleAmount(10, 0.1)).toBe(5);
    expect(scaleAmount(10, 3)).toBe(13);
  });

  it('keeps any positive amount at least 1', () => {
    for (let amount = 1; amount <= 30; amount++) {
      expect(scaleAmount(amount, 0)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('scaleEffects', () => {
  const effects: Effect[] = [
    { type: 'damage', amount: 7, hits: 2, target: 'target' },
    { type: 'block', amount: 6 },
    { type: 'apply-status', status: 'vulnerable', stacks: 3, target: 'target' },
    { type: 'gain-steam', amount: 1 },
    { type: 'lose-steam', amount: 1 },
    { type: 'draw', amount: 2 },
  ];

  it('scales damage per hit, block and status stacks; leaves hits, steam and draw alone', () => {
    expect(scaleEffects(effects, 0.5)).toEqual([
      { type: 'damage', amount: 4, hits: 2, target: 'target' },
      { type: 'block', amount: 3 },
      { type: 'apply-status', status: 'vulnerable', stacks: 2, target: 'target' },
      { type: 'gain-steam', amount: 1 },
      { type: 'lose-steam', amount: 1 },
      { type: 'draw', amount: 2 },
    ]);
    expect(scaleEffects(effects, 1.25)).toEqual([
      { type: 'damage', amount: 9, hits: 2, target: 'target' },
      { type: 'block', amount: 8 },
      { type: 'apply-status', status: 'vulnerable', stacks: 4, target: 'target' },
      { type: 'gain-steam', amount: 1 },
      { type: 'lose-steam', amount: 1 },
      { type: 'draw', amount: 2 },
    ]);
  });

  it('scales damage added by Block and healing amounts', () => {
    const bonus = { min: 1, amount: 4 };
    expect(
      scaleEffects(
        [
          { type: 'damage', amount: 12, target: 'target', bonusIfSelfBlock: bonus },
          { type: 'heal', amount: 6, target: 'self' },
        ],
        0.5,
      ),
    ).toEqual([
      { type: 'damage', amount: 6, target: 'target', bonusIfSelfBlock: { min: 1, amount: 2 } },
      { type: 'heal', amount: 3, target: 'self' },
    ]);
  });

  it('returns a new list and never mutates its input', () => {
    const frozen = deepFreeze(structuredClone(effects));
    const out = scaleEffects(frozen, 1);
    expect(out).not.toBe(frozen);
    expect(out).toEqual(effects);
  });

  it('scales the final value of a dice amount, which needs the roll', () => {
    const diceEffects: Effect[] = [
      { type: 'damage', amount: { base: 2, dice: 1 }, target: 'target' },
      { type: 'block', amount: { dice: 2 } },
      { type: 'draw', amount: { dice: 1 } },
    ];
    expect(scaleEffects(diceEffects, 0.5, 5)).toEqual([
      { type: 'damage', amount: 4, target: 'target' },
      { type: 'block', amount: 5 },
      { type: 'draw', amount: { dice: 1 } },
    ]);
    expect(() => scaleEffects(diceEffects, 0.5)).toThrow(RulesError);
  });
});

const sigilBolt: CardDef = {
  id: 'sigil-bolt',
  cost: 1,
  target: 'enemy',
  effects: [{ type: 'damage', amount: 10, target: 'target' }],
};
const diceBolt: CardDef = {
  id: 'dice-bolt',
  cost: 1,
  target: 'enemy',
  effects: [{ type: 'damage', amount: { base: 1, dice: 1 }, target: 'target' }],
};

function combat(deck: CardDef[]): CombatState {
  const started = startCombat({
    player: { hp: 30, maxHp: 30 },
    deck,
    enemies: [
      {
        id: 'dummy',
        name: 'dummy',
        hp: 99,
        moves: [{ id: 'wait', intent: 'unknown', effects: [] }],
      },
    ],
    rng: new RunRng('SP1RE000').snapshot(),
  }).state;
  return apply(started, { type: 'start-turn' }).state;
}

describe('playCardWithSigil through the real engine', () => {
  it.each([
    [0.2, 5],
    [0.75, 8],
    [1, 10],
    [1.25, 13],
    [4, 13],
  ])('multiplier %s deals %s', (multiplier, damage) => {
    const state = deepFreeze(combat([sigilBolt]));
    const { state: after, events } = playCardWithSigil(
      state,
      { type: 'play-card', uid: 0, target: 'dummy' },
      multiplier,
    );
    expect(events.find((e) => e.type === 'damage-dealt')).toMatchObject({ amount: damage });
    expect(after.enemies[0]?.hp).toBe(99 - damage);
  });

  it('spends all stored Charge before applying the boosted effects above the trace cap', () => {
    const base = combat([sigilBolt]);
    const player = { ...base.player, statuses: { charge: 4, 'wound-up': 1 } };
    const charged = deepFreeze({ ...base, player });
    const result = playCardWithSigil(charged, { type: 'play-card', uid: 0, target: 'dummy' }, 4);
    expect(result.multiplier).toBeCloseTo(1.65);
    expect(result.state.player.statuses).toEqual({ 'wound-up': 1 });
    expect(result.events.filter((event) => event.type === 'status-ticked')).toEqual([
      { type: 'status-ticked', target: 'player', status: 'charge', from: 4, to: 0 },
    ]);
    expect(result.events.find((e) => e.type === 'damage-dealt')).toMatchObject({ amount: 18 });
    expect(charged.player.statuses.charge).toBe(4);
    expect(() =>
      playCardWithSigil(charged, { type: 'play-card', uid: 0, target: 'missing' }, 1),
    ).toThrow(RulesError);
    expect(charged.player.statuses.charge).toBe(4);
  });

  it('scales the resolved die damage on a charged sigil and preserves Charge on a Fizzle', () => {
    const before = combat([diceBolt]);
    const state = { ...before, player: { ...before.player, statuses: { charge: 3 } } };
    const action = { type: 'play-card', uid: 0, target: 'dummy', dice: 6 } as const;
    const boosted = playCardWithSigil(state, action, 1.25);
    expect(boosted.multiplier).toBeCloseTo(1.55);
    expect(boosted.state.enemies[0]?.hp).toBe(88);
    const fizzled = playCardWithSigil(state, action, 0.5, true);
    expect(fizzled.multiplier).toBe(0.5);
    expect(fizzled.state.enemies[0]?.hp).toBe(95);
    expect(fizzled.state.player.statuses).toEqual({ charge: 3 });
  });

  it('puts the original, unscaled card into the discard pile', () => {
    const state = combat([sigilBolt]);
    const original = state.piles.hand[0];
    const { state: after } = playCardWithSigil(
      state,
      { type: 'play-card', uid: 0, target: 'dummy' },
      0.5,
    );
    expect(after.piles.hand).toEqual([]);
    expect(after.piles.discard).toHaveLength(1);
    expect(after.piles.discard[0]).toBe(original);
    expect(after.piles.discard[0]?.def.effects).toEqual(sigilBolt.effects);
  });

  it('scales a dice card by its rolled value and still records the roll', () => {
    const state = combat([diceBolt]);
    const { events } = playCardWithSigil(
      state,
      { type: 'play-card', uid: 0, target: 'dummy', dice: 6 },
      1.25,
    );
    expect(events).toContainEqual({
      type: 'card-played',
      uid: 0,
      cardId: 'dice-bolt',
      target: 'dummy',
      dice: 6,
    });
    expect(events.find((e) => e.type === 'damage-dealt')).toMatchObject({ amount: 9 });
  });

  it('validates against the unscaled card, so a dice card still needs its roll', () => {
    const state = combat([diceBolt]);
    expect(() =>
      playCardWithSigil(state, { type: 'play-card', uid: 0, target: 'dummy' }, 1),
    ).toThrow(RulesError);
    expect(() =>
      playCardWithSigil(state, { type: 'play-card', uid: 7, target: 'dummy', dice: 3 }, 1),
    ).toThrow(RulesError);
  });
});
