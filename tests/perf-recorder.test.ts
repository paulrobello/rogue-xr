import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  perfMark,
  perfRecording,
  perfRoom,
  perfWindow,
  setActivePerfRecorder,
} from '../src/perf/marks.ts';
import {
  createPerfRecorder,
  PERF_MAX_HITCHES,
  PERF_MAX_WINDOWS,
  PERF_PAUSE_MS,
  PERF_STORAGE_MAX_CHARS,
  PERF_STORAGE_NAME,
  type PerfRecorder,
  type PerfStorage,
  type PerfSummary,
  percentileSorted,
  readStoredHitches,
  readStoredWindows,
  storedJson,
} from '../src/perf/recorder.ts';

function memoryStorage(initial: Record<string, string> = {}): PerfStorage & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const HZ72 = 1000 / 72;

function make(
  overrides: Partial<Parameters<typeof createPerfRecorder>[0]> = {},
  targetHz: number | null = 72,
): PerfRecorder {
  return createPerfRecorder({
    context: () => ({ targetHz, foveation: 0.5, scale: 0.85 }),
    now: () => 0,
    wallNow: () => 1_700_000_000_000,
    ...overrides,
  });
}

/** Feeds a first frame at `start`, then `intervals` back to back; returns the last time. */
function feed(rec: PerfRecorder, start: number, intervals: number[], presenting = true): number {
  let t = start;
  rec.frame(t, presenting);
  for (const dt of intervals) {
    t += dt;
    rec.frame(t, presenting);
  }
  return t;
}

describe('percentileSorted', () => {
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('uses nearest rank ceil(p/100 * n)', () => {
    expect(percentileSorted(sorted, 50)).toBe(5);
    expect(percentileSorted(sorted, 95)).toBe(10);
    expect(percentileSorted(sorted, 99)).toBe(10);
    expect(percentileSorted(sorted, 11)).toBe(2);
  });

  it('clamps and handles empty input', () => {
    expect(percentileSorted([], 50)).toBeNull();
    expect(percentileSorted(sorted, 0)).toBe(1);
    expect(percentileSorted(sorted, 200)).toBe(10);
  });
});

describe('window maths', () => {
  it('summarises mean, percentiles, longest frame and fps', () => {
    const rec = make({ settleMs: 0 });
    const intervals = Array.from({ length: 100 }, (_, i) => i + 1);
    feed(rec, 10, intervals);
    const w = rec.current();
    expect(w.frames).toBe(100);
    expect(w.durationMs).toBe(5050);
    expect(w.meanMs).toBe(50.5);
    expect(w.p50Ms).toBe(50);
    expect(w.p95Ms).toBe(95);
    expect(w.p99Ms).toBe(99);
    expect(w.maxMs).toBe(100);
    expect(w.fps).toBeCloseTo((1000 * 100) / 5050, 9);
    expect(w.presenting).toBe(true);
  });

  it('counts over-budget shares at 1.5x and 2.5x the budget', () => {
    const rec = make({ settleMs: 0 });
    const budget = HZ72;
    // 10 frames: 6 on budget, 2 at 2x (over 1.5x only), 2 at 3x (over both).
    feed(rec, 0, [...Array(6).fill(budget), budget * 2, budget * 2, budget * 3, budget * 3]);
    const w = rec.current();
    expect(w.budgetMs).toBeCloseTo(budget, 9);
    expect(w.overBudgetPct).toBe(40);
    expect(w.over2xBudgetPct).toBe(20);
  });

  it('has no budget, so no shares, without a target rate', () => {
    const rec = make({ settleMs: 0 }, null);
    feed(rec, 0, [50, 50, 50], false);
    const w = rec.current();
    expect(w.budgetMs).toBeNull();
    expect(w.overBudgetPct).toBeNull();
    expect(w.over2xBudgetPct).toBeNull();
    expect(w.presenting).toBe(false);
  });

  it('is empty before any counted frame', () => {
    const w = make().current();
    expect(w.frames).toBe(0);
    expect(w.meanMs).toBeNull();
    expect(w.maxMs).toBeNull();
    expect(w.fps).toBeNull();
  });

  it('skips a pause longer than PERF_PAUSE_MS instead of counting it as a frame', () => {
    const rec = make({ settleMs: 0 });
    const t = feed(rec, 0, [14, 14]);
    rec.frame(t + PERF_PAUSE_MS + 1, true);
    rec.frame(t + PERF_PAUSE_MS + 15, true);
    const w = rec.current();
    expect(w.frames).toBe(3);
    expect(w.maxMs).toBe(14);
  });
});

