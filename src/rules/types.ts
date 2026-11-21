import type { RunRngState } from '../core/rng.ts';

/** Steam (energy) refilled at the start of every player turn (D3). */
export const STEAM_PER_TURN = 3;
/** Cards drawn at the start of every player turn (D3). */
export const DRAW_PER_TURN = 5;
export const MAX_HAND = 10;

export type PrismChannel = 0 | 1 | 2;
export interface StoredPrismState {
  readonly orientation: PrismChannel;
  readonly progress: 0 | 1 | 2 | 3;
}

export type DispatchRoute = 0 | 1 | 2;
export interface StoredDispatchState {
  readonly route: DispatchRoute;
  readonly sent: boolean;
  readonly opened: boolean;
}
export type PipeChannel = 0 | 1 | 2;
export type SpeakingPipesState = 'idle' | 'primed' | 'open';
export type StoredSpeakingPipesState = SpeakingPipesState;
export type ValvehouseState = 'missing' | 'held' | 'seated' | 'open';

/** `'player'` or an enemy id. Enemy ids must never be `'player'`. */
export type ActorId = string;
export const PLAYER_ID = 'player';

export type StatusId = 'weak' | 'vulnerable' | 'overheat' | 'wound-up' | 'plating' | 'rust';
/** Stack counts by status. A status with zero stacks is absent. */
export type Statuses = Readonly<Partial<Record<StatusId, number>>>;

/**
 * A number, or `base + dice × <caller-supplied dice result>`. Enemy moves may only use plain numbers;
 * a card using a dice amount must be played with a `dice` value.
 */
export type Amount = number | { readonly base?: number; readonly dice: number };

/**
 * Who an effect lands on, relative to the actor resolving it: `'self'` is the actor, `'target'` is the
 * card's chosen enemy (for an enemy move, the player), `'all-opponents'` is every living enemy (for an
 * enemy move, the player).
 */
export type EffectTarget = 'self' | 'target' | 'all-opponents';

export type Effect =
  | {
      readonly type: 'damage';
      readonly amount: Amount;
      /** Additional damage when the acting player has at least this much Block. */
      readonly bonusIfSelfBlock?: { readonly min: number; readonly amount: number };
      /** Repeat the hit this many times (default 1). Each hit is modified and blocked separately. */
      readonly hits?: number;
      readonly target: 'target' | 'all-opponents';
    }
  | { readonly type: 'block'; readonly amount: Amount }
  | { readonly type: 'gain-steam'; readonly amount: Amount }
  | { readonly type: 'lose-steam'; readonly amount: Amount }
  | {
      readonly type: 'apply-status';
      readonly status: StatusId;
      readonly stacks: Amount;
      readonly target: EffectTarget;
    }
  | {
      readonly type: 'block-from-status';
      readonly status: StatusId;
      readonly maxStacks: number;
      readonly base: number;
      readonly perStack: number;
      readonly target: 'self';
      readonly removeFrom: 'self' | 'target';
      /** Set by sigil resolution so the resulting total is scaled once. */
      readonly multiplier?: number;
    }
  | {
      readonly type: 'conditional-block';
      readonly amount: Amount;
      readonly target: 'self';
      readonly minTargetHits: number;
    }
  | { readonly type: 'draw'; readonly amount: Amount }
  | { readonly type: 'heal'; readonly amount: Amount; readonly target: 'self' };

/** How a card picks its target: an enemy, or nothing (dropped on the table, D5). */
export type CardTargetRule = 'enemy' | 'none';

/**
 * The engine's view of a card. Content (P2-T2) may extend this interface with extra fields; the engine
 * carries the whole object through the piles untouched.
 */
export interface CardDef {
  readonly id: string;
  readonly cost: number;
  readonly target: CardTargetRule;
  readonly effects: readonly Effect[];
  /** Goes to the exhaust pile instead of discard after it is played. */
  readonly exhaust?: boolean;
  /** Keeps this card in hand when the player ends the turn. */
  readonly pinned?: boolean;
}

/** A card instance in a pile. `uid` is unique within one combat. */
export interface CombatCard {
  readonly uid: number;
  readonly def: CardDef;
}

export type IntentKind = 'attack' | 'defend' | 'buff' | 'debuff' | 'attack-debuff' | 'unknown';
export type FoundryStance = 'guarded' | 'exposed';

