import { describe, expect, it } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { MAP_MARKER_ICONS } from '../src/flow/map-markers.ts';
import { bindFlowPersistence } from '../src/flow/persist.ts';
import { openDb } from '../src/persist/db.ts';
import { loadRunSnapshot, validateSnapshot } from '../src/persist/saves.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const make = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });

describe('personal map markers', () => {
  it('keeps markers immutable, scoped to reached floors, and removes by floor-local index', () => {
    const flow = make();
    expect(flow.addMapMarker(2, { icon: 'star', position: [1, 2] })).toBe(false);
    expect(flow.newRun('MARKERS1')).toBe(true);
    const position: [number, number] = [3, 4];
    const marker = { icon: 'flag' as const, position };
    expect(flow.addMapMarker(1, marker)).toBe(true);
    position[0] = 99;
    expect(flow.mapMarkersOnFloor(1)).toEqual([{ icon: 'flag', position: [3, 4] }]);
    expect(flow.addMapMarker(1, { icon: 'danger', position: [5, 6] })).toBe(true);
    expect(flow.removeMapMarker(1, 1)).toBe(true);
    expect(flow.mapMarkersOnFloor(1)).toEqual([{ icon: 'flag', position: [3, 4] }]);
    expect(flow.removeMapMarker(1, 1)).toBe(false);
  });

  it('retains markers through floor travel and Continue, while New Run clears them', () => {
    const flow = make();
    flow.newRun('MARKERS2');
    flow.addMapMarker(1, { icon: 'star', position: [1, 2] });
    expect(flow.travelToFloor(2, 0)).toBe(true);
    flow.addMapMarker(2, { icon: 'check', position: [-3, 0.5] });
    const snapshot = flow.snapshot(10);
    if (!snapshot) throw new Error('missing marker snapshot');
    expect(snapshot.mapMarkers).toEqual([
      { floor: 1, icon: 'star', position: [1, 2] },
      { floor: 2, icon: 'check', position: [-3, 0.5] },
    ]);
    const continued = make();
    expect(continued.continueRun(validateSnapshot(JSON.parse(JSON.stringify(snapshot))))).toBe(
      true,
    );
    expect(continued.mapMarkersOnFloor(1)).toEqual([{ icon: 'star', position: [1, 2] }]);
    expect(continued.mapMarkersOnFloor(2)).toEqual([{ icon: 'check', position: [-3, 0.5] }]);
    continued.enterRoom(0);
    continued.fightStarted(0);
    continued.fightEnded({ room: 0, outcome: 'defeat', tier: 'regular' });
    expect(continued.toTitle()).toBe(true);
    expect(continued.newRun('MARKERS3')).toBe(true);
    expect(continued.mapMarkersOnFloor(1)).toEqual([]);
  });

  it('accepts old snapshots and rejects invalid marker records', () => {
    const flow = make();
    flow.newRun('MARKERS4');
    const snapshot = flow.snapshot(10);
    if (!snapshot) throw new Error('missing snapshot');
    expect(validateSnapshot(snapshot).mapMarkers).toBeUndefined();
    for (const bad of [
      { floor: 4, icon: 'star', position: [0, 0] },
      { floor: 1, icon: 'nope', position: [0, 0] },
      { floor: 1, icon: MAP_MARKER_ICONS[0], position: [Number.NaN, 0] },
    ]) {
      expect(() => validateSnapshot({ ...snapshot, mapMarkers: [bad] })).toThrow();
    }
  });

  it('saves edits made in the paused combat book to the exploration checkpoint', async () => {
    const flow = make();
    const db = await openDb(undefined, { name: 'combat-book-markers' });
    const persistence = bindFlowPersistence(flow, db);
    flow.newRun('MARKERS5');
    flow.addMapMarker(1, { icon: 'star', position: [0, 0] });
    expect(flow.fightStarted(1)).toBe(true);
    expect(flow.addMapMarker(1, { icon: 'danger', position: [1, 2] })).toBe(true);
    expect(flow.removeMapMarker(1, 0)).toBe(true);
    await persistence.flushed();
    const snapshot = await loadRunSnapshot(db);
    expect(snapshot?.phase).toBe('explore');
    expect(snapshot?.mapMarkers).toEqual([{ floor: 1, icon: 'danger', position: [1, 2] }]);
    persistence.dispose();
  });
});
