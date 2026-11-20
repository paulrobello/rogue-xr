import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { snapshotRun, validateSnapshot } from '../src/persist/saves.ts';
import { type BellNote, bellMelody, strikeChime } from '../src/rules/bell-chimes.ts';
import { createRun } from '../src/rules/run.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const make = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });

describe('bell chime rules and flow', () => {
  it('is deterministic, uses all three numbered bells, and varies by seed', () => {
    const a = bellMelody('BRASS042');
    expect(a).toEqual(bellMelody('BRASS042'));
    expect(a).toHaveLength(4);
    expect(new Set(a)).toEqual(new Set([0, 1, 2]));
    expect(a).not.toEqual(bellMelody('MAPTEST2'));
  });

  it('teaches on Floor 1, replays there, rejects wrong floors, and resets mistakes', () => {
    const flow = make();
    flow.newRun('BRASS042');
    expect(flow.strikeChime(0)).toBeNull();
    expect(flow.listenToChimes()).toBe(true);
    expect(flow.listenToChimes()).toBe(true);
    expect(flow.travelToFloor(2, 1)).toBe(true);
    const melody = bellMelody('BRASS042');
    expect(flow.strikeChime((melody[0] === 0 ? 1 : 0) as BellNote)).toBe('mistake');
    expect(flow.run?.bellChimes?.progress).toEqual([]);
    expect(flow.travelToFloor(1, 0)).toBe(true);
    expect(flow.strikeChime(0)).toBeNull();
    expect(flow.travelToFloor(2, 1)).toBe(true);
    expect(flow.strikeChime(melody[0])).toBe('correct');
  });

  it('returns the clear music-box hint before activation and prevents premature or duplicate reward', () => {
    const run = createRun('BRASS042', STARTER_DECK);
    const hinted = strikeChime(run, 0);
    expect(hinted?.feedback).toBe('hint');
    expect(hinted?.run).toEqual(run);
    const flow = make();
    flow.newRun('BRASS042');
    expect(flow.claimChimeReward()).toBe(false);
  });

  it('round-trips partial and solved-unclaimed progress across both floors, then pays once', () => {
    const flow = make();
    flow.newRun('BRASS042');
    flow.listenToChimes();
    flow.travelToFloor(2, 3);
    const melody = bellMelody('BRASS042');
    flow.strikeChime(melody[0]);
    const partial = flow.snapshot(10);
    if (!partial) throw new Error('missing partial snapshot');
    const resumed = make();
    expect(resumed.continueRun(validateSnapshot(JSON.parse(JSON.stringify(partial))))).toBe(true);
    expect(resumed.run?.bellChimes?.progress).toEqual([melody[0]]);
    for (const note of melody.slice(1)) resumed.strikeChime(note);
    expect(resumed.travelToFloor(1, 0)).toBe(true);
    expect(resumed.run?.bellChimes?.solved).toBe(true);
    expect(resumed.claimChimeReward()).toBe(false);
    expect(resumed.travelToFloor(2, 3)).toBe(true);
    const solved = resumed.snapshot(11);
    if (!solved) throw new Error('missing solved snapshot');
    const resumedSolved = make();
    expect(resumedSolved.continueRun(validateSnapshot(JSON.parse(JSON.stringify(solved))))).toBe(
      true,
    );
    const before = resumedSolved.run?.cogs ?? 0;
    expect(resumedSolved.claimChimeReward()).toBe(true);
    expect(resumedSolved.claimChimeReward()).toBe(false);
    expect(resumedSolved.run?.cogs).toBe(before + 12);
  });

  it('rejects impossible prefixes and inconsistent flags while accepting old saves without chimes', () => {
    const run = createRun('BRASS042', STARTER_DECK);
    const world = {
      phase: 'explore' as const,
      floorSeed: run.seed,
      roomIndex: 0,
      clearedEncounters: [],
      pendingReward: null,
    };
    const base = snapshotRun(run, world, 1);
    const old = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    delete (old.run as Record<string, unknown>).bellChimes;
    expect(validateSnapshot(old).run.bellChimes).toBeUndefined();
    const badPrefix = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    (badPrefix.run as Record<string, unknown>).bellChimes = {
      clueHeard: true,
      progress: [9],
      solved: false,
      rewardClaimed: false,
    };
    expect(() => validateSnapshot(badPrefix)).toThrow();
    const completed = bellMelody(run.seed);
    for (const [progress, solved] of [
      [[(completed[0] + 1) % 3], false],
      [completed, false],
      [[completed[0]], true],
    ] as const) {
      const invalid = JSON.parse(JSON.stringify(base));
      invalid.run.bellChimes = { clueHeard: true, progress, solved, rewardClaimed: false };
      expect(() => validateSnapshot(invalid)).toThrow();
    }
    const badFlags = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    (badFlags.run as Record<string, unknown>).bellChimes = {
      clueHeard: false,
      progress: [],
      solved: true,
      rewardClaimed: true,
    };
    expect(() => validateSnapshot(badFlags)).toThrow();
  });
});
