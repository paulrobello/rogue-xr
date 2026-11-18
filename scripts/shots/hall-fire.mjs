#!/usr/bin/env node
// Hall fireplace fire stills (docs/verification/hall-fire-*.jpg) from the real game page: on
// `/?seed=SPIRE002&debug` room 0 is the hall, dressed through main.ts with its live fireplace fire
// (src/world/fireplace.ts). Shots: the fireplace from the hall's spawn point (the entry view) and
// from 1.5 m in front of the firebox, both with the eye at 1.6 m, then a strip of six frames
// 0.15 s apart from the close pose, composed side by side.
//
//   node scripts/shots/hall-fire.mjs [--base http://localhost:4260] [--out docs/verification]
//
// Needs a running dev server and a GPU (ANGLE on Metal; PW_GPU=swiftshader opts into software GL).
// Fails (exit 1) when the hall has no live fire, a frame is black, the strip frames do not differ,
// the fire adds other than one draw call, the page logs an error, or the GPU is not Apple.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4260' },
    out: { type: 'string', default: 'docs/verification' },
    seed: { type: 'string', default: 'SPIRE002' },
  },
});
const GPU_ARGS =
  (process.env.PW_GPU ?? 'metal') === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const VIEWPORT = { width: 1600, height: 1000 };
const EYE_Y = 1.6;
const CLOSE_DISTANCE = 1.5;
const STRIP_FRAMES = 6;
const STRIP_SECONDS = 0.15;
const LOOK_DEGREES_PER_PIXEL = 0.23;
const PITCH_RADIANS_PER_PIXEL = 0.004;

const report = { base: opts.base, seed: opts.seed, gpu: null, shots: [], strip: null, errors: [] };
const fail = (message) => {
  report.errors.push(message);
  console.error(`FAIL ${message}`);
};

function aim(eye, target) {
  const dx = target[0] - eye[0];
  const dz = target[2] - eye[2];
  return {
    yaw: (Math.atan2(dx, -dz) * 180) / Math.PI,
    pitch: Math.atan2(target[1] - eye[1], Math.hypot(dx, dz)),
  };
}

async function pose(page, eye, look) {
  await page.evaluate(
    ({ eye }) => {
      const camera = window.__combat.camera;
      camera.parent.position.set(eye[0], eye[1] - camera.position.y, eye[2]);
    },
    { eye },
  );
  await page.evaluate(
    ({ yaw, pitch, lookRate, tilt }) => {
      const camera = window.__combat.camera;
      const rig = camera.parent;
      const canvas = document.querySelector('canvas');
      const yawNow = (-rig.rotation.y * 180) / Math.PI;
      const turn = ((((yaw - yawNow) % 360) + 540) % 360) - 180;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          movementX: Math.round(turn / lookRate),
          movementY: Math.round(-(pitch - camera.rotation.x) / tilt),
        }),
      );
      window.dispatchEvent(new PointerEvent('pointerup'));
    },
    { ...look, lookRate: LOOK_DEGREES_PER_PIXEL, tilt: PITCH_RADIANS_PER_PIXEL },
  );
  await page.waitForTimeout(500);
}

/** Mean RGB of a JPEG (and, with `other`, the mean absolute difference between the two). */
async function stats(page, jpeg, other = null) {
  return page.evaluate(
    async ({ a, b }) => {
      const pixels = async (b64) => {
        const img = new Image();
        img.src = `data:image/jpeg;base64,${b64}`;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = 320;
        c.height = 200;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, 320, 200);
        return g.getImageData(0, 0, 320, 200).data;
      };
      const d = await pixels(a);
      const m = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) m[k] += d[i + k];
      const mean = m.map((v) => Math.round((v / (d.length / 4)) * 10) / 10);
      if (!b) return { mean };
      const e = await pixels(b);
      let diff = 0;
      let changed = 0;
      for (let i = 0; i < d.length; i += 4) {
        const px =
          Math.abs(d[i] - e[i]) + Math.abs(d[i + 1] - e[i + 1]) + Math.abs(d[i + 2] - e[i + 2]);
        diff += px;
        if (px > 24) changed++;
      }
      return { mean, diff: Math.round((diff / (d.length / 4)) * 100) / 100, changed };
    },
    { a: jpeg.toString('base64'), b: other ? other.toString('base64') : null },
  );
}

async function fireState(page) {
  return page.evaluate(() => {
    const c = window.__combat;
    const fire = c.floor.world.roomGroups[0].getObjectByName('fireplace-fire');
    if (!fire) return null;
    fire.updateWorldMatrix(true, false);
    const e = fire.matrixWorld.elements;
    return {
      at: [e[12], e[13], e[14]],
      out: [e[8], e[9], e[10]],
      uTime: fire.material.uniforms.uTime.value,
      template: c.floor.world.plan.rooms[0].templateId,
      spawn: (() => {
        const s = c.floor.world.spawnPoint();
        return [s.x, s.y, s.z];
      })(),
    };
  });
}

