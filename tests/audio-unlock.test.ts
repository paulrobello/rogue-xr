import { describe, expect, it, vi } from 'vitest';
import {
  type AudioDeps,
  AudioDirector,
  type FlatVoice,
  type SpatialVoice,
} from '../src/audio/index.ts';

class FakeVoice implements SpatialVoice {
  isPlaying = false;
  readonly position = { set: () => undefined };
  updateMatrixWorld(): void {}
  setBuffer(): void {}
  setVolume(): void {}
  setLoop(): void {}
  play(): void {
    this.isPlaying = true;
  }
  stop(): void {
    this.isPlaying = false;
  }
}

/** An `AudioContext` stand-in: `resume()` settles as the test says and fires `statechange`. */
class FakeContext extends EventTarget {
  state = 'suspended';
  /** What the next `resume()` does: run the context, stay pending, or reject. */
  mode: 'run' | 'pending' | 'reject' = 'run';
  readonly resume = vi.fn((): Promise<void> => {
    if (this.mode === 'reject') {
      return Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
    }
    if (this.mode === 'pending') return new Promise<void>(() => undefined);
    return Promise.resolve().then(() => this.set('running'));
  });
  set(state: string): void {
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

/** `renderer.xr`: fires `sessionstart`/`sessionend` and hands out the live session. */
class FakeXr extends EventTarget {
  session: EventTarget | null = null;
  getSession(): EventTarget | null {
    return this.session;
  }
  start(): EventTarget {
    this.session = new EventTarget();
    this.dispatchEvent(new Event('sessionstart'));
    return this.session;
  }
  end(): void {
    this.dispatchEvent(new Event('sessionend'));
    this.session = null;
  }
}

function setup() {
  const context = new FakeContext();
  const deps: AudioDeps = {
    context,
    loader: { load: (_url, onLoad) => onLoad({ length: 1, numberOfChannels: 1 } as AudioBuffer) },
    createSpatial: () => new FakeVoice(),
    createFlat: (): FlatVoice => new FakeVoice(),
    setMasterVolume: () => undefined,
  };
  const director = new AudioDirector({ deps, baseUrl: '/', now: () => 0, warn: () => undefined });
  return { context, director };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('audio unlock (H7: silent in the Quest headset)', () => {
  it('calls resume() before unlock() returns, so it runs inside the click that enters VR', () => {
    const { context, director } = setup();
    director.unlock('enter-vr');
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it('does not call resume() when the context already runs', async () => {
    const { context, director } = setup();
    context.set('running');
    director.unlock('enter-vr');
    expect(context.resume).not.toHaveBeenCalled();
  });

  it('resumes on pointerup, the activation event for non-mouse pointers', () => {
    const { context, director } = setup();
    const target = new EventTarget();
    director.unlockOnGesture(target);
    target.dispatchEvent(new Event('pointerup'));
    expect(context.resume).toHaveBeenCalledTimes(1);
  });

  it('recovers a context suspended after it first ran, on the next gesture', async () => {
    const { context, director } = setup();
    const target = new EventTarget();
    director.unlockOnGesture(target);
    target.dispatchEvent(new Event('click'));
    await flush();
    expect(context.state).toBe('running');
    // Entering immersive, the Meta menu or proximity sleep suspends the context.
    context.mode = 'pending';
    context.set('suspended');
    context.mode = 'run';
    target.dispatchEvent(new Event('click'));
    await flush();
    expect(context.state).toBe('running');
    expect(director.contextState).toBe('running');
  });

  it('retries resume() when the context drops out of running after it ran', async () => {
    const { context, director } = setup();
    director.unlock('enter-vr');
    await flush();
    expect(context.resume).toHaveBeenCalledTimes(1);
    context.set('suspended');
    expect(context.resume).toHaveBeenCalledTimes(2);
    await flush();
    expect(context.state).toBe('running');
  });

  it('resumes on the controller trigger inside the immersive session, and lets go at session end', async () => {
    const { context, director } = setup();
    const xr = new FakeXr();
    context.mode = 'pending';
    director.unlockOnXrSession(xr);
    const session = xr.start();
    expect(context.resume).toHaveBeenCalledTimes(1);
    context.mode = 'run';
    session.dispatchEvent(new Event('select'));
    expect(context.resume).toHaveBeenCalledTimes(2);
    await flush();
    expect(context.state).toBe('running');
    // A later suspension inside VR: the squeeze resumes it again.
    context.mode = 'pending';
    context.set('suspended');
    context.mode = 'run';
    session.dispatchEvent(new Event('squeezestart'));
    await flush();
    expect(context.state).toBe('running');

    xr.end();
    context.mode = 'pending';
    context.set('suspended');
    const calls = context.resume.mock.calls.length;
    session.dispatchEvent(new Event('select'));
    expect(context.resume).toHaveBeenCalledTimes(calls);
  });

  it('records a rejected resume in the status log and keeps listening', async () => {
    const { context, director } = setup();
    const target = new EventTarget();
    director.unlockOnGesture(target);
    context.mode = 'reject';
    target.dispatchEvent(new Event('pointerdown'));
    await flush();
    const last = director.unlockLog.at(-1);
    expect(last?.source).toBe('pointerdown');
    expect(last?.outcome).toBe('rejected');
    expect(last?.error).toBe('NotAllowedError');
    expect(director.statusLine).toContain('NotAllowedError');
    context.mode = 'run';
    target.dispatchEvent(new Event('click'));
    await flush();
    expect(context.state).toBe('running');
    expect(director.statusLine).toMatch(/^audio running/);
  });

  it('logs every context state change and keeps the log bounded', async () => {
    const { context, director } = setup();
    director.unlock('enter-vr');
    await flush();
    expect(director.unlockLog.some((e) => e.outcome === 'state' && e.state === 'running')).toBe(
      true,
    );
    for (let i = 0; i < 40; i++) {
      context.mode = 'pending';
      context.set(i % 2 === 0 ? 'suspended' : 'running');
    }
    expect(director.unlockLog.length).toBeLessThanOrEqual(16);
  });

  it('removes every listener on dispose', async () => {
    const { context, director } = setup();
    const target = new EventTarget();
    const xr = new FakeXr();
    director.unlockOnGesture(target);
    director.unlockOnXrSession(xr);
    const session = xr.start();
    director.dispose();
    const calls = context.resume.mock.calls.length;
    target.dispatchEvent(new Event('click'));
    session.dispatchEvent(new Event('select'));
    xr.dispatchEvent(new Event('sessionstart'));
    context.set('interrupted');
    expect(context.resume).toHaveBeenCalledTimes(calls);
  });
});
