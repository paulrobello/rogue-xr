#!/usr/bin/env node
// P5-T12 integration stills (docs/verification/p5-int-*.jpg) from the real game page: the floor of
// seed SPIRE002 built by main.ts with every hero room dressed (buildFloorWorld + dressRoom, sealed
// doors, the gear-shaft's rigid nodes spinning from the floor clock). Each shot loads
// `/?seed=SPIRE002&debug`, waits for `__combat.heroReady`, stands the rig at a fixed world point with
// the eye at the seated 1.2 m, turns the view through the desktop drag path (pointer events, the
// same `turn` intents a player sends) and screenshots the 1600 x 1000 page with its debug HUD.
//
//   node scripts/shots/p5-int.mjs [--base http://localhost:4260] [--out docs/verification] [--only hall,study]
//   node scripts/shots/p5-int.mjs --greybox --only hall-sealed,corridor-sealed,study-sealed
//
// --greybox blocks every room asset request so each room falls back to its greybox, and writes
// p5-int-greybox-<name>.jpg instead.
//
// Needs a running dev server (`make dev-start`, port 4260) and a GPU: Chromium runs headless with
// ANGLE on Metal (PW_GPU=swiftshader opts into software GL). The run fails (exit 1) when the floor
// plan no longer matches PLAN, a pose cannot be reached, a frame is black, or the page logs an error.
// Each shot prints its measured pose, room, draw calls and the screenshot's mean colour; the GPU
// string closes the run.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4260' },
    out: { type: 'string', default: 'docs/verification' },
    only: { type: 'string', default: '' },
    headed: { type: 'boolean', default: false },
    greybox: { type: 'boolean', default: false },
  },
});

const GPU_ARGS =
  (process.env.PW_GPU ?? 'metal') === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const VIEWPORT = { width: 1600, height: 1000 };
const SEED = 'SPIRE002';
const EYE_Y = 1.2;
/** src/desktop/controls.ts: degrees of turn per dragged pixel and pitch radians per pixel. */
const LOOK_DEGREES_PER_PIXEL = 0.23;
const PITCH_RADIANS_PER_PIXEL = 0.004;
/** The SPIRE002 rooms these poses are written against (index: template, role). */
const PLAN = [
  ['hall', 'entry'],
  ['corridor', 'corridor'],
  ['study', 'combat'],
  ['gear-shaft', 'combat'],
  ['study', 'combat'],
  ['study', 'treasure'],
  ['guardian-vault', 'guardian'],
];
/**
 * World eye (x, z), walker yaw in degrees (0 faces -z, 90 faces +x) and pitch in radians. `wait`
 * holds the pose that long before the frame (the turned gear: the floor clock runs on).
 */
const SHOTS = [
  { name: 'hall', room: 0, eye: [3.0, 3.4], yaw: -48, pitch: 0 },
  { name: 'hall-sealed', room: 0, eye: [-1.9, 1.0], yaw: -90, pitch: 0 },
  { name: 'corridor-sealed', room: 1, eye: [-1.0, 7.4], yaw: 180, pitch: 0 },
  { name: 'study', room: 2, eye: [12.2, -3.1], yaw: -133, pitch: 0 },
  { name: 'study-sealed', room: 5, eye: [-9.0, -9.85], yaw: 180, pitch: 0 },
  { name: 'gear-shaft', room: 3, eye: [14.8, 10.8], yaw: -58, pitch: 0.18 },
  { name: 'gear-shaft-turned', room: 3, eye: [14.8, 10.8], yaw: -58, pitch: 0.18, wait: 2000 },
  { name: 'guardian-vault', room: 6, eye: [23.0, 13.3], yaw: 0, pitch: 0 },
];

const only = new Set(opts.only.split(',').filter(Boolean));
const report = { seed: SEED, base: opts.base, gpu: null, shots: [], errors: [] };
const fail = (message) => {
  report.errors.push(message);
  console.error(`FAIL ${message}`);
};

