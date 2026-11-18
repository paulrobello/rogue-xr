// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BRASS_D6, DIE_IDS, GLASS_D8, IRON_D4 } from '../src/content/dice.ts';
import { faceNormals } from '../src/dice/faces.ts';
import { STATUS_IDS } from '../src/rules/statuses.ts';
import { SIGIL_TEMPLATES } from '../src/sigil/templates.ts';
import { SIGIL_IDS } from '../src/sigil/types.ts';
import {
  type AtlasEntry,
  dieFace,
  ICON_IDS,
  INTENT_ICON,
  iconForStatus,
  iconUv,
  loadUiAtlas,
  RESOURCE_ICON_IDS,
  STATUS_ICON,
  type UiAtlasManifest,
} from '../src/ui/icon-atlas.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = join(root, 'public/assets/ui');
const manifest = JSON.parse(readFileSync(join(uiDir, 'ui-atlas.json'), 'utf8')) as UiAtlasManifest;

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(join(uiDir, file));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Entries on `page`; a dice glow page shares its colour page's face slots. */
function entriesOnPage(page: string): AtlasEntry[] {
  const all: AtlasEntry[] = [
    ...Object.values(manifest.icons),
    ...Object.values(manifest.glyphs),
    ...Object.values(manifest.dice).flatMap((set) => set.faces),
  ];
  const glowOf = Object.values(manifest.dice).find((set) => set.glowPage === page);
  if (glowOf) return [...glowOf.faces];
  return all.filter((e) => e.page === page);
}

