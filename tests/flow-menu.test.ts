import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { CARD_FLIGHT_SECONDS } from '../src/flow/card-flight.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { FlowUi, type FlyTarget, tableDistanceCell } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/persist/db.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { ButtonEdge, MAP_BUTTON, MENU_BUTTON } from '../src/xr/menu-button.ts';

const SEED = 'BRASS042';

function rig(
  fly: (() => FlyTarget | null) | undefined = undefined,
  seatHasRoom?: (distance: number) => boolean,
) {
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
    setTableDistance: seatHasRoom,
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
      expect.arrayContaining(['menu-resume', 'menu-settings', 'menu-deck', 'menu-items']),
    );
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

  it('only saves a table-distance choice after moving to a clear seat', () => {
    let blocked = false;
    const r = rig(undefined, () => !blocked);
    r.flow.newRun(SEED);
    r.ui.sync(r.head);
    r.ui.openMenu(r.head);
    r.ui.activate('menu-tableDistance-12');
    blocked = true;
    r.ui.activate('menu-tableDistance-13');
    expect(r.settings().tableDistance).toBe(1.2);
    expect(r.applied.map((s) => s.tableDistance)).toEqual([1.2]);
    blocked = false;
    r.ui.activate('menu-tableDistance-13');
    expect(r.settings().tableDistance).toBe(1.3);
    r.ui.dispose();
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

  it('opens the minimap page from title and in-run settings, saving and marking choices', () => {
    const { flow, ui, head, settings } = rig();
    const selected = () => [...(ui as unknown as { selectedIds: Set<string> }).selectedIds];
    flow.openSettings();
    ui.sync(head);
    expect(ui.controlIds()).toContain('settings-minimap');
    expect(ui.activate('settings-minimap')).toBe(true);
    expect(ui.controlIds()).toEqual(
      expect.arrayContaining([
        'minimap-enabled-on',
        'minimap-north-up-off',
        'minimap-zoom-0.25',
        'minimap-zoom-0.5',
        'minimap-zoom-0.75',
        'minimap-zoom-1',
        'minimap-horizontal',
        'minimap-vertical',
      ]),
    );
    expect(ui.activate('minimap-enabled-on')).toBe(true);
    expect(ui.activate('minimap-north-up-off')).toBe(true);
    expect(ui.activate('minimap-zoom-0.75')).toBe(true);
    expect(settings()).toMatchObject({
      minimapEnabled: true,
      minimapNorthUp: false,
      minimapZoom: 0.75,
    });
    expect(selected()).toEqual(
      expect.arrayContaining(['minimap-enabled-on', 'minimap-north-up-off', 'minimap-zoom-0.75']),
    );

    const board = ui.root.getObjectByName('minimap-board');
    const horizontal = board?.getObjectByName('minimap-horizontal-rail');
    expect(horizontal).toBeTruthy();
    if (!horizontal) throw new Error('horizontal minimap slider rail missing');
    horizontal?.updateWorldMatrix(true, false);
    const center = horizontal.getWorldPosition(new THREE.Vector3());
    const ray = new THREE.Ray(
      center.clone().add(new THREE.Vector3(0, 0, 1)),
      new THREE.Vector3(0, 0, -1),
    );
    expect(ui.startMinimapSlider('minimap-horizontal', ray)).toBe(true);
    const moved = ray.clone();
    moved.origin.x += 0.08;
    expect(ui.dragMinimapSlider(moved)).toBe(true);
    expect(ui.minimapPlacementPreview?.minimapHorizontal).toBeGreaterThan(0);
    const originalHorizontal = settings().minimapHorizontal;
    ui.finishMinimapSlider(false);
    expect(settings().minimapHorizontal).toBe(originalHorizontal);
    expect(ui.startMinimapSlider('minimap-horizontal', ray)).toBe(true);
    expect(ui.dragMinimapSlider(moved)).toBe(true);
    ui.finishMinimapSlider(true);
    expect(settings().minimapHorizontal).toBeGreaterThan(0);
    expect(ui.activate('minimap-back')).toBe(true);
    expect(ui.activate('settings-back')).toBe(true);

    expect(flow.newRun(SEED)).toBe(true);
    ui.sync(head);
    expect(ui.openMenu(head)).toBe(true);
    expect(ui.activate('menu-settings')).toBe(true);
    expect(ui.activate('settings-minimap')).toBe(true);
    expect(ui.menuView).toBe('minimap');
    expect(ui.activate('minimap-back')).toBe(true);
    expect(ui.menuView).toBe('settings');
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
    expect(ui.controlIds()).not.toContain('reward-skip-skip');
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
      ui.update(0.8);
      ui.root.updateMatrixWorld(true);
      const wheel = ui.root.getObjectByName('radial-menu');
      if (!wheel) throw new Error('Missing radial menu');
      const ring = wheel.getObjectByName('menu-clockwork-rim');
      if (!ring) throw new Error('Missing clockwork bezel');
      let vertices = 0;
      const point = new THREE.Vector3();
      ring.traverse((part) => {
        if (!(part instanceof THREE.Mesh)) return;
        const positions = part.geometry.getAttribute('position');
        const count = part instanceof THREE.InstancedMesh ? part.count : 1;
        const matrix = new THREE.Matrix4();
        for (let instance = 0; instance < count; instance++) {
          if (part instanceof THREE.InstancedMesh) part.getMatrixAt(instance, matrix);
          for (let i = 0; i < positions.count; i++) {
            point
              .fromBufferAttribute(positions, i)
              .applyMatrix4(matrix)
              .applyMatrix4(part.matrixWorld)
              .project(camera);
            if (Math.abs(point.x) > 1 || Math.abs(point.y) > 1)
              throw Error(`Wheel clipped at pitch ${pitch}: ${point.x}, ${point.y}`);
          }
        }
        vertices += positions.count * count;
      });
      expect(vertices).toBeGreaterThan(0);
      ui.dispose();
    }
  });
});

describe('XR menu button', () => {
  it('is the left Y button, and a press toggles once however long it is held', () => {
    expect(MENU_BUTTON).toEqual({ side: 'left', index: 5 });
    expect(MAP_BUTTON).toEqual({ side: 'left', index: 4 });
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
    // A second pick, or the removed Skip control, during the flight does nothing.
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

  it('has no Skip control on the reward board', () => {
    const { flow, ui, head } = rig(() => ({ object: head, standoff: 0.3 }));
    toReward(flow, ui, head);
    expect(ui.activate('reward-skip-skip')).toBe(false);
    expect(ui.claiming).toBe(false);
    expect(flow.phase).toBe('reward');
    ui.dispose();
  });
});
