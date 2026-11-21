import * as THREE from 'three';
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { SliceCard } from '../content/cards.ts';

/**
 * Typed view of `public/assets/cards/atlas/card-atlas.json`, written by
 * `scripts/assets/build_card_atlas.py`. UV rects are `[u0, v0, u1, v1]` in three.js texture space
 * (origin bottom-left, v up): the PNG pages load with the default `flipY` and the KTX2 pages are
 * encoded bottom-left, so one rect fits both. Pixel rects and text regions are top-left origin.
 */
export const CARD_ATLAS_BASE = '/assets/cards/atlas';
export const CARD_ATLAS_MANIFEST = `${CARD_ATLAS_BASE}/card-atlas.json`;

export type CardType = SliceCard['type'];
export type CardLayerId = 'back' | 'mid' | 'front';
export const CARD_LAYER_IDS: readonly CardLayerId[] = ['back', 'mid', 'front'];
export type Rect4 = readonly [number, number, number, number];

export interface CardAtlasPage {
  readonly png: string;
  readonly ktx2: string;
  readonly width: number;
  readonly height: number;
}

export interface CardAtlasRegion {
  readonly page: number;
  /** x, y, w, h in page pixels, origin top-left. */
  readonly rect: Rect4;
  /** u0, v0, u1, v1 in texture space, origin bottom-left. */
  readonly uv: Rect4;
}

export interface CardWindow {
  /** Window centre: u from the left, v from the top, both 0..1 of the frame. */
  readonly u: number;
  readonly v: number;
  /** Radius as a fraction of the card width. */
  readonly radius: number;
}

export interface CardAtlasFrame extends CardAtlasRegion {
  /** Height over width. */
  readonly aspect: number;
  readonly window: CardWindow;
  /** Frame-pixel regions (origin top-left of the frame rect) the runtime text belongs in. */
  readonly textRegions: {
    readonly cost: { readonly centre: readonly [number, number]; readonly radius: number };
    readonly name: { readonly rect: Rect4 };
    readonly description: { readonly rect: Rect4 };
  };
}

export interface CardStackLayer {
  /** Metres behind the card face (holo card). */
  readonly depth: number;
  /** Plane edge length in window diameters. */
  readonly size: number;
  /** Plane centre offset from the window centre in window diameters (x right, y up). */
  readonly offset?: readonly [number, number];
  readonly opaque?: boolean;
  readonly additive?: boolean;
}

export interface CardAtlasCard {
  readonly type: CardType;
  readonly frame: CardType;
  /** Colour of the additive glow layer, a CSS hex string. */
  readonly glow: string;
  readonly layers: Readonly<Record<CardLayerId, CardAtlasRegion>>;
  readonly stack: Readonly<Record<CardLayerId | 'glow', CardStackLayer>>;
}

export interface CardAtlas {
  readonly version: 1;
  readonly uvOrigin: 'bottom-left';
  readonly pages: readonly CardAtlasPage[];
  readonly frames: Readonly<Record<CardType, CardAtlasFrame>>;
  readonly cards: Readonly<Record<string, CardAtlasCard>>;
}

export function parseCardAtlas(raw: unknown): CardAtlas {
  const atlas = raw as Partial<CardAtlas> | null;
  if (atlas?.version !== 1 || atlas.uvOrigin !== 'bottom-left') {
    throw new Error('card atlas: unsupported version or UV origin');
  }
  if (!Array.isArray(atlas.pages) || !atlas.frames || !atlas.cards) {
    throw new Error('card atlas: pages, frames and cards are required');
  }
  for (const type of ['attack', 'skill', 'sigil'] as const) {
    if (!atlas.frames[type]) throw new Error(`card atlas: missing ${type} frame`);
  }
  for (const [id, card] of Object.entries(atlas.cards)) {
    for (const layer of CARD_LAYER_IDS) {
      const region = card.layers?.[layer];
      if (!region || atlas.pages[region.page] === undefined) {
        throw new Error(`card atlas: ${id}.${layer} has no valid page`);
      }
    }
  }
  return atlas as CardAtlas;
}

function assetRevision(): string {
  const build =
    typeof document === 'undefined'
      ? null
      : document.querySelector('meta[name="app-build"]')?.getAttribute('content');
  return build ? `?v=${encodeURIComponent(build)}` : '';
}

export async function loadCardAtlas(
  url: string = CARD_ATLAS_MANIFEST,
  fetchFn: typeof fetch = fetch,
): Promise<CardAtlas> {
  const response = await fetchFn(url === CARD_ATLAS_MANIFEST ? `${url}${assetRevision()}` : url);
  if (!response.ok) throw new Error(`card atlas ${url}: HTTP ${response.status}`);
  return parseCardAtlas(await response.json());
}

/** Atlas key for a card id: upgraded variants (`strike+`) share their base card's art. */
export function artId(cardId: string): string {
  return cardId.endsWith('+') ? cardId.slice(0, -1) : cardId;
}

export interface CardArtEntry {
  readonly card: CardAtlasCard;
  readonly frame: CardAtlasFrame;
}

export function cardArt(atlas: CardAtlas, cardId: string): CardArtEntry {
  const card = atlas.cards[artId(cardId)];
  if (!card) throw new RangeError(`card atlas has no art for ${cardId}`);
  return { card, frame: atlas.frames[card.frame] };
}

/** A frame-pixel point as card-local fractions: x right and y up, both -0.5..0.5 of width and height. */
export function frameToCard(frame: CardAtlasFrame, px: number, py: number): [number, number] {
  return [px / frame.rect[2] - 0.5, 0.5 - py / frame.rect[3]];
}

/** Texture settings shared by every atlas page: sRGB colour, clamped, mipmapped. */
export function configureAtlasPage(texture: THREE.Texture, anisotropy = 4): THREE.Texture {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  // Compressed pages carry their own mip chain.
  texture.generateMipmaps = !(texture as THREE.CompressedTexture).isCompressedTexture;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Loads every atlas page: KTX2 when a configured loader is given (about a quarter of the GPU
 * memory of RGBA8), otherwise the PNG twins.
 */
export async function loadCardPages(
  atlas: CardAtlas,
  ktx2?: KTX2Loader | null,
  base: string = CARD_ATLAS_BASE,
): Promise<THREE.Texture[]> {
  const png = new THREE.TextureLoader();
  const revision = assetRevision();
  return Promise.all(
    atlas.pages.map(async (page) => {
      const texture = ktx2
        ? await ktx2.loadAsync(`${base}/${page.ktx2}${revision}`)
        : await png.loadAsync(`${base}/${page.png}${revision}`);
      return configureAtlasPage(texture);
    }),
  );
}

/** A view of one atlas region: shares the page's GPU upload, maps 0..1 UVs onto the rect. */
export function regionTexture(page: THREE.Texture, uv: Rect4): THREE.Texture {
  const view = page.clone();
  view.offset.set(uv[0], uv[1]);
  view.repeat.set(uv[2] - uv[0], uv[3] - uv[1]);
  view.wrapS = THREE.ClampToEdgeWrapping;
  view.wrapT = THREE.ClampToEdgeWrapping;
  // A clone starts at version 0, which binds nothing; the upload itself is shared through `source`.
  view.needsUpdate = true;
  return view;
}
