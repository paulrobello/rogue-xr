// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { foldEvents, segmentEvents } from '../src/combat-view/enemy-turn.ts';
import {
  ENCOUNTERS,
  ENEMIES,
  encounterSetups,
  GUARDIAN_PHASE_TWO_HP_FRACTION,
} from '../src/content/enemies.ts';
import { RunRng } from '../src/core/rng.ts';
import {
  type Action,
  apply,
  type CardDef,
  type CombatEvent,
  type CombatState,
  createIdleState,
  type EnemySetup,
  RulesError,
  startCombat,
  validate,
} from '../src/rules/index.ts';

const GUARDIAN = ENEMIES['grand-escapement'];
const PHASE_TWO = GUARDIAN.phaseTwo?.moves ?? [];
const PHASE_ONE_IDS = ['tick', 'tock', 'pallet', 'mainspring'];
const PHASE_TWO_IDS = [...PHASE_ONE_IDS, 'overwind', 'toll'];
const SEEDS = Array.from({ length: 40 }, (_, i) => `SPIRE${String(i + 1).padStart(3, '0')}`);

/** A free card that deals `amount` to one enemy: every play moves the guardian's hp by exactly that. */
const hits = (amount: number): CardDef[] =>
  Array.from({ length: 10 }, (_, i) => ({
    id: `hit${i}`,
    cost: 0,
    target: 'enemy' as const,
    effects: [{ type: 'damage' as const, amount, target: 'target' as const }],
  }));

const guardianAt = (hp: number, extra: Partial<EnemySetup> = {}): EnemySetup => ({
  ...GUARDIAN,
  hp,
  maxHp: GUARDIAN.hp,
  ...extra,
});

/** Starts a fight and the first player turn. The player cannot die, so only the guardian's hp matters. */
function begin(enemy: EnemySetup, amount = 1, seed = SEEDS[0] as string): CombatState {
  const started = startCombat({
    player: { hp: 1_000_000, maxHp: 1_000_000 },
    deck: hits(amount),
    enemies: [enemy],
    rng: new RunRng(seed).snapshot(),
  }).state;
  return apply(started, { type: 'start-turn' }).state;
}

function run(state: CombatState, actions: Action[]): { state: CombatState; events: CombatEvent[] } {
  const events: CombatEvent[] = [];
  for (const action of actions) {
    const result = apply(state, action);
    state = result.state;
    events.push(...result.events);
  }
  return { state, events };
}

/** Plays the first card in hand on the guardian. */
const strike = (state: CombatState): Action => ({
  type: 'play-card',
  uid: state.piles.hand[0]?.uid as number,
  target: GUARDIAN.id,
});

/** One full round without attacking: end turn, the enemy acts, the next turn starts. */
const ROUND: Action[] = [{ type: 'end-turn' }, { type: 'enemy-act' }, { type: 'start-turn' }];

const phaseEvents = (events: readonly CombatEvent[]) =>
  events.filter((e) => e.type === 'enemy-phase');
const intentIds = (events: readonly CombatEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'enemy-intent' ? [e.moveId] : []));

describe('guardian content', () => {
  it('is the 50 percent default the owner reviews', () => {
    expect(GUARDIAN_PHASE_TWO_HP_FRACTION).toBe(0.5);
    expect(GUARDIAN.phaseTwo?.hpFraction).toBe(0.5);
  });

  it('keeps toll and overwind out of phase 1 and adds exactly them in phase 2', () => {
    expect(GUARDIAN.moves.map((m) => m.id)).toEqual(PHASE_ONE_IDS);
    expect(GUARDIAN.phaseTwo?.moves.map((m) => m.id)).toEqual(PHASE_TWO_IDS);
  });

  it('is the only enemy with a second phase', () => {
    for (const [id, setup] of Object.entries(ENEMIES))
      expect(setup.phaseTwo !== undefined, id).toBe(id === 'grand-escapement');
  });

  it('survives encounterSetups, so the fight the game starts carries it', () => {
    const guardian = ENCOUNTERS.guardian.flatMap((e) => encounterSetups(e));
    expect(guardian).toHaveLength(1);
    expect(guardian[0]?.phaseTwo?.moves).toHaveLength(6);
  });
});

