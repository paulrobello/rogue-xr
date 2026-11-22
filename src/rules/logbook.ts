import { isPressureNoteId } from './pressure.ts';
import type { LogbookClueId } from './types.ts';

export type { LogbookClueId, LogbookEntry } from './types.ts';
export const RUBBING_LOGBOOK_CLUE = 'reliquary-rubbing';

export function isLogbookClueId(value: unknown): value is LogbookClueId {
  return value === RUBBING_LOGBOOK_CLUE || isPressureNoteId(value);
}
