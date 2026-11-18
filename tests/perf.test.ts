import { FOVEATION_LEVELS } from '@par/xr-workspace';
import type * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { FrameStats, percentileNearestRank, RateSampler } from '../src/perf/frame-stats.ts';
import { mountPerf, scaleOverrideFromSearch } from '../src/perf/index.ts';
import {
  applySessionScale,
  assertFoveation,
  DEFAULT_XR_SCALE,
  foveationValue,
  isXrScale,
  loadXrScale,
  saveXrScale,
  XR_FOVEATION,
  XR_SCALE_OPTIONS,
  XR_SCALE_STORAGE_KEY,
} from '../src/perf/xr-perf.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

describe('percentileNearestRank', () => {
  const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];

  it('uses rank ceil(p/100 * n) on the sorted values', () => {
    expect(percentileNearestRank(ten, 50)).toBe(5);
    expect(percentileNearestRank(ten, 95)).toBe(10);
    expect(percentileNearestRank(ten, 90)).toBe(9);
    expect(percentileNearestRank(ten, 10)).toBe(1);
    expect(percentileNearestRank(ten, 11)).toBe(2);
  });

  it('clamps p, handles empty and single inputs, and does not mutate', () => {
    const input = [3, 1, 2];
    expect(percentileNearestRank(input, 0)).toBe(1);
    expect(percentileNearestRank(input, -5)).toBe(1);
    expect(percentileNearestRank(input, 100)).toBe(3);
    expect(percentileNearestRank(input, 250)).toBe(3);
    expect(input).toEqual([3, 1, 2]);
    expect(percentileNearestRank([], 50)).toBe(0);
    expect(percentileNearestRank([7], 95)).toBe(7);
  });

  it('p95 of 100 samples is the 95th value, not interpolated', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileNearestRank(hundred, 95)).toBe(95);
    expect(percentileNearestRank(hundred, 50)).toBe(50);
  });
});

describe('FrameStats windows', () => {
  it('emits a summary when a frame crosses the 2 s boundary', () => {
    const stats = new FrameStats();
    // 20 frames at t = 0, 100, ..., 1900 with durations 1..20 ms.
    for (let i = 0; i < 20; i += 1) expect(stats.record(i + 1, i * 100)).toBeNull();
    const closed = stats.record(14, 2000);
    expect(closed).toEqual({
      start: 0,
      end: 2000,
      frames: 20,
      p50: 10,
      p95: 19,
      worst: 20,
      fps: 10,
    });
    expect(stats.latest()).toBe(closed);
  });

  it('keeps a frame at start + windowMs - 1 in the window and start + windowMs in the next', () => {
    const stats = new FrameStats();
    stats.record(5, 0);
    expect(stats.record(6, 1999)).toBeNull();
    const closed = stats.record(7, 2000);
    expect(closed?.frames).toBe(2);
    const next = stats.record(8, 4000);
    expect(next).toMatchObject({ start: 2000, end: 4000, frames: 1, worst: 7 });
  });

  it('skips empty windows after a stall and realigns to the original grid', () => {
    const stats = new FrameStats();
    stats.record(10, 100);
    const closed = stats.record(500, 7300);
    expect(closed).toMatchObject({ start: 100, end: 2100, frames: 1 });
    expect(stats.history()).toHaveLength(1);
    const after = stats.record(10, 8100);
    expect(after).toMatchObject({ start: 6100, end: 8100, frames: 1, worst: 500 });
  });

  it('reports the worst frame and fps for a steady 72 Hz run', () => {
    const stats = new FrameStats();
    const dt = 1000 / 72;
    for (let i = 0; i < 144; i += 1) stats.record(i === 50 ? 40 : dt, i * dt);
    const closed = stats.record(dt, 144 * dt);
    expect(closed?.frames).toBe(144);
    expect(closed?.worst).toBe(40);
    expect(closed?.fps).toBeCloseTo(72, 6);
    expect(closed?.p50).toBeCloseTo(dt, 9);
    expect(closed?.p95).toBeCloseTo(dt, 9);
  });

  it('ignores invalid frames', () => {
    const stats = new FrameStats();
    expect(stats.record(Number.NaN, 0)).toBeNull();
    expect(stats.record(-1, 0)).toBeNull();
    expect(stats.record(5, Number.POSITIVE_INFINITY)).toBeNull();
    expect(stats.flush(10)).toBeNull();
  });

  it('rejects bad options', () => {
    expect(() => new FrameStats({ windowMs: 0 })).toThrow(RangeError);
    expect(() => new FrameStats({ historyLimit: 0 })).toThrow(RangeError);
    expect(() => new FrameStats({ historyLimit: 1.5 })).toThrow(RangeError);
  });
});

