import { bellMelody } from '../rules/bell-chimes.ts';
import { BEARINGS, calibrationPlan, GEAR_TEETH, PLANET_NAMES } from '../rules/calibration.ts';
import { isPressureNoteId, type PressureNoteId } from '../rules/pressure.ts';
import { reliquaryGlyph } from '../rules/reliquary.ts';
import type { RunFlow } from './flow.ts';

export interface PuzzleClueText {
  readonly title: string;
  readonly body: string;
  readonly origin?: string;
}

export interface ActivePuzzlePage {
  readonly puzzle: string;
  readonly title: string;
  readonly text: string;
  readonly origin?: string;
  readonly glyphPoints?: readonly { readonly x: number; readonly y: number }[];
  readonly sigilId?: string;
  readonly resolved?: boolean;
}

export interface ActivePuzzlePageDeps {
  /** Records supplied by the floor that placed each discovered pressure note. */
  readonly pressureNotes?: Partial<Readonly<Record<PressureNoteId, PuzzleClueText>>>;
}

const PRESSURE_ORDER: readonly PressureNoteId[] = ['dispatch', 'A', 'B', 'C'];

/**
 * Returns only puzzle clues the run has discovered. Generated pages are deliberately based on
 * persisted discovery flags, not on the seed alone, so opening the logbook cannot reveal answers.
 */
export function activePuzzlePages(
  flow: RunFlow,
  deps: ActivePuzzlePageDeps = {},
): readonly ActivePuzzlePage[] {
  const run = flow.run;
  if (!run) return [];
  const pages: ActivePuzzlePage[] = [];
  if (flow.reliquarySeal === 'known' || flow.reliquarySeal === 'open') {
    const glyph = reliquaryGlyph(run.seed);
    pages.push({
      puzzle: 'Stone Reliquary',
      title: "Keeper's rubbing",
      text: 'Copy this mark in one continuous stroke.',
      origin: 'Upper Works · Stone Reliquary · seal plate',
      glyphPoints: glyph.points,
      sigilId: 'reliquary-rubbing',
      ...(flow.reliquarySeal === 'open' ? { resolved: true } : {}),
    });
  }

  const pressureIds = new Set(flow.explorationOnFloor(1)?.pressure?.notes ?? flow.pressure.notes);
  for (const entry of run.logbook ?? []) {
    if (isPressureNoteId(entry.id) && pressureIds.has(entry.id)) {
      pages.push({
        puzzle: 'Pressure Regulator',
        title: entry.title,
        text: entry.body,
        origin: entry.origin,
      });
      pressureIds.delete(entry.id);
    }
  }
  for (const id of PRESSURE_ORDER) {
    if (!pressureIds.has(id)) continue;
    const record = deps.pressureNotes?.[id];
    if (record) {
      pages.push({
        puzzle: 'Pressure Regulator',
        title: record.title,
        text: record.body,
        ...(record.origin === undefined ? {} : { origin: record.origin }),
      });
    }
  }

  if (run.bellChimes?.clueHeard) {
    pages.push({
      puzzle: 'Music Box',
      title: 'Remembered chime sequence',
      text: bellMelody(run.seed)
        .map((note) => String(note + 1))
        .join(' · '),
      origin: 'Lower Works · music box',
    });
  }

  if (run.calibration?.chart) {
    const plan = calibrationPlan(run.seed);
    const text =
      plan.kind === 'gears'
        ? `Gear train · ${plan.gearOrder.map((id) => GEAR_TEETH[id]).join(' / ')}`
        : `Star chart · ${plan.detents.map((d, i) => `${PLANET_NAMES[i]} ${BEARINGS[d][0]}`).join(' / ')}`;
    pages.push({
      puzzle: 'Calibration Instrument',
      title: 'Calibration chart',
      text,
      origin: 'Lower Works · supply cabinet',
    });
  }
  if (run.calibration?.key === 'held') {
    pages.push({
      puzzle: 'Calibration Instrument',
      title: 'Winding key',
      text: 'Insert the key in the orrery arbor.',
      origin: 'Lower Works · calibration cabinet',
    });
  }
  if (run.calibration?.spare && !run.calibration.repaired) {
    pages.push({
      puzzle: 'Calibration Instrument',
      title: 'Orrery shaft coupling',
      text: 'A spare coupling is carried for the damaged orrery shaft.',
      origin: 'Lower Works · calibration cabinet',
    });
  }

  for (const clue of run.conservatoryFormula?.clues ?? []) {
    pages.push({
      puzzle: 'Conservatory Formula',
      title: clue === 'portrait' ? 'Portrait observation' : 'Upper Works record',
      text: flow.describeFormulaClue(clue),
      origin: clue === 'portrait' ? 'Alchemical Conservatory · portrait' : 'Upper Works · record',
    });
  }

  return pages;
}
