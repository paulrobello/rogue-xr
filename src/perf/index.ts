import type * as THREE from 'three';
import { registerDiag } from '../diag/diag.ts';
import { createDebugPanel, type DebugPanel } from './debug-panel.ts';
import { type FrameLog, FrameStats, RateSampler } from './frame-stats.ts';
import { DEFAULT_TARGET_HZ, mountPerfGauge, type PerfGauge } from './gauge.ts';
import { perfMark, setActivePerfRecorder } from './marks.ts';
import {
  createPerfRecorder,
  type PerfRecorder,
  type PerfStorage,
  readStoredWindows,
} from './recorder.ts';
import {
  applySessionScale,
  assertFoveation,
  loadXrScale,
  type ScaleStorage,
  saveXrScale,
  XR_FOVEATION,
  type XrScale,
} from './xr-perf.ts';

export * from './frame-stats.ts';
export * from './marks.ts';
export * from './recorder.ts';
export * from './xr-perf.ts';

/** A frame interval this long is a pause (hidden tab, system menu), not a slow frame. */
export const PERF_PAUSE_MS = 5000;

export interface MountPerfOptions {
  /** Force the dev tools on or off. Default: the `?perf=1` query parameter. */
  enabled?: boolean;
  /** Query string to read the flag from. Default: location.search. */
  search?: string;
  /** The main camera; the gauge faces it and floats in front of it when no wrist is tracked. */
  camera: THREE.Camera;
  /** Display refresh rate frame pacing is judged against. Default 72. */
  targetHz?: number;
  /** Where the debug panel mounts. Default: document.body. */
  panelParent?: HTMLElement;
  storage?: ScaleStorage | null;
  /** three.js foveation (0 off, 1 maximum) re-asserted every frame. Default `XR_FOVEATION`. */
  foveation?: number;
  /** Where the frame recorder keeps its windows. Default: localStorage, or none when unavailable. */
  perfStorage?: PerfStorage | null;
}

export interface PerfHandle {
  /**
   * Call once per rendered frame, before renderer.render. `dtMs` is the raw frame interval in
   * milliseconds, not the clamped simulation delta; pass null to derive it from `now`.
   */
  frame(dtMs: number | null, now: number): void;
  /** Frame log so far, including the in-progress window. */
  log(): FrameLog;
  /** Changes the foveation `frame` re-asserts (three.js: 0 off, 1 maximum), from the next frame. */
  setFoveation(level: number): void;
  /**
   * Shows or hides the FPS counter (the gauge) at runtime, and starts or stops the frame
   * recorder with it unless `?perf` keeps the recorder on. Off, the per-frame cost is a null check.
   */
  setFpsCounter(on: boolean): void;
  /** True while the FPS counter is shown. */
  readonly fpsCounter: boolean;
  dispose(): void;
}

export function perfEnabledFromSearch(search: string): boolean {
  return new URLSearchParams(search).get('perf') === '1';
}

/** True when the query asks for the frame recorder: `?perf` with any value but `0`. */
export function perfRecorderFromSearch(search: string): boolean {
  const value = new URLSearchParams(search).get('perf');
  return value !== null && value !== '0';
}

function defaultPerfStorage(): PerfStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

type PerfGlobals = { __spirePerfMark?: (label?: string) => void; __spirePerfClear?: () => void };

/**
 * Wires performance instrumentation. Always: applies the stored framebuffer scale now (call
 * before Enter VR), re-asserts the foveation level (`options.foveation`, then `setFoveation`)
 * every frame, and aggregates 2 s frame windows. With
 * `?perf=1`: also mounts the wrist gauge and the desktop debug panel. The frame recorder runs
 * with `?perf` or while the FPS counter is on, and `perfMark` feeds it.
 */
