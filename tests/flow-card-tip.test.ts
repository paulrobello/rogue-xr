/**
 * Playtest 2026-11-17: "effects on cards need a laser point explanation of what they do". On the
 * reward board and in the deck viewer, the card the laser or mouse rests on shows its keyword tip
 * (the combat hand's `cardTip` source), and the tip hides when the pointer leaves it.
 */
import { createPointer } from '@par/xr-workspace';
import * as THREE from 'three';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cardTip } from '../src/combat-view/card-keywords.ts';
import { getCard, STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { FlowUi } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

/** A do-nothing 2D context, so the tip's canvas label exists in happy-dom. */
function stubCanvas2d(): void {
  const handler: ProxyHandler<object> = {
    get: (_target, key) =>
      key === 'measureText'
        ? (text: string) => ({ width: String(text).length * 10 })
        : () => new Proxy({}, handler),
    set: () => true,
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => new Proxy({}, handler) as unknown as CanvasRenderingContext2D,
  );
}

function rig(seed: string) {
  const flow = new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
  const ui = new FlowUi({
    flow,
    keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
    seed,
    snapshot: () => null,
    settings: () => ({ ...DEFAULT_SETTINGS }),
    onNewRun: (s) => flow.newRun(s),
    onContinue: () => {},
    onSettings: () => {},
    rewardCards: { art: null, loadArt: false, syncLabels: false },
  });
  const head = new THREE.Object3D();
  head.position.set(0, 1.6, 0);
  head.updateMatrixWorld(true);
  return { flow, ui, head };
}

const titlesOf = (id: string): string[] => cardTip(getCard(id)).map((e) => e.title);
const tipMesh = (ui: FlowUi) => ui.root.getObjectByName('flow-card-tip');

/** The control the pointer cast from `head` through `target` lands on, the way main.ts picks. */
function pick(ui: FlowUi, head: THREE.Object3D, target: THREE.Object3D): string | null {
  ui.root.updateMatrixWorld(true);
  const origin = head.getWorldPosition(new THREE.Vector3());
  const at = target.getWorldPosition(new THREE.Vector3());
  const hit = createPointer({ far: 6 }).cast(origin, at.sub(origin).normalize(), ui.targets());
  return hit ? ui.controlAt(hit.object) : null;
}

describe('card keyword tip on the reward board and the deck viewer', () => {
  beforeAll(() => stubCanvas2d());
  afterAll(() => vi.restoreAllMocks());

  it('shows a reward card its keywords on hover and hides on unhover', () => {
    // A reward offer with a keyword card and one without (the seed only picks the offer).
    let found: { ui: FlowUi; keyed: string; plain: string | undefined } | null = null;
    for (let i = 0; i < 200 && !found; i++) {
      const { flow, ui, head } = rig(`TIPS${String(i).padStart(4, '0')}`);
      flow.newRun(`TIPS${String(i).padStart(4, '0')}`);
      flow.fightStarted(1);
      flow.fightEnded({ room: 1, outcome: 'win', tier: 'regular' });
      ui.sync(head);
      const cards = flow.offer?.cards ?? [];
      const keyed = cards.find((id) => titlesOf(id).length > 0);
      if (keyed) found = { ui, keyed, plain: cards.find((id) => titlesOf(id).length === 0) };
      else ui.dispose();
    }
    if (!found) throw new Error('no reward offer with a keyword card');
    const { ui, keyed, plain } = found;
    expect(ui.cardTipShown).toBeNull();
    ui.hover(`reward-${keyed}`);
    expect(ui.cardTipShown).toEqual({ id: keyed, titles: titlesOf(keyed) });
    const tip = tipMesh(ui);
    expect(tip?.visible).toBe(true);
    expect(tip?.parent?.name).toBe('reward-card-faces');
    ui.hover('reward-skip-skip');
    expect(ui.cardTipShown).toBeNull();
    expect(tipMesh(ui)).toBeUndefined();
    if (plain) {
      ui.hover(`reward-${plain}`);
      expect(ui.cardTipShown).toBeNull();
    }
    ui.hover(`reward-${keyed}`);
    ui.hover(null);
    expect(ui.cardTipShown).toBeNull();
    expect(tip?.visible).toBe(false);
    ui.dispose();
  });

  it('lets the pointer rest on a deck viewer card, shows its keywords and hides on unhover', () => {
    const { flow, ui, head } = rig('BRASS042');
    flow.newRun('BRASS042');
    ui.sync(head);
    ui.openMenu(head);
    expect(ui.activate('menu-deck')).toBe(true);
    const hits = ui.root.getObjectByName('deck-card-hits');
    expect(hits?.children.length).toBe(ui.deckCards.length);
    const index = ui.deckCards.findIndex((id) => titlesOf(id).length > 0);
    expect(index).toBeGreaterThanOrEqual(0);
    const id = ui.deckCards[index] as string;
    // Laser and mouse both resolve through `targets` and `controlAt`.
    const control = pick(ui, head, hits?.children[index] as THREE.Object3D);
    expect(control).toBe(`deck-card-${index}`);
    ui.hover(control);
    expect(ui.cardTipShown).toEqual({ id, titles: titlesOf(id) });
    expect(tipMesh(ui)?.visible).toBe(true);
    expect(tipMesh(ui)?.parent?.name).toBe('deck-card-faces');
    // A deck card is for reading only.
    expect(ui.activate(`deck-card-${index}`)).toBe(false);
    ui.hover(null);
    expect(ui.cardTipShown).toBeNull();
    expect(tipMesh(ui)).toBeUndefined();
    // Leaving the viewer takes its hit planes with it.
    expect(ui.activate('menu-deck-nav-back')).toBe(true);
    expect(ui.root.getObjectByName('deck-card-hits')).toBeUndefined();
    ui.dispose();
  });
});
