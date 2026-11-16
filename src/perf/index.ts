import type * as THREE from 'three';
import { createDebugPanel, type DebugPanel } from './debug-panel.ts';
import { type FrameLog, FrameStats, RateSampler } from './frame-stats.ts';
import { DEFAULT_TARGET_HZ, mountPerfGauge, type PerfGauge } from './gauge.ts';
import {
  applySessionScale,
  assertFoveation,
  loadXrScale,
  type ScaleStorage,
  saveXrScale,
  type XrScale,
} from './xr-perf.ts';

export * from './frame-stats.ts';
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
}

export interface PerfHandle {
  /**
   * Call once per rendered frame, before renderer.render. `dtMs` is the raw frame interval in
   * milliseconds, not the clamped simulation delta; pass null to derive it from `now`.
   */
  frame(dtMs: number | null, now: number): void;
  /** Frame log so far, including the in-progress window. */
  log(): FrameLog;
  dispose(): void;
}

export function perfEnabledFromSearch(search: string): boolean {
  return new URLSearchParams(search).get('perf') === '1';
}

/**
 * Wires performance instrumentation. Always: applies the stored framebuffer scale now (call
 * before Enter VR), re-asserts foveation 0.5 every frame, and aggregates 2 s frame windows. With
 * `?perf=1`: also mounts the wrist gauge and the desktop debug panel.
 */
export function mountPerf(
  renderer: THREE.WebGLRenderer,
  _scene: THREE.Scene,
  rig: THREE.Group,
  options: MountPerfOptions,
): PerfHandle {
  const stats = new FrameStats();
  const sampler = new RateSampler();
  const enabled =
    options.enabled ?? perfEnabledFromSearch(options.search ?? globalThis.location?.search ?? '');
  const storage = options.storage;
  const loadedScale = storage === undefined ? loadXrScale() : loadXrScale(storage);
  applySessionScale(renderer, loadedScale);

  let gauge: PerfGauge | null = null;
  let panel: DebugPanel | null = null;
  if (enabled) {
    gauge = mountPerfGauge(renderer, rig, { targetHz: options.targetHz ?? DEFAULT_TARGET_HZ });
    panel = createDebugPanel({
      parent: options.panelParent ?? document.body,
      scale: loadedScale,
      onScale(scale: XrScale) {
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
      assertFoveation(renderer);
      const interval = dtMs ?? (lastNow === null ? null : now - lastNow);
      lastNow = now;
      lastClock = now;
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
    dispose() {
      gauge?.dispose();
      panel?.dispose();
    },
  };
}
