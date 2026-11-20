import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SFX } from '../src/audio/cues.ts';

describe('secret service panel knocks', () => {
  it('registers distinct positional mono Opus assets', () => {
    const solid = readFileSync('public/assets/audio/sfx/panel-solid.ogg');
    const hollow = readFileSync('public/assets/audio/sfx/panel-hollow.ogg');
    expect(existsSync('public/assets/audio/sfx/panel-solid.ogg')).toBe(true);
    expect(existsSync('public/assets/audio/sfx/panel-hollow.ogg')).toBe(true);
    expect(SFX['panel-solid'].kind).toBe('positional');
    expect(SFX['panel-hollow'].kind).toBe('positional');
    expect(solid.equals(hollow)).toBe(false);
    expect(solid.subarray(0, 4).toString()).toBe('OggS');
    expect(hollow.subarray(0, 4).toString()).toBe('OggS');
  });
});
