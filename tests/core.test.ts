import { describe, expect, it } from 'vitest';
import { ActionBus } from '../src/core/actions.ts';
import { isValidSeed, normalizeSeed, RunRng, randomSeed, STREAMS } from '../src/core/rng.ts';
import { GameStateMachine, TRANSITIONS } from '../src/core/state.ts';

const draw = (rng: RunRng, name: (typeof STREAMS)[number], n = 32) =>
  Array.from({ length: n }, () => rng.stream(name).nextUint32());

describe('RunRng', () => {
  it('replays identical sequences for the same seed on every stream', () => {
    for (const name of STREAMS) {
      expect(draw(new RunRng('SP1RE000'), name)).toEqual(draw(new RunRng('SP1RE000'), name));
    }
  });

  it('differs between seeds and between streams', () => {
    const a = new RunRng('SP1RE000');
    const b = new RunRng('SP1RE001');
    expect(draw(a, 'deck')).not.toEqual(draw(b, 'deck'));
    const c = new RunRng('SP1RE000');
    expect(draw(c, 'deck')).not.toEqual(draw(c, 'dice'));
  });

  it('keeps streams independent of each other', () => {
    const quiet = new RunRng('ABCDEFGH');
    const busy = new RunRng('ABCDEFGH');
    draw(busy, 'deck', 500);
    expect(draw(busy, 'dice')).toEqual(draw(quiet, 'dice'));
  });

  it('resumes the exact sequence from a snapshot', () => {
    const rng = new RunRng('ABCDEFGH');
    draw(rng, 'loot', 17);
    const resumed = new RunRng('ABCDEFGH', rng.snapshot());
    expect(draw(resumed, 'loot')).toEqual(draw(rng, 'loot'));
  });

  it('keeps int(), pick() and shuffle() in range and permutation-preserving', () => {
    const stream = new RunRng('ZZZZZZZZ').stream('floor');
    for (let i = 0; i < 1000; i++) {
      const v = stream.int(-2, 3);
      expect(v).toBeGreaterThanOrEqual(-2);
      expect(v).toBeLessThanOrEqual(3);
    }
    expect(['a', 'b']).toContain(stream.pick(['a', 'b']));
    expect(stream.shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(() => stream.int(3, 2)).toThrow(RangeError);
    expect(() => stream.pick([])).toThrow(RangeError);
  });
});

describe('seeds', () => {
  it('normalizes Crockford look-alikes and separators', () => {
    expect(normalizeSeed('sp1r-eoli')).toBe('SP1RE011');
    expect(isValidSeed('SHORT')).toBe(false);
    expect(isValidSeed('UUUUUUUU')).toBe(false);
  });

  it('creates valid random seeds', () => {
    for (let i = 0; i < 50; i++) expect(isValidSeed(randomSeed())).toBe(true);
  });
});

describe('GameStateMachine', () => {
  it('follows the transition table and rejects illegal moves', () => {
    const machine = new GameStateMachine();
    const seen: string[] = [];
    machine.onChange((from, to) => seen.push(`${from}>${to}`));
    machine.transition('explore');
    machine.transition('combat');
    machine.transition('reward');
    machine.transition('explore');
    expect(seen).toEqual(['title>explore', 'explore>combat', 'combat>reward', 'reward>explore']);
    expect(() => machine.transition('reward')).toThrow(/Illegal/);
    for (const targets of Object.values(TRANSITIONS)) expect(targets.length).toBeGreaterThan(0);
  });
});

describe('ActionBus', () => {
  it('delivers typed actions and unsubscribes', () => {
    const bus = new ActionBus();
    const turns: number[] = [];
    const off = bus.on('turn', (action) => turns.push(action.degrees));
    bus.emit({ type: 'turn', degrees: 30 });
    bus.emit({ type: 'recenter' });
    off();
    bus.emit({ type: 'turn', degrees: -30 });
    expect(turns).toEqual([30]);
  });
});
