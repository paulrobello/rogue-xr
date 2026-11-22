import { chooseEncounter, fightSeed } from '../../src/combat/encounter-choice.ts';
import { deckDefs, getCard, STARTER_DECK } from '../../src/content/cards.ts';
import { dieById } from '../../src/content/dice.ts';
import { encounterSetups } from '../../src/content/enemies.ts';
import { REWARD_POOL } from '../../src/content/rewards.ts';
import { RunRng, Stream } from '../../src/core/rng.ts';
import { generateFloor, type PlacedRoom } from '../../src/floor/generate.ts';
import { rollDice } from '../../src/rules/dice.ts';
import { type Difficulty, difficultyMaxHp } from '../../src/rules/difficulty.ts';
import {
  apply,
  cardSteamCost,
  intentDamage,
  isAlive,
  startCombat,
} from '../../src/rules/engine.ts';
import {
  chooseReward,
  createRun,
  HEARTH_HEAL_FRACTION,
  hearthHeal,
  lootKey,
  openTreasure,
  type RunState,
  rewardOffer,
  useHearth,
} from '../../src/rules/run.ts';
import { playCardWithSigil } from '../../src/rules/sigil.ts';
import { stacks } from '../../src/rules/statuses.ts';
import type { CombatCard, CombatState } from '../../src/rules/types.ts';
import { createWorkshop, runOptionsFrom } from '../../src/rules/workshop.ts';
import {
  DEFAULT_SIGIL_LEVEL,
  DISTANCE_AT_ZERO_BY_LEVEL,
  distanceToScore,
  FLOOR,
  MAX,
  MIN_SCORE,
  PERFECT_SCORE,
  scoreToMultiplier,
} from '../../src/sigil/index.ts';

/**
 * A full-run balance simulation through the pure rules, for a scripted player who is not perfect.
 *
 * The run is the game's own: `createRun` with a fresh workshop and the level's max hp, the floor from
 * `generateFloor`, each room's encounter from `chooseEncounter` and its fight seed from `fightSeed`
 * (so a seed meets the same enemies, shuffles and rolls as in the game), rewards, treasure and
 * hearths through rules/run.ts, guardian phase 2 inside the engine.
 *
 * The player (the policy):
 * - Route: every room in order of depth from the entry (then room index), fighting every encounter
 *   including elites, opening every coffer when it reaches it; the guardian vault last.
 * - Hearth: used on arrival when the full heal fits under max hp, otherwise saved for just before
 *   the guardian.
 * - Reward: always takes a card, the first of the offer in `REWARD_PREFERENCE`.
 * - Turn: greedy one card at a time. Each playable card (and each target) is tried on a copy of the
 *   state with the die at its mean, and the one that most improves `stateValue` net of its steam is
 *   played, until nothing helps. Dice cards then roll for real (`1 + bonusDice` dice, best kept).
 * - Sigils: every sigil card casts at `sigilMultiplier` (the hand's trace quality on this level).
 * - Misses: before each play the `miss` stream decides, with probability `missRate`, that this card is
 *   not played this turn (a fling that missed, a card forgotten). A miss costs no steam.
 *
 * The miss stream is `Stream.fromKey(<seed>:balance-miss)`, separate from the run's five streams, so
 * changing the miss rate never shifts the deck, dice, ai or loot draws.
 */
export interface SimOptions {
  readonly level: Difficulty;
  /** Power multiplier every sigil cast gets, 0.5..1.25. */
  readonly sigilMultiplier: number;
  /** Chance, 0..1, that the card the policy picks is not played this turn. */
  readonly missRate?: number;
  /** Called after each fight, for inspecting a run. */
  readonly onFight?: (fight: FightLog) => void;
}

export interface FightLog {
  readonly room: number;
  readonly enemies: readonly string[];
  readonly hpBefore: number;
  readonly hpAfter: number;
  readonly turns: number;
}

