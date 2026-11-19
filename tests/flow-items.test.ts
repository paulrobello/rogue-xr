import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { FlowUi } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import type { PressureNoteId } from '../src/rules/pressure.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

function setup(onNoteOpened?: (at: THREE.Vector3) => void) {
  const flow = new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
  const records = new Map<
    PressureNoteId,
    { id: PressureNoteId; title: string; body: string; source: 'floor' }
  >([
    [
      'A',
      {
        id: 'A',
        title: 'Circuit A',
        body: 'Follow the red pipe to the first wheel.',
        source: 'floor',
      },
    ],
    [
      'B',
      { id: 'B', title: 'Circuit B', body: 'The second wheel answers the first.', source: 'floor' },
    ],
    [
      'C',
      {
        id: 'C',
        title: 'Circuit C',
        body: 'The last mark is hidden by the brass plate.',
        source: 'floor',
      },
    ],
    [
      'dispatch',
      { id: 'dispatch', title: 'Dispatch', body: 'Look for the marked circuit.', source: 'floor' },
    ],
  ]);
  const ui = new FlowUi({
    flow,
    keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
    seed: 'BRASS042',
    snapshot: () => null,
    settings: () => ({ ...DEFAULT_SETTINGS }),
    onNewRun: (seed) => flow.newRun(seed),
    onContinue: () => {},
    onSettings: () => {},
    onNoteOpened,
    noteRecord: (id) => records.get(id) ?? null,
  });
  return { flow, ui, head: new THREE.Object3D() };
}

describe('FlowUi pressure Items', () => {
  it('shows an explicit empty state and works while exploring and fighting', () => {
    const { flow, ui, head } = setup();
    flow.newRun('BRASS042');
    ui.openMenu(head);
    expect(ui.controlIds()).toContain('menu-items');
    expect(ui.activate('menu-items')).toBe(true);
    expect(ui.root.getObjectByName('menu-items-empty')?.userData.labelText).toBe(
      'No items collected yet',
    );
    ui.closeMenu();
    flow.fightStarted(1);
    expect(ui.openMenu(head)).toBe(true);
    expect(ui.activate('menu-items')).toBe(true);
    expect(ui.root.getObjectByName('menu-items-empty')?.userData.labelText).toBe(
      'No items collected yet',
    );
    ui.dispose();
  });

  it('lists only normalized acquired notes and opens the same readable sheet', () => {
    const { flow, ui, head } = setup();
    flow.newRun('BRASS042');
    flow.collectPressureNote(1, 'A');
    ui.openMenu(head);
    ui.activate('menu-items');
    expect(ui.controlIds()).toContain('menu-items-item-A');
    expect(ui.controlIds()).not.toContain('menu-items-item-B');
    expect(ui.activate('menu-items-item-A')).toBe(true);
    expect(ui.controlIds()).toContain('menu-note-back');
    expect(ui.controlIds()).toContain('menu-note-resume');
    expect(ui.root.getObjectByName('menu-note-sheet')).toBeDefined();
    expect(ui.root.getObjectByName('menu-note-sheet')?.userData.noteId).toBe('A');
    ui.dispose();
  });

  it('readNote opens a physical sheet with Put away and Items controls', () => {
    const { flow, ui, head } = setup();
    flow.newRun('BRASS042');
    flow.collectPressureNote(1, 'A');
    expect(ui.readNote('A', head)).toBe(true);
    expect(ui.controlIds()).toContain('menu-note-put-away');
    expect(ui.controlIds()).toContain('menu-note-items');
    expect(ui.activate('menu-note-put-away')).toBe(true);
    expect(ui.menuView).toBe('closed');
    ui.dispose();
  });
});

it('unfolds at the sheet on pickup and on reread, once per opening', () => {
  const positions: THREE.Vector3[] = [];
  const { ui, flow, head } = setup((at) => positions.push(at.clone()));
  flow.newRun('BRASS042');
  expect(ui.readNote('A', head)).toBe(false);
  flow.collectPressureNote(1, 'A');
  ui.readNote('A', head);
  ui.readNote('A', head);
  ui.refresh();
  expect(positions).toHaveLength(1);
  ui.activate('menu-note-items');
  ui.activate('menu-items-item-A');
  expect(positions).toHaveLength(2);
  const sheet = ui.root.getObjectByName('menu-note-sheet');
  expect(sheet?.getWorldPosition(new THREE.Vector3()).distanceTo(positions[1])).toBeLessThan(0.001);
  ui.dispose();
});
