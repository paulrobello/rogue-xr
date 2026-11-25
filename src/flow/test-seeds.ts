import { DUNGEON_SHOWCASE_SEED } from '../floor/dungeon-showcase.ts';
import { SHOWCASE_SEED } from '../floor/generate.ts';

/** Named playtest routes and gameplay regression seeds. */
export const TEST_SEEDS = [
  { seed: SHOWCASE_SEED, label: 'Room showcase & furnishings' },
  { seed: DUNGEON_SHOWCASE_SEED, label: 'Dungeon & late fixtures' },
  { seed: '1ENS0006', label: 'Lens Focus reward' },
  { seed: 'DR0M0000', label: 'Drum Gallery' },
  { seed: 'C1RC0000', label: 'Dark Circuit' },
  { seed: 'TRE10002', label: 'Trellis Keeper' },
  { seed: 'ARM0R005', label: 'Armory challenge' },
  { seed: 'ARM0R003', label: 'Armory parade display' },
  { seed: 'N0TE0032', label: 'Pressure Works field notes' },
  { seed: 'PAT00000', label: 'Roaming patrol' },
  { seed: 'W1ND0001', label: 'Patrol & Conservatory brew' },
  { seed: 'BRASS042', label: 'Quest walkthrough' },
  { seed: 'SP1RE001', label: 'Brass cache & treasure' },
  { seed: 'SP1RE002', label: 'Combat & Spring Tension' },
  { seed: 'SP1RE004', label: 'Grand Escapement' },
  { seed: 'SP1RE006', label: 'Three-wing combat run' },
  { seed: 'SP1RE007', label: 'Rest hearth' },
  { seed: 'BASH0000', label: 'Two-wing elite run' },
  { seed: 'BASH4000', label: 'Two-wing elite alternate' },
  { seed: 'BASH7000', label: 'Guardian sigil tests' },
  { seed: 'BASHA000', label: 'Two-wing combat run' },
  { seed: 'BASHB200', label: 'Two-wing combat alternate' },
] as const;
