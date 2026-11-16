#!/usr/bin/env node
// Emulated-XR walk: drives the app's immersive-session paths in headless Chromium on the GPU,
// with Meta's IWER standing in for a Quest 3. Emulator evidence only: it does not replace a
// headset run (no real compositor, foveation or framebuffer scale is applied by the emulator).
//
//   node scripts/xr-emu/walk.mjs [--base http://localhost:4260] [--out docs/verification]
//                                [--seed BRASS042] [--headed]
//   node scripts/xr-emu/walk.mjs --notice http://localhost:4262   (update-notice check only)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4260' },
    out: { type: 'string', default: join(root, 'docs/verification') },
    seed: { type: 'string', default: 'BRASS042' },
    notice: { type: 'string' },
    headed: { type: 'boolean', default: false },
    // Only the card fan and sigil checks: New Run, one fight, then stop.
    focus: { type: 'boolean', default: false },
    // Only the enemy-phase checks: one two-automaton fight on TURN_SEED.
    turns: { type: 'boolean', default: false },
    // Only the turned-away Enter VR check (XO5): the title must be re-placed in front of the head.
    recenter: { type: 'boolean', default: false },
    // Only the treasure check: open a coffer with the controller ray and trigger.
    treasure: { type: 'boolean', default: false },
    // Only the rest-room check: use a hearth with the controller ray and trigger.
    rest: { type: 'boolean', default: false },
    // Only the guardian phase check: fight the Grand Escapement until its case opens.
    guardian: { type: 'boolean', default: false },
    // Only the comfort checks: the Settings toggles, New Run, then locomotion (move, turn, vignette, teleport).
    loco: { type: 'boolean', default: false },
  },
});

/** macOS GPU flags; PW_GPU=swiftshader opts into software GL. */
const GPU_ARGS =
  (process.env.PW_GPU ?? 'metal') === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const SEATED_HEAD_Y = 1.2;
/** Seed whose first regular room seats two automatons (a Cog Sentry and a Spring Hound). */
const TURN_SEED = 'SPIRE002';
/** Seed with a treasure room holding a card coffer (room 3, found with `generateFloor`). */
const TREASURE_SEED = 'SPIRE001';
/** Seed whose floor has one rest room (room 4, a hall), found with `generateFloor`. */
const REST_SEED = 'SPIRE007';
/** Share of max hp a hearth restores (HEARTH_HEAL_FRACTION in src/rules/run.ts). */
const HEARTH_FRACTION = 0.3;
/** Seed for the guardian fight (any floor has one vault). */
const GUARDIAN_SEED = 'SPIRE004';
const MAIN = 'right';
const OFF = 'left';
/** Controller offsets from the head, in tracking space: hands low and forward, as when seated. */
const HAND_OFFSET = { right: [0.18, -0.28, -0.3], left: [-0.18, -0.28, -0.3] };

const results = [];
const record = (id, pass, detail) => {
  results.push({ id, pass, detail });
  console.log(`${pass === true ? 'PASS' : pass === false ? 'FAIL' : 'NOTE'} ${id}`, detail);
};

const iwerUmd = readFileSync(join(root, 'node_modules/iwer/build/iwer.min.js'), 'utf8');
const hooks = readFileSync(join(here, 'page-hooks.js'), 'utf8');

