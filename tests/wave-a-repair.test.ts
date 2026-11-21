import { describe, expect, it } from 'vitest';
import { DUNGEON_CONTENT_VERSION, WAVE_A_REPAIR_VERSION } from '../src/combat/encounter-choice.ts';
import { STARTER_DECK } from '../src/content/cards.ts';
import {
  DUNGEON_REWARD_IDS,
  LEGACY_REWARD_POOL,
  PERMANENT_CARD_IDS,
  REWARD_POOL,
  WAVE_A_REPAIR_IDS,
} from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { rewardOffer } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const options = {
  workshop: createWorkshop(),
  starterDeck: STARTER_DECK,
  rewardPool: REWARD_POOL,
};
const beforeRepair = REWARD_POOL.filter((id) => !WAVE_A_REPAIR_IDS.has(id));
const beforeDungeon = beforeRepair.filter((id) => !DUNGEON_REWARD_IDS.has(id));

describe('Wave A repair availability', () => {
  it('adds all three cards to the new reward pool and Workshop', () => {
    expect(REWARD_POOL.slice(-3)).toEqual(['spare-parts', 'flywheel-swing', 'patch-kit']);
    for (const id of WAVE_A_REPAIR_IDS) expect(PERMANENT_CARD_IDS).toContain(id);
  });

  it.each([
    [1, LEGACY_REWARD_POOL],
    [2, beforeDungeon],
    [DUNGEON_CONTENT_VERSION - 1, beforeDungeon],
    [DUNGEON_CONTENT_VERSION, beforeRepair],
    [WAVE_A_REPAIR_VERSION - 1, beforeRepair],
    [WAVE_A_REPAIR_VERSION, REWARD_POOL],
  ])('replays the exact combat reward order for content version %i', (version, eligible) => {
    for (let i = 0; i < 24; i++) {
      const fresh = new RunFlow(options);
      fresh.newRun(`REPA1R${String(i).padStart(2, '0')}`);
      const snapshot = fresh.snapshot(1, 0);
      if (!snapshot) throw Error('Missing snapshot');
      const run = new RunFlow(options);
      expect(run.continueRun({ ...snapshot, contentVersion: version })).toBe(true);
      expect(run.fightStarted(1)).toBe(true);
      const expected = rewardOffer(snapshot.run, 'regular', eligible).offer;
      expect(
        run.fightEnded({ room: 1, outcome: 'win', tier: 'regular', playerHp: snapshot.run.hp }),
      ).toBe(true);
      expect(run.offer).toEqual(expected);
    }
  });
});
