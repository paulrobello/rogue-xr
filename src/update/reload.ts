/** The current URL with a fresh `_reload` stamp, so the navigation bypasses a cached page. Other query parameters and the fragment are kept. */
export function reloadUrl(href: string, stamp: number): string {
  const url = new URL(href);
  url.searchParams.set('_reload', String(stamp));
  return url.href;
}

export interface ReloadOptions {
  /** Leaves the immersive session first; a rejection keeps the page where it is. */
  exitXr?: () => Promise<void>;
  location?: Pick<Location, 'href' | 'replace'>;
  now?: () => number;
}

/** Ends any immersive session, then navigates to the cache-busted current URL. Resolves `false` when XR could not exit. */
export async function reloadApp(options: ReloadOptions = {}): Promise<boolean> {
  const { exitXr, location = globalThis.location, now = Date.now } = options;
  if (exitXr) {
    try {
      await exitXr();
    } catch {
      return false;
    }
  }
  location.replace(reloadUrl(location.href, now()));
  return true;
}