export interface RunOutcome {
  readonly seed: string;
  readonly won: boolean;
  /** Fights won, the guardian included. */
  readonly fightsWon: number;
  /** The tier of the fight that ended the run, or null for a win. */
  readonly diedTo: 'regular' | 'elite' | 'guardian' | null;
  /** Hp left at the end (0 on a loss). */
  readonly hp: number;
}

/** A fight that reaches this many player turns counts as lost. */
export const TURN_CAP = 60;

/** Reward pick order, strongest first. Ids not listed rank after every listed one. */
export const REWARD_PREFERENCE: readonly string[] = [
  'escapement-hammer',
  'cogstorm',
  'arc-bolt',
  'ratchet-flurry',
  'overwind',
  'rivet-volley',
  'furnace-brand',
  'spanner-jam',
  'time-spiral',
  'lucky-rivets',
  'cog-toss',
  'warding-glyph',
  'release-valve',
];

/** Hp the player expects to lose is worth this much more than enemy hp removed. */
const INCOMING_WEIGHT = 1.2;
/** Value of one steam kept: a card must beat it to be worth its cost. */
const STEAM_VALUE = 2;
/** Value of a card drawn. */
const DRAW_VALUE = 2;
const STATUS_VALUE = { vulnerable: 3, weak: 2, overheat: 1.5, woundUp: 4 } as const;

/**
 * The multiplier a hand earns on `level`: `casualMultiplier` is what its traces earn on Casual
 * (0.5..1.25); the trace distance that earns it is judged again at the level's tolerance. A Casual
 * fizzle (0.5) is taken as a trace right at MIN_SCORE on Casual.
 */
export function handMultiplier(casualMultiplier: number, level: Difficulty): number {
  const t = Math.min(1, Math.max(0, (casualMultiplier - FLOOR) / (MAX - FLOOR)));
  const casualScore = MIN_SCORE + t * (PERFECT_SCORE - MIN_SCORE);
  const distance = (1 - casualScore) * DISTANCE_AT_ZERO_BY_LEVEL[DEFAULT_SIGIL_LEVEL];
  return scoreToMultiplier(distanceToScore(distance, level));
}

function meanDie(id: Parameters<typeof dieById>[0]): number {
  const { faces } = dieById(id);
  return Math.floor(faces.reduce((a, b) => a + b, 0) / faces.length);
}

/** How good `state` is for the player, before the enemies act. */
function stateValue(state: CombatState): number {
  let value = 0;
  let incoming = 0;
  for (const enemy of state.enemies) {
    if (!isAlive(enemy)) continue;
    value -= enemy.hp + enemy.block;
    value += STATUS_VALUE.vulnerable * Math.min(2, stacks(enemy.statuses, 'vulnerable'));
    value += STATUS_VALUE.weak * Math.min(2, stacks(enemy.statuses, 'weak'));
    value += STATUS_VALUE.overheat * stacks(enemy.statuses, 'overheat');
    incoming += intentDamage(state, enemy.id).reduce((a, b) => a + b, 0);
  }
  const { player } = state;
  value -= INCOMING_WEIGHT * Math.max(0, incoming - player.block);
  value -= stacks(player.statuses, 'overheat');
  value += STATUS_VALUE.woundUp * stacks(player.statuses, 'wound-up');
  if (state.outcome === 'won') value += 1000;
  return value;
}

interface Play {
  readonly card: CombatCard;
  readonly target: string | undefined;
}

function playOn(
  state: CombatState,
  play: Play,
  dice: number | undefined,
  multiplier: number,
): CombatState {
  const action = {
    type: 'play-card' as const,
    uid: play.card.uid,
    ...(play.target === undefined ? {} : { target: play.target }),
    ...(dice === undefined ? {} : { dice }),
  };
  const info = getCard(play.card.def.id);
  const played =
    info.sigil === undefined
      ? apply(state, action).state
      : playCardWithSigil(state, action, multiplier).state;
  // The simulator has no hidden-information discard heuristic. Keep every revealed card on top of
  // the draw pile so planning and real play both resume the player phase deterministically.
  return played.scry === undefined
    ? played
    : apply(played, { type: 'resolve-scry', discard: [] }).state;
}

