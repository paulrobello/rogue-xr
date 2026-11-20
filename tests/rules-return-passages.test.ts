import { describe, expect, it } from 'vitest';
import { counterweightTarget, hangCounterweight } from '../src/rules/counterweight.ts';
import { pressureTarget } from '../src/rules/pressure.ts';
import { createRun } from '../src/rules/run.ts';

describe('return passage rules', () => {
  it('supports every non-default three-dial pressure code', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 2000; i++)
      codes.add(pressureTarget(`P${String(i).padStart(7, '0')}`).join(''));
    expect(codes).toHaveLength(26);
    expect(codes.has('111')).toBe(false);
  });

  it('recovers from a wrong counterweight and refuses changes after solving', () => {
    const run = createRun('RETRY001', []);
    const target = counterweightTarget(run.seed);
    const wrong = hangCounterweight(run, target === 0 ? 1 : 0);
    expect(wrong?.solved).toBe(false);
    const solved = hangCounterweight(wrong!.run, target);
    expect(solved?.solved).toBe(true);
    expect(hangCounterweight(solved!.run, target)).toBeNull();
  });
});

it('preserves the two lower unlocks across stair travel, book secrets and a cold Continue', async () => {
  const { RunFlow } = await import('../src/flow/flow.ts');
  const { createWorkshop } = await import('../src/rules/workshop.ts');
  const { validateSnapshot } = await import('../src/persist/saves.ts');
  const make = () =>
    new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: ['strike'] });
  const flow = make();
  flow.newRun('TW0L0CKS');
  for (const id of ['A', 'B', 'C'] as const) flow.collectPressureNote(0, id);
  const code = pressureTarget(flow.floorSeed);
  for (const i of [0, 1, 2] as const)
    for (let n = 1; n < code[i]; n++) flow.turnPressureValve(0, i);
  expect(flow.primePressure(0)?.solved).toBe(true);
  flow.findBookSecretKey(0);
  expect(flow.pressure.solved).toBe(true);
  expect(flow.travelToFloor(2, 0)).toBe(true);
  flow.weighCounterweight(counterweightTarget(flow.run!.seed));
  expect(flow.hangCounterweight()).toBe('solved');
  expect(flow.travelToFloor(1, 0)).toBe(true);
  const fresh = make();
  expect(fresh.continueRun(validateSnapshot(flow.snapshot()))).toBe(true);
  expect(fresh.canEnterPuzzleGate('pressure')).toBe(true);
  expect(fresh.canEnterPuzzleGate('counterweight')).toBe(true);
});