mkdirSync(opts.out, { recursive: true });
const browser = await chromium.launch({
  channel: 'chromium',
  headless: !opts.headed,
  args: GPU_ARGS,
});
const consoleErrors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.addInitScript({ content: `${iwerUmd}\n${hooks}` });
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  const shot = async (name) => {
    const path = join(opts.out, `xr-emu-${name}.jpg`);
    await page.screenshot({ path, type: 'jpeg', quality: 82 });
    console.log(`  screenshot ${path}`);
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const settle = (ms = 250) => page.waitForTimeout(ms);
  const phase = () => ev(() => window.__flow.flow.phase);
  const waitFor = async (label, fn, arg, timeout = 15000) => {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: 100 });
      return true;
    } catch {
      record(`wait:${label}`, false, `timed out after ${timeout} ms`);
      return false;
    }
  };

  /** Aims a controller's ray at a world point; the other hand rests low and forward. */
  const aim = (hand, target) =>
    ev(
      ({ hand, target, offsets }) => {
        const probe = window.__xrEmu;
        const other = hand === 'right' ? 'left' : 'right';
        const rest = probe.worldOf('player-rig', [0, 0, -5]);
        probe.aimAt(other, rest, offsets[other]);
        return probe.aimAt(hand, target, offsets[hand]);
      },
      { hand, target, offsets: HAND_OFFSET },
    );
  const pullTrigger = async (hand) => {
    await ev((h) => window.__xrEmu.device.controllers[h].updateButtonValue('trigger', 1), hand);
    await settle(150);
    await ev((h) => window.__xrEmu.device.controllers[h].updateButtonValue('trigger', 0), hand);
    await settle(250);
  };
  /** Points the main hand at a board control, checks the hover, then pulls the trigger. */
  const press = async (controlId, hand = MAIN) => {
    const target = await ev((id) => window.__xrEmu.worldOf(id), controlId);
    if (!target) {
      record(`press:${controlId}`, false, 'control not on the boards');
      return false;
    }
    await aim(hand, target);
    await settle(200);
    const hovered = await ev(() => window.__flow.ui.hoveredId);
    await pullTrigger(hand);
    return hovered;
  };

  const gpu = async () =>
    ev(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });

  const enterVr = async (yaw = 0) => {
    await waitFor(
      'enter-vr-enabled',
      () => {
        const b = [...document.querySelectorAll('button')].find(
          (x) => x.textContent === 'Enter VR',
        );
        return b && !b.disabled;
      },
      undefined,
      30000,
    );
    await ev(({ y, yaw }) => window.__xrEmu.setHead(y, 0, yaw), { y: SEATED_HEAD_Y, yaw });
    const button = page.getByRole('button', { name: 'Enter VR' });
    try {
      await button.click({ timeout: 3000 });
      record('enter-vr-clickable', true, {});
    } catch (error) {
      // Something covers the button (the desktop update bar sits on it): note it, press it anyway.
      const cover = await button.evaluate((b) => {
        const r = b.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top?.closest('[id]')?.id ?? top?.tagName ?? null;
      });
      record('enter-vr-clickable', false, {
        coveredBy: cover,
        error: String(error).split('\n')[0],
      });
      await button.evaluate((b) => b.click());
    }
    await waitFor('presenting', () => window.__xrEmu.ctx().renderer?.xr.isPresenting === true);
    await settle(800);
  };

  if (opts.notice) {
    await noticeCheck();
  } else if (opts.turns) {
    await enemyTurnCheck();
  } else if (opts.recenter) {
    await recenterCheck();
  } else if (opts.treasure) {
    await treasureCheck();
  } else if (opts.rest) {
    await restCheck();
  } else if (opts.guardian) {
    await guardianPhaseCheck();
    await guardianPhaseTwoCheck();
  } else if (opts.loco) {
    await walk();
  } else {
    await walk();
    await enemyTurnCheck();
    await recenterCheck();
    await treasureCheck();
    await restCheck();
    await guardianPhaseCheck();
    await guardianPhaseTwoCheck();
  }

  /**
   * P6 treasure: a seated player points the main-hand ray at the treasure room's coffer and pulls the
   * trigger. It opens once, pays exactly what the panel shows, saves, and stays open on a second pull.
   */
  async function treasureCheck() {
    const base = opts.base.replace(/\/$/, '');
    await page.goto(`${base}/?seed=${TREASURE_SEED}&debug`);
    await waitFor(
      'treasure-app',
      () => window.__combat?.floor && window.__xrEmu.ctx().renderer,
      undefined,
      60000,
    );
    await ev(() => window.__combat.heroReady);
    await settle(1500);
    await enterVr();
    const name = await ev(() => window.__combat.teleportToLoot());
    record('xr-treasure-teleport', typeof name === 'string' && name.startsWith('coffer-'), {
      name,
    });
    if (!name) return;
    await settle(1200);
    // Turn the seated head toward the coffer (tracking yaw is relative to the rig's heading).
    await ev((coffer) => {
      const probe = window.__xrEmu;
      const { rig } = probe.ctx();
      const at = probe.worldOf(coffer, [0, 0.25, 0]);
      const { head } = probe.headTo(at);
      const dx = at.x - head.x;
      const dz = at.z - head.z;
      const yaw = Math.atan2(-dx, -dz) - rig.rotation.y;
      probe.setHead(1.2, Math.atan2(at.y - head.y, Math.hypot(dx, dz)), yaw);
    }, name);
    await settle(500);
    const state = () =>
      ev(
        async ({ coffer }) => {
          const flow = window.__flow.flow;
          const { getCard } = await import('/src/content/cards.ts');
          const run = flow.run;
          const toast = window.__combat.floor.loot.toast;
          const last = flow.lastLoot;
          const shown =
            last?.loot.kind === 'cogs'
              ? `+${last.loot.cogs} cogs`
              : last
                ? `New card: ${getCard(last.loot.card).name}`
                : null;
          const lid = window.__combat.floor.world.group
            .getObjectByName(coffer)
            ?.getObjectByName('coffer-lid');
          return {
            phase: flow.phase,
            cogs: run.cogs,
            deck: run.deck.length,
            opened: run.openedLoot ?? [],
            toast: toast?.text ?? null,
            shown,
            lid: lid?.rotation.x ?? null,
            board: window.__flow.ui.visible,
          };
        },
        { coffer: name },
      );
    const before = await state();
    await shot('17-treasure-closed');
    const target = await ev((coffer) => window.__xrEmu.worldOf(coffer, [0, 0.25, 0]), name);
    await aim(MAIN, target);
    await settle(300);
    await pullTrigger(MAIN);
    await settle(900);
    const after = await state();
    await shot('17-treasure-opened');
    const paid = after.cogs - before.cogs;
    const cards = after.deck - before.deck;
    record(
      'xr-treasure-trigger-opens-coffer',
      after.opened.length === 1 && before.opened.length === 0 && (after.lid ?? 0) > 1.5,
      { before, after },
    );
    record(
      'xr-treasure-pays-what-the-panel-shows',
      after.toast !== null &&
        after.toast === after.shown &&
        ((paid > 0 && cards === 0) || (paid === 0 && cards === 1)),
      {
        toast: after.toast,
        shown: after.shown,
        paid,
        cards,
      },
    );
    record('xr-treasure-no-board-lock', after.phase === 'explore' && after.board === false, {
      phase: after.phase,
      board: after.board,
    });
    const inView = await ev(() => {
      const { renderer, camera } = window.__xrEmu.ctx();
      const eye = renderer.xr.getCamera().cameras?.[0] ?? camera;
      const panel = window.__combat.floor.world.group.getObjectByName('loot-toast-root');
      if (!panel) return null;
      const p = panel.getWorldPosition(panel.position.clone()).project(eye);
      return { x: p.x, y: p.y, z: p.z };
    });
    record(
      'xr-treasure-panel-in-view',
      inView !== null && Math.abs(inView.x) < 1 && Math.abs(inView.y) < 1 && inView.z < 1,
      inView,
    );
    await aim(MAIN, target);
    await pullTrigger(MAIN);
    await settle(400);
    const again = await state();
    record(
      'xr-treasure-second-pull-pays-nothing',
      again.cogs === after.cogs && again.deck === after.deck && again.opened.length === 1,
      { after, again },
    );
    await ev(() => window.__flow.flushed());
    const saved = await ev(async () => {
      const { openDb } = await import('/src/persist/db.ts');
      const { loadRunSnapshot } = await import('/src/persist/saves.ts');
      const snap = await loadRunSnapshot(await openDb());
      return snap
        ? { opened: snap.run.openedLoot ?? [], cogs: snap.run.cogs, deck: snap.run.deck.length }
        : null;
    });
    record(
      'xr-treasure-saved',
      saved !== null &&
        saved.opened.length === 1 &&
        saved.cogs === again.cogs &&
        saved.deck === again.deck,
      saved,
    );

    // Resume: reload to the title, Continue with the ray. The coffer is open at once, nothing is
    // repaid, and the ray and trigger no longer open it.
    await page.goto(`${base}/?title&debug`);
    await waitFor(
      'treasure-reload',
      () => window.__flow?.ui && window.__xrEmu.ctx().renderer,
      undefined,
      60000,
    );
    await ev(() => window.__combat.heroReady);
    await settle(1500);
    await enterVr();
    const hasContinue = await ev(() => window.__xrEmu.worldOf('title-continue') !== null);
    if (hasContinue) await press('title-continue');
    await settle(1000);
    const resumed = await state();
    const lidOpen = await ev((coffer) => {
      const node = window.__combat.floor.world.group.getObjectByName(coffer);
      return {
        opened: window.__combat.floor.loot.coffers.some((k) => k.opened),
        lid: node?.getObjectByName('coffer-lid')?.rotation.x ?? null,
        panel: window.__combat.floor.loot.toast !== null,
      };
    }, name);
    await shot('18-treasure-resumed');
    record(
      'xr-treasure-resume-shows-coffer-open',
      hasContinue &&
        resumed.phase === 'explore' &&
        resumed.cogs === again.cogs &&
        resumed.deck === again.deck &&
        resumed.opened.length === 1 &&
        lidOpen.opened &&
        (lidOpen.lid ?? 0) > 1.5 &&
        !lidOpen.panel,
      { hasContinue, resumed, lidOpen },
    );
    await aim(MAIN, target);
    await pullTrigger(MAIN);
    await settle(400);
    const repulled = await state();
    record(
      'xr-treasure-resume-cannot-reopen',
      repulled.cogs === resumed.cogs &&
        repulled.deck === resumed.deck &&
        repulled.opened.length === 1 &&
        repulled.toast === null,
      { resumed, repulled },
    );
    await ev(() => window.__xrEmu.ctx().renderer.xr.getSession()?.end());
    await settle(400);
  }

  /**
   * P6 rest room: a seated player takes real damage in a real fight, walks to the rest room's hearth,
   * aims the main-hand ray at it and pulls the trigger. It heals once by exactly what the panel shows
   * (30 percent of max hp rounded down, capped at the missing hp), dims, saves, and does nothing on a
   * second pull or after a resume.
   */
  async function restCheck() {
    const base = opts.base.replace(/\/$/, '');
    await page.goto(`${base}/?seed=${REST_SEED}&debug`);
    await waitFor(
      'rest-app',
      () => window.__combat?.floor && window.__xrEmu.ctx().renderer,
      undefined,
      60000,
    );
    await ev(() => window.__combat.heroReady);
    await settle(1500);
    await enterVr();

    // Lose hp the way a player does: a fight where the enemy's turns land, then a debug win (K) and
    // the reward skipped with the ray. The hp the fight ends with is what the run keeps.
    await ev(() => window.__flow.setCheat('win'));
    await ev(() => window.__combat.teleportToEncounter());
    await waitFor(
      'rest-fight-active',
      () => window.__combat.floor.encounter.phase === 'active' && window.__combat.session !== null,
      undefined,
      30000,
    );
    await settle(1500);
    for (let turn = 0; turn < 4; turn += 1) {
      const hp = await ev(() => window.__combat.session.controller.state.player.hp);
      if (hp <= 50) break;
      await page.keyboard.press('KeyE');
      await settle(300);
      await enemyPhaseOver(`rest-turn-${turn}`);
      await settle(1500);
    }
    // The debug K key ends a fight without carrying its hp into the run, so the cheat-1-hp automaton
    // is killed with a played card through the controller (the path a desktop click takes) and the
    // fight ends the way a won one does, keeping the player's hp.
    const killed = await ev(() => {
      const c = window.__combat.session.controller;
      const card = c.state.piles.hand.find(
        (h) => h.def.target === 'enemy' && h.def.cost <= c.state.player.steam,
      );
      const enemy = c.state.enemies.find((e) => e.hp > 0);
      if (!card || !enemy) return { ok: false, reason: 'no attack card or target' };
      return c.select(card.uid).ok ? c.target(enemy.id) : { ok: false, reason: 'select failed' };
    });
    record('xr-rest-fight-won-by-a-played-card', killed.ok === true, killed);
    await waitFor('rest-reward', () => window.__flow.flow.phase === 'reward', undefined, 30000);
    await settle(800);
    await press('reward-skip-skip');
    await waitFor('rest-explore', () => window.__flow.flow.phase === 'explore');
    const wounded = await ev(() => ({
      hp: window.__flow.flow.run.hp,
      maxHp: window.__flow.flow.run.maxHp,
    }));
    record('xr-rest-wounded-by-a-real-fight', wounded.hp < wounded.maxHp, wounded);

    const name = await ev(() => window.__combat.teleportToHearth());
    record('xr-rest-teleport', typeof name === 'string' && name.startsWith('hearth-'), { name });
    if (!name) return;
    await settle(1200);
    await ev((hearth) => {
      const probe = window.__xrEmu;
      const { rig } = probe.ctx();
      const at = probe.worldOf(hearth, [0, 0.6, 0]);
      const { head } = probe.headTo(at);
      const dx = at.x - head.x;
      const dz = at.z - head.z;
      const yaw = Math.atan2(-dx, -dz) - rig.rotation.y;
      probe.setHead(1.2, Math.atan2(at.y - head.y, Math.hypot(dx, dz)), yaw);
    }, name);
    await settle(500);

    const state = () =>
      ev(
        ({ hearth }) => {
          const flow = window.__flow.flow;
          const floor = window.__combat.floor;
          const run = flow.run;
          const lit = floor.hearth.hearths.find((h) => h.object.name === hearth);
          const coals = lit?.object.getObjectByName('hearth-coals')?.material.color;
          let nodes = 0;
          floor.world.group.traverse(() => {
            nodes += 1;
          });
          return {
            phase: flow.phase,
            hp: run.hp,
            maxHp: run.maxHp,
            cogs: run.cogs,
            deck: run.deck.length,
            used: run.usedHearths ?? [],
            toast: floor.hearth.toast?.text ?? null,
            last: flow.lastHearth,
            spent: lit?.used ?? null,
            coals: coals ? coals.r + coals.g + coals.b : null,
            nodes,
            board: window.__flow.ui.visible,
          };
        },
        { hearth: name },
      );
    /** The game's own pick along each controller's -Z beam (what the laser ends on): the hearths it reaches. */
    const beam = () =>
      ev(() => {
        const { renderer } = window.__xrEmu.ctx();
        const floor = window.__combat.floor;
        const hits = [];
        for (const index of [0, 1]) {
          const controller = renderer.xr.getController(index);
          controller.updateWorldMatrix(true, false);
          const e = controller.matrixWorld.elements;
          const origin = controller.position.clone().set(e[12], e[13], e[14]);
          const direction = controller.position.clone().set(-e[8], -e[9], -e[10]).normalize();
          const hit = floor.hearth.pick(origin, direction);
          if (hit) hits.push({ index, distance: hit.distance, room: hit.room });
        }
        return hits;
      });

    const before = await state();
    await settle(600);
    const lit = await state();
    const target = await ev((hearth) => window.__xrEmu.worldOf(hearth, [0, 0.6, 0]), name);
    await shot('19-rest-hearth-lit');
    await aim(MAIN, target);
    await settle(300);
    const aimed = await beam();
    record(
      'xr-rest-beam-ends-on-hearth',
      aimed.length === 1 && aimed[0].distance > 1 && aimed[0].distance < 4,
      aimed,
    );
    await pullTrigger(MAIN);
    await settle(900);
    const after = await state();
    await shot('19-rest-hearth-used');
    const missing = before.maxHp - before.hp;
    const want = Math.min(missing, Math.floor(before.maxHp * HEARTH_FRACTION));
    const gained = after.hp - before.hp;
    record(
      'xr-rest-trigger-heals-what-the-panel-shows',
      after.toast === `+${gained} hp` && after.last?.healed === gained && gained === want,
      { before: before.hp, after: after.hp, maxHp: before.maxHp, want, toast: after.toast },
    );
    record(
      'xr-rest-hearth-spent-and-recorded',
      after.spent === true &&
        before.spent === false &&
        after.used.length === 1 &&
        after.used[0] === `${after.last?.room}/chest` &&
        before.used.length === 0,
      { used: after.used, last: after.last },
    );
    record(
      'xr-rest-coals-dim',
      lit.coals !== null && after.coals !== null && after.coals < lit.coals * 0.3,
      { lit: lit.coals, spent: after.coals },
    );
    record(
      'xr-rest-changes-only-hp',
      after.cogs === before.cogs && after.deck === before.deck && after.phase === 'explore',
      { before, after },
    );
    record('xr-rest-no-board-lock', after.phase === 'explore' && after.board === false, {
      phase: after.phase,
      board: after.board,
    });
    const inView = await ev(() => {
      const { renderer, camera } = window.__xrEmu.ctx();
      const eye = renderer.xr.getCamera().cameras?.[0] ?? camera;
      const panel = window.__combat.floor.world.group.getObjectByName('loot-toast-root');
      if (!panel) return null;
      const p = panel.getWorldPosition(panel.position.clone()).project(eye);
      return { x: p.x, y: p.y, z: p.z };
    });
    record(
      'xr-rest-panel-in-view',
      inView !== null && Math.abs(inView.x) < 1 && Math.abs(inView.y) < 1 && inView.z < 1,
      inView,
    );
    await aim(MAIN, target);
    await settle(300);
    const beamAfter = await beam();
    await pullTrigger(MAIN);
    await settle(400);
    const again = await state();
    record(
      'xr-rest-second-pull-heals-nothing',
      beamAfter.length === 0 &&
        again.hp === after.hp &&
        again.used.length === 1 &&
        again.last?.healed === after.last?.healed,
      { after: after.hp, again: again.hp, beamAfter },
    );
    // The panel expires and takes its nodes with it: the hearth leaves the scene as it found it.
    await waitFor(
      'rest-panel-gone',
      () => window.__combat.floor.hearth.toast === null,
      undefined,
      8000,
    );
    const settled = await state();
    record(
      'xr-rest-no-stale-panel-or-nodes',
      settled.toast === null && settled.nodes === before.nodes,
      { before: before.nodes, settled: settled.nodes, toast: settled.toast },
    );
    await ev(() => window.__flow.flushed());
    const saved = await ev(async () => {
      const { openDb } = await import('/src/persist/db.ts');
      const { loadRunSnapshot } = await import('/src/persist/saves.ts');
      const snap = await loadRunSnapshot(await openDb());
      return snap ? { used: snap.run.usedHearths ?? [], hp: snap.run.hp } : null;
    });
    record(
      'xr-rest-saved',
      saved !== null && saved.used.length === 1 && saved.hp === again.hp,
      saved,
    );

    // Resume: reload to the title, Continue with the ray. The hearth is spent at once, nothing is
    // healed again, and the ray and trigger no longer use it.
    await page.goto(`${base}/?title&debug`);
    await waitFor(
      'rest-reload',
      () => window.__flow?.ui && window.__xrEmu.ctx().renderer,
      undefined,
      60000,
    );
    await ev(() => window.__combat.heroReady);
    await settle(1500);
    await enterVr();
    const hasContinue = await ev(() => window.__xrEmu.worldOf('title-continue') !== null);
    if (hasContinue) await press('title-continue');
    await settle(1000);
    const resumed = await state();
    await shot('20-rest-resumed');
    record(
      'xr-rest-resume-shows-hearth-spent',
      hasContinue &&
        resumed.phase === 'explore' &&
        resumed.hp === again.hp &&
        resumed.used.length === 1 &&
        resumed.spent === true &&
        resumed.toast === null &&
        resumed.coals !== null &&
        resumed.coals < lit.coals * 0.3,
      { hasContinue, resumed },
    );
    await aim(MAIN, target);
    await pullTrigger(MAIN);
    await settle(400);
    const repulled = await state();
    record(
      'xr-rest-resume-cannot-reuse',
      repulled.hp === resumed.hp && repulled.used.length === 1 && repulled.toast === null,
      { resumed: resumed.hp, repulled: repulled.hp },
    );
    await ev(() => window.__xrEmu.ctx().renderer.xr.getSession()?.end());
    await settle(400);
  }

  /**
   * P6 guardian phase 1 in XR: the guardian model carries its phase-change clip, stands with its case
   * closed, never plays the clip, and shows only the four phase-1 moves as intents over real enemy
   * turns. Pinned to Hard (`&difficulty=hard`, the content as written): the lower levels shrink the
   * guardian's hp, which moves its threshold. The flip itself is `guardianPhaseTwoCheck`: a starter-deck
   * player is dead by turn 6 to 8 with the guardian still at 97 to 103 hp (simulated through
   * CombatController over four seeds), so that check lowers the guardian's hp with a debug hook and
   * lets a real card play cross the threshold.
   */
  async function guardianPhaseCheck() {
    const base = opts.base.replace(/\/$/, '');
    await page.goto(`${base}/?seed=${GUARDIAN_SEED}&debug&difficulty=hard`);
    await waitFor(
      'guardian-app',
      () => window.__combat?.floor && window.__xrEmu.ctx().renderer,
      undefined,
      60000,
    );
    await ev(() => window.__combat.heroReady);
    await settle(1500);
    await enterVr();
    const room = await ev(() => window.__combat.teleportToEncounter({ guardian: true }));
    record('xr-guardian-teleport', typeof room === 'number', { room });
    if (room === null) return;
    await waitFor(
      'guardian-fight-active',
      () => window.__combat.floor.encounter.phase === 'active' && window.__combat.session !== null,
      undefined,
      30000,
    );
    await waitFor(
      'guardian-model',
      () => {
        const s = window.__combat.session;
        return s && s.enemies.length === 1 && window.__combat.floor.actorOf(s.enemies[0].body);
      },
      undefined,
      30000,
    );
    await settle(1800);
    await ev(() => window.__xrEmu.setHead(1.2, -0.1));
    await settle(400);
    const read = () =>
      ev(() => {
        const s = window.__combat.session;
        const enemy = s.controller.state.enemies[0];
        const actor = window.__combat.floor.actorOf(s.enemies[0].body);
        return {
          id: enemy.id,
          hp: enemy.hp,
          maxHp: enemy.maxHp,
          phase: enemy.phase,
          moves: enemy.moves.map((m) => m.id),
          intent: enemy.intent?.id ?? null,
          shownPhase: s.view.enemies[0]?.phase ?? null,
          shownIntent: s.view.enemies[0]?.intent?.id ?? null,
          playerHp: s.controller.state.player.hp,
          model: actor !== null,
          clip: actor?.asset.phaseClip?.name ?? null,
          caseOpen: actor?.caseOpen ?? null,
          caseOpening: actor?.caseOpening ?? null,
          phaseChanges: actor?.phaseChanges ?? null,
          state: actor?.state ?? null,
        };
      });
    const first = await read();
    await shot('21-guardian-phase1');
    record(
      'xr-guardian-phase1-case-closed',
      first.id === 'grand-escapement' &&
        first.model &&
        first.clip === 'phase-change' &&
        first.phase === 1 &&
        first.shownPhase === 1 &&
        first.caseOpen === false &&
        first.caseOpening === false &&
        first.phaseChanges === 0 &&
        first.hp === first.maxHp,
      first,
    );
    record(
      'xr-guardian-phase1-moves-without-toll-and-overwind',
      JSON.stringify(first.moves) === JSON.stringify(['tick', 'tock', 'pallet', 'mainspring']),
      first.moves,
    );
    const shown = [first.shownIntent];
    for (let turn = 0; turn < 3; turn += 1) {
      const now = await read();
      if (now.playerHp <= 20) break;
      await page.keyboard.press('KeyE');
      await settle(300);
      await enemyPhaseOver(`guardian-turn-${turn}`, 30000);
      await settle(1200);
      shown.push((await read()).shownIntent);
    }
    const last = await read();
    const phase1 = ['tick', 'tock', 'pallet', 'mainspring'];
    record(
      'xr-guardian-phase1-intents-from-the-four-move-list',
      shown.length >= 2 && shown.every((id) => phase1.includes(id)),
      shown,
    );
    record(
      'xr-guardian-phase1-clip-never-played',
      last.phaseChanges === 0 && last.caseOpen === false && last.state !== 'phase-change',
      last,
    );
    await shot('21-guardian-phase1-after-turns');
    await page.keyboard.press('KeyK');
    await settle(800);
    await ev(() => window.__xrEmu.ctx().renderer.xr.getSession()?.end());
    await settle(400);
  }

  /**
   * P6 guardian phase 2 in XR. The debug hook `setGuardianNearPhaseTwo` leaves the Grand Escapement one
   * hp above its threshold (the starter deck cannot get it there: see `guardianPhaseCheck`), then a
   * real Strike played through the controller crosses it through the rules' `checkPhase`. Checks the
   * `enemy-phase` event (counted at the audio director, which sees every rules event once), the
   * phase-change clip and the held-open case (the four hinge bones against the clip's last keyframe,
   * sampled every 30 ms across the clip, idle, attack and hit), the six-move list and a phase-2-only
   * intent over real enemy turns (the player only defends, so the fight keeps going), and the music
   * request.
   */
  async function guardianPhaseTwoCheck() {
    const base = opts.base.replace(/\/$/, '');
    const errorsBefore = consoleErrors.length;
    await page.goto(`${base}/?seed=${GUARDIAN_SEED}&debug&difficulty=hard`);
    await waitFor(
      'guardian2-app',
      () => window.__combat?.floor && window.__xrEmu.ctx().renderer,
      undefined,
      60000,
    );
    await ev(() => window.__combat.heroReady);
    await settle(1500);
    await enterVr();
    const room = await ev(() => window.__combat.teleportToEncounter({ guardian: true }));
    record('xr-guardian-phase2-teleport', typeof room === 'number', { room });
    if (room === null) return;
    await waitFor(
      'guardian2-fight-active',
      () => window.__combat.floor.encounter.phase === 'active' && window.__combat.session !== null,
      undefined,
      30000,
    );
    await waitFor(
      'guardian2-model',
      () => {
        const s = window.__combat.session;
        return s && s.enemies.length === 1 && window.__combat.floor.actorOf(s.enemies[0].body);
      },
      undefined,
      30000,
    );
    await settle(1800);
    await ev(() => window.__xrEmu.setHead(1.2, -0.1));
    await ev(() => window.__xrEmu.frames(4));

    // In-page instruments: every rules event the session sounds passes the audio director once, so
    // wrapping it counts `enemy-phase`; a 30 ms sampler records the actor's clip and how far the four
    // hinge bones sit from the phase-change clip's last keyframe.
    await ev(() => {
      const audio = window.__combat.audio;
      const events = [];
      const play = audio.playCombatEvent.bind(audio);
      audio.playCombatEvent = (event, at) => {
        if (event.type === 'enemy-phase') events.push({ ...event, t: performance.now() });
        return play(event, at);
      };
      window.__phaseEvents = events;
      const names = ['door.L', 'door.R', 'plate.L', 'plate.R'];
      const actor = () => {
        const body = window.__combat.session?.enemies[0]?.body;
        return body ? window.__combat.floor.actorOf(body) : null;
      };
      const trace = [];
      window.__phaseTrace = trace;
      window.__phaseDeg = () => {
        const a = actor();
        const clip = a.asset.phaseClip;
        let worst = 0;
        for (const name of names) {
          const key = name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
          const bone = a.object.getObjectByName(key) ?? a.object.getObjectByName(name);
          const track = clip.tracks.find((t) => t.name === `${bone.name}.quaternion`);
          const last = bone.quaternion
            .clone()
            .fromArray(track.values, track.values.length - 4)
            .normalize();
          worst = Math.max(worst, (bone.quaternion.angleTo(last) * 180) / Math.PI);
        }
        return worst;
      };
      window.__phaseTimer = setInterval(() => {
        const a = actor();
        if (!a || trace.length > 40000) return;
        trace.push({
          t: performance.now(),
          state: a.state,
          open: a.caseOpen,
          opening: a.caseOpening,
          deg: window.__phaseDeg(),
        });
      }, 30);
    });
    const read = () =>
      ev(() => {
        const s = window.__combat.session;
        const enemy = s.controller.state.enemies[0];
        const actor = window.__combat.floor.actorOf(s.enemies[0].body);
        const audio = window.__combat.audio;
        return {
          hp: enemy.hp,
          maxHp: enemy.maxHp,
          phase: enemy.phase,
          shownPhase: s.view.enemies[0]?.phase ?? null,
          moves: enemy.moves.map((m) => m.id),
          intent: enemy.intent?.id ?? null,
          shownIntent: s.view.enemies[0]?.intent?.id ?? null,
          shownHp: s.view.enemies[0]?.hp ?? null,
          playerHp: s.controller.state.player.hp,
          stage: s.controller.stage,
          caseOpen: actor?.caseOpen ?? null,
          caseOpening: actor?.caseOpening ?? null,
          phaseChanges: actor?.phaseChanges ?? null,
          actorState: actor?.state ?? null,
          boneDeg: window.__phaseDeg(),
          events: window.__phaseEvents.length,
          audioState: audio.state,
          musicRequest: audio.musicRequest,
        };
      });
    /** Plays every Brass Guard in hand (select, then the table click) so the player outlasts the turns. */
    const defend = () =>
      ev(() => {
        const c = window.__combat.session.controller;
        let played = 0;
        for (;;) {
          const card = c.state.piles.hand.find(
            (h) => h.def.id === 'defend' && h.def.cost <= c.state.player.steam,
          );
          if (!card || c.stage !== 'idle' || !c.select(card.uid).ok || !c.table().ok) break;
          played += 1;
        }
        return played;
      });

    const before = await read();
    const placed = await ev(() => window.__combat.setGuardianNearPhaseTwo());
    await ev(() => window.__xrEmu.frames(6));
    const near = await read();
    const threshold = near.maxHp * 0.5;
    record(
      'xr-guardian-phase2-hook-leaves-hp-just-above-threshold',
      placed !== null &&
        near.hp === Math.floor(threshold) + 1 &&
        near.hp > threshold &&
        near.phase === 1 &&
        near.shownPhase === 1 &&
        near.caseOpen === false &&
        near.events === 0 &&
        before.phase === 1 &&
        before.moves.length === 4 &&
        before.boneDeg > 5,
      { placed, before, near },
    );
    await shot('22-guardian-phase2-before');

    // A real card: select a Strike and aim it at the guardian, the controller path a desktop click takes.
    const played = await ev(() => {
      const c = window.__combat.session.controller;
      const card = c.state.piles.hand.find(
        (h) => h.def.id === 'strike' && h.def.cost <= c.state.player.steam,
      );
      const enemy = c.state.enemies[0];
      if (!card) return { ok: false, reason: 'no Strike in hand' };
      return c.select(card.uid).ok ? c.target(enemy.id) : { ok: false, reason: 'select failed' };
    });
    await ev(() => window.__xrEmu.frames(6));
    const crossed = await read();
    record(
      'xr-guardian-phase2-card-crosses-threshold',
      played.ok === true &&
        crossed.hp > 0 &&
        crossed.hp <= threshold &&
        crossed.hp < near.hp &&
        crossed.phase === 2 &&
        crossed.shownPhase === 2 &&
        crossed.moves.length === 6,
      { played, near: near.hp, crossed },
    );
    const opened = await waitFor(
      'guardian2-case-open',
      () => window.__combat.floor.actorOf(window.__combat.session.enemies[0].body).caseOpen,
      undefined,
      15000,
    );
    await settle(900);
    const open = await read();
    await ev(() => window.__xrEmu.frames(4));
    await shot('22-guardian-phase2-open');

    // Real enemy turns. The pick made before the flip stands for the first one, then every pick
    // draws from the six moves; stop once a phase-2-only intent is shown.
    const MAX_TURNS = 14;
    const PHASE_TWO_ONLY = ['toll', 'overwind'];
    const six = ['tick', 'tock', 'pallet', 'mainspring', 'overwind', 'toll'];
    const intents = [];
    let found = null;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const now = await read();
      if (now.playerHp <= 12 || now.stage === 'over') break;
      await defend();
      await page.keyboard.press('KeyE');
      await settle(300);
      await enemyPhaseOver(`guardian2-turn-${turn}`, 30000);
      await settle(1000);
      const after = await read();
      intents.push(after.shownIntent);
      if (PHASE_TWO_ONLY.includes(after.shownIntent)) {
        found = { turn: turn + 1, intent: after.shownIntent };
        await ev(() => window.__xrEmu.frames(4));
        await shot('22-guardian-phase2-intent');
        break;
      }
    }
    // The case must also have been seen holding open under an attack: run one more turn if none was.
    const sawAttack = () =>
      ev(() => window.__phaseTrace.some((p) => p.open && p.state === 'attack'));
    if (!(await sawAttack())) {
      const now = await read();
      if (now.playerHp > 12 && now.stage !== 'over') {
        await defend();
        await page.keyboard.press('KeyE');
        await settle(300);
        await enemyPhaseOver('guardian2-extra-turn', 30000);
        await settle(1000);
      }
    }
    const last = await read();
    const trace = await ev(() => window.__phaseTrace);
    const events = await ev(() => window.__phaseEvents);
    const openSamples = trace.filter((p) => p.open);
    const heldWorst = openSamples.reduce((m, p) => Math.max(m, p.deg), 0);
    const statesOpen = [...new Set(openSamples.map((p) => p.state))];

    record(
      'xr-guardian-phase2-enemy-phase-event-fires-once',
      events.length === 1 &&
        events[0].enemyId === 'grand-escapement' &&
        events[0].phase === 2 &&
        last.events === 1,
      { events, total: last.events },
    );
    record(
      'xr-guardian-phase2-clip-plays-and-case-held-open',
      opened &&
        open.phaseChanges === 1 &&
        last.phaseChanges === 1 &&
        trace.some((p) => p.state === 'phase-change' && p.opening) &&
        open.caseOpen === true &&
        open.boneDeg < 1 &&
        openSamples.length > 20 &&
        statesOpen.includes('idle') &&
        statesOpen.includes('attack') &&
        heldWorst < 1 &&
        last.caseOpen === true &&
        last.boneDeg < 1,
      {
        opened,
        phaseChanges: [open.phaseChanges, last.phaseChanges],
        samples: trace.length,
        openSamples: openSamples.length,
        statesWhileOpen: statesOpen,
        worstBoneDegreesWhileOpen: heldWorst,
        closedBoneDegrees: before.boneDeg,
      },
    );
    record(
      'xr-guardian-phase2-intents-come-from-the-six-moves',
      JSON.stringify(last.moves) === JSON.stringify(six) &&
        intents.length > 0 &&
        intents.every((id) => six.includes(id)),
      { moves: last.moves, intents },
    );
    record('xr-guardian-phase2-shows-a-phase-two-only-move', found !== null, {
      found,
      intents,
      limit: MAX_TURNS,
    });
    record(
      'xr-guardian-phase2-music-request-is-guardian-2',
      before.audioState === 'guardian-active' &&
        before.musicRequest === 'guardian-1' &&
        open.musicRequest === 'guardian-2' &&
        last.musicRequest === 'guardian-2' &&
        last.audioState === 'guardian-active',
      {
        before: [before.audioState, before.musicRequest],
        open: [open.audioState, open.musicRequest],
        last: [last.audioState, last.musicRequest],
      },
    );
    await ev(() => clearInterval(window.__phaseTimer));
    const errors = consoleErrors.slice(errorsBefore);
    record('xr-guardian-phase2-no-console-errors', errors.length === 0, errors.slice(0, 5));
    await page.keyboard.press('KeyK');
    await settle(800);
    await ev(() => window.__xrEmu.ctx().renderer.xr.getSession()?.end());
    await settle(400);
  }

  /** XO5: a player facing away from the desktop title at Enter VR still finds it in front. */
  async function recenterCheck() {
    const base = opts.base.replace(/\/$/, '');
    await page.goto(`${base}/?title&debug`);
    await waitFor(
      'recenter-app',
      () => window.__flow?.ui && window.__xrEmu.ctx().renderer,
      undefined,
      60000,
    );
    await settle(1500);
    await enterVr(Math.PI);
    await settle(400);
    const bearing = await ev(() => {
      const probe = window.__xrEmu;
      const { camera } = probe.ctx();
      const board = probe.worldOf('title-board');
      if (!board) return null;
      camera.updateWorldMatrix(true, false);
      const e = camera.matrixWorld.elements;
      // Camera forward is -Z of its world matrix.
      const fx = -e[8];
      const fz = -e[10];
      const dx = board.x - e[12];
      const dz = board.z - e[14];
      const angle = Math.abs(Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz));
      return { degrees: (angle * 180) / Math.PI, forward: [fx, fz], toBoard: [dx, dz] };
    });
    record(
      'xr-title-in-front-after-turned-entry',
      bearing !== null && bearing.degrees < 30,
      bearing,
    );
    await shot('16-title-after-turned-entry');
  }

  async function walk() {
    const base = opts.base.replace(/\/$/, '');
    await page.goto(`${base}/?title&debug`);
    await waitFor(
      'app',
      () => window.__flow?.ui && window.__xrEmu.ctx().renderer,
      undefined,
      60000,
    );
    record('gpu', null, await gpu());
    await settle(1500);
    const desk = await ev(() => {
      const { world } = window.__xrEmu.ctx();
      return { phase: window.__flow.flow.phase, sceneChildren: world.children.length };
    });
    record('desktop-boot', desk.phase === 'title', desk);
    await shot('0-desktop-title');

    if (opts.focus) {
      await enterVr();
      await press('title-new-run');
      await settle(800);
      await ev(() => window.__flow.setCheat('win'));
      await ev(() => window.__combat.teleportToEncounter());
      if (
        await waitFor(
          'focus-fight-active',
          () => window.__combat.floor.encounter.phase === 'active',
          undefined,
          30000,
        )
      ) {
        await settle(1200);
        await fanAndSigilCheck();
      }
      return;
    }

    if (opts.loco) {
      await enterVr();
      await settingsComfortCheck();
      await press('title-new-run');
      await settle(800);
      await locomotionCheck();
      return;
    }

    // --- P0-T2 criterion 2: the session through createXrSession, foveation, scale, hands --------
    await enterVr();
    const session = await ev(() => {
      const probe = window.__xrEmu;
      const { renderer, rig, camera } = probe.ctx();
      return {
        presenting: renderer.xr.isPresenting,
        requests: probe.requests,
        mode: probe.session?.mode ?? null,
        threeFoveation: renderer.xr.getFoveation(),
        foveationWrites: probe.foveationWrites,
        layerInits: probe.layerInits,
        rigY: rig.position.y,
        headLocalY: camera.position.y,
        enterButtonHidden:
          [...document.querySelectorAll('button')].find((x) => x.textContent === 'Enter VR')?.style
            .display === 'none',
      };
    });
    record('xr-session-immersive-vr', session.presenting && session.mode === 'immersive-vr', {
      presenting: session.presenting,
      mode: session.mode,
      optionalFeatures: session.requests[0]?.optionalFeatures,
      enterButtonHidden: session.enterButtonHidden,
    });
    // three.js writes its own default (1) once inside setSession, before the first frame; the
    // toolkit's 0.5 follows as soon as setSession resolves and every frame re-asserts it.
    const fov = session.foveationWrites.map((w) => w.value);
    record(
      'xr-foveation-medium',
      session.threeFoveation === 0.5 && fov.at(-1) === 0.5 && fov.slice(1).every((v) => v === 0.5),
      {
        threeGetFoveation: session.threeFoveation,
        layerWrites: session.foveationWrites,
        toolkitMedium: 0.5,
        perfXrFoveation: 0.5,
        note: 'requested value; IWER emulation mode does not apply foveation',
      },
    );
    const scale =
      session.layerInits[0]?.framebufferScaleFactor ?? session.layerInits[0]?.scaleFactor;
    record('xr-framebuffer-scale', scale === 0.85, {
      layerInits: session.layerInits,
      note: 'requested at layer creation; IWER emulation renders at the canvas size',
    });
    record('xr-seated-recenter', Math.abs(session.rigY - (1.6 - SEATED_HEAD_Y)) < 0.02, {
      rigY: session.rigY,
      headLocalY: session.headLocalY,
      expectedRigY: 1.6 - SEATED_HEAD_Y,
    });

    // Hands posed in view: aim both forward-down so the brass hands sit in the lower view.
    await ev(
      ({ offsets }) => {
        const probe = window.__xrEmu;
        const front = probe.worldOf('player-rig', [0, 0.4, -3]);
        probe.aimAt('right', front, offsets.right);
        probe.aimAt('left', front, offsets.left);
      },
      { offsets: HAND_OFFSET },
    );
    await settle(2500);
    const hands = await ev(() => {
      const { world } = window.__xrEmu.ctx();
      const out = [];
      world.traverse((node) => {
        if (node.name !== 'xr-cartoon-hand') return;
        const skin = node.getObjectByName('cartoon-hand-skin');
        let visibleMeshes = 0;
        node.traverseVisible((n) => {
          if (n.isMesh) visibleMeshes += 1;
        });
        out.push({
          visible: node.visible,
          asset: node.userData.handAsset ?? null,
          skinColor: skin?.material?.color?.getHexString?.() ?? null,
          visibleMeshes,
        });
      });
      return out;
    });
    record(
      'xr-brass-hands',
      hands.length === 2 && hands.every((h) => h.visible && h.visibleMeshes > 0),
      hands,
    );
    await shot('1-session-hands');

    // --- P5-T9 criterion 1, XR half: the boards with the controller ray ------------------------
    const titleBoard = await ev(() => {
      const probe = window.__xrEmu;
      const board = probe.worldOf('title-board');
      const art = probe.worldOf('flow-key-art');
      const passes = probe.passes.slice(-12);
      const { uiScene } = probe.ctx();
      return {
        board: board && probe.headTo(board),
        art: art && probe.headTo(art),
        uiPassInXr: passes.some((p) => p.scene === uiScene.uuid),
        uiPassAfterClear: passes.some((p) => p.scene === uiScene.uuid && p.autoClear === false),
      };
    });
    record('boards-placement-title', titleBoard.board !== null, titleBoard);
    record('boards-own-pass-in-xr', titleBoard.uiPassInXr && titleBoard.uiPassAfterClear, {
      uiPassInXr: titleBoard.uiPassInXr,
      uiPassAfterClear: titleBoard.uiPassAfterClear,
    });

    // Hover follows the main hand only.
    const newRun = await ev(() => window.__xrEmu.worldOf('title-new-run'));
    await aim(MAIN, newRun);
    await settle(250);
    const mainHover = await ev(() => window.__flow.ui.hoveredId);
    await shot('2-title-hover');
    await aim(OFF, newRun);
    await settle(250);
    const offHover = await ev(() => window.__flow.ui.hoveredId);
    record('hover-main-hand', mainHover === 'title-new-run' && offHover === null, {
      mainHover,
      offHandHover: offHover,
    });

    // Settings: Lower master volume (the default is 100 %), then back.
    let hovered = await press('title-settings');
    const before = await ev(() => window.__flow.ui.deps.settings().masterVolume);
    const settingsOpen = (await phase()) === 'settings';
    const lowered = await press('settings-masterVolume-down');
    const after = await ev(() => window.__flow.ui.deps.settings().masterVolume);
    await shot('3-settings');
    await press('settings-back');
    record('settings-volume', settingsOpen && after < before && (await phase()) === 'title', {
      hovered,
      lowered,
      before,
      after,
      control: 'Lower/Raise buttons (no slider on the board)',
    });

    await settingsComfortCheck();

    // Seed keypad.
    hovered = await press('title-enter-seed');
    const padOpen = await ev(() => window.__flow.ui.seedEntry === '');
    for (const ch of opts.seed) await press(`seedpad-k-${ch}`);
    const draft = await ev(() => window.__flow.ui.seedEntry);
    await shot('4-seed-keypad');
    await press('seedpad-done');
    const seed = await ev(() => window.__flow.ui.seed);
    record('seed-keypad', padOpen && draft === opts.seed && seed === opts.seed, {
      draft,
      seed,
    });

    // Workshop (no cogs banked yet in a fresh profile).
    await press('title-workshop');
    const shop = await ev(() => ({
      phase: window.__flow.flow.phase,
      cogs: window.__flow.flow.workshop.cogsBanked,
    }));
    await press('workshop-back');
    record('workshop-open', shop.phase === 'workshop' && (await phase()) === 'title', shop);

    // Difficulty with the ray: Casual is chosen on the title, remembered, and the run starts at it.
    const levelBefore = await ev(() => window.__flow.ui.deps.settings().difficulty);
    hovered = await press('title-difficulty-casual');
    const levelAfter = await ev(() => window.__flow.ui.deps.settings().difficulty);
    await shot('4b-title-difficulty');
    record(
      'xr-title-difficulty',
      hovered === 'title-difficulty-casual' && levelAfter === 'casual',
      { levelBefore, hovered, levelAfter },
    );

    // New Run on the keyed seed: the floor is rebuilt in place while presenting.
    const bootFloor = await ev(() => {
      window.__xrEmuBootFloor = window.__combat.floor;
      return window.__combat.floor.seed;
    });
    await press('title-new-run');
    await settle(800);
    const run = await ev(() => ({
      phase: window.__flow.flow.phase,
      seed: window.__combat.floor.seed,
      rebuilt: window.__combat.floor !== window.__xrEmuBootFloor,
      presenting: window.__xrEmu.ctx().renderer.xr.isPresenting,
      rigY: window.__xrEmu.ctx().rig.position.y,
      difficulty: window.__flow.flow.run?.difficulty ?? null,
    }));
    record('new-run-in-xr', run.phase === 'explore' && run.seed === opts.seed && run.presenting, {
      bootFloor,
      ...run,
    });
    record('xr-new-run-difficulty', run.difficulty === 'casual', { difficulty: run.difficulty });
    record('seated-height-after-new-run', Math.abs(run.rigY - (1.6 - SEATED_HEAD_Y)) < 0.02, {
      rigY: run.rigY,
      expected: 1.6 - SEATED_HEAD_Y,
    });
    await shot('5-explore');

    await locomotionCheck();

    // Continue: persist, reload, enter again, Continue with the ray.
    await ev(() => window.__flow.flushed());
    await page.reload();
    await waitFor('app-reload', () => window.__flow?.ui && window.__xrEmu.ctx().renderer);
    await settle(1500);
    await enterVr();
    const hasContinue = await ev(() => window.__xrEmu.worldOf('title-continue') !== null);
    hovered = hasContinue ? await press('title-continue') : null;
    await settle(800);
    const resumed = await ev(() => ({
      phase: window.__flow.flow.phase,
      seed: window.__flow.flow.run?.seed ?? null,
      presenting: window.__xrEmu.ctx().renderer.xr.isPresenting,
      rigY: window.__xrEmu.ctx().rig.position.y,
      difficulty: window.__flow.flow.run?.difficulty ?? null,
    }));
    record('xr-continue-keeps-difficulty', resumed.difficulty === 'casual', {
      difficulty: resumed.difficulty,
    });
    record('seated-height-after-continue', Math.abs(resumed.rigY - (1.6 - SEATED_HEAD_Y)) < 0.02, {
      rigY: resumed.rigY,
      expected: 1.6 - SEATED_HEAD_Y,
    });
    record(
      'continue-in-xr',
      hasContinue && resumed.phase === 'explore' && resumed.seed === opts.seed,
      {
        hovered,
        ...resumed,
      },
    );

    await fightAndReward();
    await deathAndBack();
    await ev(() => window.__xrEmu.ctx().renderer.xr.getSession()?.end());
    await settle(500);
    record('session-end', !(await ev(() => window.__xrEmu.ctx().renderer.xr.isPresenting)), null);
  }

  async function locomotionCheck() {
    const read = () =>
      ev(() => {
        const { rig } = window.__xrEmu.ctx();
        return { x: rig.position.x, z: rig.position.z, yaw: (rig.rotation.y * 180) / Math.PI };
      });
    const start = await read();
    await ev(() => window.__xrEmu.device.controllers.right.updateAxes('thumbstick', 0, -1));
    await settle(1000);
    await ev(() => window.__xrEmu.device.controllers.right.updateAxes('thumbstick', 0, 0));
    await settle(200);
    const moved = await read();
    const distance = Math.hypot(moved.x - start.x, moved.z - start.z);
    record('locomotion-smooth-move', distance > 0.3, {
      metres: Number(distance.toFixed(3)),
      from: start,
      to: moved,
    });
    const snap = async () => {
      await ev(() => window.__xrEmu.device.controllers.left.updateAxes('thumbstick', 1, 0));
      await settle(400);
      await ev(() => window.__xrEmu.device.controllers.left.updateAxes('thumbstick', 0, 0));
      await settle(300);
      return (await read()).yaw;
    };
    const yaw1 = await snap();
    const yaw2 = await snap();
    const step1 = moved.yaw - yaw1;
    const step2 = yaw1 - yaw2;
    record('locomotion-snap-turn', Math.abs(step1 - 30) < 0.5 && Math.abs(step2 - 30) < 0.5, {
      yawDeg: [moved.yaw, yaw1, yaw2],
      steps: [step1, step2],
    });
    // Turn back so the checks below face the way the floor expects.
    await ev(() => {
      window.__xrEmu.ctx().rig.rotation.y = 0;
    });
    await comfortVignetteCheck();
    await teleportCheck();
  }

  /** While the table is up neither smooth move (right stick) nor teleport (left stick forward) moves the rig, and no aim is held. */
  async function combatLocksLocomotionCheck() {
    const read = () =>
      ev(() => {
        const { rig } = window.__xrEmu.ctx();
        const { locomotion, drive, floor } = window.__combat;
        return {
          at: [rig.position.x, rig.position.z],
          vignette: locomotion.vignetteStrength,
          aiming: drive.isAiming,
          preview: locomotion.teleportPreview !== null,
          locked: floor.locked,
        };
      });
    const setTeleport = (on) =>
      ev((on) => {
        const { ui } = window.__flow;
        ui.deps.onSettings({ ...ui.deps.settings(), teleportEnabled: on });
      }, on);
    const before = await read();
    const held = {};
    for (const teleport of [false, true]) {
      await setTeleport(teleport);
      await stick('right', 0, -1);
      await stick('left', 0, -1);
      await frames(3);
      await settle(400);
      held[teleport ? 'teleport' : 'smooth'] = await read();
      await stick('right', 0, 0);
      await stick('left', 0, 0);
      await frames(3);
    }
    await setTeleport(true);
    const after = await read();
    const still = (r) =>
      Math.hypot(r.at[0] - before.at[0], r.at[1] - before.at[1]) < 1e-6 &&
      r.vignette === 0 &&
      !r.aiming &&
      !r.preview;
    record(
      'locomotion-locked-in-combat',
      before.locked && still(held.smooth) && still(held.teleport) && still(after),
      { before, held, after },
    );
  }

  /** The comfort options on the Settings board: flip with the ray, then read the app, locomotion and the stored profile. */
  async function settingsComfortCheck() {
    const stored = () =>
      ev(
        () =>
          new Promise((resolve) => {
            const open = indexedDB.open('rogue-xr');
            open.onerror = () => resolve(null);
            open.onsuccess = () => {
              const db = open.result;
              const get = db.transaction('settings').objectStore('settings').get('current');
              get.onsuccess = () => {
                db.close();
                resolve(get.result ?? null);
              };
              get.onerror = () => {
                db.close();
                resolve(null);
              };
            };
          }),
      );
    const read = () =>
      ev(() => {
        const live = window.__flow.ui.deps.settings();
        const { settings: loco } = window.__combat.locomotion;
        return {
          teleportEnabled: live.teleportEnabled,
          turnMode: live.turnMode,
          locoTeleport: loco.teleport,
          locoTurnMode: loco.turnMode,
        };
      });
    await press('title-settings');
    const open = (await phase()) === 'settings';
    const initial = await read();
    await press('settings-teleportEnabled-toggle');
    await settle(400);
    const teleOff = { live: await read(), stored: await stored() };
    await shot('3b-settings-comfort');
    await press('settings-teleportEnabled-toggle');
    await settle(400);
    const teleOn = { live: await read(), stored: await stored() };
    record(
      'settings-teleport-toggle',
      open &&
        initial.teleportEnabled === true &&
        teleOn.live.teleportEnabled === true &&
        teleOn.live.locoTeleport === true &&
        teleOn.stored?.teleportEnabled === true &&
        teleOff.live.teleportEnabled === false &&
        teleOff.live.locoTeleport === false &&
        teleOff.stored?.teleportEnabled === false,
      { initial, teleOff, teleOn },
    );
    await press('settings-turnMode-toggle');
    await settle(400);
    const smooth = { live: await read(), stored: await stored() };
    await press('settings-turnMode-toggle');
    await settle(400);
    const snap = { live: await read(), stored: await stored() };
    record(
      'settings-turn-toggle',
      initial.turnMode === 'snap' &&
        smooth.live.turnMode === 'smooth' &&
        smooth.live.locoTurnMode === 'smooth' &&
        smooth.stored?.turnMode === 'smooth' &&
        snap.live.turnMode === 'snap' &&
        snap.live.locoTurnMode === 'snap' &&
        snap.stored?.turnMode === 'snap',
      { initial, smooth, snap },
    );
    await press('settings-back');
    record('settings-comfort-back', (await phase()) === 'title', null);
  }

  /** Sets a controller's thumbstick; the app reads it in the next XR frame. */
  function stick(hand, x, y) {
    return ev(
      ({ hand, x, y }) => window.__xrEmu.device.controllers[hand].updateAxes('thumbstick', x, y),
      { hand, x, y },
    );
  }

  /**
   * Mean luma of the outer frame band and of the centre box in two screenshots (same pose), so the
   * edge darkening of the comfort vignette and the unchanged centre can be compared.
   */
  function bandLuma(a, b) {
    return ev(
      async ({ a, b }) => {
        const read = async (src) => {
          const img = new Image();
          img.src = `data:image/png;base64,${src}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const g = canvas.getContext('2d');
          g.drawImage(img, 0, 0);
          return g.getImageData(0, 0, img.width, img.height);
        };
        const bands = (image) => {
          const { data, width: w, height: h } = image;
          let edge = 0;
          let edgeN = 0;
          let center = 0;
          let centerN = 0;
          for (let y = 0; y < h; y += 1) {
            for (let x = 0; x < w; x += 1) {
              const i = (y * w + x) * 4;
              const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
              const u = x / w;
              const v = y / h;
              if (u < 0.08 || u > 0.92 || v < 0.1 || v > 0.9) {
                edge += luma;
                edgeN += 1;
              } else if (Math.abs(u - 0.5) < 0.12 && Math.abs(v - 0.5) < 0.15) {
                center += luma;
                centerN += 1;
              }
            }
          }
          return { edge: edge / edgeN, center: center / centerN };
        };
        return { first: bands(await read(a)), second: bands(await read(b)) };
      },
      { a: a.toString('base64'), b: b.toString('base64') },
    );
  }

  /** The comfort vignette: strength follows motion in the app, its pass renders only while moving, the edge band darkens at a held strength. */
  async function comfortVignetteCheck() {
    const sample = () =>
      ev(() => {
        const { locomotion, comfortVignette } = window.__combat;
        return {
          strength: locomotion.vignetteStrength,
          shown: comfortVignette.strength,
          active: comfortVignette.active,
          uuid: comfortVignette.scene.uuid,
          now: performance.now(),
        };
      });
    const passesSince = (uuid, since) =>
      ev(
        ({ uuid, since }) =>
          window.__xrEmu.passes.filter((p) => p.scene === uuid && p.t > since).length,
        { uuid, since },
      );
    const stillBefore = await sample();
    await stick('right', 0, -1);
    await settle(500);
    const moving = await sample();
    await settle(300);
    const movingPasses = await passesSince(moving.uuid, moving.now);
    await stick('right', 0, 0);
    await settle(1200);
    const still = await sample();
    await settle(300);
    const stillPasses = await passesSince(still.uuid, still.now);
    record(
      'locomotion-vignette-follows-motion',
      stillBefore.strength === 0 &&
        moving.strength > 0.3 &&
        moving.active &&
        moving.shown > 0.4 &&
        movingPasses > 3 &&
        still.strength === 0 &&
        !still.active &&
        stillPasses === 0,
      { stillBefore, moving, movingPasses, still, stillPasses },
    );
    // Pixels at one pose: the vignette held at its cap against the same view with it off.
    await ev(() => {
      window.__combat.comfortVignette.hold = 0.7;
    });
    await frames(4);
    const dark = await page.screenshot({ type: 'png' });
    await shot('p6-comfort-vignette-held');
    await ev(() => {
      window.__combat.comfortVignette.hold = null;
    });
    await frames(4);
    const clear = await page.screenshot({ type: 'png' });
    const luma = await bandLuma(dark, clear);
    const edgeRatio = luma.first.edge / Math.max(luma.second.edge, 1e-6);
    const centerDelta = Math.abs(luma.first.center - luma.second.center);
    record('locomotion-vignette-edge-band', edgeRatio < 0.8 && centerDelta < 4, {
      held: luma.first,
      clear: luma.second,
      edgeRatio: Number(edgeRatio.toFixed(3)),
      centerDelta: Number(centerDelta.toFixed(2)),
      note: 'outer band mean luma with the vignette held at its cap vs off, same pose; centre box unchanged',
    });
    // The red hit flash stacks on top of the held comfort vignette instead of being replaced by it.
    await ev(() => {
      window.__combat.comfortVignette.hold = 0.7;
      window.__combat.hitFx.hold({ kind: 'hit', amount: 8, blocked: 0, hpLost: 8 });
    });
    await frames(4);
    const both = await page.screenshot({ type: 'png' });
    await ev(() => {
      window.__combat.hitFx.release();
      window.__combat.comfortVignette.hold = null;
    });
    await frames(4);
    const stacked = await redEdgePixels(dark, both);
    record(
      'locomotion-vignette-composes-with-hit',
      stacked.edgeShare > 0.05 && stacked.centerShare < 0.005,
      {
        ...stacked,
        note: 'new red pixels at the frame band vs the centre when the hit flash is added over the held comfort vignette',
      },
    );
  }

  /** Teleport on: aim with the left stick and controller, an invalid aim does not move, a valid release lands where the arc ended. */
  async function teleportCheck() {
    await ev(() => {
      const { ui } = window.__flow;
      ui.deps.onSettings({ ...ui.deps.settings(), teleportEnabled: true });
    });
    const state = () =>
      ev(() => {
        const probe = window.__xrEmu;
        const { rig } = probe.ctx();
        const { locomotion, teleportView } = window.__combat;
        // The tracked head in world space. The camera's own world position is moved back along the
        // view axis by three.js when it renders the union of both eyes, which is not the head the
        // locomotion moves.
        const at = probe.device.position;
        rig.updateMatrixWorld(true);
        const head = rig.localToWorld(rig.position.clone().set(at.x, at.y, at.z));
        const p = locomotion.teleportPreview;
        return {
          head: [head.x, head.z],
          rigY: rig.position.y,
          vignette: locomotion.vignetteStrength,
          preview: p && {
            valid: p.valid,
            reason: p.reason,
            landing: p.landing,
            end: p.points.at(-1),
          },
          view: {
            visible: teleportView.visible,
            ring: teleportView.ring.visible,
            ringColor: teleportView.ring.material.color.getHexString(),
            arcColor: teleportView.arc.material.color.getHexString(),
            dots: teleportView.arc.count,
          },
        };
      });
    const aimAt = async (yaw, elev) => {
      const from = await ev(() => {
        const probe = window.__xrEmu;
        const { rig } = probe.ctx();
        const at = probe.device.position;
        rig.updateMatrixWorld(true);
        const head = rig.localToWorld(rig.position.clone().set(at.x, at.y - 0.3, at.z));
        return { x: head.x, y: head.y, z: head.z };
      });
      const y = (yaw * Math.PI) / 180;
      const l = (elev * Math.PI) / 180;
      const target = {
        x: from.x + 5 * Math.cos(l) * Math.sin(y),
        y: from.y + 5 * Math.sin(l),
        z: from.z - 5 * Math.cos(l) * Math.cos(y),
      };
      await ev(({ from, target }) => window.__xrEmu.placeAt('left', from, target), {
        from,
        target,
      });
      await frames(3);
      return state();
    };
    const YAWS = [0, 45, 315, 90, 270, 135, 225, 180];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const before = await state();

    // Invalid: scan aims until the app's own validation rejects one (a wall, preferably).
    await stick('left', 0, -1);
    await frames(2);
    let invalid = null;
    for (const elev of [4, 20, 40]) {
      for (const yaw of YAWS) {
        const s = await aimAt(yaw, elev);
        if (s.preview && !s.preview.valid && (!invalid || s.preview.reason === 'blocked')) {
          invalid = { yaw, elev };
          if (s.preview.reason === 'blocked') break;
        }
      }
      if (invalid) break;
    }
    let invalidResult = null;
    if (invalid) {
      const aimed = await aimAt(invalid.yaw, invalid.elev);
      await shot('p6-teleport-invalid');
      await stick('left', 0, 0);
      await frames(3);
      invalidResult = { aimed, after: await state() };
    }
    const invalidOk =
      !!invalidResult &&
      invalidResult.aimed.view.visible &&
      invalidResult.aimed.view.ringColor === '7c2a24' &&
      invalidResult.aimed.view.arcColor === '7c2a24' &&
      dist(invalidResult.after.head, before.head) < 1e-3 &&
      invalidResult.after.rigY === before.rigY &&
      invalidResult.after.preview === null;
    record('locomotion-teleport-invalid-stays', invalidOk, {
      aimedYawElev: invalid && [invalid.yaw, invalid.elev],
      reason: invalidResult?.aimed.preview?.reason ?? null,
      view: invalidResult?.aimed.view ?? null,
      movedMetres: invalidResult
        ? Number(dist(invalidResult.after.head, before.head).toFixed(4))
        : null,
    });

    // Valid: the landing the arc showed is where the head ends up, at the same seated lift.
    await stick('left', 0, -1);
    await frames(2);
    let valid = null;
    for (const elev of [20, 32, 12]) {
      for (const yaw of YAWS) {
        const s = await aimAt(yaw, elev);
        const land = s.preview?.valid ? s.preview.landing : null;
        if (land && dist(s.head, [land[0], land[2]]) > 1.5) {
          valid = { yaw, elev };
          break;
        }
      }
      if (valid) break;
    }
    let validResult = null;
    if (valid) {
      // Look toward the aim and a little down, so the arc and the ring are in the screenshot.
      await ev(({ y, yaw }) => window.__xrEmu.setHead(y, -0.3, (-yaw * Math.PI) / 180), {
        y: SEATED_HEAD_Y,
        yaw: valid.yaw,
      });
      await frames(3);
      const aimed = await aimAt(valid.yaw, valid.elev);
      await shot('p6-teleport-aim');
      await stick('left', 0, 0);
      await frames(2);
      const landed = await state();
      await shot('p6-teleport-jump');
      await settle(1000);
      const faded = await state();
      validResult = { aimed, landed, faded };
    }
    const target = validResult?.aimed.preview?.landing && [
      validResult.aimed.preview.landing[0],
      validResult.aimed.preview.landing[2],
    ];
    const validOk =
      !!validResult &&
      !!target &&
      validResult.aimed.view.visible &&
      validResult.aimed.view.ring &&
      validResult.aimed.view.ringColor === 'dec16a' &&
      validResult.aimed.view.arcColor === 'dec16a' &&
      dist(validResult.aimed.head, before.head) < 1e-3 &&
      dist(validResult.landed.head, target) < 0.03 &&
      validResult.landed.rigY === before.rigY &&
      validResult.landed.vignette > 0.3 &&
      validResult.faded.vignette === 0 &&
      !validResult.faded.view.visible;
    record('locomotion-teleport-valid-moves', validOk, {
      aimedYawElev: valid && [valid.yaw, valid.elev],
      landing: target,
      headBefore: validResult?.aimed.head ?? null,
      headAfter: validResult?.landed.head ?? null,
      errorMetres:
        validResult && target ? Number(dist(validResult.landed.head, target).toFixed(4)) : null,
      rigY: validResult && [before.rigY, validResult.landed.rigY],
      view: validResult?.aimed.view ?? null,
      vignettePulse: validResult && [validResult.landed.vignette, validResult.faded.vignette],
    });

    await ev((y) => window.__xrEmu.setHead(y, 0, 0), SEATED_HEAD_Y);
    // Back to the default (teleport on) for the rest of the walk, through the app's own settings path.
    await ev(() => {
      const { ui } = window.__flow;
      ui.deps.onSettings({ ...ui.deps.settings(), teleportEnabled: true });
    });
    await frames(2);
  }

  /**
   * Wins fights with the debug key (K ends the active fight as a win) until the run holds the
   * cheapest workshop tier (30 cogs) or three fights are won. The first reward is a card picked
   * with the ray, later ones are skipped with the ray.
   */
  async function fightAndReward() {
    await ev(() => window.__flow.setCheat('win'));
    for (let fightIndex = 0; fightIndex < 3; fightIndex += 1) {
      const room = await ev(() => window.__combat.teleportToEncounter());
      if (room === null) break;
      const active = await waitFor(
        `fight-${fightIndex}-active`,
        () => window.__combat.floor.encounter.phase === 'active',
        undefined,
        30000,
      );
      await settle(1200);
      if (fightIndex === 0) {
        await shot('6-fight');
        await fanAndSigilCheck();
      }
      const fight = await ev(() => ({
        phase: window.__flow.flow.phase,
        hasSession: window.__combat.session !== null,
      }));
      if (fightIndex === 0) await combatLocksLocomotionCheck();
      await page.keyboard.press('KeyK');
      await waitFor(`reward-${fightIndex}`, () => window.__flow.flow.phase === 'reward');
      await settle(800);
      const reward = await ev(() => {
        const probe = window.__xrEmu;
        const card = window.__flow.flow.offer?.cards[0];
        const at = card ? probe.worldOf(`reward-${card}`) : null;
        return {
          card,
          distance: at ? probe.headTo(at).distance : null,
          deck: window.__flow.flow.run.deck.length,
        };
      });
      const pick = fightIndex === 0 ? `reward-${reward.card}` : 'reward-skip-skip';
      if (fightIndex === 0) {
        await aim(MAIN, await ev((id) => window.__xrEmu.worldOf(id), pick));
        await settle(300);
        await shot('7-reward-hover');
      }
      const hovered = await press(pick);
      const picked = await ev(() => ({
        phase: window.__flow.flow.phase,
        deck: window.__flow.flow.run.deck.length,
        cogs: window.__flow.flow.run.cogs,
      }));
      const wantDeck = fightIndex === 0 ? reward.deck + 1 : reward.deck;
      record(
        `fight-${fightIndex}-and-reward`,
        active && picked.phase === 'explore' && picked.deck === wantDeck,
        {
          room,
          fight,
          end: 'KeyK debug win (endFight) while presenting',
          pick,
          hovered,
          cardDistance: reward.distance,
          deck: [reward.deck, picked.deck],
          runCogs: picked.cogs,
        },
      );
      if (picked.cogs >= 30) break;
    }
  }

  /** Head-relative world point: `offset` metres in the rig's frame from the XR camera. */
  function headPoint(offset) {
    return ev((o) => window.__xrEmu.headPoint(o), offset);
  }

  /** Waits `n` XR frames, so poses just written are applied before world state is read. */
  function frames(n = 2) {
    return ev((count) => window.__xrEmu.frames(count), n);
  }

  /**
   * Holds the off hand up to read the fan: the ray points away from the eyes, forward and low.
   * Waits a frame first so a `setHead` just before has moved the camera both reads come from, and
   * after, so the grip and the fan on it are at the new pose when the caller reads them.
   */
  async function holdFan() {
    await frames();
    const from = await headPoint([-0.1, -0.22, -0.3]);
    const aim = await headPoint([-0.25, -0.45, -1.0]);
    await ev(({ from, aim }) => window.__xrEmu.placeAt('left', from, aim), { from, aim });
    await frames();
  }

  /** Trail-coloured pixels (the additive near-white #fff0b8) present in `after` but not in `before`. */
  function newTrailPixels(before, after) {
    return ev(
      async ({ a, b }) => {
        const read = async (src) => {
          const img = new Image();
          img.src = `data:image/png;base64,${src}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const g = canvas.getContext('2d');
          g.drawImage(img, 0, 0);
          return g.getImageData(0, 0, img.width, img.height).data;
        };
        const pa = await read(a);
        const pb = await read(b);
        const trail = (d, i) => d[i] > 225 && d[i + 1] > 205 && d[i + 2] > 120;
        let count = 0;
        for (let i = 0; i < pa.length; i += 4) if (trail(pb, i) && !trail(pa, i)) count += 1;
        return count;
      },
      { a: before.toString('base64'), b: after.toString('base64') },
    );
  }

  /**
   * The off-hand card fan held up in view (screenshot evidence for the wrist-through-cards fix,
   * proven geometrically in tests/fan-hand-clearance.test.ts), then a sigil card staged through the
   * real XR path (main-hand squeeze on the hovered card, released over the table) and its glyph
   * traced by holding the trigger and sweeping the main-hand ray across the plate along the card's
   * own template. The trail must show in the rendered frame and the cast must resolve.
   */
  async function fanAndSigilCheck() {
    // Bring a sigil card into the hand: end turns until one is drawn.
    for (let turn = 0; turn < 6; turn += 1) {
      const has = await ev(() =>
        window.__combat.session.controller.state.piles.hand.some((c) => c.def.type === 'sigil'),
      );
      if (has) break;
      await page.keyboard.press('KeyE');
      await settle(300);
      await enemyPhaseOver(`fan-turn-${turn}`);
      await settle(400);
    }
    await ev(() => window.__xrEmu.setHead(1.2, -0.35));
    await holdFan();
    await ev(({ from, aim }) => window.__xrEmu.placeAt('right', from, aim), {
      from: await headPoint([0.2, -0.32, -0.25]),
      aim: await headPoint([0.3, -0.6, -1]),
    });
    await settle(500);
    const fan = await ev(() => {
      const s = window.__combat.session;
      const parent = s.fan.root.parent;
      return {
        cards: s.fan.count,
        onGrip: parent?.parent?.name === 'player-rig',
        rootOffset: s.fan.root.position.toArray().map((v) => Number(v.toFixed(3))),
      };
    });
    await shot('12-fan-held');
    record('xr-fan-in-off-hand', fan.onGrip && fan.cards > 0, {
      ...fan,
      note: 'clearance is proven in tests/fan-hand-clearance.test.ts; this is the visual',
    });
    await ev(() => window.__xrEmu.setHead(1.2, 0));
    await holdFan();

    // Stage the sigil card with the main hand: point at it, squeeze, carry it over the table, let go.
    const pick = await ev(() => {
      const s = window.__combat.session;
      const hand = s.controller.state.piles.hand;
      const index = hand.findIndex((c) => c.def.type === 'sigil');
      if (index < 0) return null;
      const card = hand[index];
      const at = s.worldOf('card', card.uid);
      return { index, uid: card.uid, id: card.def.id, at: { x: at.x, y: at.y, z: at.z } };
    });
    if (!pick) {
      record('xr-sigil-stage', false, 'no sigil card reached the hand');
      return;
    }
    const mainFrom = await headPoint([0.18, -0.28, -0.3]);
    await ev(({ from, at }) => window.__xrEmu.placeAt('right', from, at), {
      from: mainFrom,
      at: pick.at,
    });
    await frames();
    // Squeeze only once the ray rests on the sigil card: a squeeze grabs whichever card is hovered.
    await waitFor(
      'sigil-card-hovered',
      (index) => window.__combat.session.fan.hovered === index,
      pick.index,
      3000,
    );
    const hoveredCard = await ev(() => window.__combat.session.fan.hovered);
    await ev(() => window.__xrEmu.device.controllers.right.updateButtonValue('squeeze', 1));
    await settle(300);
    const table = await ev(() => {
      const p = window.__combat.session.worldOf('table');
      return { x: p.x, y: p.y, z: p.z };
    });
    const over = { x: table.x, y: table.y + 0.3, z: table.z };
    for (let step = 1; step <= 6; step += 1) {
      const t = step / 6;
      const from = {
        x: mainFrom.x + (over.x - mainFrom.x) * t,
        y: mainFrom.y + (over.y - mainFrom.y) * t,
        z: mainFrom.z + (over.z - mainFrom.z) * t,
      };
      await ev(({ from, table }) => window.__xrEmu.placeAt('right', from, table), { from, table });
      await settle(60);
    }
    await settle(300);
    await ev(() => window.__xrEmu.device.controllers.right.updateButtonValue('squeeze', 0));
    await settle(500);
    const staged = await ev(() => {
      const s = window.__combat.session;
      return {
        stage: s.controller.stage,
        plate: s.plate.phase,
        hint: s.plate.hintText ?? null,
        message: s.message,
        fling: s.fling.debugText(),
      };
    });
    record('xr-sigil-stage', staged.stage === 'sigil' && staged.plate === 'ready', {
      card: pick.id,
      index: pick.index,
      hoveredCard,
      ...staged,
    });
    if (staged.plate !== 'ready') return;
    record('xr-sigil-hint', /trigger/i.test(staged.hint ?? '') && /trigger/i.test(staged.message), {
      plateHint: staged.hint,
      message: staged.message,
    });

    // Trace the card's own glyph with the main-hand ray, trigger held, from a resting hand.
    const glyph = await ev(async (cardId) => {
      const { SIGIL_TEMPLATES } = await import('/src/sigil/templates.ts');
      const { CARDS_BY_ID } = await import('/src/content/cards.ts');
      const sigil = CARDS_BY_ID.get(cardId).sigil;
      const p = window.__combat.session.platePoseNow;
      const size = Math.min(p.halfWidth, p.halfHeight) * 2 * 0.8;
      const world = (pt) => {
        const x = (pt.x - 0.5) * size;
        const y = (pt.y - 0.5) * size;
        return {
          x: p.center.x + p.right.x * x + p.up.x * y,
          y: p.center.y + p.right.y * x + p.up.y * y,
          z: p.center.z + p.right.z * x + p.up.z * y,
        };
      };
      return { sigil, strokes: SIGIL_TEMPLATES[sigil].strokes.map((s) => s.map(world)) };
    }, pick.id);
    const pen = await headPoint([0.15, -0.3, -0.25]);
    const pointAt = (target) =>
      ev(({ from, target }) => window.__xrEmu.placeAt('right', from, target), {
        from: pen,
        target,
      });
    const home = glyph.strokes[0][0];
    await pointAt(home);
    await settle(300);
    const before = await page.screenshot({ type: 'png' });
    const trace = [];
    for (const [s, stroke] of glyph.strokes.entries()) {
      await pointAt(stroke[0]);
      await settle(80);
      await ev(() => window.__xrEmu.device.controllers.right.updateButtonValue('trigger', 1));
      await settle(80);
      for (const [i, point] of stroke.entries()) {
        await pointAt(point);
        await settle(40);
        if (s === 0 && i === Math.floor(stroke.length * 0.6)) await shot('13-sigil-tracing');
      }
      if (s === glyph.strokes.length - 1) {
        await pointAt(home);
        await settle(150);
      }
      trace.push(
        await ev(() => {
          const s = window.__combat.session;
          const trail = s.plate.getObjectByName('sigil-plate-trail');
          return {
            points: s.plate.pointCount,
            strokes: s.plate.strokes.length,
            trailDrawCount: trail.geometry.drawRange.count,
            phase: s.plate.phase,
          };
        }),
      );
      if (s === glyph.strokes.length - 1) {
        const after = await page.screenshot({ type: 'png' });
        trace.push({ newTrailPixels: await newTrailPixels(before, after) });
      }
      await ev(() => window.__xrEmu.device.controllers.right.updateButtonValue('trigger', 0));
      await settle(120);
    }
    const drawn = trace.at(-2);
    const pixels = trace.at(-1).newTrailPixels;
    record('xr-sigil-trail', drawn.trailDrawCount > 0 && pixels > 150, {
      sigil: glyph.sigil,
      perStroke: trace.slice(0, -1),
      newTrailPixels: pixels,
    });
    await settle(1200);
    await shot('14-sigil-cast');
    const cast = await ev(() => {
      const s = window.__combat.session;
      return {
        label: s.plate.labelText,
        plate: s.plate.phase,
        message: s.message,
        stage: s.controller.stage,
        log: s.log.slice(-3),
      };
    });
    record(
      'xr-sigil-cast',
      cast.label !== '' &&
        !/too short|fizzle/i.test(cast.label) &&
        !/too short/i.test(cast.message),
      cast,
    );
  }

  /** New-red pixels (the hit flash) present in `after` but not in `before`, at the frame edge and centre. */
  function redEdgePixels(before, after) {
    return ev(
      async ({ a, b }) => {
        const read = async (src) => {
          const img = new Image();
          img.src = `data:image/png;base64,${src}`;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const g = canvas.getContext('2d');
          g.drawImage(img, 0, 0);
          return {
            data: g.getImageData(0, 0, img.width, img.height).data,
            w: img.width,
            h: img.height,
          };
        };
        const pa = await read(a);
        const pb = await read(b);
        const { w, h } = pb;
        let edge = 0;
        let edgeArea = 0;
        let center = 0;
        let centerArea = 0;
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 4;
            const redder =
              pb.data[i] - pa.data[i] > 20 && pb.data[i] > pb.data[i + 1] + 25 && pb.data[i] > 70;
            const u = x / w;
            const v = y / h;
            const isEdge = u < 0.08 || u > 0.92 || v < 0.1 || v > 0.9;
            const isCenter = Math.abs(u - 0.5) < 0.12 && Math.abs(v - 0.5) < 0.15;
            if (isEdge) {
              edgeArea += 1;
              if (redder) edge += 1;
            } else if (isCenter) {
              centerArea += 1;
              if (redder) center += 1;
            }
          }
        }
        return {
          edge,
          center,
          edgeShare: Number((edge / edgeArea).toFixed(4)),
          centerShare: Number((center / centerArea).toFixed(4)),
        };
      },
      { a: before.toString('base64'), b: after.toString('base64') },
    );
  }

  /** Steps until the enemy phase is over (each automaton takes its turn in order). */
  async function enemyPhaseOver(label, timeout = 20000) {
    return waitFor(label, () => window.__combat.session?.enemyPhase !== true, undefined, timeout);
  }

  /**
   * The enemy phase in XR on a two-automaton fight (TURN_SEED room 2): each automaton acts only
   * after the one before it resolved plus the gap, a natural hit drew the edge flash pass while
   * presenting, and the flash (held at its peak) shows red at the edges of the XR frame and not in
   * the middle. Runs on a fresh page load so the walk's own seed and checks stay as they were.
   */
  async function enemyTurnCheck() {
    const base = opts.base.replace(/\/$/, '');
    await page.goto(`${base}/?seed=${TURN_SEED}&debug`);
    await waitFor(
      'turns-app',
      () => window.__combat?.floor && window.__xrEmu.ctx().renderer,
      undefined,
      60000,
    );
    await settle(1500);
    await enterVr();
    const room = await ev(() => window.__combat.teleportToEncounter());
    await waitFor(
      'turns-fight-active',
      () => window.__combat.floor.encounter.phase === 'active' && window.__combat.session !== null,
      undefined,
      30000,
    );
    await settle(1800);
    await ev(() => window.__xrEmu.setHead(1.2, -0.25));
    await settle(300);
    const setup = await ev(() => {
      const s = window.__combat.session;
      const floor = window.__combat.floor;
      return {
        enemies: s.view.enemies.filter((e) => e.hp > 0).map((e) => e.id),
        models: s.enemies.map((e) => floor.actorOf(e.body) !== null),
        hp: s.view.player.hp,
        trace: s.turnTrace.length,
        hits: window.__combat.hitFx.log.length,
      };
    });
    // In-page sampler: the flash's peak opacity and whether its pass rendered while presenting.
    await ev(() => {
      const fx = window.__combat.hitFx;
      const probe = window.__xrEmu;
      const sampler = { max: 0, passSeen: false, enemyStageSeen: false };
      sampler.timer = setInterval(() => {
        sampler.max = Math.max(sampler.max, fx.opacity);
        if (probe.passes.slice(-12).some((p) => p.scene === fx.scene.uuid)) sampler.passSeen = true;
        if (window.__combat.session?.stage === 'enemy') sampler.enemyStageSeen = true;
      }, 10);
      window.__turnSampler = sampler;
    });
    await page.keyboard.press('KeyE');
    const burst = [];
    for (let i = 0; i < 16; i += 1) {
      await settle(220);
      const st = await ev(() => {
        const s = window.__combat.session;
        const open = s.turnTrace.at(-1);
        return {
          phase: s.enemyPhase,
          t: Number(s.time.toFixed(2)),
          acting: open && open.end === null ? open.enemyId : null,
          flash: Number(window.__combat.hitFx.opacity.toFixed(3)),
          hp: s.view.player.hp,
        };
      });
      if (!st.phase) break;
      const name = `15-enemy-turn-${String(i).padStart(2, '0')}`;
      await shot(name);
      burst.push({ name, ...st });
    }
    await enemyPhaseOver('turns-phase-over');
    const after = await ev((from) => {
      const s = window.__combat.session;
      const sampler = window.__turnSampler;
      clearInterval(sampler.timer);
      return {
        trace: s.turnTrace.slice(from.trace),
        hits: window.__combat.hitFx.log.slice(from.hits),
        sampler: {
          max: sampler.max,
          passSeen: sampler.passSeen,
          enemyStageSeen: sampler.enemyStageSeen,
        },
        hp: s.view.player.hp,
        fan: s.fan.count,
      };
    }, setup);
    const gap = 0.35;
    const ordered =
      after.trace.length === setup.enemies.length &&
      after.trace.every((b, i) => b.enemyId === setup.enemies[i]);
    const sequential = after.trace.every(
      (b, i) =>
        b.impact !== null &&
        b.end !== null &&
        b.impact >= b.start &&
        (i === 0 || b.start >= after.trace[i - 1].end + gap - 0.02),
    );
    record(
      'xr-enemy-turns-sequential',
      setup.enemies.length >= 2 && ordered && sequential && after.sampler.enemyStageSeen,
      {
        room,
        enemies: setup.enemies,
        models: setup.models,
        trace: after.trace.map((b) => ({
          ...b,
          start: Number(b.start.toFixed(2)),
          impact: b.impact === null ? null : Number(b.impact.toFixed(2)),
          end: b.end === null ? null : Number(b.end.toFixed(2)),
        })),
        burst,
        fanAfter: after.fan,
      },
    );
    record(
      'xr-hit-flash-natural',
      after.hits.length > 0 ? after.sampler.max > 0.05 && after.sampler.passSeen : null,
      {
        hits: after.hits,
        hp: [setup.hp, after.hp],
        maxOpacity: Number(after.sampler.max.toFixed(3)),
        passRenderedWhilePresenting: after.sampler.passSeen,
        note: after.hits.length > 0 ? 'a real enemy blow fired it' : 'no blow landed this turn',
      },
    );
    // Pixel check: the flash held at its peak against the same pose without it.
    await ev(() => window.__combat.hitFx.hold({ kind: 'hit', amount: 8, blocked: 0, hpLost: 8 }));
    await settle(300);
    const withFlash = await page.screenshot({ type: 'png' });
    await shot('16-hit-vignette-held');
    await ev(() => window.__combat.hitFx.release());
    await settle(900);
    const without = await page.screenshot({ type: 'png' });
    const px = await redEdgePixels(without, withFlash);
    record('xr-hit-vignette-visible', px.edgeShare > 0.05 && px.centerShare < 0.005, {
      ...px,
      note: 'new red pixels at the outer frame band vs the centre, flash held at peak',
    });
  }

  async function deathAndBack() {
    await ev(() => window.__flow.setCheat('lose'));
    let room = await ev(() => window.__combat.teleportToEncounter());
    if (room === null)
      room = await ev(() => window.__combat.teleportToEncounter({ guardian: true }));
    await waitFor(
      'fight2-active',
      () => window.__combat.floor.encounter.phase === 'active',
      undefined,
      30000,
    );
    await settle(1000);
    // A 1 hp player: end turns until the automaton's attack lands.
    let path = 'end-turn (KeyE) with ?cheat lose';
    for (let i = 0; i < 6 && (await phase()) !== 'death'; i += 1) {
      await page.keyboard.press('KeyE');
      await settle(300);
      await enemyPhaseOver(`death-turn-${i}`);
      await settle(2200);
    }
    if ((await phase()) !== 'death') {
      path = 'flow.fightEnded defeat (fallback)';
      await ev(() => {
        const floor = window.__combat.floor;
        window.__flow.flow.fightEnded({
          room: floor.encounter.activeRoom,
          outcome: 'defeat',
          tier: 'regular',
        });
      });
    }
    await waitFor('death', () => window.__flow.flow.phase === 'death');
    await settle(800);
    const board = await ev(() => {
      const probe = window.__xrEmu;
      const at = probe.worldOf('summary-board');
      return at && probe.headTo(at);
    });
    await shot('8-death-board');
    const hovered = await press('summary-title');
    record('death-board', (await phase()) === 'title', { room, path, board, hovered });

    // Workshop Buy with the cogs the death banked.
    await press('title-workshop');
    const buy = await ev(() => {
      const { ui, flow } = window.__flow;
      const prefix = 'workshop-buy-';
      const id = ui
        .controlIds()
        .find((c) => c.startsWith(prefix) && flow.canBuy(c.slice(prefix.length)));
      return { id: id ?? null, cogs: flow.workshop.cogsBanked };
    });
    let bought = null;
    if (buy.id) {
      await press(buy.id);
      bought = await ev(() => window.__flow.flow.workshop.cogsBanked);
    }
    await shot('9-workshop');
    await press('workshop-back');
    record('workshop-buy', buy.id ? bought < buy.cogs : null, {
      ...buy,
      after: bought,
      note: buy.id ? 'bought with the ray' : 'no affordable upgrade: Buy not exercised',
    });

    // New Run after death without leaving XR: a fresh floor, same session.
    await ev(() => {
      window.__xrEmuDeadFloor = window.__combat.floor;
      window.__xrEmuSession = window.__xrEmu.ctx().renderer.xr.getSession();
    });
    await press('title-new-run');
    await settle(1000);
    const rerun = await ev(() => ({
      phase: window.__flow.flow.phase,
      rebuilt: window.__combat.floor !== window.__xrEmuDeadFloor,
      sameSession: window.__xrEmu.ctx().renderer.xr.getSession() === window.__xrEmuSession,
      presenting: window.__xrEmu.ctx().renderer.xr.isPresenting,
      rigY: window.__xrEmu.ctx().rig.position.y,
    }));
    await shot('10-rerun-explore');
    record(
      'rerun-floor-rebuild-in-xr',
      rerun.phase === 'explore' && rerun.rebuilt && rerun.sameSession && rerun.presenting,
      rerun,
    );
  }

  async function noticeCheck() {
    const base = opts.notice.replace(/\/$/, '');
    await page.route('**/version.json*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ buildId: 'deadbeefcafe0001' }),
      }),
    );
    await page.goto(`${base}/?title&debug&version-poll=2`);
    await waitFor(
      'app',
      () => window.__flow?.ui && window.__xrEmu.ctx().renderer,
      undefined,
      60000,
    );
    record('gpu', null, await gpu());
    await settle(3000);
    await shot('11a-desktop-notice');
    await enterVr();
    await settle(2500);
    const panel = await ev(() => {
      const probe = window.__xrEmu;
      const node = probe.scenes.map((s) => s.getObjectByName('update-notice')).find(Boolean);
      const at = node && probe.worldOf('update-notice');
      return { found: !!node, visible: node?.visible ?? false, at: at && probe.headTo(at) };
    });
    record('xr-notice-shown', panel.visible, panel);
    const order = await ev(() => {
      const probe = window.__xrEmu;
      const { uiScene, world } = probe.ctx();
      const noticeScene = probe.scenes.find((s) => s.getObjectByName('update-notice'));
      const name = (p) =>
        p.scene === uiScene.uuid
          ? 'boards'
          : p.scene === world.uuid
            ? 'world'
            : p.scene === noticeScene?.uuid
              ? 'notice'
              : 'other';
      const passes = probe.passes.slice(-8).map(name);
      return {
        boardsVisible: window.__flow.ui.visible,
        lastPasses: passes.slice(-4),
        noticeAfterBoards: passes.lastIndexOf('notice') > passes.lastIndexOf('boards'),
      };
    });
    record('xr-notice-above-boards', !order.boardsVisible || order.noticeAfterBoards, {
      ...order,
      note: 'the notice must draw in a pass after the boards, which clear depth',
    });
    // Later sits at canvas (500, 215) of 640x300 on a 0.64 x 0.3 m plane.
    const later = await ev(() => window.__xrEmu.worldOf('update-notice', [0.18, -0.065, 0]));
    await aim(MAIN, later);
    await settle(400);
    await shot('11b-xr-update-notice');
    await pullTrigger(MAIN);
    const hidden = await ev(
      () =>
        !window.__xrEmu.scenes.map((s) => s.getObjectByName('update-notice')).find(Boolean)
          ?.visible,
    );
    record('xr-notice-later', hidden, { hiddenAfterLater: hidden });
  }
} finally {
  await browser.close();
  const fails = results.filter((r) => r.pass === false);
  const report = { when: new Date().toISOString(), results, consoleErrors };
  writeFileSync(
    join(opts.out, `xr-emu-report${opts.notice ? '-notice' : ''}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(
    `\n${results.length} checks, ${fails.length} failed, ${consoleErrors.length} console errors`,
  );
  for (const e of consoleErrors.slice(0, 10)) console.log(`  console: ${e}`);
  process.exitCode = fails.length > 0 ? 1 : 0;
}
