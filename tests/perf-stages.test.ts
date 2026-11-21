import { describe, expect, it } from 'vitest';
import {
  createQuestPerfProfiler,
  QUEST_PERF_MAX_SAMPLES,
  questPerfEnabledFromSearch,
} from '../src/perf/stages.ts';

function storage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe('Quest stage profiling', () => {
  it('is opt-in and accepts the combined perf capture spelling', () => {
    expect(questPerfEnabledFromSearch('')).toBe(false);
    expect(questPerfEnabledFromSearch('?perf=1')).toBe(false);
    expect(questPerfEnabledFromSearch('?questperf=1')).toBe(true);
    expect(questPerfEnabledFromSearch('?perf=quest')).toBe(true);
  });

  it('attributes nested stages to one fight and persists bounded data', () => {
    let now = 100;
    const store = storage();
    const profiler = createQuestPerfProfiler(store, () => now);
    profiler.beginFight('room-2');
    profiler.setMode('xr');
    profiler.frame(0);
    profiler.frame(1000 / 72);
    const outer = profiler.start('combat.update');
    now += 2;
    const inner = profiler.start('combat.dice');
    now += 3;
    profiler.end(inner);
    now += 1;
    profiler.end(outer);
    now += 4;
    profiler.endFight();
    const log = profiler.log();
    expect(log.samples).toMatchObject([
      { stage: 'combat.dice', mode: 'xr', fight: 'room-2', ms: 3, depth: 1 },
      { stage: 'combat.update', mode: 'xr', fight: 'room-2', ms: 6, depth: 0 },
    ]);
    expect(log.currentFight).toBeNull();
    expect(log.fights[0]).toMatchObject({
      id: 'room-2',
      ms: 10,
      endedBy: 'completed',
      stages: [
        { stage: 'combat.dice', count: 1, maxMs: 3 },
        { stage: 'combat.update', count: 1, maxMs: 6 },
      ],
      cadence: { xr: { frames: 1, fps: 72, budgetMisses: 0, systemGaps: 0, p95Ms: 14 } },
    });
    expect(JSON.parse(store.getItem() ?? '{}').fights).toHaveLength(1);
    const restored = createQuestPerfProfiler(store, () => now);
    expect(restored.log().fights).toHaveLength(1);
  });

  it('keeps a sustained capture bounded', () => {
    let now = 0;
    const profiler = createQuestPerfProfiler(null, () => ++now);
    for (let i = 0; i < QUEST_PERF_MAX_SAMPLES + 80; i += 1) {
      const token = profiler.start('floor.update');
      profiler.end(token);
    }
    expect(profiler.log().samples).toHaveLength(QUEST_PERF_MAX_SAMPLES);
  });

  it('keeps an interrupted fight across a capture reload', () => {
    const store = storage();
    const profiler = createQuestPerfProfiler(store);
    profiler.setMode('xr');
    profiler.beginFight('floor-1/room-7');
    for (const at of [10, 30, 50, 350, 370]) profiler.frame(at);
    expect(profiler.log().currentFight).toMatchObject({
      endedBy: null,
      cadence: { xr: { frames: 3, durationMs: 60, fps: 50, systemGaps: 1, maxSystemGapMs: 300 } },
    });
    profiler.persist();
    expect(createQuestPerfProfiler(store).log().fights[0]).toMatchObject({
      id: 'floor-1/room-7',
      endedBy: 'pagehide',
      cadence: { xr: { frames: 3, fps: 50 } },
    });
  });

  it('does not write storage on the hot path after the sample ring fills', () => {
    let now = 0;
    let writes = 0;
    const store = {
      getItem: () => null,
      setItem: () => {
        writes += 1;
      },
    };
    const profiler = createQuestPerfProfiler(store, () => ++now);
    for (let i = 0; i < QUEST_PERF_MAX_SAMPLES + 40; i += 1) {
      const token = profiler.start('floor.update');
      profiler.end(token);
    }
    expect(writes).toBe(0);
    profiler.persist();
    expect(writes).toBe(1);
  });
});
