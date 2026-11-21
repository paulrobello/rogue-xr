/** Opt-in CPU stage attribution for a Quest capture. Disabled calls are two cheap checks. */
export const QUEST_PERF_STORAGE_NAME = 'rogue-xr.perf.quest.v1';
export const QUEST_PERF_MAX_SAMPLES = 512;
export const QUEST_PERF_MAX_FIGHTS = 64;
export const QUEST_PERF_MIN_SAMPLE_MS = 0.5;
const CADENCE_PAUSE_MS = 250;

export interface QuestPerfSample {
  readonly stage: string;
  readonly mode: 'xr' | 'desktop';
  readonly fight: string | null;
  readonly wallMs: number;
  readonly fightWallMs: number | null;
  readonly ms: number;
  readonly depth: number;
}

export interface QuestPerfFight {
  readonly id: string;
  readonly wallMs: number;
  readonly endedBy: 'completed' | 'pagehide' | null;
  readonly ms: number;
  readonly stages: readonly {
    readonly stage: string;
    readonly count: number;
    readonly maxMs: number;
  }[];
  readonly cadence: { readonly xr: QuestPerfCadence; readonly desktop: QuestPerfCadence };
}

export interface QuestPerfCadence {
  readonly frames: number;
  readonly durationMs: number;
  readonly fps: number | null;
  readonly maxMs: number | null;
  readonly budgetMisses: number;
  readonly p95Ms: number | null;
  readonly systemGaps: number;
  readonly maxSystemGapMs: number | null;
}

export interface QuestPerfLog {
  readonly version: 1;
  readonly samples: readonly QuestPerfSample[];
  readonly fights: readonly QuestPerfFight[];
  readonly currentFight: QuestPerfFight | null;
}

export interface QuestPerfStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type ActiveProfiler = QuestPerfProfiler;
let active: ActiveProfiler | null = null;
const NO_STAGE = 0;

export function questPerfEnabledFromSearch(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get('questperf') === '1' || params.get('perf') === 'quest';
}

