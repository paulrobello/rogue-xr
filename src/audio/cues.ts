/**
 * Pure audio logic: the SFX registry, the game-state to music-cue mapping, the equal-power
 * crossfade mixer and the voice pool. No three.js and no Web Audio, so all of it is unit tested.
 * `director.ts` binds it to three.js.
 */
import type { EncounterPhase } from '../combat/encounter.ts';
import type { RoomKind } from '../content/rooms.ts';
import type { GamePhase } from '../core/state.ts';
import type { FlowPhase } from '../flow/flow.ts';
import type { RewardTier } from '../rules/run.ts';
import { type CombatEvent, PLAYER_ID } from '../rules/types.ts';

/** Where runtime files live, relative to the site base. Written by `scripts/assets/build_audio.py`. */
export const AUDIO_DIR = 'assets/audio';

export type SfxClass = 'positional' | 'ui';

export interface SfxDef {
  /** Path under `AUDIO_DIR`. */
  readonly file: string;
  /** `positional` cues are mono and spatialised, `ui` cues are stereo and flat. */
  readonly kind: SfxClass;
  /** Linear trim on top of the mastered level. 1 keeps the mastered level. */
  readonly gain: number;
  /** Retrigger guard in seconds: a play inside this window of the previous one is dropped. */
  readonly minGap: number;
  readonly loop: boolean;
}

function sfx(id: string, kind: SfxClass, minGap = 0, loop = false): SfxDef {
  return { file: `sfx/${id}.ogg`, kind, gain: 1, minGap, loop };
}

/** One entry per file in `public/assets/audio/sfx/`. */
export const SFX = {
  'card-draw': sfx('card-draw', 'positional', 0.05),
  'card-fling': sfx('card-fling', 'positional', 0.05),
  'card-impact': sfx('card-impact', 'positional', 0.05),
  'dice-roll': sfx('dice-roll', 'positional', 0.1),
  'dice-settle': sfx('dice-settle', 'positional', 0.05),
  'sigil-trace': sfx('sigil-trace', 'positional', 0, true),
  'sigil-cast': sfx('sigil-cast', 'positional', 0.1),
  'sigil-fizzle': sfx('sigil-fizzle', 'positional', 0.1),
  'steam-vent': sfx('steam-vent', 'positional', 0.1),
  'gear-clank': sfx('gear-clank', 'positional', 0.05),
  'door-open': sfx('door-open', 'positional', 0.2),
  'ui-tick': sfx('ui-tick', 'ui', 0.03),
  'automaton-hit': sfx('automaton-hit', 'positional', 0.05),
  'automaton-death': sfx('automaton-death', 'positional', 0.2),
  'table-unfold': sfx('table-unfold', 'positional', 0.2),
  'reward-chime': sfx('reward-chime', 'ui', 0.2),
  'defeat-sting': sfx('defeat-sting', 'ui', 0.5),
  'victory-sting': sfx('victory-sting', 'ui', 0.5),
  'cog-pickup': sfx('cog-pickup', 'positional', 0.03),
  'block-ward': sfx('block-ward', 'positional', 0.1),
} as const satisfies Record<string, SfxDef>;

export type SfxId = keyof typeof SFX;
export const SFX_IDS = Object.keys(SFX) as SfxId[];

/**
 * Run-outcome stingers, grouped by outcome. A fight's own stinger (the combat session) and the
 * flow's state stinger (`setState`) announce the same moment, so one family sounds at most once per
 * `STINGER_WINDOW`: whichever plays first wins and the other is dropped.
 */
export type StingerFamily = 'win' | 'loss';
export const STINGER_FAMILY: Readonly<Partial<Record<SfxId, StingerFamily>>> = {
  'victory-sting': 'win',
  'reward-chime': 'win',
  'defeat-sting': 'loss',
};
/** Seconds a stinger family stays claimed after one of its cues plays. */
export const STINGER_WINDOW = 3;

export interface MusicDef {
  /** Path under `AUDIO_DIR`. */
  readonly file: string;
  /** Loops forever when true; a one-shot plays once to its natural end. */
  readonly loop: boolean;
  /**
   * What plays while this cue's file is missing: the cue that covered the moment before this one
   * existed, at an absolute layer gain. Followed in a chain; silence when nothing in it loaded.
   */
  readonly fallback?: { readonly cue: string; readonly gain: number };
}

function music(id: string, loop: boolean, fallback?: MusicDef['fallback']): MusicDef {
  return { file: `music/${id}.ogg`, loop, ...(fallback ? { fallback } : {}) };
}

/**
 * Every music cue, in the order a player first hears it. Mirrors
 * `assets-source/audio/music/cues.json`, which the build and the Suno handoff read; a test keeps
 * the two in step.
 */
