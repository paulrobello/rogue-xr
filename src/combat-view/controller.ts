import { deckDefs, getCard, STARTER_DECK } from '../content/cards.ts';
import { dieById } from '../content/dice.ts';
import {
  ENCOUNTERS,
  ENEMIES,
  type EncounterTier,
  type EnemyKind,
  encounterSetups,
  pickEncounter,
} from '../content/enemies.ts';
import { isValidSeed, normalizeSeed, RunRng } from '../core/rng.ts';
import type { Difficulty } from '../rules/difficulty.ts';
import {
  type Action,
  apply,
  type CombatEvent,
  type CombatState,
  type EnemySetup,
  livingEnemies,
  PLAYER_ID,
  playCardWithSigil,
  rollDice,
  startCombat,
  validate,
} from '../rules/index.ts';
import type { SigilId, Stroke } from '../sigil/index.ts';
import { type SigilQuality, scoreTrace } from '../sigil-plate/index.ts';

export const DEFAULT_SEED = 'SPIRE001';
export const DEFAULT_ENEMY: EnemyKind = 'cog-sentry';
export const PLAYER_START_HP = 70;
const LOG_CAP = 200;

export const ENEMY_ORDER: readonly EnemyKind[] = [
  'cog-sentry',
  'spring-hound',
  'bellows-golem',
  'orrery-warden',
  'grand-escapement',
  'glasswing-scrivener',
  'furnace-mite',
  'null-crown-auditor',
];

export interface CombatOptions {
  /** Run seed; an invalid one falls back to `DEFAULT_SEED`. */
  readonly seed?: string;
  /** Single-enemy fight. Ignored when `encounter` is set. */
  readonly enemy?: EnemyKind;
  /** Picks an encounter of this tier from the seed's `floor` stream. */
  readonly encounter?: EncounterTier;
  /** Explicit enemy setups (a floor room's chosen encounter); wins over `enemy` and `encounter`. */
  readonly setups?: readonly EnemySetup[];
  readonly deck?: readonly string[];
  /** Debug cheat: every enemy starts at this many hit points (max hit points unchanged). */
  readonly enemyHp?: number;
  /** The player starts at this many hit points, capped at the max. Defaults to the max. */
  readonly playerHp?: number;
  /** The run's maximum hit points (workshop Sturdy Frame). Defaults to `PLAYER_START_HP`. */
  readonly playerMaxHp?: number;
  /**
   * Extra dice from the run's loadout (workshop Spare Die). Each dice card rolls `1 + bonusDice`
   * times from the dice stream and keeps the highest result. 0 rolls exactly as before.
   */
  readonly bonusDice?: number;
  /** The run's level: how strictly sigil traces are judged. Absent: Casual tolerance. */
  readonly difficulty?: Difficulty;
}

/** What the view can ask the controller to do next: `target` an enemy, `table` click, or draw a `sigil`. */
export type Stage = 'idle' | 'target' | 'table' | 'sigil' | 'over';

export type { SigilQuality };

export interface SigilResult {
  /** The sigil the card asked for. */
  readonly sigil: SigilId;
  readonly score: number;
  readonly multiplier: number;
  readonly quality: SigilQuality;
  /** The sigil the trace resembles most (may differ from `sigil` on a wrong trace). */
  readonly recognizedAs: SigilId;
}

export interface DiceReadout {
  readonly cardId: string;
  readonly cardName: string;
  readonly dieName: string;
  readonly faces: number;
  readonly value: number;
  /** Every physical roll, in order. The final entry is not necessarily the kept winner. */
  readonly rolls: readonly number[];
}

export type InvalidSubject =
  | { readonly kind: 'card'; readonly uid: number }
  | { readonly kind: 'enemy'; readonly id: string }
  | { readonly kind: 'table' }
  | { readonly kind: 'plate' }
  | { readonly kind: 'end-turn' };

export type ViewUpdate =
  | { readonly type: 'changed' }
  | { readonly type: 'invalid'; readonly reason: string; readonly subject: InvalidSubject };

export type Listener = (update: ViewUpdate) => void;

export type PlayResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const KNOWN_TIERS = Object.keys(ENCOUNTERS) as EncounterTier[];

