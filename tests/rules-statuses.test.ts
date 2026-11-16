import { describe, expect, it } from 'vitest';
import { RunRng } from '../src/core/rng.ts';
import {
  absorb,
  apply,
  attackDamage,
  type CardDef,
  type EnemySetup,
  type Fighter,
  type Statuses,
  startCombat,
  withStacks,
} from '../src/rules/index.ts';

const fighter = (statuses: Statuses = {}): Fighter => ({ hp: 50, maxHp: 50, block: 0, statuses });
const card = (id: string, extra: Partial<CardDef> = {}): CardDef => ({
  id,
  cost: 1,
  target: 'enemy',
  effects: [{ type: 'damage', amount: 6, target: 'target' }],
  ...extra,
});
const idle = (id = 'dummy', hp = 40): EnemySetup => ({
  id,
  name: id,
  hp,
  moves: [{ id: 'wait', intent: 'unknown', effects: [] }],
});

function begin(deck: CardDef[], enemies: EnemySetup[] = [idle()], playerStatuses: Statuses = {}) {
  return startCombat({
    player: { hp: 30, maxHp: 30, statuses: playerStatuses },
    deck,
    enemies,
    rng: new RunRng('STAT0000').snapshot(),
  }).state;
}

describe('attackDamage', () => {
  it('passes base damage through with no statuses', () => {
    expect(attackDamage(6, fighter(), fighter())).toBe(6);
  });

  it('Weak deals 25% less, rounded down', () => {
    expect(attackDamage(6, fighter({ weak: 1 }), fighter())).toBe(4);
    expect(attackDamage(9, fighter({ weak: 3 }), fighter())).toBe(6);
  });

  it('Vulnerable takes 50% more, rounded down', () => {
    expect(attackDamage(5, fighter(), fighter({ vulnerable: 1 }))).toBe(7);
  });

  it('adds Wound-up first, then Weak, then Vulnerable', () => {
    // (5 + 3) = 8, Weak gives 6, Vulnerable gives 9.
    const attacker = fighter({ 'wound-up': 3, weak: 1 });
    expect(attackDamage(5, attacker, fighter({ vulnerable: 1 }))).toBe(9);
  });

  it('never goes below zero', () => {
    expect(attackDamage(0, fighter({ weak: 1 }), fighter())).toBe(0);
  });
});

describe('absorb and withStacks', () => {
  it('block soaks damage before HP', () => {
    expect(absorb(7, 5)).toEqual({ blocked: 5, hpLost: 2 });
    expect(absorb(3, 5)).toEqual({ blocked: 3, hpLost: 0 });
  });

  it('adds stacks and drops statuses that reach zero', () => {
    expect(withStacks({}, 'weak', 2)).toEqual({ weak: 2 });
    expect(withStacks({ weak: 1, vulnerable: 2 }, 'weak', -1)).toEqual({ vulnerable: 2 });
  });
});

describe('status timing in combat', () => {
  it('Vulnerable on an enemy boosts the next hit and decays at the end of that enemy turn', () => {
    const deck = [
      card('expose', {
        effects: [{ type: 'apply-status', status: 'vulnerable', stacks: 1, target: 'target' }],
      }),
      ...Array.from({ length: 4 }, (_, i) => card(`strike${i}`)),
    ];
    let state = apply(begin(deck), { type: 'start-turn' }).state;
    const expose = state.piles.hand.find((c) => c.def.id === 'expose');
    const strike = state.piles.hand.find((c) => c.def.id !== 'expose');
    if (!expose || !strike) throw new Error('setup');
    state = apply(state, { type: 'play-card', uid: expose.uid, target: 'dummy' }).state;
    const hit = apply(state, { type: 'play-card', uid: strike.uid, target: 'dummy' });
    expect(hit.events).toContainEqual(
      expect.objectContaining({ type: 'damage-dealt', amount: 9, hpLost: 9, target: 'dummy' }),
    );
    state = apply(hit.state, { type: 'end-turn' }).state;
    expect(state.enemies[0]?.statuses).toEqual({ vulnerable: 1 });
    const acted = apply(state, { type: 'enemy-act' });
    expect(acted.state.enemies[0]?.statuses).toEqual({});
    expect(acted.events).toContainEqual({
      type: 'status-ticked',
      target: 'dummy',
      status: 'vulnerable',
      from: 1,
      to: 0,
    });
  });

  it('Weak on the player decays at the end of the player turn', () => {
    let state = begin([card('a'), card('b')], [idle()], { weak: 2 });
    state = apply(state, { type: 'start-turn' }).state;
    expect(state.player.statuses).toEqual({ weak: 2 });
    state = apply(state, { type: 'end-turn' }).state;
    expect(state.player.statuses).toEqual({ weak: 1 });
  });

  it('Overheat burns through block at turn start, then loses a stack', () => {
    const { state, events } = apply(begin([card('a')], [idle()], { overheat: 3 }), {
      type: 'start-turn',
    });
    expect(state.player.hp).toBe(27);
    expect(state.player.statuses).toEqual({ overheat: 2 });
    expect(events).toContainEqual({
      type: 'damage-dealt',
      source: null,
      target: 'player',
      kind: 'overheat',
      amount: 3,
      blocked: 0,
      hpLost: 3,
    });
  });

  it('Overheat ignores Vulnerable and block', () => {
    const deck = [card('guard', { target: 'none', effects: [{ type: 'block', amount: 10 }] })];
    let state = apply(begin(deck, [idle()], { overheat: 4, vulnerable: 2 }), {
      type: 'start-turn',
    }).state;
    expect(state.player.hp).toBe(26);
    state = apply(state, { type: 'play-card', uid: 0 }).state;
    expect(state.player.block).toBe(10);
    state = apply(state, { type: 'end-turn' }).state;
    state = apply(state, { type: 'enemy-act' }).state;
    // Block clears before the tick at the start of the next turn; the tick never touches block.
    expect(apply(state, { type: 'start-turn' }).state.player.hp).toBe(23);
  });

  it('Overheat ticks on enemies at the start of their action and can kill them', () => {
    const deck = [
      card('scald', {
        effects: [{ type: 'apply-status', status: 'overheat', stacks: 5, target: 'target' }],
      }),
    ];
    let state = apply(begin(deck, [idle('dummy', 4)]), { type: 'start-turn' }).state;
    const uid = state.piles.hand[0]?.uid ?? -1;
    state = apply(state, { type: 'play-card', uid, target: 'dummy' }).state;
    state = apply(state, { type: 'end-turn' }).state;
    const result = apply(state, { type: 'enemy-act' });
    expect(result.state.outcome).toBe('won');
    expect(result.events.map((e) => e.type)).toEqual([
      'damage-dealt',
      'status-ticked',
      'enemy-died',
      'combat-won',
    ]);
  });

  it('Wound-up adds to every hit and never decays', () => {
    const enemy: EnemySetup = {
      id: 'spring',
      name: 'Spring Hound',
      hp: 30,
      statuses: { 'wound-up': 2 },
      moves: [
        {
          id: 'bite',
          intent: 'attack',
          effects: [{ type: 'damage', amount: 3, hits: 2, target: 'target' }],
        },
      ],
    };
    let state = apply(begin([card('a')], [enemy]), { type: 'start-turn' }).state;
    state = apply(state, { type: 'end-turn' }).state;
    const result = apply(state, { type: 'enemy-act' });
    expect(result.state.player.hp).toBe(30 - 10);
    expect(result.state.enemies[0]?.statuses).toEqual({ 'wound-up': 2 });
  });
});
