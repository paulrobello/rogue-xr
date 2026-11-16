import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditionEngine } from '../src/audition/engine.ts';
import { buildMusicItems, buildSfxItems, parseCues } from '../src/audition/items.ts';
import { emptyState, loadState, STORAGE_KEY } from '../src/audition/review.ts';
import { AuditionApp } from '../src/audition/ui.ts';

const fixture = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'fixtures/audition-cues.json'), 'utf8'),
);

class FakeStorage {
  data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function mount(storage: FakeStorage): HTMLElement {
  const items = buildMusicItems(parseCues(fixture));
  const engine = { playingKey: null, onStop: () => {} } as unknown as AuditionEngine;
  const app = new AuditionApp({
    engine,
    sfx: buildSfxItems(
      [],
      [
        { id: 'loopy', loop: true, text: 'a loop' },
        { id: 'shot', text: 'a shot' },
      ],
      null,
    ),
    music: [items[0] as (typeof items)[number]],
    pendingMusic: items.slice(1),
    state: loadState(storage),
    storage,
    cuesPath: 'assets-source/audio/music/cues.json',
    musicListed: true,
  });
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  app.mount(root);
  return root;
}

describe('audition page', () => {
  let storage: FakeStorage;
  beforeEach(() => {
    storage = new FakeStorage();
  });

  it('gives loop items a loop toggle and one-shots none', () => {
    const root = mount(storage);
    const loopy = root.querySelector('[data-key="sfx:loopy"]') as HTMLElement;
    const shot = root.querySelector('[data-key="sfx:shot"]') as HTMLElement;
    expect(loopy.textContent).toContain('Loop');
    expect(shot.querySelector('button[aria-pressed]:not(.verdict)')).toBeNull();
  });

  it('shows missing music as not generated yet, with title and when, and no player', () => {
    const root = mount(storage);
    const pending = root.querySelector('[data-key="music:combat"]') as HTMLElement;
    expect(pending.classList.contains('pending')).toBe(true);
    expect(pending.textContent).toContain('Combat');
    expect(pending.textContent).toContain('While the table is unfolded');
    expect(pending.textContent).toContain('Not generated yet');
    expect(pending.querySelector('button.play')).toBeNull();
    const playable = root.querySelector('[data-key="music:explore"]') as HTMLElement;
    expect(playable.querySelector('button.play')).not.toBeNull();
  });

  it('records verdicts and notes in storage and exports them', () => {
    const root = mount(storage);
    const shot = root.querySelector('[data-key="sfx:shot"]') as HTMLElement;
    (shot.querySelector('button.reject') as HTMLButtonElement).click();
    const note = shot.querySelector('input.note') as HTMLInputElement;
    note.value = 'too long';
    note.dispatchEvent(new Event('input'));
    const saved = loadState(storage);
    expect(saved.items['sfx:shot']).toEqual({ verdict: 'reject', note: 'too long' });
    expect(shot.dataset.verdict).toBe('reject');
    expect(storage.data.has(STORAGE_KEY)).toBe(true);

    (shot.querySelector('button.reject') as HTMLButtonElement).click();
    expect(loadState(storage).items['sfx:shot']?.verdict).toBeNull();
    expect(emptyState().items).toEqual({});
  });

  it('hides plates that do not match the filter', () => {
    const root = mount(storage);
    const shot = root.querySelector('[data-key="sfx:shot"]') as HTMLElement;
    (shot.querySelector('button.approve') as HTMLButtonElement).click();
    const buttons = [...root.querySelectorAll('.segment')] as HTMLButtonElement[];
    buttons.find((b) => b.textContent === 'Rejected')?.click();
    expect(shot.hidden).toBe(true);
    buttons.find((b) => b.textContent === 'Approved')?.click();
    expect(shot.hidden).toBe(false);
  });
});