/** Reads `?enemy=&encounter=&seed=&cheat=` into controller options; anything invalid falls back to the defaults. */
export function parseCombatQuery(search: string): CombatOptions {
  const params = new URLSearchParams(search);
  const seed = params.get('seed');
  const enemy = params.get('enemy');
  const tier = params.get('encounter');
  const cheat = params.get('cheat');
  return {
    seed: seed !== null && isValidSeed(seed) ? normalizeSeed(seed) : DEFAULT_SEED,
    enemy: enemy !== null && enemy in ENEMIES ? (enemy as EnemyKind) : DEFAULT_ENEMY,
    ...(tier !== null && (KNOWN_TIERS as string[]).includes(tier)
      ? { encounter: tier as EncounterTier }
      : {}),
    ...(cheat === 'win' ? { enemyHp: 1 } : {}),
    ...(cheat === 'lose' ? { playerHp: 1 } : {}),
  };
}

/** The enemy setups for `options`, with any hit point cheat applied. */
export function resolveSetups(options: CombatOptions): EnemySetup[] {
  const seed = normalizeSeed(options.seed ?? DEFAULT_SEED);
  const base = options.setups
    ? [...options.setups]
    : options.encounter
      ? encounterSetups(pickEncounter(options.encounter, new RunRng(seed).stream('floor')))
      : [ENEMIES[options.enemy ?? DEFAULT_ENEMY]];
  const cap = options.enemyHp;
  return cap === undefined
    ? base
    : base.map((setup) => ({
        ...setup,
        hp: Math.min(setup.hp, cap),
        maxHp: setup.maxHp ?? setup.hp,
      }));
}

/** One log line for an event, or `null` for events too noisy to show. */
export function describeEvent(event: CombatEvent, state: CombatState): string | null {
  const name = (id: string | null): string =>
    id === null || id === PLAYER_ID ? 'You' : (state.enemies.find((e) => e.id === id)?.name ?? id);
  switch (event.type) {
    case 'combat-started':
      return `Combat begins (${event.enemies.length} enemy, deck ${event.deckSize})`;
    case 'turn-started':
      return `-- Turn ${event.turn} --`;
    case 'card-played': {
      const dice = event.dice === null ? '' : ` [rolled ${event.dice}]`;
      const target = event.target === null ? '' : ` on ${name(event.target)}`;
      return `Played ${getCard(event.cardId).name}${target}${dice}`;
    }
    case 'damage-dealt':
      return `${name(event.source)} hit ${name(event.target)} for ${event.hpLost}${
        event.blocked > 0 ? ` (${event.blocked} blocked)` : ''
      }${event.kind === 'overheat' ? ' (overheat)' : ''}`;
    case 'healed':
      return `${name(event.target)} restored ${event.amount} HP`;
    case 'block-gained':
      return `${name(event.target)} gained ${event.amount} block`;
    case 'status-applied':
      return `${name(event.target)}: +${event.stacks} ${event.status} (${event.total})`;
    case 'enemy-acted':
      return `${name(event.enemyId)} used ${event.moveId}`;
    case 'enemy-phase':
      return `${name(event.enemyId)} opens its case: phase ${event.phase}`;
    case 'enemy-died':
      return `${name(event.enemyId)} is destroyed`;
    case 'reshuffled':
      return `Reshuffled ${event.count} cards`;
    case 'combat-won':
      return 'VICTORY';
    case 'combat-lost':
      return 'DEFEAT';
    default:
      return null;
  }
}

/**
 * The combat view's game logic with no rendering: owns the `CombatState` and RNG, turns clicks into
 * rules actions, and tells the presenter what changed. Invalid input never throws and never advances
 * an RNG stream: it emits `invalid` with the rules' reason and leaves the state alone.
 */
