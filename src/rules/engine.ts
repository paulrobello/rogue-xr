import { RunRng, type RunRngState, Stream } from '../core/rng.ts';
import {
  absorb,
  attackDamage,
  DECAYS_AT_TURN_END,
  STATUS_IDS,
  stacks,
  withStacks,
} from './statuses.ts';
import {
  type Action,
  type ActorId,
  type Amount,
  type ApplyResult,
  type CardCost,
  type CardDef,
  type CombatCard,
  type CombatEvent,
  type CombatOutcome,
  type CombatPhase,
  type CombatState,
  DRAW_PER_TURN,
  type Effect,
  type EffectTarget,
  type EnemyMove,
  type EnemyState,
  type Fighter,
  MAX_HAND,
  type PendingScry,
  PLAYER_ID,
  type PlayerState,
  RulesError,
  STEAM_PER_TURN,
  type Statuses,
  type StatusId,
  type SuccessfulSigil,
} from './types.ts';

type StartCombat = Extract<Action, { type: 'start-combat' }>;
type PlayCard = Extract<Action, { type: 'play-card' }>;

/** Working copy for one `apply` call. Arrays are fresh; fighters and cards are replaced, never mutated. */
interface Work {
  phase: CombatPhase;
  outcome: CombatOutcome;
  turn: number;
  player: PlayerState;
  enemies: EnemyState[];
  draw: CombatCard[];
  hand: CombatCard[];
  discard: CombatCard[];
  exhaust: CombatCard[];
  mechanisms: CombatCard[];
  scry?: PendingScry;
  loadedDie?: boolean;
  rerollDie?: boolean;
  lastSuccessfulSigil?: SuccessfulSigil;
  rng: RunRngState;
  deck: Stream;
  ai: Stream;
  events: CombatEvent[];
}

const IDLE_SEED = '00000000';

/** The state before start-combat. Its RNG snapshot is a placeholder replaced by start-combat. */
export function createIdleState(): CombatState {
  return {
    phase: 'idle',
    outcome: null,
    turn: 0,
    player: { hp: 0, maxHp: 0, block: 0, statuses: {}, steam: 0 },
    enemies: [],
    piles: { draw: [], hand: [], discard: [], exhaust: [] },
    rng: new RunRng(IDLE_SEED).snapshot(),
  };
}

/** Convenience for `apply(createIdleState(), { type: 'start-combat', ... })`. */
export function startCombat(setup: Omit<StartCombat, 'type'>): ApplyResult {
  return apply(createIdleState(), { type: 'start-combat', ...setup });
}

/** `base + dice × roll`, floored and never below 0. Throws if a dice amount has no roll. */
export function resolveAmount(amount: Amount, dice: number | null, steamSpent = 0): number {
  if (typeof amount === 'number') return Math.max(0, Math.floor(amount));
  if ('perSteam' in amount) return Math.max(0, Math.floor(amount.perSteam * steamSpent));
  if (dice === null) throw new RulesError('A dice amount needs a dice result');
  if ('atLeast' in amount)
    return Math.max(0, Math.floor(dice >= amount.atLeast ? amount.high : amount.low));
  return Math.max(0, Math.floor((amount.base ?? 0) + amount.dice * dice));
}

function hitAmount(
  effect: Extract<Effect, { type: 'damage' }>,
  block: number,
  dice: number | null,
  steamSpent = 0,
): number {
  const bonus = effect.bonusIfSelfBlock;
  return (
    resolveAmount(effect.amount, dice, steamSpent) +
    (bonus && block >= bonus.min ? resolveAmount(bonus.amount, null, steamSpent) : 0)
  );
}

function effectAmount(effect: Effect): Amount | undefined {
  if (effect.type === 'apply-status') return effect.stacks;
  return 'amount' in effect ? effect.amount : undefined;
}

export function usesDice(effects: readonly Effect[]): boolean {
  return effects.some((effect) => {
    const amount = effectAmount(effect);
    return amount !== undefined && typeof amount !== 'number' && !('perSteam' in amount);
  });
}

export function cardSteamCost(cost: CardCost, availableSteam: number): number {
  return cost === 'X' ? Math.max(0, availableSteam) : cost;
}

export function playTarget(state: CombatState, card: CardDef): CardDef['target'] {
  return (card.echoSigil ? state.lastSuccessfulSigil?.target : undefined) ?? card.target;
}

