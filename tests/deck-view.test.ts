import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { DECK_PAGE_SIZE, FlowUi } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const SEED = 'BRASS042';

function rig() {
  const flow = new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
  const ui = new FlowUi({
    flow,
    keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
    seed: SEED,
    snapshot: () => null,
    settings: () => ({ ...DEFAULT_SETTINGS }),
    onNewRun: (seed) => flow.newRun(seed),
    onContinue: () => {},
    onSettings: () => {},
    rewardCards: { art: null, loadArt: false, syncLabels: false },
  });
  const head = new THREE.Object3D();
  head.position.set(0, 1.6, 0);
  return { flow, ui, head };
}

const faces = (ui: FlowUi): THREE.Object3D | undefined =>
  ui.root.getObjectByName('deck-card-faces');

describe('deck viewer in the in-run menu (playtest card E)', () => {
  it('opens from the menu while exploring, pages through the whole deck and goes back', () => {
    const { flow, ui, head } = rig();
    flow.newRun(SEED);
    ui.sync(head);
    ui.openMenu(head);
    const deck = flow.run?.deck ?? [];
    expect(deck.length).toBeGreaterThan(DECK_PAGE_SIZE);
    expect(ui.activate('menu-deck')).toBe(true);
    expect(ui.menuView).toBe('deck');
    expect(ui.deckCards).toEqual(deck.slice(0, DECK_PAGE_SIZE));
    // Real card faces: one face slot per card on the page, drawn by the reward board's faces.
    const bodies = faces(ui)?.getObjectByName('reward-card-bodies');
    expect(bodies).toBeInstanceOf(THREE.InstancedMesh);
    expect((bodies as THREE.InstancedMesh).count).toBe(DECK_PAGE_SIZE);
    expect(ui.controlIds()).toEqual(
      expect.arrayContaining(['menu-deck-nav-next', 'menu-deck-nav-back']),
    );
    // The first page has nothing before it: Previous is a label, not a control.
    expect(ui.controlIds()).not.toContain('menu-deck-nav-prev');
    expect(ui.activate('menu-deck-nav-prev')).toBe(false);

    expect(ui.activate('menu-deck-nav-next')).toBe(true);
    expect(ui.deckCards).toEqual(deck.slice(DECK_PAGE_SIZE));
    expect(ui.controlIds()).not.toContain('menu-deck-nav-next');
    expect(ui.activate('menu-deck-nav-next')).toBe(false);
    expect(ui.activate('menu-deck-nav-prev')).toBe(true);
    expect(ui.deckCards).toEqual(deck.slice(0, DECK_PAGE_SIZE));

    expect(ui.activate('menu-deck-nav-back')).toBe(true);
    expect(ui.menuView).toBe('main');
    expect(ui.deckCards).toEqual([]);
    expect(faces(ui)).toBeUndefined();
    expect(ui.controlIds()).toContain('menu-resume');
    ui.dispose();
  });

  it('shows cards claimed during the run', () => {
    const { flow, ui, head } = rig();
    flow.newRun(SEED);
    flow.fightStarted(1);
    flow.fightEnded({ room: 1, outcome: 'win', tier: 'regular' });
    const picked = flow.offer?.cards[0] as string;
    flow.pickReward(picked);
    ui.sync(head);
    ui.openMenu(head);
    ui.activate('menu-deck');
    ui.activate('menu-deck-nav-next');
    expect(ui.deckCards.at(-1)).toBe(picked);
    ui.dispose();
  });

  it('is not offered in a fight, and the menu closes from the viewer', () => {
    const { flow, ui, head } = rig();
    flow.newRun(SEED);
    flow.fightStarted(2);
    ui.sync(head);
    ui.openMenu(head);
    expect(ui.controlIds()).not.toContain('menu-deck');
    ui.closeMenu();

    flow.fightEnded({ room: 2, outcome: 'flee', tier: 'regular' });
    ui.sync(head);
    ui.openMenu(head);
    ui.activate('menu-deck');
    expect(ui.toggleMenu(head)).toBe(true);
    expect(ui.menuOpen).toBe(false);
    expect(ui.visible).toBe(false);
    expect(faces(ui)).toBeUndefined();
    ui.dispose();
  });
});
