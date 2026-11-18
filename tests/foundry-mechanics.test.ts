import { describe, expect, it } from 'vitest';
import { getCard } from '../src/content/cards.ts';
import { ENEMIES } from '../src/content/enemies.ts';
import { RunRng } from '../src/core/rng.ts';
import {
  apply,
  type CombatState,
  type EnemySetup,
  playCardWithSigil,
  startCombat,
} from '../src/rules/index.ts';

const wait: EnemySetup = {
  id: 'wait',
  name: 'Wait',
  hp: 100,
  moves: [{ id: 'wait', intent: 'unknown', effects: [] }],
};
const begin = (
  deck: Parameters<typeof startCombat>[0]['deck'],
  enemies: EnemySetup[] = [wait],
): CombatState => {
  const started = startCombat({
    player: { hp: 50, maxHp: 50 },
    deck,
    enemies,
    rng: new RunRng('BRASS123').snapshot(),
  });
  return apply(started.state, { type: 'start-turn' }).state;
};
const hand = (state: CombatState, uid: number): CombatState => ({
  ...state,
  piles: (() => {
    const card = state.piles.draw.find((c) => c.uid === uid);
    return card
      ? {
          ...state.piles,
          draw: state.piles.draw.filter((c) => c.uid !== uid),
          hand: [...state.piles.hand, card],
        }
      : state.piles;
  })(),
});
const play = (state: CombatState, uid: number, target?: string): CombatState =>
  apply(state, { type: 'play-card', uid, ...(target ? { target } : {}) }).state;

