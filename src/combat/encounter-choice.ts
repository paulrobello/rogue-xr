import {
  ENCOUNTERS,
  type Encounter,
  type EncounterTier,
  type EnemyKind,
} from '../content/enemies.ts';
import { Stream } from '../core/rng.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Existing snapshots keep their encounter pool and floor layout across content releases. */
export const FOUNDRY_VERSION = 2;
export const PRESSURE_WORKS_VERSION = 3;
/** Fresh runs use the distinct Upper Works floor; older snapshots retain their v3 layouts. */
export const UPPER_WORKS_VERSION = 4;
export const ENCOUNTER_CONTENT_VERSION = UPPER_WORKS_VERSION;
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
): Encounter {
  const pool =
    contentVersion < FOUNDRY_VERSION
      ? ENCOUNTERS[tier].filter((e) => LEGACY_ENCOUNTER_IDS.has(e.id))
      : ENCOUNTERS[tier];
  const fits = pool.filter((e) => e.enemies.length === count);
  return Stream.fromKey(`${seed}:room-${room}:encounter`).pick(fits.length > 0 ? fits : pool);
}

/** A per-room combat seed derived from the run seed, so each fight shuffles and rolls its own way. */
export function fightSeed(seed: string, room: number): string {
  const s = Stream.fromKey(`${seed}:room-${room}:fight`);
  return Array.from({ length: 8 }, () => CROCKFORD[s.int(0, 31)]).join('');
}

/** The enemy kind of a rules enemy id: `cog-sentry-2` is a second `cog-sentry`. */
export function enemyKindOf(id: string): EnemyKind {
  return id.replace(/-\d+$/, '') as EnemyKind;
}
