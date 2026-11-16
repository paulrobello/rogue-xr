#!/usr/bin/env node
// Automated desktop full run: plays seeded runs of the real game on the dev server in headless
// Chromium on the GPU, with the same inputs a desktop player uses. WASD walks the floor room to
// room through its doors, a mouse drag turns the view, cards are dragged at an automaton or onto
// the table, `T` throws dice, sigils are traced with the mouse on the plate and `E` ends the turn.
// The `?debug` hooks are read for state and screen positions only; nothing here writes rules state.
//
//   node scripts/full-run/run.mjs [--base http://localhost:4260] [--out /tmp/full-run]
//        [--seeds SPIRE001,SPIRE002] [--death SPIRE001] [--headed]
//
// Each seed gets a fresh browser context (its own IndexedDB) and writes screenshots and
// report.json to <out>/<seed>/ (the death run to <out>/<seed>-death/). The summary lands in
// <out>/summary.json. The exit code is 1 when any run fails an assertion or does not finish.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4260' },
    out: { type: 'string', default: '/tmp/full-run' },
    seeds: { type: 'string', default: 'SPIRE001,SPIRE002,SPIRE003,SPIRE004,SPIRE005' },
    death: { type: 'string', default: 'SPIRE001' },
    headed: { type: 'boolean', default: false },
    'max-turns': { type: 'string', default: '45' },
  },
});

const GPU_ARGS =
  (process.env.PW_GPU ?? 'metal') === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const VIEWPORT = { width: 1600, height: 1000 };
const MAX_TURNS = Number(opts['max-turns']);
/** Degrees of turn per pixel of drag (src/desktop/controls.ts LOOK_DEGREES_PER_PIXEL). */
const LOOK_DEG_PER_PX = 0.23;
const MUSIC = /\/audio\/music\/|music not found/;

/** Runs before any app script: catches the renderer and scenes, and the text each canvas draws. */
const INIT = `(() => {
  const devtools = new EventTarget();
  devtools.objects = [];
  devtools.addEventListener('observe', (e) => devtools.objects.push(e.detail));
  window.__THREE_DEVTOOLS__ = devtools;
  const proto = CanvasRenderingContext2D.prototype;
  const clear = proto.clearRect;
  proto.clearRect = function (...args) {
    this.canvas.__texts = [];
    return clear.apply(this, args);
  };
  const fill = proto.fillText;
  proto.fillText = function (text, ...args) {
    (this.canvas.__texts ??= []).push(String(text));
    return fill.call(this, text, ...args);
  };
})();`;

const seeds = opts.seeds.split(',').filter(Boolean);
mkdirSync(opts.out, { recursive: true });
const browser = await chromium.launch({
  channel: 'chromium',
  headless: !opts.headed,
  args: GPU_ARGS,
});
const reports = [];
try {
  for (const seed of seeds) reports.push(await runSeed(seed, 'play'));
  if (opts.death) reports.push(await runSeed(opts.death, 'death'));
} finally {
  await browser.close();
}
const summary = reports.map((r) => ({
  seed: r.seed,
  mode: r.mode,
  end: r.end,
  roomsVisited: r.roomsVisited.length,
  fightsWon: r.fights.filter((f) => f.outcome === 'won').length,
  turns: r.fights.reduce((n, f) => n + f.turns, 0),
  cogs: r.cogsEarned,
  failures: r.failures.length,
  consoleErrors: r.console.errors.length,
  consoleWarnings: r.console.warnings.length,
  failedRequests: r.network.failed.length,
  music404: r.network.music.length,
}));
writeFileSync(join(opts.out, 'summary.json'), JSON.stringify(summary, null, 2));
console.table(summary);
const failed = reports.filter(
  (r) => r.failures.length > 0 || !['victory', 'death'].includes(r.end),
);
process.exit(failed.length > 0 ? 1 : 0);

