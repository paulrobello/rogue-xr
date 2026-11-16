import {
  ENCOUNTERS,
  type Encounter,
  type EncounterTier,
  type EnemyKind,
} from '../content/enemies.ts';
import { Stream } from '../core/rng.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The encounter the floor plan's room gets: one of its tier whose size matches the room's automatons. */
export function chooseEncounter(
  seed: string,
  room: number,
  tier: EncounterTier,
  count: number,
): Encounter {
  const fits = ENCOUNTERS[tier].filter((e) => e.enemies.length === count);
  return Stream.fromKey(`${seed}:room-${room}:encounter`).pick(
    fits.length > 0 ? fits : ENCOUNTERS[tier],
  );
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
