// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENEMY_CLIPS, parseEnemyManifest } from '../src/enemies/enemy-asset.ts';

/**
 * P5-T3 automatons (scripts/assets/build-spring-hound.py, build-bellows-golem.py) and P5-T4
 * (build-orrery-warden.py, build-grand-escapement.py).
 */
const IDS = ['spring-hound', 'bellows-golem', 'orrery-warden', 'grand-escapement'] as const;
const REQUIRED_CLIPS = ['idle', 'attack', 'hit', 'death', 'frozen'];
/** The floor guardian adds a one-shot `phase-change` clip and gets the larger guardian budget. */
const GUARDIAN = 'grand-escapement';
const clipsOf = (id: string): string[] =>
  id === GUARDIAN ? [...REQUIRED_CLIPS, 'phase-change'] : REQUIRED_CLIPS;
const budgetOf = (id: string) =>
  id === GUARDIAN
    ? { tris: 40_000, materials: 4, bones: 60 }
    : { tris: 25_000, materials: 4, bones: 40 };
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

  it('lists the required clips with the sentry loop modes and event names', () => {
    const m = parseEnemyManifest(raw, id);
    const sentryClips = parseEnemyManifest(sentry, 'cog-sentry').clips;
    expect(Object.keys(m.clips).sort()).toEqual([...clipsOf(id)].sort());
    expect([...ENEMY_CLIPS].sort()).toEqual([...REQUIRED_CLIPS].sort());
    for (const clip of ENEMY_CLIPS) {
      expect(m.clips[clip].duration).toBeGreaterThan(0);
      expect(m.clips[clip].loop).toBe(sentryClips[clip].loop);
      expect(Object.keys(m.clips[clip].events)).toEqual(Object.keys(sentryClips[clip].events));
    }
    expect(m.clips.frozen.held).toBe(true);
    expect(m.clips.death.endsOnFloor).toBe(true);
    if (id === GUARDIAN) {
      // EnemyClip covers only the five shared clips, so read the guardian's extra clip from the raw JSON.
      const phase = (
        raw.clips as Record<string, { duration: number; loop: string; events: object }>
      )['phase-change'];
      expect(phase?.duration).toBeGreaterThan(0);
      expect(phase?.loop).toBe('once');
      expect(Object.keys(phase?.events ?? {})).toEqual(['open']);
    }
  });

  it('keeps its budget and the shared sockets', () => {
    const m = parseEnemyManifest(raw, id);
    const budget = budgetOf(id);
    expect(m.budget.tris).toBeLessThanOrEqual(budget.tris);
    expect(m.budget.materials).toBeLessThanOrEqual(budget.materials);
    expect(m.budget.bones).toBeLessThanOrEqual(budget.bones);
    expect(m.skeleton.bones).toBe(m.budget.bones);
    expect(m.skeleton.maxInfluences).toBeLessThanOrEqual(4);
    expect(Object.keys(m.sockets).sort()).toEqual([...SOCKETS].sort());
    expect(m.materialSlots[m.emissive.material]?.emissive).toBe(true);
    expect(m.bounds.min[1]).toBeCloseTo(0, 3);
    expect(m.cull?.center).toHaveLength(3);
    expect(m.cull?.radius).toBeGreaterThan(0);
  });
});
