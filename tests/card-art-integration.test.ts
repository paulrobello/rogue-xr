import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  artId,
  CARD_LAYER_IDS,
  cardArt,
  frameToCard,
  parseCardAtlas,
  regionTexture,
} from '../src/cards/card-atlas.ts';
import { cardFaceInstance } from '../src/cards/card-face-material.ts';
import { holoLayers } from '../src/cards/card-proof.ts';
import { createHoloCard } from '../src/cards/holo-card.ts';
import { CARDS, getCard } from '../src/content/cards.ts';
import { BRASS_D6, GLASS_D8 } from '../src/content/dice.ts';
import { ENEMIES } from '../src/content/enemies.ts';
import { faceNormals } from '../src/dice/faces.ts';
import { atlasFaceFor, DIE_ATLAS_ID, d6FaceUvs, d8FaceUvs } from '../src/dice/presenter.ts';
import { CardFan, countDraws } from '../src/hand/card-fan.ts';
import { DEFAULT_FAN, HOLO_CARD_ASPECT, MAX_HAND } from '../src/hand/fan-layout.ts';
import type { StatusId } from '../src/rules/types.ts';
import {
  ICON_IDS,
  INTENT_ICON,
  iconUv,
  STATUS_ICON,
  type UiAtlasManifest,
} from '../src/ui/icon-atlas.ts';

const read = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(process.cwd(), 'public', path), 'utf8'));
const atlas = parseCardAtlas(read('assets/cards/atlas/card-atlas.json'));
const ui = read('assets/ui/ui-atlas.json') as UiAtlasManifest;
const baseCards = CARDS.filter((c) => !c.upgraded);
const pages = atlas.pages.map(() => new THREE.Texture());
const art = { atlas, pages };

const inside = (uv: readonly number[], rect: readonly number[]) => {
  expect(uv[0]).toBeGreaterThanOrEqual((rect[0] as number) - 1e-6);
  expect(uv[0]).toBeLessThanOrEqual((rect[2] as number) + 1e-6);
  expect(uv[1]).toBeGreaterThanOrEqual((rect[1] as number) - 1e-6);
  expect(uv[1]).toBeLessThanOrEqual((rect[3] as number) + 1e-6);
};

describe('card atlas parsing', () => {
  it('rejects a manifest with a different UV origin or missing frames', () => {
    expect(() => parseCardAtlas({ version: 1, uvOrigin: 'top-left' })).toThrow();
    expect(() =>
      parseCardAtlas({ version: 1, uvOrigin: 'bottom-left', pages: [], frames: {}, cards: {} }),
    ).toThrow(/frame/);
  });

  it('gives each of the 15 cards three layer rects on one art page, and its type frame', () => {
    expect(baseCards).toHaveLength(15);
    for (const card of baseCards) {
      const { card: entry, frame } = cardArt(atlas, card.id);
      expect(entry.frame).toBe(card.type);
      expect(frame).toBe(atlas.frames[card.type]);
      const page = entry.layers.back.page;
      for (const layer of CARD_LAYER_IDS) {
        const [u0, v0, u1, v1] = entry.layers[layer].uv;
        expect(entry.layers[layer].page).toBe(page);
        expect(u1 - u0).toBeCloseTo(480 / 2048, 4);
        expect(v1 - v0).toBeCloseTo(480 / 2048, 4);
      }
      const face = cardFaceInstance(atlas, card.id);
      expect(face.backUv).toEqual(entry.layers.back.uv);
      expect(face.midUv).toEqual(entry.layers.mid.uv);
      expect(face.frontUv).toEqual(entry.layers.front.uv);
      expect(face.frameUv).toEqual(frame.uv);
      expect([0, 1, 2]).toContain(face.glowPage[3]);
    }
    // One art page per card type, so the shader's three page samplers cover every card.
    const slots = new Set(baseCards.map((c) => cardFaceInstance(atlas, c.id).glowPage[3]));
    expect(slots.size).toBe(3);
  });

  it('shares upgraded cards with their base art', () => {
    const upgraded = baseCards.filter((c) => c.upgrade).map((c) => getCard(`${c.id}+`));
    expect(upgraded.length).toBeGreaterThan(0);
    for (const card of upgraded) {
      expect(artId(card.id)).toBe(card.id.slice(0, -1));
      expect(cardFaceInstance(atlas, card.id)).toEqual(cardFaceInstance(atlas, artId(card.id)));
    }
    expect(() => cardArt(atlas, 'no-such-card')).toThrow(RangeError);
  });

  it('has three frames sharing one window, aspect and text layout the fan and shader assume', () => {
    const frames = Object.values(atlas.frames);
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.page).toBe(atlas.frames.attack.page);
      expect(frame.window).toEqual(atlas.frames.attack.window);
      expect(frame.aspect).toBeCloseTo(1016 / 672, 5);
      expect(frame.textRegions).toEqual(atlas.frames.attack.textRegions);
    }
    expect(HOLO_CARD_ASPECT).toBeCloseTo(atlas.frames.attack.aspect, 5);
    // Every card stack has the same layer sizes (uniforms in the fan shader).
    const sizes = (id: string) =>
      (['back', 'mid', 'glow', 'front'] as const).map((l) => atlas.cards[id]?.stack[l].size);
    for (const card of baseCards) expect(sizes(card.id)).toEqual(sizes('strike'));
    // Text regions land where the card shows them: cost top-left, name and description below the window.
    const { cost, name } = atlas.frames.attack.textRegions;
    const [cx, cy] = frameToCard(atlas.frames.attack, cost.centre[0], cost.centre[1]);
    expect(cx).toBeLessThan(-0.3);
    expect(cy).toBeGreaterThan(0.4);
    const [, ny] = frameToCard(atlas.frames.attack, 0, name.rect[1]);
    const w = atlas.frames.attack.window;
    expect(0.5 - ny).toBeGreaterThan(w.v + (w.radius / atlas.frames.attack.aspect) * 0.9);
  });
});

