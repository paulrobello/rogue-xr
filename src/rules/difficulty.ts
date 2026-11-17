import type { RewardTier, RunState } from './run.ts';
import type { Effect, EnemyMove, EnemySetup } from './types.ts';

/**
 * How hard a run is, chosen on the title before a new run and stored on the run, so a resumed run
 * keeps it. Hard is the tuned content as written. Normal and Casual scale enemy hp and damage, and
 * Casual also raises the player's max hp. Scaling draws no random number, so a seed and level replay
 * exactly.
 */
export type Difficulty = 'casual' | 'normal' | 'hard';

export const DIFFICULTIES: readonly Difficulty[] = ['casual', 'normal', 'hard'];
/** The level of a run that does not name one, including every save made before levels existed. */
export const DEFAULT_DIFFICULTY: Difficulty = 'normal';

export interface DifficultyScale {
  /** Enemy hp multiplier by encounter tier. */
  readonly enemyHp: Readonly<Record<RewardTier, number>>;
  /** Multiplier on every damage amount in an enemy's moves. Block and statuses stay as written. */
  readonly enemyDamage: number;
  /** Multiplier on the player's max hp at run start, after workshop upgrades. */
  readonly playerMaxHp: number;
}

/**
 * Per-level multipliers. Hard keeps every number as written. Casual is tuned for a mediocre player:
 * win rates of the greedy, imperfect player in scripts/balance/sim.ts over SPIRE001 to SPIRE400 (full
 * runs, fresh workshop, hearths, guardian phase 2; 2026-11-17, `bun scripts/balance/winrate.ts
 * --miss 0,0.15`), by the multiplier the player's sigils earn on Casual (0.5 / 0.75 / 1.0):
 * Casual 70.8 / 80.5 / 89.5 % (60.0 / 70.8 / 79.0 % when 15 % of picked cards are missed; Orrery
 * Warden 51 hp, Grand Escapement 72 hp, enemy damage x0.7, player max hp 90). Normal, retuned at
 * Paul's request the same day, gives it 27.5 / 29.5 / 43.8 % (20.8 / 23.5 / 33.0 % with misses;
 * warden 55 hp, guardian 88 hp, damage x0.75, max hp 78); the old Normal (x1 / 0.75 / 0.75 hp,
 * damage x1, max hp 60) gave it 0 %, as Hard still does. The old Casual (x0.85 / 0.7 / 0.7 hp,
 * damage x0.85, max hp 72) gave it 2 / 4 / 8 %. An earlier planning bot (not in the tree) won Hard
 * 9.8 %, old Normal 26.5 %, old Casual 76.3 %.
 */
export const DIFFICULTY_SCALE: Readonly<Record<Difficulty, DifficultyScale>> = {
  casual: {
    enemyHp: { regular: 0.75, elite: 0.55, guardian: 0.45 },
    enemyDamage: 0.7,
    playerMaxHp: 1.5,
  },
  normal: {
    enemyHp: { regular: 0.8, elite: 0.6, guardian: 0.55 },
    enemyDamage: 0.75,
    playerMaxHp: 1.3,
  },
  hard: {
    enemyHp: { regular: 1, elite: 1, guardian: 1 },
    enemyDamage: 1,
    playerMaxHp: 1,
  },
};

export const DIFFICULTY_LABEL: Readonly<Record<Difficulty, string>> = {
  casual: 'Casual',
  normal: 'Normal',
  hard: 'Hard',
};

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value);
}

/** The run's level: `DEFAULT_DIFFICULTY` when the run does not name one. */
export function runDifficulty(run: Pick<RunState, 'difficulty'>): Difficulty {
  return run.difficulty ?? DEFAULT_DIFFICULTY;
}

const scaleBy = (value: number, factor: number): number =>
  factor === 1 ? value : Math.max(1, Math.round(value * factor));

function scaleEffect(effect: Effect, factor: number): Effect {
  if (effect.type !== 'damage' || typeof effect.amount !== 'number') return effect;
  return { ...effect, amount: scaleBy(effect.amount, factor) };
}

function scaleMoves(moves: readonly EnemyMove[], factor: number): EnemyMove[] {
  return moves.map((m) => ({ ...m, effects: m.effects.map((e) => scaleEffect(e, factor)) }));
}

/** The player's max hp at run start on `level`, from the workshop's max hp. */
export function difficultyMaxHp(baseMaxHp: number, level: Difficulty): number {
  return scaleBy(baseMaxHp, DIFFICULTY_SCALE[level].playerMaxHp);
}

/**
 * `setup` as it fights on `level` in an encounter of `tier`: hp (and max hp) and every damage amount
 * scaled, each rounded and at least 1. A phase-2 threshold is a fraction of max hp, so it follows the
 * scaled hp. Returns `setup` itself when nothing changes, so Hard fights the content as written.
 */
export function scaleEnemySetup(
  setup: EnemySetup,
  tier: RewardTier,
  level: Difficulty,
): EnemySetup {
  const scale = DIFFICULTY_SCALE[level];
  const hp = scale.enemyHp[tier];
  const damage = scale.enemyDamage;
  if (hp === 1 && damage === 1) return setup;
  const { phaseTwo } = setup;
  return {
    ...setup,
    hp: scaleBy(setup.hp, hp),
    ...(setup.maxHp === undefined ? {} : { maxHp: scaleBy(setup.maxHp, hp) }),
    moves: scaleMoves(setup.moves, damage),
    ...(phaseTwo ? { phaseTwo: { ...phaseTwo, moves: scaleMoves(phaseTwo.moves, damage) } } : {}),
  };
}
