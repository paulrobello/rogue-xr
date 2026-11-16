/** What `version.json` carries. Only `buildId` is compared; the rest is for humans. */
export interface BuildManifest {
  buildId: string;
  version?: string;
  commit?: string;
  builtAt?: string;
}

/** The timer functions the watcher uses, injectable so tests drive time by hand. */
export interface Timers {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface WatcherOptions {
  /** The build this page is running, from the page itself. `null` (dev server) makes the watcher inert. */
  runningBuildId: string | null;
  /** Called with the deployed manifest when it differs from the running build, and with `null` when it matches again. */
  onChange(manifest: BuildManifest | null): void;
  url?: string;
  /** Background poll period. */
  intervalMs?: number;
  /** Minimum gap between event-driven checks (focus, visibility, online). */
  throttleMs?: number;
  /** Per-request budget, including reading the body. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  timers?: Timers;
  now?: () => number;
  online?: () => boolean;
}

export interface UpdateWatcher {
  /** Poll now and then every `intervalMs`. */
  start(): void;
  /** One check: skipped while offline, inert, disposed or another request is in flight. */
  poll(): Promise<void>;
  /** An event-driven check, skipped when the last one started less than `throttleMs` ago. */
  check(): Promise<void>;
  dispose(): void;
}

export const DEFAULT_POLL_MS = 60_000;
export const DEFAULT_THROTTLE_MS = 15_000;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const VERSION_URL = 'version.json';
const BUILD_ID = /^[0-9a-f]{8,128}$/;

/** A manifest with a hex `buildId`, or `null` for anything else. */
export function parseManifest(value: unknown): BuildManifest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.buildId !== 'string' || !BUILD_ID.test(candidate.buildId)) return null;
  const manifest: BuildManifest = { buildId: candidate.buildId };
  for (const key of ['version', 'commit', 'builtAt'] as const) {
    const field = candidate[key];
    if (typeof field === 'string') manifest[key] = field;
  }
  return manifest;
}

/** The manifest to announce for what the server serves now: `null` when it is the running build. */
export function newerThanRunning(
  runningBuildId: string,
  deployed: BuildManifest | null,
): BuildManifest | null {
  if (deployed === null || deployed.buildId === runningBuildId) return null;
  return deployed;
}

/** Poll seconds from `?version-poll=<seconds>` (minimum 1), for tests and agents; `null` when absent or invalid. */
export function pollMsFromQuery(search: string): number | null {
  const raw = new URLSearchParams(search).get('version-poll');
  if (raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 1 ? seconds * 1000 : null;
}

export function createUpdateWatcher(options: WatcherOptions): UpdateWatcher {
  const {
    runningBuildId,
    onChange,
    url = VERSION_URL,
    intervalMs = DEFAULT_POLL_MS,
    throttleMs = DEFAULT_THROTTLE_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetch: fetchImpl = (input, init) => globalThis.fetch(input, init),
    timers = globalThis as unknown as Timers,
    now = Date.now,
    online = () => globalThis.navigator?.onLine !== false,
  } = options;

  let disposed = false;
  let started = false;
  let intervalHandle: unknown;
  let inFlight: Promise<void> | null = null;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let announced: string | null = null;
  let controller: AbortController | undefined;

  const request = async (): Promise<void> => {
    const abort = new AbortController();
    controller = abort;
    const timeout = timers.setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${url}?t=${now()}`, {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: abort.signal,
      });
      if (!response.ok) return;
      const deployed = parseManifest(await response.json());
      if (disposed || deployed === null || runningBuildId === null) return;
      const next = newerThanRunning(runningBuildId, deployed);
      const nextId = next?.buildId ?? null;
      if (nextId === announced) return;
      announced = nextId;
      onChange(next);
    } catch {
      // Offline, aborted, or a malformed body: show nothing and let the next check retry.
    } finally {
      timers.clearTimeout(timeout);
      if (controller === abort) controller = undefined;
    }
  };

  const poll = (): Promise<void> => {
    if (disposed || runningBuildId === null || !online()) return Promise.resolve();
    if (inFlight) return inFlight;
    lastCheckAt = now();
    const run = request().finally(() => {
      if (inFlight === run) inFlight = null;
    });
    inFlight = run;
    return run;
  };

  return {
    start() {
      if (disposed || started || runningBuildId === null) return;
      started = true;
      void poll();
      intervalHandle = timers.setInterval(() => void poll(), intervalMs);
    },
    poll,
    check() {
      if (now() - lastCheckAt < throttleMs) return Promise.resolve();
      return poll();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (intervalHandle !== undefined) timers.clearInterval(intervalHandle);
      controller?.abort();
    },
  };
}