export function isAlive(fighter: Fighter): boolean {
  return fighter.hp > 0;
}

export function livingEnemies(state: CombatState): readonly EnemyState[] {
  return state.enemies.filter(isAlive);
}

/**
 * Per-hit attack damage an enemy's visible intent would deal to the player right now, after statuses
 * and before block, one entry per damage effect. Lets the presenter show intent numbers.
 */
export function intentDamage(state: CombatState, enemyId: string): readonly number[] {
  const enemy = state.enemies.find((e) => e.id === enemyId);
  if (!enemy?.intent) return [];
  return enemy.intent.effects.flatMap((effect) =>
    effect.type === 'damage'
      ? [attackDamage(hitAmount(effect, enemy.block, null), enemy, state.player)]
      : [],
  );
}

/** Why `action` is illegal in `state`, or `null` when `apply` would accept it. */
export function validate(state: CombatState, action: Action): string | null {
  switch (action.type) {
    case 'start-combat':
      return state.phase === 'idle' ? validateSetup(action) : 'start-combat needs an idle state';
    case 'start-turn':
      return state.phase === 'awaiting-turn'
        ? null
        : `start-turn is illegal in phase ${state.phase}`;
    case 'end-turn':
      return state.phase === 'player' ? null : `end-turn is illegal in phase ${state.phase}`;
    case 'enemy-act':
      return state.phase === 'enemy' ? null : `enemy-act is illegal in phase ${state.phase}`;
    case 'play-card':
      return validatePlay(state, action);
    case 'resolve-scry': {
      if (state.phase !== 'scry' || !state.scry) return 'No Scry choice is open';
      const visible = state.piles.draw.slice(0, state.scry.count);
      const valid =
        new Set(action.discard).size === action.discard.length &&
        action.discard.every((uid) => visible.some((card) => card.uid === uid));
      return valid ? null : 'Discard choices must name distinct revealed cards';
    }
  }
}

/** Pure reducer: returns the next state and the presentation events. Throws `RulesError` when illegal. */
export function apply(state: CombatState, action: Action): ApplyResult {
  const problem = validate(state, action);
  if (problem !== null) throw new RulesError(problem);
  const w = action.type === 'start-combat' ? setupWork(action) : openWork(state);
  switch (action.type) {
    case 'start-combat':
      break;
    case 'start-turn':
      startTurn(w);
      break;
    case 'play-card':
      playCard(w, action);
      break;
    case 'resolve-scry':
      resolveScry(w, action.discard);
      break;
    case 'end-turn':
      endTurn(w);
      break;
    case 'enemy-act':
      enemyAct(w);
      break;
  }
  return { state: closeWork(w), events: w.events };
}

function validateCard(def: CardDef): string | null {
  if (def.cost !== 'X' && (!Number.isInteger(def.cost) || def.cost < 0))
    return `Card ${def.id} has an invalid cost`;
  if (def.echoSigil && (def.target !== 'none' || def.effects.length > 0 || def.mechanism))
    return `Echo card ${def.id} must use only its remembered spell`;
  const mechanism = def.mechanism;
  if (mechanism) {
    if (def.target !== 'none' || def.effects.length > 0)
      return `Mechanism ${def.id} must install without an immediate effect or target`;
    if (usesDice(mechanism.effects)) return `Mechanism ${def.id} cannot require a die result`;
    for (const effect of mechanism.effects) {
      const amount = effectAmount(effect);
      if (effect.type === 'scry' || (typeof amount === 'object' && 'perSteam' in amount))
        return `Mechanism ${def.id} cannot require a player choice or spent Steam`;
      const aimed =
        ('target' in effect &&
          (effect.target === 'target' || effect.target === 'other-opponents')) ||
        (effect.type === 'block-from-status' && effect.removeFrom === 'target');
      if (aimed && !mechanism.target)
        return `Mechanism ${def.id} aims an effect but targets nothing`;
    }
  }
  for (const effect of def.effects) {
    if (
      effect.type === 'damage' &&
      effect.extraHitsIfTargetRust !== undefined &&
      (effect.target !== 'target' ||
        !Number.isInteger(effect.extraHitsIfTargetRust) ||
        effect.extraHitsIfTargetRust < 0)
    )
      return `Card ${def.id} has invalid Rust hit bonus`;
    const amount = effectAmount(effect);
    if (amount === undefined || typeof amount === 'number' || !('perSteam' in amount)) continue;
    if (!Number.isFinite(amount.perSteam) || amount.perSteam <= 0)
      return `Card ${def.id} has an invalid perSteam amount`;
    if (def.cost !== 'X') return `Card ${def.id} uses perSteam without an X cost`;
  }
  const scryAt = def.effects.findIndex((effect) => effect.type === 'scry');
  if (scryAt !== -1) {
    const scry = def.effects[scryAt];
    if (scry.type !== 'scry' || scryAt !== def.effects.length - 1)
      return `Card ${def.id} must end with its only Scry effect`;
    const after = scry.drawAfter ?? 0;
    if (
      !Number.isInteger(scry.count) ||
      scry.count < 1 ||
      scry.count > 4 ||
      !Number.isInteger(after) ||
      after < 0
    )
      return `Card ${def.id} has invalid Scry values`;
  }
  const aimed = def.effects.some(
    (e) => 'target' in e && (e.target === 'target' || e.target === 'other-opponents'),
  );
  if (aimed && def.target !== 'enemy') return `Card ${def.id} aims an effect but targets nothing`;
  return null;
}