async function runSeed(seed, mode) {
  const dir = join(opts.out, mode === 'death' ? `${seed}-death` : seed);
  mkdirSync(dir, { recursive: true });
  const report = {
    seed,
    mode,
    end: 'unfinished',
    gpu: null,
    roomsVisited: [],
    route: [],
    fights: [],
    rewards: [],
    hpCurve: [],
    cogsEarned: 0,
    summary: null,
    workshop: null,
    leak: null,
    reloads: 0,
    failures: [],
    console: { errors: [], warnings: [] },
    network: { failed: [], music: [] },
    screenshots: [],
  };
  const fail = (what, detail = {}) => {
    report.failures.push({ what, ...detail });
    console.log(`  FAIL ${seed} ${what}`, JSON.stringify(detail));
  };
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript({ content: INIT });
  const page = await context.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (MUSIC.test(text)) report.network.music.push(text);
    else if (msg.type() === 'error') report.console.errors.push(text);
    else if (msg.type() === 'warning') report.console.warnings.push(text);
  });
  page.on('pageerror', (error) => report.console.errors.push(`pageerror: ${error}`));
  page.on('requestfailed', (req) =>
    (MUSIC.test(req.url()) ? report.network.music : report.network.failed).push(
      `${req.url()} ${req.failure()?.errorText ?? ''}`,
    ),
  );
  page.on('response', (res) => {
    if (res.status() < 400) return;
    (MUSIC.test(res.url()) ? report.network.music : report.network.failed).push(
      `${res.status()} ${res.url()}`,
    );
  });
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && ++navigations > 1) report.reloads++;
  });

  const ev = (fn, arg) => page.evaluate(fn, arg);
  const wait = (ms) => page.waitForTimeout(ms);
  let shotIndex = 0;
  const shot = async (name) => {
    const path = join(dir, `${String(shotIndex++).padStart(2, '0')}-${name}.jpg`);
    await page.screenshot({ path, type: 'jpeg', quality: 80 });
    report.screenshots.push(path);
  };
  const until = async (label, fn, arg, timeout = 20000) => {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: 100 });
      return true;
    } catch {
      fail(`timeout:${label}`, { timeout });
      return false;
    }
  };
  const phase = () => ev(() => window.__flow.flow.phase);
  /** Waits for `n` rendered frames, so the session has synced the last input. */
  const frames = (n = 2) =>
    ev(
      (k) =>
        new Promise((done) => {
          const step = (left) =>
            left <= 0 ? done(true) : requestAnimationFrame(() => step(left - 1));
          step(k);
        }),
      n,
    );
  const runHp = async (at) => {
    const run = await ev(() => window.__flow.flow.run);
    if (run) report.hpCurve.push({ at, hp: run.hp, maxHp: run.maxHp, cogs: run.cogs });
  };
  /** Clicks a board control the way a player does: a mouse press on its screen point. */
  const clickControl = async (id) => {
    const p = await ev((c) => window.__flow.screenOfControl(c), id);
    if (!p) {
      fail(`control-missing:${id}`, { controls: await ev(() => window.__flow.ui.controlIds()) });
      return false;
    }
    await page.mouse.move(p.x, p.y, { steps: 4 });
    await wait(120);
    await page.mouse.click(p.x, p.y);
    await wait(350);
    return true;
  };

  const KEYS = { f: { 1: 'KeyW', '-1': 'KeyS' }, s: { 1: 'KeyD', '-1': 'KeyA' } };
  let held = new Set();
  const hold = async (next) => {
    for (const k of held) if (!next.has(k)) await page.keyboard.up(k);
    for (const k of next) if (!held.has(k)) await page.keyboard.down(k);
    held = next;
  };

  console.log(`\n=== ${seed} (${mode})`);
  try {
    await page.goto(`${opts.base}/?seed=${seed}&title&debug`);
    await until('app', () => window.__flow?.ui && window.__combat, undefined, 60000);
    await ev(() => window.__combat.heroReady);
    await ev(installHelpers);
    report.gpu = await ev(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    await wait(800);
    await shot('title');
    if ((await phase()) !== 'title') fail('boot-not-title', { phase: await phase() });

    await clickControl('title-new-run');
    if (!(await until('explore', () => window.__flow.flow.phase === 'explore'))) return report;
    const floorSeed = await ev(() => window.__combat.floor.seed);
    report.floorSeed = floorSeed;
    const want = await ev(
      async (raw) => (await import('/src/core/rng.ts')).normalizeSeed(raw),
      seed,
    );
    if (floorSeed !== want) fail('wrong-floor-seed', { floorSeed, want });
    await wait(1500);
    const baseline = await ev(() => window.__fr.census());
    report.route = await ev(() => window.__fr.route());
    await runHp('start');
    await shot('explore-start');
    await lookAround();

    // Encounter rooms along the route to the guardian, in order.
    const targets = report.route.filter((r) => r.encounter);
    for (const target of targets) {
      const result = await approachAndFight(target);
      if (result === 'stop') break;
    }
    const end = await phase();
    report.end = end === 'victory' || end === 'death' ? end : `stopped in ${end}`;
    if (end === 'victory' || end === 'death') {
      report.summary = await ev(() => window.__flow.flow.summary);
      report.cogsEarned = report.summary?.cogsEarned ?? 0;
      const atEnd = await ev(() => window.__fr.census());
      await wait(600);
      await shot(end);
      await clickControl('summary-title');
      await until('title-after-run', () => window.__flow.flow.phase === 'title');
      const continueOffered = await ev(() =>
        window.__flow.ui.controlIds().includes('title-continue'),
      );
      if (continueOffered) fail('continue-offered-after-run');
      await shot('title-after-run');
      await workshop();
      // A second New Run in the same page: the loop restarts and the old floor leaves nothing.
      await ev(() => window.__fr.trackFloor());
      await clickControl('title-new-run');
      if (await until('second-run', () => window.__flow.flow.phase === 'explore')) {
        await wait(2500);
        const after = await ev(() => window.__fr.census());
        const orphans = await ev(() => window.__fr.floorOrphans());
        report.leak = { baseline, atEnd, after, orphans };
        // Same seed, fresh floor: the scene graph must match the first run's start exactly, and
        // every geometry and texture of the old floor must be disposed or reused by the new one.
        if (after.nodes !== baseline.nodes) fail('scene-node-leak', report.leak);
        if (after.floors !== 1) fail('floor-groups-after-rerun', report.leak);
        if (orphans.geometries.length || orphans.textures.length)
          fail('old-floor-gpu-leak', orphans);
        await shot('second-run');
      }
    }
  } catch (error) {
    fail('exception', { error: String(error).split('\n').slice(0, 3).join(' ') });
    await shot('exception').catch(() => {});
  } finally {
    report.roomsVisited = await ev(() => window.__fr?.visited ?? []).catch(
      () => report.roomsVisited,
    );
    writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
    await context.close();
  }
  console.log(
    `  ${seed} ${mode}: ${report.end}, ${report.fights.filter((f) => f.outcome === 'won').length} won, ` +
      `${report.failures.length} failures, ${report.console.errors.length} console errors`,
  );
  return report;

  // ---- exploring --------------------------------------------------------------------------------

  /** A drag-to-look sweep (turn right then back to the start heading), then back to yaw 0. */
  async function lookAround() {
    await turnTo(60);
    await turnTo(0);
    const yaw = await ev(() => window.__fr.pose().yaw);
    if (Math.abs(yaw) > 3) fail('drag-turn', { yaw });
  }

  /** Turns the walker to `deg` (0 north, clockwise) with mouse drags on the canvas. */
  async function turnTo(deg) {
    for (let i = 0; i < 4; i++) {
      const { yaw } = await ev(() => window.__fr.pose());
      const delta = ((((deg - yaw) % 360) + 540) % 360) - 180;
      if (Math.abs(delta) < 1) return;
      const px = delta / LOOK_DEG_PER_PX;
      const x0 = VIEWPORT.width / 2 - Math.sign(px) * Math.min(Math.abs(px) / 2, 700);
      const y = VIEWPORT.height * 0.3;
      await page.mouse.move(x0, y);
      await page.mouse.down();
      await page.mouse.move(x0 + px, y, { steps: Math.max(4, Math.ceil(Math.abs(px) / 20)) });
      await page.mouse.up();
      await wait(120);
    }
  }

  /** Walks the waypoints with WASD; returns 'fight', 'arrived' or 'stuck'. */
  async function walk(points) {
    let lastProgress = Date.now();
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const goal = points[i];
      best = Infinity;
      for (;;) {
        const pose = await ev(() => window.__fr.pose());
        if (pose.encounter !== 'idle') {
          await hold(new Set());
          return 'fight';
        }
        const dx = goal[0] - pose.x;
        const dz = goal[1] - pose.z;
        const d = Math.hypot(dx, dz);
        if (d < (i === points.length - 1 ? 0.15 : 0.25)) break;
        if (d < best - 0.03) {
          best = d;
          lastProgress = Date.now();
        } else if (Date.now() - lastProgress > 2500) {
          await hold(new Set());
          return 'stuck';
        }
        // Pick the WASD combination whose world direction is closest to the goal.
        const yaw = (pose.yaw * Math.PI) / 180;
        let pick = null;
        let bestDot = -2;
        for (const f of [-1, 0, 1]) {
          for (const s of [-1, 0, 1]) {
            if (!f && !s) continue;
            const wx = Math.sin(yaw) * f + Math.cos(yaw) * s;
            const wz = -Math.cos(yaw) * f + Math.sin(yaw) * s;
            const dot = (wx * dx + wz * dz) / (Math.hypot(wx, wz) * d);
            if (dot > bestDot) {
              bestDot = dot;
              pick = { f, s };
            }
          }
        }
        const keys = new Set();
        if (pick.f) keys.add(KEYS.f[pick.f]);
        if (pick.s) keys.add(KEYS.s[pick.s]);
        await hold(keys);
        await wait(d < 0.5 ? 25 : 50);
      }
    }
    await hold(new Set());
    return 'arrived';
  }

  /** Walks to the target room's nearest automaton until its fight opens, then plays it. */
  async function approachAndFight(target) {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await ev((room) => window.__combat.floor.encounter.isCleared(room), target.room))
        return 'next';
      const plan = await ev((room) => window.__fr.pathToEnemy(room), target.room);
      if (!plan) {
        fail('no-path', { room: target.room });
        return 'stop';
      }
      const result = await walk(plan.points);
      if (result === 'stuck') {
        // Back off and re-plan from where the walls left us.
        await hold(new Set(['KeyS']));
        await wait(400);
        await hold(new Set());
        continue;
      }
      if (result === 'arrived') {
        // Standing at the automaton without a fight: a failed placement waits out its cooldown.
        await wait(1500);
        const opened = await ev(() => window.__combat.floor.encounter.phase !== 'idle');
        if (!opened) {
          await hold(new Set(['KeyS']));
          await wait(600);
          await hold(new Set());
          continue;
        }
      }
      const room = await ev(() => window.__combat.floor.encounter.activeRoom);
      if (room !== target.room) fail('fight-in-unexpected-room', { expected: target.room, room });
      const outcome = await fight(room, target);
      if (outcome !== 'won') return 'stop';
      const ph = await phase();
      if (ph === 'victory') return 'stop';
      if (ph === 'reward') await reward(room);
      if (!(await until('explore-after-reward', () => window.__flow.flow.phase === 'explore')))
        return 'stop';
      await wait(900);
      await turnTo(0);
      return 'next';
    }
    fail('could-not-open-fight', { room: target.room });
    return 'stop';
  }

  async function reward(room) {
    await wait(700);
    const offer = await ev(() => window.__flow.flow.offer);
    await shot(`reward-r${room}`);
    const pick = offer?.cards?.[0] ?? null;
    const before = await ev(() => window.__flow.flow.run);
    await clickControl(pick ? `reward-${pick}` : 'reward-skip-skip');
    await until('reward-claimed', () => window.__flow.flow.phase === 'explore');
    const after = await ev(() => window.__flow.flow.run);
    report.rewards.push({
      room,
      offer,
      picked: pick,
      cogsBefore: before.cogs,
      cogsAfter: after.cogs,
    });
    if (pick && after.deck.length !== before.deck.length + 1)
      fail('reward-card-not-added', { room, pick });
    if (offer && after.cogs !== before.cogs + offer.cogs)
      fail('reward-cogs-mismatch', { room, offer });
    await runHp(`reward r${room}`);
  }

  async function workshop() {
    await clickControl('title-workshop');
    if (!(await until('workshop', () => window.__flow.flow.phase === 'workshop'))) return;
    await wait(400);
    const before = await ev(() => window.__flow.flow.workshop.cogsBanked);
    const ids = await ev(() =>
      window.__flow.ui.controlIds().filter((id) => id.startsWith('workshop-buy-')),
    );
    let bought = null;
    for (const id of ids) {
      const upgrade = id.slice('workshop-buy-'.length);
      if (await ev((u) => window.__flow.flow.canBuy(u), upgrade)) {
        await clickControl(id);
        bought = upgrade;
        break;
      }
    }
    const after = await ev(() => window.__flow.flow.workshop.cogsBanked);
    report.workshop = { bankedBefore: before, bought, bankedAfter: after };
    if (bought && after >= before) fail('workshop-buy-did-not-spend', report.workshop);
    await shot('workshop');
    await clickControl('workshop-back');
    await until('title-after-workshop', () => window.__flow.flow.phase === 'title');
  }

  // ---- fighting ---------------------------------------------------------------------------------

  async function fight(room, target) {
    const record = {
      room,
      tier: target.tier,
      enemies: [],
      outcome: null,
      turns: 0,
      cardsPlayed: 0,
      failedPlays: [],
      sigils: [],
      dice: [],
      hpStart: null,
      hpEnd: null,
    };
    report.fights.push(record);
    const ready = await until(
      `fight-active-r${room}`,
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
      20000,
    );
    if (!ready) return 'stuck';
    let s = await ev(() => window.__fr.snap());
    record.enemies = s.enemies.map((e) => `${e.name} ${e.hp}`);
    record.hpStart = s.player.hp;
    await wait(500);
    await shot(`fight-r${room}-open`);
    const hud = await ev(() => window.__fr.hudInView());
    if (hud.outside.length) fail('hud-out-of-view', { room, outside: hud.outside });
    let shotMid = false;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const failed = new Set();
      for (let plays = 0; plays < 12; plays++) {
        s = await ev(() => window.__fr.snap());
        if (s.outcome) break;
        const desync = await ev(() => window.__fr.readoutDesync());
        if (desync.length)
          fail('readout-desync', {
            room,
            turn: s.turn,
            time: s.time,
            now: (await ev(() => window.__fr.snap())).time,
            desync,
          });
        const choice = mode === 'death' ? null : choose(s, failed);
        if (!choice) break;
        const ok = await play(choice, record);
        if (!ok) failed.add(choice.uid);
        else record.cardsPlayed++;
        if (!shotMid && ok) {
          shotMid = true;
          await shot(`fight-r${room}-play`);
        }
      }
      s = await ev(() => window.__fr.snap());
      if (s.outcome) break;
      await endTurn(s.turn);
      s = await ev(() => window.__fr.snap());
      if (s.outcome) break;
    }
    s = await ev(() => window.__fr.snap());
    record.turns = s.turn;
    record.outcome = s.outcome;
    record.hpEnd = s.player.hp;
    record.enemiesEnd = s.enemies.map((e) => `${e.name} ${e.hp}/${e.maxHp}`);
    if (!s.outcome) {
      fail('fight-did-not-end', { room, turns: s.turn });
      return 'stuck';
    }
    await shot(`fight-r${room}-${s.outcome}`);
    console.log(
      `  r${room} ${target.tier} ${s.outcome} t${s.turn} hp${s.player.hp} played ${record.cardsPlayed}`,
    );
    const next =
      s.outcome === 'won' ? (target.tier === 'guardian' ? 'victory' : 'reward') : 'death';
    await until(`flow-${next}-r${room}`, (n) => window.__flow.flow.phase === n, next, 20000);
    await runHp(`fight r${room} ${s.outcome}`);
    if (next !== 'death') {
      const run = await ev(() => window.__flow.flow.run);
      if (run && run.hp !== s.player.hp)
        fail('run-hp-desync', { room, runHp: run.hp, fightHp: s.player.hp });
    }
    return s.outcome;
  }

  /** Deterministic test policy: lethal first, block when the intent outdamages the block, else attack. */
  function choose(s, failed) {
    const live = s.enemies.filter((e) => e.hp > 0);
    if (!live.length) return null;
    const hand = s.hand.filter((c) => c.cost <= s.player.steam && !failed.has(c.uid));
    const focus = [...live].sort((a, b) => a.hp + a.block - (b.hp + b.block))[0];
    const hits = (c) => c.dmg > 0;
    for (const c of hand.filter(hits)) {
      for (const e of live) {
        const lands = c.target === 'enemy' ? c.dmg : c.dmg / Math.max(1, live.length);
        if (lands >= e.hp + e.block) return { ...c, enemy: c.target === 'enemy' ? e.id : null };
      }
    }
    const incoming = live.reduce((n, e) => n + e.incoming, 0);
    if (incoming > s.player.block) {
      const guard = hand
        .filter((c) => c.blockGain > 0)
        .sort((a, b) => b.blockGain - a.blockGain)[0];
      if (guard) return { ...guard, enemy: guard.target === 'enemy' ? focus.id : null };
    }
    const attack = hand
      .filter(hits)
      .sort((a, b) => b.dmg / Math.max(1, b.cost) - a.dmg / Math.max(1, a.cost))[0];
    if (attack) return { ...attack, enemy: attack.target === 'enemy' ? focus.id : null };
    const other = hand.find((c) => c.blockGain === 0);
    if (other) return { ...other, enemy: other.target === 'enemy' ? focus.id : null };
    return null;
  }

  async function play(card, record) {
    const from = await ev((uid) => window.__combat.screenOf('card', uid), card.uid);
    const to = await ev(
      (enemy) =>
        enemy ? window.__combat.screenOf('enemy', enemy) : window.__combat.screenOf('table'),
      card.enemy,
    );
    if (!from || !to) {
      record.failedPlays.push({ card: card.id, why: 'no screen point' });
      return false;
    }
    await page.mouse.move(from.x, from.y, { steps: 3 });
    await wait(80);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await wait(60);
    await page.mouse.up();
    await frames(2);
    const started = Date.now();
    let traced = false;
    let threw = false;
    while (Date.now() - started < 15000) {
      await wait(120);
      const s = await ev(() => window.__fr.snap());
      const inHand = s.hand.some((c) => c.uid === card.uid);
      if (s.outcome) return true;
      if (s.awaitingThrow) {
        await page.keyboard.press('KeyT');
        threw = Date.now();
        await wait(250);
        continue;
      }
      if (s.stage === 'sigil' && s.plate === 'ready' && !traced) {
        const result = await trace(card.sigil);
        traced = true;
        record.sigils.push({ card: card.id, ...result });
        continue;
      }
      if (s.stage === 'idle' && !s.enemyPhase && s.plate !== 'drawing') {
        // A rolled card resolves (or stages its sigil) once the die settles.
        if (inHand && threw && Date.now() - threw < 5000) continue;
        if (!inHand) {
          if (threw) record.dice.push({ card: card.id, roll: s.lastRoll });
          return true;
        }
        record.failedPlays.push({ card: card.id, why: s.message || 'sprang back' });
        return false;
      }
      if ((s.stage === 'target' || s.stage === 'table') && Date.now() - started > 3000) {
        await page.keyboard.press('Escape');
        record.failedPlays.push({ card: card.id, why: `stuck in ${s.stage}` });
        return false;
      }
    }
    fail('play-timeout', { card: card.id });
    await page.keyboard.press('Escape');
    return false;
  }

  /** Traces the sigil's template strokes with the mouse on the plate (72 % of the plate). */
  async function trace(sigil) {
    const strokes = await ev((id) => window.__fr.plateStrokes(id), sigil);
    for (const stroke of strokes) {
      await page.mouse.move(stroke[0].x, stroke[0].y);
      await page.mouse.down();
      for (const p of stroke.slice(1)) await page.mouse.move(p.x, p.y, { steps: 2 });
      await page.mouse.up();
      await wait(60);
    }
    await page
      .waitForFunction(
        () =>
          window.__combat.session?.plate.phase !== 'drawing' &&
          window.__combat.session?.plate.phase !== 'ready',
        undefined,
        { timeout: 3000, polling: 50 },
      )
      .catch(() => {});
    return ev(() => window.__fr.lastSigil());
  }

  async function endTurn(turn) {
    await page.keyboard.press('KeyE');
    await frames(3);
    const ok = await page
      .waitForFunction(
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
        { timeout: 20000, polling: 100 },
      )
      .then(() => true)
      .catch(() => false);
    if (!ok) fail('end-turn-stuck', { turn, snap: await ev(() => window.__fr.snap()) });
  }
}