describe('settle drop', () => {
  it('leaves out the first second of each window, by timestamps from its first frame', () => {
    const rec = make();
    // Frames every 100 ms from t=0: the one at 1000 ms is the first counted.
    feed(rec, 0, Array(20).fill(100));
    const w = rec.current();
    expect(w.frames).toBe(11);
    expect(w.durationMs).toBe(1100);
  });

  it('restarts the settle after a mark', () => {
    const rec = make();
    const t = feed(rec, 0, Array(20).fill(100));
    rec.mark('next');
    feed(rec, t + 100, Array(5).fill(100));
    expect(rec.current().frames).toBe(0);
  });
});

describe('marks and windows', () => {
  it('closes the open window on a mark, labelled with why it opened and why it closed', () => {
    const rec = make({ settleMs: 0 });
    const t = feed(rec, 0, [14, 14, 14]);
    rec.mark('combat');
    feed(rec, t + 14, [20, 20]);
    rec.mark('reward');
    const [first, second] = rec.windows();
    expect(first?.label).toBe('boot');
    expect(first?.closedBy).toBe('combat');
    expect(first?.frames).toBe(3);
    expect(second?.label).toBe('combat');
    expect(second?.closedBy).toBe('reward');
    expect(second?.meanMs).toBe(20);
    expect(rec.current().label).toBe('reward');
  });

  it('drops a window closed inside its settle and one with no frames', () => {
    const rec = make();
    feed(rec, 0, [14, 14]);
    rec.mark('a');
    rec.mark('b');
    expect(rec.windows()).toEqual([]);
  });

  it("reports a window's presenting state from its own frames, not the live state", () => {
    const rec = make({ settleMs: 0 });
    const t = feed(rec, 0, [14, 14], true);
    rec.mark('xr-end');
    expect(rec.windows()[0]?.presenting).toBe(true);
    feed(rec, t + 14, [14, 14], false);
    expect(rec.current().presenting).toBe(false);
  });

  it('records the wall clock of the first frame and the context', () => {
    const rec = make({ settleMs: 0, now: () => 42 });
    feed(rec, 5, [14]);
    const w = rec.current();
    expect(w.startMs).toBe(42);
    expect(w.wallMs).toBe(1_700_000_000_000);
    expect(w.foveation).toBe(0.5);
    expect(w.scale).toBe(0.85);
  });
});

describe('ring bound', () => {
  it('keeps only the newest frames and flags the window truncated', () => {
    const rec = make({ settleMs: 0, ringFrames: 4 });
    feed(rec, 0, [100, 100, 10, 10, 10, 10]);
    const w = rec.current();
    expect(w.frames).toBe(4);
    expect(w.maxMs).toBe(10);
    expect(w.truncated).toBe(true);
  });

  it('does not flag a window that fits', () => {
    const rec = make({ settleMs: 0, ringFrames: 8 });
    feed(rec, 0, [10, 10, 10]);
    expect(rec.current().truncated).toBe(false);
  });
});