export function createQuestPerfProfiler(
  storage: QuestPerfStorage | null = null,
  now: () => number = () => performance.now(),
): QuestPerfProfiler {
  const samples: QuestPerfSample[] = [];
  const fights: QuestPerfFight[] = [];
  if (storage) {
    try {
      const parsed = JSON.parse(
        storage.getItem(QUEST_PERF_STORAGE_NAME) ?? '',
      ) as Partial<QuestPerfLog>;
      if (parsed.version === 1 && Array.isArray(parsed.samples))
        samples.push(...parsed.samples.slice(-QUEST_PERF_MAX_SAMPLES));
      if (parsed.version === 1 && Array.isArray(parsed.fights))
        fights.push(...parsed.fights.slice(-QUEST_PERF_MAX_FIGHTS));
      if (parsed.version === 1 && parsed.currentFight?.endedBy === 'pagehide') {
        fights.push(parsed.currentFight);
        if (fights.length > QUEST_PERF_MAX_FIGHTS) fights.shift();
      }
    } catch {
      // Missing or malformed captures start empty.
    }
  }
  const stack: { label: string; start: number; depth: number }[] = [];
  type CadenceState = {
    frames: number;
    durationMs: number;
    maxMs: number;
    misses: number;
    histogram: number[];
    systemGaps: number;
    maxSystemGapMs: number;
    last: number | null;
  };
  const newCadence = (): CadenceState => ({
    frames: 0,
    durationMs: 0,
    maxMs: 0,
    misses: 0,
    histogram: Array.from({ length: CADENCE_PAUSE_MS + 1 }, () => 0),
    systemGaps: 0,
    maxSystemGapMs: 0,
    last: null,
  });
  let fight: {
    id: string;
    start: number;
    wallMs: number;
    stages: Map<string, { count: number; maxMs: number }>;
    cadence: { xr: CadenceState; desktop: CadenceState };
  } | null = null;
  let mode: 'xr' | 'desktop' = 'desktop';

  const persist = (): void => {
    if (!storage) return;
    try {
      storage.setItem(
        QUEST_PERF_STORAGE_NAME,
        JSON.stringify({ version: 1, samples, fights, currentFight: fightLog('pagehide') }),
      );
    } catch {
      // The in-memory capture remains useful when storage is unavailable or full.
    }
  };
  const addSample = (label: string, ms: number, depth: number): void => {
    if (ms < QUEST_PERF_MIN_SAMPLE_MS) return;
    samples.push({
      stage: label,
      mode,
      fight: fight?.id ?? null,
      wallMs: Date.now(),
      fightWallMs: fight?.wallMs ?? null,
      ms,
      depth,
    });
    if (fight) {
      const aggregate = fight.stages.get(label) ?? { count: 0, maxMs: 0 };
      aggregate.count += 1;
      aggregate.maxMs = Math.max(aggregate.maxMs, ms);
      fight.stages.set(label, aggregate);
    }
    if (samples.length > QUEST_PERF_MAX_SAMPLES)
      samples.splice(0, samples.length - QUEST_PERF_MAX_SAMPLES);
  };
  const cadenceLog = (state: CadenceState): QuestPerfCadence => {
    const rank = Math.max(1, Math.ceil(state.frames * 0.95));
    let seen = 0;
    let p95Ms: number | null = null;
    for (let i = 1; i < state.histogram.length; i += 1) {
      seen += state.histogram[i] ?? 0;
      if (seen >= rank) {
        p95Ms = i;
        break;
      }
    }
    return {
      frames: state.frames,
      durationMs: state.durationMs,
      fps: state.durationMs > 0 ? (1000 * state.frames) / state.durationMs : null,
      maxMs: state.frames > 0 ? state.maxMs : null,
      budgetMisses: state.misses,
      p95Ms,
      systemGaps: state.systemGaps,
      maxSystemGapMs: state.systemGaps > 0 ? state.maxSystemGapMs : null,
    };
  };
  const fightLog = (endedBy: QuestPerfFight['endedBy']): QuestPerfFight | null =>
    fight
      ? {
          id: fight.id,
          wallMs: fight.wallMs,
          endedBy,
          ms: Math.max(0, now() - fight.start),
          stages: [...fight.stages].map(([stage, value]) => ({ stage, ...value })),
          cadence: { xr: cadenceLog(fight.cadence.xr), desktop: cadenceLog(fight.cadence.desktop) },
        }
      : null;
  const profiler: QuestPerfProfiler = {
    setMode(next) {
      if (next !== mode && fight) fight.cadence[next].last = null;
      mode = next;
    },
    start(label) {
      stack.push({ label, start: now(), depth: stack.length });
      return stack.length;
    },
    end(token) {
      if (token === NO_STAGE || stack.length < token) return;
      const entry = stack[token - 1];
      stack.length = token - 1;
      if (!entry) return;
      addSample(entry.label, Math.max(0, now() - entry.start), entry.depth);
    },
    beginFight(id) {
      if (fight) profiler.endFight();
      fight = {
        id,
        start: now(),
        wallMs: Date.now(),
        stages: new Map(),
        cadence: { xr: newCadence(), desktop: newCadence() },
      };
    },
    endFight() {
      const summary = fightLog('completed');
      if (!summary) return;
      fights.push(summary);
      if (fights.length > QUEST_PERF_MAX_FIGHTS)
        fights.splice(0, fights.length - QUEST_PERF_MAX_FIGHTS);
      fight = null;
      stack.length = 0;
      persist();
    },
    frame(time) {
      if (!fight) return;
      const state = fight.cadence[mode];
      const previous = state.last;
      state.last = time;
      if (previous === null) return;
      const ms = time - previous;
      if (!(ms > 0)) return;
      if (ms > CADENCE_PAUSE_MS) {
        state.systemGaps += 1;
        state.maxSystemGapMs = Math.max(state.maxSystemGapMs, ms);
        return;
      }
      state.frames += 1;
      state.durationMs += ms;
      state.maxMs = Math.max(state.maxMs, ms);
      state.histogram[Math.min(CADENCE_PAUSE_MS, Math.max(1, Math.round(ms)))] += 1;
      const budget = mode === 'xr' ? 1000 / 72 : 1000 / 60;
      if (ms > budget) state.misses += 1;
    },
    log() {
      return {
        version: 1,
        samples: [...samples],
        fights: [...fights],
        currentFight: fightLog(null),
      };
    },
    clear() {
      samples.length = 0;
      fights.length = 0;
      try {
        storage?.setItem(
          QUEST_PERF_STORAGE_NAME,
          JSON.stringify({ version: 1, samples, fights, currentFight: null }),
        );
      } catch {
        // Ignore unavailable storage.
      }
    },
    persist,
  };
  return profiler;
}

export interface QuestPerfProfiler {
  setMode(mode: 'xr' | 'desktop'): void;
  start(label: string): number;
  end(token: number): void;
  beginFight(id: string): void;
  endFight(): void;
  frame(time: number): void;
  log(): QuestPerfLog;
  clear(): void;
  persist(): void;
}

export function setActiveQuestPerf(profiler: QuestPerfProfiler | null): void {
  active = profiler;
}

export function questPerfStageStart(label: string): number {
  return active?.start(label) ?? NO_STAGE;
}

export function questPerfSetMode(mode: 'xr' | 'desktop'): void {
  active?.setMode(mode);
}

export function questPerfFrame(time: number): void {
  active?.frame(time);
}

export function questPerfStageEnd(token: number): void {
  active?.end(token);
}

export function questPerfFightStart(id: string): void {
  active?.beginFight(id);
}

export function questPerfFightEnd(): void {
  active?.endFight();
}

export function questPerfLog(): QuestPerfLog | null {
  return active?.log() ?? null;
}
