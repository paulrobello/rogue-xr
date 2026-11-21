import { describe, expect, it } from 'vitest';
import {
  ENCOUNTERS,
  ENEMIES,
  ENEMY_THREAT,
  type EncounterTier,
  encounterSetups,
  pickEncounter,
} from '../src/content/enemies.ts';
import { RunRng } from '../src/core/rng.ts';
import {
  type Action,
  apply,
  type CombatEvent,
  type CombatState,
  createIdleState,
  type EnemySetup,
  startCombat,
  validate,
} from '../src/rules/index.ts';

const ROSTER = Object.values(ENEMIES);
/** Every move an enemy can ever pick: its phase-1 list plus the extra moves of its phase 2. */
const allMoves = (enemy: EnemySetup): EnemySetup['moves'] => [
  ...enemy.moves,
  ...(enemy.phaseTwo?.moves ?? []).filter((m) => !enemy.moves.some((p) => p.id === m.id)),
];
const TIERS: EncounterTier[] = ['regular', 'elite', 'guardian'];

function begin(enemies: EnemySetup[], seed: string, hp = 70): CombatState {
  return startCombat({
    player: { hp, maxHp: hp },
    deck: [],
    enemies,
    rng: new RunRng(seed).snapshot(),
  }).state;
}

/** Plays `rounds` passive player turns (start-turn, end-turn, enemy-act) and collects every event. */
function passRounds(
  state: CombatState,
  rounds: number,
): { state: CombatState; events: CombatEvent[] } {
  const events: CombatEvent[] = [];
  const round: Action[] = [{ type: 'start-turn' }, { type: 'end-turn' }, { type: 'enemy-act' }];
  for (let i = 0; i < rounds; i++) {
    for (const action of round) {
      const result = apply(state, action);
      state = result.state;
      events.push(...result.events);
    }
  }
  return { state, events };
}

/** The visible intents of `enemy` from start-combat through `rounds` enemy actions. */
function intentSequence(enemy: EnemySetup, seed: string, rounds = 12): string[] {
  const start = startCombat({
    player: { hp: 9999, maxHp: 9999 },
    deck: [],
    enemies: [enemy],
    rng: new RunRng(seed).snapshot(),
  });
  const { state, events } = passRounds(start.state, rounds);
  expect(state.phase).toBe('awaiting-turn');
  return [...start.events, ...events].flatMap((e) => (e.type === 'enemy-intent' ? [e.moveId] : []));
}

describe('roster', () => {
  it('contains each named automaton, including the Conservatory owl', () => {
    expect(ROSTER.map((e) => e.name)).toEqual([
      'Cog Sentry',
      'Spring Hound',
      'Bellows Golem',
      'Orrery Warden',
      'Grand Escapement',
      'Glasswing Scrivener',
      'Twin Furnace Mite',
      'Null-Crown Auditor',
      'Clockwork Owl',
      'Mortar Scarab',
      'Lantern Bailiff',
    ]);
    for (const [kind, setup] of Object.entries(ENEMIES)) expect(setup.id).toBe(kind);
  });

  it('every enemy passes start-combat validation', () => {
    const rng = new RunRng('SP1RE000').snapshot();
    for (const enemy of ROSTER) {
      const action: Action = {
        type: 'start-combat',
        player: { hp: 70, maxHp: 70 },
        deck: [],
        enemies: [enemy],
        rng,
      };
      expect(validate(createIdleState(), action)).toBeNull();
    }
  });

  it('applies Weak and Vulnerable to the player', () => {
    for (const enemy of ROSTER) {
      for (const move of allMoves(enemy)) {
        for (const effect of move.effects) {
          if (effect.type !== 'apply-status') continue;
          if (effect.status === 'weak' || effect.status === 'vulnerable') {
            expect(effect.target, `${enemy.id}/${move.id}`).toBe('target');
            expect(effect.stacks, `${enemy.id}/${move.id}`).toBeGreaterThanOrEqual(2);
          }
          if (effect.target === 'self') expect(effect.status).toBe('wound-up');
        }
      }
    }
  });

  it('steps up in toughness: regulars < elite < guardian', () => {
    const regular = Math.max(...ROSTER.slice(0, 3).map((e) => e.hp));
    expect(ENEMIES['orrery-warden'].hp).toBeGreaterThan(regular);
    expect(ENEMIES['grand-escapement'].hp).toBeGreaterThan(ENEMIES['orrery-warden'].hp);
  });
});

