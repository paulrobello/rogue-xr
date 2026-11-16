import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { FlowUi, splitControlId } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

describe('splitControlId', () => {
  const boards = ['reward-info', 'reward', 'reward-skip'];

  it('picks the longest board name that prefixes the id', () => {
    expect(splitControlId(boards, 'reward-skip-skip')).toEqual({
      board: 'reward-skip',
      cell: 'skip',
    });
    expect(splitControlId(boards, 'reward-rivet-volley')).toEqual({
      board: 'reward',
      cell: 'rivet-volley',
    });
    expect(splitControlId(boards, 'reward-info-cogs')).toEqual({
      board: 'reward-info',
      cell: 'cogs',
    });
  });

  it('returns null for an id no board owns', () => {
    expect(splitControlId(boards, 'title-new-run')).toBeNull();
  });
});

describe('FlowUi reward board', () => {
  it('skips the card when Skip is activated (was routed to the card row and ignored)', () => {
    const flow = new RunFlow({
      workshop: createWorkshop(),
      starterDeck: STARTER_DECK,
      rewardPool: REWARD_POOL,
    });
    const ui = new FlowUi({
      flow,
      keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
      seed: 'BRASS042',
      snapshot: () => null,
      settings: () => ({ ...DEFAULT_SETTINGS }),
      onNewRun: (seed) => flow.newRun(seed),
      onContinue: () => {},
      onSettings: () => {},
    });
    const head = new THREE.Object3D();
    flow.newRun('BRASS042');
    flow.fightStarted(1);
    flow.fightEnded({ room: 1, outcome: 'win', tier: 'regular' });
    expect(flow.phase).toBe('reward');
    ui.sync(head);
    const deck = flow.run?.deck.length;
    expect(ui.controlIds()).toContain('reward-skip-skip');
    expect(ui.activate('reward-skip-skip')).toBe(true);
    expect(flow.phase).toBe('explore');
    expect(flow.run?.deck.length).toBe(deck);
    ui.dispose();
  });
});