function validateMove(enemyId: string, move: EnemyMove): string | null {
  const weight = move.weight ?? 1;
  if (!Number.isInteger(weight) || weight < 0)
    return `Move ${move.id} needs a non-negative integer weight`;
  if (usesDice(move.effects)) return `Move ${move.id} of ${enemyId} may not use dice amounts`;
  if (
    move.effects.some((effect) => {
      const amount = effectAmount(effect);
      return amount !== undefined && typeof amount !== 'number' && 'perSteam' in amount;
    })
  )
    return `Move ${move.id} of ${enemyId} may not use perSteam amounts`;
  const playerOnly = move.effects.find(
    (e) =>
      e.type === 'draw' ||
      e.type === 'scry' ||
      e.type === 'damage-from-block' ||
      ('target' in e && e.target === 'other-opponents') ||
      e.type.endsWith('-steam'),
  );
  if (playerOnly) return `Move ${move.id} of ${enemyId} uses player-only effect ${playerOnly.type}`;
  return null;
}

function validateSetup(action: StartCombat): string | null {
  const { player, deck, enemies } = action;
  if (player.hp <= 0 || player.hp > player.maxHp) return 'Player needs 0 < hp <= maxHp';
  if (enemies.length === 0) return 'A combat needs at least one enemy';
  const ids = new Set<string>();
  for (const enemy of enemies) {
    if (enemy.id === PLAYER_ID || ids.has(enemy.id))
      return `Enemy id ${enemy.id} is reserved or taken`;
    ids.add(enemy.id);
    if (enemy.hp <= 0 || enemy.hp > (enemy.maxHp ?? enemy.hp))
      return `Enemy ${enemy.id} has bad hp`;
    if (enemy.moves.length === 0) return `Enemy ${enemy.id} has no moves`;
    const { phaseTwo } = enemy;
    if (phaseTwo && !(phaseTwo.hpFraction > 0 && phaseTwo.hpFraction < 1))
      return `Enemy ${enemy.id} needs a phase-2 threshold between 0 and 1`;
    if (phaseTwo && phaseTwo.moves.length === 0) return `Enemy ${enemy.id} has no phase-2 moves`;
    for (const moves of [enemy.moves, ...(phaseTwo ? [phaseTwo.moves] : [])]) {
      if (!moves.some((move) => (move.weight ?? 1) > 0))
        return `Enemy ${enemy.id} has no selectable move`;
      for (const move of moves) {
        const problem = validateMove(enemy.id, move);
        if (problem) return problem;
        if (move.followUp && !moves.some((next) => next.id === move.followUp))
          return `Enemy ${enemy.id} has unknown follow-up ${move.followUp}`;
      }
    }
  }
  for (const def of deck) {
    const problem = validateCard(def);
    if (problem) return problem;
  }
  return null;
}

