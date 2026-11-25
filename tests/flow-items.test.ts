import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ENCOUNTER_CONTENT_VERSION } from '../src/combat/encounter-choice.ts';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { worldRooms } from '../src/floor/generate.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
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

it('keeps puzzle rooms private until interaction and restores them across floors and saves', () => {
  const { flow } = setup();
  flow.newRun('DNGS80EC');
  flow.enterRoom(6);
  expect(flow.explorationOnFloor(1)?.puzzleLocations).toEqual([]);
  flow.discoverPuzzle('window-cache', 6);
  flow.discoverPuzzle('chime', 6);
  expect(flow.travelToFloor(2, 0)).toBe(true);
  flow.enterRoom(16);
  flow.discoverPuzzle('dark-circuit', 16);
  const continued = setup().flow;
  expect(continued.continueRun(validateSnapshot(flow.snapshot(8)))).toBe(true);
  expect(continued.explorationOnFloor(2)?.puzzleLocations).toEqual([
    { id: 'dark-circuit', room: 16 },
  ]);
  expect(continued.travelToFloor(1, 6)).toBe(true);
  expect(continued.explorationOnFloor(1)?.puzzleLocations).toEqual([
    { id: 'window-cache', room: 6 },
  ]);
});

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
    expect(ui.controlIds().filter((id) => id.startsWith('menu-note-'))).toEqual([
      'menu-note-add-show',
      'menu-note-add-close',
    ]);
    expect(ui.root.getObjectByName('menu-note-sheet')).toBeDefined();
    expect(ui.root.getObjectByName('menu-note-sheet')?.userData.noteId).toBe('A');
    ui.dispose();
  });

  it('files a physical clue when read, and its Close button resumes the run', () => {
    const { flow, ui, head } = setup();
    flow.newRun('BRASS042');
    flow.collectPressureNote(1, 'A');
    expect(ui.readNote('A', head)).toBe(true);
    expect(ui.controlIds().filter((id) => id.startsWith('menu-note-'))).toEqual([
      'menu-note-add-show',
      'menu-note-add-close',
    ]);
    expect(flow.logbookEntries.map(({ id }) => id)).toEqual(['A']);
    expect(ui.activate('menu-note-add-close')).toBe(true);
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
  ui.closeMenu();
  ui.openMenu(head);
  ui.activate('menu-items');
  ui.activate('menu-items-item-A');
  expect(positions).toHaveLength(2);
  const sheet = ui.root.getObjectByName('menu-note-sheet');
  expect(sheet?.getWorldPosition(new THREE.Vector3()).distanceTo(positions[1])).toBeLessThan(0.001);
  ui.dispose();
});

