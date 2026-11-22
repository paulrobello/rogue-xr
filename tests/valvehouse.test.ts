// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { VALVEHOUSE_VERSION } from '../src/combat/encounter-choice.ts';
import { placeStairEntry } from '../src/floor/stairs.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import { gasketFor } from '../src/rules/valvehouse.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';

const flow = () =>
  new RunFlow({
    workshop: createWorkshop(),
    starterDeck: ['strike'],
    rewardPool: ['strike'],
  });

describe('Valvehouse topology and run history', () => {
  it('adds an optional chamber while preserving earlier floor indices, stairs and cache', () => {
    let attached = 0;
    for (const seed of [
      'MAPTEST2',
      ...Array.from({ length: 100 }, (_, i) => `VH${String(i).padStart(6, '0')}`),
    ]) {
      const old = playableFloorPlan(seed, VALVEHOUSE_VERSION - 1, 1);
      const plan = playableFloorPlan(seed, VALVEHOUSE_VERSION, 1);
      expect(plan.rooms.slice(0, old.rooms.length)).toEqual(old.rooms);
      expect(plan.connections.slice(0, old.connections.length)).toEqual(old.connections);
      expect(plan.brassCache).toEqual(old.brassCache);
      expect(placeStairEntry(plan)).toEqual(placeStairEntry(old));
      const spec = plan.valvehouse;
      if (!spec) continue;
      attached++;
      const edge = plan.connections.at(-1);
      expect(edge?.puzzleGate).toBe('valvehouse');
      expect(edge?.[0]).toEqual(spec.source);
      expect(edge?.[1].room).toBe(spec.valvehouseRoom);
      expect(spec.valvehouseRoom).toBe(old.rooms.length);
      expect(spec.supplyRoom).not.toBe(spec.source.room);
      expect(plan.rooms[spec.valvehouseRoom].loot).toHaveLength(1);
      const visited = new Set([0]);
      for (const room of visited) {
        for (const link of plan.connections) {
          if (link.puzzleGate) continue;
          if (link[0].room === room) visited.add(link[1].room);
          if (link[1].room === room) visited.add(link[0].room);
        }
      }
      expect(visited).toContain(spec.source.room);
      expect(visited).toContain(spec.supplyRoom);
      expect(visited).toContain(plan.guardianRoom);
      expect(visited).not.toContain(spec.valvehouseRoom);
    }
    expect(attached).toBeGreaterThan(65);
  });

  it('keeps three distinct gasket shapes seeded and permits retry, travel and one saved opening', () => {
    expect(
      new Set(Array.from({ length: 40 }, (_, i) => gasketFor(`VH${String(i).padStart(6, '0')}`))),
    ).toEqual(new Set(['round', 'square', 'triangular']));
    const game = flow();
    game.newRun('MAPTEST2');
    expect(game.seatValvehouseGasket()).toBe(false);
    expect(game.testValvehousePressure()).toBe('leak');
    expect(game.valvehouse).toBe('missing');
    expect(game.collectValvehouseGasket()).toBe(true);
    expect(game.collectValvehouseGasket()).toBe(false);
    expect(game.testValvehousePressure()).toBe('leak');
    expect(game.valvehouse).toBe('held');
    expect(game.travelToFloor(2, 0)).toBe(true);
    expect(game.seatValvehouseGasket()).toBe(false);
    expect(game.testValvehousePressure()).toBe('ignored');

    const upstairs = validateSnapshot(game.snapshot(100, 0));
    const restored = flow();
    expect(restored.continueRun(upstairs)).toBe(true);
    expect(restored.valvehouse).toBe('held');
    expect(restored.travelToFloor(1, 0)).toBe(true);
    expect(restored.seatValvehouseGasket()).toBe(true);
    expect(restored.seatValvehouseGasket()).toBe(false);
    const repair = validateSnapshot(restored.snapshot(200, 0));
    const repaired = flow();
    expect(repaired.continueRun(repair)).toBe(true);
    expect(repaired.testValvehousePressure()).toBe('opened');
    expect(repaired.testValvehousePressure()).toBe('ignored');
    const done = flow();
    expect(done.continueRun(validateSnapshot(repaired.snapshot(300, 0)))).toBe(true);
    expect(done.valvehouse).toBe('open');
    expect(done.testValvehousePressure()).toBe('ignored');
  });

  it('rejects malformed state and keeps the actions unavailable on v14', () => {
    const game = flow();
    game.newRun('MAPTEST2');
    const snapshot = validateSnapshot(game.snapshot(100, 0));
    expect(() =>
      validateSnapshot({ ...snapshot, run: { ...snapshot.run, valvehouse: 'broken' } }),
    ).toThrow(/valvehouse/);
    const old = flow();
    expect(old.continueRun({ ...snapshot, contentVersion: VALVEHOUSE_VERSION - 1 })).toBe(true);
    expect(old.collectValvehouseGasket()).toBe(false);
    expect(old.seatValvehouseGasket()).toBe(false);
    expect(old.testValvehousePressure()).toBe('ignored');
  });
});
