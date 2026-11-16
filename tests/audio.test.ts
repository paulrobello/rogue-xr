import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_DIR,
  type AudioDeps,
  AudioDirector,
  type AudioLoaderLike,
  audioStateFor,
  crossfadeGains,
  type FlatVoice,
  MUSIC_FILES,
  MUSIC_IDS,
  MusicMixer,
  type MusicSink,
  musicCueFor,
  SFX,
  SFX_IDS,
  type SfxId,
  type SpatialVoice,
  STINGER_FAMILY,
  STINGER_WINDOW,
  sfxForCombatEvent,
  VoicePool,
} from '../src/audio/index.ts';
import type { CombatEvent } from '../src/rules/types.ts';

class FakeVoice implements SpatialVoice {
  isPlaying = false;
  loop = false;
  volume = -1;
  buffer: AudioBuffer | null = null;
  plays = 0;
  readonly position = { set: vi.fn() };
  updateMatrixWorld = vi.fn();
  setBuffer(buffer: AudioBuffer) {
    this.buffer = buffer;
  }
  setVolume(volume: number) {
    this.volume = volume;
  }
  setLoop(loop: boolean) {
    this.loop = loop;
  }
  play() {
    this.isPlaying = true;
    this.plays++;
  }
  stop() {
    this.isPlaying = false;
  }
}

/** A spatial voice that is a real `Object3D`, like `THREE.PositionalAudio`. */
class ThreeFakeVoice extends THREE.Object3D implements SpatialVoice {
  isPlaying = false;
  setBuffer() {}
  setVolume() {}
  setLoop() {}
  play() {
    this.isPlaying = true;
  }
  stop() {
    this.isPlaying = false;
  }
}

const ALL_FILES = [...SFX_IDS.map((id) => SFX[id].file), ...MUSIC_IDS.map((id) => MUSIC_FILES[id])];

interface Harness {
  director: AudioDirector;
  voices: FakeVoice[];
  flat: FakeVoice[];
  requested: string[];
  warnings: string[];
  context: { state: string; resume: ReturnType<typeof vi.fn> };
  clock: { t: number };
}

/** A loader that serves every file except those whose path contains one of `missing`. */
function harness(missing: readonly string[] = [], spatialVoices = 8): Harness {
  const requested: string[] = [];
  const warnings: string[] = [];
  const voices: FakeVoice[] = [];
  const flat: FakeVoice[] = [];
  const clock = { t: 0 };
  const context = { state: 'running', resume: vi.fn() };
  const loader: AudioLoaderLike = {
    load(url, onLoad, _onProgress, onError) {
      requested.push(url);
      if (missing.some((m) => url.includes(m))) onError?.(new Error(`404 ${url}`));
      else onLoad({ duration: 1 } as AudioBuffer);
    },
  };
  const deps: AudioDeps = {
    context,
    loader,
    createSpatial: () => {
      const v = new FakeVoice();
      voices.push(v);
      return v;
    },
    createFlat: () => {
      const v = new FakeVoice();
      flat.push(v);
      return v;
    },
    setMasterVolume: vi.fn(),
  };
  const director = new AudioDirector({
    deps,
    baseUrl: '/',
    spatialVoices,
    now: () => clock.t,
    warn: (m) => warnings.push(m),
  });
  return { director, voices, flat, requested, warnings, context, clock };
}

