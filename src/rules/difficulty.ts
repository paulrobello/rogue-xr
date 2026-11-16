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
 * Per-level multipliers. Hard keeps every number as written. Planning-bot win rates over SPIRE001 to
 * SPIRE400 with rest-room hearths and guardian phase 2 (2026-11-16): Hard 9.8 %, Normal 26.5 %
 * (Orrery Warden 69 hp, Grand Escapement 120 hp), Casual 76.3 % (warden 64, guardian 112, enemy
 * damage x0.85, player max hp 72).
 */
export const DIFFICULTY_SCALE: Readonly<Record<Difficulty, DifficultyScale>> = {
  casual: {
    enemyHp: { regular: 0.85, elite: 0.7, guardian: 0.7 },
    enemyDamage: 0.85,
    playerMaxHp: 1.2,
  },
  normal: {
    enemyHp: { regular: 1, elite: 0.75, guardian: 0.75 },
    enemyDamage: 1,
    playerMaxHp: 1,
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
