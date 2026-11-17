import { describe, expect, it } from 'vitest';
import {
  BOLT_ARC,
  BOLT_TAIL_POINTS,
  boltEase,
  boltPoint,
  contactAt,
  FLASH_PEAK_SECONDS,
  FLIGHT_MAX_SECONDS,
  FLIGHT_MIN_SECONDS,
  flightSeconds,
  IMPACT_SECONDS,
  IMPACT_SPARKS_MAX,
  IMPACT_SPARKS_MIN,
  impactFlash,
  impactSparkCount,
  KNOCK_METRES,
  KNOCK_RISE_SECONDS,
  KNOCK_SECONDS,
  knockOffset,
  tailBrightness,
  tailFraction,
} from '../src/combat-view/impact-timing.ts';
import { glyphPath, revealAt } from '../src/sigil/glyph-path.ts';
import { FLOOR, MAX, SIGIL_IDS, SIGIL_TEMPLATES } from '../src/sigil/index.ts';
import {
  castPower,
  flickerGain,
  GLYPH_DRAW_SECONDS,
  GLYPH_END_SECONDS,
  GLYPH_FLARE_PEAK,
  GLYPH_LAUNCH_SECONDS,
  glyphFrame,
  headHeat,
  newGlyphFrame,
  TRAIL_FADE_SECONDS,
} from '../src/sigil-plate/glyph-timing.ts';

const PLATE_DONE_SECONDS = 1.6;

describe('glyph path', () => {
  it('flattens every stroke in order and measures the arc', () => {
    const path = glyphPath([
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
      [
        { x: 0, y: 1 },
        { x: 0, y: 3 },
      ],
    ]);
    expect(path.segments).toHaveLength(2);
    expect(path.length).toBeCloseTo(3);
    expect(path.segments[1]?.start).toBeCloseTo(1);
  });

  it('reveals at constant arc speed', () => {
    const path = glyphPath([
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 4, y: 0 },
      ],
    ]);
    const r = { full: 0, partial: 0 };
    expect(revealAt(path, 0, r)).toEqual({ full: 0, partial: 0 });
    expect(revealAt(path, 1, r)).toEqual({ full: 2, partial: 0 });
    // A quarter of the length is the whole first (short) segment.
    revealAt(path, 0.125, r);
    expect(r.full).toBe(0);
    expect(r.partial).toBeCloseTo(0.5);
    revealAt(path, 0.5, r);
    expect(r.full).toBe(1);
    expect(r.partial).toBeCloseTo(1 / 3);
  });

  it('covers every template, with the multi-stroke gear in one path', () => {
    for (const id of SIGIL_IDS) {
      const path = glyphPath(SIGIL_TEMPLATES[id].strokes);
      expect(path.length).toBeGreaterThan(1);
      const strokes = SIGIL_TEMPLATES[id].strokes;
      expect(path.segments).toHaveLength(strokes.reduce((n, s) => n + s.length - 1, 0));
    }
  });
});

describe('cast glyph timeline', () => {
  const at = (t: number, power = 1, reduced = false) =>
    glyphFrame(t, power, reduced, newGlyphFrame());

  it('fits inside the plate result hold, launching before it collapses', () => {
    expect(GLYPH_DRAW_SECONDS).toBeLessThan(GLYPH_FLARE_PEAK);
    expect(GLYPH_FLARE_PEAK).toBeLessThan(GLYPH_LAUNCH_SECONDS);
    expect(GLYPH_LAUNCH_SECONDS).toBeLessThan(GLYPH_END_SECONDS);
    expect(GLYPH_END_SECONDS).toBeLessThan(PLATE_DONE_SECONDS);
  });

  it('traces itself in over the draw time, monotonically', () => {
    expect(at(0).reveal).toBe(0);
    expect(at(GLYPH_DRAW_SECONDS).reveal).toBe(1);
    let last = -1;
    for (let t = 0; t <= GLYPH_DRAW_SECONDS; t += 0.02) {
      const r = at(t).reveal;
      expect(r).toBeGreaterThanOrEqual(last);
      last = r;
    }
  });

  it('flares to its peak, then collapses and ends', () => {
    expect(at(0.1).flare).toBe(0);
    expect(at(GLYPH_FLARE_PEAK).flare).toBeCloseTo(1);
    expect(at(GLYPH_FLARE_PEAK).brightness).toBeGreaterThan(at(0.2).brightness * 2);
    expect(at(GLYPH_END_SECONDS - 0.01).scale).toBeLessThan(0.2);
    const end = at(GLYPH_END_SECONDS);
    expect(end.alive).toBe(false);
    expect(end.brightness).toBe(0);
  });

  it('turns as it collapses, but never under reduced motion', () => {
    expect(at(0.3).spin).toBe(0);
    expect(at(GLYPH_END_SECONDS - 0.02).spin).toBeGreaterThan(0.4);
    for (let t = 0; t < GLYPH_END_SECONDS; t += 0.05) {
      const f = at(t, 1, true);
      expect(f.spin).toBe(0);
      expect(f.scale).toBeLessThanOrEqual(1);
    }
    expect(at(GLYPH_FLARE_PEAK, 1, true).flare).toBeLessThan(at(GLYPH_FLARE_PEAK).flare);
  });

  it('casts a weaker glyph for a poorer trace', () => {
    expect(castPower(FLOOR)).toBe(0);
    expect(castPower(MAX)).toBe(1);
    expect(castPower(0)).toBe(0);
    const weak = at(GLYPH_FLARE_PEAK, castPower(FLOOR));
    const strong = at(GLYPH_FLARE_PEAK, castPower(MAX));
    expect(weak.brightness).toBeLessThan(strong.brightness * 0.6);
    expect(weak.flare).toBeLessThan(strong.flare);
  });

  it('flickers a fizzle and holds a masterful cast steady', () => {
    expect(flickerGain(1, 1)).toBe(1);
    expect(flickerGain(0, 0)).toBe(1);
    expect(flickerGain(0, 1)).toBeLessThan(0.5);
    expect(flickerGain(0.5, 1)).toBeGreaterThan(flickerGain(0, 1));
  });

  it('fades the raw stroke out as the glyph starts', () => {
    expect(at(0).trail).toBe(1);
    expect(at(TRAIL_FADE_SECONDS / 2).trail).toBeCloseTo(0.5);
    expect(at(TRAIL_FADE_SECONDS).trail).toBe(0);
  });

  it('burns hottest at the head and cools behind it', () => {
    expect(headHeat(0)).toBe(1);
    expect(headHeat(0.5)).toBe(0);
    expect(headHeat(-0.1)).toBe(0);
    expect(headHeat(0.05)).toBeGreaterThan(headHeat(0.1));
  });
});

