import type { EnemyMove, Fighter, FoundryStance, Statuses, StatusId } from './types.ts';

/**
 * Status semantics. "Owner" is the fighter carrying the status; a turn boundary is the owner's own
 * turn (the player's turn, or one enemy's action during enemy-act).
 *
 * - Weak: the owner's attack damage is multiplied by 0.75, rounded down. Loses 1 stack at the end of
 *   the owner's turn.
 * - Vulnerable: attack damage taken by the owner is multiplied by 1.5, rounded down. Loses 1 stack at
 *   the end of the owner's turn.
 * - Overheat: at the start of the owner's turn the owner loses HP equal to its stacks, ignoring block,
 *   Weak and Vulnerable; then it loses 1 stack.
 * - Wound-up: each of the owner's attack hits deals +stacks damage, added before Weak and Vulnerable.
 *   It never decays and lasts the whole combat.
 */
export const STATUS_IDS: readonly StatusId[] = [
  'weak',
  'vulnerable',
  'overheat',
  'wound-up',
  'plating',
  'rust',
  'charge',
];

/** Statuses that lose one stack at the end of their owner's turn. */
export const DECAYS_AT_TURN_END: readonly StatusId[] = ['weak', 'vulnerable', 'rust'];

export const WEAK_MULTIPLIER = 0.75;
export const VULNERABLE_MULTIPLIER = 1.5;
export const RUST_MULTIPLIER = 0.5;
export const SIGIL_CHARGE_PER_STACK = 0.1;

export function stacks(statuses: Statuses, id: StatusId): number {
  return statuses[id] ?? 0;
}

/** Adds stacks (which may be negative) and drops the status when it reaches zero. */
export function withStacks(statuses: Statuses, id: StatusId, delta: number): Statuses {
  const next = Math.max(0, stacks(statuses, id) + delta);
  const out: Partial<Record<StatusId, number>> = {};
  for (const key of STATUS_IDS) {
    const value = key === id ? next : stacks(statuses, key);
    if (value > 0) out[key] = value;
  }
  return out;
}

export const STANCE_MULTIPLIER = { guarded: 0.75, exposed: 1.25 } as const;
type Posture = { readonly intent?: EnemyMove | null };

export function foundryStance(target: Posture): FoundryStance | 'neutral' {
  return target.intent?.stance ?? 'neutral';
}

/** Wound-up adds first, then Weak and Vulnerable round down. Posture modifies each hit before Block. */
export function attackDamage(base: number, attacker: Fighter, defender: Fighter & Posture): number {
  let damage = base + stacks(attacker.statuses, 'wound-up');
  if (stacks(attacker.statuses, 'weak') > 0) damage = Math.floor(damage * WEAK_MULTIPLIER);
  if (stacks(defender.statuses, 'vulnerable') > 0) {
    damage = Math.floor(damage * VULNERABLE_MULTIPLIER);
  }
  const stance = foundryStance(defender);
  if (damage <= 0) return 0;
  return stance === 'neutral'
    ? damage
    : Math.max(1, Math.round(damage * STANCE_MULTIPLIER[stance]));
}

/** Splits incoming damage into the part block absorbs and the part that reaches HP. */
export function absorb(damage: number, block: number): { blocked: number; hpLost: number } {
  const blocked = Math.min(block, damage);
  return { blocked, hpLost: damage - blocked };
}