describe('state to music cue mapping', () => {
  it('maps every audio state to a directive', () => {
    expect(musicCueFor('title')).toMatchObject({ kind: 'play', cue: 'explore' });
    expect(musicCueFor('explore')).toMatchObject({ kind: 'play', cue: 'explore', gain: 1 });
    expect(musicCueFor('encounter-unfolding')).toMatchObject({ kind: 'play', cue: 'combat' });
    expect(musicCueFor('encounter-active')).toMatchObject({ kind: 'play', cue: 'combat' });
    expect(musicCueFor('encounter-folding')).toEqual({ kind: 'hold' });
    expect(musicCueFor('reward')).toMatchObject({
      kind: 'play',
      cue: 'explore',
      stinger: 'reward-chime',
    });
    expect(musicCueFor('defeat')).toMatchObject({ kind: 'stop', stinger: 'defeat-sting' });
    expect(musicCueFor('victory')).toMatchObject({ kind: 'stop', stinger: 'victory-sting' });
  });

  it('only ever names cues and stingers that exist in the registries', () => {
    const states = [
      'title',
      'workshop',
      'explore',
      'encounter-unfolding',
      'encounter-active',
      'encounter-folding',
      'reward',
      'defeat',
      'victory',
    ] as const;
    for (const state of states) {
      const d = musicCueFor(state);
      if (d.kind === 'play') expect(MUSIC_IDS).toContain(d.cue);
      if (d.kind !== 'hold' && d.stinger) expect(SFX_IDS).toContain(d.stinger);
      if (d.kind !== 'hold') expect(d.fadeSeconds).toBeGreaterThan(0);
    }
  });

  it('enters combat faster than it returns to exploration', () => {
    const into = musicCueFor('encounter-unfolding');
    const out = musicCueFor('explore');
    if (into.kind !== 'play' || out.kind !== 'play') throw new Error('expected play directives');
    expect(into.fadeSeconds).toBeLessThan(out.fadeSeconds);
  });

  it('derives the audio state from the phase and the encounter phase', () => {
    expect(audioStateFor('title', 'idle')).toBe('title');
    expect(audioStateFor('workshop', 'idle')).toBe('workshop');
    expect(audioStateFor('explore', 'idle')).toBe('explore');
    expect(audioStateFor('explore', 'unfolding')).toBe('encounter-unfolding');
    expect(audioStateFor('combat', 'active')).toBe('encounter-active');
    expect(audioStateFor('combat', 'folding')).toBe('encounter-folding');
    expect(audioStateFor('reward', 'idle')).toBe('reward');
    expect(audioStateFor('combat', 'idle')).toBe('explore');
  });

  it('maps rules events to SFX and keeps state-owned events silent', () => {
    const damage = (target: string, hpLost: number): CombatEvent => ({
      type: 'damage-dealt',
      source: null,
      target,
      kind: 'attack',
      amount: 5,
      blocked: 5 - hpLost,
      hpLost,
    });
    expect(sfxForCombatEvent({ type: 'card-drawn', uid: 1, cardId: 'strike' })).toBe('card-draw');
    expect(
      sfxForCombatEvent({
        type: 'card-played',
        uid: 1,
        cardId: 'strike',
        target: null,
        dice: null,
      }),
    ).toBe('card-fling');
    expect(sfxForCombatEvent(damage('sentry', 5))).toBe('automaton-hit');
    expect(sfxForCombatEvent(damage('sentry', 0))).toBe('gear-clank');
    expect(sfxForCombatEvent(damage('player', 3))).toBe('gear-clank');
    expect(sfxForCombatEvent({ type: 'block-gained', target: 'player', amount: 5 })).toBe(
      'block-ward',
    );
    expect(sfxForCombatEvent({ type: 'steam-changed', from: 3, to: 1 })).toBe('steam-vent');
    expect(sfxForCombatEvent({ type: 'steam-changed', from: 1, to: 3 })).toBeNull();
    expect(sfxForCombatEvent({ type: 'enemy-died', enemyId: 'sentry' })).toBe('automaton-death');
    expect(sfxForCombatEvent({ type: 'combat-won' })).toBeNull();
    expect(sfxForCombatEvent({ type: 'combat-lost' })).toBeNull();
  });
});

