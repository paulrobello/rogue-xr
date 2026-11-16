#!/usr/bin/env node
// Automated desktop full run: plays seeded runs of the real game on the dev server in headless
// Chromium on the GPU, with the same inputs a desktop player uses. WASD walks the floor room to
// room through its doors, a mouse drag turns the view, cards are dragged at an automaton or onto
// the table, `T` throws dice, sigils are traced with the mouse on the plate and `E` ends the turn.
// The `?debug` hooks are read for state and screen positions only; nothing here writes rules state.
// A run clears the non-elite fights in the side wings first, then takes the route to the
// guardian, opening any treasure coffer a cleared way offers (a mouse click on its lid, checked against
// the panel it shows) just before the guardian; an elite is fought only when it stands on that route
// (see the policy block below). A rest-room hearth is used (a mouse click on its bowl) over a cleared
// route when the bot is hurt, and any left over just before the guardian; the hp it gives is checked
// against the rule. The guardian fight is watched frame by frame for its phase 2 (see watchGuardian).
// Each run picks its difficulty on the title (a click on the level's button) before New Run. The
// default is Hard, the content as written, so the recorded outcomes stay comparable across passes.
//
//   node scripts/full-run/run.mjs [--base http://localhost:4260] [--out /tmp/full-run]
//        [--seeds SPIRE001,SPIRE002] [--death SPIRE001] [--difficulty hard] [--headed]
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
    seeds: {
      type: 'string',
      default:
        'SPIRE001,SPIRE002,SPIRE003,SPIRE004,SPIRE010,SPIRE034,SPIRE021,SPIRE024,SPIRE065,SPIRE086',
    },
    death: { type: 'string', default: 'SPIRE001' },
    difficulty: { type: 'string', default: 'hard' },
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
const DIFFICULTY = opts.difficulty;
if (!['casual', 'normal', 'hard'].includes(DIFFICULTY)) {
  console.error(`--difficulty must be casual, normal or hard, not ${DIFFICULTY}`);
  process.exit(2);
}
/** Degrees of turn per pixel of drag (src/desktop/controls.ts LOOK_DEGREES_PER_PIXEL). */
const LOOK_DEG_PER_PX = 0.23;
const MUSIC = /\/audio\/music\/|music not found/;

/**
 * The bot's policy. It reads only what a player sees: hand, steam, hp, block, statuses and the
 * intents on the enemies. It never reads the draw pile, the rng streams or an enemy's later moves.
 * A turn is planned by searching the orders of the cards in hand with expected dice rolls and a
 * perfectly traced sigil (x1.25), scoring damage dealt against the hp the visible intents would take.
 */
const POLICY = {
  hpWeight: 4,
  killBonus: 4,
  woundValue: 6,
  overheatValue: 0.7,
  sigilPower: 1.25,
  rewardMin: 3,
  dupPenalty: 1,
  optional: 'regular',
};
/** The bot walks to a hearth early when it is missing at least this much hp; the last one is always used. */
const HEARTH_MIN_MISSING = 10;
/** Length of the guardian's phase-change clip in seconds (its manifest). */
const PHASE_CLIP_SECONDS = 3.0;
const DIE_MEAN = { 'brass-d6': 3.5, 'glass-d8': 4.5 };

const stackOf = (st, id) => st?.[id] || 0;

/** Mirrors rules/statuses.ts attackDamage. */
function hitDamage(base, attacker, defender) {
  let d = base + stackOf(attacker, 'wound-up');
  if (stackOf(attacker, 'weak') > 0) d = Math.floor(d * 0.75);
  if (stackOf(defender, 'vulnerable') > 0) d = Math.floor(d * 1.5);
  return Math.max(0, d);
}

function amountOf(a, card) {
  if (typeof a === 'number') return a;
  const mean = DIE_MEAN[card.dice] ?? 3.5;
  return (a.base ?? 0) + a.dice * mean;
}

function scaled(x, card) {
  if (!card.sigil) return Math.floor(x);
  return Math.floor(x * POLICY.sigilPower + 0.5 + 1e-9);
}

function cloneModel(m) {
  return {
    hp: m.hp,
    block: m.block,
    steam: m.steam,
    pst: { ...m.pst },
    bonus: m.bonus,
    enemies: m.enemies.map((e) => ({ ...e, st: { ...e.st } })),
  };
}

