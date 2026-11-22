import { describe, expect, it } from 'vitest';
import { DUNGEON_CONTENT_VERSION } from '../src/combat/encounter-choice.ts';
import { getCard, STARTER_DECK } from '../src/content/cards.ts';
import { DUNGEON_REWARD_IDS, REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

describe('Wave A dungeon cards', () => {
  it('publishes the three first dungeon-era cards with their upgrades', () => {
    expect(getCard('torque-wrench')).toMatchObject({
      id: 'torque-wrench',
      type: 'attack',
      cost: 1,
      description: 'Deal 6 damage. Apply 1 Rust.',
    });
    expect(getCard('torque-wrench+')).toMatchObject({
      id: 'torque-wrench+',
      description: 'Deal 9 damage. Apply 2 Rust.',
    });
    expect(getCard('counterweight')).toMatchObject({
      id: 'counterweight',
      type: 'skill',
      cost: 2,
      pinned: true,
      description: 'Gain 12 Block. Pinned.',
    });
    expect(getCard('counterweight+').description).toBe('Gain 16 Block. Pinned.');
    expect(getCard('tension-coil')).toMatchObject({
      id: 'tension-coil',
      type: 'skill',
      cost: 1,
      description: 'Gain 4 Block. Gain 1 Wound-up.',
    });
    expect(getCard('tension-coil+').description).toBe('Gain 6 Block. Gain 1 Wound-up.');
  });

  it('keeps dungeon cards out of authored pre-dungeon rewards', () => {
    for (const id of ['torque-wrench', 'counterweight', 'tension-coil']) {
      expect(REWARD_POOL).toContain(id);
      expect(DUNGEON_REWARD_IDS.has(id)).toBe(true);
    }
  });

  it('filters new cards from an older run’s configured reward pool', () => {
    const options = {
      workshop: createWorkshop(),
      starterDeck: STARTER_DECK,
      rewardPool: ['torque-wrench', 'overwind'],
    };
    const source = new RunFlow(options);
    expect(source.newRun('MAPTEST2')).toBe(true);
    const saved = source.snapshot(1, 0);
    if (!saved) throw Error('Expected a fresh run snapshot');
    const resumed = new RunFlow(options);
    expect(resumed.continueRun({ ...saved, contentVersion: DUNGEON_CONTENT_VERSION - 1 })).toBe(
      true,
    );
    expect(resumed.openLoot(3, 'chest', 'card')).toMatchObject({ kind: 'card', card: 'overwind' });
  });
});
