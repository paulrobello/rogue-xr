import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ENCOUNTER_CONTENT_VERSION } from '../src/combat/encounter-choice.ts';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { worldRooms } from '../src/floor/generate.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { chartFloor, FIT_MAP_VIEW, type LogbookMap, moveMapView } from '../src/flow/logbook-map.ts';
import { FlowUi } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import { bellMelody } from '../src/rules/bell-chimes.ts';
import type { PressureNoteId } from '../src/rules/pressure.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';

function setup(
  onNoteOpened?: (at: THREE.Vector3) => void,
  logbookMaps?: () => readonly LogbookMap[],
) {
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
    logbookMaps,
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

  it('keeps the four learned bell numbers readable upstairs', () => {
    const { flow, ui, head } = setup();
    flow.newRun('MAPTEST2');
    flow.listenToChimes();
    flow.travelToFloor(2, 0);
    ui.openMenu(head);
    ui.activate('menu-items');
    const score = ui.root.getObjectByName('menu-items-bell-score')?.userData.labelText;
    expect(score).toBe(
      `Bell score · ${bellMelody('MAPTEST2')
        .map((note) => note + 1)
        .join(' · ')}`,
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

it('saves only selected clues, persists their contents across floors, and turns a leaf through the spine', () => {
  const rustles: THREE.Vector3[] = [];
  const { ui, flow, head } = setup((at) => {
    rustles.push(at.clone());
  });
  flow.newRun('MAPTEST2');
  flow.collectPressureNote(1, 'A');
  flow.collectPressureNote(2, 'B');
  flow.collectPressureNote(3, 'C');
  expect(flow.logbookEntries).toHaveLength(0);
  expect(ui.readNote('A', head)).toBe(true);
  expect(ui.activate('menu-note-save-logbook')).toBe(true);
  expect(ui.menuView).toBe('logbook');
  expect(ui.root.getObjectByName('logbook-left-page')?.userData.clueId).toBe('A');
  ui.closeMenu();
  ui.readNote('A', head);
  ui.activate('menu-note-save-logbook');
  expect(flow.logbookEntries).toHaveLength(1);
  for (const id of ['B', 'C'] as const) {
    ui.closeMenu();
    ui.readNote(id, head);
    ui.activate('menu-note-save-logbook');
  }
  ui.closeMenu();
  flow.travelToFloor(2, 0);
  const saved = validateSnapshot(flow.snapshot());
  const resumed = setup();
  expect(resumed.flow.continueRun(saved)).toBe(true);
  expect(resumed.flow.logbookEntries).toEqual(flow.logbookEntries);
  expect(resumed.flow.logbookEntries.map(({ id }) => id)).toEqual(['A', 'B', 'C']);
  ui.openMenu(head);
  expect(ui.activate('menu-logbook')).toBe(true);
  const soundsBeforeTurn = rustles.length;
  expect(ui.activate('menu-logbook-next')).toBe(true);
  ui.update(0.27);
  const moving = ui.root.getObjectByName('logbook-turn-front') as THREE.Mesh;
  expect(moving.visible).toBe(true);
  const coordinates = moving.geometry.getAttribute('position').array;
  expect(coordinates.some((z, i) => i % 3 === 2 && z > 0.3)).toBe(true);
  expect(rustles).toHaveLength(soundsBeforeTurn + 1);
  ui.update(2);
  expect(moving.visible).toBe(false);
  expect(ui.root.getObjectByName('logbook-left-page')?.userData.clueId).toBe('C');
  ui.dispose();
  resumed.ui.dispose();
});

it('shows a map before saving any clues and starts on the current floor', () => {
  const maps: LogbookMap[] = [
    { floor: 1, rooms: [], doors: [] },
    { floor: 2, rooms: [], doors: [], player: { room: 1, label: 'study', position: [1, 2] } },
  ];
  const { ui, flow, head } = setup(undefined, () => maps);
  flow.newRun('MAPTEST2');
  flow.travelToFloor(2, 1);
  ui.openMenu(head);
  ui.activate('menu-logbook');
  expect(flow.logbookEntries).toHaveLength(0);
  expect(ui.activate('menu-logbook-map')).toBe(true);
  const pageMap = () => ui.root.getObjectByName('logbook-right-page')?.userData.map;
  expect(pageMap()).toBe(maps[1]);
  expect(ui.activate('menu-logbook-previous')).toBe(true);
  ui.update(1);
  expect(pageMap()).toBe(maps[0]);
  expect(pageMap()).not.toHaveProperty('player');
  expect(ui.activate('menu-logbook-clues')).toBe(true);
  expect(pageMap()).toBeUndefined();
  ui.dispose();
});

it('charts only reached footprints and their mutual doorways', () => {
  const plan = playableFloorPlan('MAPTEST2', ENCOUNTER_CONTENT_VERSION);
  const world = worldRooms(plan);
  const pair = plan.connections[0];
  const position: readonly [number, number] = [0.1, -0.2];
  const onlyEntry = chartFloor(1, plan, world, [pair[0].room], { room: pair[0].room, position });
  expect(onlyEntry.rooms.map(({ id }) => id)).toEqual([pair[0].room]);
  expect(onlyEntry.doors).toHaveLength(0);
  expect(onlyEntry.player?.position).toEqual(position);
  const both = chartFloor(1, plan, world, [pair[0].room, pair[1].room]);
  expect(both.rooms.map(({ id }) => id).sort()).toEqual([pair[0].room, pair[1].room].sort());
  expect(both.doors).toHaveLength(1);
  expect(both.player).toBeUndefined();
});

it('clamps a zoomed floor to its chart and keeps the scroll anchor stable', () => {
  const map: LogbookMap = {
    floor: 1,
    rooms: [{ id: 0, bounds: { min: [-40, -40], max: [40, 40] } }],
    doors: [],
  };
  expect(moveMapView(map, FIT_MAP_VIEW, 500, -500, 1)).toEqual(FIT_MAP_VIEW);
  const zoom = moveMapView(map, FIT_MAP_VIEW, 0, 0, 2, [452, 614]);
  expect(zoom).toEqual({ zoom: 2, x: -100, y: -100 });
  const panned = moveMapView(map, zoom, -9_000, 9_000, 1);
  expect(panned.x).toBe(-274);
  expect(panned.y).toBe(213);
  expect(moveMapView(map, panned, 0, 0, 0.1)).toEqual(FIT_MAP_VIEW);
  expect(moveMapView(map, zoom, 0, 0, 100).zoom).toBe(6);
});

it('retains each map view across floors and keeps the run menu available', () => {
  const largeRoom = { id: 0, bounds: { min: [-40, -40], max: [40, 40] } } as const;
  const maps: LogbookMap[] = [
    { floor: 1, rooms: [largeRoom], doors: [] },
    { floor: 2, rooms: [largeRoom], doors: [] },
  ];
  const { ui, flow, head } = setup(undefined, () => maps);
  flow.newRun('MAPTEST2');
  ui.openMenu(head);
  ui.activate('menu-logbook');
  for (const name of ['map', 'puzzles', 'clues', 'cards', 'stats'])
    expect(ui.controlIds()).toContain(`menu-logbook-${name}`);
  ui.activate('menu-logbook-map');
  const view = () => ui.root.getObjectByName('logbook-right-page')?.userData.mapView;
  ui.activate('menu-logbook-zoom-in');
  ui.adjustLogbookMap(-40, 20);
  ui.update(0.1);
  expect(view()).toEqual({ zoom: Math.SQRT2, x: -40, y: 20 });
  ui.activate('menu-logbook-next');
  ui.update(1);
  expect(view()).toEqual(FIT_MAP_VIEW);
  ui.activate('menu-logbook-previous');
  ui.update(1);
  expect(view().zoom).toBe(Math.SQRT2);
  ui.activate('menu-logbook-finds');
  ui.update(1);
  expect(ui.root.getObjectByName('logbook-right-page')?.userData.showFinds).toBe(true);
  ui.activate('menu-logbook-fit');
  ui.update(1);
  expect(view()).toEqual(FIT_MAP_VIEW);
  ui.dispose();
});
