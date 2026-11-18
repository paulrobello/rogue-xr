#!/usr/bin/env node
// Table-decoration stills (assets-source/props/table-decor/engine/*.jpg) from the real game page:
// for each seed, `/?seed=<seed>&debug` builds the floor through main.ts (hero rooms dressed, seeded
// props from src/floor/table-decor.ts merged into one mesh per dressed room). Every dressed table is
// framed from the room-centre side with the eye at the seated 1.2 m, about 1 m from the table,
// turned and pitched through the desktop drag path (as p5-int.mjs). One close-up per prop kind
// follows, the eye 0.4 m above and 0.5 m out from that prop.
//
//   node scripts/shots/table-decor.mjs [--base http://localhost:4260] [--out assets-source/props/table-decor/engine]
//
// Needs a running dev server and a GPU (ANGLE on Metal; PW_GPU=swiftshader opts into software GL).
// Fails (exit 1) when a seed has no dressed table, a prop sits off its table, a pose cannot be
// reached, a frame is black, the page logs an error, or the GPU is not Apple. Each shot prints its
// pose, room, draw calls with and without the decoration mesh, and the frame's mean colour.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: opts } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4260' },
    out: { type: 'string', default: 'assets-source/props/table-decor/engine' },
    seeds: { type: 'string', default: 'SPIRE002,SPIRE004' },
    headed: { type: 'boolean', default: false },
  },
});

const GPU_ARGS =
  (process.env.PW_GPU ?? 'metal') === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const VIEWPORT = { width: 1600, height: 1000 };
const EYE_Y = 1.2;
const TABLE_DISTANCE = 1.0;
const CLOSE_DISTANCE = 0.5;
const CLOSE_RISE = 0.4;
/** src/desktop/controls.ts: degrees of turn per dragged pixel and pitch radians per pixel. */
const LOOK_DEGREES_PER_PIXEL = 0.23;
const PITCH_RADIANS_PER_PIXEL = 0.004;
/** src/floor/table-decor.ts DECOR_TABLES, template-local (x, z, half extents, top). */
const TABLES = {
  'hall:bench-w': { x: -4, z: 0, halfX: 0.21, halfZ: 0.45, top: 0.47 },
  'hall:bench-e': { x: 4, z: 0, halfX: 0.21, halfZ: 0.45, top: 0.47 },
  'gear-shaft:crate': { x: 3, z: 4.5, halfX: 0.4, halfZ: 0.4, top: 0.8 },
};

const report = { base: opts.base, gpu: null, seeds: {}, shots: [], errors: [] };
const fail = (message) => {
  report.errors.push(message);
  console.error(`FAIL ${message}`);
};

/** Yaw (degrees, 0 faces -z, 90 faces +x) and pitch (radians) from an eye to a target. */
function aim(eye, target) {
  const dx = target[0] - eye[0];
  const dz = target[2] - eye[2];
  const yaw = (Math.atan2(dx, -dz) * 180) / Math.PI;
  const pitch = Math.atan2(target[1] - eye[1], Math.hypot(dx, dz));
  return { yaw, pitch };
}

