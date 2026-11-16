// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnemyAssetMissing, loadEnemyAsset, loadEnemyAssets } from '../src/enemies/enemy-asset.ts';

const base = new URL('../public/assets/enemies/cog-sentry/', import.meta.url);
const sentryManifest = readFileSync(new URL('cog-sentry.manifest.json', base), 'utf8');
const sentryGlb = readFileSync(new URL('cog-sentry.glb', base));
const HTML = '<!doctype html><html><head></head><body></body></html>';

type Route = () => Response;
const json =
  (body: string): Route =>
  () =>
    new Response(body, { headers: { 'content-type': 'application/json' } });
const glb =
  (bytes: Uint8Array<ArrayBuffer> | Buffer): Route =>
  () =>
    new Response(new Uint8Array(bytes), { headers: { 'content-type': 'model/gltf-binary' } });
/** What the Vite dev server answers for a path it does not have. */
const devFallback: Route = () => new Response(HTML, { headers: { 'content-type': 'text/html' } });
const notFound: Route = () => new Response('Not Found', { status: 404 });

/** The sentry's manifest and GLB served under `kind`'s paths. */
function shipped(kind: string): Record<string, Route> {
  const manifest = JSON.stringify({ ...JSON.parse(sentryManifest), id: kind, glb: `${kind}.glb` });
  return {
    [`/assets/enemies/${kind}/${kind}.manifest.json`]: json(manifest),
    [`/assets/enemies/${kind}/${kind}.glb`]: glb(sentryGlb),
  };
}

let routes: Record<string, Route> = {};
let requests: string[] = [];
let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  routes = {};
  requests = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requests.push(url);
    return (routes[url] ?? devFallback)();
  });
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const opts = { materials: null };

describe('per-enemy model loader', () => {
  it('loads cog-sentry from its own manifest and GLB, unchanged', async () => {
    routes = shipped('cog-sentry');
    const asset = await loadEnemyAsset('cog-sentry', opts);
    expect(asset.id).toBe('cog-sentry');
    expect([...asset.clips.keys()]).toEqual(['idle', 'attack', 'hit', 'death', 'frozen']);
    expect(requests).toEqual([
      '/assets/enemies/cog-sentry/cog-sentry.manifest.json',
      '/assets/enemies/cog-sentry/cog-sentry.glb',
    ]);
    asset.dispose();
  });

  it('treats a 404 or the dev HTML fallback for the manifest as missing, never as an error', async () => {
    routes = { '/assets/enemies/spring-hound/spring-hound.manifest.json': notFound };
    await expect(loadEnemyAsset('spring-hound', opts)).rejects.toBeInstanceOf(EnemyAssetMissing);
    await expect(loadEnemyAsset('bellows-golem', opts)).rejects.toBeInstanceOf(EnemyAssetMissing);
    // No GLB request follows a missing manifest.
    expect(requests.some((r) => r.endsWith('.glb'))).toBe(false);
  });

  it('treats a manifest whose GLB is absent as missing', async () => {
    const hound = shipped('spring-hound');
    routes = {
      '/assets/enemies/spring-hound/spring-hound.manifest.json':
        hound['/assets/enemies/spring-hound/spring-hound.manifest.json'] ?? notFound,
    };
    await expect(loadEnemyAsset('spring-hound', opts)).rejects.toBeInstanceOf(EnemyAssetMissing);
    routes['/assets/enemies/spring-hound/spring-hound.glb'] = notFound;
    await expect(loadEnemyAsset('spring-hound', opts)).rejects.toBeInstanceOf(EnemyAssetMissing);
  });

  it('rejects a corrupt GLB and a manifest for another id as failures, not as missing', async () => {
    routes = {
      ...shipped('spring-hound'),
      '/assets/enemies/spring-hound/spring-hound.glb': glb(new Uint8Array(64)),
    };
    const bad = loadEnemyAsset('spring-hound', opts);
    await expect(bad).rejects.toThrow();
    await expect(bad).rejects.not.toBeInstanceOf(EnemyAssetMissing);
    routes = {
      '/assets/enemies/orrery-warden/orrery-warden.manifest.json': json(sentryManifest),
    };
    await expect(loadEnemyAsset('orrery-warden', opts)).rejects.toThrow(/id is cog-sentry/);
  });

  it('loads mixed present and absent ids on their own, one info per missing id and no errors', async () => {
    routes = {
      ...shipped('cog-sentry'),
      ...shipped('bellows-golem'),
      '/assets/enemies/bellows-golem/bellows-golem.glb': glb(new Uint8Array(64)),
      '/assets/enemies/orrery-warden/orrery-warden.manifest.json': notFound,
    };
    const ids = [
      'cog-sentry',
      'spring-hound',
      'bellows-golem',
      'orrery-warden',
      'grand-escapement',
      'cog-sentry',
    ];
    const pending = loadEnemyAssets(ids, opts);
    expect([...pending.keys()]).toEqual([
      'cog-sentry',
      'spring-hound',
      'bellows-golem',
      'orrery-warden',
      'grand-escapement',
    ]);
    const loaded = new Map(
      await Promise.all([...pending].map(async ([id, p]) => [id, await p] as const)),
    );
    expect(loaded.get('cog-sentry')?.id).toBe('cog-sentry');
    expect(loaded.get('spring-hound')).toBeNull();
    expect(loaded.get('bellows-golem')).toBeNull();
    expect(loaded.get('orrery-warden')).toBeNull();
    expect(loaded.get('grand-escapement')).toBeNull();
    // Three missing ids, one info each; the corrupt golem warns once; nothing is an error.
    expect(info).toHaveBeenCalledTimes(3);
    for (const id of ['spring-hound', 'orrery-warden', 'grand-escapement']) {
      expect(info.mock.calls.some(([m]: unknown[]) => String(m).startsWith(`${id}:`))).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('bellows-golem');
    expect(error).not.toHaveBeenCalled();
    // Each manifest is requested exactly once, the duplicate id included.
    expect(requests.filter((r) => r.endsWith('cog-sentry.manifest.json'))).toHaveLength(1);
    loaded.get('cog-sentry')?.dispose();
  });
});
