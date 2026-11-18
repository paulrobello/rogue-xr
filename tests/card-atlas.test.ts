// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARDS } from '../src/content/cards.ts';

const dir = new URL('../public/assets/cards/atlas/', import.meta.url);

interface Region {
  page: number;
  rect: [number, number, number, number];
  uv: [number, number, number, number];
}
interface Page {
  png: string;
  ktx2: string;
  width: number;
  height: number;
}
interface Atlas {
  uvOrigin: string;
  pages: Page[];
  frames: Record<string, Region & { window: { u: number; v: number; radius: number } }>;
  cards: Record<string, { type: string; frame: string; layers: Record<string, Region> }>;
}

const atlas = JSON.parse(readFileSync(new URL('card-atlas.json', dir), 'utf8')) as Atlas;

/** Width and height from a PNG IHDR chunk. */
function pngSize(bytes: Buffer): [number, number] {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

/** Width and height from a KTX2 header (pixelWidth at byte 20, pixelHeight at 24). */
function ktx2Size(bytes: Buffer): [number, number] {
  expect(bytes.subarray(1, 7).toString('latin1')).toBe('KTX 20');
  return [bytes.readUInt32LE(20), bytes.readUInt32LE(24)];
}

function expectInside(region: Region): void {
  const page = atlas.pages[region.page];
  expect(page).toBeDefined();
  if (!page) return;
  const [x, y, w, h] = region.rect;
  expect(x).toBeGreaterThanOrEqual(0);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(w).toBeGreaterThan(0);
  expect(h).toBeGreaterThan(0);
  expect(x + w).toBeLessThanOrEqual(page.width);
  expect(y + h).toBeLessThanOrEqual(page.height);
  // UVs use a bottom-left origin, the same for flipY PNGs and bottom-left KTX2 pages.
  const [u0, v0, u1, v1] = region.uv;
  expect(u0).toBeCloseTo(x / page.width, 5);
  expect(u1).toBeCloseTo((x + w) / page.width, 5);
  expect(v0).toBeCloseTo(1 - (y + h) / page.height, 5);
  expect(v1).toBeCloseTo(1 - y / page.height, 5);
}

describe('card atlas index', () => {
  const baseCards = CARDS.filter((c) => !c.upgraded);

  it('covers every slice card and its type', () => {
    expect(baseCards).toHaveLength(23);
    expect(Object.keys(atlas.cards).sort()).toEqual(baseCards.map((c) => c.id).sort());
    for (const card of baseCards) {
      const entry = atlas.cards[card.id];
      expect(entry?.type).toBe(card.type);
      expect(entry?.frame).toBe(card.type);
      expect(Object.keys(entry?.layers ?? {}).sort()).toEqual(['back', 'front', 'mid']);
    }
  });

  it('has the three frame types with a window inside the card', () => {
    expect(Object.keys(atlas.frames).sort()).toEqual(['attack', 'sigil', 'skill']);
    for (const frame of Object.values(atlas.frames)) {
      const { u, v, radius } = frame.window;
      expect(u - radius).toBeGreaterThan(0);
      expect(u + radius).toBeLessThan(1);
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('keeps every rect inside its page with matching UVs', () => {
    expect(atlas.uvOrigin).toBe('bottom-left');
    for (const frame of Object.values(atlas.frames)) expectInside(frame);
    for (const card of Object.values(atlas.cards)) {
      for (const layer of Object.values(card.layers)) expectInside(layer);
    }
  });

  it('ships every page as PNG and KTX2 at the declared size, at most 2048 px', () => {
    for (const page of atlas.pages) {
      expect(page.width).toBeLessThanOrEqual(2048);
      expect(page.height).toBeLessThanOrEqual(2048);
      for (const [file, size] of [
        [page.png, pngSize],
        [page.ktx2, ktx2Size],
      ] as const) {
        const url = new URL(file, dir);
        expect(existsSync(url), file).toBe(true);
        expect(size(readFileSync(url))).toEqual([page.width, page.height]);
      }
    }
  });
});
