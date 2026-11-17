/**
 * The frame recorder (`?perf`, or the FPS counter on): every frame's interval goes into a
 * preallocated ring, and the session is cut into windows. A window closes, and the next opens,
 * on a mark. Each window leaves out its first `PERF_SETTLE_MS` of frames, then closes into a
 * summary. Summaries persist to localStorage once per close, never per frame. Modelled on
 * gogh-xr's `src/diag/perf.ts`, without its A/B and hand-speed parts.
 */

/** Intervals the ring holds: about 30 minutes at 72 Hz, 512 KB of float32. */
export const PERF_RING_FRAMES = 131_072;
/** Each window's first frames, by their timestamps from its first frame, are not counted. */
export const PERF_SETTLE_MS = 1000;
/** Summaries kept in memory and in storage. */
export const PERF_MAX_WINDOWS = 200;
/** A frame counts as over budget past this multiple of the budget: at least one missed vsync. */
export const PERF_OVER_FACTOR = 1.5;
/** A frame counts as over twice the budget past this multiple: at least two missed vsyncs. */
export const PERF_OVER_2X_FACTOR = 2.5;
/** A frame interval this long is a pause (hidden tab, system menu), not a slow frame. */
export const PERF_PAUSE_MS = 5000;
export const PERF_STORAGE_NAME = 'rogue-xr.perf.v1';
/** The stored list never passes this many characters of JSON: the oldest windows go first. */
export const PERF_STORAGE_MAX_CHARS = 400_000;
/** Hitches kept in memory and in storage: the newest win. */
export const PERF_MAX_HITCHES = 500;
/** A frame is a hitch past this multiple of the budget (or of 60 Hz without one): a missed vsync. */
export const PERF_HITCH_FACTOR = 1.5;
/** Budget used for hitches when the app has no XR target rate. */
export const PERF_DEFAULT_BUDGET_MS = 1000 / 60;

/** What the app reports about itself around a window. */
export interface PerfContext {
  /** The XR target frame rate, or null on the desktop. */
  readonly targetHz: number | null;
  readonly foveation: number | null;
  /** The framebuffer scale factor, or null when unknown. */
  readonly scale: number | null;
}

export interface PerfSummary {
  /** Why the window opened: `boot`, a mark's label, ... */
  readonly label: string;
  /** Why it closed, the next window's label; null for the live window. */
  readonly closedBy: string | null;
  /** performance.now() at the window's first frame. Resets on a reload. */
  readonly startMs: number;
  /** Date.now() at the window's first frame, which survives a reload. */
  readonly wallMs: number;
  /** Sum of the counted intervals. */
  readonly durationMs: number;
  /** Counted frames: after the settle. */
  readonly frames: number;
  /** True when every counted frame presented in XR. */
  readonly presenting: boolean;
  readonly targetHz: number | null;
  readonly budgetMs: number | null;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
  /** Share of counted frames over PERF_OVER_FACTOR x budget, percent; null without a budget. */
  readonly overBudgetPct: number | null;
  /** Share over PERF_OVER_2X_FACTOR x budget, percent. */
  readonly over2xBudgetPct: number | null;
  readonly fps: number | null;
  readonly foveation: number | null;
  readonly scale: number | null;
  /** The window held more frames than the ring: its stats cover the last PERF_RING_FRAMES. */
  readonly truncated: boolean;
}

/**
 * One slow frame, kept even inside a window's settle or on the first frame after a mark, where
 * the window statistics never see it: a mark at a throw or a cast lands in the same frame as the
 * work it labels.
 */
export interface PerfHitch {
  /** The open window's label when the slow frame ended. */
  readonly label: string;
  /** The frame interval. */
  readonly ms: number;
  /** Time from the mark to the end of the slow frame. */
  readonly sinceMarkMs: number;
  readonly wallMs: number;
  readonly presenting: boolean;
}

export interface PerfStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PerfRecorderOptions {
  /**
   * The live context. `presenting` is the window's own state (whether all its counted frames
   * presented), because three flips `isPresenting` before it dispatches `sessionstart` and
   * `sessionend`, so the live state at a close on those events belongs to the next window.
   */
  readonly context: (presenting: boolean) => PerfContext;
  readonly storage?: PerfStorage | null;
  readonly now?: () => number;
  readonly wallNow?: () => number;
  readonly ringFrames?: number;
  readonly settleMs?: number;
  readonly maxWindows?: number;
}