async function drawCalls(page) {
  return page.evaluate(async () => {
    const c = window.__combat;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const fire = c.floor.world.roomGroups[0].getObjectByName('fireplace-fire');
    await frame();
    const withFire = c.stats.calls;
    fire.visible = false;
    await frame();
    const without = c.stats.calls;
    fire.visible = true;
    await frame();
    return { withFire, without };
  });
}

mkdirSync(opts.out, { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: GPU_ARGS });
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', (error) => fail(`page error ${error}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/\/audio\/music\/|music not found|404/.test(msg.text()))
      fail(`console ${msg.text()}`);
  });
  await page.goto(`${opts.base}/?seed=${opts.seed}&debug`);
  await page.waitForFunction(() => window.__combat?.floor && window.__combat.heroReady, null, {
    timeout: 90000,
  });
  await page.evaluate(() => window.__combat.heroReady);
  report.gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  const fire = await fireState(page);
  report.fire = fire;
  if (!fire) throw new Error('room 0 has no fireplace-fire');
  if (fire.template !== 'hall') fail(`room 0 is ${fire.template}, not the hall`);
  const target = [fire.at[0], 0.38, fire.at[2]];
  const close = [
    fire.at[0] + fire.out[0] * CLOSE_DISTANCE,
    EYE_Y,
    fire.at[2] + fire.out[2] * CLOSE_DISTANCE,
  ];
  const shots = [
    { name: 'hall-fire-entry', eye: [fire.spawn[0], EYE_Y, fire.spawn[2]] },
    { name: 'hall-fire-close', eye: close },
  ];
  for (const shot of shots) {
    await pose(page, shot.eye, aim(shot.eye, target));
    const calls = await drawCalls(page);
    const path = join(opts.out, `${shot.name}.jpg`);
    const jpeg = await page.screenshot({ path, type: 'jpeg', quality: 90 });
    const { mean } = await stats(page, jpeg);
    report.shots.push({ ...shot, path, calls, mean });
    console.log(
      `${shot.name}: eye=${JSON.stringify(shot.eye)} calls=${calls.withFire} (without fire ${calls.without}) mean=${JSON.stringify(mean)} -> ${path}`,
    );
    if (calls.withFire - calls.without !== 1)
      fail(`${shot.name}: fire adds ${calls.withFire - calls.without} draw calls`);
    if (mean[0] + mean[1] + mean[2] < 15) fail(`${shot.name}: black frame`);
  }
  // Strip: crop around the firebox from the close pose, six frames 0.15 s apart on the page clock.
  await pose(page, close, aim(close, target));
  const clip = { x: 500, y: 300, width: 600, height: 560 };
  const frames = [];
  const times = [];
  const t0 = await page.evaluate(() => performance.now());
  for (let k = 0; k < STRIP_FRAMES; k++) {
    await page.evaluate(
      (at) =>
        new Promise((r) => {
          const wait = () => (performance.now() >= at ? r() : requestAnimationFrame(wait));
          wait();
        }),
      t0 + k * STRIP_SECONDS * 1000,
    );
    times.push(
      await page.evaluate(
        () =>
          window.__combat.floor.world.roomGroups[0].getObjectByName('fireplace-fire').material
            .uniforms.uTime.value,
      ),
    );
    frames.push(await page.screenshot({ type: 'jpeg', quality: 92, clip }));
  }
  const diffs = [];
  for (let k = 1; k < frames.length; k++) diffs.push(await stats(page, frames[k], frames[k - 1]));
  const strip = await page.evaluate(
    async ({ list, w, h, times }) => {
      const c = document.createElement('canvas');
      c.width = w * list.length;
      c.height = h + 28;
      const g = c.getContext('2d');
      g.fillStyle = '#111';
      g.fillRect(0, 0, c.width, c.height);
      for (let k = 0; k < list.length; k++) {
        const img = new Image();
        img.src = `data:image/jpeg;base64,${list[k]}`;
        await img.decode();
        g.drawImage(img, k * w, 28);
        g.fillStyle = '#ddd';
        g.font = '18px sans-serif';
        g.fillText(`t = ${(times[k] - times[0]).toFixed(2)} s`, k * w + 10, 20);
      }
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    },
    { list: frames.map((f) => f.toString('base64')), w: clip.width, h: clip.height, times },
  );
  const stripPath = join(opts.out, 'hall-fire-strip.jpg');
  writeFileSync(stripPath, Buffer.from(strip, 'base64'));
  const steps = times.slice(1).map((t, k) => Math.round((t - (times[k] ?? 0)) * 1000) / 1000);
  report.strip = { path: stripPath, times, steps, diffs };
  console.log(
    `strip: uTime steps ${JSON.stringify(steps)} diffs ${JSON.stringify(diffs.map((d) => d.diff))} -> ${stripPath}`,
  );
  if (diffs.some((d) => d.changed < 50)) fail('strip: consecutive frames barely differ');
  if (diffs.some((d) => d.mean[0] + d.mean[1] + d.mean[2] < 15)) fail('strip: black frame');
  await context.close();
} finally {
  await browser.close();
}
writeFileSync(join(opts.out, 'hall-fire-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`gpu ${report.gpu}`);
if (report.errors.length || !/Apple|Metal/i.test(report.gpu ?? '')) process.exit(1);
