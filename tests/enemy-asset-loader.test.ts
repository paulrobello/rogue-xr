// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EnemyAssetMissing,
  type EnemyManifest,
  loadEnemyAsset,
  loadEnemyAssets,
  parseEnemyAsset,
  parseEnemyManifest,
  rimeColor,
  SHIPPED_ENEMY_MODELS,
} from '../src/enemies/enemy-asset.ts';
import type { PbrSet } from '../src/world/materials.ts';

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
  it('accepts a second action impact only between the first impact and clip end', () => {
    const raw = JSON.parse(sentryManifest);
    raw.actionClips = { levy: 'action-levy' };
    raw.intentClips = { levy: 'intent-levy' };
    raw.actionTimings = { levy: { duration: 1, impact: 0.25, secondImpact: 0.7 } };
    expect(parseEnemyManifest(raw, 'cog-sentry').actionTimings?.levy?.secondImpact).toBe(0.7);
    for (const secondImpact of [0, 0.25, 1, 1.1, Number.NaN]) {
      raw.actionTimings.levy.secondImpact = secondImpact;
      expect(() => parseEnemyManifest(raw, 'cog-sentry')).toThrow(/action timing levy/);
    }
  });

  it('only preloads enemy kinds with a packaged runtime manifest', () => {
    const root = new URL('../public/assets/enemies/', import.meta.url);
    const packaged = readdirSync(root).filter((id) =>
      existsSync(new URL(`${id}/${id}.manifest.json`, root)),
    );
    expect([...SHIPPED_ENEMY_MODELS].sort()).toEqual(packaged.sort());
  });
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