mkdirSync(opts.out, { recursive: true });
const browser = await chromium.launch({
  channel: 'chromium',
  headless: !opts.headed,
  args: GPU_ARGS,
});
try {
  for (const shot of SHOTS) {
    if (only.size && !only.has(shot.name)) continue;
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    if (opts.greybox) await page.route('**/assets/rooms/**', (route) => route.abort());
    page.on('pageerror', (error) => fail(`${shot.name}: page error ${error}`));
    page.on('console', (msg) => {
      // The music tracks are not produced yet (their 404s are expected, as in the xr-emu walk).
      const blocked = opts.greybox && msg.location()?.url?.includes('/assets/rooms/');
      if (
        msg.type() === 'error' &&
        !blocked &&
        !/\/audio\/music\/|music not found|404/.test(msg.text())
      )
        fail(`${shot.name}: console ${msg.text()}`);
    });
    await page.goto(`${opts.base}/?seed=${SEED}&debug`);
    await page.waitForFunction(() => window.__combat?.floor && window.__combat.heroReady, null, {
      timeout: 60000,
    });
    await page.evaluate(() => window.__combat.heroReady);
    const plan = await page.evaluate(() =>
      window.__combat.floor.world.plan.rooms.map((r) => [r.templateId, r.role]),
    );
    if (JSON.stringify(plan) !== JSON.stringify(PLAN)) {
      fail(`${shot.name}: SPIRE002 plan changed: ${JSON.stringify(plan)}`);
      await context.close();
      continue;
    }
    // Stand the rig at the eye point with the camera at EYE_Y.
    await page.evaluate(
      ({ eye, eyeY }) => {
        const camera = window.__combat.camera;
        camera.parent.position.set(eye[0], eyeY - camera.position.y, eye[1]);
      },
      { eye: shot.eye, eyeY: EYE_Y },
    );
    // Turn and pitch through the desktop drag path; the pose is read back below.
    await page.evaluate(
      ({ yaw, pitch, look, tilt }) => {
        const camera = window.__combat.camera;
        const rig = camera.parent;
        const canvas = document.querySelector('canvas');
        const yawNow = (-rig.rotation.y * 180) / Math.PI;
        const turn = ((((yaw - yawNow) % 360) + 540) % 360) - 180;
        canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        window.dispatchEvent(
          new PointerEvent('pointermove', {
            movementX: Math.round(turn / look),
            movementY: Math.round(-(pitch - camera.rotation.x) / tilt),
          }),
        );
        window.dispatchEvent(new PointerEvent('pointerup'));
      },
      {
        yaw: shot.yaw,
        pitch: shot.pitch,
        look: LOOK_DEGREES_PER_PIXEL,
        tilt: PITCH_RADIANS_PER_PIXEL,
      },
    );
    await page.waitForTimeout(400 + (shot.wait ?? 0));
    const state = await page.evaluate(() => {
      const c = window.__combat;
      const camera = c.camera;
      const p = camera.getWorldPosition(new camera.position.constructor());
      return {
        eye: [p.x, p.y, p.z].map((v) => Math.round(v * 1000) / 1000),
        yaw: Math.round(((-camera.parent.rotation.y * 180) / Math.PI) * 100) / 100,
        pitch: Math.round(camera.rotation.x * 1000) / 1000,
        room: c.floor.world.current,
        calls: c.stats.calls,
        hud: document.getElementById('debug-hud')?.textContent?.split('\n')[0] ?? '',
      };
    });
    const path = join(opts.out, `p5-int-${opts.greybox ? 'greybox-' : ''}${shot.name}.jpg`);
    const jpeg = await page.screenshot({ path, type: 'jpeg', quality: 85 });
    // Mean colour of the saved frame itself (the play canvas does not preserve its buffer).
    const mean = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 40;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 64, 40);
      const d = g.getImageData(0, 0, 64, 40).data;
      const m = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) m[k] += d[i + k];
      return m.map((v) => Math.round((v / (d.length / 4)) * 10) / 10);
    }, jpeg.toString('base64'));
    report.gpu ??= await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    report.shots.push({ ...shot, path, state, mean });
    console.log(`${shot.name}: ${JSON.stringify(state)} mean=${JSON.stringify(mean)} -> ${path}`);
    if (state.room !== shot.room)
      fail(`${shot.name}: eye is in room ${state.room}, wanted ${shot.room}`);
    if (Math.abs(state.eye[1] - EYE_Y) > 0.01) fail(`${shot.name}: eye height ${state.eye[1]}`);
    const dyaw = Math.abs(((((state.yaw - shot.yaw) % 360) + 540) % 360) - 180);
    if (dyaw > 0.5 || Math.abs(state.pitch - shot.pitch) > 0.01)
      fail(`${shot.name}: pose not reached`);
    if (mean[0] + mean[1] + mean[2] < 15) fail(`${shot.name}: black frame ${JSON.stringify(mean)}`);
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(`gpu ${report.gpu}`);
if (report.errors.length || !/Apple|Metal/i.test(report.gpu ?? '')) process.exit(1);
