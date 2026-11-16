// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENEMY_CLIPS, parseEnemyManifest } from '../src/enemies/enemy-asset.ts';

/** P5-T3 automatons (scripts/assets/build-spring-hound.py, build-bellows-golem.py). */
const IDS = ['spring-hound', 'bellows-golem'] as const;
const REQUIRED_CLIPS = ['idle', 'attack', 'hit', 'death', 'frozen'];
const SOCKETS = ['socket-hit', 'socket-eye', 'socket-weapon'];

const read = (id: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`../public/assets/enemies/${id}/${id}.manifest.json`, import.meta.url),
      'utf8',
    ),
  );

const sentry = read('cog-sentry');

/** Key paths of nested objects, stopping at arrays and at maps keyed by data (clips, sockets, slots). */
function shape(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix];
  return Object.keys(value)
    .sort()
    .flatMap((k) => {
      const path = prefix ? `${prefix}.${k}` : k;
      const leaf = ['clips', 'sockets', 'materialSlots', 'events'].includes(k);
      return leaf ? [path] : shape((value as Record<string, unknown>)[k], path);
    });
}

describe.each(IDS)('%s manifest', (id) => {
  const raw = read(id);

  it('parses with the runtime enemy manifest parser', () => {
    const m = parseEnemyManifest(raw, id);
    expect(m.id).toBe(id);
    expect(m.glb).toBe(`${id}.glb`);
    expect(m.root).toBe(id);
  });

  it('has the cog-sentry schema, plus only the optional cull sphere', () => {
    const extra = shape(raw).filter((k) => !shape(sentry).includes(k));
    const missing = shape(sentry).filter((k) => !shape(raw).includes(k));
    expect(missing).toEqual([]);
    expect(extra).toEqual(['cull.center', 'cull.radius']);
  });

  it('lists the five required clips with the sentry loop modes and event names', () => {
    const m = parseEnemyManifest(raw, id);
    const sentryClips = parseEnemyManifest(sentry, 'cog-sentry').clips;
    expect(Object.keys(m.clips).sort()).toEqual([...REQUIRED_CLIPS].sort());
    expect([...ENEMY_CLIPS].sort()).toEqual([...REQUIRED_CLIPS].sort());
    for (const clip of ENEMY_CLIPS) {
      expect(m.clips[clip].duration).toBeGreaterThan(0);
      expect(m.clips[clip].loop).toBe(sentryClips[clip].loop);
      expect(Object.keys(m.clips[clip].events)).toEqual(Object.keys(sentryClips[clip].events));
    }
    expect(m.clips.frozen.held).toBe(true);
    expect(m.clips.death.endsOnFloor).toBe(true);
  });

  it('keeps the P4-T6 budgets and the shared sockets', () => {
    const m = parseEnemyManifest(raw, id);
    expect(m.budget.tris).toBeLessThanOrEqual(25_000);
    expect(m.budget.materials).toBeLessThanOrEqual(4);
    expect(m.budget.bones).toBeLessThanOrEqual(40);
    expect(m.skeleton.bones).toBe(m.budget.bones);
    expect(m.skeleton.maxInfluences).toBeLessThanOrEqual(4);
    expect(Object.keys(m.sockets).sort()).toEqual([...SOCKETS].sort());
    expect(m.materialSlots[m.emissive.material]?.emissive).toBe(true);
    expect(m.bounds.min[1]).toBeCloseTo(0, 3);
    expect(m.cull?.center).toHaveLength(3);
    expect(m.cull?.radius).toBeGreaterThan(0);
  });
});
