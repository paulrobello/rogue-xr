// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCardAtlas } from '../src/cards/card-atlas.ts';
import { cardFaceInstance } from '../src/cards/card-face-material.ts';
import { CARDS } from '../src/content/cards.ts';

const dir = new URL('../public/assets/cards/atlas/', import.meta.url);

interface Region {
  readonly source?: string;
  readonly page: number;
  readonly rect: readonly [number, number, number, number];
  readonly uv: readonly [number, number, number, number];
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

  it('covers every base card and its type', () => {
    expect(
      Object.keys(atlas.cards)
        .filter((id) => baseCards.some((card) => card.id === id))
        .sort(),
    ).toEqual(baseCards.map((c) => c.id).sort());
    for (const card of baseCards) {
      const entry = atlas.cards[card.id];
      expect(entry?.type).toBe(card.type);
      expect(entry?.frame).toBe(card.type);
      expect(Object.keys(entry?.layers ?? {}).sort()).toEqual(['back', 'front', 'mid']);
    }
  });

  it('keeps Wave A repair foregrounds in reserved slot 15 with shared backdrops', () => {
    const expected = [
      ['spare-parts', 'defend', 1],
      ['flywheel-swing', 'strike', 0],
      ['patch-kit', 'rivet-plate', 4],
    ] as const;
    for (const [id, backdrop, page] of expected) {
      const entry = atlas.cards[id];
      const base = atlas.cards[backdrop];
      expect(entry).toBeDefined();
      expect(base).toBeDefined();
      if (!entry || !base) continue;
      expect(entry.layers.front.page).toBe(page);
      expect(entry.layers.front.rect).toEqual([1552, 1552, 480, 480]);
      expect(entry.layers.back).toEqual(base.layers.back);
      expect(entry.layers.mid).toEqual(base.layers.mid);
      expect(entry.layers.front.source).toBe('assets-source/cards/repair-wave/repair-wave.png');
    }
  });

  it('packs the final Wave A card art under the unchanged frame rects', () => {
    const packed = parseCardAtlas(atlas);
    const framePage = packed.frames.attack.page;
    const ids = ['grease-gun', 'escapement-break', 'lucky-strike'];
    for (const [i, id] of ids.entries()) {
      const entry = packed.cards[id];
      expect(entry.layers.back.page).toBe(id === 'grease-gun' ? framePage : framePage + 2);
      expect(entry.layers.mid.page).toBe(id === 'grease-gun' ? framePage : framePage + 2);
      expect(entry.layers.front.page).toBe(framePage + 2);
      expect(entry.layers.front.rect).toEqual(
        [
          [1040, 1040],
          [1552, 1040],
          [1040, 1552],
        ][i].concat([480, 480]),
      );
      expect(cardFaceInstance(packed, id).glowPage[3]).toBe(id === 'grease-gun' ? 179 : 5);
      expect(cardFaceInstance(packed, `${id}+`)).toEqual(cardFaceInstance(packed, id));
    }
    expect(cardFaceInstance(packed, 'strike').glowPage[3]).toBe(0);
    expect(packed.frames.attack.rect).toEqual([4, 4, 672, 1016]);
    expect(packed.frames.skill.rect).toEqual([688, 4, 672, 1016]);
    expect(packed.frames.sigil.rect).toEqual([1372, 4, 672, 1016]);
  });

  it('packs Wave B charge foregrounds into reserved cells with mixed page slots', () => {
    const capacitor = parseCardAtlas(atlas).cards.capacitor;
    const coil = parseCardAtlas(atlas).cards['copper-coil'];
    expect(capacitor?.layers.front.rect).toEqual([1552, 1552, 480, 480]);
    expect(coil?.layers.front.rect).toEqual([1552, 1552, 480, 480]);
    expect(capacitor?.layers.front.page).toBe(2);
    expect(coil?.layers.front.page).toBe(5);
    expect(cardFaceInstance(parseCardAtlas(atlas), 'capacitor').glowPage[3]).toBe(50);
    expect(cardFaceInstance(parseCardAtlas(atlas), 'copper-coil').glowPage[3]).toBe(11);
  });

  it('packs both expansion pairs into the shared 1024px overdrive sheet', () => {
    const packed = parseCardAtlas(atlas);
    const page = atlas.pages.findIndex((entry) => entry.png === 'overdrive-wave.png');
    expect(page).toBeGreaterThanOrEqual(0);
    expect(atlas.pages[page]).toMatchObject({ width: 2048, height: 2048 });
    const expected = [
      ['flash-boiler', 16, 16, 'assets-source/cards/overdrive-wave/overdrive-wave.png', 'defend'],
      [
        'overdrive-piston',
        528,
        16,
        'assets-source/cards/overdrive-wave/overdrive-wave.png',
        'strike',
      ],
      ['loaded-die', 16, 528, 'assets-source/cards/dice-wave/dice-wave.png', 'defend'],
      ['reroll-lever', 528, 528, 'assets-source/cards/dice-wave/dice-wave.png', 'defend'],
    ] as const;
    for (const [id, x, y, source, backdrop] of expected) {
      const entry = packed.cards[id];
      const base = packed.cards[backdrop];
      expect(entry).toBeDefined();
      if (!entry || !base) continue;
      expect(entry.layers.front).toMatchObject({
        page,
        rect: [x, y, 480, 480],
        source,
      });
      expect(entry.layers.back).toEqual(base.layers.back);
      expect(entry.layers.mid).toEqual(base.layers.mid);
    }
  });

