import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { parseCardAtlas } from '../src/cards/card-atlas.ts';
import type { CardFaceArt } from '../src/cards/card-face-material.ts';

const atlas = parseCardAtlas(
  JSON.parse(readFileSync(resolve('public/assets/cards/atlas/card-atlas.json'), 'utf8')),
);
const art: CardFaceArt = { atlas, pages: atlas.pages.map(() => new THREE.Texture()) };
let preloaded: CardFaceArt | null = null;

vi.mock('../src/cards/card-face-material.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/cards/card-face-material.ts')>();
  return { ...actual, loadedCardFaceArt: () => preloaded };
});

const { CardFan } = await import('../src/hand/card-fan.ts');

describe('card fan art at construction (first-fight flash)', () => {
  it('uses art the boot prefetch already loaded, so the first hand is never flat', () => {
    preloaded = art;
    const fan = new CardFan({ syncLabels: false });
    expect(fan.hasArt).toBe(true);
  });

  it('starts flat when nothing is loaded yet, and when art loading is off', () => {
    preloaded = null;
    expect(new CardFan({ syncLabels: false }).hasArt).toBe(false);
    preloaded = art;
    expect(new CardFan({ syncLabels: false, loadArt: false }).hasArt).toBe(false);
  });
});