export const MUSIC = {
  title: music('title', true, { cue: 'explore', gain: 0.6 }),
  explore: music('explore', true),
  combat: music('combat', true),
  reward: music('reward', true, { cue: 'explore', gain: 0.5 }),
  rest: music('rest', true, { cue: 'explore', gain: 1 }),
  elite: music('elite', true, { cue: 'combat', gain: 1 }),
  defeat: music('defeat', false),
  workshop: music('workshop', true, { cue: 'explore', gain: 0.5 }),
  'guardian-1': music('guardian-1', true, { cue: 'combat', gain: 1 }),
  'guardian-2': music('guardian-2', true, { cue: 'guardian-1', gain: 1 }),
  victory: music('victory', false),
} as const satisfies Record<string, MusicDef>;

export type MusicId = keyof typeof MUSIC;
export const MUSIC_IDS = Object.keys(MUSIC) as MusicId[];
export const MUSIC_FILES = Object.fromEntries(MUSIC_IDS.map((id) => [id, MUSIC[id].file])) as {
  readonly [K in MusicId]: string;
};

/**
 * The cue and gain to play for `cue` given which files loaded: the cue itself when `available`,
 * else the first available cue down its fallback chain, else `cue` unchanged (it stays silent).
 */
export function resolveMusic(
  cue: MusicId,
  gain: number,
  available: (id: MusicId) => boolean,
): { cue: MusicId; gain: number } {
  let at: MusicId = cue;
  let atGain = gain;
  for (let hops = 0; hops <= MUSIC_IDS.length; hops++) {
    if (available(at)) return { cue: at, gain: atGain };
    const next: MusicDef['fallback'] = MUSIC[at].fallback;
    if (!next) break;
    at = next.cue as MusicId;
    atGain = next.gain;
  }
  return { cue, gain };
}

/** The audio-relevant game states. Defeat and victory are run-level and have no `GamePhase`. */
export type AudioState =
  | 'title'
  | 'workshop'
  | 'explore'
  | 'rest'
  | 'encounter-unfolding'
  | 'encounter-active'
  | 'elite-unfolding'
  | 'elite-active'
  | 'guardian-unfolding'
  | 'guardian-active'
  | 'encounter-folding'
  | 'reward'
  | 'defeat'
  | 'victory';

/** Where the player is, beyond the phase: the running fight's tier and the current room's role. */
export interface MusicScene {
  readonly tier?: RewardTier | null;
  readonly room?: RoomKind | null;
}

/** The guardian fight's phase: its case opens (phase 2) at a hit-point threshold. */
export type GuardianPhase = 1 | 2;

export type MusicDirective =
  | {
      readonly kind: 'play';
      readonly cue: MusicId;
      /** Layer gain, 0..1, relative to the mastered level. */
      readonly gain: number;
      /** Crossfade length in seconds. */
      readonly fadeSeconds: number;
      readonly stinger?: SfxId;
    }
  | { readonly kind: 'stop'; readonly fadeSeconds: number; readonly stinger?: SfxId }
  | { readonly kind: 'hold' };

const MUSIC_BY_STATE: Readonly<Record<AudioState, MusicDirective>> = {
  title: { kind: 'play', cue: 'title', gain: 1, fadeSeconds: 2.5 },
  workshop: { kind: 'play', cue: 'workshop', gain: 1, fadeSeconds: 2.0 },
  explore: { kind: 'play', cue: 'explore', gain: 1, fadeSeconds: 3.0 },
  rest: { kind: 'play', cue: 'rest', gain: 1, fadeSeconds: 3.0 },
  // The table unfolds in 0.6 s, so fight music comes in fast.
  'encounter-unfolding': { kind: 'play', cue: 'combat', gain: 1, fadeSeconds: 1.0 },
  'encounter-active': { kind: 'play', cue: 'combat', gain: 1, fadeSeconds: 0.5 },
  'elite-unfolding': { kind: 'play', cue: 'elite', gain: 1, fadeSeconds: 1.0 },
  'elite-active': { kind: 'play', cue: 'elite', gain: 1, fadeSeconds: 0.5 },
  'guardian-unfolding': { kind: 'play', cue: 'guardian-1', gain: 1, fadeSeconds: 1.0 },
  'guardian-active': { kind: 'play', cue: 'guardian-1', gain: 1, fadeSeconds: 0.5 },
  // Fight music rides through the fold; the next state (reward, explore, defeat) decides what follows.
  'encounter-folding': { kind: 'hold' },
  reward: { kind: 'play', cue: 'reward', gain: 0.8, fadeSeconds: 2.0, stinger: 'reward-chime' },
  defeat: { kind: 'play', cue: 'defeat', gain: 1, fadeSeconds: 1.5, stinger: 'defeat-sting' },
  victory: { kind: 'play', cue: 'victory', gain: 1, fadeSeconds: 2.0, stinger: 'victory-sting' },
};