async function meanColour(page, jpeg) {
  return page.evaluate(async (b64) => {
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
  await page.waitForTimeout(400);
}

/** Draw calls of the next scene pass with the decoration meshes shown, then hidden. */
async function drawCalls(page) {
  return page.evaluate(async () => {
    const c = window.__combat;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const meshes = [];
    for (const g of c.floor.world.roomGroups) {
      g.traverse((n) => {
        if (n.userData.tableDecor) meshes.push(n);
      });
    }
    await frame();
    const withDecor = c.stats.calls;
    for (const m of meshes) m.visible = false;
    await frame();
    const without = c.stats.calls;
    for (const m of meshes) m.visible = true;
    await frame();
    return { withDecor, without };
  });
}

/**
 * Screen pixels of every dressed prop in the current room: its base centre, its top, the candle
 * flame, and table points walked from the base toward the eye (metres from the axis), for
 * contact-shadow and light-pool profiles.
 */
async function probes(page) {
  return page.evaluate(
    ({ walk }) => {
      const c = window.__combat;
      const camera = c.camera;
      const V = camera.position.constructor;
      const eye = camera.getWorldPosition(new V());
      const canvas = document.querySelector('canvas');
      const px = (v) => {
        const n = v.clone().project(camera);
        return [
          Math.round(((n.x + 1) / 2) * canvas.clientWidth * 10) / 10,
          Math.round(((1 - n.y) / 2) * canvas.clientHeight * 10) / 10,
        ];
      };
      const out = [];
      const g = c.floor.world.roomGroups[c.floor.world.current];
      g?.updateMatrixWorld(true);
      g?.traverse((n) => {
        if (!n.userData.tableDecor) return;
        for (const p of n.userData.placements) {
          const at = (x, y, z) => new V(x, y, z).applyMatrix4(n.matrixWorld);
          const base = at(p.x, p.y, p.z);
          const toEye = new V(eye.x - base.x, 0, eye.z - base.z).normalize();
          const height = { candle: 0.203, books: 0.084, vase: 0.222 }[p.kind];
          out.push({
            kind: p.kind,
            variant: p.variant,
            table: p.table,
            base: px(base),
            top: px(base.clone().setY(base.y + height)),
            flame: p.kind === 'candle' ? px(base.clone().setY(base.y + 0.18)) : null,
            walk: walk.map((d) => [d, px(base.clone().addScaledVector(toEye, d))]),
          });
        }
      });
      return out;
    },
    { walk: [0.04, 0.055, 0.065, 0.075, 0.09, 0.11, 0.14, 0.18, 0.25] },
  );
}

async function shoot(page, shot) {
  await pose(page, shot.eye, aim(shot.eye, shot.target));
  const calls = await drawCalls(page);
  const state = await page.evaluate(() => {
    const c = window.__combat;
    const camera = c.camera;
    const p = camera.getWorldPosition(new camera.position.constructor());
    return {
      eye: [p.x, p.y, p.z].map((v) => Math.round(v * 1000) / 1000),
      yaw: Math.round(((-camera.parent.rotation.y * 180) / Math.PI) * 100) / 100,
      pitch: Math.round(camera.rotation.x * 1000) / 1000,
      room: c.floor.world.current,
    };
  });
  const path = join(opts.out, `${shot.name}.jpg`);
  const jpeg = await page.screenshot({ path, type: 'jpeg', quality: 88 });
  const mean = await meanColour(page, jpeg);
  report.shots.push({ ...shot, path, state, calls, mean, probes: await probes(page) });
  console.log(
    `${shot.name}: ${shot.props} ${JSON.stringify(state)} calls=${calls.withDecor} (without decor ${calls.without}) mean=${JSON.stringify(mean)} -> ${path}`,
  );
  const want = aim(shot.eye, shot.target);
  if (state.room !== shot.room)
    fail(`${shot.name}: eye in room ${state.room}, wanted ${shot.room}`);
  if (Math.abs(state.eye[1] - shot.eye[1]) > 0.01) fail(`${shot.name}: eye height ${state.eye[1]}`);
  const dyaw = Math.abs(((((state.yaw - want.yaw) % 360) + 540) % 360) - 180);
  if (dyaw > 0.5 || Math.abs(state.pitch - want.pitch) > 0.01)
    fail(`${shot.name}: pose not reached`);
  if (mean[0] + mean[1] + mean[2] < 15) fail(`${shot.name}: black frame ${JSON.stringify(mean)}`);
}

mkdirSync(opts.out, { recursive: true });
const browser = await chromium.launch({
  channel: 'chromium',
  headless: !opts.headed,
  args: GPU_ARGS,
});
const closeUps = new Map();
try {
  for (const seed of opts.seeds.split(',').filter(Boolean)) {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (error) => fail(`${seed}: page error ${error}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/\/audio\/music\/|music not found|404/.test(msg.text()))
        fail(`${seed}: console ${msg.text()}`);
    });
    await page.goto(`${opts.base}/?seed=${seed}&debug`);
    await page.waitForFunction(() => window.__combat?.floor && window.__combat.heroReady, null, {
      timeout: 60000,
    });
    await page.evaluate(() => window.__combat.heroReady);
    // Every decoration mesh: its room, world matrix, placements and material state.
    const dressed = await page.evaluate(() => {
      const world = window.__combat.floor.world;
      const out = [];
      world.roomGroups.forEach((g, room) => {
        g.updateMatrixWorld(true);
        g.traverse((n) => {
          if (!n.userData.tableDecor) return;
          out.push({
            room,
            template: world.plan.rooms[room].templateId,
            centre: [g.matrixWorld.elements[12], g.matrixWorld.elements[14]],
            matrix: [...n.matrixWorld.elements],
            placements: n.userData.placements,
            castShadow: n.castShadow,
            envMap: Boolean(n.material.envMap),
            envMapIntensity: n.material.envMapIntensity,
            emissiveIntensity: n.material.emissiveIntensity,
            tris: n.geometry.index
              ? n.geometry.index.count / 3
              : n.geometry.attributes.position.count / 3,
          });
        });
      });
      return { rooms: world.plan.rooms.map((r) => r.templateId), meshes: out };
    });
    report.seeds[seed] = dressed;
    if (!dressed.meshes.length) fail(`${seed}: no dressed table`);
    const toWorld = (m, x, y, z) => [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
    for (const mesh of dressed.meshes) {
      if (mesh.castShadow || !mesh.envMap)
        fail(`${seed}: room ${mesh.room} decor shadow/env wrong`);
      const byTable = Map.groupBy(mesh.placements, (p) => p.table);
      for (const [table, props] of byTable) {
        const t = TABLES[`${mesh.template}:${table}`];
        if (!t) {
          fail(`${seed}: unknown table ${mesh.template}:${table}`);
          continue;
        }
        for (const p of props) {
          if (Math.abs(p.x - t.x) > t.halfX || Math.abs(p.z - t.z) > t.halfZ || p.y !== t.top)
            fail(`${seed}: ${p.kind} off ${mesh.template}:${table}`);
        }
        const target = toWorld(mesh.matrix, t.x, t.top + 0.08, t.z);
        const away = [mesh.centre[0] - target[0], mesh.centre[1] - target[2]];
        const len = Math.hypot(...away) || 1;
        const eye = [
          target[0] + (away[0] / len) * TABLE_DISTANCE,
          EYE_Y,
          target[2] + (away[1] / len) * TABLE_DISTANCE,
        ];
        await shoot(page, {
          name: `${seed}-room${mesh.room}-${mesh.template}-${table}`,
          seed,
          room: mesh.room,
          table: `${mesh.template}:${table}`,
          props: props.map((p) => p.kind).join('+'),
          eye,
          target,
        });
        for (const p of props) {
          // One close-up per kind (the first met), and one per further book arrangement.
          let key = p.kind;
          if (closeUps.has(key)) {
            if (p.kind !== 'books') continue;
            if ([...closeUps.values()].some((s) => s.kind === 'books' && s.variant === p.variant))
              continue;
            key = `books-v${p.variant}`;
          }
          const at = toWorld(mesh.matrix, p.x, p.y, p.z);
          const lift = p.kind === 'books' ? 0.05 : 0.1;
          const focus = [at[0], at[1] + lift, at[2]];
          const flat = [eye[0] - at[0], eye[2] - at[2]];
          const fl = Math.hypot(...flat) || 1;
          closeUps.set(key, {
            seed,
            kind: p.kind,
            variant: p.variant,
            name: `closeup-${key}`,
            room: mesh.room,
            table: `${mesh.template}:${table}`,
            props: p.kind,
            eye: [
              at[0] + (flat[0] / fl) * CLOSE_DISTANCE,
              at[1] + CLOSE_RISE,
              at[2] + (flat[1] / fl) * CLOSE_DISTANCE,
            ],
            target: focus,
          });
        }
      }
    }
    for (const shot of closeUps.values()) {
      if (shot.seed === seed && !shot.done) {
        shot.done = true;
        await shoot(page, shot);
      }
    }
    report.gpu ??= await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
    });
    await context.close();
  }
} finally {
  await browser.close();
}
for (const kind of ['candle', 'books', 'vase'])
  if (!closeUps.has(kind)) fail(`no ${kind} close-up`);
const tables = new Set(
  report.shots
    .filter((s) => !s.name.startsWith('closeup'))
    .map((s) => `${s.seed}:${s.room}:${s.table}`),
);
if (tables.size < 3) fail(`only ${tables.size} dressed tables shot`);
writeFileSync(join(opts.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`gpu ${report.gpu}`);
if (report.errors.length || !/Apple|Metal/i.test(report.gpu ?? '')) process.exit(1);
