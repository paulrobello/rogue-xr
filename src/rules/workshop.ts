import { DEFAULT_MAX_HP, REWARD_CHOICES, type RunOptions, type RunState } from './run.ts';
import { RulesError } from './types.ts';

/** Bump when the stored `WorkshopState` shape changes. `saves.ts` rejects any other value. */
export const WORKSHOP_VERSION = 1;

export type UpgradeId = 'sturdy-frame' | 'spare-die' | 'wide-catalog';
export const UPGRADE_IDS: readonly UpgradeId[] = ['sturdy-frame', 'spare-die', 'wide-catalog'];

/** What one purchased tier adds to a fresh run. Tiers stack additively. */
export interface UpgradeEffect {
  readonly maxHp?: number;
  readonly bonusDice?: number;
  readonly rewardChoices?: number;
}

export interface UpgradeDef {
  readonly id: UpgradeId;
  readonly name: string;
  readonly description: string;
  /** Cog price of tier `i + 1` is `costs[i]`; `costs.length` is the tier cap. */
  readonly costs: readonly number[];
  readonly effectPerTier: UpgradeEffect;
}

/**
 * The slice's three upgrades. A run banks roughly 80 to 100 cogs (about five regular fights at 10-15,
 * plus treasure), so prices are sized for about one purchase per run and a full tree takes about five
 * runs: sturdy-frame 30/60/90 (180), spare-die 90, wide-catalog 60/120 (180), 450 cogs in all.
 */
export const UPGRADES: Readonly<Record<UpgradeId, UpgradeDef>> = {
  'sturdy-frame': {
    id: 'sturdy-frame',
    name: 'Sturdy Frame',
    description: 'Start each run with 5 more maximum HP per tier.',
    costs: [30, 60, 90],
    effectPerTier: { maxHp: 5 },
  },
  'spare-die': {
    id: 'spare-die',
    name: 'Spare Die',
    description: 'Start each run with one extra die in the dice tray.',
    costs: [90],
    effectPerTier: { bonusDice: 1 },
  },
  'wide-catalog': {
    id: 'wide-catalog',
    name: 'Wide Catalog',
    description: 'Card rewards offer one more choice per tier.',
    costs: [60, 120],
    effectPerTier: { rewardChoices: 1 },
  },
};

/** Permanent meta-progression. Immutable like the other rules states. */
export interface WorkshopState {
  readonly version: number;
  /** Cogs banked from finished runs and not yet spent. */
  readonly cogsBanked: number;
  /** Tiers bought per upgrade, 0 to the upgrade's tier cap. */
  readonly purchased: Readonly<Record<UpgradeId, number>>;
}

export function createWorkshop(): WorkshopState {
  return {
    version: WORKSHOP_VERSION,
    cogsBanked: 0,
    purchased: { 'sturdy-frame': 0, 'spare-die': 0, 'wide-catalog': 0 },
  };
}

export const maxTier = (id: UpgradeId): number => UPGRADES[id].costs.length;

/** Cog price of the next tier of `id`, or `null` when it is maxed. */
export function nextCost(ws: WorkshopState, id: UpgradeId): number | null {
  return UPGRADES[id].costs[ws.purchased[id]] ?? null;
}

/** Buys the next tier of `id`. Throws `RulesError` for an unknown id, a maxed upgrade or too few cogs. */
export function buyUpgrade(ws: WorkshopState, id: UpgradeId): WorkshopState {
  if (!UPGRADE_IDS.includes(id)) throw new RulesError(`Unknown upgrade ${String(id)}`);
  const cost = nextCost(ws, id);
  if (cost === null) throw new RulesError(`Upgrade ${id} is already at its maximum tier`);
  if (ws.cogsBanked < cost) {
    throw new RulesError(`Upgrade ${id} costs ${cost} cogs, only ${ws.cogsBanked} banked`);
  }
  return {
    ...ws,
    cogsBanked: ws.cogsBanked - cost,
    purchased: { ...ws.purchased, [id]: ws.purchased[id] + 1 },
  };
}

/**
 * Adds the run's cog purse to the bank. Call once per finished run: the run is not mutated, so banking
 * the same `RunState` twice pays twice.
 */
export function bankRunCogs(ws: WorkshopState, run: RunState): WorkshopState {
  return { ...ws, cogsBanked: ws.cogsBanked + run.cogs };
}

/** `createRun` options for a fresh run: base values plus every purchased tier's effect. */
export function runOptionsFrom(
  ws: WorkshopState,
): Required<Pick<RunOptions, 'maxHp' | 'bonusDice' | 'rewardChoices'>> {
  let maxHp = DEFAULT_MAX_HP;
  let bonusDice = 0;
  let rewardChoices = REWARD_CHOICES;
  for (const id of UPGRADE_IDS) {
    const tiers = ws.purchased[id];
    const effect = UPGRADES[id].effectPerTier;
    maxHp += (effect.maxHp ?? 0) * tiers;
    bonusDice += (effect.bonusDice ?? 0) * tiers;
    rewardChoices += (effect.rewardChoices ?? 0) * tiers;
  }
  return { maxHp, bonusDice, rewardChoices };
}
