export type Verdict = 'approve' | 'reject';

export interface Review {
  verdict: Verdict | null;
  note: string;
}

export interface ReviewState {
  items: Record<string, Review>;
  match: boolean;
}

export const STORAGE_KEY = 'rogue-xr:audition:v1';
/** Owner-review row that holds the sound effects. */
export const SFX_ROW = 'A17';
/** Music has no owner-review row yet. Set this one value when one is added. */
export const MUSIC_ROW = '';

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const flatten = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function emptyState(): ReviewState {
  return { items: {}, match: false };
}

export function loadState(storage: StorageLike | null): ReviewState {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return emptyState();
  }
  if (!raw) return emptyState();
  try {
    const parsed = JSON.parse(raw) as { items?: unknown; match?: unknown };
    const state = emptyState();
    state.match = parsed.match === true;
    if (typeof parsed.items === 'object' && parsed.items !== null) {
      for (const [key, value] of Object.entries(parsed.items)) {
        const v = (value ?? {}) as { verdict?: unknown; note?: unknown };
        const verdict = v.verdict === 'approve' || v.verdict === 'reject' ? v.verdict : null;
        const note = typeof v.note === 'string' ? v.note : '';
        if (verdict || note) state.items[key] = { verdict, note };
      }
    }
    return state;
  } catch {
    return emptyState();
  }
}

export function saveState(storage: StorageLike | null, state: ReviewState): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full quota: the review still works for this page load.
  }
}

export interface ExportRow {
  key: string;
  kind: 'sfx' | 'music';
  id: string;
}

/** One owner-review line per reviewed item, in the order given. Unreviewed items are skipped. */
export function exportReview(rows: readonly ExportRow[], state: ReviewState): string {
  const lines: string[] = [];
  for (const row of rows) {
    const review = state.items[row.key];
    if (!review) continue;
    const note = flatten(review.note);
    const prefix = [row.kind === 'sfx' ? SFX_ROW : MUSIC_ROW, row.kind, row.id]
      .filter(Boolean)
      .join(' ');
    if (review.verdict) {
      lines.push(note ? `${prefix} ${review.verdict}: ${note}` : `${prefix} ${review.verdict}`);
    } else if (note) {
      lines.push(`${prefix} note: ${note}`);
    }
  }
  return lines.join('\n');
}
