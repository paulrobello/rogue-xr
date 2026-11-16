export {
  type DiceRoll,
  type DiceRollResult,
  type DieDef,
  type RngRollResult,
  rollDice,
  rollDie,
  validateDie,
} from './dice.ts';
export {
  apply,
  createIdleState,
  intentDamage,
  isAlive,
  livingEnemies,
  resolveAmount,
  startCombat,
  usesDice,
  validate,
} from './engine.ts';
export {
  clampMultiplier,
  playCardWithSigil,
  SIGIL_MAX_MULTIPLIER,
  SIGIL_MIN_MULTIPLIER,
  scaleAmount,
  scaleEffects,
} from './sigil.ts';
export {
  absorb,
  attackDamage,
  DECAYS_AT_TURN_END,
  STATUS_IDS,
  stacks,
  VULNERABLE_MULTIPLIER,
  WEAK_MULTIPLIER,
  withStacks,
} from './statuses.ts';
export * from './types.ts';
