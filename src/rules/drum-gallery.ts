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

export const EMPTY_DRUM_GALLERY: DrumGalleryState = { pin: null, open: false };

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

/** Select an empty socket to move the spare, or select the seated spare to lift it. */
export function setDrumPin(
  pattern: DrumPattern,
  state: DrumGalleryState,
  pin: DrumPin,
): DrumGalleryState {
  if (state.open || (pin.beat !== pattern.gap && pattern.notes[pin.beat] === pin.note))
    return state;
  return { pin: state.pin && samePin(state.pin, pin) ? null : { ...pin }, open: false };
}

/** Returns the sounding reeds per beat, including both notes if the spare makes a chord. */
export function drumPlayback(
  pattern: DrumPattern,
  pin: DrumPin | null,
): readonly (readonly BellNote[])[] {
  return pattern.notes.map((note, beat) => [
    ...(beat === pattern.gap ? [] : [note]),
    ...(pin?.beat === beat ? [pin.note] : []),
  ]);
}

/** The lock tests the fitted pin when the player winds the cylinder. */
export function windDrum(pattern: DrumPattern, state: DrumGalleryState): DrumGalleryState {
  const note = pattern.notes[pattern.gap];
  if (state.open || !state.pin || !samePin(state.pin, { beat: pattern.gap, note })) return state;
  return { ...state, open: true };
}