/** Plays `card` at `target` (enemy id or null) into model `m`, in place. */
function applyCard(m, card, target) {
  m.steam -= card.cost;
  for (const e of card.effects) {
    if (e.type === 'damage') {
      const base = scaled(amountOf(e.amount, card), card);
      const targets =
        e.target === 'all-opponents'
          ? m.enemies.filter((x) => x.hp > 0)
          : m.enemies.filter((x) => x.id === target && x.hp > 0);
      for (let h = 0; h < (e.hits ?? 1); h++) {
        for (const t of targets) {
          if (t.hp <= 0) continue;
          const d = hitDamage(base, m.pst, t.st);
          const blocked = Math.min(t.block, d);
          t.block -= blocked;
          const lost = Math.min(t.hp, d - blocked);
          t.hp -= lost;
          t.dealt += lost;
        }
      }
    } else if (e.type === 'block') {
      m.block += scaled(amountOf(e.amount, card), card);
    } else if (e.type === 'gain-steam') {
      m.steam += amountOf(e.amount, card);
      m.bonus += 0.5;
    } else if (e.type === 'draw') {
      m.bonus += 2.5 * amountOf(e.amount, card);
    } else if (e.type === 'apply-status') {
      const n = scaled(amountOf(e.stacks, card), card);
      if (e.target === 'self') {
        m.pst[e.status] = stackOf(m.pst, e.status) + n;
        if (e.status === 'wound-up') m.bonus += POLICY.woundValue * n * m.woundScale;
      } else {
        const targets =
          e.target === 'all-opponents'
            ? m.enemies.filter((x) => x.hp > 0)
            : m.enemies.filter((x) => x.id === target && x.hp > 0);
        for (const t of targets) {
          t.st[e.status] = stackOf(t.st, e.status) + n;
          if (e.status === 'overheat') {
            const had = stackOf(t.st, 'overheat') - n;
            const total = ((had + n) * (had + n + 1)) / 2 - (had * (had + 1)) / 2;
            m.bonus += Math.min(total, t.hp) * POLICY.overheatValue;
          }
        }
      }
    }
  }
}

/** Score of the position after the player's turn: damage progress minus the hp the visible intents take. */
function leaf(m) {
  let score = m.bonus;
  for (const e of m.enemies) {
    score += e.dealt;
    if (e.hp <= 0) score += POLICY.killBonus;
  }
  if (m.enemies.every((e) => e.hp <= 0)) return score + 1000;
  let block = m.block;
  let hpLoss = 0;
  for (const e of m.enemies) {
    if (e.hp <= 0 || !e.intent) continue;
    for (const f of e.intent.effects) {
      if (f.type !== 'damage') continue;
      for (let h = 0; h < (f.hits ?? 1); h++) {
        const d = hitDamage(typeof f.amount === 'number' ? f.amount : 0, e.st, m.pst);
        const absorbed = Math.min(block, d);
        block -= absorbed;
        hpLoss += d - absorbed;
      }
    }
    // The enemy's own block, buffs and overheat tick on its next action are not modelled.
  }
  // Dying to the visible intents is the one outcome that ends the run.
  if (hpLoss >= m.hp) score -= 500;
  return score - POLICY.hpWeight * Math.min(hpLoss, m.hp);
}

const KIND_ORDER = (c) =>
  c.effects.some((e) => e.type === 'apply-status' && e.target === 'self')
    ? 0
    : c.effects.some((e) => e.type === 'gain-steam' || e.type === 'draw')
      ? 1
      : c.effects.some((e) => e.type === 'apply-status')
        ? 2
        : c.effects.some((e) => e.type === 'damage')
          ? 3
          : 4;

