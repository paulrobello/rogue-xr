#!/usr/bin/env node
// Evidence screenshots for four visual effects, taken in headless Chromium on the GPU against a
// running vite dev server, with the same inputs a desktop player uses (mouse drags, the `T` and `E`
// keys). Each effect gets its own fresh browser context, so one failing step never hides another:
//
//   h4  card burn        a damage card dragged at an enemy; shots 40, 200 and 420 ms after mouse up
//   h3  sigil sparks     a sigil card laid on the table, then a stroke traced on the plate with the
//                        button held: one shot while the mouse moves, two while it rests (beam fizz)
//   h9  break-apart      an enemy killed (`?cheat=win` sets enemy hp to 1); shots 0.3, 1.0 and 2.5 s
//                        after the shatter starts (the death clip has ended)
//   h8  portal card art  the hand fan close up at several view offsets (drag-to-look, a debug poke of
//                        the hand anchor, and card hover) so the art-layer parallax can be compared
//
//   node scripts/full-run/effects-shot.mjs [--base http://localhost:4260] [--out /tmp/effects-shot]
//        [--seed SPIRE002] [--only h8,h4,h3,h9] [--headed]
//
// Timed shots are grabbed inside the page, in the animation frame that follows the trigger, by
// drawing the WebGL canvas into a 2D canvas right after the app has rendered: this ties each shot
// to the effect's own clock (mouse-up, first spark contact, shatter start) instead of to the
// latency of a Playwright screenshot. Every shot is a JPEG: a crop around the effect, plus a
// `-full` frame for the timed ones. `effects.json` lists the shots with the wanted and measured
// times, in-page probe values, console errors and page errors. Exit code 1 on any page error, any
// failed step or any missing shot. Every wait is bounded, so the script cannot hang.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4260' },
    out: { type: 'string', default: '/tmp/effects-shot' },
    seed: { type: 'string', default: 'SPIRE002' },
    only: { type: 'string', default: 'h8,h4,h3,h9' },
    headed: { type: 'boolean', default: false },
  },
});

const GPU_ARGS =
  (process.env.PW_GPU ?? 'metal') === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const VIEWPORT = { width: 1600, height: 1000 };
const MUSIC = /\/audio\/music\/|music not found/;
/** Hard ceiling for the whole run; the report is written and the process exits when it is hit. */
const RUN_BUDGET_MS = 14 * 60 * 1000;

/** Runs before any app script: catches the renderer and scenes (as run.mjs does). */
const INIT = `(() => {
  const devtools = new EventTarget();
  devtools.objects = [];
  devtools.addEventListener('observe', (e) => devtools.objects.push(e.detail));
  window.__THREE_DEVTOOLS__ = devtools;
})();`;

const STEPS = {
  h8: {
    dpr: 2,
    cheat: false,
    multi: false,
    budget: 170000,
    expect: [
      'hand-base',
      'hand-look-yaw-pos',
      'hand-look-yaw-neg',
      'hand-look-pitch-up',
      'hand-look-pitch-down',
      'hand-anchor-yaw-pos',
      'hand-anchor-yaw-neg',
      'hand-anchor-pitch-up',
      'hand-anchor-pitch-down',
      'hand-hover-left',
      'hand-hover-right',
    ],
  },
  h4: {
    dpr: 1,
    cheat: false,
    multi: false,
    budget: 170000,
    expect: ['burn-040ms', 'burn-200ms', 'burn-420ms'],
  },
  h3: {
    dpr: 2,
    cheat: false,
    multi: false,
    budget: 190000,
    expect: ['sigil-moving', 'sigil-resting-a', 'sigil-resting-b'],
  },
  h9: {
    dpr: 1,
    cheat: true,
    multi: true,
    budget: 190000,
    expect: ['shatter-0300ms', 'shatter-1000ms', 'shatter-2500ms'],
  },
};

const report = {
  base: opts.base,
  seed: opts.seed,
  startedAt: new Date().toISOString(),
  ok: false,
  steps: [],
  pageErrors: [],
  consoleErrors: [],
  watchdog: false,
};

mkdirSync(opts.out, { recursive: true });

function finish(code) {
  report.ok = code === 0;
  writeFileSync(join(opts.out, 'effects.json'), JSON.stringify(report, null, 2));
  console.log(
    `\n${report.steps.map((s) => `${s.step}: ${s.ok ? 'ok' : 'FAILED'} (${s.shots.length} shots)`).join(', ')}` +
      `\n${report.pageErrors.length} page errors, ${report.consoleErrors.length} console errors` +
      `\nreport: ${join(opts.out, 'effects.json')}`,
  );
  process.exit(code);
}

