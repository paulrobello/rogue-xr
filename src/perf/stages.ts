/** Opt-in CPU stage attribution for a Quest capture. Disabled calls are two cheap checks. */
export const QUEST_PERF_STORAGE_NAME = 'rogue-xr.perf.quest.v1';
export const QUEST_PERF_MAX_SAMPLES = 512;
export const QUEST_PERF_MAX_FIGHTS = 64;
export const QUEST_PERF_WINDOW_MS = 10_000;
export const QUEST_PERF_MAX_WINDOWS = 384;
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
  readonly stages: readonly QuestPerfStageSummary[];
  readonly cadence: { readonly xr: QuestPerfCadence; readonly desktop: QuestPerfCadence };
}

export interface QuestPerfCadence {
  readonly frames: number;
  readonly durationMs: number;
  readonly fps: number | null;
  readonly maxMs: number | null;
  readonly budgetMisses: number;
  readonly over33Ms: number;
  readonly p95Ms: number | null;
  readonly systemGaps: number;
  readonly maxSystemGapMs: number | null;
}

interface QuestPerfStageSummary {
  readonly stage: string;
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface QuestPerfContext {
  readonly seed: string | null;
  readonly floor: number | null;
  readonly room: number | null;
  readonly phase: string;
  readonly scale: number;
  readonly foveation: number;
  readonly buildId: string | null;
}

export interface QuestPerfWindow {
  readonly wallMs: number;
  readonly mode: QuestPerfSample['mode'];
  readonly targetHz: number;
  readonly context: QuestPerfContext | null;
  readonly cadence: QuestPerfCadence;
  readonly stages: readonly QuestPerfStageSummary[];
  readonly peakWorldDrawCalls: number;
  readonly peakWorldTriangles: number;
}

export interface QuestPerfLog {
  readonly version: 1;
  readonly samples: readonly QuestPerfSample[];
  readonly fights: readonly QuestPerfFight[];
  readonly currentFight: QuestPerfFight | null;
  readonly windows: readonly QuestPerfWindow[];
  readonly currentWindow: QuestPerfWindow | null;
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
  const perf = params.get('perf');
  const quest = params.get('questperf');
  if (quest === '1' || perf === 'quest') return true;
  if (quest === '0' || perf === '0') return false;
  return perf !== null || (quest === null && params.has('playtest'));
}

export function readStoredQuestPerf(storage: QuestPerfStorage | null): QuestPerfLog | null {
  if (!storage) return null;
  try {
    const data = JSON.parse(
      storage.getItem(QUEST_PERF_STORAGE_NAME) ?? 'null',
    ) as QuestPerfLog | null;
    if (data?.version !== 1 || !Array.isArray(data.samples) || !Array.isArray(data.fights))
      return null;
    return {
      version: 1,
      samples: data.samples,
      fights: data.fights,
      currentFight: data.currentFight ?? null,
      windows: Array.isArray(data.windows) ? data.windows : [],
      currentWindow: data.currentWindow ?? null,
    };
  } catch {
    return null;
  }
}

export function createQuestPerfProfiler(
  storage: QuestPerfStorage | null = null,
  now: () => number = () => performance.now(),
): QuestPerfProfiler {
  const samples: QuestPerfSample[] = [];
  const fights: QuestPerfFight[] = [];
  const windows: QuestPerfWindow[] = [];
  const stored = readStoredQuestPerf(storage);
  if (stored) {
    samples.push(...stored.samples.slice(-QUEST_PERF_MAX_SAMPLES));
    fights.push(...stored.fights.slice(-QUEST_PERF_MAX_FIGHTS));
    windows.push(...stored.windows.slice(-QUEST_PERF_MAX_WINDOWS));
    if (stored.currentWindow) {
      windows.push(stored.currentWindow);
      if (windows.length > QUEST_PERF_MAX_WINDOWS) windows.shift();
    }
    if (stored.currentFight?.endedBy === 'pagehide') {
      fights.push(stored.currentFight);
      if (fights.length > QUEST_PERF_MAX_FIGHTS) fights.shift();
    }
  }
  const stack: { label: string; start: number; depth: number }[] = [];
  type CadenceState = {
    frames: number;
    durationMs: number;
    maxMs: number;
    misses: number;
    over33Ms: number;
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
    over33Ms: 0,
    histogram: Array.from({ length: CADENCE_PAUSE_MS + 1 }, () => 0),
    systemGaps: 0,
    maxSystemGapMs: 0,
    last: null,
  });
  type StageTotals = Map<string, { count: number; totalMs: number; maxMs: number }>;
  let window: {
    startedAt: number;
    wallMs: number;
    mode: QuestPerfSample['mode'];
    targetHz: number;
    context: QuestPerfContext | null;
    cadence: CadenceState;
    stages: StageTotals;
    peakWorldDrawCalls: number;
    peakWorldTriangles: number;
  } | null = null;
  let fight: {
    id: string;
    start: number;
    wallMs: number;
    stages: StageTotals;
    cadence: { xr: CadenceState; desktop: CadenceState };
  } | null = null;
  let mode: QuestPerfSample['mode'] = 'desktop';
  let targetHz = 60;

