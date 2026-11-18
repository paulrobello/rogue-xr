import { FOVEATION_LEVELS, type FoveationLevel } from '@par/xr-workspace';
import type * as THREE from 'three';

/** Framebuffer scales offered in the debug panel. */
export const XR_SCALE_OPTIONS = [0.8, 0.85, 0.9, 1.0, 1.1, 1.2] as const;
export type XrScale = (typeof XR_SCALE_OPTIONS)[number];
export const DEFAULT_XR_SCALE: XrScale = 1.2;
/**
 * three.js foveation (0 off, 1 maximum) for each settings level: the toolkit's `FOVEATION_LEVELS`,
 * off 0, low 0.25, medium 0.5, high 1.
 */
export function foveationValue(level: FoveationLevel): number {
  return FOVEATION_LEVELS[level];
}
/** Default foveation re-asserted every frame: medium, per the Quest 3 guide. */
export const XR_FOVEATION = foveationValue('medium');
export const XR_SCALE_STORAGE_KEY = 'rogue-xr.xrScale';

export function isXrScale(value: unknown): value is XrScale {
  return typeof value === 'number' && (XR_SCALE_OPTIONS as readonly number[]).includes(value);
}

export type ScaleStorage = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): ScaleStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Stored scale, or the default when storage is missing, throws, or holds an unlisted value. */
export function loadXrScale(storage: ScaleStorage | null = defaultStorage()): XrScale {
  try {
    const raw = storage?.getItem(XR_SCALE_STORAGE_KEY);
    if (raw == null) return DEFAULT_XR_SCALE;
    const value = Number(raw);
    return isXrScale(value) ? value : DEFAULT_XR_SCALE;
  } catch {
    return DEFAULT_XR_SCALE;
  }
}

/** Persists a scale. Returns false for an unlisted scale or unavailable storage. */
export function saveXrScale(
  scale: number,
  storage: ScaleStorage | null = defaultStorage(),
): boolean {
  if (!isXrScale(scale) || !storage) return false;
  try {
    storage.setItem(XR_SCALE_STORAGE_KEY, String(scale));
    return true;
  } catch {
    return false;
  }
}

type XrManager = THREE.WebGLRenderer['xr'];
type XrScaleRenderer = { xr: Pick<XrManager, 'setFramebufferScaleFactor' | 'isPresenting'> };
type XrFoveationRenderer = { xr: Pick<XrManager, 'setFoveation' | 'isPresenting'> };

/**
 * Sets the framebuffer scale for the next immersive session. three.js cannot change it while
 * presenting, so call before Enter VR. Returns false, and changes nothing, when the scale is not
 * in XR_SCALE_OPTIONS or a session is already presenting.
 */
export function applySessionScale(renderer: XrScaleRenderer, scale: number): boolean {
  if (!isXrScale(scale) || renderer.xr.isPresenting) return false;
  renderer.xr.setFramebufferScaleFactor(scale);
  return true;
}

/** Re-asserts foveation. Call every frame; it does nothing outside an immersive session. */
export function assertFoveation(renderer: XrFoveationRenderer, level: number = XR_FOVEATION): void {
  if (!renderer.xr.isPresenting) return;
  renderer.xr.setFoveation(level);
}