export function mountPerf(
  renderer: THREE.WebGLRenderer,
  _scene: THREE.Scene,
  rig: THREE.Group,
  options: MountPerfOptions,
): PerfHandle {
  const stats = new FrameStats();
  const sampler = new RateSampler();
  const search = options.search ?? globalThis.location?.search ?? '';
  const enabled = options.enabled ?? perfEnabledFromSearch(search);
  const recorderFlag = enabled || perfRecorderFromSearch(search);
  const perfStorage =
    options.perfStorage === undefined ? defaultPerfStorage() : options.perfStorage;
  const storage = options.storage;
  const loadedScale = storage === undefined ? loadXrScale() : loadXrScale(storage);
  applySessionScale(renderer, loadedScale);
  let foveation = options.foveation ?? XR_FOVEATION;

  let gauge: PerfGauge | null = null;
  let panel: DebugPanel | null = null;
  let recorder: PerfRecorder | null = null;

  const mountGauge = (): PerfGauge =>
    mountPerfGauge(renderer, rig, { targetHz: options.targetHz ?? DEFAULT_TARGET_HZ });
  const onSessionStart = (): void => perfMark('xr-start');
  const onSessionEnd = (): void => perfMark('xr-end');
  const onPageHide = (): void => perfMark('pagehide');

  function startRecorder(): void {
    recorder = createPerfRecorder({
      storage: perfStorage,
      context: (presenting) => ({
        targetHz: presenting
          ? (renderer.xr.getSession?.()?.frameRate ?? options.targetHz ?? DEFAULT_TARGET_HZ)
          : null,
        foveation,
        scale: loadedScale,
      }),
    });
    setActivePerfRecorder(recorder);
    renderer.xr.addEventListener?.('sessionstart', onSessionStart);
    renderer.xr.addEventListener?.('sessionend', onSessionEnd);
    globalThis.addEventListener?.('pagehide', onPageHide);
  }

  function stopRecorder(): void {
    perfMark('recorder-off');
    setActivePerfRecorder(null);
    renderer.xr.removeEventListener?.('sessionstart', onSessionStart);
    renderer.xr.removeEventListener?.('sessionend', onSessionEnd);
    globalThis.removeEventListener?.('pagehide', onPageHide);
    recorder = null;
  }

  /** The recorder runs for `?perf` and while the counter is on. */
  function syncRecorder(): void {
    const want = recorderFlag || gauge !== null;
    if (want && !recorder) startRecorder();
    else if (!want && recorder) stopRecorder();
  }

  const target = globalThis as PerfGlobals;
  target.__spirePerfMark = (label) => perfMark(label || 'mark');
  target.__spirePerfClear = () => recorder?.clear();
  registerDiag('perf', () => ({
    recording: recorder !== null,
    windows: recorder ? recorder.windows() : readStoredWindows(perfStorage),
    current: recorder ? recorder.current() : null,
  }));

  if (enabled) {
    gauge = mountGauge();
    panel = createDebugPanel({
      parent: options.panelParent ?? document.body,
      scale: loadedScale,
      onScale(scale: XrScale) {
        perfMark(`scale ${scale}`);
        const saved = storage === undefined ? saveXrScale(scale) : saveXrScale(scale, storage);
        if (!applySessionScale(renderer, scale))
          return 'In a session: saved, applies at the next Enter VR.';
        return saved
          ? 'Saved. Applies at the next Enter VR.'
          : 'Applies at the next Enter VR (not saved).';
      },
      onDownload() {
        return JSON.stringify(currentLog(), null, 2);
      },
    });
  }

  syncRecorder();

  let lastNow: number | null = null;
  let lastClock = 0;

  function currentLog(): FrameLog {
    const log = stats.toJSON();
    const partial = stats.peek(lastClock);
    if (partial) log.windows.push(partial);
    return log;
  }

  return {
    frame(dtMs, now) {
      assertFoveation(renderer, foveation);
      const interval = dtMs ?? (lastNow === null ? null : now - lastNow);
      lastNow = now;
      lastClock = now;
      recorder?.frame(now, renderer.xr.isPresenting);
      if (interval === null || !(interval > 0) || interval > PERF_PAUSE_MS) {
        gauge?.update(options.camera);
        return;
      }
      const closed = stats.record(interval, now);
      if (closed) panel?.setWindow(closed);
      const sample = sampler.record(interval, now);
      if (sample) gauge?.setSample(sample);
      gauge?.update(options.camera);
    },
    log: currentLog,
    setFoveation(level) {
      if (level !== foveation) perfMark(`foveation ${level}`);
      foveation = level;
    },
    setFpsCounter(on) {
      if (on === (gauge !== null)) return;
      if (on) {
        gauge = mountGauge();
      } else {
        gauge?.dispose();
        gauge = null;
      }
      syncRecorder();
    },
    get fpsCounter() {
      return gauge !== null;
    },
    dispose() {
      gauge?.dispose();
      panel?.dispose();
      gauge = null;
      if (recorder) stopRecorder();
    },
  };
}