describe('card fan with art', () => {
  const makeFan = (n: number) => {
    const scene = new THREE.Scene();
    const fan = new CardFan({ syncLabels: false, loadArt: false });
    scene.add(fan.root);
    fan.setArt(art);
    fan.setHand(Array.from({ length: n }, (_, i) => baseCards[i % baseCards.length]!));
    return { scene, fan };
  };

  it.each(Array.from({ length: MAX_HAND }, (_, i) => i + 1))(
    'draws a %i card hand with art in at most 3 draws',
    (n) => {
      const { scene, fan } = makeFan(n);
      expect(fan.hasArt).toBe(true);
      expect(countDraws(scene)).toBeLessThanOrEqual(3);
      fan.hover(n - 1);
      fan.update(0.2);
      expect(countDraws(scene)).toBeLessThanOrEqual(3);
    },
  );

  it('writes each card instance its own atlas rects', () => {
    const { fan } = makeFan(MAX_HAND);
    const body = fan.root.getObjectByName('card-fan-bodies') as THREE.InstancedMesh;
    const back = body.geometry.getAttribute('aBackUv') as THREE.InstancedBufferAttribute;
    const frame = body.geometry.getAttribute('aFrameUv') as THREE.InstancedBufferAttribute;
    for (let i = 0; i < MAX_HAND; i++) {
      const card = baseCards[i % baseCards.length]!;
      const want = cardFaceInstance(atlas, card.id);
      expect(back.getX(i)).toBeCloseTo(want.backUv[0], 6);
      expect(back.getW(i)).toBeCloseTo(want.backUv[3], 6);
      expect(frame.getX(i)).toBeCloseTo(want.frameUv[0], 6);
    }
    const material = body.material as THREE.ShaderMaterial;
    expect(material.uniforms.uHasArt?.value).toBe(1);
    expect(material.uniforms.uFrame?.value).toBe(pages[atlas.frames.attack.page]);
  });

  it('keeps the fan card at the atlas frame aspect', () => {
    expect(DEFAULT_FAN.cardHeight / DEFAULT_FAN.cardWidth).toBeCloseTo(1016 / 672, 6);
  });
});

describe('holo card from the atlas', () => {
  it('builds the portal layers as views onto the shared atlas pages', () => {
    const spec = holoLayers(atlas, pages, 'strike+');
    const { card, frame } = cardArt(atlas, 'strike');
    expect(spec.aspect).toBe(frame.aspect);
    expect(spec.window).toEqual(frame.window);
    expect(spec.frame.source).toBe(pages[frame.page]?.source);
    expect(spec.frame.offset.x).toBeCloseTo(frame.uv[0], 6);
    expect(spec.frame.repeat.y).toBeCloseTo(frame.uv[3] - frame.uv[1], 6);
    expect(spec.layers).toHaveLength(4);
    const [back, mid, glow, front] = spec.layers;
    expect(back?.opaque).toBe(true);
    expect(back?.texture.offset.y).toBeCloseTo(card.layers.back.uv[1], 6);
    expect(mid?.size).toBe(card.stack.mid.size);
    expect(glow?.additive).toBe(true);
    expect(front?.offset).toEqual(card.stack.front.offset);
    expect(front?.texture.wrapS).toBe(THREE.ClampToEdgeWrapping);
    const holo = createHoloCard({ ...spec, width: 0.063 });
    expect(holo.group.getObjectByName('face')).toBeDefined();
    holo.dispose();
  });

  it('region views share the page source and need an upload', () => {
    const page = new THREE.Texture();
    const view = regionTexture(page, [0.25, 0.5, 0.5, 0.75]);
    expect(view.source).toBe(page.source);
    expect(view.version).toBeGreaterThan(0);
    expect(view.repeat.toArray()).toEqual([0.25, 0.25]);
  });
});

