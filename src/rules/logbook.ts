import { isPressureNoteId } from './pressure.ts';
import { type LogbookClueId, WORLD_LOGBOOK_CLUES, type WorldLogbookClueId } from './types.ts';

export type { LogbookClueId, LogbookEntry } from './types.ts';
export const RUBBING_LOGBOOK_CLUE = 'reliquary-rubbing';

export function isWorldLogbookClueId(value: unknown): value is WorldLogbookClueId {
  return WORLD_LOGBOOK_CLUES.some((id) => value === id);
}

export function isLogbookClueId(value: unknown): value is LogbookClueId {
  return value === RUBBING_LOGBOOK_CLUE || isWorldLogbookClueId(value) || isPressureNoteId(value);
}
