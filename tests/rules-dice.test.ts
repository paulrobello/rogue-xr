import { describe, expect, it } from 'vitest';
import {
  BRASS_D6,
  CRYSTAL_D12,
  DICE,
  DIE_IDS,
  dieById,
  GLASS_D8,
  IRON_D4,
} from '../src/content/dice.ts';
import { RunRng } from '../src/core/rng.ts';
import {
  apply,
  type CardDef,
  type CombatState,
  type DieDef,
  RulesError,
  rollDice,
  rollDie,
  startCombat,
  validateDie,
} from '../src/rules/index.ts';

const SEED = 'SP1RE000';

const diceStrike: CardDef = {
  id: 'dice-strike',
  cost: 1,
  target: 'enemy',
  effects: [{ type: 'damage', amount: { dice: 1 }, target: 'target' }],
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A started player turn with `diceStrike` (uid 0) in hand against a 99 HP dummy with no block. */
function combat(seed = SEED): CombatState {
  const started = startCombat({
    player: { hp: 30, maxHp: 30 },
    deck: [diceStrike],
    enemies: [
      {
        id: 'dummy',
        name: 'dummy',
        hp: 99,
        moves: [{ id: 'wait', intent: 'unknown', effects: [] }],
      },
    ],
    rng: new RunRng(seed).snapshot(),
  }).state;
  return apply(started, { type: 'start-turn' }).state;
}

describe('content dice', () => {
  it('defines each die with its face values', () => {
    expect(DIE_IDS).toEqual(['brass-d6', 'glass-d8', 'iron-d4', 'crystal-d12']);
    expect(BRASS_D6.faces).toEqual([1, 2, 3, 4, 5, 6]);
    expect(GLASS_D8.faces).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(IRON_D4.faces).toEqual([1, 2, 3, 4]);
    expect(CRYSTAL_D12.faces).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const id of DIE_IDS) {
      expect(dieById(id).id).toBe(id);
      expect(DICE[id]).toBe(dieById(id));
      expect(validateDie(dieById(id))).toBeNull();
    }
  });
});

describe('rollDie', () => {
  it('draws once per roll from the dice stream: int(0, faces - 1) picks the face', () => {
    for (const die of Object.values(DICE)) {
      const reference = new RunRng(SEED).stream('dice');
      let rng = new RunRng(SEED).snapshot();
      for (let i = 0; i < 20; i++) {
        const result = rollDie(rng, die);
        const face = reference.int(0, die.faces.length - 1);
        expect(result.roll).toEqual({ die: die.id, face, value: die.faces[face] });
        expect(result.rng.dice).toEqual(reference.snapshot());
        rng = result.rng;
      }
    }
  });

  it('is deterministic per seed and differs across seeds', () => {
    const sequence = (seed: string): number[] => {
      let rng = new RunRng(seed).snapshot();
      return Array.from({ length: 12 }, () => {
        const result = rollDie(rng, GLASS_D8);
        rng = result.rng;
        return result.roll.value;
      });
    };
    expect(sequence(SEED)).toEqual(sequence(SEED));
    expect(sequence(SEED)).not.toEqual(sequence('DEADBEEF'));
  });

  it('lands every face of each die and only their face values', () => {
    for (const die of Object.values(DICE)) {
      let rng = new RunRng(SEED).snapshot();
      const seen = new Set<number>();
      for (let i = 0; i < 400; i++) {
        const result = rollDie(rng, die);
        expect(result.roll.value).toBe(die.faces[result.roll.face]);
        seen.add(result.roll.value);
        rng = result.rng;
      }
      expect([...seen].sort((a, b) => a - b)).toEqual([...die.faces]);
    }
  });

  it('advances only the dice stream and never mutates its input', () => {
    const rng = deepFreeze(new RunRng(SEED).snapshot());
    const result = rollDie(rng, BRASS_D6);
    expect(result.rng.dice).not.toEqual(rng.dice);
    for (const name of ['floor', 'deck', 'loot', 'ai'] as const) {
      expect(result.rng[name]).toBe(rng[name]);
    }
    expect(rng).toEqual(new RunRng(SEED).snapshot());
  });

  it('rejects dice the engine could not apply', () => {
    const rng = new RunRng(SEED).snapshot();
    const bad = (faces: number[]): DieDef => ({ id: 'bad', name: 'bad', faces });
    for (const faces of [[], [1, 2.5], [-1, 2], [Number.NaN]]) {
      expect(validateDie(bad(faces))).not.toBeNull();
      expect(() => rollDie(rng, bad(faces))).toThrow(RulesError);
    }
  });
});

describe('rollDice on a combat state', () => {
  it('changes only rng.dice and leaves every other field identical', () => {
    const state = deepFreeze(combat());
    const { state: next, roll } = rollDice(state, GLASS_D8);
    expect(roll.die).toBe('glass-d8');
    expect(next.rng.dice).toEqual(rollDie(state.rng, GLASS_D8).rng.dice);
    expect(next.rng.dice).not.toEqual(state.rng.dice);
    for (const name of ['floor', 'deck', 'loot', 'ai'] as const) {
      expect(next.rng[name]).toBe(state.rng[name]);
    }
    const { rng: _a, ...rest } = next;
    const { rng: _b, ...before } = state;
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      expect(rest[key]).toBe(before[key]);
    }
  });

  it('the value the presenter receives is exactly the value the engine applies', () => {
    for (const seed of [SEED, 'DEADBEEF', '7Q2M9KX4']) {
      for (const die of Object.values(DICE)) {
        const { state, roll } = rollDice(combat(seed), die);
        const presented = roll.value;
        const { state: after, events } = apply(state, {
          type: 'play-card',
          uid: 0,
          target: 'dummy',
          dice: presented,
        });
        expect(events).toContainEqual({
          type: 'card-played',
          uid: 0,
          cardId: 'dice-strike',
          target: 'dummy',
          dice: presented,
        });
        const hit = events.find((e) => e.type === 'damage-dealt');
        expect(hit).toMatchObject({ source: 'player', target: 'dummy', amount: presented });
        expect(after.enemies[0]?.hp).toBe(99 - presented);
        expect(after.rng.dice).toEqual(state.rng.dice);
      }
    }
  });

  it('successive rolls on the returned state follow the dice stream', () => {
    let state = combat();
    const reference = new RunRng(SEED).stream('dice');
    for (let i = 0; i < 6; i++) {
      const result = rollDice(state, BRASS_D6);
      expect(result.roll.face).toBe(reference.int(0, 5));
      state = result.state;
    }
  });
});
