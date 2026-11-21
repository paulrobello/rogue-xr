import { describe, expect, it } from 'vitest';
import { PRISM_ANNEX_VERSION } from '../src/combat/encounter-choice.ts';
import { generateFloor } from '../src/floor/generate.ts';
import { attachPrismAnnex } from '../src/floor/prism-annex.ts';
import {
  latchPrismReceiver,
  prismOrder,
  readPrismSignal,
  turnPrism,
} from '../src/rules/prism-signal.ts';
import { createRun } from '../src/rules/run.ts';
import { playableFloorPlan } from '../src/world/floor-view.ts';

describe('prism annex topology', () => {
  it('preserves the pre-annex Conservatory in legacy runs', () => {
    const legacy = playableFloorPlan('PRISM001', PRISM_ANNEX_VERSION - 1, 3);
    const current = playableFloorPlan('PRISM001', PRISM_ANNEX_VERSION, 3);
    expect(legacy.prismAnnex).toBeUndefined();
    expect(current.prismAnnex?.annexRoom).toBe(legacy.rooms.length);
    expect(current.rooms.slice(0, legacy.rooms.length)).toEqual(legacy.rooms);
  });

  it('appends one optional treasure hall without changing the base plan', () => {
    const base = generateFloor('PRISM001');
    const annex = attachPrismAnnex(base);
    expect(annex.rooms.slice(0, base.rooms.length)).toEqual(base.rooms);
    expect(annex.connections.slice(0, base.connections.length)).toEqual(base.connections);
    expect(annex.prismAnnex?.annexRoom).toBe(base.rooms.length);
    expect(annex.connections.at(-1)?.puzzleGate).toBe('prism');
  });
});

describe('prism signal state', () => {
  it('rotates and persists seeded correct and wrong progress', () => {
    const run = createRun('PRISM001', []);
    expect(readPrismSignal(run)).toEqual({ orientation: 0, progress: 0 });
    expect(turnPrism(readPrismSignal(run))).toEqual({ orientation: 1, progress: 0 });
    const order = prismOrder(run.seed);
    let state = run;
    while (readPrismSignal(state).orientation !== order[0])
      state = { ...state, prismSignal: turnPrism(readPrismSignal(state)) };
    const first = latchPrismReceiver(state, order[0]);
    expect(first?.result).toBe('matched');
    state = first?.run ?? state;
    const wrongChannel = ((order[1] + 1) % 3) as 0 | 1 | 2;
    while (readPrismSignal(state).orientation !== wrongChannel)
      state = { ...state, prismSignal: turnPrism(readPrismSignal(state)) };
    const wrong = latchPrismReceiver(state, wrongChannel);
    expect(wrong?.result).toBe('mistake');
    state = wrong?.run ?? state;
    for (const channel of order) {
      while (readPrismSignal(state).orientation !== channel)
        state = { ...state, prismSignal: turnPrism(readPrismSignal(state)) };
      const solved = latchPrismReceiver(state, channel);
      state = solved?.run ?? state;
      if (channel === order[2]) expect(solved?.result).toBe('solved');
    }
    expect(latchPrismReceiver(state, order[0])).toBeNull();
  });
});
