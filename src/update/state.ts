import type { BuildManifest } from './watcher.ts';

/**
 * What the app knows about a newer deployed build. `available` holds from the first newer build
 * until a rollback clears it, so the title can still offer the reload after Later; `noticeWanted`
 * is the bar and panel, which Later hides until a different newer build appears.
 */
export interface UpdateState {
  readonly available: boolean;
  readonly noticeWanted: boolean;
  /** The watcher's report: a newer manifest, or null once the deployed build is the running one. */
  report(manifest: BuildManifest | null): void;
  /** Hides the notice for the build on offer. */
  later(): void;
  /** Calls `listener` after every change; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
}

export function createUpdateState(): UpdateState {
  let latest: BuildManifest | null = null;
  let dismissed: string | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  return {
    get available() {
      return latest !== null;
    },
    get noticeWanted() {
      return latest !== null && latest.buildId !== dismissed;
    },
    report(manifest) {
      latest = manifest;
      emit();
    },
    later() {
      dismissed = latest?.buildId ?? null;
      emit();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