/** The guardian's phase-2 cue, crossfaded in when its case opens. */
const GUARDIAN_PHASE_TWO: MusicDirective = {
  kind: 'play',
  cue: 'guardian-2',
  gain: 1,
  fadeSeconds: 1.5,
};

/** What the music bus does when the game enters `state`; `guardian` picks the guardian fight's cue. */
export function musicCueFor(state: AudioState, guardian: GuardianPhase = 1): MusicDirective {
  if (guardian === 2 && state === 'guardian-active') return GUARDIAN_PHASE_TWO;
  return MUSIC_BY_STATE[state];
}

/**
 * The audio state for the live game: a running encounter wins over the phase, because the
 * encounter director owns the unfold and fold timing and the phase machine may lag it. `scene`
 * picks the elite and guardian fight cues and the rest-room cue; without it every fight is a
 * regular one and every room plays the exploring cue.
 */
export function audioStateFor(
  phase: GamePhase,
  encounter: EncounterPhase,
  scene: MusicScene = {},
): AudioState {
  if (encounter === 'folding') return 'encounter-folding';
  if (encounter === 'unfolding' || encounter === 'active') {
    const step = encounter === 'unfolding' ? 'unfolding' : 'active';
    if (scene.tier === 'elite') return `elite-${step}`;
    if (scene.tier === 'guardian') return `guardian-${step}`;
    return `encounter-${step}`;
  }
  if (phase === 'title' || phase === 'workshop' || phase === 'reward') return phase;
  return scene.room === 'rest' ? 'rest' : 'explore';
}

/** The audio state for a flow screen: the run-end and settings screens, then `audioStateFor`. */
export function audioStateForFlow(
  phase: FlowPhase,
  encounter: EncounterPhase,
  scene: MusicScene = {},
): AudioState {
  if (phase === 'death') return 'defeat';
  if (phase === 'victory') return 'victory';
  if (phase === 'settings') return 'title';
  return audioStateFor(phase, encounter, scene);
}

/** The SFX for a rules event, or null when the event is silent or owned by the state cues. */
export function sfxForCombatEvent(event: CombatEvent): SfxId | null {
  switch (event.type) {
    case 'card-drawn':
      return 'card-draw';
    case 'card-played':
      return 'card-fling';
    case 'damage-dealt':
      if (event.target === PLAYER_ID) return 'gear-clank';
      return event.hpLost > 0 ? 'automaton-hit' : 'gear-clank';
    case 'block-gained':
      return 'block-ward';
    case 'steam-changed':
      return event.to < event.from ? 'steam-vent' : null;
    case 'enemy-phase':
      return 'door-open';
    case 'enemy-died':
      return 'automaton-death';
    default:
      return null;
  }
}

/** Equal-power crossfade gains for a linear fade position 0..1 (0 all outgoing, 1 all incoming). */
export function crossfadeGains(progress: number): { out: number; in: number } {
  const p = Math.min(1, Math.max(0, progress));
  return { out: Math.cos((p * Math.PI) / 2), in: Math.sin((p * Math.PI) / 2) };
}

/** Receives the mixer's decisions. The director implements it over three.js audio objects. */
export interface MusicSink<K extends string> {
  start(slot: number, cue: K): void;
  stop(slot: number): void;
  setGain(slot: number, gain: number): void;
}

interface Layer<K extends string> {
  cue: K;
  /** Linear envelope 0..1. Output gain is `gain * sin(env * pi/2)`, which keeps power constant across a crossfade. */
  env: number;
  envTarget: 0 | 1;
  envRate: number;
  gain: number;
  gainTarget: number;
  gainRate: number;
}

/**
 * Equal-power crossfading across a small pool of looping layers. `request` fades the current
 * layer out and the new one in over the same time. It never allocates after construction beyond
 * the layer records, and drives a sink, so it runs without Web Audio.
 */
export class MusicMixer<K extends string> {
  private readonly layers: (Layer<K> | null)[];

  constructor(
    private readonly sink: MusicSink<K>,
    slots = 3,
  ) {
    this.layers = new Array<Layer<K> | null>(slots).fill(null);
  }

  /** The cue fading in or holding, or null when music is stopped or fading out. */
  get current(): K | null {
    const slot = this.currentSlot();
    return slot < 0 ? null : (this.layers[slot]?.cue ?? null);
  }

  /** Live layer count, including layers still fading out. */
  get liveLayers(): number {
    return this.layers.filter((l) => l !== null).length;
  }

  /** Output gain of a slot right now, 0 when the slot is empty. */
  gainOf(slot: number): number {
    const l = this.layers[slot];
    return l ? l.gain * Math.sin((l.env * Math.PI) / 2) : 0;
  }

  /** The cue playing in a slot, or null when the slot is empty. */
  layerCue(slot: number): K | null {
    return this.layers[slot]?.cue ?? null;
  }