describe('the phase threshold', () => {
  it('starts in phase 1 with the phase-1 list and no phase event', () => {
    const state = begin(guardianAt(160));
    expect(state.enemies[0]?.phase).toBe(1);
    expect(state.enemies[0]?.moves.map((m) => m.id)).toEqual(PHASE_ONE_IDS);
  });

  it('flips exactly at 50 percent of max hp, never above it', () => {
    const above = begin(guardianAt(82));
    const one = run(above, [strike(above)]);
    expect(one.state.enemies[0]?.hp).toBe(81);
    expect(phaseEvents(one.events)).toHaveLength(0);
    expect(one.state.enemies[0]?.phase).toBe(1);

    const two = run(one.state, [strike(one.state)]);
    expect(two.state.enemies[0]?.hp).toBe(80);
    expect(phaseEvents(two.events)).toEqual([
      { type: 'enemy-phase', enemyId: 'grand-escapement', phase: 2 },
    ]);
    expect(two.state.enemies[0]?.phase).toBe(2);
    expect(two.state.enemies[0]?.moves.map((m) => m.id)).toEqual(PHASE_TWO_IDS);
  });

  it('puts the event right after the blow that caused it', () => {
    const state = begin(guardianAt(81));
    const { events } = run(state, [strike(state)]);
    const at = events.findIndex((e) => e.type === 'enemy-phase');
    expect(events[at - 1]).toMatchObject({ type: 'damage-dealt', target: 'grand-escapement' });
  });

  it('happens once: further damage and later rounds add no second event', () => {
    const state = begin(guardianAt(81), 5);
    const first = run(state, [strike(state)]);
    expect(phaseEvents(first.events)).toHaveLength(1);
    const more = run(first.state, [strike(first.state)]);
    expect(phaseEvents(more.events)).toHaveLength(0);
    const rounds = run(first.state, [...ROUND, ...ROUND, ...ROUND]);
    expect(phaseEvents(rounds.events)).toHaveLength(0);
    expect(rounds.state.enemies[0]?.phase).toBe(2);
  });

  it('does not trigger on a blow that kills from above the threshold', () => {
    const state = begin(guardianAt(100), 100);
    const { state: end, events } = run(state, [strike(state)]);
    expect(end.outcome).toBe('won');
    expect(phaseEvents(events)).toHaveLength(0);
  });

  it('triggers on its own Overheat tick, before the enemy acts', () => {
    const state = begin(guardianAt(85, { statuses: { overheat: 10 } }));
    const ended = run(state, [{ type: 'end-turn' }]);
    const acted = apply(ended.state, { type: 'enemy-act' });
    const kinds = acted.events.map((e) => e.type);
    expect(acted.state.enemies[0]?.hp).toBe(75);
    expect(kinds.indexOf('enemy-phase')).toBeGreaterThan(kinds.indexOf('damage-dealt'));
    expect(kinds.indexOf('enemy-phase')).toBeLessThan(kinds.indexOf('enemy-acted'));
    expect(acted.state.enemies[0]?.phase).toBe(2);
    // The next pick (the last event of the round) draws from the phase-2 list.
    expect(PHASE_TWO_IDS).toContain(acted.state.enemies[0]?.intent?.id);
  });

  it('rejects a threshold outside 0 to 1 and an empty phase-2 list', () => {
    const start = (phaseTwo: EnemySetup['phaseTwo']): string | null =>
      validate(createIdleState(), {
        type: 'start-combat',
        player: { hp: 10, maxHp: 10 },
        deck: hits(1),
        enemies: [{ ...GUARDIAN, phaseTwo }],
        rng: new RunRng(SEEDS[0] as string).snapshot(),
      });
    expect(start(GUARDIAN.phaseTwo)).toBeNull();
    expect(start({ hpFraction: 0, moves: PHASE_TWO })).toMatch(/threshold/);
    expect(start({ hpFraction: 1, moves: PHASE_TWO })).toMatch(/threshold/);
    expect(start({ hpFraction: 0.5, moves: [] })).toMatch(/no phase-2 moves/);
    expect(() =>
      startCombat({
        player: { hp: 10, maxHp: 10 },
        deck: hits(1),
        enemies: [{ ...GUARDIAN, phaseTwo: { hpFraction: 2, moves: PHASE_TWO } }],
        rng: new RunRng(SEEDS[0] as string).snapshot(),
      }),
    ).toThrow(RulesError);
  });
});

describe('move lists per phase', () => {
  it('never picks toll or overwind in phase 1', () => {
    for (const seed of SEEDS) {
      const state = begin(guardianAt(160), 1, seed);
      const { events } = run(state, Array.from({ length: 12 }, () => ROUND).flat());
      const ids = intentIds(events);
      expect(ids.length).toBeGreaterThan(10);
      for (const id of ids) expect(PHASE_ONE_IDS, `${seed} picked ${id}`).toContain(id);
    }
  });

  it('keeps the intent already shown when the phase changes, then draws the next from phase 2', () => {
    const afterChange: string[] = [];
    for (const seed of SEEDS) {
      const state = begin(guardianAt(81), 1, seed);
      const shown = state.enemies[0]?.intent;
      const changed = run(state, [strike(state)]);
      // The intent the player already saw is never re-rolled or swapped.
      expect(changed.state.enemies[0]?.intent).toBe(shown);
      expect(intentIds(changed.events)).toEqual([]);
      const round = run(changed.state, [{ type: 'end-turn' }, { type: 'enemy-act' }]);
      const [next] = intentIds(round.events);
      expect(PHASE_TWO_IDS).toContain(next);
      afterChange.push(next as string);
    }
    // Over 40 seeds the first phase-2 pick is toll or overwind at least once (weights 1 and 1 of 10).
    expect(afterChange.some((id) => id === 'toll' || id === 'overwind')).toBe(true);
  });

  it('picks all six moves over a phase-2 fight, and the new two only after the change', () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      const state = begin(guardianAt(81), 1, seed);
      const changed = run(state, [strike(state)]);
      const { events } = run(changed.state, Array.from({ length: 12 }, () => ROUND).flat());
      for (const id of intentIds(events)) seen.add(id);
    }
    expect([...seen].sort()).toEqual([...PHASE_TWO_IDS].sort());
  });

  it('shows the phase-2 list in the intent the player reads from the turn after the change', () => {
    for (const seed of SEEDS) {
      const state = begin(guardianAt(81), 1, seed);
      const changed = run(state, [strike(state)]);
      const turn2 = run(changed.state, ROUND);
      expect(turn2.state.phase).toBe('player');
      expect(PHASE_TWO_IDS).toContain(turn2.state.enemies[0]?.intent?.id);
    }
  });
});

