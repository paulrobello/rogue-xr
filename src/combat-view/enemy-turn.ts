import {
  type CombatEvent,
  type CombatState,
  type EnemyState,
  PLAYER_ID,
  type PlayerState,
} from '../rules/index.ts';

/**
 * Splitting a rules event batch into the beats the enemy phase plays one at a time. The rules
 * resolve every enemy at once (`enemy-act`); this only decides what the view shows when, so the
 * outcome cannot differ from the unsequenced resolution. No three.js here.
 */

/** One enemy's turn: its lead-in (block clearing, an Overheat tick) and the move it acts on. */
export interface EnemyBeat {
  readonly kind: 'enemy';
  readonly enemyId: string;
  /** Events before the enemy acts: its block clearing and its Overheat tick (which may kill it). */
  readonly lead: readonly CombatEvent[];
  /** `enemy-acted`, every effect of the move, its decay ticks and its next intent. Empty when it never acted. */
  readonly act: readonly CombatEvent[];
  /** The move it acted on, or null when it did not act. */
  readonly moveId: string | null;
  /** True when the move dealt damage to the player (it swings or lunges rather than braces). */
  readonly attacks: boolean;
}

/** Events shown at once: player turns, card plays, the next turn's draw. */
export interface InstantSegment {
  readonly kind: 'instant';
  readonly events: readonly CombatEvent[];
}

export type TurnSegment = InstantSegment | EnemyBeat;

/** The enemy an event belongs to, or null for player and turn bookkeeping events. */
export function eventOwner(event: CombatEvent): string | null {
  switch (event.type) {
    case 'enemy-acted':
    case 'enemy-intent':
    case 'enemy-phase':
    case 'enemy-died':
      return event.enemyId;
    case 'healed':
    case 'block-gained':
    case 'block-cleared':
    case 'status-applied':
    case 'status-ticked':
      return event.target === PLAYER_ID ? null : event.target;
    case 'damage-dealt':
      if (event.source !== null && event.source !== PLAYER_ID) return event.source;
      return event.target === PLAYER_ID ? null : event.target;
    default:
      return null;
  }
}

interface BeatDraft {
  enemyId: string;
  lead: CombatEvent[];
  act: CombatEvent[];
  moveId: string | null;
  attacks: boolean;
}

/**
 * Cuts `events` into segments in rules order: everything outside an enemy phase is instant, and
 * every enemy that did anything between `turn-ended` and the next `turn-started` (or the end of
 * the fight) gets its own beat. Concatenating the segments' events gives `events` back unchanged.
 */
export function segmentEvents(events: readonly CombatEvent[]): TurnSegment[] {
  const out: TurnSegment[] = [];
  let instant: CombatEvent[] = [];
  // A holder, so the flush helper's reset is visible to the loop's narrowing.
  const open: { beat: BeatDraft | null } = { beat: null };
  let enemyPhase = false;
  const flushInstant = (): void => {
    if (instant.length > 0) out.push({ kind: 'instant', events: instant });
    instant = [];
  };
  const flushBeat = (): void => {
    if (open.beat) out.push({ kind: 'enemy', ...open.beat });
    open.beat = null;
  };
  for (const event of events) {
    if (event.type === 'turn-started') {
      flushBeat();
      enemyPhase = false;
    }
    if (!enemyPhase) {
      instant.push(event);
      if (event.type === 'turn-ended') {
        enemyPhase = true;
        flushInstant();
      }
      continue;
    }
    const owner = eventOwner(event);
    if (owner !== null && owner !== open.beat?.enemyId) {
      flushBeat();
      open.beat = { enemyId: owner, lead: [], act: [], moveId: null, attacks: false };
    }
    const beat = open.beat;
    if (!beat) {
      // Nothing to own it yet (no enemy acted): show it with the turn's end.
      out.push({ kind: 'instant', events: [event] });
      continue;
    }
    if (event.type === 'enemy-acted') beat.moveId = event.moveId;
    if (beat.moveId === null) beat.lead.push(event);
    else beat.act.push(event);
    if (
      beat.moveId !== null &&
      event.type === 'damage-dealt' &&
      event.target === PLAYER_ID &&
      event.source === beat.enemyId
    )
      beat.attacks = true;
  }
  flushBeat();
  flushInstant();
  return out;
}