/** In-page helpers (read-only): state snapshots, the route, a walkable-grid path and screen maps. */
async function installHelpers() {
  const { intentDamage } = await import('/src/rules/engine.ts');
  const { SIGIL_TEMPLATES } = await import('/src/sigil/templates.ts');
  const c = window.__combat;
  const rig = c.camera.parent;
  const scene = rig.parent;
  const renderer = window.__THREE_DEVTOOLS__.objects.find((o) => o?.isWebGLRenderer);
  const visited = [];
  const amount = (a) => (typeof a === 'number' ? a : (a.base ?? 0) + a.dice * 3.5);
  const fr = {
    visited,
    pose() {
      const floor = c.floor;
      const room = floor.world.current;
      if (visited.at(-1) !== room) visited.push(room);
      return {
        x: rig.position.x,
        z: rig.position.z,
        yaw: Math.round(((-rig.rotation.y * 180) / Math.PI) * 100) / 100,
        room,
        encounter: floor.encounter.phase,
      };
    },
    /** BFS route over the door graph, entry to guardian, with each room's encounter. */
    route() {
      const plan = c.floor.world.plan;
      const prev = new Map([[0, -1]]);
      const queue = [0];
      while (queue.length) {
        const r = queue.shift();
        for (const [a, b] of plan.connections) {
          const next = a.room === r ? b.room : b.room === r ? a.room : null;
          if (next === null || prev.has(next)) continue;
          prev.set(next, r);
          queue.push(next);
        }
      }
      const path = [];
      for (let r = plan.guardianRoom; r !== -1; r = prev.get(r)) path.unshift(r);
      return path.map((room) => ({
        room,
        template: plan.rooms[room].templateId,
        role: plan.rooms[room].role,
        encounter: !!plan.rooms[room].encounter,
        tier: room === plan.guardianRoom ? 'guardian' : (plan.rooms[room].encounter?.tier ?? null),
      }));
    },
    /** A* over a 0.1 m grid of the floor's footprints minus the colliders (inflated by the body). */
    pathToEnemy(room) {
      const world = c.floor.world;
      const body = (world.enemies.get(room) ?? []).find((b) => b.parent !== null);
      if (!body) return null;
      const goalV = body.getWorldPosition(body.position.clone());
      const cell = 0.1;
      const inflate = 0.32;
      const rects = world.rooms.map((r) => r.footprint);
      const minX = Math.min(...rects.map((r) => r.min[0]));
      const minZ = Math.min(...rects.map((r) => r.min[1]));
      const maxX = Math.max(...rects.map((r) => r.max[0]));
      const maxZ = Math.max(...rects.map((r) => r.max[1]));
      const W = Math.ceil((maxX - minX) / cell) + 1;
      const H = Math.ceil((maxZ - minZ) / cell) + 1;
      const free = new Uint8Array(W * H);
      const boxes = world.colliders.flat().filter((b) => b.max[1] > 0.1 && b.min[1] < 1.8);
      for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
          const x = minX + i * cell;
          const z = minZ + j * cell;
          if (!rects.some((r) => x >= r.min[0] && x <= r.max[0] && z >= r.min[1] && z <= r.max[1]))
            continue;
          let hit = false;
          for (const b of boxes) {
            if (
              x > b.min[0] - inflate &&
              x < b.max[0] + inflate &&
              z > b.min[2] - inflate &&
              z < b.max[2] + inflate
            ) {
              hit = true;
              break;
            }
          }
          if (!hit) free[j * W + i] = 1;
        }
      }
      const toCell = (x, z) => [Math.round((x - minX) / cell), Math.round((z - minZ) / cell)];
      const nearestFree = ([ci, cj]) => {
        for (let r = 0; r < 40; r++) {
          for (let dj = -r; dj <= r; dj++) {
            for (let di = -r; di <= r; di++) {
              if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
              const i = ci + di;
              const j = cj + dj;
              if (i >= 0 && j >= 0 && i < W && j < H && free[j * W + i]) return [i, j];
            }
          }
        }
        return null;
      };
      const start = nearestFree(toCell(rig.position.x, rig.position.z));
      const goal = nearestFree(toCell(goalV.x, goalV.z));
      if (!start || !goal) return null;
      const idx = (i, j) => j * W + i;
      const g = new Float32Array(W * H).fill(Infinity);
      const from = new Int32Array(W * H).fill(-1);
      const open = [[0, idx(...start)]];
      g[idx(...start)] = 0;
      const h = (k) => Math.hypot((k % W) - goal[0], Math.floor(k / W) - goal[1]);
      const goalK = idx(...goal);
      const push = (item) => {
        open.push(item);
        let n = open.length - 1;
        while (n > 0) {
          const p = (n - 1) >> 1;
          if (open[p][0] <= open[n][0]) break;
          [open[p], open[n]] = [open[n], open[p]];
          n = p;
        }
      };
      const pop = () => {
        const top = open[0];
        const last = open.pop();
        if (open.length) {
          open[0] = last;
          let n = 0;
          for (;;) {
            const l = 2 * n + 1;
            const r = l + 1;
            let m = n;
            if (l < open.length && open[l][0] < open[m][0]) m = l;
            if (r < open.length && open[r][0] < open[m][0]) m = r;
            if (m === n) break;
            [open[m], open[n]] = [open[n], open[m]];
            n = m;
          }
        }
        return top;
      };
      while (open.length) {
        const [, k] = pop();
        if (k === goalK) break;
        const i = k % W;
        const j = Math.floor(k / W);
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ni = i + di;
            const nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= W || nj >= H) continue;
            const nk = idx(ni, nj);
            if (!free[nk]) continue;
            if (di && dj && (!free[idx(i + di, j)] || !free[idx(i, j + dj)])) continue;
            const cost = g[k] + (di && dj ? Math.SQRT2 : 1);
            if (cost < g[nk]) {
              g[nk] = cost;
              from[nk] = k;
              push([cost + h(nk), nk]);
            }
          }
        }
      }
      if (from[goalK] === -1 && goalK !== idx(...start)) return null;
      const cells = [];
      for (let k = goalK; k !== -1; k = from[k]) cells.unshift(k);
      // Keep only the corners of the grid path.
      const points = [];
      for (let n = 0; n < cells.length; n++) {
        const k = cells[n];
        const prevK = cells[n - 1];
        const nextK = cells[n + 1];
        const dir = (a, b) => `${(b % W) - (a % W)},${Math.floor(b / W) - Math.floor(a / W)}`;
        if (n === cells.length - 1 || (n > 0 && dir(prevK, k) !== dir(k, nextK)))
          points.push([minX + (k % W) * cell, minZ + Math.floor(k / W) * cell]);
      }
      return { points, length: g[goalK] * cell };
    },
    snap() {
      const s = c.session;
      if (!s) return { outcome: null, stage: 'none', hand: [], enemies: [], player: {}, turn: 0 };
      const st = s.controller.state;
      const live = st.enemies.filter((e) => e.hp > 0).length;
      const estimate = (def) => {
        let dmg = 0;
        let blockGain = 0;
        for (const e of def.effects) {
          if (e.type === 'damage')
            dmg += amount(e.amount) * (e.hits ?? 1) * (e.target === 'all-opponents' ? live : 1);
          if (e.type === 'block') blockGain += amount(e.amount);
        }
        return { dmg, blockGain };
      };
      return {
        outcome: s.controller.outcome,
        time: s.time,
        stage: s.stage,
        enemyPhase: s.enemyPhase,
        awaitingThrow: s.awaitingThrow,
        plate: s.plate.phase,
        message: s.message ?? '',
        turn: st.turn,
        phase: st.phase,
        lastRoll: s.rolls.at(-1)?.value ?? null,
        player: {
          hp: st.player.hp,
          maxHp: st.player.maxHp,
          block: st.player.block,
          steam: st.player.steam,
        },
        enemies: st.enemies.map((e) => ({
          id: e.id,
          name: e.name,
          hp: e.hp,
          maxHp: e.maxHp,
          block: e.block,
          incoming: e.hp > 0 ? intentDamage(st, e.id).reduce((a, b) => a + b, 0) : 0,
        })),
        hand: st.piles.hand.map((card) => ({
          uid: card.uid,
          id: card.def.id,
          cost: card.def.cost,
          target: card.def.target,
          sigil: card.def.sigil ?? null,
          ...estimate(card.def),
        })),
      };
    },
    /** Screen points of the sigil template, fitted to 72 % of the plate. */
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
    lastSigil() {
      const s = c.session;
      return {
        log: s?.log.slice(-2) ?? [],
        plate: s?.plate.phase ?? null,
        points: s?.plate.pointCount ?? null,
      };
    },
    /** Readouts whose drawn numbers differ from the rules state (checked between player actions). */
    readoutDesync() {
      const s = c.session;
      if (!s || s.enemyPhase || s.dirty || s.stage !== 'idle') return [];
      const st = s.controller.state;
      const out = [];
      for (const { id, label } of s.labels) {
        const e = st.enemies.find((x) => x.id === id);
        if (!e || e.hp <= 0) continue;
        const texts = label.canvas.__texts ?? [];
        if (!texts.includes(`${e.hp}/${e.maxHp}`))
          out.push({ id, want: `${e.hp}/${e.maxHp}`, drawn: texts });
      }
      const p = st.player;
      const status = s.status?.canvas.__texts ?? null;
      if (status && !(status.includes(`${p.hp}/${p.maxHp}`) && status.includes(String(p.steam))))
        out.push({ id: 'player', want: [`${p.hp}/${p.maxHp}`, p.steam], drawn: status });
      return out;
    },
    /** HUD elements whose projected corners leave the view. */
    hudInView() {
      const s = c.session;
      const outside = [];
      c.camera.updateMatrixWorld(true);
      for (const { name, points } of s.hudPoints()) {
        for (const p of points) {
          const v = p.clone().project(c.camera);
          if (Math.abs(v.x) > 1.001 || Math.abs(v.y) > 1.001 || v.z > 1) {
            outside.push(name);
            break;
          }
        }
      }
      return { outside };
    },
    /** Marks every geometry and texture under the current floor, listening for their dispose. */
    trackFloor() {
      const tracked = new Map();
      const seen = (res, kind, where) => {
        if (!res || tracked.has(res)) return;
        tracked.set(res, { kind, where, disposed: false });
        res.addEventListener('dispose', () => {
          tracked.get(res).disposed = true;
        });
      };
      const visit = (root) =>
        root.traverse((o) => {
          if (o.geometry) seen(o.geometry, 'geometry', o.name || o.type);
          for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])
            for (const v of Object.values(m))
              if (v?.isTexture) seen(v, 'texture', `${o.name || o.type}:${m.name || m.type}`);
        });
      visit(c.floor.world.group);
      for (const t of [c.floor.encounter?.table].filter(Boolean)) visit(t);
      fr.tracked = tracked;
      return tracked.size;
    },
    /** Old-floor resources neither disposed nor used anywhere in the current scene. */
    floorOrphans() {
      const live = new Set();
      scene.traverse((o) => {
        if (o.geometry) live.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])
          for (const v of Object.values(m)) if (v?.isTexture) live.add(v);
      });
      const out = { tracked: fr.tracked?.size ?? 0, geometries: [], textures: [] };
      for (const [res, info] of fr.tracked ?? []) {
        if (info.disposed || live.has(res)) continue;
        out[info.kind === 'geometry' ? 'geometries' : 'textures'].push(info.where);
      }
      out.geometries = out.geometries.slice(0, 40);
      out.textures = out.textures.slice(0, 40);
      return out;
    },
    /** Scene nodes, floor groups and GPU memory, for the cross-floor leak check. */
    census() {
      let nodes = 0;
      scene.traverse(() => {
        nodes++;
      });
      const floors = scene.children.filter(
        (o) => o === c.floor.world.group || o.name === c.floor.world.group.name,
      ).length;
      return {
        nodes,
        floors,
        geometries: renderer?.info.memory.geometries ?? null,
        textures: renderer?.info.memory.textures ?? null,
        programs: renderer?.info.programs?.length ?? null,
      };
    },
  };
  window.__fr = fr;
  return true;
}
