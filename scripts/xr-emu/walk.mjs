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
  } else {
    await walk();
    await enemyTurnCheck();
    await recenterCheck();
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
      if (fightIndex === 0) {
        await shot('6-fight');
        await fanAndSigilCheck();
      }
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

  /** Head-relative world point: `offset` metres in the rig's frame from the XR camera. */
  function headPoint(offset) {
    return ev((o) => {
      const { rig, camera } = window.__xrEmu.ctx();
      camera.updateWorldMatrix(true, false);
      const head = camera.getWorldPosition(camera.position.clone());
      const turn = rig.getWorldQuaternion(rig.quaternion.clone());
      const p = head.add(
        camera.position
          .clone()
          .set(...o)
          .applyQuaternion(turn),
      );
      return { x: p.x, y: p.y, z: p.z };
    }, offset);
  }

  /** Holds the off hand up to read the fan: the ray points away from the eyes, forward and low. */
  async function holdFan() {
    const from = await headPoint([-0.1, -0.22, -0.3]);
    const aim = await headPoint([-0.25, -0.45, -1.0]);
    await ev(({ from, aim }) => window.__xrEmu.placeAt('left', from, aim), { from, aim });
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
    await settle(300);
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