function validatePlay(state: CombatState, action: PlayCard): string | null {
  if (state.phase !== 'player') return `play-card is illegal in phase ${state.phase}`;
  const card = state.piles.hand.find((c) => c.uid === action.uid);
  if (!card) return `Card ${action.uid} is not in hand`;
  const { def } = card;
  const cost = cardSteamCost(def.cost, state.player.steam);
  if (cost > state.player.steam) return `Card ${def.id} costs ${def.cost} steam`;
  if (def.echoSigil && !state.lastSuccessfulSigil) return 'Cast a sigil successfully before Echo';
  if (playTarget(state, def) === 'enemy') {
    const target = state.enemies.find((e) => e.id === action.target);
    if (!target || !isAlive(target)) return `Card ${def.id} needs a living enemy target`;
  } else if (action.target !== undefined) {
    return `Card ${def.id} takes no target`;
  }
  if (action.dice !== undefined && (!Number.isInteger(action.dice) || action.dice < 0)) {
    return 'Dice result must be a non-negative integer';
  }
  if (action.dice === undefined && usesDice(def.effects))
    return `Card ${def.id} needs a dice result`;
  return null;
}

function cleanStatuses(statuses: Statuses | undefined): Statuses {
  let out: Statuses = {};
  for (const id of STATUS_IDS) out = withStacks(out, id, stacks(statuses ?? {}, id));
  return out;
}

function setupWork(action: StartCombat): Work {
  const w: Work = {
    phase: 'awaiting-turn',
    outcome: null,
    turn: 0,
    player: {
      hp: action.player.hp,
      maxHp: action.player.maxHp,
      block: 0,
      statuses: cleanStatuses(action.player.statuses),
      steam: 0,
    },
    enemies: action.enemies.map((e) => ({
      id: e.id,
      name: e.name,
      hp: e.hp,
      maxHp: e.maxHp ?? e.hp,
      block: 0,
      statuses: cleanStatuses(e.statuses),
      moves: e.moves,
      ...(e.phaseTwo ? { phaseTwo: e.phaseTwo, phase: 1 as const } : {}),
      intent: null,
    })),
    draw: [],
    hand: [],
    discard: [],
    exhaust: [],
    mechanisms: [],
    rng: action.rng,
    deck: new Stream(action.rng.deck),
    ai: new Stream(action.rng.ai),
    events: [],
  };
  w.draw = w.deck.shuffle(action.deck.map((def, uid) => ({ uid, def })));
  w.events.push({
    type: 'combat-started',
    enemies: w.enemies.map((e) => e.id),
    deckSize: w.draw.length,
  });
  w.enemies = w.enemies.map((e) => chooseIntent(w, e));
  return w;
}

function openWork(state: CombatState): Work {
  return {
    phase: state.phase,
    outcome: state.outcome,
    turn: state.turn,
    player: state.player,
    enemies: [...state.enemies],
    draw: [...state.piles.draw],
    hand: [...state.piles.hand],
    discard: [...state.piles.discard],
    exhaust: [...state.piles.exhaust],
    mechanisms: [...(state.mechanisms ?? [])],
    scry: state.scry,
    loadedDie: state.loadedDie,
    rerollDie: state.rerollDie,
    lastSuccessfulSigil: state.lastSuccessfulSigil,
    rng: state.rng,
    deck: new Stream(state.rng.deck),
    ai: new Stream(state.rng.ai),
    events: [],
  };
}

function closeWork(w: Work): CombatState {
  return {
    phase: w.phase,
    outcome: w.outcome,
    turn: w.turn,
    player: w.player,
    enemies: w.enemies,
    piles: { draw: w.draw, hand: w.hand, discard: w.discard, exhaust: w.exhaust },
    ...(w.mechanisms.length > 0 ? { mechanisms: w.mechanisms } : {}),
    ...(w.scry ? { scry: w.scry } : {}),
    ...(w.loadedDie ? { loadedDie: true } : {}),
    ...(w.rerollDie ? { rerollDie: true } : {}),
    ...(w.lastSuccessfulSigil ? { lastSuccessfulSigil: w.lastSuccessfulSigil } : {}),
    rng: { ...w.rng, deck: w.deck.snapshot(), ai: w.ai.snapshot() },
  };
}

function fighter(w: Work, id: ActorId): Fighter {
  if (id === PLAYER_ID) return w.player;
  const enemy = w.enemies.find((e) => e.id === id);
  if (!enemy) throw new RulesError(`Unknown fighter ${id}`);
  return enemy;
}

