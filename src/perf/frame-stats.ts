/** Window length for frame-time summaries, in milliseconds. */
export const FRAME_WINDOW_MS = 2000;
/** Closed windows retained by default: 10 minutes at 2 s per window. */
export const FRAME_HISTORY_LIMIT = 300;

export interface FrameWindow {
  /** Window start, ms on the caller's clock. */
  start: number;
  /** Window end, ms on the caller's clock. */
  end: number;
  frames: number;
  /** Median frame time, ms. */
  p50: number;
  /** 95th-percentile frame time, ms. */
  p95: number;
  /** Longest frame time, ms. */
  worst: number;
  /** Frames per second over the window: frames / ((end - start) / 1000). */
  fps: number;
}

export interface FrameLog {
  version: 1;
  windowMs: number;
  windows: FrameWindow[];
}

export interface FrameStatsOptions {
  windowMs?: number;
  historyLimit?: number;
}

/**
 * Nearest-rank percentile (no interpolation). With n samples sorted ascending, the p-th
 * percentile is the value at 1-based rank ceil(p / 100 * n), clamped to [1, n]. p is clamped to
 * [0, 100]; an empty input returns 0. The input is not mutated.
 */
export function percentileNearestRank(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((clamped / 100) * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

/**
 * Rolling frame-time aggregator. Feed it every frame's duration and end timestamp. A frame at
 * time t belongs to the window [start, start + windowMs). The first frame fixes the first
 * window's start, and later windows stay aligned to it, so a long stall skips empty windows
 * rather than emitting them.
 */
export class FrameStats {
  readonly windowMs: number;
  readonly historyLimit: number;
  private readonly closed: FrameWindow[] = [];
  private durations: number[] = [];
  private windowStart: number | null = null;

  constructor(options: FrameStatsOptions = {}) {
    const windowMs = options.windowMs ?? FRAME_WINDOW_MS;
    const historyLimit = options.historyLimit ?? FRAME_HISTORY_LIMIT;
    if (!(windowMs > 0) || !Number.isFinite(windowMs)) throw new RangeError('windowMs must be > 0');
    if (!Number.isInteger(historyLimit) || historyLimit < 1)
      throw new RangeError('historyLimit must be a positive integer');
    this.windowMs = windowMs;
    this.historyLimit = historyLimit;
  }

  /**
   * Records one frame. Returns the window this frame closed, or null. Non-finite or negative
   * inputs are ignored.
   */
  record(frameMs: number, nowMs: number): FrameWindow | null {
    if (!Number.isFinite(frameMs) || frameMs < 0 || !Number.isFinite(nowMs)) return null;
    if (this.windowStart === null) this.windowStart = nowMs;
    let summary: FrameWindow | null = null;
    if (nowMs >= this.windowStart + this.windowMs) {
      summary = this.close(this.windowStart + this.windowMs);
      const skipped = Math.floor((nowMs - this.windowStart) / this.windowMs);
      this.windowStart += skipped * this.windowMs;
    }
    this.durations.push(frameMs);
    return summary;
  }

  /**
   * Closes the in-progress window early, ending at endMs, so a session's tail is not lost.
   * Returns null when it holds no frames.
   */
  flush(endMs: number): FrameWindow | null {
    if (this.windowStart === null || this.durations.length === 0) return null;
    const summary = this.close(Math.max(endMs, this.windowStart));
    this.windowStart = null;
    return summary;
  }

  /** The most recently closed window. */
  latest(): FrameWindow | null {
    return this.closed[this.closed.length - 1] ?? null;
  }

  /** Closed windows, oldest first, at most historyLimit of them. */
  history(): readonly FrameWindow[] {
    return this.closed;
  }

  reset(): void {
    this.closed.length = 0;
    this.durations = [];
    this.windowStart = null;
  }

  toJSON(): FrameLog {
    return { version: 1, windowMs: this.windowMs, windows: this.closed.map((w) => ({ ...w })) };
  }

  /** Summary of the in-progress window ending at endMs, without closing it. */
  peek(endMs: number): FrameWindow | null {
    if (this.windowStart === null) return null;
    return this.summarize(this.windowStart, Math.max(endMs, this.windowStart));
  }

  private close(end: number): FrameWindow | null {
    const start = this.windowStart ?? end;
    const summary = this.summarize(start, end);
    if (!summary) return null;
    this.durations = [];
    this.closed.push(summary);
    if (this.closed.length > this.historyLimit)
      this.closed.splice(0, this.closed.length - this.historyLimit);
    return summary;
  }

  private summarize(start: number, end: number): FrameWindow | null {
    const frames = this.durations.length;
    if (frames === 0) return null;
    const seconds = (end - start) / 1000;
    let worst = 0;
    for (const duration of this.durations) worst = Math.max(worst, duration);
    return {
      start,
      end,
      frames,
      p50: percentileNearestRank(this.durations, 50),
      p95: percentileNearestRank(this.durations, 95),
      worst,
      fps: seconds > 0 ? frames / seconds : 0,
    };
  }
}

export interface RateSample {
  fps: number;
  /** Longest frame since the previous sample, ms. */
  worstFrameMs: number;
}

/**
 * Short-interval sampler for the wrist gauge (about 2 Hz). Returns a sample each time intervalMs
 * has elapsed since the previous one.
 */
export class RateSampler {
  private start: number | null = null;
  private frames = 0;
  private worst = 0;

  constructor(readonly intervalMs = 500) {}

  record(frameMs: number, nowMs: number): RateSample | null {
    if (!Number.isFinite(frameMs) || frameMs < 0 || !Number.isFinite(nowMs)) return null;
    if (this.start === null) this.start = nowMs;
    let sample: RateSample | null = null;
    const elapsed = nowMs - this.start;
    if (elapsed >= this.intervalMs) {
      sample = { fps: this.frames / (elapsed / 1000), worstFrameMs: this.worst };
      this.start = nowMs;
      this.frames = 0;
      this.worst = 0;
    }
    this.frames += 1;
    this.worst = Math.max(this.worst, frameMs);
    return sample;
  }
}
