import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { PERMANENT_CARD_IDS, REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { FlowUi, splitControlId, tableDistanceCell } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

describe('splitControlId', () => {
  const boards = ['reward-info', 'reward'];

  it('picks the longest board name that prefixes the id', () => {
    expect(splitControlId(boards, 'reward-skip-skip')).toEqual({
      board: 'reward',
      cell: 'skip-skip',
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
  it('offers only cards, with no Skip control', () => {
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
    expect(ui.controlIds()).not.toContain('reward-skip-skip');
    expect(ui.controlIds().some((id) => id.startsWith('reward-'))).toBe(true);
    ui.dispose();
  });
});

describe('FlowUi permanent-card shop', () => {
  it('browses, buys, reports ownership, paginates, and returns to the workshop', () => {
    const flow = new RunFlow({
      workshop: { ...createWorkshop(), cogsBanked: 60 },
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
    flow.openWorkshop();
    ui.sync(head);
    expect(ui.controlIds()).toContain('workshop-permanent-cards');

    expect(ui.activate('workshop-permanent-cards')).toBe(true);
    const first = PERMANENT_CARD_IDS[0] as string;
    expect(ui.controlIds()).toContain(`workshop-buy-permanent-${first}`);
    expect(ui.root.getObjectByName(`workshop-permanent-effect-${first}`)).toBeDefined();
    const inspect = (id: string) => {
      const thumbnail = ui.root.getObjectByName(`workshop-card-${id}`);
      if (!thumbnail) throw new Error(`Missing icon for ${id}`);
      ui.root.updateWorldMatrix(true, true);
      const origin = head.getWorldPosition(new THREE.Vector3());
      const ray = new THREE.Raycaster(
        origin,
        thumbnail.getWorldPosition(new THREE.Vector3()).sub(origin).normalize(),
      );
      const firstHit = ray.intersectObjects(ui.targets(), true)[0];
      if (!firstHit) throw new Error(`Ray missed ${id}`);
      const control = ui.controlAt(firstHit.object);
      expect(control).toBe(thumbnail.name);
      ui.hover(control);
      const face = ui.root.getObjectByName(`workshop-card-preview-${id}`);
      expect(face?.visible).toBe(true);
      return face;
    };
    const firstFace = inspect(first);
    expect(ui.activate(`workshop-card-${first}`)).toBe(true);
    const costlyFace = inspect('escapement-hammer');
    expect(firstFace?.visible).toBe(false);
    ui.hover(null);
    expect(costlyFace?.visible).toBe(false);
    expect(flow.workshop.permanentCards).toEqual([]);
    expect(flow.workshop.cogsBanked).toBe(60);

    expect(ui.activate(`workshop-buy-permanent-${first}`)).toBe(true);
    expect(flow.workshop.permanentCards).toContain(first);
    expect(flow.workshop.cogsBanked).toBe(0);
    expect(ui.root.getObjectByName('workshop-feedback')).toBeDefined();
    expect(ui.activate(`workshop-buy-permanent-${first}`)).toBe(false);

    expect(ui.root.getObjectByName(`workshop-card-preview-${first}`)).toBeUndefined();
    const ownedFace = inspect(first);
    expect(flow.workshop.cogsBanked).toBe(0);

    expect(ui.controlIds()).toContain('workshop-next-page');
    expect(ui.activate('workshop-next-page')).toBe(true);
    expect(ui.root.getObjectByName('workshop-page')).toBeDefined();
    expect(ownedFace?.parent).toBeNull();
    expect(ui.root.getObjectByName(`workshop-card-${first}`)).toBeUndefined();
    expect(ui.activate('workshop-previous-page')).toBe(true);
    expect(ui.activate('workshop-back')).toBe(true);
    expect(ui.controlIds()).toContain('workshop-permanent-cards');
    expect(ui.activate('workshop-back')).toBe(true);
    expect(flow.phase).toBe('title');
    ui.dispose();
  });
});

describe('FlowUi XR recenter (XO5)', () => {
  const makeUi = (flow: RunFlow) =>
    new FlowUi({
      flow,
      keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
      seed: 'BRASS042',
      snapshot: () => null,
      settings: () => ({ ...DEFAULT_SETTINGS }),
      onNewRun: (seed) => flow.newRun(seed),
      onContinue: () => {},
      onSettings: () => {},
    });
  const makeFlow = () =>
    new RunFlow({ workshop: createWorkshop(), starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });
  /** Horizontal bearing of the title board from the head, radians (0 is straight ahead). */
  const bearing = (ui: FlowUi, head: THREE.Object3D): number => {
    head.updateMatrixWorld(true);
    ui.root.updateMatrixWorld(true);
    const board = ui.root.getObjectByName('title-board');
    if (!board) throw new Error('no title board');
    const to = board
      .getWorldPosition(new THREE.Vector3())
      .sub(head.getWorldPosition(new THREE.Vector3()));
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      head.getWorldQuaternion(new THREE.Quaternion()),
    );
    return Math.atan2(forward.x * to.z - forward.z * to.x, forward.x * to.x + forward.z * to.z);
  };

  it('re-places the title in front of a head that turned away before the session started', () => {
    const flow = makeFlow();
    const ui = makeUi(flow);
    // The desktop places the title from the desktop camera, facing -Z.
    const rig = new THREE.Group();
    const head = new THREE.Object3D();
    rig.add(head);
    head.position.set(0, 1.6, 0);
    ui.sync(head);
    expect(flow.phase).toBe('title');
    expect(Math.abs(bearing(ui, head))).toBeLessThan(0.6);

    // Enter VR facing the other way, with the seated lift on the rig: the board is behind.
    head.position.set(0.1, 1.2, 0.05);
    head.rotation.set(-0.1, Math.PI, 0, 'YXZ');
    rig.position.y = 0.4;
    rig.updateMatrixWorld(true);
    ui.sync(head);
    expect(Math.abs(bearing(ui, head))).toBeGreaterThan(2.5);

    ui.recenter(head);
    expect(Math.abs(bearing(ui, head))).toBeLessThan(0.6);
    // The same layout as any placement: the root sits on the eye, level.
    const eye = head.getWorldPosition(new THREE.Vector3());
    expect(ui.root.position.distanceTo(eye)).toBeLessThan(1e-9);
    expect(ui.root.rotation.x).toBe(0);
    ui.dispose();
  });

  it('leaves a hidden flow (exploring) alone', () => {
    const flow = makeFlow();
    const ui = makeUi(flow);
    const head = new THREE.Object3D();
    flow.newRun('BRASS042');
    ui.sync(head);
    expect(ui.visible).toBe(false);
    head.rotation.y = Math.PI;
    ui.recenter(head);
    expect(ui.root.rotation.y).toBe(0);
    ui.dispose();
  });
});

describe('FlowUi settings board comfort toggles', () => {
  it('flips teleport and turn mode through onSettings and shows the new state', () => {
    const flow = new RunFlow({
      workshop: createWorkshop(),
      starterDeck: STARTER_DECK,
      rewardPool: REWARD_POOL,
    });
    let stored = { ...DEFAULT_SETTINGS };
    const saved: (typeof DEFAULT_SETTINGS)[] = [];
    const ui = new FlowUi({
      flow,
      keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
      seed: 'BRASS042',
      snapshot: () => null,
      settings: () => stored,
      onNewRun: (seed) => flow.newRun(seed),
      onContinue: () => {},
      onSettings: (next) => {
        stored = next;
        saved.push(next);
      },
    });
    const head = new THREE.Object3D();
    ui.sync(head);
    expect(flow.openSettings()).toBe(true);
    ui.sync(head);
    expect(ui.controlIds()).toContain('settings-teleportEnabled-toggle');
    expect(ui.controlIds()).toContain('settings-turnMode-toggle');

    expect(stored.teleportEnabled).toBe(true);
    expect(ui.activate('settings-teleportEnabled-toggle')).toBe(true);
    expect(stored.teleportEnabled).toBe(false);
    expect(ui.activate('settings-turnMode-toggle')).toBe(true);
    expect(stored.turnMode).toBe('smooth');
    expect(ui.activate('settings-teleportEnabled-toggle')).toBe(true);
    expect(stored.teleportEnabled).toBe(true);
    expect(saved).toHaveLength(3);
    // Each flip keeps the other fields (volumes are untouched).
    expect(stored.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
    ui.dispose();
  });
});

describe('FlowUi settings board table distance and foveation (F3, F4)', () => {
  it('offers 0.9 to 1.3 m and off to high, shows the choice and saves a pick', () => {
    const flow = new RunFlow({
      workshop: createWorkshop(),
      starterDeck: STARTER_DECK,
      rewardPool: REWARD_POOL,
    });
    let stored = { ...DEFAULT_SETTINGS };
    const ui = new FlowUi({
      flow,
      keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
      seed: 'BRASS042',
      snapshot: () => null,
      settings: () => stored,
      onNewRun: (seed) => flow.newRun(seed),
      onContinue: () => {},
      onSettings: (next) => {
        stored = next;
      },
    });
    const selected = () => [...(ui as unknown as { selectedIds: Set<string> }).selectedIds];
    const head = new THREE.Object3D();
    flow.openSettings();
    ui.sync(head);
    const ids = ui.controlIds();
    for (const cell of [
      'tableDistance-9',
      'tableDistance-10',
      'tableDistance-11',
      'tableDistance-12',
      'tableDistance-13',
    ]) {
      expect(ids).toContain(`settings-${cell}`);
    }
    for (const level of ['off', 'low', 'medium', 'high']) {
      expect(ids).toContain(`settings-foveation-${level}`);
    }
    expect(tableDistanceCell(1.1)).toBe('tableDistance-11');
    expect(selected()).toEqual(
      expect.arrayContaining(['settings-tableDistance-11', 'settings-foveation-medium']),
    );

    expect(ui.activate('settings-tableDistance-13')).toBe(true);
    expect(stored.tableDistance).toBe(1.3);
    expect(ui.activate('settings-foveation-high')).toBe(true);
    expect(stored.foveation).toBe('high');
    expect(stored.tableDistance).toBe(1.3);
    expect(stored.masterVolume).toBe(DEFAULT_SETTINGS.masterVolume);
    expect(selected()).toEqual(
      expect.arrayContaining(['settings-tableDistance-13', 'settings-foveation-high']),
    );
    expect(selected()).not.toContain('settings-tableDistance-11');
    ui.dispose();
  });
});