describe('crossfade schedule math', () => {
  it('keeps constant power across the fade', () => {
    for (let i = 0; i <= 20; i++) {
      const g = crossfadeGains(i / 20);
      expect(g.out ** 2 + g.in ** 2).toBeCloseTo(1, 10);
    }
    expect(crossfadeGains(0)).toEqual({ out: 1, in: 0 });
    expect(crossfadeGains(1).in).toBeCloseTo(1, 10);
    expect(crossfadeGains(1).out).toBeCloseTo(0, 10);
    expect(crossfadeGains(-1).in).toBe(0);
    expect(crossfadeGains(2).in).toBeCloseTo(1, 10);
  });

  function sinkLog() {
    const events: string[] = [];
    const gains = new Map<number, number>();
    const sink: MusicSink<'a' | 'b'> = {
      start: (slot, cue) => events.push(`start ${slot} ${cue}`),
      stop: (slot) => {
        events.push(`stop ${slot}`);
        gains.delete(slot);
      },
      setGain: (slot, g) => gains.set(slot, g),
    };
    return { events, gains, sink };
  }

  it('fades the old layer out and the new one in over the requested time', () => {
    const { events, gains, sink } = sinkLog();
    const mixer = new MusicMixer<'a' | 'b'>(sink);
    mixer.request('a', 1, 0);
    expect(gains.get(0)).toBe(1);
    mixer.request('b', 1, 2);
    expect(events).toEqual(['start 0 a', 'start 1 b']);
    mixer.update(1);
    expect(gains.get(0)).toBeCloseTo(Math.cos(Math.PI / 4), 6);
    expect(gains.get(1)).toBeCloseTo(Math.sin(Math.PI / 4), 6);
    const power = (gains.get(0) as number) ** 2 + (gains.get(1) as number) ** 2;
    expect(power).toBeCloseTo(1, 6);
    mixer.update(1);
    expect(events).toContain('stop 0');
    expect(gains.get(1)).toBeCloseTo(1, 6);
    expect(mixer.liveLayers).toBe(1);
    expect(mixer.current).toBe('b');
  });

  it('retargets the gain of a cue that is already playing without restarting it', () => {
    const { events, gains, sink } = sinkLog();
    const mixer = new MusicMixer<'a' | 'b'>(sink);
    mixer.request('a', 0.6, 0);
    mixer.request('a', 1, 2);
    mixer.update(1);
    expect(events).toEqual(['start 0 a']);
    expect(gains.get(0)).toBeCloseTo(0.8, 6);
    mixer.update(1);
    expect(gains.get(0)).toBeCloseTo(1, 6);
  });

  it('reuses a layer that is still fading out when its cue returns, and never exceeds its slots', () => {
    const { events, sink } = sinkLog();
    const mixer = new MusicMixer<'a' | 'b'>(sink, 2);
    mixer.request('a', 1, 0);
    mixer.request('b', 1, 4);
    mixer.update(1);
    mixer.request('a', 1, 1);
    expect(events.filter((e) => e.startsWith('start'))).toEqual(['start 0 a', 'start 1 b']);
    expect(mixer.current).toBe('a');
    expect(mixer.liveLayers).toBeLessThanOrEqual(2);
  });

  it('fades everything out on stop and frees the slots', () => {
    const { events, sink } = sinkLog();
    const mixer = new MusicMixer<'a' | 'b'>(sink);
    mixer.request('a', 1, 0);
    mixer.stop(1.5);
    expect(mixer.current).toBeNull();
    mixer.update(1.5);
    expect(mixer.liveLayers).toBe(0);
    expect(events).toContain('stop 0');
  });
});

describe('voice pool', () => {
  const pool = (n: number) => new VoicePool(Array.from({ length: n }, () => new FakeVoice()));

  it('reuses idle voices without growing', () => {
    const p = pool(3);
    const first = p.acquire();
    if (!first) throw new Error('no voice');
    first.voice.play();
    first.voice.stop();
    const again = p.acquire();
    expect(p.capacity).toBe(3);
    expect(again?.stolen).toBe(false);
  });

  it('caps concurrency at the pool size and steals the oldest voice', () => {
    const p = pool(3);
    const acquired = [];
    for (let i = 0; i < 3; i++) {
      const a = p.acquire();
      if (!a) throw new Error('no voice');
      a.voice.play();
      acquired.push(a.voice);
    }
    expect(p.busy).toBe(3);
    const fourth = p.acquire();
    expect(fourth?.stolen).toBe(true);
    expect(fourth?.voice).toBe(acquired[0]);
    fourth?.voice.play();
    expect(p.busy).toBe(3);
    expect(p.capacity).toBe(3);
  });

  it('prefers the least recently used idle voice', () => {
    const p = pool(2);
    const a = p.acquire();
    a?.voice.play();
    a?.voice.stop();
    const b = p.acquire();
    expect(b?.voice).not.toBe(a?.voice);
  });
});

