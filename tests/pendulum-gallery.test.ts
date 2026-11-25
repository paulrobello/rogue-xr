// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { PENDULUM_GALLERY_VERSION } from '../src/combat/encounter-choice.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import {
  PENDULUM_PERIODS,
  type PendulumDetent,
  pendulumAngle,
  pendulumTarget,
  pendulumTrialSeconds,
  pendulumWeightTarget,
} from '../src/rules/pendulum-gallery.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';

function running() {
  return new RunFlow({
    workshop: createWorkshop(),
    starterDeck: ['strike'],
    rewardPool: ['strike'],
  });
}

describe('Pendulum Gallery', () => {
  it('appends an optional skylit gallery without changing earlier Conservatory routes', () => {
    let appended = 0;
    for (const seed of [
      'MAPTEST2',
      ...Array.from({ length: 96 }, (_, i) => `PN${String(i).padStart(6, '0')}`),
    ]) {
      const floor = floorSeedFor(seed, 3);
      const old = playableFloorPlan(floor, PENDULUM_GALLERY_VERSION - 1, 3);
      const plan = playableFloorPlan(floor, PENDULUM_GALLERY_VERSION, 3);
      expect(plan.rooms.slice(0, old.rooms.length)).toEqual(old.rooms);
      expect(plan.connections.slice(0, old.connections.length)).toEqual(old.connections);
      expect(plan.prismAnnex).toEqual(old.prismAnnex);
      const spec = plan.pendulumGallery;
      if (!spec) continue;
      appended++;
      const edge = plan.connections.at(-1);
      expect(edge?.[0]).toEqual(spec.source);
      expect(edge?.[1].room).toBe(spec.galleryRoom);
      expect(edge?.puzzleGate).toBe('pendulum');
      const visited = new Set([0]);
      for (const room of visited)
        for (const link of plan.connections) {
          if (link.puzzleGate) continue;
          if (link[0].room === room) visited.add(link[1].room);
          if (link[1].room === room) visited.add(link[0].room);
        }
      expect(visited).toContain(spec.source.room);
      expect(visited).not.toContain(spec.galleryRoom);
      expect(plan.rooms[spec.galleryRoom].loot).toHaveLength(1);
    }
    expect(appended).toBeGreaterThan(85);
  });

  it.each([0, 1, 2] as const)('both arms on detent %i finish at the centre crossing', (detent) => {
    const finish = pendulumTrialSeconds(detent, detent);
    expect(finish).toBeCloseTo(1.25 * PENDULUM_PERIODS[detent]);
    expect(pendulumAngle(detent, finish)).toBeCloseTo(0);
    const different = ((detent + 1) % 3) as PendulumDetent;
    expect(pendulumAngle(different, PENDULUM_PERIODS[detent] * 0.25)).not.toBeCloseTo(0);
  });

  it('saves selections and one matched trial through travel and Continue', () => {
    const run = running();
    const seed = 'MAPTEST2';
    run.newRun(seed);
    expect(run.advancePendulumDetent()).toBe(false);
    expect(run.completePendulumTrial()).toBe('ignored');
    expect(run.travelToFloor(2, 0)).toBe(true);
    expect(run.travelToFloor(3, 0)).toBe(true);
    const target = pendulumTarget(seed);
    run.setPendulumWeight(pendulumWeightTarget(seed));
    expect(run.pendulumGallery.detent).not.toBe(target);
    expect(run.completePendulumTrial()).toBe('wrong');
    expect(run.pendulumGallery.open).toBe(false);
    expect(run.advancePendulumDetent()).toBe(true);
    expect(run.pendulumGallery.detent).not.toBe(target);
    const snapshot = validateSnapshot(run.snapshot(200, 0));
    const old = running();
    expect(old.continueRun({ ...snapshot, contentVersion: PENDULUM_GALLERY_VERSION - 1 })).toBe(
      true,
    );
    expect(old.advancePendulumDetent()).toBe(false);
    expect(old.completePendulumTrial()).toBe('ignored');
    const same = running();
    expect(same.continueRun(snapshot)).toBe(true);
    expect(same.pendulumGallery).toEqual(run.pendulumGallery);
    expect(same.advancePendulumDetent()).toBe(true);
    expect(same.completePendulumTrial()).toBe('matched');
    expect(same.advancePendulumDetent()).toBe(true);
    expect(same.completePendulumTrial()).toBe('opened');
    expect(same.completePendulumTrial()).toBe('ignored');
    expect(same.travelToFloor(2, 0)).toBe(true);
    const restored = running();
    expect(restored.continueRun(validateSnapshot(same.snapshot(300, 0)))).toBe(true);
    expect(restored.travelToFloor(3, 0)).toBe(true);
    expect(restored.pendulumGallery).toMatchObject({
      detent: target,
      open: true,
      weight: pendulumWeightTarget(seed),
      phaseReady: true,
      phaseSet: true,
    });
    expect(restored.advancePendulumDetent()).toBe(false);
    expect(restored.completePendulumTrial()).toBe('ignored');
    const legacy = running();
    const legacySnapshot = validateSnapshot({
      ...snapshot,
      run: { ...snapshot.run, pendulumGallery: { detent: target, open: true } },
    });
    expect(legacy.continueRun(legacySnapshot)).toBe(true);
    expect(legacy.pendulumGallery.open).toBe(true);
    expect(legacy.completePendulumTrial()).toBe('ignored');
    expect(() =>
      validateSnapshot({
        ...snapshot,
        run: { ...snapshot.run, pendulumGallery: { detent: 12, open: false } },
      }),
    ).toThrow(/pendulumGallery/);
  });
});
