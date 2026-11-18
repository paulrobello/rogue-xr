import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { FlowUi } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

describe('title key art fallback', () => {
  it('builds the title, its wordmark and its controls when the key art cannot load', () => {
    const flow = new RunFlow({
      workshop: createWorkshop(),
      starterDeck: STARTER_DECK,
      rewardPool: REWARD_POOL,
    });
    const ui = new FlowUi({
      flow,
      keyArt: {
        url: 'data:image/jpeg;base64,AAAA',
        titleSafe: { x: 0.03, y: 0.3, w: 0.27, h: 0.4 },
      },
      seed: 'BRASS042',
      snapshot: () => null,
      settings: () => ({ ...DEFAULT_SETTINGS }),
      onNewRun: (seed) => flow.newRun(seed),
      onContinue: () => {},
      onSettings: () => {},
    });
    expect(() => ui.sync(new THREE.Object3D())).not.toThrow();
    expect(ui.root.getObjectByName('flow-key-art')).toBeDefined();
    expect(ui.controlIds().length).toBeGreaterThan(0);
    ui.dispose();
  });
});
