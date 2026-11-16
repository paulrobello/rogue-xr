import type * as THREE from 'three';
import { onFirstRender } from './first-render.ts';
import { type IconId, loadUiAtlas, UI_ATLAS_BASE, type UiAtlasManifest } from './icon-atlas.ts';

/**
 * The UI atlas icon page as an image for 2D canvas labels. Drawing icons into a label's existing
 * canvas costs no extra draw call: the label stays one textured plane.
 */
export interface IconSheet {
  readonly manifest: UiAtlasManifest;
  readonly image: CanvasImageSource;
}

let sheet: Promise<IconSheet> | null = null;
let ready: IconSheet | null = null;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`icon page ${url} failed to load`));
    image.src = url;
  });
}

/** Loads the icon page once and shares it. A failed load is forgotten so a later call can retry. */
export function loadIconSheet(): Promise<IconSheet> {
  if (!sheet) {
    sheet = (async () => {
      const manifest = await loadUiAtlas();
      const image = await loadImage(`${UI_ATLAS_BASE}/${manifest.pages.icons?.png ?? 'icons.png'}`);
      ready = { manifest, image };
      return ready;
    })();
    sheet.catch(() => {
      sheet = null;
    });
  }
  return sheet;
}

/** The loaded sheet, or null until `loadIconSheet` resolves. */
export function iconSheet(): IconSheet | null {
  return ready;
}

/**
 * Starts the icon load the first time `mesh` is drawn and calls `onReady` once it is available, so
 * views that are never rendered (tests) never fetch.
 */
export function iconSheetOnFirstRender(mesh: THREE.Object3D, onReady: () => void): void {
  if (ready) return;
  onFirstRender(mesh, () => {
    loadIconSheet().then(onReady, (error: unknown) =>
      console.warn('UI icon atlas failed to load', error),
    );
  });
}

/** Draws atlas icon `id` with its top-left at (x, y), `size` canvas pixels square. */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  source: IconSheet,
  id: IconId,
  x: number,
  y: number,
  size: number,
): void {
  const px = source.manifest.icons[id]?.px;
  if (!px) return;
  ctx.drawImage(source.image, px.x, px.y, px.w, px.h, x, y, size, size);
}

/** One icon and its value, e.g. the attack intent and its damage. */
export interface IconChip {
  readonly icon: IconId;
  readonly text: string;
  /** Word shown in place of the icon while the sheet is still loading. */
  readonly fallback: string;
}

/**
 * Draws chips left to right on one line centred at `centreY`: icon `size` px square, then its text
 * in the current font and fill. `align: 'center'` centres the whole row on `x`.
 */
export function drawIconRow(
  ctx: CanvasRenderingContext2D,
  source: IconSheet | null,
  chips: readonly IconChip[],
  x: number,
  centreY: number,
  size: number,
  align: 'left' | 'center' = 'left',
): void {
  const gap = size * 0.15;
  const chipGap = size * 0.4;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const label = (chip: IconChip) => (source ? chip.text : `${chip.fallback} ${chip.text}`.trim());
  const lead = source ? size + gap : 0;
  const widths = chips.map((chip) => lead + ctx.measureText(label(chip)).width);
  const total = widths.reduce((sum, w) => sum + w, 0) + chipGap * Math.max(0, chips.length - 1);
  let at = align === 'center' ? x - total / 2 : x;
  chips.forEach((chip, i) => {
    if (source) drawIcon(ctx, source, chip.icon, at, centreY - size / 2, size);
    ctx.fillText(label(chip), at + lead, centreY);
    at += (widths[i] as number) + chipGap;
  });
}
