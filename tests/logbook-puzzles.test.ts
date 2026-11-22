import { describe, expect, it } from 'vitest';
import { CONSERVATORY_SPECIMENS_VERSION } from '../src/combat/encounter-choice.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { activePuzzlePages } from '../src/flow/logbook-puzzles.ts';
import { formulaObservation } from '../src/rules/alchemy.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

function fakeFlow(run: Record<string, unknown>, views: Record<string, unknown>): RunFlow {
  return {
    run,
    get reliquarySeal() {
      return views.reliquarySeal;
    },
    get pressure() {
      return views.pressure;
    },
    describeFormulaClue: () => views.formulaClue,
    explorationOnFloor(floor: number) {
      return floor === 1 ? views.lowerFloor : undefined;
    },
  } as unknown as RunFlow;
}

describe('active puzzle logbook pages', () => {
  it('does not reveal seed-derived clues before discovery', () => {
    const flow = fakeFlow(
      { seed: 'PZZLE001' },
      { reliquarySeal: 'hidden', pressure: { notes: [] } },
    );
    expect(activePuzzlePages(flow)).toEqual([]);
  });

  it('includes discovered clues in stable order and preserves archived text', () => {
    const flow = fakeFlow(
      {
        seed: 'PZZLE001',
        logbook: [{ id: 'B', title: 'Return line', body: 'Set B to two.', origin: 'Floor 1' }],
        bellChimes: { clueHeard: true, progress: [], solved: false, rewardClaimed: false },
        calibration: { chart: true, key: 'held', spare: false, repaired: false },
        conservatoryFormula: { clues: ['record'] },
      },
      {
        reliquarySeal: 'known',
        pressure: { notes: [] },
        lowerFloor: { pressure: { notes: ['B', 'A'] } },
        formulaClue: 'II · Bellcap',
      },
    );
    const pages = activePuzzlePages(flow, {
      pressureNotes: { A: { title: 'Intake', body: 'Set A to one.' } },
    });
    expect(pages.map((page) => [page.puzzle, page.title])).toEqual([
      ['Stone Reliquary', "Keeper's rubbing"],
      ['Pressure Regulator', 'Return line'],
      ['Pressure Regulator', 'Intake'],
      ['Music Box', 'Remembered chime sequence'],
      ['Calibration Instrument', 'Calibration chart'],
      ['Calibration Instrument', 'Winding key'],
      ['Conservatory Formula', 'Upper Works record'],
    ]);
    expect(pages[0].glyphPoints).toBeDefined();
    expect(pages[0].sigilId).toBe('reliquary-rubbing');
    expect(pages[1].text).toBe('Set B to two.');
    expect(pages.at(-1)?.text).toBe('II · Bellcap');
  });

  it('shows the specimen for the run content version', () => {
    const createFlow = () =>
      new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: ['strike'] });
    const seed = 'BREW0001';
    const current = createFlow();
    current.newRun(seed);
    const snapshot = current.snapshot();
    if (!snapshot) throw Error('Missing test run snapshot');
    const legacy = createFlow();
    const legacyVersion = CONSERVATORY_SPECIMENS_VERSION - 1;
    expect(legacy.continueRun({ ...snapshot, contentVersion: legacyVersion })).toBe(true);
    for (const flow of [current, legacy]) {
      expect(flow.travelToFloor(2, 0)).toBe(true);
      expect(flow.travelToFloor(3, 0)).toBe(true);
      expect(flow.learnFormulaClue('portrait')).toBe(true);
    }
    const portrait = (flow: RunFlow) =>
      activePuzzlePages(flow).find((page) => page.title === 'Portrait observation')?.text;
    expect(portrait(current)).toBe('II · Silverleaf');
    expect(portrait(legacy)).toBe(formulaObservation(seed, 'portrait', legacyVersion));
    expect(portrait(legacy)).not.toBe(portrait(current));
  });
  it('keeps the rubbing readable after the reliquary is opened', () => {
    const flow = fakeFlow(
      {
        seed: 'PZZLE001',
        logbook: [
          { id: 'reliquary-rubbing', title: 'Rubbing', body: 'Saved mark', origin: 'Vault' },
        ],
      },
      { reliquarySeal: 'open', pressure: { notes: [] } },
    );
    expect(activePuzzlePages(flow)[0]).toMatchObject({
      text: 'Copy this mark in one continuous stroke.',
      resolved: true,
    });
  });
});
