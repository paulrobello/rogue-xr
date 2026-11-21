import { apply, resolveAmount, validate } from './engine.ts';
import {
  type Action,
  type Amount,
  type ApplyResult,
  type CardDef,
  type CombatCard,
  type CombatState,
  type Effect,
  RulesError,
} from './types.ts';

type PlayCard = Extract<Action, { type: 'play-card' }>;

/** Weakest sigil: a barely recognised glyph still casts at half power. */
export const SIGIL_MIN_MULTIPLIER = 0.5;
/** Strongest sigil: a perfect glyph casts at 125 % power. */
export const SIGIL_MAX_MULTIPLIER = 1.25;

/** Absorbs float noise in `amount × multiplier`, so a true .5 (e.g. 5 × 0.7) still rounds up. */
const ROUNDING_TOLERANCE = 1e-9;

/** Clamps a sigil multiplier to [0.5, 1.25]. Throws `RulesError` for NaN or ±Infinity. */
export function clampMultiplier(multiplier: number): number {
  if (!Number.isFinite(multiplier)) throw new RulesError('Sigil multiplier must be finite');
  return Math.min(SIGIL_MAX_MULTIPLIER, Math.max(SIGIL_MIN_MULTIPLIER, multiplier));
}

/**
 * Scales one resolved amount: `round-half-up(amount × clamp(multiplier))`, never below 0. Because the
 * multiplier is at least 0.5, any amount of 1 or more stays at least 1.
 */
export function scaleAmount(amount: number, multiplier: number): number {
  const product = amount * clampMultiplier(multiplier);
  return Math.max(0, Math.floor(product + 0.5 + ROUNDING_TOLERANCE));
}

/**
 * Returns a new effect list scaled by a sigil multiplier (the sigil recogniser maps its score to it).
 *
 * - Scaled: damage per hit and its conditional bonus, Block, healing, and applied status stacks.
 * - Not scaled: `gain-steam`, `lose-steam`, `draw`. They are turn economy, and accuracy may not mint
 *   steam or cards.
 * - Rounding: every scaled amount goes through `scaleAmount` (round half up, never below 0).
 * - Dice amounts: the final value is scaled. `base + dice × roll` is resolved first with the engine's
 *   rule, then scaled, so the result is a plain number. Scaling a dice amount needs the roll; without
 *   one this throws `RulesError`. Unscaled dice amounts are left as they are.
 */
export function scaleEffects(
  effects: readonly Effect[],
  multiplier: number,
  dice: number | null = null,
): Effect[] {
  const m = clampMultiplier(multiplier);
  const scale = (amount: Amount): number => scaleAmount(resolveScaled(amount, dice), m);
  return effects.map((effect): Effect => {
    switch (effect.type) {
      case 'damage': {
        const bonus = effect.bonusIfSelfBlock;
        return {
          ...effect,
          amount: scale(effect.amount),
          ...(bonus ? { bonusIfSelfBlock: { ...bonus, amount: scale(bonus.amount) } } : {}),
        };
      }
      case 'block':
      case 'heal':
        return { ...effect, amount: scale(effect.amount) };
      case 'apply-status':
        return { ...effect, stacks: scale(effect.stacks) };
      case 'block-from-status':
        return { ...effect, multiplier: m };
      default:
        return effect;
    }
  });
}

function resolveScaled(amount: Amount, dice: number | null): number {
  if (typeof amount !== 'number' && dice === null) {
    throw new RulesError('Scaling a dice amount needs the dice result');
  }
  return resolveAmount(amount, dice);
}

/**
 * Plays a card through the real engine with its effects scaled by `multiplier`. Validates the action
 * against the unscaled card first (so a dice card still needs `action.dice`), swaps the scaled def in
 * for the play, then restores the original def wherever the card landed, so the card is never
 * permanently scaled. Events are the engine's own; `card-played` still carries the dice value.
 */
export function playCardWithSigil(
  state: CombatState,
  action: PlayCard,
  multiplier: number,
): ApplyResult {
  const problem = validate(state, action);
  if (problem !== null) throw new RulesError(problem);
  const original = state.piles.hand.find((c) => c.uid === action.uid) as CombatCard;
  const def: CardDef = {
    ...original.def,
    effects: scaleEffects(original.def.effects, multiplier, action.dice ?? null),
  };
  const swap = (pile: readonly CombatCard[], card: CombatCard): CombatCard[] =>
    pile.map((c) => (c.uid === action.uid ? card : c));
  const played = apply(
    {
      ...state,
      piles: { ...state.piles, hand: swap(state.piles.hand, { uid: original.uid, def }) },
    },
    action,
  );
  const { piles } = played.state;
  return {
    state: {
      ...played.state,
      piles: {
        draw: swap(piles.draw, original),
        hand: swap(piles.hand, original),
        discard: swap(piles.discard, original),
        exhaust: swap(piles.exhaust, original),
      },
    },
    events: played.events,
  };
}
