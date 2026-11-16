import { SEED_LENGTH } from '../core/rng.ts';

/**
 * Seed entry for the in-scene title (the DOM seed strip it replaced lived here). The keypad shows
 * `SEED_ALPHABET`; desktop typing goes through `appendSeedChar`, which applies the same Crockford
 * folding as `normalizeSeed` (I and L read as 1, O as 0).
 */
export const SEED_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export { SEED_LENGTH };

/** `draft` with `key` appended, or null when the key is not a seed character or the draft is full. */
export function appendSeedChar(draft: string, key: string): string | null {
  if (key.length !== 1 || draft.length >= SEED_LENGTH) return null;
  const upper = key.toUpperCase();
  const ch = upper === 'I' || upper === 'L' ? '1' : upper === 'O' ? '0' : upper;
  return SEED_ALPHABET.includes(ch) ? draft + ch : null;
}