export class CombatController {
  readonly options: CombatOptions;
  readonly seed: string;
  readonly playerMaxHp: number;
  readonly bonusDice: number;
  state: CombatState;
  /** Presentation log lines, oldest first. */
  readonly log: string[] = [];
  lastDice: DiceReadout | null = null;
  lastSigil: SigilResult | null = null;
  private pending: { uid: number; target?: string } | null = null;
  /** Rules events since the last `drainEvents`, for presenters that react to them (audio, effects). */
  private readonly recentEvents: CombatEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(options: CombatOptions = {}) {
    this.options = options;
    this.seed = normalizeSeed(
      options.seed !== undefined && isValidSeed(options.seed) ? options.seed : DEFAULT_SEED,
    );
    this.playerMaxHp = Math.max(1, Math.floor(options.playerMaxHp ?? PLAYER_START_HP));
    this.bonusDice = Math.max(0, Math.floor(options.bonusDice ?? 0));
    const started = startCombat({
      player: {
        hp: Math.min(this.playerMaxHp, options.playerHp ?? this.playerMaxHp),
        maxHp: this.playerMaxHp,
      },
      deck: deckDefs(options.deck ?? STARTER_DECK),
      enemies: resolveSetups({ ...options, seed: this.seed }),
      rng: new RunRng(this.seed).snapshot(),
    });
    this.state = started.state;
    this.record(started);
    this.step({ type: 'start-turn' });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get outcome(): CombatState['outcome'] {
    return this.state.outcome;
  }

  /** Returns and clears the rules events recorded since the previous call. */
  drainEvents(): CombatEvent[] {
    return this.recentEvents.splice(0, this.recentEvents.length);
  }

  /** The card the player picked up, if any. */
  get selectedUid(): number | null {
    return this.pending?.uid ?? null;
  }

  get selectedTarget(): string | null {
    return this.pending?.target ?? null;
  }

  get stage(): Stage {
    if (this.state.outcome !== null) return 'over';
    if (this.pending === null) return 'idle';
    const info = this.pendingCard();
    if (info.target === 'enemy' && this.pending.target === undefined) return 'target';
    return info.sigil === undefined ? 'table' : 'sigil';
  }

  /** The sigil the plate is waiting for, while `stage === 'sigil'`. */
  get awaitedSigil(): SigilId | null {
    return this.stage === 'sigil' ? (this.pendingCard().sigil ?? null) : null;
  }

  /** Clicks a card: picks it up, or puts it down when it is already selected. */
  select(uid: number): PlayResult {
    if (this.state.outcome !== null)
      return this.invalid('The fight is over', { kind: 'card', uid });
    if (this.pending?.uid === uid) {
      this.pending = null;
      this.changed();
      return { ok: true };
    }
    const reason = this.probe(uid, this.probeTarget(uid));
    if (reason !== null) return this.invalid(reason, { kind: 'card', uid });
    this.pending = { uid };
    this.changed();
    return { ok: true };
  }

  /** Clicks an enemy: aims the selected card. Plain cards play now, sigil cards wait for the plate. */
  target(enemyId: string): PlayResult {
    const subject: InvalidSubject = { kind: 'enemy', id: enemyId };
    if (this.stage !== 'target' || this.pending === null) {
      return this.invalid(
        this.pending === null ? 'Select a card first' : 'No target needed',
        subject,
      );
    }
    const reason = this.probe(this.pending.uid, enemyId);
    if (reason !== null) return this.invalid(reason, subject);
    if (this.pendingCard().sigil !== undefined) {
      this.pending = { uid: this.pending.uid, target: enemyId };
      this.changed();
      return { ok: true };
    }
    return this.play(this.pending.uid, enemyId, null);
  }

  /** Clicks the table: plays the selected untargeted, non-sigil card. */
  table(): PlayResult {
    if (this.pending === null || this.state.outcome !== null) return { ok: true };
    const subject: InvalidSubject = { kind: 'table' };
    if (this.stage === 'target') return this.invalid('Pick an enemy first', subject);
    if (this.stage === 'sigil') return this.invalid('Draw the sigil on the plate', subject);
    return this.play(this.pending.uid, undefined, null);
  }

  /** The player released a trace on the plate: score it, then cast the selected sigil card. */
  submitSigil(strokes: readonly Stroke[]): PlayResult {
    const subject: InvalidSubject = { kind: 'plate' };
    const sigil = this.awaitedSigil;
    if (sigil === null || this.pending === null) {
      return this.invalid('Select a sigil card first', subject);
    }
    const trace = scoreTrace(strokes, sigil, this.options.difficulty);
    if (!trace.castable) return this.invalid('Trace too short, draw the glyph', subject);
    const result: SigilResult = {
      sigil,
      score: trace.score,
      multiplier: trace.multiplier,
      quality: trace.quality,
      recognizedAs: trace.recognizedAs,
    };
    return this.play(this.pending.uid, this.pending.target, result);
  }

  /** Ends the player turn, lets the enemies act, and starts the next turn unless the fight ended. */
  endTurn(): PlayResult {
    if (this.state.outcome !== null) return this.invalid('The fight is over', { kind: 'end-turn' });
    this.pending = null;
    this.step({ type: 'end-turn' });
    if (this.state.phase === 'enemy') this.step({ type: 'enemy-act' });
    if (this.state.phase === 'awaiting-turn') this.step({ type: 'start-turn' });
    this.changed();
    return { ok: true };
  }

  /** Puts the selected card back in the hand. */
  cancel(): void {
    if (this.pending === null) return;
    this.pending = null;
    this.changed();
  }

  private pendingCard() {
    const card = this.state.piles.hand.find((c) => c.uid === this.pending?.uid);
    if (!card) throw new Error('Selected card is not in hand');
    return getCard(card.def.id);
  }

  /** A target to probe with: the first living enemy for a targeted card, else none. */
  private probeTarget(uid: number): string | undefined {
    const card = this.state.piles.hand.find((c) => c.uid === uid);
    return card?.def.target === 'enemy' ? livingEnemies(this.state)[0]?.id : undefined;
  }

  /** The rules' reason a play is illegal, or `null`. A placeholder dice value lets dice cards validate. */
  private probe(uid: number, target: string | undefined): string | null {
    const action: Action = {
      type: 'play-card',
      uid,
      ...(target === undefined ? {} : { target }),
      dice: 0,
    };
    return validate(this.state, action);
  }

  /** Commits a play: rolls the card's die only after validation, so an illegal click leaves the dice stream alone. */
  private play(uid: number, target: string | undefined, sigil: SigilResult | null): PlayResult {
    const reason = this.probe(uid, target);
    if (reason !== null) return this.invalid(reason, { kind: 'card', uid });
    const card = this.state.piles.hand.find((c) => c.uid === uid);
    if (!card) return this.invalid('Card is not in hand', { kind: 'card', uid });
    const info = getCard(card.def.id);
    let current = this.state;
    let dice: number | undefined;
    if (info.dice !== undefined) {
      const die = dieById(info.dice);
      let best = Number.NEGATIVE_INFINITY;
      const rolls: number[] = [];
      for (let n = 0; n <= this.bonusDice; n++) {
        const rolled = rollDice(current, die);
        current = rolled.state;
        best = Math.max(best, rolled.roll.value);
        rolls.push(rolled.roll.value);
      }
      dice = best;
      this.lastDice = {
        cardId: info.id,
        cardName: info.name,
        dieName: die.name,
        faces: die.faces.length,
        value: best,
        rolls,
      };
    }
    const action = {
      type: 'play-card' as const,
      uid,
      ...(target === undefined ? {} : { target }),
      ...(dice === undefined ? {} : { dice }),
    };
    const result =
      sigil === null
        ? apply(current, action)
        : playCardWithSigil(current, action, sigil.multiplier);
    if (sigil !== null) this.lastSigil = sigil;
    this.pending = null;
    this.state = result.state;
    this.record(result);
    this.changed();
    return { ok: true };
  }

  private step(action: Action): void {
    const result = apply(this.state, action);
    this.state = result.state;
    this.record(result);
  }

  private record(result: { state: CombatState; events: readonly CombatEvent[] }): void {
    this.recentEvents.push(...result.events);
    if (this.recentEvents.length > LOG_CAP)
      this.recentEvents.splice(0, this.recentEvents.length - LOG_CAP);
    for (const event of result.events) {
      const line = describeEvent(event, result.state);
      if (line !== null) this.log.push(line);
    }
    if (this.log.length > LOG_CAP) this.log.splice(0, this.log.length - LOG_CAP);
  }

  private invalid(reason: string, subject: InvalidSubject): PlayResult {
    this.emit({ type: 'invalid', reason, subject });
    return { ok: false, reason };
  }

  private changed(): void {
    this.emit({ type: 'changed' });
  }

  private emit(update: ViewUpdate): void {
    for (const listener of this.listeners) listener(update);
  }
}