describe('Foundry combat mechanics', () => {
  it('keeps an unplayed Pinned card through end-turn, then discards it when used', () => {
    let state = hand(begin([getCard('shear-pin')]), 0);
    state = apply(state, { type: 'end-turn' }).state;
    expect(state.piles.hand.map((c) => c.def.id)).toContain('shear-pin');
    state = apply(state, { type: 'enemy-act' }).state;
    state = apply(state, { type: 'start-turn' }).state;
    state = play(state, 0, 'wait');
    expect(state.piles.hand.some((c) => c.uid === 0)).toBe(false);
    expect(state.piles.discard.some((c) => c.uid === 0)).toBe(true);
  });

  it('draws five new cards beside a retained pin, stopping at the hand capacity', () => {
    for (const [pins, expected] of [
      [1, 6],
      [7, 10],
    ] as const) {
      const state = begin([getCard('shear-pin')]);
      const pin = state.piles.hand[0];
      if (!pin) throw new Error('Expected a pin');
      const held = Array.from({ length: pins }, (_, i) => ({ ...pin, uid: i }));
      const draw = Array.from({ length: 8 }, (_, i) => ({ def: getCard('strike'), uid: i + pins }));
      let turn = apply(
        { ...state, piles: { ...state.piles, draw, hand: held, discard: [] } },
        { type: 'end-turn' },
      ).state;
      turn = apply(turn, { type: 'enemy-act' }).state;
      turn = apply(turn, { type: 'start-turn' }).state;
      expect(turn.piles.hand).toHaveLength(expected);
      expect(turn.piles.hand.slice(0, pins)).toEqual(held);
    }
  });

  it('pays Plating after clearing old Block, then decreases 3 to 2 to 1', () => {
    let state = begin([getCard('rivet-plate'), getCard('defend')]);
    state = hand(state, 0);
    state = play(state, 0);
    expect(state.player.statuses.plating).toBe(3);
    state = { ...state, player: { ...state.player, block: 9 } };
    state = apply(state, { type: 'end-turn' }).state;
    state = apply(state, { type: 'enemy-act' }).state;
    state = apply(state, { type: 'start-turn' }).state;
    expect(state.player.block).toBe(3);
    expect(state.player.statuses.plating).toBe(2);
  });

  it('halves odd Block under Rust and decays Rust at the owner turn end', () => {
    const proof: EnemySetup = {
      id: 'proof',
      name: 'Proof',
      hp: 100,
      moves: [{ id: 'proof', intent: 'defend', effects: [{ type: 'block', amount: 5 }] }],
    };
    let state = begin([getCard('rust-spray')], [proof]);
    state = hand(state, 0);
    state = play(state, 0);
    state = apply(state, { type: 'end-turn' }).state;
    state = apply(state, { type: 'enemy-act' }).state;
    expect(state.enemies[0]?.block).toBe(2);
    expect(state.enemies[0]?.statuses.rust).toBe(1);
  });

  it('Counterstroke gains Block only for the target intent with two hits', () => {
    const enemy: EnemySetup = {
      id: 'mite',
      name: 'Mite',
      hp: 20,
      moves: [
        {
          id: 'double',
          intent: 'attack',
          effects: [{ type: 'damage', amount: 1, hits: 2, target: 'target' }],
        },
      ],
    };
    let state = hand(begin([getCard('counterstroke')], [enemy]), 0);
    state = play(state, 0, 'mite');
    expect(state.player.block).toBe(6);
  });

  it('Quench removes only existing heat and scales the computed total once', () => {
    let state = begin([getCard('quench-seal')]);
    state = hand(state, 0);
    const target = state.enemies[0];
    if (!target) throw new Error('No heat target');
    state = { ...state, enemies: [{ ...target, statuses: { overheat: 1 } }] };
    state = playCardWithSigil(state, { type: 'play-card', uid: 0, target: 'wait' }, 0.5).state;
    expect(state.enemies[0]?.statuses).toEqual({});
    expect(state.player.block).toBe(3);
  });

  it('keeps the conditional shield when Counterstroke kills a double-striking target', () => {
    const mite = ENEMIES['furnace-mite'];
    const double = mite.moves.find((move) => move.id === 'double-spark');
    if (!double) throw new Error('Missing Double Spark');
    const state = hand(
      begin(
        [getCard('counterstroke')],
        [
          { ...mite, hp: 1, moves: [double] },
          { ...mite, id: 'partner' },
        ],
      ),
      0,
    );
    expect(play(state, 0, mite.id).player.block).toBe(6);
  });

  it('caps Quench at three spent stacks before a masterful trace scales the combined ward', () => {
    const state = hand(begin([getCard('quench-seal')]), 0);
    const enemy = state.enemies[0];
    if (!enemy) throw new Error('No heat target');
    const hot = { ...state, enemies: [{ ...enemy, statuses: { overheat: 5 } }] };
    const result = playCardWithSigil(hot, { type: 'play-card', uid: 0, target: enemy.id }, 1.25);
    expect(result.state.player.block).toBe(13);
    expect(result.state.enemies[0]?.statuses.overheat).toBe(2);
    expect(result.events).toContainEqual({
      type: 'status-ticked',
      target: enemy.id,
      status: 'overheat',
      from: 5,
      to: 2,
    });
  });

  it('announces Levy exclusively after Reconcile, including across serialized state', () => {
    let warnings = 0;
    for (let i = 0; i < 12; i++) {
      let state = startCombat({
        player: { hp: 10000, maxHp: 10000 },
        deck: [],
        enemies: [ENEMIES['null-crown-auditor']],
        rng: new RunRng(`STAMP${String(i).padStart(3, '0')}`).snapshot(),
      }).state;
      expect(state.enemies[0]?.intent?.id).not.toBe('levy');
      for (let turn = 0; turn < 12; turn++) {
        state = apply(state, { type: 'start-turn' }).state;
        const current = state.enemies[0]?.intent?.id;
        state = apply(state, { type: 'end-turn' }).state;
        state = apply(JSON.parse(JSON.stringify(state)) as CombatState, {
          type: 'enemy-act',
        }).state;
        expect(state.enemies[0]?.intent?.id === 'levy').toBe(current === 'reconcile');
        if (current === 'reconcile') warnings++;
      }
    }
    expect(warnings).toBeGreaterThan(0);
  });
});