describe('storage', () => {
  function closeWindows(rec: PerfRecorder, count: number): void {
    let t = 0;
    for (let i = 0; i < count; i += 1) {
      t = feed(rec, t + 14, [14, 14]);
      rec.mark(`w${i}`);
    }
  }

  it('persists once per close under rogue-xr.perf.v1, never per frame', () => {
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const rec = make({ settleMs: 0, storage });
    feed(rec, 0, Array(50).fill(14));
    expect(setItem).not.toHaveBeenCalled();
    rec.mark('a');
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(setItem.mock.calls[0]?.[0]).toBe('rogue-xr.perf.v1');
    expect(PERF_STORAGE_NAME).toBe('rogue-xr.perf.v1');
  });

  it('reloads stored windows in a new recorder, and clear empties memory and storage', () => {
    const storage = memoryStorage();
    const rec = make({ settleMs: 0, storage });
    closeWindows(rec, 3);
    expect(readStoredWindows(storage)).toHaveLength(3);
    const reloaded = make({ settleMs: 0, storage });
    expect(reloaded.windows().map((w) => w.closedBy)).toEqual(['w0', 'w1', 'w2']);
    reloaded.clear();
    expect(reloaded.windows()).toEqual([]);
    expect(storage.data.has(PERF_STORAGE_NAME)).toBe(false);
  });

  it('ignores foreign or malformed stored data', () => {
    expect(readStoredWindows(memoryStorage({ [PERF_STORAGE_NAME]: 'nope' }))).toEqual([]);
    expect(
      readStoredWindows(memoryStorage({ [PERF_STORAGE_NAME]: '{"version":2,"windows":[]}' })),
    ).toEqual([]);
    expect(readStoredWindows(null)).toEqual([]);
  });

  it('keeps at most maxWindows, in memory and in storage', () => {
    const storage = memoryStorage();
    const rec = make({ settleMs: 0, storage, maxWindows: 3 });
    closeWindows(rec, 5);
    expect(rec.windows().map((w) => w.closedBy)).toEqual(['w2', 'w3', 'w4']);
    expect(readStoredWindows(storage).map((w) => w.closedBy)).toEqual(['w2', 'w3', 'w4']);
    expect(PERF_MAX_WINDOWS).toBe(200);
  });

  it('drops the oldest windows until the JSON fits the size bound', () => {
    const rec = make({ settleMs: 0 });
    closeWindows(rec, 6);
    const windows: PerfSummary[] = rec.windows();
    const one = JSON.stringify(windows[0]).length;
    const json = storedJson(windows, one * 3);
    const kept = (JSON.parse(json) as { windows: PerfSummary[] }).windows;
    expect(json.length).toBeLessThanOrEqual(one * 3);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(6);
    expect(kept.at(-1)?.closedBy).toBe('w5');
    expect(PERF_STORAGE_MAX_CHARS).toBe(400_000);
  });

  it('survives a storage that throws', () => {
    const storage: PerfStorage = {
      getItem: () => {
        throw new Error('off');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('off');
      },
    };
    const rec = make({ settleMs: 0, storage });
    feed(rec, 0, [14, 14]);
    expect(() => rec.mark('a')).not.toThrow();
    expect(rec.windows()).toHaveLength(1);
    expect(() => rec.clear()).not.toThrow();
  });
});

describe('perfMark', () => {
  afterEach(() => {
    setActivePerfRecorder(null);
    vi.useRealTimers();
  });

  it('is a no-op with no recorder', () => {
    expect(perfRecording()).toBe(false);
    expect(() => perfMark('x')).not.toThrow();
  });

  it('marks the active recorder', () => {
    const rec = make({ settleMs: 0 });
    const mark = vi.spyOn(rec, 'mark');
    setActivePerfRecorder(rec);
    expect(perfRecording()).toBe(true);
    perfMark('chest-opened');
    expect(mark).toHaveBeenCalledWith('chest-opened');
  });

  it('perfWindow closes its window after the delay, unless another mark came first', () => {
    vi.useFakeTimers();
    const rec = make({ settleMs: 0 });
    const mark = vi.spyOn(rec, 'mark');
    setActivePerfRecorder(rec);
    perfWindow('cast', 3000);
    vi.advanceTimersByTime(3000);
    expect(mark.mock.calls.map((c) => c[0])).toEqual(['cast', 'play']);

    mark.mockClear();
    perfWindow('cast', 3000);
    perfMark('dice-throw');
    vi.advanceTimersByTime(3000);
    expect(mark.mock.calls.map((c) => c[0])).toEqual(['cast', 'dice-throw']);
  });

  it('perfRoom marks only when the room changes, with its template', () => {
    const rec = make({ settleMs: 0 });
    const mark = vi.spyOn(rec, 'mark');
    setActivePerfRecorder(rec);
    const world = {
      current: 2,
      plan: { rooms: [{ templateId: 'a' }, { templateId: 'b' }, { templateId: 'study' }] },
    };
    perfRoom(world);
    perfRoom(world);
    world.current = 1;
    perfRoom(world);
    expect(mark.mock.calls.map((c) => c[0])).toEqual(['room 2 study', 'room 1 b']);
  });
});

