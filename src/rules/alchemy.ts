import { normalizeSeed, Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { Ingredient, StoredAlchemyState } from './types.ts';

export type { Ingredient, StoredAlchemyState } from './types.ts';

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
