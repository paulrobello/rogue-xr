import type { Stream } from '../core/rng.ts';
import { type Difficulty, scaleEnemySetup } from '../rules/difficulty.ts';
import type { Effect, EnemyMove, EnemySetup } from '../rules/types.ts';

/**
 * The automaton roster. Each enemy's intent script is its weighted move list: the engine draws the
 * next intent from the `ai` stream (`ai.int(1, totalWeight)`) after every action, so a run's seed fixes
 * every intent. Tuned for a ~70 HP player with 3 steam and 5 cards a turn.
 *
 * Weak and Vulnerable lose one stack at the end of their owner's turn, so a move that puts either on
 * the player applies at least 2 stacks; one stack would decay before the next enemy action.
 */
export type EnemyKind =
  | 'cog-sentry'
  | 'spring-hound'
  | 'bellows-golem'
  | 'orrery-warden'
  | 'grand-escapement'
  | 'glasswing-scrivener'
  | 'furnace-mite'
  | 'null-crown-auditor'
  | 'clockwork-owl';

export type EncounterTier = 'regular' | 'elite' | 'guardian';

const hit = (amount: number, hits?: number): Effect =>
  hits === undefined
    ? { type: 'damage', amount, target: 'target' }
    : { type: 'damage', amount, hits, target: 'target' };
const block = (amount: number): Effect => ({ type: 'block', amount });
const windUp = (stacks: number): Effect => ({
  type: 'apply-status',
  status: 'wound-up',
  stacks,
  target: 'self',
});
const onPlayer = (status: 'weak' | 'vulnerable' | 'overheat', stacks: number): Effect => ({
  type: 'apply-status',
  status,
  stacks,
  target: 'target',
});

const move = (
  id: string,
  intent: EnemyMove['intent'],
  weight: number,
  effects: Effect[],
  stance?: EnemyMove['stance'],
): EnemyMove => ({ id, intent, weight, effects, ...(stance ? { stance } : {}) });

/**
 * Guardian phase 2 (default pending the owner, per assets-source/concepts/p5-automatons-design.md):
 * the case starts closed with the first four moves. When its hp first falls to this fraction of max
 * or below, its case opens and every intent picked from then on draws from all six, adding `overwind`
 * and `toll`. One constant: change the number to move the threshold, or drop `phaseTwo` from the
 * guardian entry (and give it the full list) to remove the rule.
 */
export const GUARDIAN_PHASE_TWO_HP_FRACTION = 0.5;

const GUARDIAN_PHASE_ONE: EnemyMove[] = [
  move('tick', 'attack', 3, [hit(8, 2)]),
  move('tock', 'defend', 2, [block(16), hit(7)]),
  move('pallet', 'attack-debuff', 2, [hit(13), onPlayer('weak', 2)]),
  move('mainspring', 'buff', 1, [windUp(2), block(8)]),
];

const GUARDIAN_PHASE_TWO: EnemyMove[] = [
  ...GUARDIAN_PHASE_ONE,
  move('overwind', 'debuff', 1, [onPlayer('overheat', 3), onPlayer('vulnerable', 2)]),
  move('toll', 'attack', 1, [hit(26)]),
];

export const ENEMIES: Readonly<Record<EnemyKind, EnemySetup>> = {
  'cog-sentry': {
    id: 'cog-sentry',
    name: 'Cog Sentry',
    hp: 38,
    moves: [
      move('bolt', 'attack', 3, [hit(8)]),
      move('brace', 'defend', 2, [block(7), hit(4)]),
      move('jam', 'debuff', 1, [onPlayer('weak', 2)]),
    ],
  },
  'spring-hound': {
    id: 'spring-hound',
    name: 'Spring Hound',
    hp: 30,
    moves: [
      move('snap', 'attack', 3, [hit(3, 2)]),
      move('pounce', 'attack', 2, [hit(9)]),
      move('coil', 'buff', 1, [windUp(1), block(4)]),
    ],
  },
  'bellows-golem': {
    id: 'bellows-golem',
    name: 'Bellows Golem',
    hp: 52,
    moves: [
      move('crush', 'attack', 2, [hit(12)]),
      move('vent', 'attack-debuff', 2, [hit(4), onPlayer('overheat', 3)]),
      move('bank', 'defend', 1, [block(12)]),
    ],
  },
  'orrery-warden': {
    id: 'orrery-warden',
    name: 'Orrery Warden',
    hp: 92,
    moves: [
      move('transit', 'attack', 3, [hit(5, 3)]),
      move('eclipse', 'attack-debuff', 2, [hit(10), onPlayer('vulnerable', 2)]),
      move('align', 'buff', 1, [windUp(2), block(10)]),
      move('zenith', 'attack', 1, [hit(17)]),
    ],
  },
  'grand-escapement': {
    id: 'grand-escapement',
    name: 'Grand Escapement',
    hp: 160,
    moves: GUARDIAN_PHASE_ONE,
    phaseTwo: { hpFraction: GUARDIAN_PHASE_TWO_HP_FRACTION, moves: GUARDIAN_PHASE_TWO },
  },
  'glasswing-scrivener': {
    id: 'glasswing-scrivener',
    name: 'Glasswing Scrivener',
    hp: 34,
    moves: [
      move('inscribe', 'attack-debuff', 3, [hit(5), onPlayer('vulnerable', 2)]),
      move('cross-out', 'attack', 2, [hit(3, 2)]),
      move('proof', 'defend', 2, [block(10)], 'guarded'),
    ],
  },
  'furnace-mite': {
    id: 'furnace-mite',
    name: 'Twin Furnace Mite',
    hp: 20,
    moves: [
      move('double-spark', 'attack', 3, [hit(3, 2)], 'exposed'),
      move(
        'stoke',
        'attack-debuff',
        2,
        [hit(4), { type: 'apply-status', status: 'overheat', stacks: 1, target: 'target' }],
        'exposed',
      ),
      move('clink', 'defend', 1, [block(6)], 'guarded'),
    ],
  },
  'null-crown-auditor': {
    id: 'null-crown-auditor',
    name: 'Null-Crown Auditor',
    hp: 78,
    moves: [
      move('tally', 'attack', 3, [hit(4, 2)]),
      { ...move('reconcile', 'defend', 2, [block(14)], 'guarded'), followUp: 'levy' },
      move('levy', 'attack', 0, [hit(18)], 'exposed'),
    ],
  },
  'clockwork-owl': {
    id: 'clockwork-owl',
    name: 'Clockwork Owl',
    hp: 44,
    moves: [
      move('talon-sweep', 'attack', 3, [hit(7, 2)]),
      move('watchful-tilt', 'defend', 2, [block(10)]),
      move('feather-dart', 'attack-debuff', 2, [hit(6), onPlayer('vulnerable', 2)]),
    ],
  },
};