function candidates(state: CombatState, skipped: ReadonlySet<number>): Play[] {
  const living = state.enemies.filter(isAlive).map((e) => e.id);
  return state.piles.hand.flatMap((card): Play[] => {
    if (
      skipped.has(card.uid) ||
      (card.def.echoSigil && !state.lastSuccessfulSigil) ||
      cardSteamCost(card.def.cost, state.player.steam) > state.player.steam
    )
      return [];
    return card.def.target === 'enemy'
      ? living.map((target) => ({ card, target }))
      : [{ card, target: undefined }];
  });
}

function bestPlay(
  state: CombatState,
  skipped: ReadonlySet<number>,
  multiplier: number,
): Play | null {
  const before = stateValue(state);
  let best: Play | null = null;
  let bestGain = 0;
  for (const play of candidates(state, skipped)) {
    const info = getCard(play.card.def.id);
    const dice = info.dice === undefined ? undefined : meanDie(info.dice);
    const after = playOn(state, play, dice, multiplier);
    const drawn = after.piles.hand.length - state.piles.hand.length + 1;
    const gain =
      stateValue(after) -
      before +
      DRAW_VALUE * drawn +
      STEAM_VALUE * (after.player.steam - state.player.steam);
    if (gain > bestGain) {
      best = play;
      bestGain = gain;
    }
  }
  return best;
}

/** One player turn: greedy plays until nothing helps, then end turn and let the enemies act. */
function playTurn(
  start: CombatState,
  bonusDice: number,
  opts: SimOptions,
  miss: Stream,
): CombatState {
  let state = start;
  const skipped = new Set<number>();
  for (;;) {
    if (state.outcome !== null) return state;
    const play = bestPlay(state, skipped, opts.sigilMultiplier);
    if (!play) break;
    if ((opts.missRate ?? 0) > 0 && miss.next() < (opts.missRate ?? 0)) {
      skipped.add(play.card.uid);
      continue;
    }
    const info = getCard(play.card.def.id);
    let dice: number | undefined;
    if (info.dice !== undefined) {
      const die = dieById(info.dice);
      let rolled = Number.NEGATIVE_INFINITY;
      for (let n = 0; n <= bonusDice; n++) {
        const r = rollDice(state, die);
        state = r.state;
        rolled = Math.max(rolled, r.roll.value);
      }
      dice = rolled;
    }
    state = playOn(state, play, dice, opts.sigilMultiplier);
  }
  state = apply(state, { type: 'end-turn' }).state;
  if (state.phase === 'enemy') state = apply(state, { type: 'enemy-act' }).state;
  return state;
}

/** Plays one room's fight to the end. Returns the player's hp afterwards (0 on a loss). */
function fight(run: RunState, room: PlacedRoom, opts: SimOptions, miss: Stream): number {
  const tier = room.encounter?.tier ?? 'regular';
  const encounter = chooseEncounter(
    run.seed,
    room.index,
    tier,
    room.encounter?.socketIds.length ?? 1,
  );
  let state = startCombat({
    player: { hp: run.hp, maxHp: run.maxHp },
    deck: deckDefs(run.deck),
    enemies: encounterSetups(encounter, opts.level),
    rng: new RunRng(fightSeed(run.seed, room.index)).snapshot(),
  }).state;
  for (let turn = 0; turn < TURN_CAP && state.outcome === null; turn++) {
    state = apply(state, { type: 'start-turn' }).state;
    state = playTurn(state, run.bonusDice ?? 0, opts, miss);
  }
  const hp = state.outcome === 'won' ? state.player.hp : 0;
  opts.onFight?.({
    room: room.index,
    enemies: encounter.enemies,
    hpBefore: run.hp,
    hpAfter: hp,
    turns: state.turn,
  });
  return hp;
}