describe('hitches', () => {
  it('logs the slow first frame after a mark, which the window drops, with its label', () => {
    const rec = make();
    let t = feed(rec, 0, Array(100).fill(HZ72));
    rec.mark('dice-throw');
    // The throw's work makes the next interval slow: the first frame of the new window.
    t = feed(rec, t + 30, Array(10).fill(HZ72));
    rec.mark('dice-settled');
    const hitches = rec.hitches();
    expect(hitches).toHaveLength(1);
    expect(hitches[0]?.label).toBe('dice-throw');
    expect(hitches[0]?.ms).toBeCloseTo(30, 5);
    expect(hitches[0]?.sinceMarkMs).toBeCloseTo(30, 5);
    expect(hitches[0]?.presenting).toBe(true);
    // The dice-throw window closed inside its settle, so only the boot window was kept.
    expect(rec.windows().map((w) => w.label)).toEqual(['boot']);
    expect(t).toBeGreaterThan(0);
  });

  it('logs frames inside a settle and later in a window, but not normal frames or pauses', () => {
    const rec = make();
    feed(rec, 0, [HZ72, 25, HZ72, HZ72, PERF_PAUSE_MS + 1, HZ72, 40, HZ72]);
    expect(rec.hitches().map((h) => Math.round(h.ms))).toEqual([25, 40]);
    expect(rec.hitches()[1]?.sinceMarkMs).toBeCloseTo(HZ72 * 4 + 25 + PERF_PAUSE_MS + 1 + 40, 5);
  });

  it('uses 1.5x 60 Hz without an XR target rate', () => {
    const rec = make({}, null);
    feed(rec, 0, [24, 26]);
    expect(rec.hitches().map((h) => h.ms)).toEqual([26]);
  });

  it('keeps the newest PERF_MAX_HITCHES', () => {
    const rec = make();
    feed(rec, 0, Array(PERF_MAX_HITCHES + 5).fill(30));
    expect(rec.hitches()).toHaveLength(PERF_MAX_HITCHES);
  });

  it('persists on a mark even when the window is dropped, reloads and clears', () => {
    const storage = memoryStorage();
    const rec = make({ storage });
    const t = feed(rec, 0, [HZ72, 30]);
    rec.mark('cast');
    expect(rec.windows()).toHaveLength(0);
    expect(readStoredHitches(storage)).toHaveLength(1);
    const again = make({ storage });
    expect(again.hitches()).toHaveLength(1);
    again.clear();
    expect(again.hitches()).toHaveLength(0);
    expect(readStoredHitches(storage)).toEqual([]);
    expect(t).toBeGreaterThan(0);
  });

  it('drops the oldest hitches with the windows to fit the size bound', () => {
    const hitches = Array.from({ length: 50 }, (_, i) => ({
      label: `h${i}`,
      ms: 30,
      sinceMarkMs: 30,
      wallMs: 0,
      presenting: true,
    }));
    const json = storedJson([], 1000, hitches);
    expect(json.length).toBeLessThanOrEqual(1000);
    const kept = (JSON.parse(json) as { hitches: { label: string }[] }).hitches;
    expect(kept.at(-1)?.label).toBe('h49');
  });
});
