import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { CARD_ATLAS_BASE, parseCardAtlas } from '../src/cards/card-atlas.ts';
import {
  createCardFaceMaterial,
  FRAME_EDGE_FOOTPRINTS,
  FRAME_EDGE_MAX_TEXELS,
  FRAME_EDGE_TEXELS,
} from '../src/cards/card-face-material.ts';

const dir = resolve(process.cwd(), `public${CARD_ATLAS_BASE}`);
const atlas = parseCardAtlas(JSON.parse(readFileSync(`${dir}/card-atlas.json`, 'utf8')));

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Decodes an 8-bit RGBA, non-interlaced PNG (the atlas pages). */
function decodePng(bytes: Buffer): Rgba {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect([body[8], body[9], body[12]]).toEqual([8, 6, 0]);
    } else if (type === 'IDAT') idat.push(body);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= 4 ? (data[y * stride + x - 4] as number) : 0;
      const b = y > 0 ? (data[(y - 1) * stride + x] as number) : 0;
      const c = x >= 4 && y > 0 ? (data[(y - 1) * stride + x - 4] as number) : 0;
      let predictor = 0;
      if (filter === 1) predictor = a;
      else if (filter === 2) predictor = b;
      else if (filter === 3) predictor = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[y * stride + x] = ((raw[line + x] as number) + predictor) & 0xff;
    }
  }
  return { width, height, data };
}

const framePage = atlas.frames.attack.page;
const page = decodePng(readFileSync(`${dir}/${atlas.pages[framePage]?.png}`));
const texel = (x: number, y: number): [number, number, number, number] => {
  const i = (y * page.width + x) * 4;
  const d = page.data;
  return [d[i] as number, d[i + 1] as number, d[i + 2] as number, d[i + 3] as number];
};

/** Every texel a bilinear tap at `d` texels from the window radius, at `angles` bearings, can read. */
function ringTexels(type: keyof typeof atlas.frames, d: number, angles = 720) {
  const frame = atlas.frames[type];
  const [x0, y0, w, h] = frame.rect;
  const cx = x0 + frame.window.u * w;
  const cy = y0 + frame.window.v * h;
  const r = frame.window.radius * w + d;
  const out: [number, number, number, number][] = [];
  for (let k = 0; k < angles; k += 1) {
    const t = (k / angles) * Math.PI * 2;
    const x = cx + Math.cos(t) * r - 0.5;
    const y = cy + Math.sin(t) * r - 0.5;
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      out.push(texel(Math.floor(x) + dx, Math.floor(y) + dy));
    }
  }
  return out;
}

const keyGreen = ([r, g, b]: readonly number[]): boolean =>
  (g as number) > (r as number) + 30 && (g as number) > (b as number) + 30;

describe('card frame window edge (playtest card F)', () => {
  it('finds key green under the transparent hole just inside the window: the speckle source', () => {
    // Straight-alpha filtering on the edge mixes this colour in at partial alpha.
    let green = 0;
    for (let d = -6; d <= 0; d += 0.5) {
      green += ringTexels('skill', d).filter((t) => t[3] === 0 && keyGreen(t)).length;
    }
    expect(green).toBeGreaterThan(100);
  });

  it('pushes the edge colour tap into opaque, key-free brass on every frame and footprint', () => {
    const nearest = FRAME_EDGE_TEXELS + FRAME_EDGE_FOOTPRINTS * 1;
    expect(nearest).toBeGreaterThanOrEqual(2.5);
    expect(FRAME_EDGE_MAX_TEXELS).toBeGreaterThanOrEqual(nearest);
    for (const type of ['attack', 'skill', 'sigil', 'mechanism'] as const) {
      // A bilinear tap reads one texel either side; a minified one up to the capped push.
      for (let d = nearest - 1; d <= FRAME_EDGE_MAX_TEXELS + 1; d += 0.5) {
        const texels = ringTexels(type, d);
        expect(texels.every((t) => t[3] === 255)).toBe(true);
        expect(texels.filter(keyGreen)).toHaveLength(0);
      }
    }
  });

  it('draws the art out to the opaque brass, so no fragment on the window edge is discarded', () => {
    const fragment = createCardFaceMaterial().fragmentShader;
    expect(fragment).toContain('bool inWindow = dist < uWindow.z + edge;');
    expect(fragment).toContain('brass = textureGrad(uFrame, frameUv + push, fx, fy).rgb;');
    expect(fragment).toContain('color = mix(art, brass, frame.a);');
    expect(fragment).not.toContain('mix(art, frame.rgb, frame.a)');
    expect(fragment).toContain(`const float EDGE_MAX_TEXELS = ${FRAME_EDGE_MAX_TEXELS}.0;`);
  });
});
