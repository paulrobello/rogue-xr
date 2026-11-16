import * as THREE from 'three';
import type { EncounterPhase } from '../combat/encounter.ts';
import type { GamePhase } from '../core/state.ts';
import type { CombatEvent } from '../rules/types.ts';
import {
  AUDIO_DIR,
  type AudioState,
  audioStateFor,
  MUSIC_FILES,
  MUSIC_IDS,
  type MusicId,
  MusicMixer,
  type MusicSink,
  musicCueFor,
  type PoolVoice,
  SFX,
  SFX_IDS,
  type SfxId,
  sfxForCombatEvent,
  VoicePool,
} from './cues.ts';

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The slice of `THREE.Audio` the director uses. */
export interface FlatVoice extends PoolVoice {
  setBuffer(buffer: AudioBuffer): unknown;
  setVolume(volume: number): unknown;
  setLoop(loop: boolean): unknown;
  play(): unknown;
  disconnect?(): unknown;
}

/** The slice of `THREE.PositionalAudio` the director uses. */
export interface SpatialVoice extends FlatVoice {
  readonly position: { set(x: number, y: number, z: number): unknown };
  updateMatrixWorld(force?: boolean): void;
}

/** The slice of `EventTarget` the unlock hooks use. */
export interface ListenerTarget {
  addEventListener(type: string, listener: () => void): unknown;
  removeEventListener(type: string, listener: () => void): unknown;
}

/** `renderer.xr` (a `WebXRManager`) or any `EventTarget` that fires `sessionstart`. */
export interface SessionEvents {
  addEventListener(type: 'sessionstart', listener: () => void): unknown;
  removeEventListener(type: 'sessionstart', listener: () => void): unknown;
}

export interface AudioLoaderLike {
  load(
    url: string,
    onLoad: (buffer: AudioBuffer) => void,
    onProgress?: (event: ProgressEvent) => void,
    onError?: (error: unknown) => void,
  ): void;
}

/** Everything the director needs from the browser, injectable so tests run without Web Audio. */
export interface AudioDeps {
  readonly context: { readonly state: string; resume(): Promise<void> | void };
  readonly loader: AudioLoaderLike;
  createSpatial(): SpatialVoice;
  createFlat(): FlatVoice;
  setMasterVolume(volume: number): void;
  dispose?(): void;
}

/** three.js audio: an `AudioListener` on the camera, `AudioLoader`, `Audio` and `PositionalAudio`. */
export function createThreeDeps(camera: THREE.Object3D): AudioDeps {
  const listener = new THREE.AudioListener();
  camera.add(listener);
  return {
    context: listener.context,
    loader: new THREE.AudioLoader(),
    createSpatial() {
      const voice = new THREE.PositionalAudio(listener);
      voice.setDistanceModel('inverse');
      voice.setRefDistance(1);
      voice.setRolloffFactor(1.5);
      voice.setMaxDistance(25);
      return voice;
    },
    createFlat: () => new THREE.Audio(listener),
    setMasterVolume: (volume) => listener.setMasterVolume(volume),
    dispose() {
      camera.remove(listener);
    },
  };
}

export interface AudioDirectorOptions {
  /** Camera to hang the `AudioListener` on. Required unless `deps` is given. */
  camera?: THREE.Object3D;
  deps?: AudioDeps;
  /** Site base URL, default `import.meta.env.BASE_URL`. */
  baseUrl?: string;
  /** Concurrent positional SFX voices. Default 8. */
  spatialVoices?: number;
  /** Concurrent flat SFX voices (UI and stingers). Default 4. */
  flatVoices?: number;
  /** Seconds clock for retrigger guards. Default `performance.now() / 1000`. */
  now?: () => number;
  warn?: (message: string) => void;
}

export interface LoadReport {
  readonly loaded: readonly string[];
  readonly missing: readonly string[];
}

const MUSIC_SLOTS = 3;
const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend', 'click'] as const;

function joinUrl(base: string, ...parts: string[]): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  return root + parts.join('/');
}

/**
 * Plays the game's music and SFX. Voices are created once and reused (a burst steals the oldest
 * voice rather than allocating), music crossfades equal-power across looping layers, and a missing
 * or undecodable file leaves that cue silent and logs once. Construct it once, add `root` to the
 * scene, call `load()`, drive it with `setState`/`syncGame`/`playSfx`, call `update(dt)` each frame
 * and `unlockOnGesture` / `unlockOnXrSession` so the context resumes on first input.
 */
export class AudioDirector {
  /** Parent of the positional voices. Add it to the scene, world-space, untransformed. */
  readonly root = new THREE.Group();
  private readonly deps: AudioDeps;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly spatial: VoicePool<SpatialVoice>;
  private readonly flat: VoicePool<FlatVoice>;
  private readonly loops = new Map<SfxId, SpatialVoice>();
  private readonly musicVoices: FlatVoice[] = [];
  private readonly mixer: MusicMixer<MusicId>;
  private readonly sfxBuffers = new Map<SfxId, AudioBuffer>();
  private readonly musicBuffers = new Map<MusicId, AudioBuffer>();
  private readonly lastPlayed = new Map<SfxId, number>();
  private readonly unlockers: (() => void)[] = [];
  private stateValue: AudioState | null = null;
  private sfxVolume = 1;
  private musicVolume = 1;
  private disposed = false;