const withStatus = (
  statuses: EnemyState['statuses'],
  status: keyof EnemyState['statuses'],
  value: number,
): EnemyState['statuses'] => {
  const out: Partial<Record<keyof EnemyState['statuses'], number>> = { ...statuses };
  if (value > 0) out[status] = value;
  else delete out[status];
  return out;
};

/**
 * Plays `events` onto a display copy of `state`: hit points, block, statuses, intents, steam,
 * turn and outcome. Piles are left alone (the view decides what hand to show). Folding a batch
 * onto the state before it gives the fighters of the state after it.
 */
export function foldEvents(state: CombatState, events: readonly CombatEvent[]): CombatState {
  let player: PlayerState = state.player;
  let enemies: readonly EnemyState[] = state.enemies;
  let { turn, outcome } = state;
  const patch = (id: string, f: (fighter: PlayerState | EnemyState) => object): void => {
    if (id === PLAYER_ID) player = { ...player, ...f(player) };
    else enemies = enemies.map((e) => (e.id === id ? { ...e, ...f(e) } : e));
  };
  for (const event of events) {
    switch (event.type) {
      case 'damage-dealt':
        patch(event.target, (f) => ({
          hp: Math.max(0, f.hp - event.hpLost),
          block: Math.max(0, f.block - event.blocked),
        }));
        break;
      case 'healed':
        patch(event.target, (f) => ({ hp: Math.min(f.maxHp, f.hp + event.amount) }));
        break;
      case 'block-gained':
        patch(event.target, (f) => ({ block: f.block + event.amount }));
        break;
      case 'block-cleared':
        patch(event.target, (f) => ({ block: Math.max(0, f.block - event.amount) }));
        break;
      case 'status-applied':
        patch(event.target, (f) => ({
          statuses: withStatus(f.statuses, event.status, event.total),
        }));
        break;
      case 'status-ticked':
        patch(event.target, (f) => ({ statuses: withStatus(f.statuses, event.status, event.to) }));
        break;
      case 'enemy-intent':
        enemies = enemies.map((e) =>
          e.id === event.enemyId
            ? { ...e, intent: e.moves.find((m) => m.id === event.moveId) ?? null }
            : e,
        );
        break;
      case 'enemy-phase':
        enemies = enemies.map((e) =>
          e.id === event.enemyId && e.phaseTwo
            ? { ...e, phase: event.phase, moves: e.phaseTwo.moves }
            : e,
        );
        break;
      case 'enemy-died':
        enemies = enemies.map((e) => (e.id === event.enemyId ? { ...e, intent: null } : e));
        break;
      case 'steam-changed':
        player = { ...player, steam: event.to };
        break;
      case 'turn-started':
        turn = event.turn;
        break;
      case 'combat-won':
        outcome = 'won';
        break;
      case 'combat-lost':
        outcome = 'lost';
        break;
    }
  }
  return { ...state, player, enemies, turn, outcome };
}

/** What landed on the player in one batch: a clean hit, a full block, or a partial block. */
export interface PlayerHit {
  readonly kind: 'hit' | 'blocked' | 'partial';
  /** Damage after modifiers, before block. */
  readonly amount: number;
  readonly blocked: number;
  readonly hpLost: number;
}

/** Sums the damage dealt to the player in `events`; null when nothing (or only 0 damage) landed. */
export function playerHit(events: readonly CombatEvent[]): PlayerHit | null {
  let amount = 0;
  let blocked = 0;
  let hpLost = 0;
  for (const e of events) {
    if (e.type !== 'damage-dealt' || e.target !== PLAYER_ID) continue;
    amount += e.amount;
    blocked += e.blocked;
    hpLost += e.hpLost;
  }
  if (hpLost === 0 && blocked === 0) return null;
  const kind = hpLost === 0 ? 'blocked' : blocked > 0 ? 'partial' : 'hit';
  return { kind, amount, blocked, hpLost };
}