describe('AudioDirector', () => {
  it('loads every registered file once, under the audio directory', async () => {
    const h = harness();
    const report = await h.director.load();
    expect(report.missing).toEqual([]);
    expect(report.loaded).toHaveLength(ALL_FILES.length);
    expect(h.requested.sort()).toEqual(ALL_FILES.map((f) => `/${AUDIO_DIR}/${f}`).sort());
    expect(h.warnings).toEqual([]);
  });

  it('creates its voices once and reuses them under a burst of sounds', async () => {
    const h = harness();
    await h.director.load();
    const created = h.voices.length + h.flat.length;
    // 8 spatial pool voices plus one dedicated loop voice, 4 flat voices plus 3 music layers.
    expect(h.voices).toHaveLength(9);
    expect(h.flat).toHaveLength(7);
    for (let i = 0; i < 50; i++) {
      h.clock.t += 1;
      h.director.playSfx('card-impact', { x: i, y: 1, z: -1 });
    }
    expect(h.voices.length + h.flat.length).toBe(created);
    expect(h.director.spatialPool.busy).toBe(8);
    expect(h.voices.reduce((n, v) => n + v.plays, 0)).toBe(50);
  });

  it('places positional cues at the requested point and plays ui cues flat', async () => {
    const h = harness();
    await h.director.load();
    expect(h.director.playSfx('automaton-hit', { x: 1, y: 2, z: 3 })).toBe(true);
    const voice = h.voices.find((v) => v.plays > 0);
    expect(voice?.position.set).toHaveBeenCalledWith(1, 2, 3);
    expect(voice?.updateMatrixWorld).toHaveBeenCalled();
    expect(h.director.playSfx('ui-tick', { x: 9, y: 9, z: 9 })).toBe(true);
    expect(h.flat.some((v) => v.plays > 0 && v.buffer !== null)).toBe(true);
    expect(h.voices.filter((v) => v.plays > 0)).toHaveLength(1);
  });

  it('drops a retrigger inside the minimum gap', async () => {
    const h = harness();
    await h.director.load();
    expect(h.director.playSfx('card-draw', { x: 0, y: 1, z: 0 })).toBe(true);
    h.clock.t += SFX['card-draw'].minGap / 2;
    expect(h.director.playSfx('card-draw', { x: 0, y: 1, z: 0 })).toBe(false);
    h.clock.t += SFX['card-draw'].minGap;
    expect(h.director.playSfx('card-draw', { x: 0, y: 1, z: 0 })).toBe(true);
  });

  it('plays nothing until the context runs, and unlocks on the first gesture and on XR session start', async () => {
    const h = harness();
    await h.director.load();
    h.context.state = 'suspended';
    expect(h.director.playSfx('ui-tick')).toBe(false);
    h.context.resume.mockImplementation(() => {
      h.context.state = 'running';
    });
    const target = new EventTarget();
    h.director.unlockOnGesture(target);
    target.dispatchEvent(new Event('pointerdown'));
    await vi.waitFor(() => expect(h.context.resume).toHaveBeenCalledTimes(1));
    expect(h.director.playSfx('ui-tick')).toBe(true);
    // disarmed after the context runs
    target.dispatchEvent(new Event('pointerdown'));
    expect(h.context.resume).toHaveBeenCalledTimes(1);

    h.context.state = 'suspended';
    const xr = new EventTarget();
    h.director.unlockOnXrSession(xr);
    xr.dispatchEvent(new Event('sessionstart'));
    await vi.waitFor(() => expect(h.context.resume).toHaveBeenCalledTimes(2));
  });

  it('falls back to silence for missing files and warns once per kind', async () => {
    const h = harness(['music/', 'sfx/door-open', 'sfx/dice-roll']);
    const report = await h.director.load();
    expect([...report.missing].sort()).toEqual([
      'dice-roll',
      'door-open',
      'music:combat',
      'music:explore',
    ]);
    expect(h.warnings).toHaveLength(2);
    expect(h.warnings[0]).toContain('music');
    expect(h.warnings[1]).toContain('dice-roll');
    expect(h.director.playSfx('door-open', { x: 0, y: 0, z: 0 })).toBe(false);
    expect(h.director.playSfx('card-draw', { x: 0, y: 0, z: 0 })).toBe(true);

    h.director.setState('explore');
    h.director.setState('encounter-active');
    h.director.update(5);
    expect(h.flat.every((v) => !v.isPlaying || v.buffer !== null)).toBe(true);
    expect(h.warnings).toHaveLength(2);
    expect(h.director.musicCue).toBe('combat');
  });

  it('crossfades music with state changes and plays the stinger for run end', async () => {
    const h = harness();
    await h.director.load();
    const music = h.flat.slice(4);
    h.director.setState('explore');
    h.director.update(3);
    expect(music.filter((v) => v.isPlaying)).toHaveLength(1);
    h.director.setState('encounter-unfolding');
    h.director.update(0.5);
    expect(music.filter((v) => v.isPlaying)).toHaveLength(2);
    h.director.update(0.5);
    expect(music.filter((v) => v.isPlaying)).toHaveLength(1);
    expect(h.director.musicCue).toBe('combat');

    h.director.setState('encounter-folding');
    expect(h.director.musicCue).toBe('combat');

    h.clock.t += 5;
    const stingersBefore = h.flat.slice(0, 4).reduce((n, v) => n + v.plays, 0);
    h.director.setState('defeat');
    expect(h.flat.slice(0, 4).reduce((n, v) => n + v.plays, 0)).toBe(stingersBefore + 1);
    h.director.update(1.5);
    expect(music.filter((v) => v.isPlaying)).toHaveLength(0);
    expect(h.director.musicCue).toBeNull();
  });

  describe('stinger families', () => {
    const stingerPlays = (h: Harness) => h.flat.slice(0, 4).reduce((n, v) => n + v.plays, 0);

    it('registers only existing cues, and every state stinger belongs to a family', () => {
      for (const id of Object.keys(STINGER_FAMILY)) expect(SFX_IDS).toContain(id);
      for (const state of ['reward', 'defeat', 'victory'] as const) {
        const d = musicCueFor(state);
        if (d.kind === 'hold' || !d.stinger) throw new Error(`${state} has no stinger`);
        expect(STINGER_FAMILY[d.stinger]).toBeDefined();
      }
    });

    it("drops the flow's defeat stinger when the fight's own defeat stinger just played", async () => {
      const h = harness();
      await h.director.load();
      h.clock.t = 10;
      expect(h.director.playSfx('defeat-sting')).toBe(true);
      h.clock.t += 1;
      h.director.setState('defeat');
      expect(stingerPlays(h)).toBe(1);
      expect(h.director.state).toBe('defeat');
    });

    it("drops the flow's reward chime when the fight's victory stinger just played", async () => {
      const h = harness();
      await h.director.load();
      h.clock.t = 10;
      expect(h.director.playSfx('victory-sting')).toBe(true);
      h.clock.t += 1;
      h.director.setState('reward');
      expect(stingerPlays(h)).toBe(1);
      expect(h.director.musicCue).toBe('explore');
    });

    it('drops a run victory stinger that follows the fight victory stinger', async () => {
      const h = harness();
      await h.director.load();
      h.clock.t = 10;
      h.director.playSfx('victory-sting');
      h.clock.t += SFX['victory-sting'].minGap + 0.1;
      h.director.setState('victory');
      expect(stingerPlays(h)).toBe(1);
    });

    it('lets the family sound again once the window has passed', async () => {
      const h = harness();
      await h.director.load();
      h.clock.t = 10;
      h.director.playSfx('victory-sting');
      h.clock.t += STINGER_WINDOW - 0.01;
      expect(h.director.playSfx('reward-chime')).toBe(false);
      h.clock.t += 0.02;
      expect(h.director.playSfx('reward-chime')).toBe(true);
      expect(stingerPlays(h)).toBe(2);
    });

    it('keeps outcome families independent and leaves ordinary cues alone', async () => {
      const h = harness();
      await h.director.load();
      h.clock.t = 10;
      expect(h.director.playSfx('defeat-sting')).toBe(true);
      expect(h.director.playSfx('victory-sting')).toBe(true);
      expect(h.director.playSfx('ui-tick')).toBe(true);
    });

    it('does not extend the window with a dropped stinger', async () => {
      const h = harness();
      await h.director.load();
      h.clock.t = 10;
      h.director.playSfx('victory-sting');
      h.clock.t += 2;
      expect(h.director.playSfx('reward-chime')).toBe(false);
      h.clock.t += 1.01;
      expect(h.director.playSfx('reward-chime')).toBe(true);
    });
  });

  it('starts music requested before the files finished loading', async () => {
    const h = harness();
    h.director.setState('title');
    const music = h.flat.slice(4);
    expect(music.some((v) => v.isPlaying)).toBe(false);
    await h.director.load();
    expect(music.filter((v) => v.isPlaying)).toHaveLength(1);
  });

  it('loops the sigil trace on its own voice and stops it', async () => {
    const h = harness();
    await h.director.load();
    expect(h.director.startLoop('sigil-trace', { x: 0, y: 1, z: -0.5 })).toBe(true);
    const loopVoice = h.voices[8];
    expect(loopVoice?.loop).toBe(true);
    expect(loopVoice?.isPlaying).toBe(true);
    expect(h.director.startLoop('sigil-trace')).toBe(false);
    expect(h.director.playSfx('sigil-trace')).toBe(false);
    h.director.stopLoop('sigil-trace');
    expect(loopVoice?.isPlaying).toBe(false);
  });

  it('stops everything on dispose and ignores later calls', async () => {
    const h = harness();
    await h.director.load();
    h.director.setState('explore');
    h.director.playSfx('card-draw', { x: 0, y: 1, z: 0 });
    h.director.dispose();
    expect([...h.voices, ...h.flat].some((v) => v.isPlaying)).toBe(false);
    expect(h.director.playSfx('card-draw', { x: 0, y: 1, z: 0 })).toBe(false);
    expect(() => h.director.update(1)).not.toThrow();
    expect(() => h.director.dispose()).not.toThrow();
  });

  it('requires a camera or deps', () => {
    expect(() => new AudioDirector({})).toThrow();
  });

  it('adds three.js voices under its root when given real objects', () => {
    const deps: AudioDeps = {
      context: { state: 'running', resume: () => undefined },
      loader: { load: () => undefined },
      createSpatial: () => new ThreeFakeVoice(),
      createFlat: () => new FakeVoice() as FlatVoice,
      setMasterVolume: () => undefined,
    };
    const director = new AudioDirector({ deps, baseUrl: '/' });
    expect(director.root.children.length).toBe(9);
  });
});

