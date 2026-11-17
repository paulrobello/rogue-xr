/**
 * Timeline of the cast glyph (pure, no three.js): once a trace is scored, the clean template glyph
 * traces itself in light, flares, pulses and turns, then collapses to the plate centre, where the
 * spell leaves for its target. `glyphFrame` maps the age of the cast to the mesh inputs.
 *
 * The whole cast fits inside the plate's result hold (`PLATE_DONE_SECONDS` in combat-session),
 * so the plate never hides a glyph mid-flight.
 */

import { FLOOR, MAX } from '../sigil/index.ts';

/** The glyph draws itself over this long, constant speed along the arc. */
export const GLYPH_DRAW_SECONDS = 0.4;
/** The flare starts a little before the line closes and peaks here. */
export const GLYPH_FLARE_START = 0.34;
export const GLYPH_FLARE_PEAK = 0.47;
/** The collapse starts here; the spell launches from the plate centre at this moment. */
export const GLYPH_LAUNCH_SECONDS = 0.62;
/** The glyph is gone by here. */
export const GLYPH_END_SECONDS = 0.88;
/** The player's raw stroke fades out over this long once the glyph starts. */
export const TRAIL_FADE_SECONDS = 0.18;
/** Rotation about the plate normal reached at the end of the collapse, radians, at full power. */
export const GLYPH_SPIN = 0.9;
/** Extra scale at the flare peak, at full power. */
export const GLYPH_SWELL = 0.14;
/** Brightness multiplier added at the flare peak. */
export const GLYPH_FLARE_GAIN = 1.6;
/** Pulse during the hold between flare and collapse, hertz. */
export const GLYPH_PULSE_HZ = 6;
/** Deepest flicker dip of a fizzled cast (power 0); a perfect cast does not flicker. */
export const GLYPH_FLICKER_DEPTH = 0.65;
/** Reduced motion: no spin, swell or pulse, and a flare this fraction as strong. */
export const REDUCED_FLARE = 0.5;

export interface GlyphFrame {
  /** Fraction of the path drawn, 0..1. */
  reveal: number;
  /** Flare 0..1. */
  flare: number;
  /** Overall brightness multiplier (before flicker). */
  brightness: number;
  /** Uniform scale of the glyph about the plate centre. */
  scale: number;
  /** Rotation about the plate normal, radians. */
  spin: number;
  /** Opacity multiplier of the player's raw stroke. */
  trail: number;
  /** False once the glyph has finished. */
  alive: boolean;
}

export const newGlyphFrame = (): GlyphFrame => ({
  reveal: 0,
  flare: 0,
  brightness: 0,
  scale: 1,
  spin: 0,
  trail: 1,
  alive: true,
});

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number): number => {
  const k = clamp01(x);
  return k * k * (3 - 2 * k);
};

/** Cast power 0..1 from a sigil multiplier: a fizzle (FLOOR) is 0, a masterful trace (MAX) is 1. */
export function castPower(multiplier: number): number {
  return clamp01((multiplier - FLOOR) / (MAX - FLOOR));
}

/**
 * Flicker gain for one frame: `noise` (0..1, from a visual stream) dips a weak cast's light, so a
 * poor trace casts a guttering glyph and a perfect one burns steady.
 */
export function flickerGain(power: number, noise: number): number {
  const weak = (1 - clamp01(power)) ** 2;
  return 1 - GLYPH_FLICKER_DEPTH * weak * clamp01(noise);
}

/** The glyph's inputs `t` seconds into the cast at `power` (0..1), written into `out`. */
export function glyphFrame(
  t: number,
  power: number,
  reducedMotion: boolean,
  out: GlyphFrame,
): GlyphFrame {
  const p = clamp01(power);
  const age = Math.max(0, t);
  out.alive = age < GLYPH_END_SECONDS;
  out.reveal = smooth(age / GLYPH_DRAW_SECONDS);
  out.trail = 1 - clamp01(age / TRAIL_FADE_SECONDS);

  const rise = smooth((age - GLYPH_FLARE_START) / (GLYPH_FLARE_PEAK - GLYPH_FLARE_START));
  const fall = smooth((age - GLYPH_FLARE_PEAK) / (GLYPH_LAUNCH_SECONDS - GLYPH_FLARE_PEAK));
  // After the peak it settles to a third, then the collapse brightens it again as it shrinks.
  const collapse = clamp01(
    (age - GLYPH_LAUNCH_SECONDS) / (GLYPH_END_SECONDS - GLYPH_LAUNCH_SECONDS),
  );
  const implode = collapse > 0 ? Math.sin(Math.PI * collapse) * 0.8 : 0;
  let flare = age < GLYPH_FLARE_PEAK ? rise : 1 - (2 / 3) * fall;
  flare = Math.max(flare * (1 - collapse), implode);
  if (reducedMotion) flare *= REDUCED_FLARE;
  out.flare = flare * (0.5 + 0.5 * p);

  const pulse =
    !reducedMotion && age > GLYPH_FLARE_PEAK && age < GLYPH_LAUNCH_SECONDS
      ? 0.06 * Math.sin(2 * Math.PI * GLYPH_PULSE_HZ * (age - GLYPH_FLARE_PEAK))
      : 0;
  const fade = 1 - collapse * collapse;
  out.brightness = (0.45 + 0.55 * p) * (1 + GLYPH_FLARE_GAIN * out.flare + pulse) * fade;

  const swell = reducedMotion ? 0 : GLYPH_SWELL * p * rise * (1 - fall * 0.6);
  // The collapse eases in, so the glyph seems pulled into the centre.
  const shrink = 1 - 0.94 * collapse ** 2;
  out.scale = (1 + swell) * (reducedMotion ? 1 - 0.3 * collapse : shrink);

  const turn = clamp01((age - GLYPH_FLARE_PEAK) / (GLYPH_END_SECONDS - GLYPH_FLARE_PEAK));
  out.spin = reducedMotion ? 0 : GLYPH_SPIN * (0.5 + 0.5 * p) * turn * turn;
  if (!out.alive) {
    out.brightness = 0;
    out.flare = 0;
  }
  return out;
}

/**
 * Heat of a glyph segment that sits `behind` (path fraction) back from the reveal head: the head
 * burns white-gold and the line cools to candle amber behind it.
 */
export function headHeat(behind: number): number {
  if (behind < 0) return 0;
  return 1 - smooth(behind / 0.18);
}
