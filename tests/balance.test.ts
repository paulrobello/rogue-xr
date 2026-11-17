// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { handMultiplier, simulateRun, spireSeeds, winRate } from '../scripts/balance/sim.ts';
import { DIFFICULTIES } from '../src/rules/difficulty.ts';

const SEEDS = spireSeeds(20);

describe('balance harness', () => {
  it('replays a run exactly', () => {
    const opts = { level: 'casual' as const, sigilMultiplier: 0.75, missRate: 0.15 };
    for (const seed of SEEDS.slice(0, 5)) {
      expect(simulateRun(seed, opts)).toEqual(simulateRun(seed, opts));
    }
  });

  it('a mediocre hand (0.75 on Casual) wins most Casual runs', () => {
    const casual = winRate(SEEDS, { level: 'casual', sigilMultiplier: 0.75 });
    expect(casual.rate).toBeGreaterThanOrEqual(0.7);
  });

  it('Casual is easier than Normal, and Normal no easier than Hard, for the same hand', () => {
    const [casual, normal, hard] = DIFFICULTIES.map(
      (level) => winRate(SEEDS, { level, sigilMultiplier: handMultiplier(0.75, level) }).rate,
    ) as [number, number, number];
    expect(casual).toBeGreaterThan(normal);
    expect(normal).toBeGreaterThanOrEqual(hard);
  });

  it('a hand is judged at its level: same on Casual, weaker on Normal and Hard', () => {
    expect(handMultiplier(0.75, 'casual')).toBeCloseTo(0.75, 12);
    expect(handMultiplier(1, 'casual')).toBeCloseTo(1, 12);
    expect(handMultiplier(0.75, 'normal')).toBeCloseTo(0.5875, 4);
    expect(handMultiplier(1, 'normal')).toBeCloseTo(0.9, 4);
    expect(handMultiplier(0.75, 'hard')).toBe(0.5);
    expect(handMultiplier(1, 'hard')).toBeCloseTo(0.775, 4);
  });
});
