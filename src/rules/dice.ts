import { type RunRngState, Stream } from '../core/rng.ts';
import { type CombatState, RulesError } from './types.ts';

/**
 * A die the rules can roll. `faces[i]` is the value printed on the model's face `i`, so the presenter
 * can turn a roll's `face` index into the face the physics die must show (D1). The concrete dice live
 * in the content layer (`src/content/dice.ts`); cards name a die by its `id`.
 */
export interface DieDef {
  readonly id: string;
  readonly name: string;
  /** Face values in model face order. Non-empty, each a non-negative integer. */
  readonly faces: readonly number[];
}

/** One resolved roll: which die, which face index lands up, and that face's value. */
export interface DiceRoll {
  readonly die: string;
  readonly face: number;
  readonly value: number;
}

export interface RngRollResult {
  /** The input snapshot with only the `dice` stream advanced. */
  readonly rng: RunRngState;
  readonly roll: DiceRoll;
}

export interface DiceRollResult {
  /** The input combat state with only `rng.dice` advanced. */
  readonly state: CombatState;
  readonly roll: DiceRoll;
}

/** Why `die` cannot be rolled, or `null` when it is valid. */
export function validateDie(die: DieDef): string | null {
  if (die.faces.length === 0) return `Die ${die.id} has no faces`;
  if (die.faces.some((value) => !Number.isInteger(value) || value < 0)) {
    return `Die ${die.id} faces must be non-negative integers`;
  }
  return null;
}

/**
 * Rolls `die` from the `dice` stream of `rng`: exactly one uniform draw, `int(0, faces - 1)`, picks the
 * face. Pure; the input snapshot is not touched. Throws `RulesError` for an invalid die.
 */
export function rollDie(rng: RunRngState, die: DieDef): RngRollResult {
  const problem = validateDie(die);
  if (problem !== null) throw new RulesError(problem);
  const stream = new Stream(rng.dice);
  const face = stream.int(0, die.faces.length - 1);
  return {
    rng: { ...rng, dice: stream.snapshot() },
    roll: { die: die.id, face, value: die.faces[face] as number },
  };
}

/**
 * Resolves a roll before presentation (D1). Flow: `rollDice` → the presenter throws the physics die
 * and turns `roll.face` up → `apply(state, { type: 'play-card', uid, target, dice: roll.value })` on
 * the returned state. The engine never advances the `dice` stream itself, so the returned state must be
 * the one passed to `apply`, or the next roll repeats this one.
 */
export function rollDice(state: CombatState, die: DieDef): DiceRollResult {
  const { rng, roll } = rollDie(state.rng, die);
  return { state: { ...state, rng }, roll };
}