/** The next card to play this turn as `{ uid, id, enemy }`, or null to end the turn. */
function choose(s, failed = new Set()) {
  const live = s.enemies.filter((e) => e.hp > 0);
  if (!live.length) return null;
  const hand = s.hand.filter((c) => !failed.has(c.uid));
  const totalHp = live.reduce((n, e) => n + e.hp, 0);
  const root = {
    hp: s.player.hp,
    block: s.player.block,
    steam: s.player.steam,
    pst: { ...(s.player.statuses ?? {}) },
    bonus: 0,
    woundScale: Math.max(0.5, Math.min(1.5, totalHp / 60)),
    enemies: live.map((e) => ({
      id: e.id,
      hp: e.hp,
      block: e.block,
      st: { ...(e.statuses ?? {}) },
      intent: e.intent ?? null,
      dealt: 0,
    })),
  };
  let best = null;
  const search = (m, cards, first, depth) => {
    const value = leaf(m);
    if (first) {
      const better =
        !best ||
        value > best.value + 1e-9 ||
        (Math.abs(value - best.value) <= 1e-9 &&
          (depth < best.depth ||
            (depth === best.depth && KIND_ORDER(first.card) < KIND_ORDER(best.first.card))));
      if (better) best = { value, first, depth };
    }
    if (depth >= 7) return;
    const seen = new Set();
    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      if (card.cost > m.steam) continue;
      const targets =
        card.target === 'enemy' ? m.enemies.filter((e) => e.hp > 0).map((e) => e.id) : [null];
      for (const target of targets) {
        const key = `${card.id}:${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const next = cloneModel(m);
        next.woundScale = m.woundScale;
        applyCard(next, card, target);
        search(
          next,
          cards.filter((_, j) => j !== i),
          first ?? { card, target },
          depth + 1,
        );
      }
    }
  };
  search(root, hand, null, 0);
  if (!best) return null;
  // Only play when it beats ending the turn now.
  const idle = leaf(root);
  if (best.value <= idle + 1e-9) return null;
  const { card, target } = best.first;
  return { ...card, enemy: target };
}

/**
 * Side-wing encounter rooms to clear before the route to the guardian, wing by wing in door order.
 * `rooms` are `{ room, wing, depth, tier, count }`; `mode` is none, cheap (a lone automaton) or regular.
 * A wing stops at its elite: the rooms behind it are only reachable through that fight.
 */
function optionalRooms(rooms, path, mode) {
  if (mode === 'none') return [];
  const onPath = new Set(path);
  const wings = new Map();
  for (const r of rooms) {
    if (r.room === 0 || onPath.has(r.room)) continue;
    wings.set(r.wing, [...(wings.get(r.wing) ?? []), r]);
  }
  const out = [];
  for (const list of wings.values()) {
    list.sort((a, b) => a.depth - b.depth);
    for (const r of list) {
      if (!r.tier) continue;
      if (r.tier === 'elite' || (mode === 'cheap' && r.count > 1)) break;
      out.push(r.room);
    }
  }
  return out;
}

const REWARD_SCORE = {
  'arc-bolt': 9,
  'furnace-brand': 8,
  'escapement-hammer': 7,
  'warding-glyph': 7,
  'spanner-jam': 6,
  overwind: 6,
  'ratchet-flurry': 5,
  'time-spiral': 5,
  cogstorm: 4,
  'release-valve': 4,
  'lucky-rivets': 3,
  'cog-toss': 4,
  'rivet-volley': 2,
};

/** Best offered card for the deck (or null to skip). */
function pickReward(offer, deck) {
  let best = null;
  for (const id of offer.cards) {
    const have = deck.filter((d) => d === id).length;
    const score = (REWARD_SCORE[id] ?? 0) - (id === 'furnace-brand' ? 0 : POLICY.dupPenalty * have);
    if (!best || score > best.score) best = { id, score };
  }
  return best && best.score >= POLICY.rewardMin ? best.id : null;
}

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
  hpEnd: r.hpCurve.at(-1)?.hp ?? null,
  hearthsUsed: r.hearth.filter((h) => h.gained !== undefined).length,
  hearthGained: r.hearth.reduce((n, h) => n + (h.gained ?? 0), 0),
  hearthSkipped: r.hearth.filter((h) => h.skipped).length,
  phaseHp: r.guardianPhase?.hpAtChange ?? null,
  phaseTurn: r.guardianPhase?.turnAtChange ?? null,
  phase2Moves: r.guardianPhase?.phase2MovesSeen?.join('+') ?? null,
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
    difficulty: DIFFICULTY,
    end: 'unfinished',
    gpu: null,
    roomsVisited: [],
    route: [],
    fights: [],
    rewards: [],
    treasure: [],
    hearth: [],
    guardianPhase: null,
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
  page.on('crash', () => fail('page-crash'));
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

    await clickControl(`title-difficulty-${DIFFICULTY}`);
    await clickControl('title-new-run');
    if (!(await until('explore', () => window.__flow.flow.phase === 'explore'))) return report;
    const runLevel = await ev(() => window.__flow.flow.run.difficulty);
    if (runLevel !== DIFFICULTY) fail('wrong-difficulty', { runLevel, want: DIFFICULTY });
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

    // Side-wing fights first (cards and cogs before the elite and guardian), then the route's encounters.
    const route = report.route.filter((r) => r.encounter);
    const rooms = await ev(() => window.__fr.encounters());
    const side = optionalRooms(
      rooms,
      report.route.map((r) => r.room),
      POLICY.optional,
    ).map((room) => ({ room, tier: rooms.find((r) => r.room === room).tier }));
    report.sideFights = side.map((t) => t.room);
    // Treasure is opened just before the guardian. A pickup draws from the `loot` stream the rewards
    // share, so opening one earlier would change every later offer (and the deck the elite and guardian
    // meet); at this point only the guardian's own purse, a flat 60, is left to draw.
    const targets = [...side, ...route];
    for (const [i, target] of targets.entries()) {
      const lastStop = i === targets.length - 1 && target.tier === 'guardian' && mode !== 'death';
      // A hearth burns no random draw, so a hurt bot can use one early without shifting any offer.
      if (mode !== 'death') await hearths(lastStop);
      if (lastStop) await treasure();
      if ((await approachAndFight(target)) === 'stop') break;
    }
    const end = await phase();
    report.end = end === 'victory' || end === 'death' ? end : `stopped in ${end}`;
    if (end === 'victory' || end === 'death') {
      report.summary = await ev(() => window.__flow.flow.summary);
      if (report.summary?.difficulty !== DIFFICULTY)
        fail('summary-wrong-difficulty', { summary: report.summary?.difficulty, want: DIFFICULTY });
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

  /** Opens every coffer the route offers: walk up, aim the mouse at the lid, click, check the find. */
  async function treasure() {
    const coffers = await ev(() => window.__fr.coffers());
    for (const coffer of coffers) {
      const record = { room: coffer.room, socketId: coffer.socketId, planned: coffer.kind };
      report.treasure.push(record);
      if (!(await ev((room) => window.__fr.routeIsClear(room), coffer.room))) {
        record.skipped = 'an uncleared encounter stands on the way';
        continue;
      }
      let arrived = false;
      for (let attempt = 0; attempt < 4 && !arrived; attempt++) {
        const plan = await ev((name) => window.__fr.pathToCoffer(name), coffer.name);
        if (!plan) {
          fail('no-path-to-coffer', { room: coffer.room });
          record.skipped = 'no path';
          break;
        }
        const result = await walk(plan.points);
        if (result === 'fight') {
          fail('fight-on-the-way-to-coffer', { room: coffer.room });
          return;
        }
        if (result === 'arrived') arrived = true;
        else {
          await hold(new Set(['KeyS']));
          await wait(400);
          await hold(new Set());
        }
      }
      if (!arrived) {
        if (!record.skipped) fail('could-not-reach-coffer', { room: coffer.room });
        continue;
      }
      await turnTo(await ev((name) => window.__fr.bearingTo(name), coffer.name));
      await wait(400);
      const room = await ev(() => window.__combat.floor.world.current);
      if (room !== coffer.room) fail('coffer-room-not-current', { room, want: coffer.room });
      await shot(`treasure-closed-r${coffer.room}`);
      const before = await ev(() => window.__fr.treasureState());
      if (before.opened) fail('coffer-open-before-click', { room: coffer.room });
      const point = await ev((name) => window.__combat.screenOfCoffer(name), coffer.name);
      const onScreen =
        point &&
        point.x > 0 &&
        point.y > 0 &&
        point.x < VIEWPORT.width &&
        point.y < VIEWPORT.height;
      if (!onScreen) {
        fail('coffer-not-on-screen', { room: coffer.room, point });
        continue;
      }
      await page.mouse.move(point.x, point.y, { steps: 4 });
      await wait(120);
      await page.mouse.click(point.x, point.y);
      const opened = await until(
        'coffer-opened',
        () => window.__fr.treasureState().opened,
        undefined,
        5000,
      );
      if (!opened) continue;
      await wait(1000);
      const after = await ev(() => window.__fr.treasureState());
      await shot(`treasure-opened-r${coffer.room}`);
      const brief = (run) => ({ cogs: run.cogs, hp: run.hp, deck: run.deck.length });
      Object.assign(record, {
        before: brief(before.run),
        after: brief(after.run),
        added: after.run.deck.slice(before.run.deck.length),
        shown: after.toast,
        found: after.last?.loot ?? null,
      });
      checkTreasure(coffer, before, after);
      // A second click on the open coffer changes nothing.
      await page.mouse.move(point.x, point.y, { steps: 2 });
      await page.mouse.click(point.x, point.y);
      await wait(500);
      const again = await ev(() => window.__fr.treasureState());
      if (JSON.stringify(again.run) !== JSON.stringify(after.run))
        fail('coffer-paid-twice', { room: coffer.room, after: after.run, again: again.run });
      // The pickup is on disk: the saved snapshot holds the opened key and the purse and deck as shown.
      await ev(() => window.__flow.flushed());
      const saved = await ev(async () => {
        const { openDb } = await import('/src/persist/db.ts');
        const { loadRunSnapshot } = await import('/src/persist/saves.ts');
        const snap = await loadRunSnapshot(await openDb());
        return snap
          ? { openedLoot: snap.run.openedLoot ?? [], cogs: snap.run.cogs, deck: snap.run.deck }
          : null;
      });
      record.saved = saved;
      const key = `${coffer.room}/${coffer.socketId}`;
      const matches =
        saved?.openedLoot.includes(key) &&
        saved.cogs === after.run.cogs &&
        saved.deck.join() === after.run.deck.join();
      if (!matches) fail('coffer-not-saved', { saved, key, run: after.run });
      await runHp(`treasure r${coffer.room}`);
      await wait(900);
      await turnTo(0);
    }
  }

  /** The find must be the one shown, of the planned kind, and change only what it names. */
  function checkTreasure(coffer, before, after) {
    const text = after.toast?.text ?? null;
    if (!text) return fail('coffer-no-toast', { room: coffer.room });
    if (!after.toast.drawn.includes(text)) fail('coffer-toast-not-drawn', after.toast);
    const cogsGain = after.run.cogs - before.run.cogs;
    const deckGain = after.run.deck.length - before.run.deck.length;
    const found = after.last?.loot;
    if (after.last?.room !== coffer.room || after.last?.socketId !== coffer.socketId)
      fail('coffer-wrong-pickup', { last: after.last });
    if (found?.kind !== coffer.kind) fail('coffer-kind-mismatch', { planned: coffer.kind, found });
    const cogs = /^\+(\d+) cogs$/.exec(text);
    const card = /^New card: (.+)$/.exec(text);
    if (cogs) {
      const n = Number(cogs[1]);
      if (cogsGain !== n || deckGain !== 0 || n < 15 || n > 25)
        fail('coffer-cogs-mismatch', { text, cogsGain, deckGain });
      if (found?.cogs !== n) fail('coffer-cogs-differ-from-result', { text, found });
    } else if (card) {
      const added = after.run.deck.at(-1);
      if (cogsGain !== 0 || deckGain !== 1 || after.cardNames[added] !== card[1])
        fail('coffer-card-mismatch', { text, cogsGain, deckGain, added });
      if (found?.card !== added) fail('coffer-card-differs-from-result', { text, found, added });
    } else fail('coffer-toast-unreadable', { text });
    for (const stream of ['floor', 'deck', 'dice', 'ai'])
      if (JSON.stringify(after.run.rng[stream]) !== JSON.stringify(before.run.rng[stream]))
        fail('coffer-advanced-another-stream', { stream });
    if (JSON.stringify(after.run.rng.loot) === JSON.stringify(before.run.rng.loot))
      fail('coffer-did-not-draw-loot', {});
    if (after.run.hp !== before.run.hp)
      fail('coffer-changed-hp', { before: before.run.hp, after: after.run.hp });
    if (!after.run.openedLoot.includes(`${coffer.room}/${coffer.socketId}`))
      fail('coffer-not-recorded', { openedLoot: after.run.openedLoot });
  }

  /**
   * Visits the floor's unused hearths over cleared routes. Early (before a fight) only when the bot
   * is missing `HEARTH_MIN_MISSING` hp or more, and every remaining one at the last stop before the guardian.
   */
  async function hearths(lastStop) {
    const list = await ev(() => window.__fr.hearths());
    for (const hearth of list) {
      if (hearth.used) continue;
      const run = await ev(() => window.__flow.flow.run);
      if (!lastStop && run.maxHp - run.hp < HEARTH_MIN_MISSING) continue;
      const clear = await ev((room) => window.__fr.routeIsClear(room), hearth.room);
      let record = report.hearth.find((h) => h.name === hearth.name);
      if (!record) {
        record = { room: hearth.room, socketId: hearth.socketId, name: hearth.name };
        report.hearth.push(record);
      }
      if (!clear) {
        record.skipped = 'an uncleared encounter stands on the way';
        continue;
      }
      delete record.skipped;
      await useHearth(hearth, record);
    }
  }

  /** Walks up to a hearth, clicks its bowl and checks what it gives, once and only once. */
  async function useHearth(hearth, record) {
    let arrived = false;
    for (let attempt = 0; attempt < 4 && !arrived; attempt++) {
      const plan = await ev((name) => window.__fr.pathToHearth(name), hearth.name);
      if (!plan) {
        fail('no-path-to-hearth', { room: hearth.room });
        record.skipped = 'no path';
        return;
      }
      const result = await walk(plan.points);
      if (result === 'fight') {
        fail('fight-on-the-way-to-hearth', { room: hearth.room });
        return;
      }
      if (result === 'arrived') arrived = true;
      else {
        await hold(new Set(['KeyS']));
        await wait(400);
        await hold(new Set());
      }
    }
    if (!arrived) {
      fail('could-not-reach-hearth', { room: hearth.room });
      return;
    }
    await turnTo(await ev((name) => window.__fr.bearingTo(name), hearth.name));
    await wait(500);
    const room = await ev(() => window.__combat.floor.world.current);
    if (room !== hearth.room) fail('hearth-room-not-current', { room, want: hearth.room });
    const before = await ev((name) => window.__fr.hearthState(name), hearth.name);
    await shot(`rest-lit-r${hearth.room}`);
    if (before.used) fail('hearth-used-before-click', { room: hearth.room });
    if (before.glow < 0.9) fail('hearth-coals-not-lit', { glow: before.glow });
    const point = await ev((name) => window.__combat.screenOfCoffer(name, 0.6), hearth.name);
    const onScreen =
      point && point.x > 0 && point.y > 0 && point.x < VIEWPORT.width && point.y < VIEWPORT.height;
    if (!onScreen) {
      fail('hearth-not-on-screen', { room: hearth.room, point });
      return;
    }
    await page.mouse.move(point.x, point.y, { steps: 4 });
    await wait(120);
    await page.mouse.click(point.x, point.y);
    const used = await until(
      'hearth-used',
      (name) => window.__fr.hearthState(name).used,
      hearth.name,
      5000,
    );
    if (!used) return;
    await wait(2000);
    const after = await ev((name) => window.__fr.hearthState(name), hearth.name);
    await shot(`rest-used-r${hearth.room}`);
    const rule = await ev(() => window.__fr.hearthRule());
    const missing = before.run.maxHp - before.run.hp;
    const want = Math.min(missing, Math.floor(before.run.maxHp * rule.fraction));
    Object.assign(record, {
      hpBefore: before.run.hp,
      hpAfter: after.run.hp,
      maxHp: before.run.maxHp,
      missing,
      want,
      shown: after.toast,
      gained: after.run.hp - before.run.hp,
      glowBefore: before.glow,
      glowAfter: after.glow,
    });
    checkHearth(hearth, before, after, want);
    // A second click on the spent hearth changes nothing.
    await page.mouse.move(point.x, point.y, { steps: 2 });
    await page.mouse.click(point.x, point.y);
    await wait(500);
    const again = await ev((name) => window.__fr.hearthState(name), hearth.name);
    if (JSON.stringify(again.run) !== JSON.stringify(after.run))
      fail('hearth-healed-twice', { room: hearth.room, after: after.run, again: again.run });
    // The use is on disk: the saved snapshot holds the used key and the hp as shown.
    await ev(() => window.__flow.flushed());
    const saved = await ev(async () => {
      const { openDb } = await import('/src/persist/db.ts');
      const { loadRunSnapshot } = await import('/src/persist/saves.ts');
      const snap = await loadRunSnapshot(await openDb());
      return snap ? { usedHearths: snap.run.usedHearths ?? [], hp: snap.run.hp } : null;
    });
    record.saved = saved;
    const key = `${hearth.room}/${hearth.socketId}`;
    if (!(saved?.usedHearths.includes(key) && saved.hp === after.run.hp))
      fail('hearth-not-saved', { saved, key, run: after.run });
    await runHp(`hearth r${hearth.room}`);
    await wait(900);
    await turnTo(0);
  }

  /** The heal must be the one shown, equal to the rule, and change only hp and the used list. */
  function checkHearth(hearth, before, after, want) {
    const text = after.toast?.text ?? null;
    if (!text) return fail('hearth-no-toast', { room: hearth.room });
    if (!after.toast.drawn.includes(text)) fail('hearth-toast-not-drawn', after.toast);
    const n = /^\+(\d+) hp$/.exec(text)?.[1];
    if (n === undefined) return fail('hearth-toast-unreadable', { text });
    const gained = after.run.hp - before.run.hp;
    if (gained !== Number(n)) fail('hearth-hp-differs-from-panel', { text, gained });
    if (gained !== want) fail('hearth-hp-differs-from-rule', { gained, want });
    if (after.run.hp > after.run.maxHp) fail('hearth-over-max-hp', { hp: after.run.hp });
    if (after.last?.room !== hearth.room || after.last?.socketId !== hearth.socketId)
      fail('hearth-wrong-use', { last: after.last });
    if (after.last?.healed !== gained || after.last?.hp !== after.run.hp)
      fail('hearth-last-differs', { last: after.last, gained });
    if (after.run.cogs !== before.run.cogs) fail('hearth-changed-cogs', {});
    if (after.run.deck.join() !== before.run.deck.join()) fail('hearth-changed-deck', {});
    if (JSON.stringify(after.run.openedLoot) !== JSON.stringify(before.run.openedLoot))
      fail('hearth-changed-loot-record', {});
    for (const stream of ['floor', 'deck', 'dice', 'loot', 'ai'])
      if (JSON.stringify(after.run.rng[stream]) !== JSON.stringify(before.run.rng[stream]))
        fail('hearth-advanced-a-stream', { stream });
    if (!after.run.usedHearths.includes(`${hearth.room}/${hearth.socketId}`))
      fail('hearth-not-recorded', { usedHearths: after.run.usedHearths });
    if (!after.used) fail('hearth-not-spent', {});
    if (!(after.glow < 0.3)) fail('hearth-coals-not-dimmed', { glow: after.glow });
  }

  async function reward(room) {
    await wait(700);
    const offer = await ev(() => window.__flow.flow.offer);
    await shot(`reward-r${room}`);
    const before = await ev(() => window.__flow.flow.run);
    const pick = offer ? pickReward(offer, before.deck) : null;
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
    const guardian = target.tier === 'guardian' && mode !== 'death';
    if (guardian) await ev(() => window.__fr.watchGuardian());
    const caseShots = new Set();
    /** Screenshots of the case opening and open, taken the first time each is seen. */
    const phaseShots = async () => {
      if (!guardian) return;
      const p = await ev(() => window.__fr.guardianNow());
      if (p?.opening && !caseShots.has('mid')) {
        caseShots.add('mid');
        await wait(1600);
        await shot('guardian-phase-opening');
      } else if (p?.open && !caseShots.has('open')) {
        caseShots.add('open');
        await wait(400);
        await shot('guardian-phase-open');
      }
    };
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const failed = new Set();
      for (let plays = 0; plays < 20; plays++) {
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
        await phaseShots();
      }
      s = await ev(() => window.__fr.snap());
      if (s.outcome) break;
      await endTurn(s.turn);
      await phaseShots();
      s = await ev(() => window.__fr.snap());
      if (s.outcome) break;
    }
    s = await ev(() => window.__fr.snap());
    if (guardian) {
      await wait(500);
      await phaseShots();
      const log = await ev(() => window.__fr.stopGuardian());
      record.guardianPhase = report.guardianPhase = await checkGuardianPhase(log, s.outcome);
    }
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

  /**
   * Checks the guardian's second phase against the frame log of its fight: rules phase and hp, the
   * shown intent, and the actor's clip state. Returns the facts it found.
   */
  async function checkGuardianPhase(log, outcome) {
    const rule = await ev(() => window.__fr.guardianRule());
    // The threshold is a fraction of the guardian's max hp in this fight, which the difficulty scales.
    rule.threshold = (log[0]?.maxHp ?? Number.NaN) * rule.fraction;
    const only2 = new Set(rule.phaseTwoOnly);
    const all6 = new Set(rule.phaseTwo);
    const facts = {
      frames: log.length,
      threshold: rule.threshold,
      outcome,
      hpAtChange: null,
      hpBeforeChange: null,
      turnAtChange: null,
      phase2MovesSeen: [],
      movesBefore: [],
      movesAfter: [],
      clipStates: [...new Set(log.map((r) => r.actor))],
      phaseChanges: log.at(-1)?.changes ?? null,
    };
    if (!log.length) {
      fail('guardian-phase-no-frames', {});
      return facts;
    }
    const first = log.findIndex((r) => r.phase === 2);
    const pre = first < 0 ? log : log.slice(0, first);
    for (const r of pre) {
      if (r.hp > 0 && r.hp <= rule.threshold) fail('guardian-phase-1-at-or-below-threshold', r);
      if (r.phase !== 1) fail('guardian-phase-not-1-before-change', r);
      if (r.changes !== 0 || r.actor === 'phase-change' || r.opening || r.open)
        fail('guardian-case-moved-before-change', r);
      for (const m of [r.intent, r.move]) {
        if (m && only2.has(m)) fail('guardian-phase-2-move-in-phase-1', { move: m, row: r });
        if (m && !facts.movesBefore.includes(m)) facts.movesBefore.push(m);
      }
    }
    if (first < 0) {
      // Never reached the threshold: only a kill from above it, or a lost fight, may end that way.
      facts.note = 'the guardian never fell to the threshold';
      if (outcome === 'won' && log.at(-1).hp > 0) fail('guardian-won-without-phase-change', {});
      return facts;
    }
    const row = log[first];
    facts.hpAtChange = row.hp;
    facts.hpBeforeChange = log[first - 1]?.hp ?? null;
    facts.turnAtChange = row.turn;
    if (row.hp > rule.threshold) fail('guardian-phase-hp-above-threshold', { row });
    if (facts.hpBeforeChange !== null && facts.hpBeforeChange <= rule.threshold)
      fail('guardian-phase-late', { before: log[first - 1], row });
    // The intent on screen when the change lands stays until the enemy acts; the next comes from phase 2.
    for (const r of log.slice(first)) {
      if (r.enemyPhase) break;
      for (const m of [r.intent, r.move])
        if (m && only2.has(m)) fail('guardian-intent-swapped-at-change', { move: m, row: r });
    }
    const after = log.slice(first).filter((r) => r.turn > row.turn);
    for (const r of after) {
      for (const m of [r.intent, r.move]) {
        if (!m) continue;
        if (!all6.has(m)) fail('guardian-intent-outside-phase-2-list', { move: m });
        if (!facts.movesAfter.includes(m)) facts.movesAfter.push(m);
        if (only2.has(m) && !facts.phase2MovesSeen.includes(m)) facts.phase2MovesSeen.push(m);
      }
    }
    // The clip: exactly one start, seen playing, the case open at the end and never shut again.
    const last = log.at(-1);
    if (last.changes !== 1) fail('guardian-phase-clip-count', { changes: last.changes });
    if (!log.some((r) => r.actor === 'phase-change' && r.opening))
      fail('guardian-phase-clip-not-played', { states: facts.clipStates });
    // A fight can end inside the 3 s clip (the player falls in the turn after the change): then the
    // case must still be opening, never shut.
    const sinceChange = last.t - row.t;
    facts.secondsFromChangeToEnd = Math.round(sinceChange * 100) / 100;
    if (!last.open && !(last.opening && sinceChange < PHASE_CLIP_SECONDS + 0.3))
      fail('guardian-case-not-open-at-end', { last, sinceChange });
    const opened = log.findIndex((r) => r.open);
    if (opened >= 0) {
      facts.secondsToOpen = Math.round((log[opened].t - row.t) * 100) / 100;
      for (const r of log.slice(opened))
        if (!r.open) fail('guardian-case-closed-again', { row: r });
    }
    for (const r of log) if (r.changes > 1) fail('guardian-phase-clip-twice', { row: r });
    console.log(
      `  guardian phase 2 at hp ${row.hp} (turn ${row.turn}), moves after: ${facts.movesAfter.join(',')}`,
    );
    return facts;
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
  const { SIGIL_TEMPLATES } = await import('/src/sigil/templates.ts');
  const { CARDS } = await import('/src/content/cards.ts');
  const c = window.__combat;
  const rig = c.camera.parent;
  const scene = rig.parent;
  const renderer = window.__THREE_DEVTOOLS__.objects.find((o) => o?.isWebGLRenderer);
  const visited = [];
  const fr = {
    visited,
    cardNames: Object.fromEntries(CARDS.map((card) => [card.id, card.name])),
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
    /** Every room with its wing, depth and encounter (tier, automaton count). */
    encounters() {
      return c.floor.world.plan.rooms.map((r) => ({
        room: r.index,
        wing: r.wing,
        depth: r.depth,
        tier: r.encounter?.tier ?? null,
        count: r.encounter?.socketIds.length ?? 0,
      }));
    },
    /** A* over a 0.1 m grid of the floor's footprints minus the colliders (inflated by the body). */
    pathToEnemy(room) {
      const body = (c.floor.world.enemies.get(room) ?? []).find((b) => b.parent !== null);
      if (!body) return null;
      return fr.pathTo(body.getWorldPosition(body.position.clone()));
    },
    /** Every coffer on the floor: its plan, name and whether it is open. */
    coffers() {
      return c.floor.loot.coffers.map((k) => ({
        room: k.room,
        socketId: k.socketId,
        kind: k.kind,
        name: k.object.name,
        opened: k.opened,
      }));
    },
    /** True when no uncleared encounter stands in a room between the entry and `room` (`room` aside). */
    routeIsClear(room) {
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
      for (let r = prev.get(room); r > 0; r = prev.get(r)) {
        if (plan.rooms[r].encounter && !c.floor.encounter.isCleared(r)) return false;
      }
      return true;
    },
    /** Every hearth on the floor: its plan, name and whether it is spent. */
    hearths() {
      return c.floor.hearth.hearths.map((h) => ({
        room: h.room,
        socketId: h.socketId,
        name: h.object.name,
        used: h.used,
      }));
    },
    /** A* path to a standing point 3 m from the hearth, toward its room's centre. */
    pathToHearth(name) {
      const h = c.floor.hearth.hearths.find((k) => k.object.name === name);
      const at = h && c.floor.hearth.approachPoint(h.room, h.socketId, 3);
      return at ? fr.pathTo(at) : null;
    },
    /** The run, the hearth's coals and its panel as the player sees them right now. */
    hearthState(name) {
      const flow = window.__flow.flow;
      const run = flow.run;
      const h = c.floor.hearth.hearths.find((k) => k.object.name === name);
      const toast = c.floor.hearth.toast;
      const color = h.object.getObjectByName('hearth-coals').material.color;
      return {
        used: h.used,
        glow: color.r + color.g + color.b,
        run: {
          cogs: run.cogs,
          hp: run.hp,
          maxHp: run.maxHp,
          deck: [...run.deck],
          rng: JSON.parse(JSON.stringify(run.rng)),
          openedLoot: [...(run.openedLoot ?? [])],
          usedHearths: [...(run.usedHearths ?? [])],
        },
        last: flow.lastHearth ? JSON.parse(JSON.stringify(flow.lastHearth)) : null,
        toast: toast ? { text: toast.text, drawn: [...(toast.canvas.__texts ?? [])] } : null,
      };
    },
    /** The hearth rule's own constant, read from the game. */
    async hearthRule() {
      const { HEARTH_HEAL_FRACTION } = await import('/src/rules/run.ts');
      return { fraction: HEARTH_HEAL_FRACTION };
    },
    /** The guardian rule's own numbers, read from the game. */
    async guardianRule() {
      const { ENEMIES, GUARDIAN_PHASE_TWO_HP_FRACTION } = await import('/src/content/enemies.ts');
      const g = ENEMIES['grand-escapement'];
      const one = g.moves.map((m) => m.id);
      const two = g.phaseTwo.moves.map((m) => m.id);
      return {
        fraction: GUARDIAN_PHASE_TWO_HP_FRACTION,
        phaseOne: one,
        phaseTwo: two,
        phaseTwoOnly: two.filter((id) => !one.includes(id)),
      };
    },
    /** The guardian's rules hp and phase, its shown move and its actor's clip state, right now. */
    guardianNow() {
      const s = c.session;
      const st = s?.controller.state;
      const e = st?.enemies.find((x) => x.id === 'grand-escapement');
      if (!s || !e) return null;
      const ent = s.enemies.find((x) => x.id === 'grand-escapement');
      const actor = ent ? c.floor.actorOf(ent.body) : null;
      const texts = s.labels.find((l) => l.id === e.id)?.label.canvas.__texts ?? [];
      const move = texts.map((t) => /move: (\S+)/.exec(t)?.[1]).find(Boolean) ?? null;
      return {
        t: performance.now() / 1000,
        turn: st.turn,
        hp: e.hp,
        maxHp: e.maxHp,
        phase: e.phase ?? null,
        intent: e.intent?.id ?? null,
        move,
        enemyPhase: s.enemyPhase,
        actor: actor?.state ?? null,
        opening: actor?.caseOpening ?? false,
        open: actor?.caseOpen ?? false,
        changes: actor?.phaseChanges ?? 0,
      };
    },
    /** Starts logging the guardian every animation frame, keeping only the frames where something changed. */
    watchGuardian() {
      const log = [];
      let running = true;
      let lastKey = '';
      const tick = () => {
        if (!running) return;
        const row = fr.guardianNow();
        if (row) {
          const { t: _t, ...rest } = row;
          const key = JSON.stringify(rest);
          if (key !== lastKey) {
            lastKey = key;
            log.push(row);
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      fr.guardianWatch = {
        log,
        stop() {
          running = false;
        },
      };
    },
    stopGuardian() {
      fr.guardianWatch?.stop();
      return fr.guardianWatch?.log ?? [];
    },
    /** A* path to a standing point 2 m from the coffer, toward its room's centre. */
    pathToCoffer(name) {
      const coffer = c.floor.loot.coffers.find((k) => k.object.name === name);
      const at = coffer && c.floor.loot.approachPoint(coffer.room, coffer.socketId, 2);
      return at ? fr.pathTo(at) : null;
    },
    /** Compass bearing in degrees (0 north, clockwise) from the player to a coffer. */
    bearingTo(name) {
      const node = c.floor.world.group.getObjectByName(name);
      const p = node.getWorldPosition(rig.position.clone());
      return (Math.atan2(p.x - rig.position.x, -(p.z - rig.position.z)) * 180) / Math.PI;
    },
    /** The run and the coffer panel as the player sees them right now. */
    treasureState() {
      const flow = window.__flow.flow;
      const run = flow.run;
      const toast = c.floor.loot.toast;
      return {
        opened: c.floor.loot.coffers.some((k) => k.opened),
        run: {
          cogs: run.cogs,
          hp: run.hp,
          deck: [...run.deck],
          rng: JSON.parse(JSON.stringify(run.rng)),
          openedLoot: [...(run.openedLoot ?? [])],
        },
        last: flow.lastLoot ? JSON.parse(JSON.stringify(flow.lastLoot)) : null,
        toast: toast ? { text: toast.text, drawn: [...(toast.canvas.__texts ?? [])] } : null,
        cardNames: fr.cardNames,
      };
    },
    /** A* over a 0.1 m grid of the floor's footprints minus the colliders (inflated by the body), to a world point. */
    pathTo(goalV) {
      const world = c.floor.world;
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
      const g = new Float64Array(W * H).fill(Infinity);
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
          statuses: st.player.statuses,
        },
        enemies: st.enemies.map((e) => ({
          id: e.id,
          name: e.name,
          hp: e.hp,
          maxHp: e.maxHp,
          block: e.block,
          statuses: e.statuses,
          intent: e.intent ? { id: e.intent.id, effects: e.intent.effects } : null,
        })),
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