  function aggregateStage(totals: StageTotals, label: string, ms: number): void {
    const current = totals.get(label) ?? { count: 0, totalMs: 0, maxMs: 0 };
    current.count += 1;
    current.totalMs += ms;
    current.maxMs = Math.max(current.maxMs, ms);
    totals.set(label, current);
  }

  function stageLog(totals: StageTotals): QuestPerfStageSummary[] {
    return [...totals].map(([stage, aggregate]) => ({ stage, ...aggregate }));
  }

  function recordCadence(state: CadenceState, time: number, hz: number): void {
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
    if (ms > 1000 / hz) state.misses += 1;
    if (ms > 1000 / 30) state.over33Ms += 1;
  }

  function sameContext(a: QuestPerfContext | null, b: QuestPerfContext | null): boolean {
    return (
      a?.seed === b?.seed &&
      a?.floor === b?.floor &&
      a?.room === b?.room &&
      a?.phase === b?.phase &&
      a?.scale === b?.scale &&
      a?.foveation === b?.foveation
    );
  }

  const persist = (): void => {
    if (!storage) return;
    try {
      storage.setItem(
        QUEST_PERF_STORAGE_NAME,
        JSON.stringify({
          version: 1,
          samples,
          fights,
          currentFight: fightLog('pagehide'),
          windows,
          currentWindow: windowLog(),
        }),
      );
    } catch {
      // The in-memory capture remains useful when storage is unavailable or full.
    }
  };
  const addSample = (label: string, ms: number, depth: number): void => {
    if (window) aggregateStage(window.stages, label, ms);
    if (fight) aggregateStage(fight.stages, label, ms);
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
      over33Ms: state.over33Ms,
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
          stages: stageLog(fight.stages),
          cadence: { xr: cadenceLog(fight.cadence.xr), desktop: cadenceLog(fight.cadence.desktop) },
        }
      : null;
  function windowLog(): QuestPerfWindow | null {
    if (!window || (!window.cadence.frames && !window.cadence.systemGaps)) return null;
    return {
      wallMs: window.wallMs,
      mode: window.mode,
      targetHz: window.targetHz,
      context: window.context,
      cadence: cadenceLog(window.cadence),
      stages: stageLog(window.stages),
      peakWorldDrawCalls: window.peakWorldDrawCalls,
      peakWorldTriangles: window.peakWorldTriangles,
    };
  }

  const profiler: QuestPerfProfiler = {
    setMode(next, displayHz) {
      if (next !== mode && fight) fight.cadence[next].last = null;
      mode = next;
      targetHz = mode === 'xr' ? (displayHz ?? 72) : 60;
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
      persist();
    },
    frame(time, context = null) {
      if (fight) recordCadence(fight.cadence[mode], time, targetHz);
      if (window?.mode === mode) recordCadence(window.cadence, time, window.targetHz);
      if (
        window &&
        window.mode === mode &&
        window.targetHz === targetHz &&
        time - window.startedAt < QUEST_PERF_WINDOW_MS &&
        sameContext(window.context, context)
      )
        return;
      const closed = windowLog();
      if (closed) {
        windows.push(closed);
        if (windows.length > QUEST_PERF_MAX_WINDOWS) windows.shift();
      }
      window = {
        startedAt: time,
        wallMs: Date.now(),
        mode,
        targetHz,
        context,
        cadence: newCadence(),
        stages: new Map(),
        peakWorldDrawCalls: 0,
        peakWorldTriangles: 0,
      };
      window.cadence.last = time;
    },
    worldRender(calls, triangles) {
      if (!window) return;
      window.peakWorldDrawCalls = Math.max(window.peakWorldDrawCalls, calls);
      window.peakWorldTriangles = Math.max(window.peakWorldTriangles, triangles);
    },
    log() {
      return {
        version: 1,
        samples: [...samples],
        fights: [...fights],
        currentFight: fightLog(null),
        windows: [...windows],
        currentWindow: windowLog(),
      };
    },
    clear() {
      samples.length = 0;
      fights.length = 0;
      windows.length = 0;
      window = null;
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
  setMode(mode: 'xr' | 'desktop', displayHz?: number): void;
  start(label: string): number;
  end(token: number): void;
  beginFight(id: string): void;
  endFight(): void;
  frame(time: number, context?: QuestPerfContext | null): void;
  worldRender(calls: number, triangles: number): void;
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

export function questPerfWorldRender(calls: number, triangles: number): void {
  active?.worldRender(calls, triangles);
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
