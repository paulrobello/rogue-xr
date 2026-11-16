import type * as THREE from 'three';
import { createDomNotice } from './dom-notice.ts';
import { reloadApp } from './reload.ts';
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

/**
 * Tells an open tab that a newer build is deployed. The running build is the id the build stamped
 * into the page (`<meta name="app-build">`), so the dev server, which has none, never shows it.
 * Desktop gets a bar with Reload and Later; an immersive session gets the same choice on a panel
 * in the scene. Later hides the notice until a different newer build appears.
 */
export function mountUpdateNotice({ scene, renderer, xr, search = '' }: UpdateNoticeOptions): {
  dispose(): void;
} {
  const runningBuildId =
    document.querySelector<HTMLMetaElement>('meta[name="app-build"]')?.content || null;
  if (runningBuildId === null) return { dispose() {} };

  let latest: BuildManifest | null = null;
  let dismissed: string | null = null;
  let reloading = false;

  const sync = (): void => {
    const wanted = latest !== null && latest.buildId !== dismissed;
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
  const onLater = (): void => {
    dismissed = latest?.buildId ?? null;
    sync();
  };

  const domNotice = createDomNotice({ onReload, onLater });
  const xrNotice = createXrNotice({ scene, renderer, onReload, onLater });
  const watcher = createUpdateWatcher({
    runningBuildId,
    intervalMs: pollMsFromQuery(search) ?? DEFAULT_POLL_MS,
    onChange(manifest) {
      latest = manifest;
      sync();
    },
  });

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
    dispose() {
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