export interface PerfRecorder {
  /** One animation frame at rAF time `timeMs` (XR's while presenting). A few stores, no allocation. */
  frame(timeMs: number, presenting: boolean): void;
  /** Closes the open window into a summary and opens the next, labelled `label`. */
  mark(label?: string): void;
  windows(): PerfSummary[];
  /** Slow frames, oldest first, including the ones the windows leave out. */
  hitches(): PerfHitch[];
  /** The open window as it would close now. */
  current(): PerfSummary;
  /** Empties the windows and hitches, in memory and in storage. The open window keeps running. */
  clear(): void;
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentileSorted(sorted: ArrayLike<number>, p: number): number | null {
  const n = sorted.length;
  if (n === 0) return null;
  const rank = Math.ceil((p / 100) * n);
  return sorted[Math.min(n - 1, Math.max(0, rank - 1))] ?? null;
}

/** The windows stored under `PERF_STORAGE_NAME`, or an empty list for missing or foreign data. */
export function readStoredWindows(storage: PerfStorage | null): PerfSummary[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PERF_STORAGE_NAME);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: unknown; windows?: unknown } | null;
    if (parsed?.version !== 1 || !Array.isArray(parsed.windows)) return [];
    return parsed.windows as PerfSummary[];
  } catch {
    return [];
  }
}

/** The hitches stored under `PERF_STORAGE_NAME`, or an empty list. */
export function readStoredHitches(storage: PerfStorage | null): PerfHitch[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PERF_STORAGE_NAME);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: unknown; hitches?: unknown } | null;
    if (parsed?.version !== 1 || !Array.isArray(parsed.hitches)) return [];
    return parsed.hitches as PerfHitch[];
  } catch {
    return [];
  }
}

/** The JSON stored for `windows` and `hitches`, dropping the oldest until it fits `maxChars`. */
export function storedJson(
  windows: readonly PerfSummary[],
  maxChars: number,
  hitches: readonly PerfHitch[] = [],
): string {
  let start = 0;
  let hitchStart = 0;
  const encode = (): string =>
    hitches.length > 0
      ? JSON.stringify({
          version: 1,
          windows: windows.slice(start),
          hitches: hitches.slice(hitchStart),
        })
      : JSON.stringify({ version: 1, windows: windows.slice(start) });
  let json = encode();
  while (json.length > maxChars && (start < windows.length || hitchStart < hitches.length)) {
    if (start < windows.length) start += Math.max(1, Math.ceil((windows.length - start) / 10));
    if (hitchStart < hitches.length)
      hitchStart += Math.max(1, Math.ceil((hitches.length - hitchStart) / 10));
    json = encode();
  }
  return json;
}