/** Threat cost of one enemy against a floor budget. */
export const ENEMY_THREAT: Readonly<Record<EnemyKind, number>> = {
  'cog-sentry': 2,
  'spring-hound': 2,
  'bellows-golem': 3,
  'orrery-warden': 6,
  'grand-escapement': 10,
  'glasswing-scrivener': 3,
  'furnace-mite': 2,
  'null-crown-auditor': 8,
  'clockwork-owl': 3,
};

export interface Encounter {
  readonly id: string;
  readonly tier: EncounterTier;
  readonly enemies: readonly EnemyKind[];
  /** Sum of the enemies' threat; the floor generator spends its budget on this. */
  readonly threat: number;
}

const encounter = (id: string, tier: EncounterTier, enemies: EnemyKind[]): Encounter => ({
  id,
  tier,
  enemies,
  threat: enemies.reduce((sum, kind) => sum + ENEMY_THREAT[kind], 0),
});

export const ROAMING_SENTRY = encounter('roaming-sentry', 'regular', ['cog-sentry']);

export const CONSERVATORY_OWL = encounter('conservatory-owl', 'regular', ['clockwork-owl']);

export const ENCOUNTERS: Readonly<Record<EncounterTier, readonly Encounter[]>> = {
  regular: [
    encounter('sentry', 'regular', ['cog-sentry']),
    encounter('hound', 'regular', ['spring-hound']),
    encounter('golem', 'regular', ['bellows-golem']),
    encounter('hound-pack', 'regular', ['spring-hound', 'spring-hound']),
    encounter('sentry-hound', 'regular', ['cog-sentry', 'spring-hound']),
    encounter('sentry-pair', 'regular', ['cog-sentry', 'cog-sentry']),
    encounter('foundry-scrivener', 'regular', ['glasswing-scrivener']),
    encounter('twin-furnace-mites', 'regular', ['furnace-mite', 'furnace-mite']),
  ],
  elite: [
    encounter('warden', 'elite', ['orrery-warden']),
    encounter('null-crown-auditor', 'elite', ['null-crown-auditor']),
  ],
  guardian: [encounter('escapement', 'guardian', ['grand-escapement'])],
};

/**
 * Picks an encounter of `tier` uniformly from `stream` (the `floor` or `ai` stream), considering only
 * encounters whose threat fits `budget`. Draws exactly once. Throws when nothing fits.
 */
export function pickEncounter(
  tier: EncounterTier,
  stream: Stream,
  budget = Number.POSITIVE_INFINITY,
): Encounter {
  const fits = ENCOUNTERS[tier].filter((e) => e.threat <= budget);
  if (fits.length === 0) throw new RangeError(`No ${tier} encounter fits threat budget ${budget}`);
  return stream.pick(fits);
}

/**
 * The start-combat enemy setups for an encounter. A kind that appears more than once gets numbered
 * ids (`spring-hound`, `spring-hound-2`), because enemy ids must be unique within a combat. With a
 * `difficulty`, each setup is scaled for that level and the encounter's tier (`scaleEnemySetup`);
 * without one, the content fights as written (Hard).
 */
export function encounterSetups(enc: Encounter, difficulty?: Difficulty): EnemySetup[] {
  const seen = new Map<EnemyKind, number>();
  return enc.enemies.map((kind) => {
    const count = (seen.get(kind) ?? 0) + 1;
    seen.set(kind, count);
    const base = difficulty ? scaleEnemySetup(ENEMIES[kind], enc.tier, difficulty) : ENEMIES[kind];
    return count === 1 ? base : { ...base, id: `${base.id}-${count}` };
  });
}