function update(w: Work, id: ActorId, patch: Partial<Fighter>): void {
  if (id === PLAYER_ID) {
    w.player = { ...w.player, ...patch };
    return;
  }
  w.enemies = w.enemies.map((e) => (e.id === id ? { ...e, ...patch } : e));
}

function isOver(w: Work): boolean {
  return w.outcome !== null;
}

/**
 * Moves an enemy into phase 2 the first time its hp is at or below its threshold. Swaps the move list
 * only: the intent already chosen stands, and the next pick (after the enemy acts) draws from phase 2.
 */
function checkPhase(w: Work, id: ActorId): void {
  const enemy = w.enemies.find((e) => e.id === id);
  if (!enemy?.phaseTwo || enemy.phase !== 1 || !isAlive(enemy)) return;
  if (enemy.hp > enemy.maxHp * enemy.phaseTwo.hpFraction) return;
  w.enemies = w.enemies.map((e) =>
    e.id === id ? { ...e, phase: 2 as const, moves: enemy.phaseTwo?.moves ?? e.moves } : e,
  );
  w.events.push({ type: 'enemy-phase', enemyId: id, phase: 2 });
}

/** Records a death and settles the outcome. */
function checkDeath(w: Work, id: ActorId): void {
  if (isAlive(fighter(w, id))) {
    if (id !== PLAYER_ID) checkPhase(w, id);
    return;
  }
  if (id === PLAYER_ID) {
    finish(w, 'lost');
    return;
  }
  w.enemies = w.enemies.map((e) => (e.id === id ? { ...e, intent: null } : e));
  w.events.push({ type: 'enemy-died', enemyId: id });
  if (!w.enemies.some(isAlive)) finish(w, 'won');
}

function finish(w: Work, outcome: 'won' | 'lost'): void {
  w.outcome = outcome;
  w.phase = 'over';
  w.events.push({ type: outcome === 'won' ? 'combat-won' : 'combat-lost' });
}

function setSteam(w: Work, to: number): void {
  const from = w.player.steam;
  w.player = { ...w.player, steam: to };
  w.events.push({ type: 'steam-changed', from, to });
}

function gainBlock(w: Work, id: ActorId, raw: number): void {
  const recipient = fighter(w, id);
  const amount = stacks(recipient.statuses, 'rust') > 0 ? Math.floor(raw / 2) : raw;
  update(w, id, { block: recipient.block + amount });
  w.events.push({ type: 'block-gained', target: id, amount });
}

function clearBlock(w: Work, id: ActorId): void {
  const amount = fighter(w, id).block;
  if (amount === 0) return;
  update(w, id, { block: 0 });
  w.events.push({ type: 'block-cleared', target: id, amount });
}

function tickStatus(w: Work, id: ActorId, status: StatusId): void {
  const from = stacks(fighter(w, id).statuses, status);
  if (from === 0) return;
  const statuses = withStacks(fighter(w, id).statuses, status, -1);
  update(w, id, { statuses });
  w.events.push({ type: 'status-ticked', target: id, status, from, to: stacks(statuses, status) });
}

/** Overheat at the start of the owner's turn: lose HP equal to stacks (ignores block), then decay 1. */
function overheatTick(w: Work, id: ActorId): void {
  const heat = stacks(fighter(w, id).statuses, 'overheat');
  if (heat === 0) return;
  const hpLost = Math.min(heat, fighter(w, id).hp);
  update(w, id, { hp: fighter(w, id).hp - hpLost });
  w.events.push({
    type: 'damage-dealt',
    source: null,
    target: id,
    kind: 'overheat',
    amount: heat,
    blocked: 0,
    hpLost,
  });
  tickStatus(w, id, 'overheat');
  checkDeath(w, id);
}

function decayAtTurnEnd(w: Work, id: ActorId): void {
  for (const status of DECAYS_AT_TURN_END) tickStatus(w, id, status);
}

function drawCards(w: Work, count: number): void {
  for (let i = 0; i < count && w.hand.length < MAX_HAND; i++) {
    if (w.draw.length === 0) {
      if (w.discard.length === 0) return;
      w.draw = w.deck.shuffle(w.discard);
      w.discard = [];
      w.events.push({ type: 'reshuffled', count: w.draw.length });
    }
    const card = w.draw.shift() as CombatCard;
    w.hand.push(card);
    w.events.push({ type: 'card-drawn', uid: card.uid, cardId: card.def.id });
  }
}

