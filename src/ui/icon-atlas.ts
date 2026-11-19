import type { DieId } from '../content/dice.ts';
import type { IntentKind, StatusId } from '../rules/types.ts';
import type { SigilId } from '../sigil/types.ts';

/**
 * Typed view of `public/assets/ui/ui-atlas.json`, written by `scripts/assets/build_ui_atlas.py`.
 * UV rects use three.js texture space: origin bottom-left, v up. The PNG pages load with the
 * default `flipY = true` and the KTX2 pages are encoded bottom-left, so one rect fits both.
 */
export const UI_ATLAS_BASE = '/assets/ui';
export const UI_ATLAS_MANIFEST = `${UI_ATLAS_BASE}/ui-atlas.json`;

export const RESOURCE_ICON_IDS = ['steam', 'block', 'hp', 'cogs', 'draw', 'dice'] as const;
export const INTENT_ICON_IDS = [
  'intent-attack',
  'intent-defend',
  'intent-buff',
  'intent-debuff',
  'intent-attack-debuff',
  'intent-unknown',
] as const;
export const STATUS_ICON_IDS = [
  'status-weak',
  'status-vulnerable',
  'status-overheat',
  'status-wound-up',
  'status-plating',
  'status-rust',
] as const;
export const ICON_IDS = [...RESOURCE_ICON_IDS, ...INTENT_ICON_IDS, ...STATUS_ICON_IDS] as const;
export type IconId = (typeof ICON_IDS)[number];

/** Exhaustive: adding an intent kind to the rules fails the type check until it has an icon. */
export const INTENT_ICON: Readonly<Record<IntentKind, IconId>> = {
  attack: 'intent-attack',
  defend: 'intent-defend',
  buff: 'intent-buff',
  debuff: 'intent-debuff',
  'attack-debuff': 'intent-attack-debuff',
  unknown: 'intent-unknown',
};

/** Exhaustive: adding a status to the rules fails the type check until it has an icon. */
export const STATUS_ICON: Readonly<Record<StatusId, IconId>> = {
  weak: 'status-weak',
  vulnerable: 'status-vulnerable',
  overheat: 'status-overheat',
  'wound-up': 'status-wound-up',
  plating: 'status-plating',
  rust: 'status-rust',
};

export interface PxRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface UvRect {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
}

export interface AtlasPage {
  readonly png: string;
  readonly ktx2: string | null;
  readonly width: number;
  readonly height: number;
}

/** `px` is the slot in image pixels (origin top-left); `uv` is the same slot in texture space. */
export interface AtlasEntry {
  readonly page: string;
  readonly px: PxRect;
  readonly uv: UvRect;
}

export interface DieFaceEntry extends AtlasEntry {
  readonly index: number;
  readonly value: number;
  /** Values at the atlas triangle corners, ordered apex, left, right. */
  readonly corners?: readonly [number, number, number];
}

export interface DieFaceSet {
  readonly kind: 'd4' | 'd6' | 'd8';
  readonly shape: 'square' | 'triangle';
  /** For triangle faces: the triangle's corners inside the slot, in slot-relative 0..1 coordinates (y down). */
  readonly triangle: readonly (readonly [number, number])[] | null;
  readonly faces: readonly DieFaceEntry[];
  /** Emissive mask page with the same slots as the faces' page: amber marks on black. */
  readonly glowPage?: string;
}

export interface KeyArtVariant {
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

export interface UiAtlasManifest {
  readonly version: 1;
  readonly uvOrigin: 'bottom-left';
  readonly pages: Readonly<Record<string, AtlasPage>>;
  readonly icons: Readonly<Record<IconId, AtlasEntry>>;
  readonly dice: Readonly<Record<DieId, DieFaceSet>>;
  readonly glyphs: Readonly<Record<SigilId, AtlasEntry>>;
  readonly keyArt: {
    readonly variants: readonly KeyArtVariant[];
    /** Region kept clear for the runtime title, in 0..1 image coordinates (origin top-left). */
    readonly titleSafe: PxRect;
  };
}

export function iconForIntent(intent: IntentKind): IconId {
  return INTENT_ICON[intent];
}

export function iconForStatus(status: StatusId): IconId {
  return STATUS_ICON[status];
}

export function iconUv(manifest: UiAtlasManifest, id: IconId): UvRect {
  const entry = manifest.icons[id];
  if (entry === undefined) throw new RangeError(`UI atlas has no icon ${id}`);
  return entry.uv;
}

export function glyphUv(manifest: UiAtlasManifest, id: SigilId): UvRect {
  const entry = manifest.glyphs[id];
  if (entry === undefined) throw new RangeError(`UI atlas has no glyph ${id}`);
  return entry.uv;
}

/** The face texture for model face `index` of `die` (face order of `src/dice/faces.ts`). */
export function dieFace(manifest: UiAtlasManifest, die: DieId, index: number): DieFaceEntry {
  const face = manifest.dice[die]?.faces.find((f) => f.index === index);
  if (face === undefined) throw new RangeError(`UI atlas has no face ${index} for ${die}`);
  return face;
}

export async function loadUiAtlas(
  url: string = UI_ATLAS_MANIFEST,
  fetchFn: typeof fetch = fetch,
): Promise<UiAtlasManifest> {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`UI atlas manifest ${url}: HTTP ${response.status}`);
  const manifest = (await response.json()) as UiAtlasManifest;
  if (manifest.version !== 1 || manifest.uvOrigin !== 'bottom-left') {
    throw new Error(`UI atlas manifest ${url}: unsupported version or UV origin`);
  }
  return manifest;
}
