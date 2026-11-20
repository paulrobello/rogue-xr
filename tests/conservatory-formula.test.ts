import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import { conservatoryFormula } from '../src/rules/alchemy.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const make = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });

describe('conservatory follow-up formula', () => {
  it('enforces cross-floor clues, third ingredient, still waiting, and recipe opening', () => {
    const flow = make();
    flow.newRun('F0R123A1');
    expect(flow.travelToFloor(2, 0)).toBe(true);
    expect(flow.learnFormulaClue('portrait')).toBe(false);
    expect(flow.learnFormulaClue('record')).toBe(true);
    expect(flow.travelToFloor(3, 0)).toBe(true);
    expect(flow.learnFormulaClue('record')).toBe(false);
    expect(flow.learnFormulaClue('portrait')).toBe(true);
    for (const ingredient of [0, 1, 2] as const)
      expect(flow.collectIngredient(ingredient)).toBe(true);
    for (const ingredient of flow.alchemyRecipe)
      expect(flow.addIngredient(ingredient)).toBe('correct');
    expect(flow.applyPotion()).toBe(true);
    const plan = conservatoryFormula(flow.run!.seed);
    expect(flow.addFormulaIngredient(plan.ingredients[0], false)).toBe(
      plan.recipe === 'stillwind' ? 'waiting' : 'correct',
    );
    if (plan.recipe === 'stillwind')
      expect(flow.addFormulaIngredient(plan.ingredients[0], true)).toBe('correct');
    expect(flow.addFormulaIngredient(plan.ingredients[1], true)).toBe('correct');
    expect(flow.useFormula('pour')).toBe(true);
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
  it('varies selected recipes and orders deterministically', () => {
    const plans = new Set(
      Array.from({ length: 80 }, (_, i) =>
        JSON.stringify(conservatoryFormula(`F${String(i).padStart(7, '0')}`)),
      ),
    );
    expect(plans.size).toBeGreaterThan(3);
  });
});