  constructor(options: AudioDirectorOptions) {
    const deps = options.deps ?? (options.camera ? createThreeDeps(options.camera) : null);
    if (!deps) throw new Error('AudioDirector needs a camera or deps');
    this.deps = deps;
    this.baseUrl = options.baseUrl ?? import.meta.env.BASE_URL;
    this.now = options.now ?? (() => performance.now() / 1000);
    this.warn = options.warn ?? ((message) => console.warn(message));

    this.spatial = new VoicePool(
      Array.from({ length: options.spatialVoices ?? 8 }, () => this.makeSpatial()),
    );
    this.flat = new VoicePool(
      Array.from({ length: options.flatVoices ?? 4 }, () => deps.createFlat()),
    );
    for (const id of SFX_IDS) {
      if (SFX[id].loop) this.loops.set(id, this.makeSpatial());
    }
    for (let i = 0; i < MUSIC_SLOTS; i++) this.musicVoices.push(deps.createFlat());
    this.mixer = new MusicMixer<MusicId>(this.musicSink(), MUSIC_SLOTS);
  }

  /** The audio state last passed to `setState`, or null before the first. */
  get state(): AudioState | null {
    return this.stateValue;
  }

  /** The music cue fading in or holding, or null. */
  get musicCue(): MusicId | null {
    return this.mixer.current;
  }

  get spatialPool(): VoicePool<SpatialVoice> {
    return this.spatial;
  }

  get flatPool(): VoicePool<FlatVoice> {
    return this.flat;
  }

  /**
   * Fetches and decodes every registered file. A missing or broken file is skipped: that cue
   * stays silent, and one warning per kind (music, SFX) names what is missing.
   */
  async load(): Promise<LoadReport> {
    const loaded: string[] = [];
    const missing: string[] = [];
    const fetchOne = (key: string, file: string, store: (buffer: AudioBuffer) => void) =>
      new Promise<void>((resolve) => {
        this.deps.loader.load(
          joinUrl(this.baseUrl, AUDIO_DIR, file),
          (buffer) => {
            if (!this.disposed) store(buffer);
            loaded.push(key);
            resolve();
          },
          undefined,
          () => {
            missing.push(key);
            resolve();
          },
        );
      });
    await Promise.all([
      ...SFX_IDS.map((id) => fetchOne(id, SFX[id].file, (b) => this.sfxBuffers.set(id, b))),
      ...MUSIC_IDS.map((id) =>
        fetchOne(`music:${id}`, MUSIC_FILES[id], (b) => this.musicBuffers.set(id, b)),
      ),
    ]);
    const missingMusic = missing.filter((m) => m.startsWith('music:')).map((m) => m.slice(6));
    const missingSfx = missing.filter((m) => !m.startsWith('music:'));
    if (missingMusic.length > 0) {
      this.warn(`[audio] music not found (${missingMusic.join(', ')}): music stays silent`);
    }
    if (missingSfx.length > 0) {
      this.warn(
        `[audio] ${missingSfx.length} SFX not found (${missingSfx.join(', ')}): those cues stay silent`,
      );
    }
    this.startLoadedMusic();
    return { loaded, missing };
  }

  /** Moves the music bus to the cue for `state` and plays that state's stinger. Idempotent per state. */
  setState(state: AudioState): void {
    if (this.disposed || state === this.stateValue) return;
    this.stateValue = state;
    const directive = musicCueFor(state);
    if (directive.kind === 'hold') return;
    if (directive.kind === 'play')
      this.mixer.request(directive.cue, directive.gain, directive.fadeSeconds);
    else this.mixer.stop(directive.fadeSeconds);
    if (directive.stinger) this.playSfx(directive.stinger);
  }

  /** Derives the audio state from the game phase and the encounter phase. Call it every frame; it only acts on change. */
  syncGame(phase: GamePhase, encounter: EncounterPhase): void {
    this.setState(audioStateFor(phase, encounter));
  }

  /**
   * Plays an SFX. Positional cues with `at` are spatialised from that world point, everything else
   * plays flat. Returns false when the cue was dropped: missing file, context not running,
   * retrigger guard, or the director is disposed.
   */
  playSfx(id: SfxId, at?: Vec3Like, volume = 1): boolean {
    const def = SFX[id];
    const buffer = this.sfxBuffers.get(id);
    if (this.disposed || !buffer || def.loop || this.deps.context.state !== 'running') return false;
    const now = this.now();
    const last = this.lastPlayed.get(id);
    if (last !== undefined && now - last < def.minGap) return false;
    const spatial = def.kind === 'positional' && at !== undefined;
    const acquired = spatial ? this.spatial.acquire() : this.flat.acquire();
    if (!acquired) return false;
    this.lastPlayed.set(id, now);
    const voice = acquired.voice;
    if (spatial && at) this.place(voice as SpatialVoice, at);
    voice.setBuffer(buffer);
    voice.setLoop(false);
    voice.setVolume(def.gain * this.sfxVolume * volume);
    voice.play();
    return true;
  }

