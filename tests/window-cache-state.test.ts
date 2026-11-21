// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import { claimWindowCache, createRun, WINDOW_CACHE_COGS } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const flowWith = (): RunFlow =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });

describe('floor-one Light window cache', () => {
  it('pays twelve run cogs once', () => {
    const run = createRun('SPIRE001', STARTER_DECK);
    const claimed = claimWindowCache(run);
    if (!claimed) throw new Error('cache claim refused');
    expect(claimed).toMatchObject({ cogs: WINDOW_CACHE_COGS, windowCacheOpened: true });
    expect(claimWindowCache(claimed)).toBeNull();
    expect(run).not.toHaveProperty('windowCacheOpened');
  });

  it('persists the claim through Continue and preserves an earlier unclaimed save', () => {
    const flow = flowWith();
    expect(flow.newRun('SPIRE001')).toBe(true);
    expect(flow.windowCacheOpened).toBe(false);
    const before = validateSnapshot(flow.snapshot());

    expect(flow.openWindowCache()).toBe(true);
    expect(flow.run?.cogs).toBe(WINDOW_CACHE_COGS);
    expect(flow.openWindowCache()).toBe(false);
    const claimed = validateSnapshot(flow.snapshot());
    expect(claimed.run.windowCacheOpened).toBe(true);

    const resumed = flowWith();
    expect(resumed.continueRun(before)).toBe(true);
    expect(resumed.windowCacheOpened).toBe(false);
    expect(resumed.openWindowCache()).toBe(true);
    expect(resumed.run?.cogs).toBe(WINDOW_CACHE_COGS);

    const continued = flowWith();
    expect(continued.continueRun(claimed)).toBe(true);
    expect(continued.windowCacheOpened).toBe(true);
    expect(continued.openWindowCache()).toBe(false);
    expect(continued.run?.cogs).toBe(WINDOW_CACHE_COGS);
  });

  it('only opens while exploring on floor one', () => {
    const flow = flowWith();
    expect(flow.openWindowCache()).toBe(false);
    expect(flow.newRun('SPIRE001')).toBe(true);
    expect(flow.travelToFloor(2, 0)).toBe(true);
    expect(flow.openWindowCache()).toBe(false);
    expect(flow.windowCacheOpened).toBe(false);
  });
});