/** One enemy move. Its effects resolve from the enemy's point of view (see `EffectTarget`). */
export interface EnemyMove {
  readonly id: string;
  readonly intent: IntentKind;
  readonly effects: readonly Effect[];
  /** Optional visible Foundry pose modifier. Legacy moves remain neutral. */
  readonly stance?: FoundryStance;
  /** Relative weight for the `ai`-stream pick (default 1). */
  readonly weight?: number;
  /** An announced move that must follow this action. A weight of zero reserves it for follow-ups. */
  readonly followUp?: string;
}

export interface Fighter {
  readonly hp: number;
  readonly maxHp: number;
  readonly block: number;
  readonly statuses: Statuses;
}

export interface PlayerState extends Fighter {
  readonly steam: number;
}

/**
 * A second phase: once the enemy's hp first falls to `hpFraction` of its max or below, its move list
 * becomes `moves` for every intent picked from then on. Decided by hp alone, so it draws no random
 * number and the intent already shown stays as it is.
 */
export interface EnemyPhaseTwo {
  readonly hpFraction: number;
  readonly moves: readonly EnemyMove[];
}

export interface EnemyState extends Fighter {
  readonly id: string;
  readonly name: string;
  /** The move list in force: the setup's `moves`, replaced by `phaseTwo.moves` once phase 2 begins. */
  readonly moves: readonly EnemyMove[];
  /** Carried from the setup; absent for an enemy with one phase. */
  readonly phaseTwo?: EnemyPhaseTwo;
  /** Present only with `phaseTwo`: 1 until the hp threshold is crossed, then 2. */
  readonly phase?: 1 | 2;
  /** The visible next intent; `null` once the enemy is dead. */
  readonly intent: EnemyMove | null;
}

export interface Piles {
  /** Index 0 is the top of the draw pile. */
  readonly draw: readonly CombatCard[];
  readonly hand: readonly CombatCard[];
  readonly discard: readonly CombatCard[];
  readonly exhaust: readonly CombatCard[];
}

/**
 * `idle` before start-combat; `awaiting-turn` when start-turn is next; `player` while cards may be
 * played; `enemy` when enemy-act is next; `over` once the combat is won or lost.
 */
export type CombatPhase = 'idle' | 'awaiting-turn' | 'player' | 'enemy' | 'over';
export type CombatOutcome = 'won' | 'lost' | null;

/** Plain, JSON-serializable combat state. Never mutated by `apply`. */
export interface CombatState {
  readonly phase: CombatPhase;
  readonly outcome: CombatOutcome;
  /** Player turn number; 0 before the first start-turn. */
  readonly turn: number;
  readonly player: PlayerState;
  readonly enemies: readonly EnemyState[];
  readonly piles: Piles;
  /** Run RNG snapshot. The engine draws from `deck` (shuffles) and `ai` (intents) only. */
  readonly rng: RunRngState;
}

export interface EnemySetup {
  readonly id: string;
  readonly name: string;
  readonly hp: number;
  readonly maxHp?: number;
  /** The phase-1 move list when `phaseTwo` is set. */
  readonly moves: readonly EnemyMove[];
  readonly phaseTwo?: EnemyPhaseTwo;
  readonly statuses?: Statuses;
}

export interface PlayerSetup {
  readonly hp: number;
  readonly maxHp: number;
  readonly statuses?: Statuses;
}

export type Action =
  | {
      readonly type: 'start-combat';
      readonly player: PlayerSetup;
      readonly deck: readonly CardDef[];
      readonly enemies: readonly EnemySetup[];
      readonly rng: RunRngState;
    }
  | { readonly type: 'start-turn' }
  | {
      readonly type: 'play-card';
      readonly uid: number;
      /** Enemy id, required when the card's target rule is `'enemy'`. */
      readonly target?: string;
      /** Dice result resolved by the caller from the `dice` stream before presentation (D1). */
      readonly dice?: number;
    }
  | { readonly type: 'end-turn' }
  | { readonly type: 'enemy-act' };

export type DamageSource = 'attack' | 'overheat';

