import { normalizeSeed, Stream } from '../core/rng.ts';
import type { RunState } from './run.ts';
import type { BellNote, DrumBeat, DrumGalleryState, DrumPin } from './types.ts';

export type { DrumBeat, DrumGalleryState, DrumPin } from './types.ts';
export type DrumControl =
  | { readonly kind: 'wind' }
  | { readonly kind: 'pin'; readonly pin: DrumPin };

export interface DrumPattern {
  readonly notes: readonly BellNote[];
  readonly gap: DrumBeat;
}

export const EMPTY_DRUM_GALLERY: DrumGalleryState = { pin: null, pins: [], open: false };

function placedPins(state: DrumGalleryState): readonly DrumPin[] {
  return state.pins ?? (state.pin ? [state.pin] : []);
}

export function readDrumGallery(run: Pick<RunState, 'drumGallery'>): DrumGalleryState {
  return run.drumGallery ?? EMPTY_DRUM_GALLERY;
}

export function drumPattern(seed: string): DrumPattern {
  const stream = Stream.fromKey(`drum-gallery:${normalizeSeed(seed)}`);
  const notes = stream.shuffle<BellNote>([0, 1, 2, stream.int(0, 2) as BellNote]);
  return { notes, gap: stream.int(0, notes.length - 1) as DrumBeat };
}

function samePin(a: DrumPin, b: DrumPin): boolean {
  return a.beat === b.beat && a.note === b.note;
}

/** Tapping an occupied socket lifts its pin. Selecting another pitch changes that beat. */
export function setDrumPin(
  pattern: DrumPattern,
  state: DrumGalleryState,
  pin: DrumPin,
): DrumGalleryState {
  if (state.open || pin.beat >= pattern.notes.length) return state;
  const pins = placedPins(state);
  const next = pins.filter((placed) => placed.beat !== pin.beat);
  if (!pins.some((placed) => samePin(placed, pin))) next.push({ ...pin });
  return { pin: next.at(-1) ?? null, pins: next, open: false };
}

/** Older solved saves retain the three factory pins and the fitted spare. */
export function drumPlayback(
  pattern: DrumPattern,
  pin: DrumPin | null,
  pins?: readonly DrumPin[],
): readonly (readonly BellNote[])[] {
  if (pins === undefined) {
    return pattern.notes.map((note, beat) => [
      ...(beat === pattern.gap ? [] : [note]),
      ...(pin?.beat === beat ? [pin.note] : []),
    ]);
  }
  const seated = pins;
  return pattern.notes.map((_, beat) => {
    const placed = seated.find((pin) => pin.beat === beat);
    return placed ? [placed.note] : [];
  });
}

/** The lock tests the complete phrase when the player winds the cylinder. */
export function windDrum(pattern: DrumPattern, state: DrumGalleryState): DrumGalleryState {
  if (state.pins === undefined) {
    const note = pattern.notes[pattern.gap];
    if (state.open || !state.pin || !samePin(state.pin, { beat: pattern.gap, note })) return state;
    return { ...state, open: true };
  }
  if (state.open) return state;
  const pins = placedPins(state);
  if (pins.length !== pattern.notes.length) return state;
  if (
    !pattern.notes.every((note, beat) => pins.some((pin) => pin.beat === beat && pin.note === note))
  )
    return state;
  return { ...state, pins, pin: pins.at(-1) ?? null, open: true };
}
