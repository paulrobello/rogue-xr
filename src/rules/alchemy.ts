import { normalizeSeed, Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type {
  FollowupRecipe,
  Ingredient,
  StoredAlchemyState,
  StoredConservatoryFormula,
} from './types.ts';

export type {
  FollowupRecipe,
  Ingredient,
  StoredAlchemyState,
  StoredConservatoryFormula,
} from './types.ts';

export function alchemyRecipe(seed: string): readonly [Ingredient, Ingredient] {
  const stream = Stream.fromKey(`${normalizeSeed(seed)}:alchemy-recipe-v1`);
  const order = stream.shuffle<Ingredient>([0, 1, 2]);
  return [order[0] as Ingredient, order[1] as Ingredient];
}

export function readAlchemy(run: Pick<RunState, 'alchemy'>): StoredAlchemyState {
  return run.alchemy ?? { found: [], added: [], brewed: false, opened: false };
}

export function collectIngredient(run: RunState, ingredient: Ingredient): RunState | null {
  const state = readAlchemy(run);
  if (![0, 1, 2].includes(ingredient) || state.found.includes(ingredient)) return null;
  return { ...run, alchemy: { ...state, found: [...state.found, ingredient] } };
}

export function addIngredient(
  run: RunState,
  ingredient: Ingredient,
): { run: RunState; correct: boolean } | null {
  const state = readAlchemy(run);
  if (state.brewed || !state.found.includes(ingredient)) return null;
  const recipe = alchemyRecipe(run.seed);
  const expected = recipe[state.added.length];
  if (expected !== ingredient) {
    return { run: { ...run, alchemy: { ...state, added: [] } }, correct: false };
  }
  const added = [...state.added, ingredient] as Ingredient[];
  return {
    run: { ...run, alchemy: { ...state, added, brewed: added.length === 2 } },
    correct: true,
  };
}

export function applyPotion(run: RunState): RunState | null {
  const state = readAlchemy(run);
  if (!state.brewed || state.opened) return null;
  return { ...run, alchemy: { ...state, opened: true } };
}

export type FormulaClue = 'portrait' | 'record';
export const ingredientNames = ['Mooncap', 'Star-thistle', 'Ember salt'] as const;
export const brewNames: Readonly<Record<FollowupRecipe, string>> = {
  'lantern-ink': 'Lantern Ink',
  stillwind: 'Stillwind Tincture',
  'looking-glass': 'Looking-glass Elixir',
};

export function conservatoryFormula(seed: string) {
  const stream = Stream.fromKey(normalizeSeed(seed) + ':conservatory-followup-v1');
  const recipe = stream.pick<FollowupRecipe>(['lantern-ink', 'stillwind', 'looking-glass']);
  const primary = alchemyRecipe(seed);
  const unused = (3 - primary[0] - primary[1]) as Ingredient;
  const reused = stream.pick(primary);
  const ingredients: readonly [Ingredient, Ingredient] =
    stream.next() < 0.5 ? [unused, reused] : [reused, unused];
  return { recipe, ingredients, quietHour: stream.int(1, 12) };
}

export function formulaClueOrder(recipe: FollowupRecipe, clue: FormulaClue): 0 | 1 {
  return (clue === 'portrait') === (recipe !== 'looking-glass') ? 0 : 1;
}

export function formulaObservation(seed: string, clue: FormulaClue): string {
  const plan = conservatoryFormula(seed),
    i = formulaClueOrder(plan.recipe, clue);
  const order = i === 0 ? 'I' : 'II';
  const line = `${order} · ${ingredientNames[plan.ingredients[i]]}`;
  return clue === 'record' && plan.recipe === 'stillwind'
    ? `${line} · Still at ${plan.quietHour} o’clock`
    : line;
}

export function readConservatoryFormula(
  run: Pick<RunState, 'conservatoryFormula' | 'seed'>,
): StoredConservatoryFormula {
  return (
    run.conservatoryFormula ?? {
      recipe: conservatoryFormula(run.seed).recipe,
      clues: [],
      added: [],
      brewed: false,
      revealed: false,
      opened: false,
    }
  );
}

export function learnFormulaClue(run: RunState, clue: FormulaClue): RunState | null {
  const state = readConservatoryFormula(run);
  if (state.clues.includes(clue)) return null;
  return { ...run, conservatoryFormula: { ...state, clues: [...state.clues, clue] } };
}

export function addFormulaIngredient(
  run: RunState,
  ingredient: Ingredient,
  inStillInterval: boolean,
): { run: RunState; correct: boolean; waiting?: boolean } | null {
  const state = readConservatoryFormula(run);
  if (
    !run.alchemy?.opened ||
    !run.alchemy.found.includes(ingredient) ||
    state.brewed ||
    state.clues.length !== 2
  )
    return null;
  if (state.recipe === 'stillwind' && !state.added.length && !inStillInterval)
    return { run, correct: false, waiting: true };
  const correct = conservatoryFormula(run.seed).ingredients[state.added.length] === ingredient;
  const added = correct ? [...state.added, ingredient] : [];
  return {
    run: { ...run, conservatoryFormula: { ...state, added, brewed: added.length === 2 } },
    correct,
  };
}

export function revealFormula(run: RunState): RunState | null {
  const state = readConservatoryFormula(run);
  if (!state.brewed || state.revealed) return null;
  return {
    ...run,
    conservatoryFormula: { ...state, revealed: true, opened: state.recipe !== 'lantern-ink' },
  };
}

export function unlatchArchive(run: RunState): RunState | null {
  const state = readConservatoryFormula(run);
  return state.recipe === 'lantern-ink' && state.revealed && !state.opened
    ? { ...run, conservatoryFormula: { ...state, opened: true } }
    : null;
}
