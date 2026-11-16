import * as THREE from 'three';
import type { EncounterPhase } from '../combat/encounter.ts';
import type { GamePhase } from '../core/state.ts';
import type { CombatEvent } from '../rules/types.ts';
import {
  AUDIO_DIR,
  type AudioState,
  audioStateFor,
  type GuardianPhase,
  MUSIC,
  MUSIC_FILES,
  MUSIC_PRELOAD,
  type MusicDirective,
  type MusicId,
  MusicMixer,
  type MusicScene,
  type MusicSink,
  musicChain,
  musicCueFor,
  musicKeepSet,
  type PoolVoice,
  resolveMusic,
  SFX,
  SFX_IDS,
  type SfxId,
  STINGER_FAMILY,
  STINGER_WINDOW,
  type StingerFamily,
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
  setBuffer(buffer: AudioBuffer | null): unknown;
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

/**
 * `renderer.xr` (a `WebXRManager`): fires `sessionstart`/`sessionend` and hands out the live
 * `XRSession`, whose controller `select`/`squeeze` events are the only input inside immersive mode.
 */
export interface SessionEvents {
  addEventListener(type: 'sessionstart' | 'sessionend', listener: () => void): unknown;
  removeEventListener(type: 'sessionstart' | 'sessionend', listener: () => void): unknown;
  getSession?(): ListenerTarget | null;
}

/** The slice of `AudioContext` the director uses. */
export interface ContextLike {
  readonly state: string;
  resume(): Promise<void> | void;
  addEventListener?(type: 'statechange', listener: () => void): unknown;
  removeEventListener?(type: 'statechange', listener: () => void): unknown;
}

/** One line of the unlock history: a resume attempt and how it ended, or a context state change. */
export interface UnlockEntry {
  /** Seconds, from the director's clock. */
  readonly at: number;
  /** The event or caller that asked (`click`, `select`, `enter-vr`, `statechange`, ...). */
  readonly source: string;
  /** Context state when the entry was written. */
  readonly state: string;
  readonly outcome: 'attempt' | 'resolved' | 'rejected' | 'state';
  /** Error name of a rejected or throwing `resume()`. */
  readonly error?: string;
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
  readonly context: ContextLike;
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

/** What `load()` fetched. Music is not in it: music cues load on demand as states ask for them. */
export interface LoadReport {
  readonly loaded: readonly string[];
  readonly missing: readonly string[];
}

const MUSIC_SLOTS = 3;
/** Crossfade, in seconds, when loading finds the requested cue missing and moves to its fallback. */
const LATE_MUSIC_FADE = 0.5;
// `pointerup` is the activation event for touch and pen pointers, `pointerdown` only for a mouse.
const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'keydown', 'touchend', 'click'] as const;
/** XRSession controller events: window pointer and key events do not fire inside immersive mode. */
const XR_INPUT_EVENTS = ['selectstart', 'select', 'squeezestart', 'squeeze'] as const;
const UNLOCK_LOG_SIZE = 16;

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) return String(error.name);
  return String(error);
}

function joinUrl(base: string, ...parts: string[]): string {
  const root = base.endsWith('/') ? base : `${base}/`;
  return root + parts.join('/');
}

