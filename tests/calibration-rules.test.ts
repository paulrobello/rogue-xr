import { expect, it } from 'vitest';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import {
  type CalibrationKind,
  calibrationPlan,
  type GearId,
  meshedSpindles,
} from '../src/rules/calibration.ts';
import { pressureTarget } from '../src/rules/pressure.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const ids = [0, 1, 2] as const;
const make = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: REWARD_POOL });
const seedFor = (kind: CalibrationKind) =>
  Array.from({ length: 64 }, (_, i) => 'B' + String(i).padStart(7, '0')).find(
    (s) => calibrationPlan(s).kind === kind,
  )!;
const reload = (flow: RunFlow) => {
  const f = make();
  expect(f.continueRun(validateSnapshot(flow.snapshot()))).toBe(true);
  return f;
};
it.each(['gears', 'orrery'] as const)(
  'keys, solves, restores and awards the %s cabinet exactly once',
  (kind) => {
    let flow = make();
    const seed = seedFor(kind);
    flow.newRun(seed);
    const p = calibrationPlan(seed);
    expect(flow.takeCalibrationChart()).toBe(false);
    expect(flow.takeCalibrationSpare()).toBe(false);
    flow.travelToFloor(2, 0);
    expect(flow.windCalibration()).toBeNull();
    expect(flow.takeCalibrationChart()).toBe(false);
    flow.travelToFloor(1, 0);
    for (const id of ['A', 'B', 'C'] as const) flow.collectPressureNote(1, id);
    const marks = pressureTarget(seed);
    for (const i of ids) for (let n = 1; n < marks[i]; n++) flow.turnPressureValve(1, i);
    flow.primePressure(1);
    expect(flow.takeCalibrationChart()).toBe(true);
    expect(flow.takeCalibrationChart()).toBe(false);
    expect(flow.claimCalibrationCard()).toBeNull();
    expect(flow.takeCalibrationSpare()).toBe(kind === 'orrery');
    expect(flow.takeCalibrationSpare()).toBe(false);
    flow.travelToFloor(2, 0);
    expect(flow.windCalibration()).toBe(kind === 'gears' ? 'stalled' : null);
    if (kind === 'gears') {
      const [a, b, c] = p.gearOrder;
      for (const [slot, id] of [
        [0, b],
        [1, a],
        [2, c],
      ] as const) {
        expect(flow.selectCalibrationGear(id)).toBe(true);
        expect(flow.seatCalibrationGear(slot)).toBe(true);
      }
      expect(flow.windCalibration()).toBe('stalled');
      flow.selectCalibrationGear(a);
      flow = reload(flow);
      flow.seatCalibrationGear(0);
      expect(flow.calibration.slots).toEqual([a, b, c]);
      expect(meshedSpindles(flow.calibration.slots, p.gearOrder)).toBe(3);
    } else {
      expect(flow.turnCalibrationRing(0)).toBe(false);
      flow = reload(flow);
      expect(flow.calibration.spare).toBe(true);
      expect(flow.repairCalibrationDrive()).toBe(true);
      expect(flow.repairCalibrationDrive()).toBe(false);
      expect(flow.windCalibration()).toBe('stalled');
      for (const i of ids) for (let n = 0; n < p.detents[i]; n++) flow.turnCalibrationRing(i);
      flow = reload(flow);
    }
    expect(flow.windCalibration()).toBe('solved');
    expect(flow.windCalibration()).toBeNull();
    expect(flow.claimCalibrationCard()).toBeNull();
    flow.travelToFloor(1, 0);
    flow = reload(flow);
    if (kind === 'orrery') {
      const snapshot = flow.snapshot()!;
      const { spare, repaired, ...oldCalibration } = flow.calibration;
      expect(spare && repaired).toBe(true);
      const compatible = validateSnapshot({
        ...snapshot,
        run: { ...snapshot.run, calibration: oldCalibration },
      });
      expect(compatible.run.calibration).toMatchObject({ spare: true, repaired: true });
      expect(() =>
        validateSnapshot({
          ...snapshot,
          run: {
            ...snapshot.run,
            calibration: { ...oldCalibration, spare: true, repaired: false },
          },
        }),
      ).toThrow('inconsistent calibration progress');
    }
    const before = [...(flow.run?.deck ?? [])];
    expect(REWARD_POOL).toContain(p.rewardCard);
    expect(flow.claimCalibrationCard()).toBe(p.rewardCard);
    expect(flow.run?.deck).toEqual([...before, p.rewardCard]);
    flow = reload(flow);
    expect(flow.claimCalibrationCard()).toBeNull();
    const forged = structuredClone(flow.snapshot())!;
    const slots = [1, 1, 2] as GearId[];
    expect(() =>
      validateSnapshot({
        ...forged,
        run: { ...forged.run, calibration: { ...flow.calibration, slots } },
      }),
    ).toThrow();
  },
);
