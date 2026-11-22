import { describe, expect, it } from 'vitest';
import { CONSERVATORY_SPECIMENS_VERSION } from '../src/combat/encounter-choice.ts';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import {
  alchemyRecipe,
  conservatoryFormula,
  ingredientsFor,
  NEW_SPECIMENS,
} from '../src/rules/alchemy.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const make = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });

describe('conservatory follow-up formula', () => {
  it('requires collecting both brewed potions before use and preserves each pickup on Continue', () => {
    let flow = make();
    const reload = () => {
      const next = make();
      expect(next.continueRun(validateSnapshot(JSON.parse(JSON.stringify(flow.snapshot()))))).toBe(
        true,
      );
      flow = next;
    };
    flow.newRun('F0R123A1');
    expect(flow.travelToFloor(2, 0)).toBe(true);
    expect(flow.learnFormulaClue('portrait')).toBe(false);
    expect(flow.learnFormulaClue('record')).toBe(true);
    expect(flow.travelToFloor(3, 0)).toBe(true);
    expect(flow.learnFormulaClue('record')).toBe(false);
    expect(flow.learnFormulaClue('portrait')).toBe(true);
    for (const ingredient of ingredientsFor(CONSERVATORY_SPECIMENS_VERSION))
      expect(flow.collectIngredient(ingredient)).toBe(true);
    expect(flow.takePotion()).toBe(false);
    for (const ingredient of flow.alchemyRecipe)
      expect(flow.addIngredient(ingredient)).toBe('correct');
    reload();
    expect(flow.applyPotion()).toBe(false);
    expect(flow.takePotion()).toBe(true);
    expect(flow.takePotion()).toBe(false);
    reload();
    expect(flow.alchemy.carried).toBe(true);
    expect(flow.applyPotion()).toBe(true);
    expect(flow.alchemy.carried).toBeUndefined();
    const plan = conservatoryFormula('F0R123A1', CONSERVATORY_SPECIMENS_VERSION);
    expect(flow.addFormulaIngredient(plan.ingredients[0], false)).toBe(
      plan.recipe === 'stillwind' ? 'waiting' : 'correct',
    );
    if (plan.recipe === 'stillwind')
      expect(flow.addFormulaIngredient(plan.ingredients[0], true)).toBe('correct');
    expect(flow.addFormulaIngredient(plan.ingredients[1], true)).toBe('correct');
    reload();
    expect(flow.useFormula('pour')).toBe(false);
    expect(flow.takePotion()).toBe(true);
    reload();
    expect(flow.conservatoryFormula.carried).toBe(true);
    expect(flow.useFormula('pour')).toBe(true);
    expect(flow.conservatoryFormula.carried).toBeUndefined();
    expect(flow.takePotion()).toBe(false);
    expect(flow.conservatoryFormula.opened).toBe(plan.recipe !== 'lantern-ink');
    if (plan.recipe === 'lantern-ink') {
      expect(flow.useFormula('unlatch')).toBe(true);
      expect(flow.conservatoryFormula.opened).toBe(true);
    }
  });
  it('keeps old v5 saves valid without formula state and rejects duplicate clues', () => {
    const flow = make();
    flow.newRun('F0R123A1');
    const snapshot = flow.snapshot(1, 0)!;
    expect(validateSnapshot(snapshot).run.conservatoryFormula).toBeUndefined();
    expect(() =>
      validateSnapshot({
        ...snapshot,
        run: {
          ...snapshot.run,
          conservatoryFormula: {
            recipe: 'lantern-ink',
            clues: ['portrait', 'portrait'],
            added: [],
            brewed: false,
            revealed: false,
            opened: false,
          },
        },
      }),
    ).toThrow();
  });
  it('varies both new specimens across fresh seeds without changing the legacy archive', () => {
    const seen = new Set<number>();
    const legacy = CONSERVATORY_SPECIMENS_VERSION - 1;
    for (let i = 0; i < 80; i++) {
      const seed = `F${String(i).padStart(7, '0')}`;
      const old = conservatoryFormula(seed, legacy);
      const next = conservatoryFormula(seed, CONSERVATORY_SPECIMENS_VERSION);
      expect(old).toEqual(conservatoryFormula(seed));
      expect(next).toEqual(conservatoryFormula(seed, CONSERVATORY_SPECIMENS_VERSION));
      expect(next).toMatchObject({ recipe: old.recipe, quietHour: old.quietHour });
      const unused = old.ingredients.findIndex((id) => !alchemyRecipe(seed).includes(id));
      expect(next.ingredients[unused]).toBe(old.ingredients[unused]);
      seen.add(next.ingredients[1 - unused]);
    }
    expect(seen).toEqual(new Set(NEW_SPECIMENS));
  });

  it('continues a legacy partial archive mix and rejects new ingredients in a legacy snapshot', () => {
    let flow = make();
    const seed = 'F0R123A1';
    flow.newRun(seed);
    const snap = flow.snapshot(1, 0)!;
    flow = make();
    expect(flow.continueRun({ ...snap, contentVersion: CONSERVATORY_SPECIMENS_VERSION - 1 })).toBe(
      true,
    );
    expect(flow.travelToFloor(2, 0)).toBe(true);
    expect(flow.learnFormulaClue('record')).toBe(true);
    expect(flow.travelToFloor(3, 0)).toBe(true);
    expect(flow.learnFormulaClue('portrait')).toBe(true);
    expect(flow.collectIngredient(3)).toBe(false);
    for (const ingredient of ingredientsFor(CONSERVATORY_SPECIMENS_VERSION - 1))
      expect(flow.collectIngredient(ingredient)).toBe(true);
    for (const ingredient of flow.alchemyRecipe)
      expect(flow.addIngredient(ingredient)).toBe('correct');
    expect(flow.takePotion()).toBe(true);
    expect(flow.applyPotion()).toBe(true);
    const recipe = conservatoryFormula(seed);
    expect(flow.addFormulaIngredient(recipe.ingredients[0], true)).toBe('correct');
    expect(validateSnapshot(flow.snapshot()).run.conservatoryFormula?.added).toEqual([
      recipe.ingredients[0],
    ]);
    expect(() =>
      validateSnapshot({
        ...flow.snapshot(),
        run: { ...flow.run, alchemy: { ...flow.alchemy, found: [3] } },
      }),
    ).toThrow(/unique ingredient ids/);
  });

  it('varies selected recipes and orders deterministically', () => {
    const plans = new Set(
      Array.from({ length: 80 }, (_, i) =>
        JSON.stringify(conservatoryFormula(`F${String(i).padStart(7, '0')}`)),
      ),
    );
    expect(plans.size).toBeGreaterThan(3);
  });
});
