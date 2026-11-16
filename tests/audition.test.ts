import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildMusicItems,
  buildSfxItems,
  parseCues,
  publicUrl,
  type SfxPrompt,
} from '../src/audition/items.ts';
import { computePeaks, estimateLufs, matchGain, samplePeak } from '../src/audition/loudness.ts';
import {
  emptyState,
  exportReview,
  loadState,
  STORAGE_KEY,
  type StorageLike,
  saveState,
} from '../src/audition/review.ts';

const root = resolve(import.meta.dirname, '..');
const readJson = (path: string): unknown => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const fixture = readJson('tests/fixtures/audition-cues.json');

function memoryStorage(initial?: string): StorageLike & { value: string | null } {
  const box = { value: initial ?? null } as StorageLike & { value: string | null };
  box.getItem = () => box.value;
  box.setItem = (_key: string, v: string) => {
    box.value = v;
  };
  return box;
}

function sine(freq: number, amplitude: number, seconds: number, rate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++)
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

describe('sfx items', () => {
  const prompts = (readJson('assets-source/audio/sfx/prompts.json') as { cues: SfxPrompt[] }).cues;
  const files = existsSync(resolve(root, 'public/assets/audio/sfx'))
    ? readdirSync(resolve(root, 'public/assets/audio/sfx'))
    : [];
  const report = (readJson('public/assets/audio/report.json') as { sfx: Record<string, never> })
    .sfx;

  it('lists every runtime file exactly once, each with its prompt', () => {
    const items = buildSfxItems(files, prompts, report);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const file of files.filter((f) => f.endsWith('.ogg'))) {
      expect(ids).toContain(file.replace(/\.ogg$/, ''));
    }
    for (const item of items) {
      expect(item.url).toBe(`assets/audio/sfx/${item.id}.ogg`);
      expect(item.prompt).toBeTruthy();
      expect(item.lufs).not.toBeNull();
      expect(item.durationS).toBeGreaterThan(0);
    }
  });

  it('keeps a spec whose file is missing and a file with no spec', () => {
    const items = buildSfxItems(['extra.ogg'], [{ id: 'ghost', text: 'x' }], null);
    expect(items.find((i) => i.id === 'ghost')?.url).toBeNull();
    expect(items.find((i) => i.id === 'extra')?.prompt).toBeNull();
  });

  it('flags a loudness deviation and marks loop cues', () => {
    const items = buildSfxItems(files, prompts, report);
    expect(items.find((i) => i.id === 'card-draw')?.caveat).toMatch(/peak/);
    expect(items.find((i) => i.id === 'sigil-trace')?.loop).toBe(true);
    expect(items.find((i) => i.id === 'ui-tick')?.loop).toBe(false);
  });
});

describe('music items', () => {
  it('orders cues by order, then file order, and drops malformed entries', () => {
    expect(parseCues(fixture).map((c) => c.id)).toEqual(['explore', 'combat', 'stinger']);
  });

  it('survives a missing or malformed document', () => {
    expect(parseCues(null)).toEqual([]);
    expect(parseCues({ cues: 'nope' })).toEqual([]);
  });

  it('turns runtime paths into page-relative urls', () => {
    expect(publicUrl('public/assets/audio/music/a.ogg')).toBe('assets/audio/music/a.ogg');
    expect(publicUrl('/assets/audio/music/a.ogg')).toBe('assets/audio/music/a.ogg');
  });

  it('carries title, when, loop, prompt, settings and measured loudness', () => {
    const [explore, combat, stinger] = buildMusicItems(parseCues(fixture));
    expect(explore?.title).toBe('Explore');
    expect(explore?.when).toBe('Walking the floor');
    expect(explore?.lufs).toBe(-18.2);
    expect(
      explore?.facts.some((f) => f.label === 'Settings' && f.value === 'Instrumental on'),
    ).toBe(true);
    expect(combat?.url).toBe('assets/audio/music/combat.ogg');
    expect(combat?.facts.some((f) => f.label === 'Weirdness' && f.value === '20%')).toBe(true);
    expect(stinger?.url).toBeNull();
    expect(stinger?.loop).toBe(false);
  });
});