it('files clues through both buttons and menu dismissal, and keeps them across floors', () => {
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
  expect(ui.activate('menu-note-add-show')).toBe(true);
  expect(ui.menuView).toBe('logbook');
  expect(ui.root.getObjectByName('logbook-left-page')?.userData.clueId).toBe('A');
  ui.closeMenu();
  ui.readNote('A', head);
  ui.activate('menu-note-add-show');
  expect(flow.logbookEntries).toHaveLength(1);
  ui.closeMenu();
  expect(ui.readNote('B', head)).toBe(true);
  expect(ui.activate('menu-note-add-close')).toBe(true);
  expect(ui.menuView).toBe('closed');
  expect(ui.readNote('C', head)).toBe(true);
  expect(ui.toggleMenu(head)).toBe(true);
  expect(ui.menuView).toBe('closed');
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
    { floor: 1, rooms: [], totalRooms: 0, doors: [] },
    {
      floor: 2,
      rooms: [],
      totalRooms: 0,
      doors: [],
      player: { room: 1, label: 'study', position: [1, 2] },
    },
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

it('charts only reached footprints while showing ordinary exits from visited rooms', () => {
  const plan = playableFloorPlan('MAPTEST2', ENCOUNTER_CONTENT_VERSION);
  const world = worldRooms(plan);
  const pair = plan.connections[0];
  const position: readonly [number, number] = [0.1, -0.2];
  const onlyEntry = chartFloor(1, plan, world, [pair[0].room], { room: pair[0].room, position });
  expect(onlyEntry.rooms.map(({ id }) => id)).toEqual([pair[0].room]);
  expect(onlyEntry.doors.length).toBeGreaterThan(0);
  expect(onlyEntry.player?.position).toEqual(position);
  const both = chartFloor(1, plan, world, [pair[0].room, pair[1].room]);
  expect(both.rooms.map(({ id }) => id).sort()).toEqual([pair[0].room, pair[1].room].sort());
  expect(both.doors.length).toBeGreaterThan(0);
  expect(both.player).toBeUndefined();
});

it('clamps a zoomed floor to its chart and keeps the scroll anchor stable', () => {
  const map: LogbookMap = {
    floor: 1,
    totalRooms: 1,
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

it('shows a visible locked exit from one explored room and keeps an undiscovered service panel off the map', () => {
  const plan = playableFloorPlan('MAPTEST2', ENCOUNTER_CONTENT_VERSION, 1);
  const [pair] = plan.connections;
  const world = worldRooms(plan);
  const reached = [pair[0].room];
  const locked = Object.assign([pair[0], pair[1]] as const, { puzzleGate: 'valvehouse' as const });
  const concealed = Object.assign([pair[0], pair[1]] as const, { puzzleGate: 'panel' as const });
  expect(chartFloor(1, { ...plan, connections: [locked] }, world, reached).doors).toHaveLength(1);
  expect(chartFloor(1, { ...plan, connections: [concealed] }, world, reached).doors).toHaveLength(
    0,
  );
  expect(
    chartFloor(1, { ...plan, connections: [concealed] }, world, [pair[0].room, pair[1].room]).doors,
  ).toHaveLength(1);
});

it('charts the explored staircase enclosure without exposing an undiscovered landing', () => {
  const plan = playableFloorPlan('MAPTEST2', ENCOUNTER_CONTENT_VERSION, 1);
  const world = worldRooms(plan);
  const stair = placeStairEntry(plan);
  if (!stair) throw new Error('showcase floor has no stair entry');
  expect(chartFloor(1, plan, world, []).stair).toBeUndefined();
  const map = chartFloor(1, plan, world, [stair.room], undefined, [], stair);
  expect(map.stair).toEqual({ room: stair.room, bounds: stair.alcove, position: stair.world });
  expect(map.totalRooms).toBe(plan.rooms.length);
});

it('records a clicked world inscription exactly once and round-trips its text on Continue', () => {
  const { flow, ui } = setup();
  flow.newRun('MAPTEST2');
  const clue = {
    id: 'plaque-drum-gallery',
    title: 'Drum Gallery Service Score',
    body: 'MID · LOW · HIGH · LOW\nPlace the four notes in this order.',
    origin: 'Drum Gallery Service Score',
  } as const;
  expect(flow.logbookEntries).toHaveLength(0);
  expect(flow.saveLogbookEntry(clue)).toBe(true);
  expect(flow.saveLogbookEntry(clue)).toBe(true);
  expect(flow.logbookEntries).toEqual([clue]);
  const resumed = setup();
  expect(resumed.flow.continueRun(validateSnapshot(flow.snapshot()))).toBe(true);
  expect(resumed.flow.logbookEntries).toEqual([clue]);
  resumed.ui.dispose();
  ui.dispose();
});

it('retains each map view across floors and keeps the run menu available', () => {
  const largeRoom = { id: 0, bounds: { min: [-40, -40], max: [40, 40] } } as const;
  const maps: LogbookMap[] = [
    { floor: 1, rooms: [largeRoom], totalRooms: 1, doors: [] },
    { floor: 2, rooms: [largeRoom], totalRooms: 1, doors: [] },
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
  expect(ui.controlIds()).not.toContain('menu-logbook-finds');
  ui.update(1);
  expect(ui.root.getObjectByName('logbook-right-page')?.userData.showFinds).toBe(true);
  ui.activate('menu-logbook-fit');
  ui.update(1);
  expect(view()).toEqual(FIT_MAP_VIEW);
  ui.dispose();
});

it('picks a logbook row with the shared pointer controls and returns to its card spread', () => {
  const { flow, ui, head } = setup();
  flow.newRun('MAPTEST2');
  ui.openMenu(head);
  ui.activate('menu-logbook');
  ui.activate('menu-logbook-cards');
  const id = ui.controlIds().find((name) => name.startsWith('logbook-card-'));
  if (!id) throw new Error('No selectable card row');
  const row = ui.root.getObjectByName(id);
  if (!row) throw new Error('No card row pointer target');
  ui.root.updateMatrixWorld(true);
  const eye = head.getWorldPosition(new THREE.Vector3());
  const direction = row.getWorldPosition(new THREE.Vector3()).sub(eye).normalize();
  const hits = new THREE.Raycaster(eye, direction).intersectObjects(ui.targets(), true);
  expect(hits.map(({ object }) => ui.controlAt(object))).toContain(id);
  expect(ui.activate(id)).toBe(true);
  expect(ui.root.getObjectByName('logbook-inspected-card')).toBeDefined();
  expect(ui.activate('logbook-inspection-back')).toBe(true);
  expect(ui.controlIds()).toContain(id);
  ui.dispose();
});

it('persists discovered lift positions across Continue and leaves older saves readable', () => {
  const { flow, ui } = setup();
  flow.newRun('MAPTEST2');
  flow.travelToFloor(2, 0);
  flow.discoverLift(0, [1.27, -2.8]);
  flow.travelToFloor(3, 0);
  const saved = validateSnapshot(flow.snapshot(1));
  const restored = setup();
  expect(restored.flow.continueRun(saved)).toBe(true);
  expect(restored.flow.discoveredLift(2)).toEqual({ floor: 2, room: 0, position: [1.27, -2.8] });
  const { mapLifts, ...legacy } = saved;
  expect(mapLifts).toHaveLength(1);
  expect(validateSnapshot(legacy).mapLifts).toBeUndefined();
  restored.ui.dispose();
  ui.dispose();
});
