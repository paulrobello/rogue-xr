import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { CARD_FLIGHT_SECONDS } from '../src/flow/card-flight.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { FlowUi, type FlyTarget, tableDistanceCell } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/persist/db.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { ButtonEdge, MENU_BUTTON } from '../src/xr/menu-button.ts';

const SEED = 'BRASS042';

function rig(fly: (() => FlyTarget | null) | undefined = undefined) {
  const flow = new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
  let settings: Settings = { ...DEFAULT_SETTINGS };
  const applied: Settings[] = [];
  const ui = new FlowUi({
    flow,
    keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
    seed: SEED,
    snapshot: () => null,
    settings: () => settings,
    onNewRun: (seed) => flow.newRun(seed),
    onContinue: () => {},
    onSettings: (next) => {
      settings = next;
      applied.push(next);
    },
    rewardCards: { art: null, loadArt: false, syncLabels: false },
    ...(fly ? { flyTarget: fly } : {}),
  });
  const head = new THREE.Object3D();
  head.position.set(0, 1.6, 0);
  return { flow, ui, head, applied, settings: () => settings };
}

describe('in-run menu (card A)', () => {
  it('opens over exploring and fighting, closes with Resume or a second toggle, and never elsewhere', () => {
    const { flow, ui, head } = rig();
    ui.sync(head);
    expect(ui.openMenu(head)).toBe(false);
    flow.newRun(SEED);
    ui.sync(head);
    expect(ui.visible).toBe(false);
    expect(ui.toggleMenu(head)).toBe(true);
    expect(ui.menuOpen).toBe(true);
    expect(ui.visible).toBe(true);
    expect(ui.controlIds()).toEqual(
      expect.arrayContaining(['menu-resume', 'menu-abandon', 'menu-foveation-high']),
    );
    expect(ui.controlIds()).toContain(`menu-${tableDistanceCell(1.3)}`);
    expect(ui.toggleMenu(head)).toBe(true);
    expect(ui.menuOpen).toBe(false);
    expect(ui.visible).toBe(false);

    flow.fightStarted(2);
    ui.sync(head);
    expect(ui.openMenu(head)).toBe(true);
    expect(ui.activate('menu-resume')).toBe(true);
    expect(ui.menuOpen).toBe(false);
    expect(flow.phase).toBe('combat');
    ui.dispose();
  });

  it('applies foveation, table distance and the FPS counter at once through onSettings', () => {
    const { flow, ui, head, applied, settings } = rig();
    flow.newRun(SEED);
    ui.sync(head);
    ui.openMenu(head);
    expect(ui.activate('menu-foveation-high')).toBe(true);
    expect(ui.activate(`menu-${tableDistanceCell(0.9)}`)).toBe(true);
    expect(ui.activate('menu-fpsCounter-on')).toBe(true);
    expect(applied).toHaveLength(3);
    expect(settings()).toMatchObject({ foveation: 'high', tableDistance: 0.9, fpsCounter: true });
    // The menu stays up on its new choices.
    expect(ui.menuOpen).toBe(true);
    expect(ui.controlIds()).toContain('menu-resume');
    ui.dispose();
  });

  it('the title settings offer the FPS counter too', () => {
    const { flow, ui, head, settings } = rig();
    flow.openSettings();
    ui.sync(head);
    expect(ui.activate('settings-fpsCounter-on')).toBe(true);
    expect(settings().fpsCounter).toBe(true);
    expect(ui.activate('settings-fpsCounter-off')).toBe(true);
    expect(settings().fpsCounter).toBe(false);
    ui.dispose();
  });

  it('abandon asks first: No goes back, Yes ends the run on the title', () => {
    const { flow, ui, head } = rig();
    flow.newRun(SEED);
    flow.fightStarted(2);
    ui.sync(head);
    ui.openMenu(head);
    expect(ui.activate('menu-abandon')).toBe(true);
    expect(ui.menuView).toBe('confirm');
    expect(flow.phase).toBe('combat');
    expect(ui.activate('menu-confirm-no')).toBe(true);
    expect(ui.menuView).toBe('main');
    ui.activate('menu-abandon');
    expect(ui.activate('menu-confirm-yes')).toBe(true);
    expect(flow.phase).toBe('title');
    expect(flow.run).toBeNull();
    ui.sync(head);
    expect(ui.menuOpen).toBe(false);
    expect(ui.controlIds()).toContain('title-new-run');
    ui.dispose();
  });

  it('a phase change under the menu closes it', () => {
    const { flow, ui, head } = rig();
    flow.newRun(SEED);
    flow.fightStarted(2);
    ui.sync(head);
    ui.openMenu(head);
    flow.fightEnded({ room: 2, outcome: 'win', tier: 'regular' });
    ui.sync(head);
    expect(ui.menuOpen).toBe(false);
    expect(ui.controlIds()).toContain('reward-skip-skip');
    ui.dispose();
  });
});

