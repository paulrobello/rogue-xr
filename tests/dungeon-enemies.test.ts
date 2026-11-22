import { describe, expect, it } from 'vitest';
import { DUNGEON_ENCOUNTERS, ENEMIES } from '../src/content/enemies.ts';
import { RunRng } from '../src/core/rng.ts';
import { apply, startCombat } from '../src/rules/index.ts';

function solo(kind: 'mortar-scarab' | 'lantern-bailiff', moves = ENEMIES[kind].moves) {
  return { ...ENEMIES[kind], moves };
}

function begin(enemy: Parameters<typeof startCombat>[0]['enemies'][number]) {
  return startCombat({
    player: { hp: 70, maxHp: 70 },
    deck: [],
    enemies: [enemy],
    rng: new RunRng('DNGN001A').snapshot(),
  }).state;
}

function enemyTurn(state: ReturnType<typeof begin>) {
  return apply(apply(state, { type: 'start-turn' }).state, { type: 'end-turn' }).state;
}

describe('stone dungeon enemies', () => {
  it('exports two regular solo encounters without changing the core pool', () => {
    expect(DUNGEON_ENCOUNTERS.map((encounter) => [encounter.id, encounter.threat])).toEqual([
      ['mortar-scarab', 3],
      ['lantern-bailiff', 4],
    ]);
    expect(DUNGEON_ENCOUNTERS.every((encounter) => encounter.tier === 'regular')).toBe(true);
    expect(DUNGEON_ENCOUNTERS.every((encounter) => encounter.enemies.length === 1)).toBe(true);
  });

  it('guarantees Mortar Scarab rake after a guarded shell seal, with stance damage applied by rules', () => {
    const scarab = ENEMIES['mortar-scarab'];
    const state = begin(solo('mortar-scarab', scarab.moves.slice(0, 2)));
    expect(state.enemies[0]?.intent).toMatchObject({ id: 'shell-seal', stance: 'guarded' });

    const afterPlayer = apply(apply(state, { type: 'start-turn' }).state, {
      type: 'end-turn',
    }).state;
    const afterShell = apply(afterPlayer, { type: 'enemy-act' }).state;
    expect(afterShell.enemies[0]?.block).toBe(9);
    expect(afterShell.enemies[0]?.intent).toMatchObject({ id: 'mortar-rake', stance: 'exposed' });
    expect(afterShell.player.hp).toBe(70);

    const afterRake = apply(apply(afterShell, { type: 'start-turn' }).state, {
      type: 'end-turn',
    }).state;
    const result = apply(afterRake, { type: 'enemy-act' });
    expect(result.state.player.hp).toBe(62);
    expect(result.events).toContainEqual({
      type: 'damage-dealt',
      source: 'mortar-scarab',
      target: 'player',
      kind: 'attack',
      amount: 4,
      blocked: 0,
      hpLost: 4,
    });
  });

  it('guarantees Lantern Bailiff sweep after guarded draw-chain and exposes the alternate debuff', () => {
    const bailiff = ENEMIES['lantern-bailiff'];
    const state = begin(solo('lantern-bailiff', bailiff.moves.slice(0, 2)));
    expect(state.enemies[0]?.intent).toMatchObject({ id: 'draw-chain', stance: 'guarded' });
    const afterDraw = apply(enemyTurn(state), { type: 'enemy-act' }).state;
    expect(afterDraw.enemies[0]?.block).toBe(7);
    expect(afterDraw.enemies[0]?.statuses).toEqual({ 'wound-up': 1 });
    expect(afterDraw.enemies[0]?.intent).toMatchObject({ id: 'lantern-sweep', stance: 'exposed' });
    const afterSweep = apply(apply(afterDraw, { type: 'start-turn' }).state, {
      type: 'end-turn',
    }).state;
    expect(apply(afterSweep, { type: 'enemy-act' }).state.player.hp).toBe(57);

    for (const [kind, moveId, status, stacks] of [
      ['mortar-scarab', 'grind', 'weak', 2],
      ['lantern-bailiff', 'cinder-glance', 'overheat', 1],
    ] as const) {
      const move = ENEMIES[kind].moves.find((candidate) => candidate.id === moveId);
      if (!move) throw new Error(`Missing ${kind}/${moveId}`);
      const acted = apply(enemyTurn(begin(solo(kind, [move]))), { type: 'enemy-act' });
      expect(acted.state.player.statuses[status]).toBe(stacks);
    }
  });
});
