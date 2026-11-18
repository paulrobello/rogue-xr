import type * as THREE from 'three';
import { createDomNotice } from './dom-notice.ts';
import { reloadApp } from './reload.ts';
import { createUpdateState } from './state.ts';
import {
  type BuildManifest,
  createUpdateWatcher,
  DEFAULT_POLL_MS,
  pollMsFromQuery,
} from './watcher.ts';
import { createXrNotice } from './xr-notice.ts';

export interface UpdateNoticeOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  /** The XR rig: reload leaves an immersive session before navigating. */
  xr: { readonly presenting: boolean; exit(): Promise<void> };
  /** `location.search`, for the `?version-poll=<seconds>` switch. */
  search?: string;
}

/** The mounted notice, for screens that offer the reload themselves (the title board). */
export interface UpdateNotice {
  /** True while a newer build is deployed, including after the player chose Later. */
  readonly available: boolean;
  /** Reloads into the newer build, leaving an immersive session first. */
  reload(): void;
  /** Calls `listener` whenever `available` or the notice changes; returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  dispose(): void;
}

/** The notice on a page without a build stamp: nothing is ever available. */
const INERT_NOTICE: UpdateNotice = {
  available: false,
  reload() {},
  onChange: () => () => {},
  dispose() {},
};

/**
 * Tells an open tab that a newer build is deployed. The running build is the id the build stamped
 * into the page (`<meta name="app-build">`), so the dev server, which has none, never shows it.
 * Desktop gets a bar with Reload and Later; an immersive session gets the same choice on a panel
 * in the scene. Later hides the notice until a different newer build appears; the build stays
 * `available`, so the title board can still offer the reload.
 */
export function mountUpdateNotice({
  scene,
  renderer,
  xr,
  search = '',
}: UpdateNoticeOptions): UpdateNotice {
  const runningBuildId =
    document.querySelector<HTMLMetaElement>('meta[name="app-build"]')?.content || null;
  if (runningBuildId === null) return INERT_NOTICE;

  const state = createUpdateState();
  let reloading = false;

  const sync = (): void => {
    const wanted = state.noticeWanted;
    const immersive = renderer.xr.isPresenting;
    if (wanted && !immersive) domNotice.show();
    else domNotice.hide();
    xrNotice.setVisible(wanted && immersive);
  };
  const onReload = (): void => {
    if (reloading) return;
    reloading = true;
    void reloadApp(xr.presenting ? { exitXr: () => xr.exit() } : {}).then((navigated) => {
      if (!navigated) reloading = false;
    });
  };
  const onLater = (): void => state.later();

  const domNotice = createDomNotice({ onReload, onLater });
  const xrNotice = createXrNotice({ scene, renderer, onReload, onLater });
  const watcher = createUpdateWatcher({
    runningBuildId,
    intervalMs: pollMsFromQuery(search) ?? DEFAULT_POLL_MS,
    onChange: (manifest: BuildManifest | null) => state.report(manifest),
  });
  const stopSync = state.onChange(sync);

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void watcher.check();
  };
  const onFocus = (): void => void watcher.check();
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onFocus);
  document.addEventListener('visibilitychange', onVisible);
  renderer.xr.addEventListener('sessionstart', sync);
  renderer.xr.addEventListener('sessionend', sync);
  watcher.start();

  return {
    get available() {
      return state.available;
    },
    reload: onReload,
    onChange: (listener) => state.onChange(listener),
    dispose() {
      stopSync();
      watcher.dispose();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      renderer.xr.removeEventListener('sessionstart', sync);
      renderer.xr.removeEventListener('sessionend', sync);
      domNotice.dispose();
      xrNotice.dispose();
    },
  };
}
