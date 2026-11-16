import { deckDefs, getCard, STARTER_DECK } from '../../src/content/cards.ts';
import { dieById } from '../../src/content/dice.ts';
import { ENEMIES, type EnemyKind } from '../../src/content/enemies.ts';
import { RunRng } from '../../src/core/rng.ts';
import {
  type Action,
  type ApplyResult,
  apply,
  type CombatEvent,
  type CombatState,
  livingEnemies,
  playCardWithSigil,
  rollDice,
  startCombat,
  validate,
} from '../../src/rules/index.ts';

/** Sigil multiplier every scripted sigil card is cast with. */
export const SIGIL_MULTIPLIER = 1;
/** A fight that is still undecided after this many player turns is recorded as `unfinished`. */
export const TURN_CAP = 30;
export const PLAYER_HP = 70;

export interface GoldenScript {
  readonly enemy: EnemyKind;
  readonly seed: string;
}

/** One scripted fight per enemy, each with its own fixed run seed. */
export const GOLDEN_SCRIPTS: readonly GoldenScript[] = [
  { enemy: 'cog-sentry', seed: 'GOLD0001' },
  { enemy: 'spring-hound', seed: 'GOLD0002' },
  { enemy: 'bellows-golem', seed: 'GOLD0003' },
  { enemy: 'orrery-warden', seed: 'GOLD0004' },
  { enemy: 'grand-escapement', seed: 'GOLD0005' },
];

export const POLICY =
  'Each turn: play the first playable card in hand order, aimed at the living enemy with the lowest hp; ' +
  `dice cards roll their die first; sigil cards cast at multiplier ${SIGIL_MULTIPLIER}; end the turn when no card is playable.`;

export interface GoldenLog {
  readonly enemy: string;
  readonly seed: string;
  readonly playerHp: number;
  readonly deck: readonly string[];
  readonly policy: string;
  readonly turnCap: number;
  readonly events: readonly CombatEvent[];
  readonly final: {
    readonly outcome: 'won' | 'lost' | 'unfinished';
    readonly turns: number;
    readonly playerHp: number;
    readonly enemyHp: Readonly<Record<string, number>>;
    readonly rng: CombatState['rng'];
  };
}

/** The first card in hand order that can be played right now, with its target, or null. */
function pickPlay(state: CombatState): { uid: number; target?: string } | null {
  const target = [...livingEnemies(state)].sort((a, b) => a.hp - b.hp)[0]?.id;
  for (const card of state.piles.hand) {
    const aimed = card.def.target === 'enemy' ? { target } : {};
    // A placeholder dice value lets validate judge cost and target for dice cards too.
    const probe: Action = { type: 'play-card', uid: card.uid, ...aimed, dice: 0 };
    if (validate(state, probe) === null) return { uid: card.uid, ...aimed };
  }
  return null;
}

/** Plays one card: rolls its die first (roll, then pass `dice: roll.value`), casts sigil cards at the fixed multiplier. */
function playOne(state: CombatState, uid: number, target?: string): ApplyResult {
  const card = state.piles.hand.find((c) => c.uid === uid);
  if (!card) throw new Error(`Card ${uid} not in hand`);
  const info = getCard(card.def.id);
  let current = state;
  let dice: number | undefined;
  if (info.dice !== undefined) {
    const rolled = rollDice(current, dieById(info.dice));
    current = rolled.state;
    dice = rolled.roll.value;
  }
  const action = {
    type: 'play-card' as const,
    uid,
    ...(target === undefined ? {} : { target }),
    ...(dice === undefined ? {} : { dice }),
  };
  return info.sigil === undefined
    ? apply(current, action)
    : playCardWithSigil(current, action, SIGIL_MULTIPLIER);
}

/** Runs one scripted fight to a win, a loss or the turn cap and returns its full event log. */
export function runGoldenScript(script: GoldenScript): GoldenLog {
  const events: CombatEvent[] = [];
  const started = startCombat({
    player: { hp: PLAYER_HP, maxHp: PLAYER_HP },
    deck: deckDefs(STARTER_DECK),
    enemies: [ENEMIES[script.enemy]],
    rng: new RunRng(script.seed).snapshot(),
  });
  let state = started.state;
  events.push(...started.events);
  const step = (result: ApplyResult): void => {
    state = result.state;
    events.push(...result.events);
  };

  while (state.outcome === null && state.turn < TURN_CAP) {
    step(apply(state, { type: 'start-turn' }));
    let pick = pickPlay(state);
    while (pick !== null && state.outcome === null) {
      step(playOne(state, pick.uid, pick.target));
      pick = pickPlay(state);
    }
    if (state.outcome !== null) break;
    step(apply(state, { type: 'end-turn' }));
    step(apply(state, { type: 'enemy-act' }));
  }

  return {
    enemy: script.enemy,
    seed: script.seed,
    playerHp: PLAYER_HP,
    deck: STARTER_DECK,
    policy: POLICY,
    turnCap: TURN_CAP,
    events,
    final: {
      outcome: state.outcome ?? 'unfinished',
      turns: state.turn,
      playerHp: state.player.hp,
      enemyHp: Object.fromEntries(state.enemies.map((e) => [e.id, e.hp])),
      rng: state.rng,
    },
  };
}

/**
 * Stable serialization as JSON Lines: a `header` line, one line per event in resolution order, then a
 * `final` line, ending in a newline. One event per line keeps diffs readable, and Biome does not
 * reformat `.jsonl`, so the bytes stay under this function's control.
 */
export function serializeGolden(log: GoldenLog): string {
  const { events, final, ...header } = log;
  const lines = [{ header }, ...events, { final }];
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
}

/** `null` when `actual` equals `expected` byte for byte, else a description of the first difference. */
export function diffGolden(expected: string, actual: string): string | null {
  if (expected === actual) return null;
  const a = expected.split('\n');
  const b = actual.split('\n');
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) {
      return `first difference at line ${i + 1}:\n  golden: ${a[i] ?? '<end of file>'}\n  actual: ${b[i] ?? '<end of file>'}`;
    }
  }
  return 'contents differ';
}
