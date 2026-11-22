import { describe, expect, it } from 'vitest';
import { DRUM_GALLERY_VERSION } from '../src/combat/encounter-choice.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { validateSnapshot } from '../src/persist/saves.ts';
import {
  type DrumBeat,
  drumPattern,
  drumPlayback,
  EMPTY_DRUM_GALLERY,
  setDrumPin,
  windDrum,
} from '../src/rules/drum-gallery.ts';
import type { BellNote } from '../src/rules/types.ts';
import { createWorkshop } from '../src/rules/workshop.ts';

const fresh = () =>
  new RunFlow({ workshop: createWorkshop(), starterDeck: ['strike'], rewardPool: ['cog-toss'] });

describe('Drum Gallery rules', () => {
  it('seed-selects one silent beat and gives the service score all three notes', () => {
    const gaps = new Set<number>();
    for (let i = 0; i < 32; i++) {
      const seed = `DR0M${String(i).padStart(4, '0')}`;
      const pattern = drumPattern(seed);
      gaps.add(pattern.gap);
      expect(drumPattern(seed.toLowerCase())).toEqual(pattern);
      expect(new Set(pattern.notes)).toEqual(new Set([0, 1, 2]));
      const played = drumPlayback(pattern, null);
      expect(played).toHaveLength(4);
      expect(played[pattern.gap]).toEqual([]);
      expect(played.map((notes) => notes.length).filter((count) => count === 1)).toHaveLength(3);
    }
    expect(gaps).toEqual(new Set([0, 1, 2, 3]));
  });

  it('lets the spare be tried in any empty socket but releases only on the correct wind', () => {
    const pattern = drumPattern('DR0M0001');
    const required = pattern.notes[pattern.gap];
    for (const beat of [0, 1, 2, 3] as const satisfies readonly DrumBeat[]) {
      for (const note of [0, 1, 2] as const satisfies readonly BellNote[]) {
        const pin = { beat, note };
        const seated = setDrumPin(pattern, EMPTY_DRUM_GALLERY, pin);
        if (beat !== pattern.gap && note === pattern.notes[beat]) {
          expect(seated).toBe(EMPTY_DRUM_GALLERY);
          continue;
        }
        expect(seated).toEqual({ pin, open: false });
        expect(setDrumPin(pattern, seated, pin)).toEqual(EMPTY_DRUM_GALLERY);
        const played = drumPlayback(pattern, pin);
        expect(played[beat]).toEqual(beat === pattern.gap ? [note] : [pattern.notes[beat], note]);
        const tested = windDrum(pattern, seated);
        if (beat !== pattern.gap || note !== required) {
          expect(tested).toBe(seated);
          continue;
        }
        expect(tested).toEqual({ pin, open: true });
        expect(drumPlayback(pattern, tested.pin)).toEqual(pattern.notes.map((pitch) => [pitch]));
        expect(windDrum(pattern, tested)).toBe(tested);
        expect(setDrumPin(pattern, tested, pin)).toBe(tested);
      }
    }
  });

  it('restores a seated pin on Continue and a solved latch after revisiting the Conservatory', () => {
    const flow = fresh();
    const seed = 'DR0M0001';
    const pattern = drumPattern(seed);
    const pin = { beat: pattern.gap, note: pattern.notes[pattern.gap] };
    const fit = { kind: 'pin', pin } as const;
    const wind = { kind: 'wind' } as const;
    flow.newRun(seed);
    expect(flow.operateDrumGallery(fit)).toBe(false);
    expect(flow.travelToFloor(2, 0)).toBe(true);
    expect(flow.operateDrumGallery(fit)).toBe(false);
    expect(flow.travelToFloor(3, 0)).toBe(true);
    let changes = 0;
    const off = flow.onChange((event) => {
      if (event.type === 'drum-gallery') changes++;
    });
    expect(flow.operateDrumGallery(wind)).toBe(true);
    expect(changes).toBe(0);
    expect(flow.operateDrumGallery(fit)).toBe(true);
    expect(changes).toBe(1);
    off();

    const draft = validateSnapshot(flow.snapshot(16));
    expect(draft.run.drumGallery).toEqual({ pin, open: false });
    const continued = fresh();
    expect(continued.continueRun(draft)).toBe(true);
    expect(continued.operateDrumGallery(wind)).toBe(true);
    expect(continued.drumGallery).toEqual({ pin, open: true });
    expect(continued.travelToFloor(2, 0)).toBe(true);
    expect(continued.drumGallery).toBe(EMPTY_DRUM_GALLERY);
    const restored = fresh();
    expect(restored.continueRun(validateSnapshot(continued.snapshot(24)))).toBe(true);
    expect(restored.travelToFloor(3, 0)).toBe(true);
    expect(restored.drumGallery).toEqual({ pin, open: true });
    expect(restored.operateDrumGallery(fit)).toBe(false);

    const legacy = fresh();
    expect(legacy.continueRun({ ...draft, contentVersion: DRUM_GALLERY_VERSION - 1 })).toBe(true);
    expect(legacy.operateDrumGallery(wind)).toBe(false);
  });

  it('rejects an imported open grille whose pin plays the wrong note', () => {
    const flow = fresh();
    const seed = 'DR0M0001';
    const pattern = drumPattern(seed);
    const wrong = { beat: pattern.gap, note: ((pattern.notes[pattern.gap] + 1) % 3) as BellNote };
    flow.newRun(seed);
    flow.travelToFloor(2, 0);
    flow.travelToFloor(3, 0);
    const snapshot = validateSnapshot(flow.snapshot(16));
    expect(() =>
      validateSnapshot({
        ...snapshot,
        run: { ...snapshot.run, drumGallery: { pin: wrong, open: true } },
      }),
    ).toThrow('the fitted pin does not complete the phrase');
  });
});
