import { describe, expect, it } from 'vitest';
import { RETURN_PASSAGES_VERSION } from '../src/combat/encounter-choice.ts';
import { counterweightResumeRoom } from '../src/floor/return-passages.ts';
import { counterweightTarget, hangCounterweight } from '../src/rules/counterweight.ts';
import { pressureTarget } from '../src/rules/pressure.ts';
import { createRun } from '../src/rules/run.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';
import { buildFloorWorld } from '../src/world/floor-world.ts';

describe('return passage rules', () => {
  it('supports every non-default three-dial pressure code', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 2000; i++)
      codes.add(pressureTarget(`P${String(i).padStart(7, '0')}`).join(''));
    expect(codes).toHaveLength(26);
    expect(codes.has('111')).toBe(false);
  });

  it('recovers from a wrong counterweight and refuses changes after solving', () => {
    const run = createRun('RETRY001', []);
    const target = counterweightTarget(run.seed);
    const wrong = hangCounterweight(run, target === 0 ? 1 : 0);
    expect(wrong?.solved).toBe(false);
    const solved = hangCounterweight(wrong!.run, target);
    expect(solved?.solved).toBe(true);
    expect(hangCounterweight(solved!.run, target)).toBeNull();
  });

  it('locks both existing entrances to the shortcut chest room', () => {
    const plan = playableFloorPlan('CW000000', RETURN_PASSAGES_VERSION, 1);
    const chest = plan.rooms.find((room) => room.index === 11);
    if (!chest) throw Error('Missing fixture chest room');
    const entrances = plan.connections.filter((edge) =>
      edge.some((door) => door.room === chest.index),
    );
    expect(entrances).toHaveLength(2);
    expect(entrances.every((edge) => edge.puzzleGate === 'counterweight')).toBe(true);
    expect(counterweightResumeRoom(plan, chest.index)).toBe(10);
    const world = buildFloorWorld(plan);
    const { min, max } = world.rooms[chest.index].footprint;
    const x = (min[0] + max[0]) / 2;
    const z = (min[1] + max[1]) / 2;
    const approaches = entrances.map((edge) => {
      const approach = edge.find((door) => door.room !== chest.index);
      if (!approach) throw Error('Missing shortcut approach');
      return approach.room;
    });
    const canLand = () =>
      world
        .nearbyWalkable()
        .some(
          (area) => x >= area.min[0] && x <= area.max[0] && z >= area.min[1] && z <= area.max[1],
        );
    const closed = approaches.map((room) => world.colliders[room].length);
    for (const room of approaches) {
      world.current = room;
      expect(canLand()).toBe(false);
    }
    world.setPuzzleGateOpen('counterweight', true, true);
    expect(approaches.map((room) => world.colliders[room].length)).toEqual(
      closed.map((count) => count - 1),
    );
    for (const room of approaches) {
      world.current = room;
      expect(canLand()).toBe(true);
    }
    world.dispose();
  });
});

it('preserves the two lower unlocks across stair travel, book secrets and a cold Continue', async () => {
  const { RunFlow } = await import('../src/flow/flow.ts');
  const { createWorkshop } = await import('../src/rules/workshop.ts');
  const { validateSnapshot } = await import('../src/persist/saves.ts');
  const make = () =>
    new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: ['strike'] });
  const flow = make();
  flow.newRun('TW0L0CKS');
  for (const id of ['A', 'B', 'C'] as const) flow.collectPressureNote(0, id);
  const code = pressureTarget(flow.floorSeed);
  for (const i of [0, 1, 2] as const)
    for (let n = 1; n < code[i]; n++) flow.turnPressureValve(0, i);
  expect(flow.primePressure(0)?.solved).toBe(true);
  flow.findBookSecretKey(0);
  expect(flow.pressure.solved).toBe(true);
  expect(flow.travelToFloor(2, 0)).toBe(true);
  flow.weighCounterweight(counterweightTarget(flow.run!.seed));
  expect(flow.hangCounterweight()).toBe('solved');
  expect(flow.travelToFloor(1, 0)).toBe(true);
  const fresh = make();
  expect(fresh.continueRun(validateSnapshot(flow.snapshot()))).toBe(true);
  expect(fresh.canEnterPuzzleGate('pressure')).toBe(true);
  expect(fresh.canEnterPuzzleGate('counterweight')).toBe(true);
});