describe('determinism', () => {
  it('replays the same events and state from the same seed', () => {
    const play = (): { state: CombatState; events: CombatEvent[] } => {
      const state = begin(guardianAt(82), 3, SEEDS[7] as string);
      return run(state, [strike(state), ...ROUND, ...ROUND]);
    };
    const a = play();
    const b = play();
    expect(b.events).toEqual(a.events);
    expect(b.state).toEqual(a.state);
    expect(phaseEvents(a.events)).toHaveLength(1);
  });

  it('draws no random number to change phase', () => {
    const state = begin(guardianAt(81));
    const { state: after } = run(state, [strike(state)]);
    expect(after.rng).toEqual(state.rng);
  });

  it('is rules state: the same hp history gives the same phase regardless of seed', () => {
    for (const seed of SEEDS.slice(0, 8)) {
      const state = begin(guardianAt(81), 1, seed);
      expect(run(state, [strike(state)]).state.enemies[0]?.phase).toBe(2);
    }
  });
});

describe('a resumed fight keeps its phase', () => {
  // Combat is not resumable in the game (snapshots exist only at explore and reward boundaries), but
  // the state is plain JSON, so a state that is serialized and revived must carry on identically.
  it('revives a phase-2 state from JSON and plays on exactly as the live one does', () => {
    const state = begin(guardianAt(81), 4, SEEDS[3] as string);
    const changed = run(state, [strike(state)]).state;
    const revived = JSON.parse(JSON.stringify(changed)) as CombatState;
    expect(revived.enemies[0]?.phase).toBe(2);
    expect(revived.enemies[0]?.moves.map((m) => m.id)).toEqual(PHASE_TWO_IDS);
    const script: Action[] = [...ROUND, ...ROUND, ...ROUND];
    const live = run(changed, script);
    const again = run(revived, script);
    expect(again.events).toEqual(live.events);
    expect(again.state).toEqual(live.state);
    expect(phaseEvents(again.events)).toHaveLength(0);
  });

  it('leaves every other enemy without phase fields, so their logs are unchanged', () => {
    const state = begin(ENEMIES['orrery-warden'] as EnemySetup);
    const { phase, phaseTwo } = state.enemies[0] as object as Record<string, unknown>;
    expect(phase).toBeUndefined();
    expect(phaseTwo).toBeUndefined();
    expect(JSON.stringify(state.enemies[0])).not.toMatch(/phase/);
  });
});

describe('the combat view folds the phase', () => {
  it('swaps the shown moves so a phase-2 intent still resolves to its move', () => {
    const state = begin(guardianAt(81), 1, SEEDS[0] as string);
    const changed = run(state, [strike(state)]);
    // A shown state folded from the event log, as the combat session keeps it.
    const shownBefore = state;
    const shown = foldEvents(shownBefore, changed.events);
    expect(shown.enemies[0]?.phase).toBe(2);
    expect(shown.enemies[0]?.moves.map((m) => m.id)).toEqual(PHASE_TWO_IDS);
    const tollIntent: CombatEvent = {
      type: 'enemy-intent',
      enemyId: 'grand-escapement',
      moveId: 'toll',
      intent: 'attack',
    };
    expect(foldEvents(shown, [tollIntent]).enemies[0]?.intent?.id).toBe('toll');
    // Without the phase event folded first, toll is not in the shown list and the intent would vanish.
    expect(foldEvents(shownBefore, [tollIntent]).enemies[0]?.intent).toBeNull();
  });

  it('files the phase event in the owning enemy beat during its Overheat tick', () => {
    const state = begin(guardianAt(85, { statuses: { overheat: 10 } }));
    const ended = run(state, [{ type: 'end-turn' }, { type: 'enemy-act' }]);
    const beats = segmentEvents(ended.events).filter((s) => s.kind === 'enemy');
    expect(beats).toHaveLength(1);
    const [beat] = beats;
    if (beat?.kind !== 'enemy') throw new Error('expected an enemy beat');
    expect(beat.lead.some((e) => e.type === 'enemy-phase')).toBe(true);
  });
});