const watchdog = setTimeout(() => {
  report.watchdog = true;
  console.log('watchdog: run budget exceeded');
  finish(1);
}, RUN_BUDGET_MS);
watchdog.unref();

/** Rejects when `promise` has not settled in `ms`, so no await can hang the run. */
function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${label}`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const names = opts.only
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const unknown = names.filter((n) => !STEPS[n]);
if (unknown.length) {
  console.error(
    `--only: unknown step ${unknown.join(',')} (known: ${Object.keys(STEPS).join(',')})`,
  );
  process.exit(2);
}

let browser = null;

async function main() {
  try {
    browser = await withTimeout(
      chromium.launch({ channel: 'chromium', headless: !opts.headed, args: GPU_ARGS }),
      60000,
      'browser launch',
    );
    for (const name of names) await runStep(name, STEPS[name]);
  } catch (error) {
    report.fatal = String(error).split('\n')[0];
    console.log(`fatal: ${report.fatal}`);
  } finally {
    if (browser) await withTimeout(browser.close(), 20000, 'browser close').catch(() => {});
  }
  const bad = report.steps.some((s) => !s.ok);
  finish(report.fatal || bad || report.pageErrors.length > 0 ? 1 : 0);
}

async function runStep(name, cfg) {
  const rec = {
    step: name,
    ok: false,
    gpu: null,
    room: null,
    notes: [],
    failures: [],
    shots: [],
    missing: [],
  };
  report.steps.push(rec);
  console.log(`\n=== ${name}`);
  let g = null;
  try {
    g = await withTimeout(openFight(name, rec, cfg), 150000, `${name} boot`);
    await withTimeout(STEP_FNS[name](g, rec), cfg.budget, `${name} step`);
  } catch (error) {
    rec.failures.push(`exception: ${String(error).split('\n')[0]}`);
    console.log(`  FAIL ${name} ${rec.failures.at(-1)}`);
    if (g) await g.shot('exception').catch(() => {});
  } finally {
    if (g) await withTimeout(g.close(), 20000, 'context close').catch(() => {});
  }
  rec.missing = cfg.expect.filter((n) => !rec.shots.some((s) => s.name === n));
  rec.ok = rec.failures.length === 0 && rec.missing.length === 0;
  console.log(`  ${name}: ${rec.ok ? 'ok' : 'FAILED'}, ${rec.shots.length} shots`);
}

/**
 * A fresh context on a started run, teleported to a regular encounter with the fight active and the
 * hand dealt. Returns the helpers each step uses.
 */
async function openFight(label, rec, cfg) {
  const context = await withTimeout(
    browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: cfg.dpr }),
    30000,
    'newContext',
  );
  await context.addInitScript({ content: INIT });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && !MUSIC.test(text))
      report.consoleErrors.push({ step: label, text: text.slice(0, 400) });
  });
  page.on('pageerror', (error) =>
    report.pageErrors.push({ step: label, error: String(error).slice(0, 400) }),
  );
  page.on('crash', () => report.pageErrors.push({ step: label, error: 'page crash' }));

  const fail = (what, detail = {}) => {
    rec.failures.push(what);
    console.log(`  FAIL ${label} ${what}`, JSON.stringify(detail));
  };
  const ev = (fn, arg, ms = 30000) => withTimeout(page.evaluate(fn, arg), ms, 'evaluate');
  const wait = (ms) => page.waitForTimeout(ms);
  const m = {
    move: (x, y, o) => withTimeout(page.mouse.move(x, y, o), 20000, 'mouse.move'),
    down: () => withTimeout(page.mouse.down(), 10000, 'mouse.down'),
    up: () => withTimeout(page.mouse.up(), 10000, 'mouse.up'),
    click: (x, y) => withTimeout(page.mouse.click(x, y), 10000, 'mouse.click'),
  };
  const key = (k) => withTimeout(page.keyboard.press(k), 10000, `key ${k}`);
  const until = async (what, fn, arg, timeout = 20000) => {
    try {
      await withTimeout(
        page.waitForFunction(fn, arg, { timeout, polling: 100 }),
        timeout + 5000,
        what,
      );
      return true;
    } catch {
      fail(`timeout:${what}`, { timeout });
      return false;
    }
  };
  const clickControl = async (id) => {
    const p = await ev((c) => window.__flow.screenOfControl(c), id);
    if (!p) return false;
    await m.move(p.x, p.y, { steps: 4 });
    await wait(120);
    await m.click(p.x, p.y);
    await wait(350);
    return true;
  };

  const save = (name, buffer, meta = {}) => {
    const file = `${label}-${name}.jpg`;
    writeFileSync(join(opts.out, file), buffer);
    if (!name.endsWith('-full')) rec.shots.push({ name, file, ...meta });
    console.log(`  shot ${file}`);
  };

  const g = {
    page,
    ev,
    wait,
    m,
    key,
    until,
    fail,
    async close() {
      await context.close();
    },
    /** A full-viewport screenshot through Playwright. */
    async shot(name) {
      const buffer = await withTimeout(
        page.screenshot({ type: 'jpeg', quality: 85 }),
        20000,
        'screenshot',
      );
      save(name, buffer);
    },
    /** A Playwright screenshot of `clip` (css pixels). */
    async clipShot(name, clip, meta = {}) {
      const buffer = await withTimeout(
        page.screenshot({ type: 'jpeg', quality: 90, clip }),
        20000,
        'clip screenshot',
      );
      save(name, buffer, { clip, ...meta });
    },
    /** Arms an in-page frame grab (see `installFx`) and returns its id. */
    arm: (spec) => ev((s) => window.__grab.arm(s), spec),
    /** Waits for a grab to finish, saves its shots and returns the job. */
    async collect(id, timeout) {
      await until(`grab-${id}`, (n) => window.__grab.done(n), id, timeout);
      const job = await ev((n) => window.__grab.take(n), id);
      if (job.error) fail(`grab ${id}: ${job.error}`, { blanks: job.blanks });
      for (const s of job.shots) {
        save(s.name, Buffer.from(s.crop.split(',')[1], 'base64'), {
          wantedMs: s.wantedMs,
          actualMs: s.actualMs,
          probe: s.probe,
          region: s.region,
        });
        if (s.full) save(`${s.name}-full`, Buffer.from(s.full.split(',')[1], 'base64'));
      }
      return job;
    },
    /** Waits until a fight turn is the player's to act in. */
    playerTurn: (timeout = 25000) =>
      until(
        'player-turn',
        () => {
          const s = window.__combat.session;
          return s && s.controller.state.phase === 'player' && !s.enemyPhase;
        },
        undefined,
        timeout,
      ),
    snap: () => ev(() => window.__fx.snap()),
    async endTurn(turn) {
      await key('KeyE');
      await ev(
        (k) =>
          new Promise((done) => {
            const step = (left) =>
              left <= 0 ? done(true) : requestAnimationFrame(() => step(left - 1));
            step(k);
          }),
        3,
      );
      return until(
        'end-turn',
        (t) => {
          const s = window.__combat.session;
          if (!s) return true;
          const st = s.controller.state;
          return (
            s.controller.outcome !== null ||
            (!s.enemyPhase && !s.dirty && st.phase === 'player' && st.turn > t)
          );
        },
        turn,
        25000,
      );
    },
    /**
     * The first hand card `pick` accepts and the steam allows, ending the turn (a fresh hand) up to
     * `turns` times when there is none. Returns `{ card, s }` or null.
     */
    async ensureCard(pick, turns = 6) {
      for (let i = 0; i <= turns; i++) {
        if (!(await g.playerTurn())) return null;
        const s = await g.snap();
        if (s.outcome) return null;
        const card = pick(s.hand.filter((c) => c.cost <= s.player.steam));
        if (card) return { card, s };
        if (i === turns) break;
        rec.notes.push(`turn ${s.turn}: no suitable card in hand, ended the turn`);
        if (!(await g.endTurn(s.turn))) return null;
      }
      fail('no-suitable-card');
      return null;
    },
    /**
     * Drags a hand card to an enemy (`enemyId`) or the table (null) with the mouse. `beforeUp(to)`
     * runs with the button still down, just before the release, and its result comes back as
     * `pending`.
     */
    async dragCard(card, enemyId, beforeUp) {
      const from = await ev((uid) => window.__combat.screenOf('card', uid), card.uid);
      const to = await ev(
        (id) => (id ? window.__combat.screenOf('enemy', id) : window.__combat.screenOf('table')),
        enemyId,
      );
      if (!from || !to) {
        fail('no-screen-point', { from, to });
        return null;
      }
      await m.move(from.x, from.y, { steps: 3 });
      await wait(80);
      await m.down();
      await m.move(to.x, to.y, { steps: 12 });
      await wait(60);
      const pending = beforeUp ? await beforeUp(to) : null;
      await m.up();
      return { from, to, pending };
    },
  };

  const url = `${opts.base}/?seed=${opts.seed}&title&debug${cfg.cheat ? '&cheat=win' : ''}`;
  await withTimeout(
    page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }),
    70000,
    'goto',
  );
  if (!(await until('app', () => window.__flow?.ui && window.__combat, undefined, 90000)))
    throw new Error('app did not boot');
  await ev(() => window.__combat.heroReady, undefined, 90000);
  await ev(installFx, undefined, 90000);
  rec.gpu = await ev(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  await wait(800);
  if (!(await clickControl('title-difficulty-casual')))
    rec.notes.push('casual difficulty button not found, default difficulty used');
  if (!(await clickControl('title-new-run'))) throw new Error('title-new-run control missing');
  if (!(await until('explore', () => window.__flow.flow.phase === 'explore', undefined, 60000)))
    throw new Error('run did not reach explore');
  await wait(1500);

  const room = await ev((multi) => {
    const pick = window.__fx.pickRoom(multi);
    return (
      (pick === null ? null : window.__combat.teleportToEncounter(pick)) ??
      window.__combat.teleportToEncounter()
    );
  }, cfg.multi);
  if (room === null) throw new Error('no encounter room to teleport to');
  rec.room = room;
  const roomInfo = await ev((r) => window.__fx.roomInfo(r), room);
  rec.notes.push(`fight in room ${room}: ${JSON.stringify(roomInfo)}`);
  const ready = await until(
    'fight-active',
    () => {
      const s = window.__combat.session;
      return (
        window.__combat.floor.encounter.phase === 'active' &&
        s &&
        s.controller.state.phase === 'player' &&
        !s.enemyPhase
      );
    },
    undefined,
    30000,
  );
  if (!ready) throw new Error('fight did not become active');
  await wait(1500);
  return g;
}

// ---- the four steps -----------------------------------------------------------------------------

const STEP_FNS = {
  /**
   * H4: drags a damage card at an enemy and grabs the frames 40, 200 and 420 ms after the mouse
   * button goes up (the burn starts in the release handler, `FlingController.settle` -> `playOut`).
   */
  async h4(g, rec) {
    const got = await g.ensureCard((hand) =>
      [...hand]
        .filter((c) => c.target === 'enemy' && c.effects.some((e) => e.type === 'damage'))
        .sort((a, b) => Number(!!a.dice) - Number(!!b.dice))
        .at(0),
    );
    if (!got) return;
    const enemy = got.s.enemies.find((e) => e.hp > 0);
    if (!enemy) return g.fail('no-live-enemy');
    rec.notes.push(`card ${got.card.id} at ${enemy.id}`);
    const result = await g.dragCard(got.card, enemy.id, (to) =>
      g.arm({
        trigger: 'pointerup',
        delays: [40, 200, 420],
        names: ['burn-040ms', 'burn-200ms', 'burn-420ms'],
        region: { x: to.x - 360, y: to.y - 280, w: 720, h: 560 },
        full: true,
        probe: 'burn',
        timeoutMs: 8000,
      }),
    );
    if (!result) return;
    const job = await g.collect(result.pending, 15000);
    const live = job.shots.map((s) => s.probe?.live ?? 0);
    if (!live.some((n) => n > 0)) g.fail('burn-never-active-in-probe', { probes: job.shots });
    else rec.notes.push(`burn progress per shot: ${job.shots.map((s) => s.probe?.maxProgress)}`);
  },

  /**
   * H3: lays a sigil card on the table, then traces the first template stroke with the button held
   * (a shot mid-stroke while moving), keeps the button down on the last point (two shots while the
   * beam rests and fizzes) and lets go.
   */
  async h3(g, rec) {
    const got = await g.ensureCard((hand) => hand.find((c) => c.sigil));
    if (!got) return;
    rec.notes.push(`sigil card ${got.card.id} (${got.card.sigil})`);
    const laid = await g.dragCard(got.card, null);
    if (!laid) return;
    let staged = false;
    for (let i = 0; i < 60 && !staged; i++) {
      await g.wait(150);
      const s = await g.snap();
      if (s.awaitingThrow) await g.key('KeyT');
      staged = s.stage === 'sigil' && s.plate === 'ready';
    }
    if (!staged) return g.fail('sigil-plate-not-ready', { snap: await g.snap() });
    await g.wait(900);

    const strokes = await g.ev((id) => window.__fx.plateStrokes(id), got.card.sigil);
    const rect = await g.ev(() => window.__fx.plateRect(60));
    const first = densify(strokes[0] ?? [], 10);
    if (first.length < 4 || !rect)
      return g.fail('no-plate-geometry', { first: first.length, rect });
    rec.notes.push(`stroke 0: ${first.length} points, plate rect ${JSON.stringify(rect)}`);

    const moving = await g.arm({
      trigger: 'moving',
      delays: [100],
      names: ['sigil-moving'],
      region: rect,
      full: true,
      probe: 'sparks',
      timeoutMs: 15000,
    });
    const resting = await g.arm({
      trigger: 'resting',
      delays: [0, 300],
      names: ['sigil-resting-a', 'sigil-resting-b'],
      region: rect,
      full: true,
      probe: 'sparks',
      timeoutMs: 15000,
    });
    const start = first[0];
    await g.m.move(start.x, start.y);
    await g.m.down();
    for (const p of first.slice(1)) {
      await g.m.move(p.x, p.y, { steps: 2 });
      await g.wait(10);
    }
    // The button stays down on the last point: no pointer events reach the plate, the contact
    // persists and `SigilSparks` keeps emitting at the resting rate.
    const movingJob = await g.collect(moving, 8000);
    const restingJob = await g.collect(resting, 10000);
    await g.m.up();
    const phase = await g.ev(() => window.__combat.session?.plate.phase ?? null);
    rec.notes.push(`plate phase after release: ${phase}`);
    for (const s of [...movingJob.shots, ...restingJob.shots])
      rec.notes.push(`${s.name} sparks probe: ${JSON.stringify(s.probe)}`);
    if (!movingJob.shots.some((s) => (s.probe?.alive ?? 0) > 0))
      g.fail('no-sparks-alive-while-moving', { probes: movingJob.shots.map((s) => s.probe) });
    if (!restingJob.shots.some((s) => (s.probe?.alive ?? 0) > 0))
      g.fail('no-sparks-alive-while-resting', { probes: restingJob.shots.map((s) => s.probe) });
    const drawCounts = [...movingJob.shots, ...restingJob.shots].map((s) => s.probe?.draws);
    if (drawCounts.some((d) => d !== 1)) g.fail('sparks-not-one-draw', { drawCounts });
  },

  /**
   * H9: with `?cheat=win` (enemy hp 1) one damage card kills an enemy. The frame grab starts when a
   * `break-apart` group appears under the floor (the death clip has ended) and takes 0.3, 1.0 and
   * 2.5 s later.
   */
  async h9(g, rec) {
    const got = await g.ensureCard((hand) =>
      [...hand]
        .filter(
          (c) =>
            c.target === 'enemy' &&
            c.effects.some((e) => e.type === 'damage' && e.target !== 'all-opponents'),
        )
        .sort((a, b) => Number(!!a.dice) - Number(!!b.dice))
        .at(0),
    );
    if (!got) return;
    const alive = got.s.enemies.filter((e) => e.hp > 0);
    const enemy = alive[0];
    if (!enemy) return g.fail('no-live-enemy');
    rec.notes.push(
      `${alive.length} live enemies; card ${got.card.id} at ${enemy.id} (hp ${enemy.hp})`,
    );
    if (alive.length < 2)
      rec.notes.push(
        'single-enemy room: the encounter may end (and unparent the actor) before its death clip does, so no shatter may start',
      );
    const result = await g.dragCard(got.card, enemy.id, (to) =>
      g.arm({
        trigger: 'shatter',
        delays: [300, 1000, 2500],
        names: ['shatter-0300ms', 'shatter-1000ms', 'shatter-2500ms'],
        region: { x: to.x - 450, y: to.y - 250, w: 900, h: 650 },
        full: true,
        probe: 'shatter',
        timeoutMs: 30000,
      }),
    );
    if (!result) return;
    // Cards with dice wait for a throw.
    for (let i = 0; i < 10; i++) {
      const s = await g.snap();
      if (!s.awaitingThrow) break;
      await g.key('KeyT');
      await g.wait(300);
    }
    const job = await g.collect(result.pending, 45000);
    rec.notes.push(`shatter probes: ${JSON.stringify(job.shots.map((s) => s.probe))}`);
    if (job.shots.length && !job.shots.some((s) => (s.probe?.pieces ?? 0) > 0))
      g.fail('shatter-has-no-pieces-in-probe');
  },

  /**
   * H8: close shots of the hand fan at several view offsets. On the desktop the fan is a child of the
   * camera, so drag-to-look leaves the card-to-eye angle unchanged; the anchor poke (a debug
   * rotation of `session.handAnchor`) and the hover tilt change it, and are the shots that show the
   * art layers lagging the frame.
   */
  async h8(g, rec) {
    const hand = (await g.snap()).hand;
    if (hand.length < 2) return g.fail('hand-too-small', { hand: hand.length });
    const handShot = async (name, extra = {}) => {
      const clip = await g.ev(() => window.__fx.handRect(70));
      if (!clip) return g.fail(`no-hand-rect:${name}`);
      const pose = await g.ev(() => window.__fx.pose());
      await g.clipShot(name, clip, { pose, ...extra });
    };
    const lookDrag = async (dx, dy) => {
      await g.m.move(800, 40);
      await g.m.down();
      await g.m.move(800 + dx, 40 + dy, { steps: 8 });
      await g.m.up();
      await g.wait(450);
    };
    const poke = async (yaw, pitch) => {
      await g.ev((a) => window.__fx.pokeHand(a[0], a[1]), [yaw, pitch]);
      await g.wait(350);
    };

    await handShot('hand-base');
    const p0 = await g.ev(() => window.__fx.pose());

    // Drag-to-look: 0.23 degrees per pixel of yaw, 0.004 radians per pixel of pitch.
    await lookDrag(43, 0);
    await handShot('hand-look-yaw-pos');
    const p1 = await g.ev(() => window.__fx.pose());
    await lookDrag(-86, 0);
    await handShot('hand-look-yaw-neg');
    await lookDrag(43, 0);
    await lookDrag(0, -35);
    await handShot('hand-look-pitch-up');
    await lookDrag(0, 70);
    await handShot('hand-look-pitch-down');
    await lookDrag(0, -35);
    rec.notes.push(
      `look drag yaw ${p0.yaw} -> ${p1.yaw} (wanted +10); the hand fan is camera-locked on the desktop`,
    );
    // In a fight the desktop view is framed and the walker is locked, so a drag may not turn it;
    // the pokeHand shots below are the parallax evidence.
    if (Math.abs(p1.yaw - p0.yaw) < 3)
      rec.notes.push('look drag did not turn (combat-locked view)');

    // View offset relative to the hand, as a head turn would give it in XR.
    await poke(7, 0);
    await handShot('hand-anchor-yaw-pos', { poke: [7, 0] });
    await poke(-7, 0);
    await handShot('hand-anchor-yaw-neg', { poke: [-7, 0] });
    await poke(0, 7);
    await handShot('hand-anchor-pitch-up', { poke: [0, 7] });
    await poke(0, -7);
    await handShot('hand-anchor-pitch-down', { poke: [0, -7] });
    await poke(0, 0);

    // Hover lifts and tilts a card toward the eye, which changes its own view angle.
    for (const [name, card] of [
      ['hand-hover-left', hand[0]],
      ['hand-hover-right', hand.at(-1)],
    ]) {
      const at = await g.ev((uid) => window.__combat.screenOf('card', uid), card.uid);
      if (!at) {
        g.fail(`no-screen-point:${name}`);
        continue;
      }
      await g.m.move(at.x, at.y, { steps: 8 });
      await g.wait(500);
      await handShot(name, { hovered: card.id });
    }
    await g.m.move(800, 40, { steps: 4 });
  },
};

/** Points every `gap` pixels along a polyline, so a stroke is traced at a steady pace. */
function densify(points, gap) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    if (i === 0) {
      out.push(a);
      continue;
    }
    const b = points[i - 1];
    const n = Math.max(1, Math.ceil(Math.hypot(a.x - b.x, a.y - b.y) / gap));
    for (let k = 1; k <= n; k++)
      out.push({ x: b.x + ((a.x - b.x) * k) / n, y: b.y + ((a.y - b.y) * k) / n });
  }
  return out;
}

/**
 * Runs in the page: read-only helpers (state, screen rectangles, sigil template points), a hand-anchor
 * poke for the H8 view offsets, and the frame grabber behind every timed shot.
 */
async function installFx() {
  const { SIGIL_TEMPLATES } = await import('/src/sigil/templates.ts');
  const c = window.__combat;
  const renderer = window.__THREE_DEVTOOLS__.objects.find((o) => o?.isWebGLRenderer);
  const canvas = renderer?.domElement ?? document.querySelector('canvas');
  const rig = c.camera.parent;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const boundsOf = (points, pad) => {
    const pts = points.filter(Boolean);
    if (!pts.length) return null;
    const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)) - pad));
    const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.y)) - pad));
    const x1 = Math.min(window.innerWidth, Math.ceil(Math.max(...pts.map((p) => p.x)) + pad));
    const y1 = Math.min(window.innerHeight, Math.ceil(Math.max(...pts.map((p) => p.y)) + pad));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
  };

  const fx = {
    handBase: null,
    snap() {
      const s = c.session;
      if (!s) return { outcome: null, stage: 'none', hand: [], enemies: [], player: {}, turn: 0 };
      const st = s.controller.state;
      return {
        outcome: s.controller.outcome,
        stage: s.stage,
        enemyPhase: s.enemyPhase,
        awaitingThrow: s.awaitingThrow,
        plate: s.plate.phase,
        turn: st.turn,
        player: { hp: st.player.hp, steam: st.player.steam },
        enemies: st.enemies.map((e) => ({ id: e.id, name: e.name, hp: e.hp, maxHp: e.maxHp })),
        hand: st.piles.hand.map((card) => ({
          uid: card.uid,
          id: card.def.id,
          cost: card.def.cost,
          target: card.def.target,
          sigil: card.def.sigil ?? null,
          dice: card.def.dice ?? null,
          effects: card.def.effects,
        })),
      };
    },
    /** A not yet cleared, non-elite encounter room: one automaton, or two or more when `multi`. */
    pickRoom(multi) {
      const plan = c.floor.world.plan;
      const live = plan.rooms.filter(
        (r) =>
          r.index !== 0 &&
          r.index !== plan.guardianRoom &&
          r.encounter &&
          r.encounter.tier !== 'elite' &&
          !c.floor.encounter.isCleared(r.index),
      );
      const count = (r) => r.encounter.socketIds.length;
      const wanted = live.filter((r) => (multi ? count(r) >= 2 : count(r) === 1));
      const pool = wanted.length ? wanted : live;
      return pool.length ? pool[0].index : null;
    },
    roomInfo(room) {
      const r = c.floor.world.plan.rooms[room];
      return { tier: r?.encounter?.tier ?? null, enemies: r?.encounter?.socketIds.length ?? 0 };
    },
    pose() {
      return {
        yaw: r3((-rig.rotation.y * 180) / Math.PI),
        pitch: r3((c.camera.rotation.x * 180) / Math.PI),
      };
    },
    /** Viewport rectangle around the hand strip (css pixels, Playwright clip form). */
    handRect(pad) {
      const s = c.session;
      const points = [];
      try {
        const box = canvas.getBoundingClientRect();
        for (const v of s.handCorners()) {
          const p = v.clone().project(c.camera);
          if (p.z > 1) continue;
          points.push({
            x: box.left + ((p.x + 1) / 2) * box.width,
            y: box.top + ((1 - p.y) / 2) * box.height,
          });
        }
      } catch {
        points.length = 0;
      }
      if (points.length) return boundsOf(points, pad);
      const centres = s.controller.state.piles.hand.map((card) => c.screenOf('card', card.uid));
      return boundsOf(centres, pad + 110);
    },
    plateRect(pad) {
      const corners = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([u, v]) => c.screenOf('plate', undefined, u, v));
      const b = boundsOf(corners, pad);
      return b && { x: b.x, y: b.y, w: b.width, h: b.height };
    },
    /** Screen points of the sigil template, fitted to 72 % of the plate (as run.mjs traces it). */
    plateStrokes(sigil) {
      const strokes = SIGIL_TEMPLATES[sigil].strokes;
      const pts = strokes.flat();
      const x0 = Math.min(...pts.map((p) => p.x));
      const x1 = Math.max(...pts.map((p) => p.x));
      const y0 = Math.min(...pts.map((p) => p.y));
      const y1 = Math.max(...pts.map((p) => p.y));
      const k = 0.72 / Math.max(x1 - x0, y1 - y0);
      return strokes.map((stroke) =>
        stroke.map((p) =>
          c.screenOf(
            'plate',
            undefined,
            0.5 + (p.x - (x0 + x1) / 2) * k,
            0.5 + (p.y - (y0 + y1) / 2) * k,
          ),
        ),
      );
    },
    /** Rotates the hand anchor by (`yawDeg`, `pitchDeg`) from its home pose: a view offset relative to the hand. */
    pokeHand(yawDeg, pitchDeg) {
      const a = c.session.handAnchor;
      fx.handBase ??= { x: a.rotation.x, y: a.rotation.y, z: a.rotation.z };
      const d = Math.PI / 180;
      a.rotation.set(fx.handBase.x + pitchDeg * d, fx.handBase.y + yawDeg * d, fx.handBase.z);
      return true;
    },
  };
  window.__fx = fx;

  // ---- frame grabber --------------------------------------------------------------------------
  const probes = {
    burn() {
      const fan = c.session?.fan;
      const b = fan?.burns;
      if (!b) return null;
      let live = 0;
      let maxProgress = 0;
      for (let i = 0; i < b.capacity; i++) {
        if (!b.isLive(i)) continue;
        live++;
        maxProgress = Math.max(maxProgress, b.progress(i));
      }
      return { live, maxProgress: r3(maxProgress) };
    },
    sparks() {
      const sp = c.session?.plate?.sparks;
      if (!sp) return null;
      let draws = 0;
      sp.traverse((o) => {
        if ((o.isMesh || o.isPoints) && o.visible) draws++;
      });
      return {
        touching: sp.touching,
        speed: r3(sp.speed),
        alive: sp.pool.alive,
        dot: r3(sp.dotBrightness),
        draws,
      };
    },
    shatter() {
      const roots = c.floor.world.group.children.filter((o) => o.name === 'break-apart');
      const root = roots.at(-1);
      if (!root) return { bursts: 0, pieces: 0 };
      return {
        bursts: roots.length,
        pieces: root.children.filter((o) => o.name.startsWith('piece-')).length,
        cogs: root.children.filter((o) => o.name === 'loose-cog').length,
      };
    },
  };
  const grab = { jobs: new Map(), serial: 0, lastUp: -1 };
  window.addEventListener(
    'pointerup',
    () => {
      grab.lastUp = performance.now();
    },
    true,
  );
  const sparksOf = () => c.session?.plate?.sparks;
  const starters = {
    now: () => performance.now(),
    pointerup: (job) => (grab.lastUp > job.armedAt ? grab.lastUp : null),
    moving: () => {
      const sp = sparksOf();
      return sp?.touching && sp.speed > 0.08 ? performance.now() : null;
    },
    resting: () => {
      const sp = sparksOf();
      return sp?.touching && sp.speed < 0.02 && sp.pool.alive >= 5 ? performance.now() : null;
    },
    shatter: (job) =>
      c.floor.world.group.children.filter((o) => o.name === 'break-apart').length > job.base
        ? performance.now()
        : null,
  };
  const tiny = document.createElement('canvas');
  tiny.width = 16;
  tiny.height = 16;
  const tinyCtx = tiny.getContext('2d', { willReadFrequently: true });
  const brightness = () => {
    tinyCtx.drawImage(canvas, 0, 0, 16, 16);
    const d = tinyCtx.getImageData(0, 0, 16, 16).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return sum / (256 * 3);
  };
  const encode = (region, maxWidth, quality) => {
    const box = canvas.getBoundingClientRect();
    const k = canvas.width / box.width;
    const x0 = Math.max(box.left, region ? region.x : box.left);
    const y0 = Math.max(box.top, region ? region.y : box.top);
    const x1 = Math.min(box.right, region ? region.x + region.w : box.right);
    const y1 = Math.min(box.bottom, region ? region.y + region.h : box.bottom);
    const sw = Math.max(1, (x1 - x0) * k);
    const sh = Math.max(1, (y1 - y0) * k);
    const scale = Math.min(1, maxWidth / sw);
    const out = document.createElement('canvas');
    out.width = Math.round(sw * scale);
    out.height = Math.round(sh * scale);
    out
      .getContext('2d')
      .drawImage(
        canvas,
        (x0 - box.left) * k,
        (y0 - box.top) * k,
        sw,
        sh,
        0,
        0,
        out.width,
        out.height,
      );
    return {
      url: out.toDataURL('image/jpeg', quality),
      region: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
    };
  };
  const capture = (job, wanted, now) => {
    if (brightness() < 0.5) {
      job.blanks++;
      if (job.blanks > 40) {
        job.error = 'only blank frames could be grabbed';
        job.done = true;
      }
      return;
    }
    const crop = encode(job.region, 2400, 0.9);
    let probe = null;
    try {
      probe = probes[job.probe]?.() ?? null;
    } catch (error) {
      probe = { error: String(error) };
    }
    job.shots.push({
      name: job.names[job.shots.length],
      wantedMs: wanted,
      actualMs: Math.round(now - job.t0),
      probe,
      region: crop.region,
      crop: crop.url,
      full: job.full ? encode(null, 1600, 0.82).url : null,
    });
    if (job.shots.length >= job.delays.length) job.done = true;
  };
  const tick = () => {
    const now = performance.now();
    for (const job of grab.jobs.values()) {
      if (job.done) continue;
      if (job.t0 === null) {
        const t = starters[job.trigger](job);
        if (t !== null) job.t0 = t;
        else if (now - job.armedAt > job.timeoutMs) {
          job.error = `trigger ${job.trigger} never fired`;
          job.done = true;
          continue;
        }
      }
      if (job.t0 !== null && now - job.t0 >= job.delays[job.shots.length]) {
        capture(job, job.delays[job.shots.length], now);
      }
    }
    requestAnimationFrame(tick);
  };
  window.__grab = {
    arm(spec) {
      const id = `g${++grab.serial}`;
      grab.jobs.set(id, {
        ...spec,
        id,
        armedAt: performance.now(),
        base: c.floor.world.group.children.filter((o) => o.name === 'break-apart').length,
        t0: null,
        shots: [],
        blanks: 0,
        done: false,
        error: null,
      });
      return id;
    },
    done: (id) => grab.jobs.get(id)?.done ?? true,
    take(id) {
      const job = grab.jobs.get(id);
      grab.jobs.delete(id);
      return job
        ? { error: job.error, blanks: job.blanks, shots: job.shots }
        : { error: 'unknown job', blanks: 0, shots: [] };
    },
  };
  // Registered from outside any frame, so it runs after the app's own frame callback in every frame
  // and the canvas still holds the frame the app just rendered.
  requestAnimationFrame(tick);
  return true;
}

await main();