describe('attack impact timing', () => {
  it('clamps the flight time and lands every target of a play together', () => {
    expect(flightSeconds(0)).toBe(FLIGHT_MIN_SECONDS);
    expect(flightSeconds(100)).toBe(FLIGHT_MAX_SECONDS);
    expect(flightSeconds(1.35)).toBeCloseTo(0.3);
    expect(flightSeconds(Number.NaN)).toBe(FLIGHT_MIN_SECONDS);
    expect(contactAt(0.1, [1.35, 0])).toBeCloseTo(0.4);
    expect(contactAt(0.25, [])).toBe(0.25);
  });

  it('accelerates the bolt into the target along a shallow arc', () => {
    expect(boltEase(0)).toBe(0);
    expect(boltEase(1)).toBe(1);
    expect(boltEase(0.5)).toBeLessThan(0.5);
    for (let u = 0.05; u <= 1; u += 0.05) expect(boltEase(u)).toBeGreaterThan(boltEase(u - 0.05));
    const from = { x: 0, y: 1, z: 0 };
    const to = { x: 2, y: 1, z: 0 };
    const out = { x: 0, y: 0, z: 0 };
    expect(boltPoint(from, to, 0, out)).toEqual(from);
    expect(boltPoint(from, to, 1, out)).toEqual(to);
    boltPoint(from, to, 0.5, out);
    expect(out.x).toBeCloseTo(1);
    expect(out.y).toBeCloseTo(1 + BOLT_ARC * 2);
  });

  it('trails a fading comet behind the head', () => {
    expect(tailFraction(0.8, 0)).toBe(0.8);
    expect(tailFraction(0.05, BOLT_TAIL_POINTS - 1)).toBe(0);
    expect(tailBrightness(0)).toBe(1);
    expect(tailBrightness(BOLT_TAIL_POINTS - 1)).toBe(0);
  });

  it('flashes at contact, peaking fast and gone by the end of the burst', () => {
    expect(impactFlash(-0.01, 1, false)).toBe(0);
    expect(impactFlash(FLASH_PEAK_SECONDS, 1, false)).toBeCloseTo(1);
    expect(impactFlash(0.2, 1, false)).toBeLessThan(0.5);
    expect(impactFlash(IMPACT_SECONDS, 1, false)).toBe(0);
    expect(impactFlash(FLASH_PEAK_SECONDS, 0, false)).toBeLessThan(0.6);
    expect(impactFlash(FLASH_PEAK_SECONDS, 1, true)).toBeLessThan(0.7);
    expect(impactSparkCount(0)).toBe(IMPACT_SPARKS_MIN);
    expect(impactSparkCount(1)).toBe(IMPACT_SPARKS_MAX);
  });

  it('knocks the enemy back and returns it exactly home', () => {
    expect(knockOffset(0, 1, false)).toBe(0);
    expect(knockOffset(KNOCK_RISE_SECONDS, 1, false)).toBeCloseTo(KNOCK_METRES);
    expect(knockOffset(KNOCK_SECONDS, 1, false)).toBe(0);
    expect(knockOffset(KNOCK_SECONDS - 1e-6, 1, false)).toBeCloseTo(0, 6);
    expect(knockOffset(KNOCK_RISE_SECONDS, 1, true)).toBe(0);
    expect(knockOffset(KNOCK_RISE_SECONDS, 0, false)).toBeLessThan(KNOCK_METRES);
  });
});