function chooseIntent(w: Work, enemy: EnemyState): EnemyState {
  const forced = enemy.intent?.followUp;
  let intent = forced ? enemy.moves.find((move) => move.id === forced) : undefined;
  if (!intent) {
    const total = enemy.moves.reduce((sum, m) => sum + (m.weight ?? 1), 0);
    let roll = w.ai.int(1, total);
    intent = enemy.moves.find((move) => {
      roll -= move.weight ?? 1;
      return roll <= 0;
    });
  }
  if (!intent) throw new RulesError(`No intent for ${enemy.id}`);
  w.events.push({
    type: 'enemy-intent',
    enemyId: enemy.id,
    moveId: intent.id,
    intent: intent.intent,
  });
  return { ...enemy, intent };
}

function opponents(w: Work, actor: ActorId): ActorId[] {
  if (actor !== PLAYER_ID) return [PLAYER_ID];
  return w.enemies.filter(isAlive).map((e) => e.id);
}

function targetsOf(
  w: Work,
  actor: ActorId,
  target: EffectTarget,
  chosen: ActorId | null,
): ActorId[] {
  if (target === 'self') return [actor];
  if (target === 'all-opponents') return opponents(w, actor);
  if (target === 'other-opponents') return opponents(w, actor).filter((id) => id !== chosen);
  return chosen === null ? [] : [chosen];
}

function dealHit(w: Work, source: ActorId, target: ActorId, base: number): void {
  const defender = fighter(w, target);
  if (!isAlive(defender)) return;
  const amount = attackDamage(base, fighter(w, source), defender);
  const { blocked, hpLost } = absorb(amount, defender.block);
  const hp = Math.max(0, defender.hp - hpLost);
  update(w, target, { block: defender.block - blocked, hp });
  w.events.push({
    type: 'damage-dealt',
    source,
    target,
    kind: 'attack',
    amount,
    blocked,
    hpLost: defender.hp - hp,
  });
  checkDeath(w, target);
}

function heal(w: Work, target: ActorId, raw: number): void {
  const fighterState = fighter(w, target);
  const amount = Math.min(Math.max(0, raw), fighterState.maxHp - fighterState.hp);
  if (amount <= 0) return;
  update(w, target, { hp: fighterState.hp + amount });
  w.events.push({ type: 'healed', target, amount });
}

/**
 * Resolves effects in order from `actor`'s point of view. `chosen` is the card's target (or the player
 * for an enemy move). Stops as soon as the combat is decided; effects aimed at a dead fighter do nothing.
 */
