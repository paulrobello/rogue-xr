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
  },
});

/** macOS GPU flags; PW_GPU=swiftshader opts into software GL. */
const GPU_ARGS =
  (process.env.PW_GPU ?? 'metal') === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const SEATED_HEAD_Y = 1.2;
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

  const enterVr = async () => {
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
    await ev((y) => window.__xrEmu.setHead(y), SEATED_HEAD_Y);
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
  } else {
    await walk();
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
    }));
    record('new-run-in-xr', run.phase === 'explore' && run.seed === opts.seed && run.presenting, {
      bootFloor,
      ...run,
    });
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
    }));
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
    await ev(() => window.__xrEmu.device.controllers.left.updateAxes('thumbstick', 0, -1));
    await settle(1000);
    await ev(() => window.__xrEmu.device.controllers.left.updateAxes('thumbstick', 0, 0));
    await settle(200);
    const moved = await read();
    const distance = Math.hypot(moved.x - start.x, moved.z - start.z);
    record('locomotion-smooth-move', distance > 0.3, {
      metres: Number(distance.toFixed(3)),
      from: start,
      to: moved,
    });
    const snap = async () => {
      await ev(() => window.__xrEmu.device.controllers.right.updateAxes('thumbstick', 1, 0));
      await settle(400);
      await ev(() => window.__xrEmu.device.controllers.right.updateAxes('thumbstick', 0, 0));
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
    record('locomotion-teleport', null, 'not wired: main.ts passes teleportAim: null every frame');
    record(
      'locomotion-vignette',
      null,
      'not drawn: Locomotion.vignetteStrength is computed but nothing in src reads it',
    );
    // Turn back so the rest of the walk faces the way the floor expects.
    await ev(() => {
      window.__xrEmu.ctx().rig.rotation.y = 0;
    });
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
      if (fightIndex === 0) await shot('6-fight');
      const fight = await ev(() => ({
        phase: window.__flow.flow.phase,
        hasSession: window.__combat.session !== null,
      }));
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
      await settle(2500);
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
