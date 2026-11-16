import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountUpdateNotice } from '../src/update/index.ts';
import { BUTTONS, buttonAtUv, PANEL } from '../src/update/layout.ts';
import { reloadApp, reloadUrl } from '../src/update/reload.ts';
import {
  type BuildManifest,
  createUpdateWatcher,
  newerThanRunning,
  parseManifest,
  pollMsFromQuery,
  type Timers,
} from '../src/update/watcher.ts';

const RUNNING = 'a'.repeat(64);
const NEWER = 'b'.repeat(64);
const NEWEST = 'c'.repeat(64);

/** A manual clock: timers fire only when `advance` crosses them. */
function fakeClock() {
  let time = 1_000_000;
  let nextHandle = 1;
  const intervals = new Map<number, { every: number; due: number; run: () => void }>();
  const timeouts = new Map<number, { due: number; run: () => void }>();
  const timers: Timers = {
    setInterval: (run, every) => {
      intervals.set(nextHandle, { every, due: time + every, run });
      return nextHandle++;
    },
    clearInterval: (handle) => void intervals.delete(handle as number),
    setTimeout: (run, ms) => {
      timeouts.set(nextHandle, { due: time + ms, run });
      return nextHandle++;
    },
    clearTimeout: (handle) => void timeouts.delete(handle as number),
  };
  return {
    timers,
    now: () => time,
    activeIntervals: () => intervals.size,
    advance(ms: number) {
      const target = time + ms;
      for (;;) {
        const due = [
          ...[...intervals.values()].map((entry) => entry.due),
          ...[...timeouts.values()].map((entry) => entry.due),
        ].filter((at) => at <= target);
        if (due.length === 0) break;
        time = Math.min(...due);
        for (const [handle, entry] of [...timeouts]) {
          if (entry.due <= time) {
            timeouts.delete(handle);
            entry.run();
          }
        }
        for (const entry of intervals.values()) {
          if (entry.due <= time) {
            entry.due += entry.every;
            entry.run();
          }
        }
      }
      time = target;
    },
  };
}

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function harness(running: string | null = RUNNING) {
  const clock = fakeClock();
  const seen: Array<BuildManifest | null> = [];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  let respond: (signal?: AbortSignal | null) => Promise<Response> = async () =>
    ok({ buildId: RUNNING });
  let online = true;
  const fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url, init });
    return respond(init?.signal);
  }) as unknown as typeof globalThis.fetch;
  const watcher = createUpdateWatcher({
    runningBuildId: running,
    onChange: (manifest) => seen.push(manifest),
    fetch,
    timers: clock.timers,
    now: clock.now,
    online: () => online,
  });
  return {
    clock,
    seen,
    requests,
    watcher,
    serve: (body: unknown) => {
      respond = async () => ok(body);
    },
    serveWith: (handler: typeof respond) => {
      respond = handler;
    },
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

describe('version manifest', () => {
  it('accepts a hex buildId and keeps the informational strings', () => {
    expect(
      parseManifest({ buildId: NEWER, version: '0.1.0', commit: 'abc', builtAt: 't', extra: 1 }),
    ).toEqual({ buildId: NEWER, version: '0.1.0', commit: 'abc', builtAt: 't' });
    expect(parseManifest({ buildId: NEWER, version: 3 })).toEqual({ buildId: NEWER });
  });

  it('rejects anything without a valid hex buildId', () => {
    for (const bad of [
      null,
      [],
      'x',
      {},
      { buildId: 7 },
      { buildId: '' },
      { buildId: 'zz11zz11' },
    ]) {
      expect(parseManifest(bad)).toBeNull();
    }
    expect(parseManifest({ buildId: 'abc' })).toBeNull();
    expect(parseManifest({ buildId: 'f'.repeat(129) })).toBeNull();
  });

  it('is newer only when the deployed id differs from the running one', () => {
    const deployed = { buildId: NEWER };
    expect(newerThanRunning(RUNNING, deployed)).toBe(deployed);
    expect(newerThanRunning(RUNNING, { buildId: RUNNING })).toBeNull();
    expect(newerThanRunning(RUNNING, null)).toBeNull();
  });

  it('reads ?version-poll in seconds with a one second minimum', () => {
    expect(pollMsFromQuery('?version-poll=2')).toBe(2000);
    expect(pollMsFromQuery('?a=1&version-poll=1')).toBe(1000);
    expect(pollMsFromQuery('?version-poll=0.5')).toBeNull();
    expect(pollMsFromQuery('?version-poll=soon')).toBeNull();
    expect(pollMsFromQuery('')).toBeNull();
  });
});

describe('update watcher', () => {
  it('stays quiet while the deployed build is the running one', async () => {
    const h = harness();
    await h.watcher.poll();
    expect(h.requests).toHaveLength(1);
    expect(h.seen).toEqual([]);
  });

  it('reports a newer build once, again for a different one, and clears on rollback', async () => {
    const h = harness();
    h.serve({ buildId: NEWER });
    await h.watcher.poll();
    await h.watcher.poll();
    expect(h.seen).toEqual([{ buildId: NEWER }]);
    h.serve({ buildId: NEWEST });
    await h.watcher.poll();
    h.serve({ buildId: RUNNING });
    await h.watcher.poll();
    expect(h.seen).toEqual([{ buildId: NEWER }, { buildId: NEWEST }, null]);
  });

  it('bypasses caches with a stamped URL and no-store', async () => {
    const h = harness();
    await h.watcher.poll();
    expect(h.requests[0]?.url).toBe(`version.json?t=${h.clock.now()}`);
    expect(h.requests[0]?.init?.cache).toBe('no-store');
  });

  it('shows nothing on errors, non-2xx or malformed bodies, and recovers on the next check', async () => {
    const h = harness();
    h.serveWith(async () => {
      throw new TypeError('network');
    });
    await h.watcher.poll();
    h.serveWith(async () => new Response('{}', { status: 503 }));
    await h.watcher.poll();
    h.serveWith(async () => new Response('<html>', { status: 200 }));
    await h.watcher.poll();
    h.serve({ buildId: 'not hex' });
    await h.watcher.poll();
    expect(h.seen).toEqual([]);
    h.serve({ buildId: NEWER });
    await h.watcher.poll();
    expect(h.seen).toEqual([{ buildId: NEWER }]);
  });

  it('skips the request while offline', async () => {
    const h = harness();
    h.setOnline(false);
    await h.watcher.poll();
    await h.watcher.check();
    expect(h.requests).toHaveLength(0);
    h.setOnline(true);
    await h.watcher.poll();
    expect(h.requests).toHaveLength(1);
  });

  it('is inert without a running build id, as on the dev server', async () => {
    const h = harness(null);
    h.watcher.start();
    await h.watcher.poll();
    h.clock.advance(5 * 60_000);
    expect(h.requests).toHaveLength(0);
    expect(h.clock.activeIntervals()).toBe(0);
  });

  it('never overlaps two requests', async () => {
    const h = harness();
    let release: (response: Response) => void = () => {};
    h.serveWith(() => new Promise<Response>((resolve) => (release = resolve)));
    const first = h.watcher.poll();
    const second = h.watcher.poll();
    expect(h.requests).toHaveLength(1);
    release(ok({ buildId: NEWER }));
    await Promise.all([first, second]);
    expect(h.seen).toEqual([{ buildId: NEWER }]);
    h.serve({ buildId: NEWER });
    await h.watcher.poll();
    expect(h.requests).toHaveLength(2);
  });

  it('throttles event-driven checks to one per 15 seconds but not the interval poll', async () => {
    const h = harness();
    await h.watcher.check();
    await h.watcher.check();
    expect(h.requests).toHaveLength(1);
    h.clock.advance(14_999);
    await h.watcher.check();
    expect(h.requests).toHaveLength(1);
    h.clock.advance(1);
    await h.watcher.check();
    expect(h.requests).toHaveLength(2);
    await h.watcher.poll();
    expect(h.requests).toHaveLength(3);
  });

  it('polls at start and then every 60 seconds until disposed', async () => {
    const h = harness();
    h.watcher.start();
    h.watcher.start();
    await flush();
    expect(h.requests).toHaveLength(1);
    h.clock.advance(60_000);
    await flush();
    expect(h.requests).toHaveLength(2);
    h.clock.advance(60_000);
    await flush();
    expect(h.requests).toHaveLength(3);
    h.watcher.dispose();
    h.clock.advance(180_000);
    await flush();
    expect(h.requests).toHaveLength(3);
    expect(h.clock.activeIntervals()).toBe(0);
  });

  it('aborts a request that outlives five seconds and polls again afterwards', async () => {
    const h = harness();
    let signal: AbortSignal | null | undefined;
    h.serveWith(
      (given) =>
        new Promise<Response>((_resolve, reject) => {
          signal = given;
          given?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pending = h.watcher.poll();
    h.clock.advance(4_999);
    expect(signal?.aborted).toBe(false);
    h.clock.advance(1);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(h.seen).toEqual([]);
    h.serve({ buildId: NEWER });
    await h.watcher.poll();
    expect(h.seen).toEqual([{ buildId: NEWER }]);
  });

  it('drops a response that arrives after dispose', async () => {
    const h = harness();
    let release: (response: Response) => void = () => {};
    h.serveWith(() => new Promise<Response>((resolve) => (release = resolve)));
    const pending = h.watcher.poll();
    h.watcher.dispose();
    release(ok({ buildId: NEWER }));
    await pending;
    expect(h.seen).toEqual([]);
  });
});

describe('reload', () => {
  it('stamps the current URL and keeps other parameters and the fragment', () => {
    expect(reloadUrl('https://spire.example/?seed=AB12&view=combat#room', 42)).toBe(
      'https://spire.example/?seed=AB12&view=combat&_reload=42#room',
    );
    expect(reloadUrl('https://spire.example/?_reload=1', 2)).toBe(
      'https://spire.example/?_reload=2',
    );
  });

  it('exits XR before it navigates', async () => {
    const order: string[] = [];
    const location = {
      href: 'https://spire.example/',
      replace: (url: string | URL) => order.push(`replace ${String(url)}`),
    };
    const navigated = await reloadApp({
      exitXr: async () => void order.push('exit'),
      location,
      now: () => 7,
    });
    expect(navigated).toBe(true);
    expect(order).toEqual(['exit', 'replace https://spire.example/?_reload=7']);
  });

  it('stays on the page when XR cannot exit', async () => {
    const replace = vi.fn();
    const navigated = await reloadApp({
      exitXr: async () => {
        throw new Error('stuck');
      },
      location: { href: 'https://spire.example/', replace },
    });
    expect(navigated).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('in-scene notice layout', () => {
  const centre = (name: 'reload' | 'later'): [number, number] => {
    const rect = BUTTONS[name];
    return [
      (rect.x + rect.width / 2) / PANEL.canvasWidth,
      1 - (rect.y + rect.height / 2) / PANEL.canvasHeight,
    ];
  };

  it('maps plane uv to the button under the ray', () => {
    expect(buttonAtUv(...centre('reload'))).toBe('reload');
    expect(buttonAtUv(...centre('later'))).toBe('later');
    expect(buttonAtUv(0.5, 0.9)).toBeNull();
    expect(buttonAtUv(0.01, 0.01)).toBeNull();
  });

  it('keeps the buttons inside the canvas and apart', () => {
    const { reload, later } = BUTTONS;
    expect(reload.x + reload.width).toBeLessThan(later.x);
    expect(later.x + later.width).toBeLessThanOrEqual(PANEL.canvasWidth);
    expect(later.y + later.height).toBeLessThanOrEqual(PANEL.canvasHeight);
  });
});

describe('mounted notice', () => {
  beforeEach(() => {
    // Only the clock is faked, so the throttle gap can be crossed without real waiting.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  const stage = () => {
    const xrState = { presenting: false };
    const listeners = new Map<string, Set<() => void>>();
    const renderer = {
      xr: {
        get isPresenting() {
          return xrState.presenting;
        },
        getController: () => new THREE.Group(),
        addEventListener: (type: string, fn: () => void) => {
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type)?.add(fn);
        },
        removeEventListener: (type: string, fn: () => void) => void listeners.get(type)?.delete(fn),
      },
    } as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    return {
      scene,
      renderer,
      xr: { presenting: false, exit: async () => {} },
      setPresenting(value: boolean) {
        xrState.presenting = value;
        for (const fn of listeners.get(value ? 'sessionstart' : 'sessionend') ?? []) fn();
      },
    };
  };
  const stampBuild = (id: string): void => {
    const meta = document.createElement('meta');
    meta.name = 'app-build';
    meta.content = id;
    document.head.append(meta);
  };
  const noticeEl = (): HTMLElement | null => document.querySelector<HTMLElement>('#update-notice');

  it('does nothing on a page without a build stamp (dev server)', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const s = stage();
    const mount = mountUpdateNotice({ scene: s.scene, renderer: s.renderer, xr: s.xr });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(noticeEl()).toBeNull();
    expect(s.scene.getObjectByName('update-notice')).toBeUndefined();
    mount.dispose();
  });

  it('shows the desktop bar for a newer build, hides it on Later, and shows the next newer build', async () => {
    stampBuild(RUNNING);
    let served = NEWER;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ buildId: served })),
    );
    const s = stage();
    const mount = mountUpdateNotice({ scene: s.scene, renderer: s.renderer, xr: s.xr });
    await vi.waitFor(() => expect(noticeEl()?.style.display).toBe('flex'));
    expect(s.scene.getObjectByName('update-notice')?.visible).toBe(false);

    const [reload, later] = noticeEl()?.querySelectorAll('button') ?? [];
    expect(reload?.textContent).toBe('Reload');
    later?.click();
    expect(noticeEl()?.style.display).toBe('none');

    served = NEWEST;
    vi.setSystemTime(Date.now() + 20_000);
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(noticeEl()?.style.display).toBe('flex'));
    mount.dispose();
    expect(noticeEl()).toBeNull();
  });

  it('keeps typed keys inside the notice', async () => {
    stampBuild(RUNNING);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ buildId: NEWER })),
    );
    const s = stage();
    const mount = mountUpdateNotice({ scene: s.scene, renderer: s.renderer, xr: s.xr });
    await vi.waitFor(() => expect(noticeEl()?.style.display).toBe('flex'));
    const reachedWindow = vi.fn();
    window.addEventListener('keydown', reachedWindow);
    noticeEl()
      ?.querySelector('button')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true }));
    window.removeEventListener('keydown', reachedWindow);
    expect(reachedWindow).not.toHaveBeenCalled();
    mount.dispose();
  });

  it('moves the notice from the desktop bar to the scene panel while immersive', async () => {
    stampBuild(RUNNING);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ buildId: NEWER })),
    );
    const s = stage();
    const mount = mountUpdateNotice({ scene: s.scene, renderer: s.renderer, xr: s.xr });
    await vi.waitFor(() => expect(noticeEl()?.style.display).toBe('flex'));
    // Placement runs in onBeforeRender, so the panel must never be frustum-culled.
    expect(s.scene.getObjectByName('update-notice')?.frustumCulled).toBe(false);
    s.setPresenting(true);
    expect(noticeEl()?.style.display).toBe('none');
    expect(s.scene.getObjectByName('update-notice')?.visible).toBe(true);
    s.setPresenting(false);
    expect(noticeEl()?.style.display).toBe('flex');
    expect(s.scene.getObjectByName('update-notice')?.visible).toBe(false);
    mount.dispose();
    expect(s.scene.getObjectByName('update-notice')).toBeUndefined();
  });
});