describe('dice faces from the UI atlas', () => {
  const kinds = [
    ['d6', BRASS_D6],
    ['d8', GLASS_D8],
  ] as const;

  it.each(kinds)(
    '%s face index -> value -> atlas uv follows faces.ts and the content die',
    (kind, die) => {
      expect(die).toBeDefined();
      if (!die) return;
      expect(DIE_ATLAS_ID[kind]).toBe(die.id);
      expect(faceNormals(kind)).toHaveLength(die.faces.length);
      die.faces.forEach((value, index) => {
        const face = atlasFaceFor(ui, kind, index);
        expect(face.index).toBe(index);
        expect(face.value).toBe(value);
      });
    },
  );

  it('puts each d6 atlas face on the box side whose normal is that face', () => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const uv = d6FaceUvs(ui.dice['brass-d6'], box.getAttribute('uv').array);
    const normal = box.getAttribute('normal');
    const normals = faceNormals('d6');
    for (let v = 0; v < normal.count; v++) {
      const index = normals.findIndex(
        (n) =>
          Math.abs(n.x - normal.getX(v)) +
            Math.abs(n.y - normal.getY(v)) +
            Math.abs(n.z - normal.getZ(v)) <
          1e-6,
      );
      const rect = atlasFaceFor(ui, 'd6', index).uv;
      inside([uv[v * 2] as number, uv[v * 2 + 1] as number], [rect.u0, rect.v0, rect.u1, rect.v1]);
    }
  });

  it('puts each d8 atlas triangle on its face, wound counter-clockwise (numerals not mirrored)', () => {
    const octa = new THREE.OctahedronGeometry(1, 0);
    const position = octa.getAttribute('position');
    const uv = d8FaceUvs(ui.dice['glass-d8'], position.array);
    const normals = faceNormals('d8');
    const seen = new Set<number>();
    for (let t = 0; t < position.count / 3; t++) {
      const [a, b, c] = [0, 1, 2].map((k) =>
        new THREE.Vector3().fromBufferAttribute(position, t * 3 + k),
      ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
      const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      const index = normals.findIndex((m) => n.dot(new THREE.Vector3(m.x, m.y, m.z)) > 0.99);
      expect(index).toBeGreaterThanOrEqual(0);
      seen.add(index);
      const rect = atlasFaceFor(ui, 'd8', index).uv;
      const p = [0, 1, 2].map((k) => [
        uv[(t * 3 + k) * 2] as number,
        uv[(t * 3 + k) * 2 + 1] as number,
      ]);
      for (const q of p) inside(q, [rect.u0, rect.v0, rect.u1, rect.v1]);
      const [p0, p1, p2] = p as [number[], number[], number[]];
      const area =
        ((p1[0] as number) - (p0[0] as number)) * ((p2[1] as number) - (p0[1] as number)) -
        ((p2[0] as number) - (p0[0] as number)) * ((p1[1] as number) - (p0[1] as number));
      expect(area).toBeGreaterThan(0);
    }
    expect(seen.size).toBe(8);
  });
});

describe('intent and status icons', () => {
  it('has an atlas icon for every intent and status the enemies use', () => {
    const intents = new Set<string>();
    const statuses = new Set<StatusId>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        if (typeof record.intent === 'string') intents.add(record.intent);
        if (record.type === 'apply-status' && typeof record.status === 'string')
          statuses.add(record.status as StatusId);
        Object.values(record).forEach(walk);
      }
    };
    walk(ENEMIES);
    walk(CARDS);
    expect(intents.size).toBeGreaterThan(0);
    for (const intent of intents) {
      const icon = INTENT_ICON[intent as keyof typeof INTENT_ICON];
      expect(icon, intent).toBeDefined();
      expect(iconUv(ui, icon).u1).toBeGreaterThan(iconUv(ui, icon).u0);
    }
    for (const status of Object.keys(STATUS_ICON) as StatusId[]) {
      expect(iconUv(ui, STATUS_ICON[status]).v1).toBeGreaterThan(
        iconUv(ui, STATUS_ICON[status]).v0,
      );
    }
    for (const status of statuses) expect(STATUS_ICON[status]).toBeDefined();
    for (const id of ['hp', 'block', 'steam'] as const) expect(ICON_IDS).toContain(id);
    // Atlas icons are 128 px cells, so drawn at 56-72 px on the labels they are never upscaled.
    for (const id of ICON_IDS) expect(ui.icons[id].px.w).toBeGreaterThanOrEqual(72);
  });

  it('looks cards up by upgraded id', () => {
    expect(cardFaceInstance(atlas, getCard('strike+').id).backUv).toEqual(
      atlas.cards.strike?.layers.back.uv,
    );
  });
});