  /** Plays the SFX for a rules event, from `at` when it has a location. Returns the cue played, or null. */
  playCombatEvent(event: CombatEvent, at?: Vec3Like): SfxId | null {
    const id = sfxForCombatEvent(event);
    return id !== null && this.playSfx(id, at) ? id : null;
  }

  /** Starts a looping cue (the sigil trace hum). No-op when it already plays or its file is missing. */
  startLoop(id: SfxId, at?: Vec3Like): boolean {
    const voice = this.loops.get(id);
    const buffer = this.sfxBuffers.get(id);
    if (this.disposed || !voice || !buffer || voice.isPlaying) return false;
    if (this.deps.context.state !== 'running') return false;
    if (at) this.place(voice, at);
    voice.setBuffer(buffer);
    voice.setLoop(true);
    voice.setVolume(SFX[id].gain * this.sfxVolume);
    voice.play();
    return true;
  }

  stopLoop(id: SfxId): void {
    const voice = this.loops.get(id);
    if (voice?.isPlaying) voice.stop();
  }

  /** Advances the music crossfades by `dt` real seconds. */
  update(dt: number): void {
    if (!this.disposed) this.mixer.update(dt);
  }

  /** Master, music-bus and SFX-bus volumes, 0..1. Omitted fields are unchanged. */
  setVolumes(volumes: { master?: number; music?: number; sfx?: number }): void {
    if (volumes.master !== undefined) this.deps.setMasterVolume(volumes.master);
    if (volumes.sfx !== undefined) this.sfxVolume = volumes.sfx;
    if (volumes.music !== undefined) {
      this.musicVolume = volumes.music;
      this.mixer.refresh();
    }
  }

  /** Resumes a suspended context. Safe to call repeatedly. */
  async resume(): Promise<void> {
    if (this.deps.context.state !== 'running') await this.deps.context.resume();
  }

  /** Resumes the context on the first user input on `target`. Returns a function that disarms it. */
  unlockOnGesture(target: ListenerTarget, events: readonly string[] = UNLOCK_EVENTS): () => void {
    return this.arm(target, events);
  }

  /** Resumes the context when an immersive session starts (`renderer.xr` fires `sessionstart`). */
  unlockOnXrSession(xr: SessionEvents): () => void {
    return this.arm(xr, ['sessionstart']);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.unlockers.splice(0)) off();
    this.spatial.stopAll();
    this.flat.stopAll();
    for (const voice of [...this.loops.values(), ...this.musicVoices]) {
      if (voice.isPlaying) voice.stop();
    }
    for (const voice of [
      ...this.spatial.voices,
      ...this.flat.voices,
      ...this.loops.values(),
      ...this.musicVoices,
    ]) {
      voice.disconnect?.();
    }
    this.root.removeFromParent();
    this.root.clear();
    this.sfxBuffers.clear();
    this.musicBuffers.clear();
    this.lastPlayed.clear();
    this.deps.dispose?.();
  }

  private makeSpatial(): SpatialVoice {
    const voice = this.deps.createSpatial();
    if (voice instanceof THREE.Object3D) this.root.add(voice);
    return voice;
  }

  private place(voice: SpatialVoice, at: Vec3Like): void {
    voice.position.set(at.x, at.y, at.z);
    voice.updateMatrixWorld(true);
  }

  private arm(target: ListenerTarget, events: readonly string[]): () => void {
    const off = () => {
      for (const name of events) target.removeEventListener(name, handler);
      const at = this.unlockers.indexOf(off);
      if (at >= 0) this.unlockers.splice(at, 1);
    };
    const handler = () => {
      void this.resume().then(() => {
        if (this.deps.context.state === 'running') off();
      });
    };
    for (const name of events) target.addEventListener(name, handler);
    this.unlockers.push(off);
    return off;
  }

  private musicSink(): MusicSink<MusicId> {
    return {
      start: (slot, cue) => this.startMusicVoice(slot, cue),
      stop: (slot) => {
        const voice = this.musicVoices[slot];
        if (voice?.isPlaying) voice.stop();
      },
      setGain: (slot, gain) => {
        this.musicVoices[slot]?.setVolume(gain * this.musicVolume);
      },
    };
  }

  private startMusicVoice(slot: number, cue: MusicId): void {
    const voice = this.musicVoices[slot];
    const buffer = this.musicBuffers.get(cue);
    if (!voice || !buffer) return;
    if (voice.isPlaying) voice.stop();
    voice.setBuffer(buffer);
    voice.setLoop(true);
    voice.setVolume(0);
    voice.play();
  }

  /** Music requested before `load()` finished starts as soon as its buffer exists. */
  private startLoadedMusic(): void {
    for (let slot = 0; slot < MUSIC_SLOTS; slot++) {
      const cue = this.mixer.layerCue(slot);
      const voice = this.musicVoices[slot];
      if (cue && voice && !voice.isPlaying) this.startMusicVoice(slot, cue);
    }
    this.mixer.refresh();
  }
}