function resolveEffects(
  w: Work,
  actor: ActorId,
  effects: readonly Effect[],
  chosen: ActorId | null,
  dice: number | null,
  steamSpent = 0,
): void {
  const aimedIntent = w.enemies.find((enemy) => enemy.id === chosen)?.intent;
  for (const effect of effects) {
    if (isOver(w) || !isAlive(fighter(w, actor))) return;
    switch (effect.type) {
      case 'damage': {
        const base = hitAmount(effect, fighter(w, actor).block, dice, steamSpent);
        if (base === 0 && typeof effect.amount !== 'number' && 'perSteam' in effect.amount) break;
        const targetRust =
          effect.extraHitsIfTargetRust && chosen !== null
            ? stacks(fighter(w, chosen).statuses, 'rust') > 0
            : false;
        const hits = (effect.hits ?? 1) + (targetRust ? (effect.extraHitsIfTargetRust ?? 0) : 0);
        for (let hit = 0; hit < hits && !isOver(w); hit++) {
          for (const target of targetsOf(w, actor, effect.target, chosen)) {
            if (!isOver(w)) dealHit(w, actor, target, base);
          }
        }
        break;
      }
      case 'heal':
        heal(w, actor, resolveAmount(effect.amount, dice, steamSpent));
        break;
      case 'block': {
        const amount = resolveAmount(effect.amount, dice, steamSpent);
        if (amount === 0 && typeof effect.amount !== 'number' && 'perSteam' in effect.amount) break;
        gainBlock(w, actor, amount);
        break;
      }
      case 'gain-steam':
        setSteam(w, w.player.steam + resolveAmount(effect.amount, dice, steamSpent));
        break;
      case 'lose-steam':
        setSteam(w, Math.max(0, w.player.steam - resolveAmount(effect.amount, dice, steamSpent)));
        break;
      case 'apply-status': {
        const count = resolveAmount(effect.stacks, dice, steamSpent);
        if (count === 0) break;
        for (const target of targetsOf(w, actor, effect.target, chosen)) {
          const current = fighter(w, target);
          if (!isAlive(current)) continue;
          const statuses = withStacks(current.statuses, effect.status, count);
          update(w, target, { statuses });
          w.events.push({
            type: 'status-applied',
            target,
            status: effect.status,
            stacks: count,
            total: stacks(statuses, effect.status),
          });
        }
        break;
      }
      case 'block-from-status': {
        const source = effect.removeFrom === 'target' ? chosen : actor;
        if (!source) throw new RulesError('A heat transfer requires a target');
        const owner = fighter(w, source);
        const before = stacks(owner.statuses, effect.status);
        const removed = Math.min(effect.maxStacks, before);
        if (removed > 0) {
          update(w, source, { statuses: withStacks(owner.statuses, effect.status, -removed) });
          w.events.push({
            type: 'status-ticked',
            target: source,
            status: effect.status,
            from: before,
            to: before - removed,
          });
        }
        const raw = effect.base + removed * effect.perStack;
        const scaled =
          effect.multiplier === undefined
            ? raw
            : Math.max(0, Math.floor(raw * effect.multiplier + 0.5 + 1e-9));
        gainBlock(w, actor, scaled);
        break;
      }
      case 'conditional-block': {
        const hits =
          aimedIntent?.effects.reduce((n, e) => n + (e.type === 'damage' ? (e.hits ?? 1) : 0), 0) ??
          0;
        if (hits < effect.minTargetHits) break;
        gainBlock(w, actor, resolveAmount(effect.amount, dice, steamSpent));
        break;
      }
      case 'damage-from-block':
        if (chosen && fighter(w, actor).block > 0)
          dealHit(w, actor, chosen, fighter(w, actor).block);
        break;
      case 'draw':
        drawCards(w, resolveAmount(effect.amount, dice, steamSpent));
        break;
      case 'scry':
        throw new RulesError('Scry must finish a player card');
      case 'load-die':
        w.loadedDie = true;
        break;
      case 'allow-reroll':
        w.rerollDie = true;
        break;
    }
  }
}

function startTurn(w: Work): void {
  w.turn += 1;
  w.phase = 'player';
  w.events.push({ type: 'turn-started', turn: w.turn });
  clearBlock(w, PLAYER_ID);
  overheatTick(w, PLAYER_ID);
  if (isOver(w)) return;
  const plating = stacks(w.player.statuses, 'plating');
  if (plating > 0) {
    gainBlock(w, PLAYER_ID, plating);
    tickStatus(w, PLAYER_ID, 'plating');
  }
  setSteam(w, STEAM_PER_TURN);
  triggerMechanisms(w, 'start-turn');
  if (isOver(w)) return;
  drawCards(w, DRAW_PER_TURN);
}

function playCard(w: Work, action: PlayCard): void {
  const index = w.hand.findIndex((c) => c.uid === action.uid);
  const [card] = w.hand.splice(index, 1) as [CombatCard];
  const { def } = card;
  const echo = def.echoSigil ? w.lastSuccessfulSigil : undefined;
  const effects = echo?.effects ?? def.effects;
  const dice = (echo ? echo.dice : action.dice) ?? null;
  const target = action.target ?? null;
  const steamSpent = cardSteamCost(def.cost, w.player.steam);
  if (steamSpent > 0) setSteam(w, w.player.steam - steamSpent);
  w.events.push({
    type: 'card-played',
    uid: card.uid,
    cardId: def.id,
    target,
    dice,
    ...(echo && { echoedCardId: echo.cardId }),
    ...(def.cost === 'X' ? { steamSpent } : {}),
  });
  if (def.mechanism) {
    const replaced = w.mechanisms.length >= 3 ? w.mechanisms[0] : undefined;
    if (replaced) {
      w.mechanisms = w.mechanisms.slice(1);
      w.exhaust.push(replaced);
      w.events.push({ type: 'card-exhausted', uid: replaced.uid, cardId: replaced.def.id });
    }
    w.mechanisms.push(card);
    w.events.push({
      type: 'mechanism-installed',
      uid: card.uid,
      cardId: def.id,
      ...(replaced ? { replacedUid: replaced.uid } : {}),
    });
    return;
  }
  const last = effects.at(-1);
  if (last?.type === 'scry') {
    resolveEffects(w, PLAYER_ID, effects.slice(0, -1), target, dice, steamSpent);
    if (!isOver(w)) {
      const count = Math.min(last.count, w.draw.length);
      const drawAfter = last.drawAfter ?? 0;
      if (count > 0) {
        w.scry = { count, drawAfter, card };
        w.phase = 'scry';
        w.events.push({ type: 'scry-ready', count });
        return;
      }
      drawCards(w, drawAfter);
    }
  } else resolveEffects(w, PLAYER_ID, effects, target, dice, steamSpent);
  settlePlayedCard(w, card);
}