function pickReward(cards: readonly string[]): string {
  const rank = (id: string): number => {
    const at = REWARD_PREFERENCE.indexOf(id);
    return at < 0 ? REWARD_PREFERENCE.length : at;
  };
  return [...cards].sort((a, b) => rank(a) - rank(b))[0] as string;
}

function hearthAt(run: RunState, room: number): RunState {
  return useHearth(run, lootKey(room, 'hearth'))?.run ?? run;
}

function openLoot(run: RunState, room: PlacedRoom): RunState {
  let next = run;
  for (const loot of room.loot) {
    next =
      openTreasure(next, lootKey(room.index, loot.socketId), loot.kind, REWARD_POOL)?.run ?? next;
  }
  return next;
}

/** Plays one full run on `seed`. Deterministic: the same seed and options give the same outcome. */
export function simulateRun(seed: string, opts: SimOptions): RunOutcome {
  const base = runOptionsFrom(createWorkshop());
  let run = createRun(seed, STARTER_DECK, {
    ...base,
    maxHp: difficultyMaxHp(base.maxHp, opts.level),
    difficulty: opts.level,
  });
  const plan = generateFloor(run.seed);
  const miss = Stream.fromKey(`${run.seed}:balance-miss`);
  const route = plan.rooms
    .filter((r) => r.index !== plan.guardianRoom)
    .sort((a, b) => a.depth - b.depth || a.index - b.index);
  const savedHearths: number[] = [];
  let fightsWon = 0;
  for (const room of route) {
    if (room.encounter) {
      const hp = fight(run, room, opts, miss);
      if (hp === 0)
        return { seed: run.seed, won: false, fightsWon, diedTo: room.encounter.tier, hp };
      fightsWon++;
      const rolled = rewardOffer({ ...run, hp }, room.encounter.tier, REWARD_POOL);
      run = chooseReward(rolled.run, rolled.offer, pickReward(rolled.offer.cards));
    }
    run = openLoot(run, room);
    if (room.role === 'rest') {
      const full = Math.floor(run.maxHp * HEARTH_HEAL_FRACTION);
      if (full > 0 && hearthHeal(run) === full) {
        run = hearthAt(run, room.index);
      } else savedHearths.push(room.index);
    }
  }
  for (const index of savedHearths) run = hearthAt(run, index);
  const vault = plan.rooms[plan.guardianRoom] as PlacedRoom;
  run = openLoot(run, vault);
  const hp = fight(run, vault, opts, miss);
  return hp === 0
    ? { seed: run.seed, won: false, fightsWon, diedTo: 'guardian', hp }
    : { seed: run.seed, won: true, fightsWon: fightsWon + 1, diedTo: null, hp };
}

/** `SPIRE001` .. `SPIRE<count>`, the seed set the DIFFICULTY_SCALE numbers are measured on. */
export function spireSeeds(count: number, first = 1): string[] {
  return Array.from({ length: count }, (_, i) => `SPIRE${String(first + i).padStart(3, '0')}`);
}

export interface WinRate {
  readonly runs: number;
  readonly wins: number;
  readonly rate: number;
  readonly diedTo: Readonly<Record<'regular' | 'elite' | 'guardian', number>>;
}

/** Simulates every seed and tallies the wins and where the losses happened. */
export function winRate(seeds: readonly string[], opts: SimOptions): WinRate {
  const diedTo = { regular: 0, elite: 0, guardian: 0 };
  let wins = 0;
  for (const seed of seeds) {
    const out = simulateRun(seed, opts);
    if (out.won) wins++;
    else if (out.diedTo) diedTo[out.diedTo]++;
  }
  return { runs: seeds.length, wins, rate: seeds.length === 0 ? 0 : wins / seeds.length, diedTo };
}