describe('every move resolves through the engine', () => {
  for (const enemy of ROSTER) {
    for (const move of allMoves(enemy)) {
      it(`${enemy.id}/${move.id}`, () => {
        // Exercise this action in isolation, including moves reserved for a follow-up.
        const only: EnemySetup = { ...enemy, moves: [{ ...move, weight: 1, followUp: undefined }] };
        const { state, events } = passRounds(begin([only], 'SP1RE000'), 2);
        const acted = events.filter((e) => e.type === 'enemy-acted');
        expect(acted).toEqual([
          { type: 'enemy-acted', enemyId: enemy.id, moveId: move.id },
          { type: 'enemy-acted', enemyId: enemy.id, moveId: move.id },
        ]);
        expect(state.phase).toBe('awaiting-turn');
        expect(state.player.hp).toBeGreaterThan(0);
        if (move.effects.some((e) => e.type === 'damage')) {
          expect(events.some((e) => e.type === 'damage-dealt' && e.target === 'player')).toBe(true);
        }
      });
    }
  }
});

describe('intent AI', () => {
  it('replays the same intent sequence for the same seed', () => {
    for (const enemy of ROSTER) {
      const first = intentSequence(enemy, 'SP1RE000');
      expect(first).toHaveLength(13);
      expect(intentSequence(enemy, 'SP1RE000')).toEqual(first);
    }
  });

  it('gives different sequences for different seeds', () => {
    const seeds = ['SP1RE000', 'C10CKW0R', '7GEARS00', 'BRASS123'];
    for (const enemy of ROSTER) {
      const sequences = new Set(seeds.map((seed) => intentSequence(enemy, seed).join(',')));
      expect(sequences.size, enemy.id).toBeGreaterThan(1);
    }
  });

  it('uses more than one move over a run', () => {
    for (const enemy of ROSTER) {
      expect(new Set(intentSequence(enemy, 'SP1RE000', 20)).size, enemy.id).toBeGreaterThan(1);
    }
  });
});

describe('encounters', () => {
  it('groups by tier with one or two regulars, and threat is the sum of its enemies', () => {
    for (const tier of TIERS) {
      expect(ENCOUNTERS[tier].length).toBeGreaterThan(0);
      for (const enc of ENCOUNTERS[tier]) {
        expect(enc.tier).toBe(tier);
        expect(enc.threat).toBe(enc.enemies.reduce((sum, k) => sum + ENEMY_THREAT[k], 0));
      }
    }
    for (const enc of ENCOUNTERS.regular) {
      expect(enc.enemies.length).toBeGreaterThanOrEqual(1);
      expect(enc.enemies.length).toBeLessThanOrEqual(2);
      for (const kind of enc.enemies) {
        expect([
          'cog-sentry',
          'spring-hound',
          'bellows-golem',
          'glasswing-scrivener',
          'furnace-mite',
          'mortar-scarab',
          'lantern-bailiff',
        ]).toContain(kind);
      }
    }
    expect(ENCOUNTERS.elite.map((e) => e.enemies)).toContainEqual(['orrery-warden']);
    expect(ENCOUNTERS.elite.map((e) => e.enemies)).toContainEqual(['null-crown-auditor']);
    expect(ENCOUNTERS.guardian.map((e) => e.enemies)).toEqual([['grand-escapement']]);
  });

  it('every encounter starts a combat, with unique ids for repeated kinds', () => {
    for (const tier of TIERS) {
      for (const enc of ENCOUNTERS[tier]) {
        const setups = encounterSetups(enc);
        expect(new Set(setups.map((s) => s.id)).size).toBe(setups.length);
        const { state } = passRounds(begin(setups, 'SP1RE000', 9999), 3);
        expect(state.phase).toBe('awaiting-turn');
      }
    }
    const pack = ENCOUNTERS.regular.find((e) => e.id === 'hound-pack');
    expect(pack && encounterSetups(pack).map((s) => s.id)).toEqual([
      'spring-hound',
      'spring-hound-2',
    ]);
  });

  it('pickEncounter is deterministic per seed and respects the budget', () => {
    const picks = (seed: string, budget?: number): string[] => {
      const stream = new RunRng(seed).stream('floor');
      return Array.from({ length: 12 }, () => pickEncounter('regular', stream, budget).id);
    };
    expect(picks('SP1RE000')).toEqual(picks('SP1RE000'));
    expect(picks('SP1RE000')).not.toEqual(picks('C10CKW0R'));
    for (const id of picks('SP1RE000', 2)) expect(['sentry', 'hound']).toContain(id);
    const stream = new RunRng('SP1RE000').stream('floor');
    expect(pickEncounter('elite', stream).id).toBe('warden');
    expect(pickEncounter('guardian', stream).id).toBe('escapement');
    expect(() => pickEncounter('guardian', stream, 5)).toThrow(RangeError);
  });
});