  /** Re-sends every live layer's gain to the sink, for when a bus volume changed. */
  refresh(): void {
    for (let i = 0; i < this.layers.length; i++) this.settle(i);
  }

  request(cue: K, gain: number, fadeSeconds: number): void {
    const rate = fadeSeconds > 0 ? 1 / fadeSeconds : Number.POSITIVE_INFINITY;
    const existing = this.layers.findIndex((l) => l !== null && l.cue === cue);
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      if (!l || i === existing) continue;
      l.envTarget = 0;
      l.envRate = rate;
    }
    if (existing >= 0) {
      const l = this.layers[existing] as Layer<K>;
      l.envTarget = 1;
      l.envRate = rate;
      this.retargetGain(l, gain, fadeSeconds);
      this.settle(existing);
      return;
    }
    let slot = this.layers.indexOf(null);
    if (slot < 0) slot = this.quietestSlot();
    if (this.layers[slot]) this.sink.stop(slot);
    this.layers[slot] = {
      cue,
      env: 0,
      envTarget: 1,
      envRate: rate,
      gain,
      gainTarget: gain,
      gainRate: 0,
    };
    this.sink.start(slot, cue);
    this.settle(slot);
  }

  /** Fades every layer out. */
  stop(fadeSeconds: number): void {
    const rate = fadeSeconds > 0 ? 1 / fadeSeconds : Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      if (!l) continue;
      l.envTarget = 0;
      l.envRate = rate;
      this.settle(i);
    }
  }

  update(dt: number): void {
    if (!(dt > 0)) return;
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      if (!l) continue;
      l.env = approach(l.env, l.envTarget, l.envRate * dt);
      l.gain = approach(l.gain, l.gainTarget, l.gainRate * dt);
      this.settle(i);
    }
  }

  private currentSlot(): number {
    for (let i = 0; i < this.layers.length; i++) {
      if (this.layers[i]?.envTarget === 1) return i;
    }
    return -1;
  }

  private quietestSlot(): number {
    let best = 0;
    let bestGain = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.layers.length; i++) {
      const g = this.gainOf(i);
      if (g < bestGain) {
        best = i;
        bestGain = g;
      }
    }
    return best;
  }

  private retargetGain(l: Layer<K>, gain: number, fadeSeconds: number): void {
    l.gainTarget = gain;
    l.gainRate = fadeSeconds > 0 ? Math.abs(gain - l.gain) / fadeSeconds : Number.POSITIVE_INFINITY;
  }

  private settle(slot: number): void {
    const l = this.layers[slot];
    if (!l) return;
    if (!Number.isFinite(l.envRate)) l.env = l.envTarget;
    if (!Number.isFinite(l.gainRate)) l.gain = l.gainTarget;
    if (l.envTarget === 0 && l.env <= 0) {
      this.layers[slot] = null;
      this.sink.stop(slot);
      return;
    }
    this.sink.setGain(slot, l.gain * Math.sin((l.env * Math.PI) / 2));
  }
}

function approach(value: number, target: number, step: number): number {
  if (value < target) return Math.min(target, value + step);
  return Math.max(target, value - step);
}

/** A voice the pool can start and stop. three.js `Audio` and `PositionalAudio` satisfy it. */
export interface PoolVoice {
  readonly isPlaying: boolean;
  stop(): unknown;
}

export interface Acquired<T> {
  readonly voice: T;
  /** True when every voice was busy and the oldest was cut off. */
  readonly stolen: boolean;
}

/**
 * Fixed-size voice pool. Voices are created once by the caller. `acquire` returns an idle voice,
 * or steals the oldest busy one when all are playing, so a burst never grows the pool.
 */
export class VoicePool<T extends PoolVoice> {
  private readonly started: number[];
  private counter = 0;

  constructor(readonly voices: readonly T[]) {
    this.started = voices.map(() => 0);
  }

  get capacity(): number {
    return this.voices.length;
  }

  get busy(): number {
    let n = 0;
    for (const v of this.voices) if (v.isPlaying) n++;
    return n;
  }

  acquire(): Acquired<T> | null {
    if (this.voices.length === 0) return null;
    let pick = -1;
    for (let i = 0; i < this.voices.length; i++) {
      if (!this.voices[i].isPlaying && (pick < 0 || this.started[i] < this.started[pick])) pick = i;
    }
    let stolen = false;
    if (pick < 0) {
      stolen = true;
      pick = 0;
      for (let i = 1; i < this.voices.length; i++) {
        if (this.started[i] < this.started[pick]) pick = i;
      }
      this.voices[pick].stop();
    }
    this.started[pick] = ++this.counter;
    return { voice: this.voices[pick], stolen };
  }

  stopAll(): void {
    for (const v of this.voices) if (v.isPlaying) v.stop();
  }
}
