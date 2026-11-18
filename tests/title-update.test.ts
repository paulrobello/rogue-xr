import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STARTER_DECK } from '../src/content/cards.ts';
import { REWARD_POOL } from '../src/content/rewards.ts';
import { RunFlow } from '../src/flow/flow.ts';
import { FlowUi, type TitleUpdate } from '../src/flow/panels.ts';
import { DEFAULT_SETTINGS } from '../src/persist/db.ts';
import { createWorkshop } from '../src/rules/workshop.ts';
import { mountUpdateNotice } from '../src/update/index.ts';
import { createUpdateState } from '../src/update/state.ts';

const RUNNING = 'a'.repeat(64);
const NEWER = 'b'.repeat(64);
const NEWEST = 'c'.repeat(64);
const SEED = 'BRASS042';

function rig(update: TitleUpdate) {
  const flow = new RunFlow({
    workshop: createWorkshop(),
    starterDeck: STARTER_DECK,
    rewardPool: REWARD_POOL,
  });
  const ui = new FlowUi({
    flow,
    keyArt: { url: '', titleSafe: { x: 0, y: 0, w: 0.3, h: 0.4 } },
    seed: SEED,
    snapshot: () => null,
    settings: () => ({ ...DEFAULT_SETTINGS }),
    onNewRun: (seed) => flow.newRun(seed),
    onContinue: () => {},
    onSettings: () => {},
    rewardCards: { art: null, loadArt: false, syncLabels: false },
    update,
  });
  const head = new THREE.Object3D();
  head.position.set(0, 1.6, 0);
  return { flow, ui, head };
}

describe('update state', () => {
  it('keeps a deferred build available while Later hides the notice until a newer one', () => {
    const state = createUpdateState();
    const changes = vi.fn();
    state.onChange(changes);
    expect(state.available).toBe(false);
    state.report({ buildId: NEWER });
    expect([state.available, state.noticeWanted]).toEqual([true, true]);
    state.later();
    expect([state.available, state.noticeWanted]).toEqual([true, false]);
    state.report({ buildId: NEWEST });
    expect(state.noticeWanted).toBe(true);
    state.report(null);
    expect([state.available, state.noticeWanted]).toEqual([false, false]);
    expect(changes).toHaveBeenCalledTimes(4);
  });
});

describe('title reload after a deferred update (playtest card D)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.head.innerHTML = '';
    document.body.innerHTML = '';
  });

  const stage = () => {
    const renderer = {
      xr: {
        isPresenting: false,
        getController: () => new THREE.Group(),
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    } as unknown as THREE.WebGLRenderer;
    return { scene: new THREE.Scene(), renderer, xr: { presenting: false, exit: async () => {} } };
  };

  it('offers Reload on the title board after the notice was dismissed during a run', async () => {
    const meta = document.createElement('meta');
    meta.name = 'app-build';
    meta.content = RUNNING;
    document.head.append(meta);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ buildId: NEWER }), { status: 200 })),
    );
    const s = stage();
    const notice = mountUpdateNotice({ scene: s.scene, renderer: s.renderer, xr: s.xr });
    const reload = vi.fn();
    const { flow, ui, head } = rig({
      get available() {
        return notice.available;
      },
      reload,
      onChange: (listener) => notice.onChange(listener),
    });

    flow.newRun(SEED);
    ui.sync(head);
    const bar = (): HTMLElement | null => document.querySelector<HTMLElement>('#update-notice');
    await vi.waitFor(() => expect(bar()?.style.display).toBe('flex'));
    // Later, mid-run: the bar goes and the build stays on offer.
    bar()?.querySelectorAll('button')[1]?.click();
    expect(bar()?.style.display).toBe('none');
    expect(notice.available).toBe(true);
    expect(ui.visible).toBe(false);

    flow.abandonRun();
    ui.sync(head);
    expect(flow.phase).toBe('title');
    expect(ui.controlIds()[0]).toBe('title-reload');
    expect(ui.activate('title-reload')).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    ui.dispose();
    notice.dispose();
  });

  it('adds the row when a newer build turns up while the title is showing', () => {
    const state = createUpdateState();
    const { ui, head } = rig({
      get available() {
        return state.available;
      },
      reload: () => {},
      onChange: (listener) => state.onChange(listener),
    });
    ui.sync(head);
    expect(ui.controlIds()).not.toContain('title-reload');
    state.report({ buildId: NEWER });
    state.later();
    expect(ui.controlIds()).toContain('title-reload');
    state.report(null);
    expect(ui.controlIds()).not.toContain('title-reload');
    ui.dispose();
  });

  it('has nothing to offer on a page without a build stamp', () => {
    const s = stage();
    const notice = mountUpdateNotice({ scene: s.scene, renderer: s.renderer, xr: s.xr });
    expect(notice.available).toBe(false);
    const { ui, head } = rig(notice);
    ui.sync(head);
    expect(ui.controlIds()).not.toContain('title-reload');
    ui.dispose();
  });
});