describe('FrameStats history and export', () => {
  it('keeps only the newest historyLimit windows', () => {
    const stats = new FrameStats({ historyLimit: 3 });
    for (let w = 0; w < 6; w += 1) stats.record(w + 1, w * 2000);
    stats.record(1, 6 * 2000);
    const history = stats.history();
    expect(history).toHaveLength(3);
    expect(history.map((window) => window.start)).toEqual([6000, 8000, 10000]);
  });

  it('exports versioned JSON that round-trips', () => {
    const stats = new FrameStats();
    stats.record(12, 0);
    stats.record(16, 1000);
    stats.record(20, 2000);
    const parsed = JSON.parse(JSON.stringify(stats));
    expect(parsed).toEqual({
      version: 1,
      windowMs: 2000,
      windows: [{ start: 0, end: 2000, frames: 2, p50: 12, p95: 16, worst: 16, fps: 1 }],
    });
    expect(Object.keys(parsed.windows[0]).sort()).toEqual(
      ['start', 'end', 'frames', 'p50', 'p95', 'worst', 'fps'].sort(),
    );
  });

  it('flush closes a partial window with its real duration; peek does not close it', () => {
    const stats = new FrameStats();
    stats.record(10, 0);
    stats.record(30, 500);
    expect(stats.peek(1000)).toMatchObject({ frames: 2, end: 1000, fps: 2, worst: 30 });
    expect(stats.history()).toHaveLength(0);
    const flushed = stats.flush(1000);
    expect(flushed).toMatchObject({ start: 0, end: 1000, frames: 2, p95: 30 });
    expect(stats.history()).toHaveLength(1);
    expect(stats.flush(2000)).toBeNull();
  });

  it('reset clears history and the open window', () => {
    const stats = new FrameStats();
    stats.record(10, 0);
    stats.record(10, 2000);
    stats.reset();
    expect(stats.history()).toHaveLength(0);
    expect(stats.latest()).toBeNull();
    expect(stats.peek(5000)).toBeNull();
  });
});

describe('RateSampler', () => {
  it('emits fps and worst frame each interval', () => {
    const sampler = new RateSampler(500);
    const samples = [];
    for (let i = 0; i <= 100; i += 1) {
      const sample = sampler.record(i === 20 ? 30 : 10, i * 10);
      if (sample) samples.push(sample);
    }
    expect(samples).toHaveLength(2);
    expect(samples[0]).toEqual({ fps: 100, worstFrameMs: 30 });
    expect(samples[1]).toEqual({ fps: 100, worstFrameMs: 10 });
  });
});

describe('XR scale options', () => {
  it('lists ascending valid options including the default', () => {
    expect([...XR_SCALE_OPTIONS]).toEqual([...XR_SCALE_OPTIONS].sort((a, b) => a - b));
    expect(XR_SCALE_OPTIONS).toContain(DEFAULT_XR_SCALE);
    expect(XR_SCALE_OPTIONS).toContain(1.0);
    expect(isXrScale(0.9)).toBe(true);
    expect(isXrScale(0.95)).toBe(false);
    expect(isXrScale('1')).toBe(false);
    expect(isXrScale(Number.NaN)).toBe(false);
  });

  it('persists a valid scale and reads it back', () => {
    const storage = memoryStorage();
    expect(saveXrScale(1.1, storage)).toBe(true);
    expect(storage.data.get(XR_SCALE_STORAGE_KEY)).toBe('1.1');
    expect(loadXrScale(storage)).toBe(1.1);
  });

  it('falls back to the default for missing, invalid, or unreadable storage', () => {
    expect(loadXrScale(memoryStorage())).toBe(DEFAULT_XR_SCALE);
    expect(loadXrScale(memoryStorage({ [XR_SCALE_STORAGE_KEY]: '3' }))).toBe(DEFAULT_XR_SCALE);
    expect(loadXrScale(memoryStorage({ [XR_SCALE_STORAGE_KEY]: 'abc' }))).toBe(DEFAULT_XR_SCALE);
    expect(loadXrScale(null)).toBe(DEFAULT_XR_SCALE);
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadXrScale(throwing)).toBe(DEFAULT_XR_SCALE);
    expect(saveXrScale(1.0, throwing)).toBe(false);
  });

  it('refuses to save an unlisted scale', () => {
    const storage = memoryStorage();
    expect(saveXrScale(0.5, storage)).toBe(false);
    expect(storage.data.size).toBe(0);
    expect(saveXrScale(1.0, null)).toBe(false);
  });
});

