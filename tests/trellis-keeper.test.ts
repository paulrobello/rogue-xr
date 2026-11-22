import { describe, expect, it } from 'vitest';
import { chooseEncounter, TRELLIS_KEEPER_VERSION } from '../src/combat/encounter-choice.ts';
import {
  CONSERVATORY_OWL,
  ENEMIES,
  encounterSetups,
  TRELLIS_KEEPER,
} from '../src/content/enemies.ts';
import { RunRng } from '../src/core/rng.ts';
import { apply, startCombat } from '../src/rules/index.ts';
import { floorSeedFor } from '../src/rules/run.ts';

describe('Trellis Keeper', () => {
  it('is the second seeded floor-three solo regular while preserving Owl compatibility and showcase', () => {
    const keeperSeed = floorSeedFor('VA1T9QZK', 3);
    expect(chooseEncounter(keeperSeed, 0, 'regular', 1, TRELLIS_KEEPER_VERSION, 3)).toBe(
      TRELLIS_KEEPER,
    );
    expect(
      chooseEncounter(floorSeedFor('SPIRE001', 3), 0, 'regular', 1, TRELLIS_KEEPER_VERSION, 3),
    ).toBe(CONSERVATORY_OWL);
    expect(chooseEncounter('VA1T9QZK', 0, 'regular', 1, TRELLIS_KEEPER_VERSION - 1, 3)).toBe(
      CONSERVATORY_OWL,
    );
    expect(chooseEncounter('MAPTEST2', 0, 'regular', 1, TRELLIS_KEEPER_VERSION, 3)).toBe(
      CONSERVATORY_OWL,
    );
    expect(
      chooseEncounter(floorSeedFor('MAPTEST2', 3), 0, 'regular', 1, TRELLIS_KEEPER_VERSION, 3),
    ).toBe(CONSERVATORY_OWL);
  });

  it('guards before its reserved two-hit follow-up and scales damage by difficulty', () => {
    expect(ENEMIES['trellis-keeper']).toMatchObject({ hp: 38 });
    expect(TRELLIS_KEEPER.threat).toBe(3);
    expect(TRELLIS_KEEPER.enemies).toEqual(['trellis-keeper']);
    expect(TRELLIS_KEEPER.enemies.length).toBe(1);
    expect(TRELLIS_KEEPER).toBeDefined();

    const hard = encounterSetups(TRELLIS_KEEPER, 'hard')[0]!;
    const normal = encounterSetups(TRELLIS_KEEPER, 'normal')[0]!;
    expect(normal.hp).toBe(30);
    expect(normal.moves.find((move) => move.id === 'hook-jab')?.effects).toEqual([
      { type: 'damage', amount: 5, target: 'target' },
    ]);
    expect(normal.moves.find((move) => move.id === 'double-cut')?.effects).toEqual([
      { type: 'damage', amount: 4, hits: 2, target: 'target' },
    ]);

    const brace = hard.moves.filter((move) => move.id !== 'hook-jab');
    const state = startCombat({
      player: { hp: 70, maxHp: 70 },
      deck: [],
      enemies: [{ ...hard, moves: brace }],
      rng: new RunRng('KEEP0001').snapshot(),
    }).state;
    expect(state.enemies[0]?.intent).toMatchObject({
      id: 'trellis-brace',
      stance: 'guarded',
      weight: 2,
      followUp: 'double-cut',
    });
    const afterBrace = apply(
      apply(apply(state, { type: 'start-turn' }).state, { type: 'end-turn' }).state,
      { type: 'enemy-act' },
    );
    expect(afterBrace.state.enemies[0]?.block).toBe(10);
    expect(afterBrace.state.enemies[0]?.intent).toMatchObject({
      id: 'double-cut',
      stance: 'exposed',
    });
    const afterCut = apply(apply(afterBrace.state, { type: 'start-turn' }).state, {
      type: 'end-turn',
    });
    const result = apply(afterCut.state, { type: 'enemy-act' });
    expect(result.state.player.hp).toBe(60);
    expect(result.events.filter((event) => event.type === 'damage-dealt')).toHaveLength(2);
  });
});
