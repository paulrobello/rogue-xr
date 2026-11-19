import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { DECK_PAGE_SIZE, FlowUi } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const SEED = 'BRASS042';

function rig(starterDeck: readonly string[] = STARTER_DECK) {
  const flow = new RunFlow({
    workshop: createWorkshop(),
    starterDeck,
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
  it('shows all ten starter cards in four slots, with a count and offset backs only for repeats', () => {
    const { flow, ui, head } = rig();
    flow.newRun(SEED);
    ui.sync(head);
    ui.openMenu(head);
    expect(ui.activate('menu-deck')).toBe(true);
    expect(ui.deckCards).toEqual(['strike', 'defend', 'cog-toss', 'warding-glyph']);
    expect(faces(ui)?.getObjectByName('deck-stack-count-strike')?.userData.labelText).toBe('×4');
    expect(faces(ui)?.getObjectByName('deck-stack-count-defend')?.userData.labelText).toBe('×4');
    expect(faces(ui)?.getObjectByName('deck-stack-count-cog-toss')).toBeUndefined();
    const backs = faces(ui)?.getObjectByName('deck-stack-backs') as THREE.InstancedMesh;
    expect(backs.count).toBe(4);
    const bodies = faces(ui)?.getObjectByName('reward-card-bodies') as THREE.InstancedMesh;
    expect(bodies.count).toBe(4);
    expect(ui.root.getObjectByName('menu-deck-count')?.userData.labelText).toBe(
      '10 cards · 4 distinct · page 1 of 1',
    );
    expect(ui.controlIds()).not.toContain('menu-deck-nav-next');
    expect(ui.activate('menu-deck-nav-back')).toBe(true);
    expect(ui.menuView).toBe('main');
    expect(ui.deckCards).toEqual([]);
    expect(faces(ui)).toBeUndefined();
    expect(ui.controlIds()).toContain('menu-resume');
    ui.dispose();
  });

  it('groups exact card versions before paging and brings the chosen role to the front', () => {
    const deck = [
      'strike',
      'defend',
      'cog-toss',
      'warding-glyph',
      'strike+',
      'iron-knuckle',
      'arc-bolt',
      'ratchet-flurry',
      'rivet-plate',
      'release-valve',
      'counterstroke',
      'time-spiral',
      'brass-bulwark',
      'rust-spray',
      'strike+',
      'counterstroke',
      'strike+',
      'defend',
    ];
    const { flow, ui, head } = rig(deck);
    flow.newRun(SEED);
    ui.sync(head);
    ui.openMenu(head);
    ui.activate('menu-deck');
    expect(ui.deckCards).toEqual(deck.slice(0, DECK_PAGE_SIZE));
    expect(faces(ui)?.getObjectByName('deck-stack-count-strike+')?.userData.labelText).toBe('×3');
    expect(faces(ui)?.getObjectByName('deck-stack-count-strike')).toBeUndefined();
    expect(ui.activate('menu-deck-nav-prev')).toBe(false);
    expect(ui.activate('menu-deck-nav-next')).toBe(true);
    expect(ui.deckCards).toEqual(deck.slice(8, 14));
    expect(ui.activate('menu-deck-nav-next')).toBe(false);
    expect(ui.activate('menu-deck-defense')).toBe(true);
    expect(ui.deckCards.slice(0, 5)).toEqual([
      'defend',
      'warding-glyph',
      'rivet-plate',
      'counterstroke',
      'brass-bulwark',
    ]);
    expect(ui.activate('menu-deck-nav-prev')).toBe(false);
    expect(ui.activate('menu-deck-offense')).toBe(true);
    expect(ui.deckCards.slice(0, 7)).toEqual([
      'strike',
      'cog-toss',
      'strike+',
      'iron-knuckle',
      'arc-bolt',
      'ratchet-flurry',
      'counterstroke',
    ]);
    expect(ui.activate('menu-deck-utility')).toBe(true);
    expect(ui.deckCards.slice(0, 3)).toEqual(['release-valve', 'time-spiral', 'rust-spray']);
    expect(ui.activate('menu-deck-nav-next')).toBe(true);
    expect(ui.activate('menu-deck-nav-prev')).toBe(true);
    expect(ui.activate('menu-deck-order')).toBe(true);
    expect(ui.deckCards).toEqual(deck.slice(0, DECK_PAGE_SIZE));
    expect(flow.run?.deck).toEqual(deck);
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
    const count = flow.run?.deck.filter((id) => id === picked).length ?? 0;
    expect(ui.deckCards.filter((id) => id === picked)).toHaveLength(1);
    if (count > 1)
      expect(faces(ui)?.getObjectByName(`deck-stack-count-${picked}`)?.userData.labelText).toBe(
        `×${count}`,
      );
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