describe('UI atlas manifest', () => {
  it('covers every intent, status and resource id the rules use', () => {
    const ids = Object.keys(manifest.icons).sort();
    expect(ids).toEqual([...ICON_IDS].sort());
    for (const id of Object.values(INTENT_ICON)) expect(manifest.icons[id]).toBeDefined();
    for (const status of STATUS_IDS) expect(manifest.icons[iconForStatus(status)]).toBeDefined();
    expect(Object.keys(STATUS_ICON).sort()).toEqual([...STATUS_IDS].sort());
    for (const id of RESOURCE_ICON_IDS) expect(manifest.icons[id]).toBeDefined();
    expect(manifest.uvOrigin).toBe('bottom-left');
  });

  it('keeps every page at most 2048 px and matching its PNG', () => {
    for (const page of Object.values(manifest.pages)) {
      expect(page.width).toBeLessThanOrEqual(2048);
      expect(page.height).toBeLessThanOrEqual(2048);
      expect(pngSize(page.png)).toEqual({ width: page.width, height: page.height });
    }
  });

  it('places every rect in bounds, with uv matching px, and no two rects overlapping', () => {
    for (const [name, page] of Object.entries(manifest.pages)) {
      const entries = entriesOnPage(name);
      expect(entries.length).toBeGreaterThan(0);
      for (const { px, uv } of entries) {
        expect(px.x).toBeGreaterThanOrEqual(0);
        expect(px.y).toBeGreaterThanOrEqual(0);
        expect(px.x + px.w).toBeLessThanOrEqual(page.width);
        expect(px.y + px.h).toBeLessThanOrEqual(page.height);
        expect(uv.u0).toBeCloseTo(px.x / page.width, 9);
        expect(uv.u1).toBeCloseTo((px.x + px.w) / page.width, 9);
        expect(uv.v0).toBeCloseTo(1 - (px.y + px.h) / page.height, 9);
        expect(uv.v1).toBeCloseTo(1 - px.y / page.height, 9);
      }
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = (entries[i] as AtlasEntry).px;
          const b = (entries[j] as AtlasEntry).px;
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap, `${name} rects ${i} and ${j} overlap`).toBe(false);
        }
      }
    }
  });

  it('numbers dice faces in src/dice/faces.ts order with opposite faces summing to N + 1', () => {
    expect(Object.keys(manifest.dice).sort()).toEqual([...DIE_IDS].sort());
    for (const def of [BRASS_D6, GLASS_D8]) {
      const set = manifest.dice[def.id as (typeof DIE_IDS)[number]];
      const n = def.faces.length;
      const normals = faceNormals(set.kind);
      expect(normals).toHaveLength(n);
      normals.forEach((normal, i) => {
        const opposite = normals[n - 1 - i];
        expect(normal.x + (opposite?.x ?? Number.NaN)).toBeCloseTo(0, 12);
        expect(normal.y + (opposite?.y ?? Number.NaN)).toBeCloseTo(0, 12);
        expect(normal.z + (opposite?.z ?? Number.NaN)).toBeCloseTo(0, 12);
      });
      expect(set.faces.map((f) => f.index)).toEqual(def.faces.map((_, i) => i));
      expect(set.faces.map((f) => f.value)).toEqual([...def.faces]);
      for (let i = 0; i < n; i++) {
        expect(dieFace(manifest, set.kind === 'd6' ? 'brass-d6' : 'glass-d8', i).value).toBe(
          def.faces[i],
        );
        expect((set.faces[i]?.value ?? 0) + (set.faces[n - 1 - i]?.value ?? 0)).toBe(n + 1);
      }
    }
  });

  it('lists a glow page per die with the same size and slots as its colour page', () => {
    expect(Object.keys(manifest.pages).sort()).toEqual(
      [
        'dice-d4',
        'dice-d4-glow',
        'dice-d6',
        'dice-d6-glow',
        'dice-d8',
        'dice-d8-glow',
        'glyphs',
        'icons',
      ].sort(),
    );
    for (const [die, colour, glow] of [
      ['brass-d6', 'dice-d6', 'dice-d6-glow'],
      ['glass-d8', 'dice-d8', 'dice-d8-glow'],
      ['iron-d4', 'dice-d4', 'dice-d4-glow'],
    ] as const) {
      const set = manifest.dice[die];
      expect(set.glowPage).toBe(glow);
      const c = manifest.pages[colour];
      const g = manifest.pages[glow];
      expect(g).toBeDefined();
      expect(g?.png).toBe(`${glow}.png`);
      expect(g?.ktx2).toBe(`${glow}.ktx2`);
      expect({ width: g?.width, height: g?.height }).toEqual({
        width: c?.width,
        height: c?.height,
      });
      expect(pngSize(g?.png ?? '')).toEqual(pngSize(c?.png ?? ''));
      // Every face slot is on the colour page, so its uv addresses the same texel rect on both.
      for (const face of set.faces) expect(face.page).toBe(colour);
      expect(entriesOnPage(glow).map((e) => e.px)).toEqual(entriesOnPage(colour).map((e) => e.px));
    }
  });

  it('has one glyph per sigil, drawn from the same strokes as the templates', () => {
    expect(Object.keys(manifest.glyphs)).toEqual([...SIGIL_IDS]);
    const strokes = JSON.parse(
      readFileSync(join(root, 'assets-source/ui/sigil-strokes.json'), 'utf8'),
    ) as Record<string, { id: string; strokes: { x: number; y: number }[][] }>;
    expect(Object.keys(strokes)).toEqual([...SIGIL_IDS]);
    // The JSON was dumped under bun; its Math.sin/cos may differ from node's in the last bit.
    for (const id of SIGIL_IDS) {
      const want = SIGIL_TEMPLATES[id].strokes;
      const got = strokes[id]?.strokes ?? [];
      expect(got.map((s) => s.length)).toEqual(want.map((s) => s.length));
      want.forEach((stroke, s) => {
        stroke.forEach((p, i) => {
          const q = got[s]?.[i];
          expect(Math.abs((q?.x ?? Number.NaN) - p.x)).toBeLessThan(1e-12);
          expect(Math.abs((q?.y ?? Number.NaN) - p.y)).toBeLessThan(1e-12);
        });
      });
    }
  });

  it('loads through the typed loader and resolves uvs', async () => {
    const fetchFn = (async () => new Response(JSON.stringify(manifest))) as typeof fetch;
    const loaded = await loadUiAtlas('/assets/ui/ui-atlas.json', fetchFn);
    expect(iconUv(loaded, INTENT_ICON.attack)).toEqual(manifest.icons['intent-attack'].uv);
    expect(() => iconUv(loaded, 'nope' as never)).toThrow(RangeError);
  });
});