/** Presentation events, in resolution order. Every field is always present, so logs serialize stably. */
export type CombatEvent =
  | {
      readonly type: 'combat-started';
      readonly enemies: readonly string[];
      readonly deckSize: number;
    }
  | { readonly type: 'turn-started'; readonly turn: number }
  | { readonly type: 'turn-ended'; readonly turn: number }
  | { readonly type: 'steam-changed'; readonly from: number; readonly to: number }
  | { readonly type: 'card-drawn'; readonly uid: number; readonly cardId: string }
  | { readonly type: 'reshuffled'; readonly count: number }
  | {
      readonly type: 'card-played';
      readonly uid: number;
      readonly cardId: string;
      readonly target: string | null;
      readonly dice: number | null;
    }
  | { readonly type: 'card-discarded'; readonly uid: number; readonly cardId: string }
  | { readonly type: 'card-exhausted'; readonly uid: number; readonly cardId: string }
  | {
      readonly type: 'damage-dealt';
      readonly source: ActorId | null;
      readonly target: ActorId;
      readonly kind: DamageSource;
      /** Damage after modifiers, before block. */
      readonly amount: number;
      readonly blocked: number;
      readonly hpLost: number;
    }
  | { readonly type: 'healed'; readonly target: ActorId; readonly amount: number }
  | { readonly type: 'block-gained'; readonly target: ActorId; readonly amount: number }
  | { readonly type: 'block-cleared'; readonly target: ActorId; readonly amount: number }
  | {
      readonly type: 'status-applied';
      readonly target: ActorId;
      readonly status: StatusId;
      readonly stacks: number;
      readonly total: number;
    }
  | {
      readonly type: 'status-ticked';
      readonly target: ActorId;
      readonly status: StatusId;
      readonly from: number;
      readonly to: number;
    }
  | {
      readonly type: 'enemy-intent';
      readonly enemyId: string;
      readonly moveId: string;
      readonly intent: IntentKind;
    }
  | { readonly type: 'enemy-acted'; readonly enemyId: string; readonly moveId: string }
  | { readonly type: 'enemy-phase'; readonly enemyId: string; readonly phase: 2 }
  | { readonly type: 'enemy-died'; readonly enemyId: string }
  | { readonly type: 'combat-won' }
  | { readonly type: 'combat-lost' };

export interface ApplyResult {
  readonly state: CombatState;
  readonly events: readonly CombatEvent[];
}

/** Thrown by `apply` for an action that is illegal in the given state. */
export class RulesError extends Error {
  override readonly name = 'RulesError';
}

export type PressureDial = 1 | 2 | 3;
export type PressureDials = readonly [PressureDial, PressureDial, PressureDial];

export type PressureNoteId = 'dispatch' | 'A' | 'B' | 'C';

export interface PressureState {
  readonly dials: PressureDials;
  readonly solved: boolean;
}

export interface NormalizedPressureState extends PressureState {
  readonly notes: readonly PressureNoteId[];
  readonly drawerOpen: boolean;
  readonly rewardClaimed: boolean;
}

export type BellNote = 0 | 1 | 2;

/** Shared by the music box downstairs and the reward lock upstairs. */
export interface StoredBellChimesState {
  readonly clueHeard: boolean;
  readonly progress: readonly BellNote[];
  readonly solved: boolean;
  readonly rewardClaimed: boolean;
}

export type FollowupRecipe = 'lantern-ink' | 'stillwind' | 'looking-glass';
export interface StoredConservatoryFormula {
  readonly recipe: FollowupRecipe;
  readonly clues: readonly ('portrait' | 'record')[];
  readonly added: readonly Ingredient[];
  readonly brewed: boolean;
  readonly revealed: boolean;
  readonly opened: boolean;
}
export type CommissionKind = 'recovery' | 'restoration' | 'delve';
export interface StoredCommissionState {
  readonly kind: CommissionKind;
  readonly accepted: boolean;
  readonly claimed: boolean;
  readonly recovered: readonly (0 | 1 | 2)[];
  readonly payout: number;
}

/** Stored pressure state. The two fields added after v3 remain optional for old saves. */
export interface StoredPressureState extends PressureState {
  readonly notes?: readonly PressureNoteId[];
  readonly drawerOpen?: boolean;
  readonly rewardClaimed?: boolean;
}

/** Progress for the seeded Upper Works counterweight lock. */
export interface StoredCounterweightState {
  readonly selected?: 0 | 1;
  readonly solved: boolean;
}

export type Ingredient = 0 | 1 | 2;
export interface StoredAlchemyState {
  readonly found: readonly Ingredient[];
  readonly added: readonly Ingredient[];
  readonly brewed: boolean;
  readonly opened: boolean;
}
export type CalibrationKind = 'gears' | 'orrery';
export type GearId = 0 | 1 | 2;
export interface StoredCalibrationState {
  readonly kind: CalibrationKind;
  readonly chart: boolean;
  readonly key: 'missing' | 'held' | 'inserted';
  readonly spare: boolean;
  readonly repaired: boolean;
  readonly selected: GearId | null;
  readonly slots: readonly (GearId | null)[];
  readonly detents: readonly number[];
  readonly solved: boolean;
  readonly claimed: boolean;
}
export interface StoredHiddenPanelState {
  readonly discovered: boolean;
  readonly opened: boolean;
}

export type BrassKeyState = 'missing' | 'held' | 'spent';
