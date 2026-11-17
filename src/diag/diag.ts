/** Reads one diagnostic section on demand. Runs only when `__spireDiag()` is called. */
export type DiagProvider = () => unknown;

type DiagGlobal = { __spireDiag?: () => Record<string, unknown> };

const providers = new Map<string, DiagProvider>();

/**
 * Adds a section to `__spireDiag()`, the one global a CDP session reads state from. Providers
 * run only when it is called, never per frame. Registering a name again replaces it.
 */
export function registerDiag(name: string, provider: DiagProvider): void {
  providers.set(name, provider);
  (globalThis as DiagGlobal).__spireDiag = () => {
    const out: Record<string, unknown> = {};
    for (const [key, read] of providers) out[key] = read();
    return out;
  };
}