export function createPerfRecorder(options: PerfRecorderOptions): PerfRecorder {
  const ringFrames = options.ringFrames ?? PERF_RING_FRAMES;
  const settleMs = options.settleMs ?? PERF_SETTLE_MS;
  const maxWindows = options.maxWindows ?? PERF_MAX_WINDOWS;
  const now = options.now ?? ((): number => performance.now());
  const wallNow = options.wallNow ?? ((): number => Date.now());
  const storage = options.storage ?? null;
  const ring = new Float32Array(ringFrames);
  const scratch = new Float32Array(ringFrames);
  const windows: PerfSummary[] = readStoredWindows(storage).slice(-maxWindows);
  const hitches: PerfHitch[] = readStoredHitches(storage).slice(-PERF_MAX_HITCHES);
  /** Frame time of the last mark's first frame, for `sinceMarkMs`. */
  let markTime: number | null = null;
  /** The hitch threshold, refreshed from the context on each mark. */
  let hitchMs = hitchThreshold();
  /** Hitches recorded since the last write to storage. */
  let unsavedHitches = 0;

  /** Frames ever written to the ring. */
  let written = 0;
  let lastTime: number | null = null;
  let label = 'boot';
  /** The open window's first frame time, or null until its first frame. */
  let openTime: number | null = null;
  let startMs = 0;
  let wallMs = 0;
  /** Index (in `written`) of the window's first counted frame, or -1 while settling. */
  let countFrom = -1;
  let presentingFrames = 0;

  function hitchThreshold(): number {
    const hz = options.context(false).targetHz;
    return PERF_HITCH_FACTOR * (hz && hz > 0 ? 1000 / hz : PERF_DEFAULT_BUDGET_MS);
  }

  function frame(timeMs: number, presenting: boolean): void {
    const previous = lastTime;
    lastTime = timeMs;
    if (previous !== null && timeMs > previous) {
      const dt = timeMs - previous;
      if (dt > hitchMs && dt <= PERF_PAUSE_MS) {
        hitches.push({
          label,
          ms: dt,
          sinceMarkMs: markTime === null ? dt : timeMs - markTime,
          wallMs: wallNow(),
          presenting,
        });
        if (hitches.length > PERF_MAX_HITCHES) hitches.splice(0, hitches.length - PERF_MAX_HITCHES);
        unsavedHitches += 1;
      }
    }
    if (markTime === null) markTime = previous ?? timeMs;
    if (openTime === null) {
      openTime = timeMs;
      startMs = now();
      wallMs = wallNow();
      return;
    }
    if (previous === null || !(timeMs > previous) || timeMs - previous > PERF_PAUSE_MS) return;
    if (countFrom < 0) {
      if (timeMs - openTime < settleMs) return;
      countFrom = written;
    }
    ring[written % ringFrames] = timeMs - previous;
    written += 1;
    if (presenting) presentingFrames += 1;
  }

  function summarise(closedBy: string | null): PerfSummary {
    const counted = countFrom < 0 ? 0 : written - countFrom;
    const n = Math.min(counted, ringFrames);
    const presenting = n > 0 && presentingFrames >= counted;
    const ctx = options.context(presenting);
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      const v = ring[(written - n + i) % ringFrames] ?? 0;
      scratch[i] = v;
      sum += v;
    }
    const sorted = scratch.subarray(0, n).sort();
    const targetHz = ctx.targetHz;
    const budgetMs = targetHz && targetHz > 0 ? 1000 / targetHz : null;
    let over = 0;
    let over2 = 0;
    if (budgetMs !== null) {
      for (let i = 0; i < n; i += 1) {
        const v = sorted[i] ?? 0;
        if (v > budgetMs * PERF_OVER_FACTOR) over += 1;
        if (v > budgetMs * PERF_OVER_2X_FACTOR) over2 += 1;
      }
    }
    const pct = (k: number): number | null => (budgetMs === null || n === 0 ? null : (100 * k) / n);
    return {
      label,
      closedBy,
      startMs,
      wallMs,
      durationMs: sum,
      frames: n,
      presenting,
      targetHz,
      budgetMs,
      meanMs: n > 0 ? sum / n : null,
      p50Ms: percentileSorted(sorted, 50),
      p95Ms: percentileSorted(sorted, 95),
      p99Ms: percentileSorted(sorted, 99),
      maxMs: n > 0 ? (sorted[n - 1] ?? null) : null,
      overBudgetPct: pct(over),
      over2xBudgetPct: pct(over2),
      fps: n > 0 && sum > 0 ? (1000 * n) / sum : null,
      foveation: ctx.foveation,
      scale: ctx.scale,
      truncated: counted > ringFrames,
    };
  }

  function persist(): void {
    unsavedHitches = 0;
    if (!storage) return;
    try {
      storage.setItem(PERF_STORAGE_NAME, storedJson(windows, PERF_STORAGE_MAX_CHARS, hitches));
    } catch {
      // Quota or storage off: the in-memory list still holds the windows.
    }
  }

  return {
    frame,
    mark(next = 'mark') {
      if (openTime !== null) {
        const summary = summarise(next);
        // A window closed inside its settle measured nothing.
        if (summary.frames > 0) {
          windows.push(summary);
          if (windows.length > maxWindows) windows.splice(0, windows.length - maxWindows);
          persist();
        } else if (unsavedHitches > 0) {
          persist();
        }
      }
      label = next;
      markTime = null;
      hitchMs = hitchThreshold();
      openTime = null;
      countFrom = -1;
      presentingFrames = 0;
    },
    windows: () => [...windows],
    hitches: () => [...hitches],
    current: () => summarise(null),
    clear() {
      windows.length = 0;
      hitches.length = 0;
      if (!storage) return;
      try {
        storage.removeItem(PERF_STORAGE_NAME);
      } catch {
        // Storage off: nothing to remove.
      }
    },
  };
}
