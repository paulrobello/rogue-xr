import { describe, expect, it } from 'vitest';
import { ENCOUNTER_CONTENT_VERSION } from '../src/combat/encounter-choice.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import { conservatoryFormula, ingredientsFor } from '../src/rules/alchemy.ts';
import { type CommissionKind, commissionPlan } from '../src/rules/commissions.ts';
import { pressureTarget } from '../src/rules/pressure.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const make = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: ['strike'] });
function start(kind: CommissionKind) {
  const seed = Array.from({ length: 64 }, (_, i) => 'C' + String(i).padStart(7, '0')).find(
    (s) => commissionPlan(s) === kind,
  );
  if (!seed) throw Error('No test seed for ' + kind);
  const flow = make();
  flow.newRun(seed);
  return flow;
}
const reload = (flow: RunFlow) => {
  const next = make();
  expect(next.continueRun(validateSnapshot(flow.snapshot()))).toBe(true);
  return next;
};
function power(flow: RunFlow) {
  for (const k of ['A', 'B', 'C'] as const) flow.collectPressureNote(0, k);
  const dials = pressureTarget(flow.floorSeed);
  for (const i of [0, 1, 2] as const)
    for (let d = 1; d < dials[i]; d++) flow.turnPressureValve(0, i);
  expect(flow.primePressure(0)?.solved).toBe(true);
}
describe('keeper commissions', () => {
  it('credits found springs before acceptance and pays once on return', () => {
    let flow = start('recovery');
    expect(flow.collectSpring(2)).toBe(false);
    expect(flow.collectSpring(1)).toBe(true);
    expect(flow.collectSpring(1)).toBe(false);
    expect(flow.claimCommission()).toBe(false);
    expect(flow.acceptCommission()).toBe(true);
    expect(flow.acceptCommission()).toBe(false);
    flow.collectSpring(0);
    flow.travelToFloor(2, 0);
    expect(flow.collectSpring(1)).toBe(false);
    flow = reload(flow);
    expect(flow.commission.progress).toBe(2);
    expect(flow.collectSpring(2)).toBe(true);
    expect(flow.claimCommission()).toBe(false);
    flow.travelToFloor(1, 0);
    const coins = flow.run?.cogs ?? 0;
    expect(flow.claimCommission()).toBe(true);
    flow = reload(flow);
    expect(flow.claimCommission()).toBe(false);
    expect(flow.run?.cogs).toBe(coins + 15);
  });
  it('recognizes a pressure repair done before the order was signed, including upstairs', () => {
    let flow = start('restoration');
    expect(flow.collectSpring(0)).toBe(false);
    power(flow);
    expect(flow.commission.progress).toBe(1);
    flow.travelToFloor(2, 0);
    flow = reload(flow);
    expect(flow.commission.progress).toBe(1);
    expect(flow.acceptCommission()).toBe(false);
    flow.travelToFloor(1, 0);
    flow.acceptCommission();
    expect(flow.claimCommission()).toBe(true);
    expect(flow.run?.cogs).toBe(10);
  });
  it('does not complete an archive delve merely by signing or opening the thorn gate', () => {
    let flow = start('delve');
    flow.acceptCommission();
    expect(flow.commission.progress).toBe(0);
    flow.travelToFloor(2, 0);
    flow.learnFormulaClue('record');
    flow.travelToFloor(3, 0);
    flow.learnFormulaClue('portrait');
    for (const i of ingredientsFor(ENCOUNTER_CONTENT_VERSION)) flow.collectIngredient(i);
    for (const i of flow.alchemyRecipe) flow.addIngredient(i);
    flow.takePotion();
    flow.applyPotion();
    expect(flow.commission.progress).toBe(0);
    for (const i of conservatoryFormula(flow.run!.seed, ENCOUNTER_CONTENT_VERSION).ingredients)
      flow.addFormulaIngredient(i, true);
    flow.takePotion();
    flow.useFormula('pour');
    if (!flow.conservatoryFormula.opened) flow.useFormula('unlatch');
    flow = reload(flow);
    expect(flow.commission.progress).toBe(1);
    expect(flow.claimCommission()).toBe(false);
    flow.travelToFloor(2, 0);
    flow.travelToFloor(1, 0);
    expect(flow.claimCommission()).toBe(true);
    expect(flow.run?.cogs).toBe(18);
  });
});