describe('review state and export', () => {
  const rows = [
    { key: 'sfx:card-draw', kind: 'sfx' as const, id: 'card-draw' },
    { key: 'sfx:card-fling', kind: 'sfx' as const, id: 'card-fling' },
    { key: 'sfx:ui-tick', kind: 'sfx' as const, id: 'ui-tick' },
    { key: 'sfx:steam-vent', kind: 'sfx' as const, id: 'steam-vent' },
    { key: 'music:explore', kind: 'music' as const, id: 'explore' },
  ];

  it('writes the owner-review line format, skipping unreviewed items', () => {
    const state = emptyState();
    state.items['sfx:card-draw'] = { verdict: 'approve', note: '' };
    state.items['sfx:card-fling'] = { verdict: 'reject', note: 'too   thin\nat the end' };
    state.items['sfx:steam-vent'] = { verdict: null, note: 'hiss is long' };
    state.items['music:explore'] = { verdict: 'approve', note: 'loops clean' };
    expect(exportReview(rows, state).split('\n')).toEqual([
      'A17 sfx card-draw approve',
      'A17 sfx card-fling reject: too thin at the end',
      'A17 sfx steam-vent note: hiss is long',
      'music explore approve: loops clean',
    ]);
  });

  it('round-trips through storage and ignores corrupt data', () => {
    const storage = memoryStorage();
    const state = emptyState();
    state.match = true;
    state.items['sfx:ui-tick'] = { verdict: 'reject', note: 'clicky' };
    saveState(storage, state);
    expect(loadState(storage)).toEqual(state);
    expect(loadState(memoryStorage('{not json'))).toEqual(emptyState());
    expect(
      loadState(memoryStorage(JSON.stringify({ items: { a: { verdict: 'maybe', note: 3 } } }))),
    ).toEqual(emptyState());
    expect(loadState(null)).toEqual(emptyState());
    expect(STORAGE_KEY).toContain('audition');
  });

  it('does not throw when storage refuses writes', () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => saveState(broken, emptyState())).not.toThrow();
    expect(loadState(broken)).toEqual(emptyState());
  });
});

describe('loudness', () => {
  it('measures a full-scale 1 kHz sine at about -3.0 LUFS', () => {
    const lufs = estimateLufs([sine(1000, 1, 3, 48000)], 48000);
    expect(lufs).toBeCloseTo(-3.0, 0);
  });

  it('measures 10 dB lower for a sine 10 dB quieter and returns null for silence', () => {
    const loud = estimateLufs([sine(1000, 0.5, 3, 48000)], 48000) as number;
    const quiet = estimateLufs([sine(1000, 0.5 * 10 ** -0.5, 3, 48000)], 48000) as number;
    expect(loud - quiet).toBeCloseTo(10, 1);
    expect(estimateLufs([new Float32Array(48000)], 48000)).toBeNull();
  });

  it('matches gain to the review level and respects the peak ceiling', () => {
    const quiet = matchGain(-30, 0.1);
    expect(quiet.gainDb).toBeCloseTo(6, 5);
    expect(quiet.limited).toBe(false);
    const loud = matchGain(-16, 0.9);
    expect(loud.gainDb).toBeCloseTo(-8, 5);
    const clipped = matchGain(-40, 0.9);
    expect(clipped.limited).toBe(true);
    expect(0.9 * clipped.gain).toBeLessThanOrEqual(0.97 + 1e-9);
  });

  it('computes peaks and sample peak', () => {
    const data = sine(100, 0.5, 1, 8000);
    expect(samplePeak([data])).toBeCloseTo(0.5, 2);
    const peaks = computePeaks([data], 10);
    expect(peaks.length).toBe(20);
    expect(Math.max(...peaks)).toBeCloseTo(0.5, 1);
  });
});