function settlePlayedCard(w: Work, card: CombatCard): void {
  const { def } = card;
  if (def.exhaust) {
    w.exhaust.push(card);
    w.events.push({ type: 'card-exhausted', uid: card.uid, cardId: def.id });
  } else {
    w.discard.push(card);
    w.events.push({ type: 'card-discarded', uid: card.uid, cardId: def.id });
  }
}

function resolveScry(w: Work, discard: readonly number[]): void {
  const pending = w.scry;
  if (!pending) throw new RulesError('No Scry choice is open');
  const chosen = new Set(discard);
  const revealed = w.draw.splice(0, pending.count);
  w.draw.unshift(...revealed.filter((card) => !chosen.has(card.uid)));
  for (const card of revealed) {
    if (!chosen.has(card.uid)) continue;
    w.discard.push(card);
    w.events.push({ type: 'card-discarded', uid: card.uid, cardId: card.def.id });
  }
  w.scry = undefined;
  w.phase = 'player';
  w.events.push({ type: 'scry-finished', discarded: chosen.size });
  drawCards(w, pending.drawAfter);
  settlePlayedCard(w, pending.card);
}

function endTurn(w: Work): void {
  for (const card of w.hand) {
    if (card.def.pinned) continue;
    w.discard.push(card);
    w.events.push({ type: 'card-discarded', uid: card.uid, cardId: card.def.id });
  }
  w.hand = w.hand.filter((card) => card.def.pinned);
  decayAtTurnEnd(w, PLAYER_ID);
  w.loadedDie = false;
  triggerMechanisms(w, 'end-turn');
  if (isOver(w)) return;
  w.events.push({ type: 'turn-ended', turn: w.turn });
  w.phase = 'enemy';
}

function triggerMechanisms(w: Work, timing: 'start-turn' | 'end-turn'): void {
  for (const card of w.mechanisms) {
    const mechanism = card.def.mechanism;
    if (!mechanism || mechanism.timing !== timing || isOver(w)) continue;
    const target = mechanism.target === 'least-hp' ? leastHpEnemy(w) : null;
    w.events.push({
      type: 'mechanism-triggered',
      uid: card.uid,
      cardId: card.def.id,
      timing,
      target,
    });
    resolveEffects(w, PLAYER_ID, mechanism.effects, target, null);
    w.events.push({ type: 'mechanism-finished', uid: card.uid });
  }
}

function leastHpEnemy(w: Work): string | null {
  let selected: EnemyState | undefined;
  for (const enemy of w.enemies) {
    if (!isAlive(enemy) || (selected && enemy.hp >= selected.hp)) continue;
    selected = enemy;
  }
  return selected?.id ?? null;
}

/** Each living enemy in order: clear block, Overheat tick, act on its intent, decay, pick next intent. */
function enemyAct(w: Work): void {
  for (const { id } of w.enemies) {
    if (isOver(w)) return;
    const enemy = fighter(w, id) as EnemyState;
    if (!isAlive(enemy) || !enemy.intent) continue;
    clearBlock(w, id);
    overheatTick(w, id);
    if (isOver(w) || !isAlive(fighter(w, id))) continue;
    const move = enemy.intent;
    w.events.push({ type: 'enemy-acted', enemyId: id, moveId: move.id });
    resolveEffects(w, id, move.effects, PLAYER_ID, null);
    if (isOver(w)) return;
    decayAtTurnEnd(w, id);
    w.enemies = w.enemies.map((e) => (e.id === id ? chooseIntent(w, e) : e));
  }
  if (!isOver(w)) w.phase = 'awaiting-turn';
}