describe('renderer hooks', () => {
  function fakeRenderer(isPresenting: boolean) {
    return {
      xr: {
        isPresenting,
        setFramebufferScaleFactor: vi.fn(),
        setFoveation: vi.fn(),
      },
    };
  }

  it('applySessionScale sets the factor before a session and refuses afterwards', () => {
    const idle = fakeRenderer(false);
    expect(applySessionScale(idle, 0.9)).toBe(true);
    expect(idle.xr.setFramebufferScaleFactor).toHaveBeenCalledWith(0.9);
    expect(applySessionScale(idle, 0.95)).toBe(false);
    expect(idle.xr.setFramebufferScaleFactor).toHaveBeenCalledTimes(1);

    const live = fakeRenderer(true);
    expect(applySessionScale(live, 0.9)).toBe(false);
    expect(live.xr.setFramebufferScaleFactor).not.toHaveBeenCalled();
  });

  it('assertFoveation re-asserts 0.5 every presenting frame and is idle otherwise', () => {
    const live = fakeRenderer(true);
    assertFoveation(live);
    assertFoveation(live);
    expect(live.xr.setFoveation).toHaveBeenCalledTimes(2);
    expect(live.xr.setFoveation).toHaveBeenLastCalledWith(XR_FOVEATION);
    expect(XR_FOVEATION).toBe(0.5);

    const idle = fakeRenderer(false);
    assertFoveation(idle);
    expect(idle.xr.setFoveation).not.toHaveBeenCalled();
  });
});

describe('foveation setting (F4)', () => {
  const presenting = () => ({
    xr: {
      isPresenting: true,
      setFramebufferScaleFactor: vi.fn(),
      setFoveation: vi.fn(),
    },
  });

  it('maps off, low, medium and high to 0, 0.25, 0.5 and 1, medium being the old default', () => {
    expect(foveationValue('off')).toBe(0);
    expect(foveationValue('low')).toBe(0.25);
    expect(foveationValue('medium')).toBe(0.5);
    expect(foveationValue('high')).toBe(1);
    expect(foveationValue('medium')).toBe(XR_FOVEATION);
    for (const [level, value] of Object.entries(FOVEATION_LEVELS)) {
      expect(foveationValue(level as keyof typeof FOVEATION_LEVELS)).toBe(value);
    }
  });

  it('re-asserts the chosen level every frame without ?perf=1, and a change from the next frame', () => {
    const renderer = presenting();
    const perf = mountPerf(
      renderer as unknown as THREE.WebGLRenderer,
      {} as THREE.Scene,
      {} as THREE.Group,
      {
        enabled: false,
        camera: {} as THREE.Camera,
        storage: memoryStorage(),
        foveation: foveationValue('low'),
      },
    );
    perf.frame(14, 1000);
    expect(renderer.xr.setFoveation).toHaveBeenLastCalledWith(0.25);
    perf.setFoveation(foveationValue('high'));
    perf.frame(14, 1014);
    expect(renderer.xr.setFoveation).toHaveBeenLastCalledWith(1);
    perf.dispose();
  });

  it('keeps medium (0.5) when no level is given', () => {
    const renderer = presenting();
    const perf = mountPerf(
      renderer as unknown as THREE.WebGLRenderer,
      {} as THREE.Scene,
      {} as THREE.Group,
      {
        enabled: false,
        camera: {} as THREE.Camera,
        storage: memoryStorage(),
      },
    );
    perf.frame(14, 1000);
    expect(renderer.xr.setFoveation).toHaveBeenLastCalledWith(0.5);
    perf.dispose();
  });
});

describe('?fbscale headset A/B', () => {
  const idle = () => ({
    xr: { isPresenting: false, setFramebufferScaleFactor: vi.fn(), setFoveation: vi.fn() },
  });
  const mount = (renderer: ReturnType<typeof idle>, search: string) =>
    mountPerf(renderer as unknown as THREE.WebGLRenderer, {} as THREE.Scene, {} as THREE.Group, {
      enabled: false,
      camera: {} as THREE.Camera,
      storage: memoryStorage({ 'rogue-xr.xrScale': '0.85' }),
      search,
    });

  it('overrides the stored scale for the page load, clamped to 0.5-2', () => {
    const r = idle();
    mount(r, '?fbscale=1.25');
    expect(r.xr.setFramebufferScaleFactor).toHaveBeenCalledTimes(1);
    expect(r.xr.setFramebufferScaleFactor).toHaveBeenLastCalledWith(1.25);
    expect(scaleOverrideFromSearch('?fbscale=3')).toBe(2);
    expect(scaleOverrideFromSearch('?fbscale=0.1')).toBe(0.5);
  });

  it('keeps the stored scale without the param or with a bad value', () => {
    for (const search of ['', '?fbscale=', '?fbscale=abc', '?fbscale=-1']) {
      const r = idle();
      mount(r, search);
      expect(r.xr.setFramebufferScaleFactor).toHaveBeenLastCalledWith(0.85);
    }
  });
});