describe('in-run menu placement', () => {
  it('sits fully in a desktop view, level or pitched down as combat framing pitches it', () => {
    for (const pitch of [0, -0.53]) {
      const { flow, ui } = rig();
      flow.newRun(SEED);
      flow.fightStarted(2);
      const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
      camera.position.set(3, 1.2, -4);
      camera.rotation.set(pitch, 0.7, 0, 'YXZ');
      camera.updateMatrixWorld(true);
      ui.sync(camera);
      expect(ui.openMenu(camera)).toBe(true);
      ui.root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(
        ui.root.getObjectByName('menu-board') as THREE.Object3D,
      );
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y])
          for (const z of [box.min.z, box.max.z]) {
            const p = new THREE.Vector3(x, y, z).project(camera);
            expect(Math.abs(p.x), `pitch ${pitch} x`).toBeLessThanOrEqual(1);
            expect(Math.abs(p.y), `pitch ${pitch} y`).toBeLessThanOrEqual(1);
          }
      ui.dispose();
    }
  });
});

describe('XR menu button', () => {
  it('is the left Y button, and a press toggles once however long it is held', () => {
    expect(MENU_BUTTON).toEqual({ side: 'left', index: 5 });
    const edge = new ButtonEdge();
    expect([false, true, true, true, false, true].map((p) => edge.step(p))).toEqual([
      false,
      true,
      false,
      false,
      false,
      true,
    ]);
  });
});

describe('reward card flight (card C)', () => {
  const toReward = (flow: RunFlow, ui: FlowUi, head: THREE.Object3D) => {
    flow.newRun(SEED);
    flow.fightStarted(1);
    flow.fightEnded({ room: 1, outcome: 'win', tier: 'regular' });
    ui.sync(head);
  };

  it('a pick flies the card to the player, then takes it into the deck once and closes the board', () => {
    const hand = new THREE.Object3D();
    hand.position.set(0.25, 1.1, -0.3);
    const { flow, ui, head } = rig(() => ({ object: hand, standoff: 0 }));
    toReward(flow, ui, head);
    const card = flow.offer?.cards[0] as string;
    const deck = flow.run?.deck.length ?? 0;
    let deckChanges = 0;
    flow.onChange((e) => {
      if (e.type === 'phase' && e.from === 'reward') deckChanges += 1;
    });
    expect(ui.activate(`reward-${card}`)).toBe(true);
    // In flight: the board is still up and owns the pick.
    expect(ui.claiming).toBe(true);
    expect(flow.phase).toBe('reward');
    expect(flow.run?.deck.length).toBe(deck);
    const flying = ui.root.getObjectByName('reward-flight');
    expect(flying).toBeDefined();
    const start = flying?.getWorldPosition(new THREE.Vector3()) as THREE.Vector3;
    const handAt = hand.getWorldPosition(new THREE.Vector3());
    // A second pick, or Skip, during the flight does nothing.
    expect(ui.activate(`reward-${flow.offer?.cards[1]}`)).toBe(false);
    expect(ui.activate('reward-skip-skip')).toBe(false);

    ui.update(CARD_FLIGHT_SECONDS / 2);
    const mid = flying?.getWorldPosition(new THREE.Vector3()) as THREE.Vector3;
    expect(mid.distanceTo(handAt)).toBeLessThan(start.distanceTo(handAt));
    expect(flying?.scale.x).toBeLessThan(1);
    expect(flow.phase).toBe('reward');

    ui.update(CARD_FLIGHT_SECONDS / 2 + 1e-3);
    expect(ui.claiming).toBe(false);
    expect(flow.phase).toBe('explore');
    expect(flow.run?.deck.length).toBe(deck + 1);
    expect(flow.run?.deck.at(-1)).toBe(card);
    expect(ui.root.getObjectByName('reward-flight')).toBeUndefined();
    ui.sync(head);
    expect(ui.visible).toBe(false);
    // Further frames change nothing.
    ui.update(1);
    expect(flow.run?.deck.length).toBe(deck + 1);
    expect(deckChanges).toBe(1);
    ui.dispose();
  });

  it('Skip still closes the board at once', () => {
    const { flow, ui, head } = rig(() => ({ object: head, standoff: 0.3 }));
    toReward(flow, ui, head);
    const deck = flow.run?.deck.length;
    expect(ui.activate('reward-skip-skip')).toBe(true);
    expect(ui.claiming).toBe(false);
    expect(flow.phase).toBe('explore');
    expect(flow.run?.deck.length).toBe(deck);
    ui.dispose();
  });
});
