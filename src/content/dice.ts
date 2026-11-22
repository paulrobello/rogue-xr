import type { DieDef } from '../rules/dice.ts';

/**
 * The slice's two dice. A card that rolls names one by `DieId`; the caller looks it up with `dieById`,
 * rolls it with `rollDice` from `src/rules/dice.ts`, and passes `roll.value` as the play-card `dice`.
 * `faces[i]` is the value on model face `i`, the order the dice models (P5) must follow.
 */
export const DIE_IDS = ['brass-d6', 'glass-d8', 'iron-d4', 'crystal-d12'] as const;
export type DieId = (typeof DIE_IDS)[number];

/** Steady six-sided brass die: 1 to 6, mean 3.5. */
export const BRASS_D6: DieDef = { id: 'brass-d6', name: 'Brass d6', faces: [1, 2, 3, 4, 5, 6] };

/** Swingy eight-sided glass die: 1 to 8, mean 4.5. */
export const GLASS_D8: DieDef = {
  id: 'glass-d8',
  name: 'Glass d8',
  faces: [1, 2, 3, 4, 5, 6, 7, 8],
};

/** True tetrahedral iron die: 1 to 4, mean 2.5. */
export const IRON_D4: DieDef = { id: 'iron-d4', name: 'Iron d4', faces: [1, 2, 3, 4] };

/** Faceted crystal twelve-sided die: 1 to 12, mean 6.5. */
export const CRYSTAL_D12: DieDef = {
  id: 'crystal-d12',
  name: 'Crystal d12',
  faces: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};

export const DICE: Readonly<Record<DieId, DieDef>> = {
  'brass-d6': BRASS_D6,
  'glass-d8': GLASS_D8,
  'iron-d4': IRON_D4,
  'crystal-d12': CRYSTAL_D12,
};

export function dieById(id: DieId): DieDef {
  return DICE[id];
}
