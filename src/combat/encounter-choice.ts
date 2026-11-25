import {
  CONSERVATORY_OWL,
  DUNGEON_ENCOUNTERS,
  ENCOUNTERS,
  type Encounter,
  type EncounterTier,
  type EnemyKind,
  TRELLIS_KEEPER,
} from '../content/enemies.ts';
import { Stream } from '../core/rng.ts';
import { CONSERVATORY_SPECIMENS_VERSION } from '../rules/alchemy.ts';
import { floorSeedFor } from '../rules/run.ts';

export { CONSERVATORY_SPECIMENS_VERSION };

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Existing snapshots keep their encounter pool and floor layout across content releases. */
export const FOUNDRY_VERSION = 2;
export const PRESSURE_WORKS_VERSION = 3;
/** Fresh runs use the distinct Upper Works floor; older snapshots retain their v3 layouts. */
export const UPPER_WORKS_VERSION = 4;
/** Return-passages puzzle content. Older snapshots keep their original clue locations. */
export const RETURN_PASSAGES_VERSION = 5;
export const HIDDEN_PANEL_VERSION = 6;
/** Portable brass key and its deterministic first-floor cache. */
export const BRASS_CACHE_VERSION = 7;
export const PATROL_VERSION = 8;
export const PRISM_ANNEX_VERSION = 9;
export const DISPATCH_ROOM_VERSION = 10;
export const DUNGEON_CONTENT_VERSION = 11;
export const SPEAKING_PIPES_VERSION = 12;
/** Stone Reliquary coffer and trace gate. */
export const RELIQUARY_VERSION = 13;
/** Wave A repair cards. Older snapshots retain the v13 reward pool. */
export const WAVE_A_REPAIR_VERSION = 14;
export const VALVEHOUSE_VERSION = 15;
export const PENDULUM_GALLERY_VERSION = 16;
export const WAVE_A_COMPLETE_VERSION = 17;
export const ARMORY_ALCOVE_VERSION = 18;
export const CHARGE_CONTENT_VERSION = 19;
export const BORROWED_LIGHT_VERSION = 20;
export const OVERDRIVE_CONTENT_VERSION = 21;
export const FLOAT_ELEVATOR_VERSION = 22;
/** Wave B dice reward content. */
export const WAVE_B_DICE_VERSION = 23;
export const SHADOW_STENCIL_VERSION = 24;
export const SPRING_TENSION_VERSION = 26;
/** Arc Chain, Gear Grinder and Pendulum Ward reward content. */
export const WAVE_B_CHAIN_VERSION = 27;
/** Crystal Gambit and its d12 reward content. */
export const CRYSTAL_GAMBIT_VERSION = 28;
/** Wave B mechanism cards. Existing v24 snapshots retain their prior reward offers. */
export const MECHANISM_CONTENT_VERSION = 25;
/** Dark Circuit's optional Upper Works branch. */
export const DARK_CIRCUIT_VERSION = 29;
/** Echo Glyph reward content. Existing snapshots retain their prior reward offers. */
export const ECHO_GLYPH_VERSION = 30;
/** Opt-in Conservatory annex in fresh runs. */
export const DRUM_GALLERY_VERSION = 31;
/** Trellis Keeper floor-three encounter content. */
export const TRELLIS_KEEPER_VERSION = 32;
/** Lens Focus reward content. Existing snapshots retain their prior reward offers. */
export const LENS_FOCUS_VERSION = 33;
/** Themed furnishings change room clearance in newly started runs. */
export const THEMED_FURNISHINGS_VERSION = 34;
/** Field Dressing reward content. Earlier snapshots keep their reward pools. */
export const FIELD_DRESSING_VERSION = 36;
export const RISK_CARDS_VERSION = 37;
export const ENCOUNTER_CONTENT_VERSION = RISK_CARDS_VERSION;
const LEGACY_ENCOUNTER_IDS = new Set([
  'sentry',
  'hound',
  'golem',
  'hound-pack',
  'sentry-hound',
  'sentry-pair',
  'warden',
  'escapement',
]);

/** The encounter the floor plan's room gets: one of its tier whose size matches the room's automatons. */
export function chooseEncounter(
  seed: string,
  room: number,
  tier: EncounterTier,
  count: number,
  contentVersion = ENCOUNTER_CONTENT_VERSION,
  floor = 1,
  stoneDungeon = false,
): Encounter {
  if (floor === 3 && count === 1 && tier === 'regular') {
    if (
      contentVersion < TRELLIS_KEEPER_VERSION ||
      seed === 'MAPTEST2' ||
      seed === floorSeedFor('MAPTEST2', 3)
    )
      return CONSERVATORY_OWL;
    return Stream.fromKey(`${seed}:floor-3:regular-single`).pick([
      CONSERVATORY_OWL,
      TRELLIS_KEEPER,
    ]);
  }
  if (
    stoneDungeon &&
    floor === 2 &&
    tier === 'regular' &&
    count === 1 &&
    contentVersion >= DUNGEON_CONTENT_VERSION
  )
    return Stream.fromKey(`${seed}:room-${room}:dungeon-encounter`).pick(DUNGEON_ENCOUNTERS);
  const pool =
    contentVersion < FOUNDRY_VERSION
      ? ENCOUNTERS[tier].filter((e) => LEGACY_ENCOUNTER_IDS.has(e.id))
      : ENCOUNTERS[tier];
  const fits = pool.filter((e) => e.enemies.length === count);
  return Stream.fromKey(`${seed}:room-${room}:encounter`).pick(fits.length > 0 ? fits : pool);
}

/** A per-room combat seed derived from the run seed, so each fight shuffles and rolls its own way. */
export function fightSeed(seed: string, room: number, patrol = false): string {
  const s = Stream.fromKey(patrol ? `${seed}:patrol:fight` : `${seed}:room-${room}:fight`);
  return Array.from({ length: 8 }, () => CROCKFORD[s.int(0, 31)]).join('');
}

/** The enemy kind of a rules enemy id: `cog-sentry-2` is a second `cog-sentry`. */
export function enemyKindOf(id: string): EnemyKind {
  return id.replace(/-\d+$/, '') as EnemyKind;
}
