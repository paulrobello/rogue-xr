import { pickFlingTarget, speedOf } from './aim.ts';
import { releaseVelocity, SampleWindow, type Vec3 } from './velocity.ts';

/**
 * One release as the headset saw it: the grip samples the velocity fit read, the targets on offer
 * and what the controller decided. Saved under `?debug` so real Quest flicks can become replay
 * fixtures (`tests/fixtures/fling/recorded/`). Same `samples` layout as the synthetic fixtures:
 * `[t, x, y, z]` per frame, seconds from the first sample, world metres.
 */
export interface FlingTrace {
  readonly name: string;
  /** Wall-clock time of the release, ISO 8601. */
  readonly recordedAt: string;
  /** Median sample rate of the trace, Hz. */
  readonly hz: number;
  readonly windowSeconds: number;
  readonly coneDeg: number;
  readonly minSpeed: number;
  /** Time of the last sample, the release frame, on the `samples` clock. */
  readonly releaseTime: number;
  readonly samples: readonly (readonly [number, number, number, number])[];
  /** The card's world position at release, where the aim cone starts. */
  readonly origin: Vec3;
  readonly cardId: string;
  readonly cardTarget: string;
  readonly targets: readonly {
    readonly id: string;
    readonly position: Vec3;
    readonly radius?: number;
    readonly valid: boolean;
  }[];
  readonly decision: {
    readonly outcome: string;
    readonly via: string;
    readonly targetId: string | null;
    readonly speed: number;
    readonly angleDeg: number | null;
  };
  /** The enemy the player meant to hit, filled in by hand from the session's notes. */
  readonly intended: string | null;
}

/** Round to 0.1 mm / 0.1 ms: the headset's tracking noise is far coarser. */
const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** Copies a sample window into the trace layout, re-based so the first sample is at t = 0. */
export function traceSamples(window: SampleWindow): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  if (window.size === 0) return out;
  const t0 = window.timeAt(0);
  for (let i = 0; i < window.size; i++) {
    out.push([
      r4(window.timeAt(i) - t0),
      r4(window.coordAt(i, 0)),
      r4(window.coordAt(i, 1)),
      r4(window.coordAt(i, 2)),
    ]);
  }
  return out;
}

/** Median frame rate of a trace, 0 with fewer than two samples. */
export function medianHz(samples: readonly (readonly number[])[]): number {
  const steps: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = (samples[i]?.[0] as number) - (samples[i - 1]?.[0] as number);
    if (dt > 0) steps.push(dt);
  }
  if (steps.length === 0) return 0;
  steps.sort((a, b) => a - b);
  return Math.round(1 / (steps[Math.floor(steps.length / 2)] as number));
}

/** The newest `capacity` traces, kept for one page session and downloaded as JSON. */
export class FlingTraceLog {
  enabled = false;
  readonly capacity: number;
  private readonly list: FlingTrace[] = [];
  private count = 0;

  constructor(capacity = 40) {
    this.capacity = capacity;
  }

  get traces(): readonly FlingTrace[] {
    return this.list;
  }

  /** Next trace name, `fling-001` upward for the page session. */
  nextName(): string {
    this.count += 1;
    return `fling-${String(this.count).padStart(3, '0')}`;
  }

  add(trace: FlingTrace): void {
    this.list.push(trace);
    if (this.list.length > this.capacity) this.list.shift();
  }

  clear(): void {
    this.list.length = 0;
  }

  toJson(): string {
    return JSON.stringify({ traces: this.list }, null, 1);
  }
}

/** The page's trace log. Off unless the page turns it on (`?debug`). */
export const flingTraceLog = new FlingTraceLog();

/** What the release logic decides from a saved trace alone: its throw speed and flick target. */
export interface TraceReplay {
  readonly speed: number;
  /** The flick's aim-assisted target, null below the flick speed or with nothing in the cone. */
  readonly flickTarget: string | null;
  readonly angleDeg: number | null;
}

/** Re-runs the velocity fit and the aim cone on a saved trace, for replay fixtures. */
export function replayTrace(trace: FlingTrace): TraceReplay {
  const window = new SampleWindow(Math.max(48, trace.samples.length));
  for (const [t, x, y, z] of trace.samples) window.push(t, x, y, z);
  const velocity = releaseVelocity(window, { windowSeconds: trace.windowSeconds });
  if (!velocity) return { speed: 0, flickTarget: null, angleDeg: null };
  const pick = pickFlingTarget(trace.origin, velocity, trace.targets, {
    coneDeg: trace.coneDeg,
    minSpeed: trace.minSpeed,
  });
  return {
    speed: speedOf(velocity),
    flickTarget: pick?.id ?? null,
    angleDeg: pick?.angleDeg ?? null,
  };
}