/**
 * Plays the game's music and SFX. Voices are created once and reused (a burst steals the oldest
 * voice rather than allocating), music crossfades equal-power across looping layers, and a missing
 * or undecodable file leaves that cue silent and logs once. SFX decode in `load()`. Music decodes
 * on demand: a state's cue loads when first requested (its fallback plays meanwhile), the cue
 * most likely to follow loads once the current one plays, and a cue nothing needs is freed, so
 * decoded music stays at the playing cue, its fallbacks and one preload. Construct it once, add `root` to the
 * scene, call `load()`, drive it with `setState`/`syncGame`/`playSfx`, call `update(dt)` each frame
 * and `unlockOnGesture` / `unlockOnXrSession` so the context resumes on input. Those stay armed for
 * the session: the platform can suspend a running context again (entering immersive, the system
 * menu, proximity sleep), and every later gesture, controller trigger or state change retries.
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
  private readonly musicPending = new Set<MusicId>();
  private readonly musicMissing = new Set<MusicId>();
  /** The buffer each music voice holds, so freeing a cue also lets go of a voice that played it. */
  private readonly slotBuffers: (AudioBuffer | null)[] = new Array<AudioBuffer | null>(
    MUSIC_SLOTS,
  ).fill(null);
  private liveLayers = 0;
  /** The cue and gain last sent to the mixer, or null after a stop. */
  private musicSent: { cue: MusicId; gain: number } | null = null;
  private readonly lastPlayed = new Map<SfxId, number>();
  private readonly lastStinger = new Map<StingerFamily, number>();
  private readonly unlockers: (() => void)[] = [];
  private readonly unlockEntries: UnlockEntry[] = [];
  /** True once the context has run: a later drop out of `running` is the platform's, so retry. */
  private hasRun: boolean;
  private stateValue: AudioState | null = null;
  /** The cue the current state asks for, before falling back to what loaded. */
  private musicWant: { cue: MusicId; gain: number; fade: number } | null = null;
  private guardianPhase: GuardianPhase = 1;
  private sfxVolume = 1;
  private musicVolume = 1;
  private disposed = false;

  constructor(options: AudioDirectorOptions) {
    const deps = options.deps ?? (options.camera ? createThreeDeps(options.camera) : null);
    if (!deps) throw new Error('AudioDirector needs a camera or deps');
    this.deps = deps;
    this.hasRun = deps.context.state === 'running';
    const context = deps.context;
    if (context.addEventListener && context.removeEventListener) {
      const onState = () => this.onContextState();
      context.addEventListener('statechange', onState);
      this.unlockers.push(() => context.removeEventListener?.('statechange', onState));
    }
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

  /** The music cue fading in or holding (after any fallback), or null. */
  get musicCue(): MusicId | null {
    return this.mixer.current;
  }

  /** The cue the current state asks for, whether or not its file loaded, or null. */
  get musicRequest(): MusicId | null {
    return this.musicWant?.cue ?? null;
  }

  /** The music cues whose decoded audio the director holds in its cache. */
  get decodedMusic(): MusicId[] {
    return [...this.musicBuffers.keys()];
  }

  /** Bytes of decoded music held: the cache plus any buffer a music voice still references. */
  get decodedMusicBytes(): number {
    const held = new Set<AudioBuffer>(this.musicBuffers.values());
    for (const buffer of this.slotBuffers) if (buffer) held.add(buffer);
    let bytes = 0;
    for (const b of held) bytes += b.length * b.numberOfChannels * 4;
    return bytes;
  }

  /** The audio context's state: `running` plays, anything else is silent. */
  get contextState(): string {
    return this.deps.context.state;
  }

  /** The last unlock attempts and context state changes, oldest first (at most 16). */
  get unlockLog(): readonly UnlockEntry[] {
    return [...this.unlockEntries];
  }

  /** One line for the debug readout: the context state and the last three unlock entries. */
  get statusLine(): string {
    const recent = this.unlockEntries
      .slice(-3)
      .map(
        (e) =>
          `${e.source} ${e.outcome === 'state' ? e.state : e.outcome}${e.error ? ` ${e.error}` : ''}`,
      );
    return `audio ${this.deps.context.state}${recent.length > 0 ? ` · ${recent.join(' · ')}` : ''}`;
  }

  get spatialPool(): VoicePool<SpatialVoice> {
    return this.spatial;
  }

  get flatPool(): VoicePool<FlatVoice> {
    return this.flat;
  }

  /**
   * Fetches and decodes every SFX file. A missing or broken file is skipped: that cue stays
   * silent, and one warning names what is missing. Music is not loaded here (see the class doc).
   */
  async load(): Promise<LoadReport> {
    const loaded: string[] = [];
    const missing: string[] = [];
    await Promise.all(
      SFX_IDS.map(
        (id) =>
          new Promise<void>((resolve) => {
            this.deps.loader.load(
              joinUrl(this.baseUrl, AUDIO_DIR, SFX[id].file),
              (buffer) => {
                if (!this.disposed) this.sfxBuffers.set(id, buffer);
                loaded.push(id);
                resolve();
              },
              undefined,
              () => {
                missing.push(id);
                resolve();
              },
            );
          }),
      ),
    );
    if (missing.length > 0) {
      this.warn(
        `[audio] ${missing.length} SFX not found (${missing.join(', ')}): those cues stay silent`,
      );
    }
    return { loaded, missing };
  }

  /** Moves the music bus to the cue for `state` and plays that state's stinger. Idempotent per state. */
  setState(state: AudioState): void {
    if (this.disposed || state === this.stateValue) return;
    this.stateValue = state;
    // A guardian fight starts closed; only its own active state and the fold keep the open case.
    if (state !== 'guardian-active' && state !== 'encounter-folding') this.guardianPhase = 1;
    const directive = musicCueFor(state, this.guardianPhase);
    this.applyMusic(directive);
    if (directive.kind !== 'hold' && directive.stinger) this.playSfx(directive.stinger);
  }

  /** Derives the audio state from the game phase and the encounter phase. Call it every frame; it only acts on change. */
  syncGame(phase: GamePhase, encounter: EncounterPhase, scene: MusicScene = {}): void {
    this.setState(audioStateFor(phase, encounter, scene));
  }

  /**
   * Plays an SFX. Positional cues with `at` are spatialised from that world point, everything else
   * plays flat. Returns false when the cue was dropped: missing file, context not running,
   * retrigger guard, a stinger of the same outcome family playing within `STINGER_WINDOW`, or the
   * director is disposed.
   */
  playSfx(id: SfxId, at?: Vec3Like, volume = 1): boolean {
    const def = SFX[id];
    const buffer = this.sfxBuffers.get(id);
    if (this.disposed || !buffer || def.loop || this.deps.context.state !== 'running') return false;
    const now = this.now();
    const last = this.lastPlayed.get(id);
    if (last !== undefined && now - last < def.minGap) return false;
    const family = STINGER_FAMILY[id];
    const lastInFamily = family === undefined ? undefined : this.lastStinger.get(family);
    if (lastInFamily !== undefined && now - lastInFamily < STINGER_WINDOW) return false;
    const spatial = def.kind === 'positional' && at !== undefined;
    const acquired = spatial ? this.spatial.acquire() : this.flat.acquire();
    if (!acquired) return false;
    this.lastPlayed.set(id, now);
    if (family !== undefined) this.lastStinger.set(family, now);
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
    if (event.type === 'enemy-phase') this.openGuardianCase();
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
    if (this.disposed) return;
    this.mixer.update(dt);
    // A layer finishing its fade frees its cue and lets the next preload start.
    if (this.mixer.liveLayers !== this.liveLayers) this.pumpMusic();
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

  /**
   * Resumes a context that is not running. `resume()` is called before this returns, so a caller
   * inside a user-activation handler (the Enter VR click, before `requestSession`) spends that
   * activation on it. Every attempt and its outcome lands in `unlockLog`.
   */
  unlock(source: string): void {
    const context = this.deps.context;
    if (this.disposed || context.state === 'running' || context.state === 'closed') return;
    let pending: Promise<void> | void;
    try {
      pending = context.resume();
    } catch (error) {
      this.record(source, 'rejected', error);
      return;
    }
    this.record(source, 'attempt');
    if (pending && typeof pending.then === 'function') {
      pending.then(
        () => {
          if (this.deps.context.state === 'running') this.hasRun = true;
          this.record(source, 'resolved');
        },
        (error: unknown) => this.record(source, 'rejected', error),
      );
    }
  }

  /** Resumes the context on user input on `target`, for the whole session. Returns a function that disarms it. */
  unlockOnGesture(target: ListenerTarget, events: readonly string[] = UNLOCK_EVENTS): () => void {
    return this.arm(target, events);
  }

  /**
   * Resumes the context when an immersive session starts, then on every controller trigger and
   * squeeze in it: window pointer and key events do not fire inside immersive mode.
   */
  unlockOnXrSession(xr: SessionEvents): () => void {
    let offInput: (() => void) | null = null;
    const onEnd = () => {
      offInput?.();
      offInput = null;
    };
    const onStart = () => {
      this.unlock('sessionstart');
      onEnd();
      const session = xr.getSession?.();
      if (session) offInput = this.arm(session, XR_INPUT_EVENTS);
    };
    xr.addEventListener('sessionstart', onStart);
    xr.addEventListener('sessionend', onEnd);
    const off = () => {
      xr.removeEventListener('sessionstart', onStart);
      xr.removeEventListener('sessionend', onEnd);
      onEnd();
      const at = this.unlockers.indexOf(off);
      if (at >= 0) this.unlockers.splice(at, 1);
    };
    this.unlockers.push(off);
    return off;
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
    this.musicPending.clear();
    this.slotBuffers.fill(null);
    this.lastPlayed.clear();
    this.lastStinger.clear();
    this.deps.dispose?.();
  }

  /** The guardian's case opened (rules `enemy-phase`): the guardian fight moves to its phase-2 cue. */
  private openGuardianCase(): void {
    if (this.disposed || this.guardianPhase === 2) return;
    this.guardianPhase = 2;
    if (this.stateValue === 'guardian-active') this.applyMusic(musicCueFor('guardian-active', 2));
  }

  private applyMusic(directive: MusicDirective): void {
    if (directive.kind === 'hold') return;
    if (directive.kind === 'stop') {
      this.musicWant = null;
      this.musicSent = null;
      this.mixer.stop(directive.fadeSeconds);
      this.pumpMusic();
      return;
    }
    this.musicWant = { cue: directive.cue, gain: directive.gain, fade: directive.fadeSeconds };
    this.loadWanted();
    this.playWanted(directive.fadeSeconds, false);
    this.pumpMusic();
  }

  /** Starts decoding the wanted cue, or the next one down its fallback chain when a file is missing. */
  private loadWanted(): void {
    if (!this.musicWant) return;
    for (const cue of musicChain(this.musicWant.cue)) {
      if (this.musicBuffers.has(cue) || this.musicPending.has(cue)) return;
      if (this.musicMissing.has(cue)) continue;
      this.fetchMusic(cue);
      if (this.musicBuffers.has(cue) || this.musicPending.has(cue)) return;
    }
  }

  private fetchMusic(cue: MusicId): void {
    this.musicPending.add(cue);
    let sync = true;
    this.deps.loader.load(
      joinUrl(this.baseUrl, AUDIO_DIR, MUSIC_FILES[cue]),
      (buffer) => {
        this.musicPending.delete(cue);
        if (this.disposed) return;
        this.musicBuffers.set(cue, buffer);
        if (!sync) this.onMusicSettled();
      },
      undefined,
      () => {
        this.musicPending.delete(cue);
        if (this.disposed) return;
        this.musicMissing.add(cue);
        this.warn(
          `[audio] music not found (${cue}): plays its fallback cue when that loaded, otherwise silence`,
        );
        if (!sync) this.onMusicSettled();
      },
    );
    sync = false;
  }

  /** A cue finished decoding or failed after `setState` returned: re-resolve the request against what is there. */
  private onMusicSettled(): void {
    this.loadWanted();
    this.playWanted(LATE_MUSIC_FADE, true);
    this.pumpMusic();
  }

  /**
   * Sends the first cue down the wanted cue's chain whose file exists to the mixer. While that cue
   * is still decoding, the cue already playing keeps playing, so a state change never fades to
   * silence and never holds a second cue in memory just to cover the decode. A cue whose file is
   * absent is skipped to its fallback, at the fallback's gain. `late` marks a re-resolve after a
   * load: it leaves a running fade alone unless the cue or gain it resolves to changed.
   */
  private playWanted(fade: number, late: boolean): void {
    const want = this.musicWant;
    if (!want) return;
    const play = resolveMusic(want.cue, want.gain, (id) => !this.musicMissing.has(id));
    if (
      !this.musicBuffers.has(play.cue) &&
      this.musicPending.has(play.cue) &&
      this.mixer.current !== null
    ) {
      return;
    }
    const sent = this.musicSent;
    if (!late || !sent || sent.cue !== play.cue || sent.gain !== play.gain) {
      this.mixer.request(play.cue, play.gain, fade);
      this.musicSent = play;
    }
    for (let slot = 0; slot < MUSIC_SLOTS; slot++) {
      const cue = this.mixer.layerCue(slot);
      const voice = this.musicVoices[slot];
      if (cue && voice && !voice.isPlaying) this.startMusicVoice(slot, cue);
    }
    this.mixer.refresh();
  }

  /**
   * Once the wanted cue plays and no crossfade is running, decodes the cues likely to follow it,
   * then frees every decoded cue that is neither wanted, a fallback in use, a preload target nor
   * still playing.
   */
  private pumpMusic(): void {
    if (this.disposed) return;
    this.liveLayers = this.mixer.liveLayers;
    const want = this.musicWant;
    if (want && this.musicBuffers.has(want.cue) && this.liveLayers <= 1) {
      for (const next of MUSIC_PRELOAD[want.cue]) {
        if (
          !this.musicBuffers.has(next) &&
          !this.musicPending.has(next) &&
          !this.musicMissing.has(next)
        ) {
          this.fetchMusic(next);
        }
      }
    }
    const playing: MusicId[] = [];
    for (let slot = 0; slot < MUSIC_SLOTS; slot++) {
      const cue = this.mixer.layerCue(slot);
      if (cue) playing.push(cue);
    }
    const keep = musicKeepSet(want?.cue ?? null, (id) => this.musicMissing.has(id), playing);
    for (const cue of [...this.musicBuffers.keys()]) {
      if (!keep.has(cue)) this.musicBuffers.delete(cue);
    }
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
    const handlers = events.map((name) => [name, () => this.unlock(name)] as const);
    for (const [name, handler] of handlers) target.addEventListener(name, handler);
    const off = () => {
      for (const [name, handler] of handlers) target.removeEventListener(name, handler);
      const at = this.unlockers.indexOf(off);
      if (at >= 0) this.unlockers.splice(at, 1);
    };
    this.unlockers.push(off);
    return off;
  }

  private onContextState(): void {
    if (this.disposed) return;
    const state = this.deps.context.state;
    this.record('statechange', 'state');
    if (state === 'running') {
      this.hasRun = true;
      return;
    }
    // The page was activated once, so a resume without a fresh gesture can succeed; if it cannot,
    // the next gesture or controller trigger retries.
    if (this.hasRun) this.unlock('statechange');
  }

  private record(source: string, outcome: UnlockEntry['outcome'], error?: unknown): void {
    if (this.disposed) return;
    const state = this.deps.context.state;
    const entry: UnlockEntry =
      error === undefined
        ? { at: this.now(), source, state, outcome }
        : { at: this.now(), source, state, outcome, error: errorName(error) };
    this.unlockEntries.push(entry);
    if (this.unlockEntries.length > UNLOCK_LOG_SIZE) this.unlockEntries.shift();
  }

  private musicSink(): MusicSink<MusicId> {
    return {
      start: (slot, cue) => this.startMusicVoice(slot, cue),
      stop: (slot) => {
        const voice = this.musicVoices[slot];
        if (voice?.isPlaying) voice.stop();
        if (this.slotBuffers[slot]) {
          voice?.setBuffer(null);
          this.slotBuffers[slot] = null;
        }
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
    this.slotBuffers[slot] = buffer;
    voice.setLoop(MUSIC[cue].loop);
    voice.setVolume(0);
    voice.play();
  }
}