describe('registry against the files on disk', () => {
  const dir = resolve(import.meta.dirname, '..', 'public', AUDIO_DIR);
  const present = existsSync(resolve(dir, 'sfx'));

  it('uses unique file names that follow the sfx/<id>.ogg convention', () => {
    for (const id of SFX_IDS) expect(SFX[id].file).toBe(`sfx/${id}.ogg`);
    expect(new Set(SFX_IDS).size).toBe(SFX_IDS.length);
    for (const id of MUSIC_IDS) expect(MUSIC_FILES[id]).toBe(`music/${id}.ogg`);
  });

  it.skipIf(!present)('has a runtime file for every SFX id and no unregistered SFX file', () => {
    const files = readdirSync(resolve(dir, 'sfx')).filter((f) => f.endsWith('.ogg'));
    const ids = files.map((f) => f.replace(/\.ogg$/, '')).sort();
    expect(ids).toEqual([...SFX_IDS].sort() as SfxId[]);
  });

  it.skipIf(!present)('has a music file for each present music cue and none unregistered', () => {
    const musicDir = resolve(dir, 'music');
    if (!existsSync(musicDir)) return;
    for (const f of readdirSync(musicDir).filter((n) => n.endsWith('.ogg'))) {
      expect(MUSIC_IDS).toContain(f.replace(/\.ogg$/, '') as (typeof MUSIC_IDS)[number]);
    }
  });
});

describe('integration types', () => {
  it('accepts window and renderer.xr for the unlock hooks (checked by tsc)', () => {
    const wire = (director: AudioDirector, renderer: THREE.WebGLRenderer) => {
      director.unlockOnGesture(window);
      director.unlockOnXrSession(renderer.xr);
    };
    expect(typeof wire).toBe('function');
  });
});
