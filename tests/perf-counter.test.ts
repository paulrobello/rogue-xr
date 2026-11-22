import type * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeGauge {
  setSample: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  hitDistance: ReturnType<typeof vi.fn>;
  beginGrab: ReturnType<typeof vi.fn>;
  endGrab: ReturnType<typeof vi.fn>;
}

const gauges = vi.hoisted(() => [] as FakeGauge[]);

vi.mock('../src/perf/gauge.ts', () => ({
  DEFAULT_TARGET_HZ: 72,
  mountPerfGauge: vi.fn(() => {
    const gauge = {
      setSample: vi.fn(),
      update: vi.fn(),
      dispose: vi.fn(),
      hitDistance: vi.fn(() => 0.7),
      beginGrab: vi.fn(() => true),
      endGrab: vi.fn(),
      visible: true,
    };
    gauges.push(gauge);
    return gauge;
  }),
}));

import { mountPerf, perfRecorderFromSearch, perfRecording } from '../src/perf/index.ts';
import type { PerfStorage } from '../src/perf/recorder.ts';

function memoryStorage(): PerfStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function mount(search = '') {
  const renderer = {
    xr: {
      isPresenting: false,
      setFramebufferScaleFactor: vi.fn(),
      setFoveation: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  };
  const perf = mountPerf(
    renderer as unknown as THREE.WebGLRenderer,
    {} as THREE.Scene,
    {} as THREE.Group,
    {
      enabled: false,
      search,
      camera: {} as THREE.Camera,
      storage: { getItem: () => null, setItem: () => undefined },
      perfStorage: memoryStorage(),
    },
  );
  return { perf, renderer };
}

afterEach(() => {
  gauges.length = 0;
  vi.clearAllMocks();
});

describe('FPS counter toggle', () => {
  it('is off at boot: no gauge, no recorder, no per-frame work beyond null checks', () => {
    const { perf } = mount();
    expect(perf.fpsCounter).toBe(false);
    expect(gauges).toHaveLength(0);
    expect(perfRecording()).toBe(false);
    perf.frame(14, 1000);
    perf.dispose();
  });

  it('setFpsCounter(true) mounts the gauge and feeds it, and starts the recorder', () => {
    const { perf } = mount();
    perf.setFpsCounter(true);
    expect(perf.fpsCounter).toBe(true);
    expect(gauges).toHaveLength(1);
    expect(perfRecording()).toBe(true);
    for (let i = 0; i < 80; i += 1) perf.frame(14, 1000 + i * 14);
    expect(gauges[0]?.update).toHaveBeenCalled();
    expect(gauges[0]?.setSample).toHaveBeenCalled();
    perf.dispose();
  });

  it('setFpsCounter(false) removes the gauge and stops the recorder; repeats are no-ops', () => {
    const { perf } = mount();
    perf.setFpsCounter(true);
    perf.setFpsCounter(true);
    expect(gauges).toHaveLength(1);
    perf.setFpsCounter(false);
    perf.setFpsCounter(false);
    expect(perf.fpsCounter).toBe(false);
    expect(gauges[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(perfRecording()).toBe(false);
    const updates = gauges[0]?.update.mock.calls.length;
    perf.frame(14, 5000);
    expect(gauges[0]?.update.mock.calls.length).toBe(updates);
    perf.dispose();
  });

  it('can be switched back on after off', () => {
    const { perf } = mount();
    perf.setFpsCounter(true);
    perf.setFpsCounter(false);
    perf.setFpsCounter(true);
    expect(gauges).toHaveLength(2);
    expect(perf.fpsCounter).toBe(true);
    perf.dispose();
  });

  it('routes aiming, grip and release only to the currently mounted FPS widget', () => {
    const { perf } = mount();
    const ray = {} as THREE.Object3D;
    const grip = {} as THREE.Object3D;
    expect(perf.gaugeHitDistance(ray)).toBeNull();
    expect(perf.grabGauge(ray, grip)).toBe(false);
    perf.setFpsCounter(true);
    expect(perf.gaugeHitDistance(ray)).toBe(0.7);
    expect(perf.grabGauge(ray, grip)).toBe(true);
    expect(gauges[0]?.beginGrab).toHaveBeenCalledWith(ray, grip);
    perf.releaseGauge(grip);
    expect(gauges[0]?.endGrab).toHaveBeenCalledWith(grip);
    perf.setFpsCounter(false);
    perf.releaseGauge(grip);
    expect(gauges[0]?.endGrab).toHaveBeenCalledTimes(1);
    perf.dispose();
  });

  it('keeps the recorder on after the counter goes off when ?perf asked for it', () => {
    const { perf } = mount('?perf');
    expect(perfRecording()).toBe(true);
    perf.setFpsCounter(true);
    perf.setFpsCounter(false);
    expect(perfRecording()).toBe(true);
    perf.dispose();
    expect(perfRecording()).toBe(false);
  });

  it('listens for session start and end while recording, and stops on dispose', () => {
    const { perf, renderer } = mount('?perf');
    const names = renderer.xr.addEventListener.mock.calls.map((c) => c[0]);
    expect(names).toEqual(['sessionstart', 'sessionend']);
    perf.dispose();
    expect(renderer.xr.removeEventListener).toHaveBeenCalledTimes(2);
  });

  it('exposes the windows through __spireDiag().perf and __spirePerfMark', () => {
    const { perf } = mount('?perf');
    const g = globalThis as unknown as {
      __spireDiag: () => { perf: { recording: boolean; windows: unknown[] } };
      __spirePerfMark: (label?: string) => void;
    };
    expect(g.__spireDiag().perf.recording).toBe(true);
    expect(Array.isArray(g.__spireDiag().perf.windows)).toBe(true);
    expect(() => g.__spirePerfMark('manual')).not.toThrow();
    perf.dispose();
    expect(g.__spireDiag().perf.recording).toBe(false);
  });
});

describe('perfRecorderFromSearch', () => {
  it('accepts a bare ?perf and any value but 0', () => {
    expect(perfRecorderFromSearch('?perf')).toBe(true);
    expect(perfRecorderFromSearch('?perf=1')).toBe(true);
    expect(perfRecorderFromSearch('?perf=0')).toBe(false);
    expect(perfRecorderFromSearch('')).toBe(false);
  });
});
