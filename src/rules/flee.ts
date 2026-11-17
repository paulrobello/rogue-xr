import type { RewardTier } from './run.ts';

/**
 * Whether the player may flee a fight of `tier`: regular fights only. An elite or the guardian holds
 * the player until the fight is decided.
 */
export function canFlee(tier: RewardTier): boolean {
  return tier === 'regular';
}
