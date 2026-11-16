import { computePeaks, estimateLufs, samplePeak } from './loudness.ts';

const PEAK_COLUMNS = 720;

export interface Clip {
  buffer: AudioBuffer;
  peak: number;
  peaks: Float32Array;
  /** K-weighted loudness estimated from the decoded samples, computed on first use. */
  estimatedLufs(): number | null;
}

interface Voice {
  key: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
  analyser: AnalyserNode;
  startedAt: number;
  duration: number;
}

export type EngineStatus = 'idle' | AudioContextState;

/** One shared audio context and at most one playing clip, so two sounds never overlap. */
export class AuditionEngine {
  private ctx: AudioContext | null = null;
  private readonly clips = new Map<string, Promise<Clip>>();
  private voice: Voice | null = null;
  private readonly scratch = new Float32Array(1024);

  /** Called when a clip stops by itself or is replaced, with its key. */
  onStop: (key: string) => void = () => {};
  onStatus: (status: EngineStatus) => void = () => {};

  get status(): EngineStatus {
    return this.ctx?.state ?? 'idle';
  }

  get playingKey(): string | null {
    return this.voice?.key ?? null;
  }

  /** Create the context. Call inside the click handler so the browser lets it run. */
  private context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx.addEventListener('statechange', () => this.onStatus(this.status));
      this.onStatus(this.status);
    }
    return this.ctx;
  }

  /** Start or resume the context synchronously from a user gesture. */
  unlock(): Promise<void> {
    return this.context().resume();
  }

  load(url: string): Promise<Clip> {
    let pending = this.clips.get(url);
    if (!pending) {
      pending = this.decode(url);
      this.clips.set(url, pending);
      pending.catch(() => this.clips.delete(url));
    }
    return pending;
  }

  private async decode(url: string): Promise<Clip> {
    const ctx = this.context();
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) =>
      buffer.getChannelData(i),
    );
    let lufs: number | null | undefined;
    return {
      buffer,
      peak: samplePeak(channels),
      peaks: computePeaks(channels, PEAK_COLUMNS),
      estimatedLufs: () => {
        if (lufs === undefined) lufs = estimateLufs(channels, buffer.sampleRate);
        return lufs;
      },
    };
  }

  play(key: string, clip: Clip, options: { loop: boolean; gain: number }): void {
    this.stop();
    const ctx = this.context();
    const source = ctx.createBufferSource();
    source.buffer = clip.buffer;
    source.loop = options.loop;
    const gain = ctx.createGain();
    gain.gain.value = options.gain;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(gain).connect(analyser).connect(ctx.destination);
    const voice: Voice = {
      key,
      source,
      gain,
      analyser,
      startedAt: ctx.currentTime,
      duration: clip.buffer.duration,
    };
    source.onended = () => {
      if (this.voice === voice) {
        this.voice = null;
        this.onStop(key);
      }
    };
    this.voice = voice;
    source.start();
  }

  stop(): void {
    const voice = this.voice;
    if (!voice) return;
    this.voice = null;
    voice.source.onended = null;
    try {
      voice.source.stop();
    } catch {
      // Already stopped.
    }
    voice.source.disconnect();
    this.onStop(voice.key);
  }

  setLoop(loop: boolean): void {
    if (this.voice) this.voice.source.loop = loop;
  }

  /** Move the gain smoothly so toggling "Match loudness" mid-sound does not click. */
  setGain(gain: number): void {
    if (this.voice && this.ctx) {
      this.voice.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.01);
    }
  }

  /** Playback position as a 0..1 fraction of the clip, and the live peak level (linear). */
  sample(): { fraction: number; peak: number } | null {
    const voice = this.voice;
    if (!voice || !this.ctx) return null;
    const elapsed = this.ctx.currentTime - voice.startedAt;
    const fraction = voice.source.loop
      ? (elapsed % voice.duration) / voice.duration
      : Math.min(1, elapsed / voice.duration);
    voice.analyser.getFloatTimeDomainData(this.scratch);
    let peak = 0;
    for (const v of this.scratch) peak = Math.max(peak, Math.abs(v));
    return { fraction, peak };
  }
}