  it('packs Wave B field art into reserved cells with explicit regions and UVs', () => {
    const packed = parseCardAtlas(atlas);
    const overdrivePage = atlas.pages.findIndex((entry) => entry.png === 'overdrive-wave.png');
    expect(overdrivePage).toBeGreaterThanOrEqual(0);
    const expected = [
      ['arc-chain', 'sigil', 'warding-glyph', overdrivePage, [1040, 528, 480, 480]],
      ['gear-grinder', 'attack', 'strike', overdrivePage, [1552, 528, 480, 480]],
      ['pendulum-ward', 'sigil', 'warding-glyph', 3, [1552, 1552, 480, 480]],
    ] as const;
    for (const [id, type, backdrop, page, rect] of expected) {
      const entry = packed.cards[id];
      const base = packed.cards[backdrop];
      expect(entry).toBeDefined();
      if (!entry || !base) continue;
      expect(entry.type).toBe(type);
      expect(entry.frame).toBe(type);
      expect(entry.layers.front).toMatchObject({
        page,
        rect,
        source: 'assets-source/cards/field-wave/field-wave.png',
      });
      expect(entry.layers.back).toEqual(base.layers.back);
      expect(entry.layers.mid).toEqual(base.layers.mid);
      expectInside(entry.layers.front);
    }
  });

  it('packs Crystal Gambit into page-3 slot 14 with the Strike backdrop', () => {
    const packed = parseCardAtlas(atlas);
    const crystal = packed.cards['crystal-gambit'];
    const strike = packed.cards.strike;
    expect(crystal).toBeDefined();
    if (!crystal) return;
    expect(crystal.type).toBe('attack');
    expect(crystal.frame).toBe('attack');
    expect(crystal.layers.front).toMatchObject({
      page: 3,
      rect: [1040, 1552, 480, 480],
      source: 'assets-source/cards/crystal-wave/crystal-wave.png',
    });
    expect(crystal.layers.back).toEqual(strike.layers.back);
    expect(crystal.layers.mid).toEqual(strike.layers.mid);
    expect(packed.cards['pendulum-ward'].layers.front.rect).toEqual([1552, 1552, 480, 480]);
    expectInside(crystal.layers.front);
  });

  it('packs Echo Glyph into the reserved 320px gap with the Warding Glyph backdrop', () => {
    const packed = parseCardAtlas(atlas);
    const echo = packed.cards['echo-glyph'];
    const warding = packed.cards['warding-glyph'];
    expect(echo).toBeDefined();
    if (!echo) return;
    expect(echo.type).toBe('sigil');
    expect(echo.frame).toBe('sigil');
    expect(echo.layers.front).toMatchObject({
      page: 3,
      rect: [704, 1056, 288, 288],
      source: 'assets-source/cards/echo-wave/echo-wave.source.png',
    });
    expect(echo.layers.back).toEqual(warding.layers.back);
    expect(echo.layers.mid).toEqual(warding.layers.mid);
    expectInside(echo.layers.front);
  });

  it('packs Lens Focus into the second reserved 320px gap with the Warding Glyph backdrop', () => {
    const packed = parseCardAtlas(atlas);
    const lens = packed.cards['lens-focus'];
    const warding = packed.cards['warding-glyph'];
    expect(lens).toBeDefined();
    if (!lens) return;
    expect(lens.type).toBe('sigil');
    expect(lens.frame).toBe('sigil');
    expect(lens.layers.front).toMatchObject({
      page: 3,
      rect: [704, 1376, 288, 288],
      source: 'assets-source/cards/lens-wave/lens-wave.cutout.png',
    });
    expect(lens.layers.back).toEqual(warding.layers.back);
    expect(lens.layers.mid).toEqual(warding.layers.mid);
    expectInside(lens.layers.front);
  });

  it('moves page-3 art into the expansion bottom-right and packs Mechanism art bottom-left', () => {
    const packed = parseCardAtlas(atlas);
    const page = atlas.pages.findIndex((entry) => entry.png === 'overdrive-wave.png');
    const moved = [
      ['grease-gun', [1040, 1040, 480, 480]],
      ['escapement-break', [1552, 1040, 480, 480]],
      ['lucky-strike', [1040, 1552, 480, 480]],
      ['copper-coil', [1552, 1552, 480, 480]],
    ] as const;
    for (const [id, rect] of moved)
      expect(packed.cards[id].layers.front).toMatchObject({ page, rect });
    const mechanism = [
      ['gyro-stabilizer', [16, 1040, 480, 480]],
      ['pressure-gauge', [528, 1040, 480, 480]],
      ['clockwork-turret', [16, 1552, 480, 480]],
      ['furnace-heart', [528, 1552, 480, 480]],
    ] as const;
    for (const [id, rect] of mechanism) {
      expect(packed.cards[id]).toBeDefined();
      expect(packed.cards[id].type).toBe('mechanism');
      expect(packed.cards[id].layers.front).toMatchObject({ page, rect });
      expect(packed.cards[id].layers.front).toMatchObject({
        source: 'assets-source/cards/mechanism-wave/mechanism-wave.png',
      });
    }
    expect(packed.frames.mechanism.rect).toEqual([4, 1028, 672, 1016]);
    expect(packed.frames.mechanism.window).toEqual(packed.frames.skill.window);
    expect(packed.frames.mechanism.textRegions).toEqual(packed.frames.skill.textRegions);
  });

  it('has the three frame types with a window inside the card', () => {
    expect(Object.keys(atlas.frames).sort()).toEqual(['attack', 'mechanism', 'sigil', 'skill']);
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
    const framePages = new Set(Object.values(atlas.frames).map((frame) => frame.page));
    expect(atlas.pages.filter((_, page) => !framePages.has(page)).length).toBeLessThanOrEqual(5);
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
