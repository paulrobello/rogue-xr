// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SPEAKING_PIPES_VERSION } from '../src/combat/encounter-choice.ts';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { floorSeedFor } from '../src/rules/run.ts';
import { pipeTarget } from '../src/rules/speaking-pipes.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';

const make = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });

describe('speaking pipes', () => {
  it('primes, retains a wrong clue, opens once, and continues with a distinct floor seed', () => {
    const flow = make();
    expect(flow.newRun('MAPTEST2')).toBe(true);
    expect(flow.travelToFloor(2, 1)).toBe(true);
    expect(flow.run?.floorSeed).toBe(floorSeedFor('MAPTEST2', 2));
    expect(flow.run?.floorSeed).not.toBe(flow.run?.seed);
    expect(flow.speakingPipes).toBe('idle');
    expect(flow.primeSpeakingPipes()).toBe(true);
    expect(flow.primeSpeakingPipes()).toBe(true);
    const target = pipeTarget('MAPTEST2');
    expect(flow.selectSpeakingPipe(((target + 1) % 3) as 0 | 1 | 2)).toBe('wrong');
    expect(flow.speakingPipes).toBe('primed');
    expect(flow.selectSpeakingPipe(target)).toBe('opened');
    expect(flow.selectSpeakingPipe(target)).toBe('ignored');
    const snapshot = flow.snapshot(1234, 1);
    if (!snapshot) throw Error('missing snapshot');
    const resumed = make();
    expect(resumed.continueRun(snapshot)).toBe(true);
    expect(resumed.speakingPipes).toBe('open');
    expect(resumed.selectSpeakingPipe(target)).toBe('ignored');
  });

  it('appends the deterministic cistern only in the v12 MAPTEST2 plan', () => {
    const legacy = playableFloorPlan('MAPTEST2', SPEAKING_PIPES_VERSION - 1, 2);
    const active = playableFloorPlan('MAPTEST2', SPEAKING_PIPES_VERSION, 2);
    expect(legacy.speakingPipes).toBeUndefined();
    expect(active.speakingPipes?.cisternRoom).toBe(legacy.rooms.length);
    expect(active.rooms.slice(0, legacy.rooms.length)).toEqual(legacy.rooms);
  });

  it('does not accept the new station actions in a pre-cistern save', () => {
    const flow = make();
    expect(flow.newRun('MAPTEST2')).toBe(true);
    expect(flow.travelToFloor(2, 0)).toBe(true);
    const snapshot = flow.snapshot(1234, 0);
    if (!snapshot) throw Error('missing snapshot');
    const legacy = make();
    expect(legacy.continueRun({ ...snapshot, contentVersion: SPEAKING_PIPES_VERSION - 1 })).toBe(
      true,
    );
    expect(legacy.primeSpeakingPipes()).toBe(false);
    expect(legacy.selectSpeakingPipe(pipeTarget('MAPTEST2'))).toBe('ignored');
    expect(legacy.speakingPipes).toBe('idle');
  });
});