describe('per-slot tint on the shared brass sets', () => {
  const linear = (r: number, g: number, b: number) =>
    new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
  /** A non-white shared colour, so a multiply cannot pass as an assignment. */
  const SHARED = linear(0.8, 0.6, 0.4);
  const fakeSet = (): PbrSet => ({
    manifest: {},
    materials: new Map(
      ['brass-polished', 'brass-aged'].map((name) => [
        name,
        new THREE.MeshStandardMaterial({ name, color: SHARED.clone() }),
      ]),
    ),
  });
  const sentryWith = (tint?: [number, number, number]): EnemyManifest => {
    const raw = JSON.parse(sentryManifest);
    for (const slot of Object.values(raw.materialSlots) as { tint?: unknown }[]) delete slot.tint;
    if (tint) raw.materialSlots['brass-polished'].tint = tint;
    return parseEnemyManifest(raw, 'cog-sentry');
  };
  const bytes = () =>
    sentryGlb.buffer.slice(
      sentryGlb.byteOffset,
      sentryGlb.byteOffset + sentryGlb.byteLength,
    ) as ArrayBuffer;
  const slotColour = (root: THREE.Object3D, name: string): THREE.Color => {
    let found: THREE.Color | undefined;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh && !Array.isArray(o.material) && o.material.name === name)
        found = (o.material as THREE.MeshStandardMaterial).color;
    });
    if (!found) throw new Error(`no ${name} material`);
    return found;
  };
  const expectColour = (got: THREE.Color, want: THREE.Color) => {
    expect(got.r).toBeCloseTo(want.r, 6);
    expect(got.g).toBeCloseTo(want.g, 6);
    expect(got.b).toBeCloseTo(want.b, 6);
  };

  it('leaves the bound clone at the shared colour when the slot has no tint', async () => {
    const set = fakeSet();
    const asset = await parseEnemyAsset(bytes(), sentryWith(), set);
    const bound = slotColour(asset.template, 'brass-polished');
    expectColour(bound, SHARED);
    expect(bound).not.toBe(set.materials.get('brass-polished')?.color);
    asset.dispose();
  });

  it('multiplies the clone colour by the tint, on that slot only, and actors keep it', async () => {
    const asset = await parseEnemyAsset(bytes(), sentryWith([0.5, 0.25, 1]), fakeSet());
    expectColour(slotColour(asset.template, 'brass-polished'), linear(0.4, 0.15, 0.4));
    expectColour(slotColour(asset.template, 'brass-aged'), SHARED);
    const actor = asset.spawn();
    expectColour(slotColour(actor.object, 'brass-polished'), linear(0.4, 0.15, 0.4));
    actor.dispose();
    asset.dispose();
  });

  it('never mutates the shared material that other enemies and the rooms bind', async () => {
    const set = fakeSet();
    const tinted = await parseEnemyAsset(bytes(), sentryWith([0.28, 0.25, 0.3]), set);
    const plain = await parseEnemyAsset(bytes(), sentryWith(), set);
    for (const material of set.materials.values()) expectColour(material.color, SHARED);
    expectColour(slotColour(plain.template, 'brass-polished'), SHARED);
    tinted.dispose();
    plain.dispose();
  });

  it('tints a factor-only slot on a clone of the GLB material, leaving the source untouched', async () => {
    const raw = JSON.parse(sentryManifest);
    raw.materialSlots.gunmetal.tint = [0.5, 0.25, 1];
    const tinted = await parseEnemyAsset(bytes(), parseEnemyManifest(raw, 'cog-sentry'), null);
    const plain = await parseEnemyAsset(bytes(), sentryWith(), null);
    const base = slotColour(plain.template, 'gunmetal');
    expect(base.r + base.g + base.b).toBeGreaterThan(0);
    const want = base.clone().multiply(linear(0.5, 0.25, 1));
    expectColour(slotColour(tinted.template, 'gunmetal'), want);
    // A second parse of the same bytes gets the untinted factor: nothing shared was mutated.
    const again = await parseEnemyAsset(bytes(), sentryWith(), null);
    expectColour(slotColour(again.template, 'gunmetal'), base);
    const actor = tinted.spawn();
    expectColour(slotColour(actor.object, 'gunmetal'), want);
    actor.dispose();
    for (const a of [tinted, plain, again]) a.dispose();
  });

  it('rimes at the material luminance: dark stays dark, bright cools without lifting', () => {
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const gunmetal = linear(0.0273, 0.0232, 0.0232);
    const dark = rimeColor(gunmetal);
    expect(lum(dark)).toBeCloseTo(lum(gunmetal), 6);
    expect(Math.max(dark.r, dark.g, dark.b)).toBeLessThan(0.04);
    for (const bright of [linear(1, 1, 1), linear(0.8, 0.55, 0.75), linear(0.73, 0.53, 0.14)]) {
      const cold = rimeColor(bright);
      expect(lum(cold)).toBeCloseTo(lum(bright), 6);
      // Frost-cooled: blue gains on red by at least 40 % (in-room B/R +0.09..+0.18 on warm metal).
      expect(cold.b / cold.r).toBeGreaterThan((bright.b / bright.r) * 1.4);
    }
    // Brass (the GLB fallback factor) cools toward red-grey and blue, never up toward yellow.
    const brass = linear(0.73, 0.53, 0.14);
    const hue = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 }, THREE.LinearSRGBColorSpace).h;
    expect(hue(rimeColor(brass))).toBeLessThan(hue(brass));
  });

  it('freeze rimes a clone of the bound colour and thaw restores it exactly', async () => {
    const asset = await parseEnemyAsset(bytes(), sentryWith([0.8, 0.55, 0.75]), fakeSet());
    const actor = asset.spawn();
    const base = slotColour(actor.object, 'brass-polished').clone();
    const gm = slotColour(actor.object, 'gunmetal').clone();
    actor.freeze();
    expectColour(slotColour(actor.object, 'brass-polished'), rimeColor(base));
    expectColour(slotColour(actor.object, 'gunmetal'), rimeColor(gm));
    actor.unfreeze();
    expect(slotColour(actor.object, 'brass-polished').equals(base)).toBe(true);
    expect(slotColour(actor.object, 'gunmetal').equals(gm)).toBe(true);
    actor.dispose();
    asset.dispose();
  });

  it('rejects a tint that is not three numbers in 0..1', () => {
    for (const bad of [[1.2, 0, 0], [0.5, 0.5], ['0.5', 0, 0], [-0.1, 0, 0], 0.5]) {
      const raw = JSON.parse(sentryManifest);
      raw.materialSlots['brass-polished'].tint = bad;
      expect(() => parseEnemyManifest(raw, 'cog-sentry')).toThrow(/tint/);
    }
    expect(sentryWith([0, 1, 0.3]).materialSlots['brass-polished']?.tint).toEqual([0, 1, 0.3]);
  });
});
