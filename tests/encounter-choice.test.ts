import { describe, expect, it } from 'vitest';
import { chooseEncounter, ENCOUNTER_CONTENT_VERSION } from '../src/combat/encounter-choice.ts';

describe('seeded encounter content compatibility', () => {
  it('keeps a pre-expansion save on the original pool while fresh seeds see new content', () => {
    const seed = 'SEED0001';
    const legacy = chooseEncounter(seed, 1, 'regular', 1, 1);
    const current = chooseEncounter(seed, 1, 'regular', 1, ENCOUNTER_CONTENT_VERSION);

    expect(legacy.id).toBe('golem');
    expect(current.id).toBe('foundry-scrivener');
  });

  it('does not allow the expanded elite pool to replace a legacy encounter', () => {
    const seed = 'SEED0001';
    expect(chooseEncounter(seed, 1, 'elite', 1, 1).id).toBe('warden');
  });
});
