#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { exerciseBrassCache } from './brass-journey.mjs';
import { exerciseCalibration } from './calibration-journey.mjs';
import { installFieldControllers, useFieldController } from './field-controller.mjs';
import { exercisePatrol } from './patrol-journey.mjs';

const {
  values: {
    base,
    seed,
    out,
    cdp,
    formula,
    commission,
    calibration,
    panels,
    brass,
    controller,
    patrol,
  },
} = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:4266' },
    seed: { type: 'string', default: 'MAPTEST2' },
    out: { type: 'string', default: '.local/return/journey' },
    cdp: { type: 'string' },
    formula: { type: 'boolean', default: false },
    commission: { type: 'boolean', default: false },
    calibration: { type: 'boolean', default: false },
    panels: { type: 'boolean', default: false },
    brass: { type: 'boolean', default: false },
    controller: { type: 'boolean', default: false },
    patrol: { type: 'boolean', default: false },
  },
});
if (controller && cdp) throw Error('Controller emulation requires desktop Chromium');
await mkdir(out, { recursive: true });
const browser = cdp
  ? await chromium.connectOverCDP(cdp)
  : await chromium.launch({
      channel: 'chromium',
      headless: true,
      args: ['--enable-gpu', '--use-angle=metal', '--ignore-gpu-blocklist'],
    });
const context = cdp
  ? browser.contexts()[0]
  : await browser.newContext({ viewport: { width: 1280, height: 820 } });
if (controller) await installFieldControllers(context);
let page;
if (cdp) {
  const session = await browser.newBrowserCDPSession();
  const { targetId } = await session.send('Target.createTarget', {
    url: 'about:blank',
    background: true,
  });
  for (let i = 0; i < 60 && !page; i++) {
    for (const candidate of context.pages()) {
      const s = await context.newCDPSession(candidate);
      const info = await s.send('Target.getTargetInfo');
      await s.detach();
      if (info.targetInfo.targetId === targetId) {
        page = candidate;
        break;
      }
    }
    if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(page, 'isolated headset tab');
  await session.detach();
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...options) {
      if (kind.startsWith('webgl')) options[0] = { ...options[0], preserveDrawingBuffer: true };
      return original.call(this, kind, ...options);
    };
    window.requestAnimationFrame = (fn) => setTimeout(() => fn(performance.now()), 20);
    window.cancelAnimationFrame = clearTimeout;
  });
} else page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => {
  errors.push(e.message);
  console.log('Runtime error', e.message);
});
page.on('console', (m) => {
  if (m.type() === 'error') console.log('console', m.text().slice(0, 170));
});
const ev = (fn, arg) => page.evaluate(fn, arg);
const ready = async (n) => {
  await page.waitForFunction(
    (n) =>
      window.__combat?.floor?.floorNumber === n &&
      window.__flow.flow.phase === 'explore' &&
      document.querySelector('#loading-screen').hidden &&
      window.__combat.stairTransition.phase === 'idle',
    n,
    { timeout: 60000, polling: 120 },
  );
  // Repositioning between distant fixtures can otherwise drop the tester inside a live combat trigger.
  if (seed !== 'MAPTEST2' && n < 3)
    await ev(() => {
      const f = window.__combat.floor;
      for (const r of f.world.plan.rooms) if (r.encounter) f.markCleared(r.index, true);
    });
};
const canvasClick = (x, y) =>
  ev(
    ({ x, y }) => {
      const el = document.querySelector('#app canvas');
      el.dispatchEvent(
        new PointerEvent('pointerdown', { button: 0, bubbles: true, clientX: x, clientY: y }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true }));
    },
    { x, y },
  );
async function approach(anchor, name, away = 1.5, offset = [0, 0, 0]) {
  await ev(
    ({ anchor, name, away }) => {
      const c = window.__combat,
        f = c.floor,
        w = f.world,
        cam = c.camera,
        rig = cam.parent;
      const g = w.group.getObjectByName(anchor),
        obj = w.group.getObjectByName(name);
      if (!g || !obj) throw Error('Missing ' + anchor + '/' + name);
      const eye = g.localToWorld(cam.position.clone().set(0, 0, away)),
        old = cam.getWorldPosition(cam.position.clone());
      rig.position.x += eye.x - old.x;
      rig.position.z += eye.z - old.z;
      rig.updateWorldMatrix(true, true);
      w.update(eye.x, eye.z);
    },
    { anchor, name, away },
  );
  await page.waitForTimeout(130);
  await ev(
    ({ name, offset }) => {
      const c = window.__combat,
        rig = c.camera.parent,
        cam = c.camera,
        obj = c.floor.world.group.getObjectByName(name);
      const aim = obj.localToWorld(cam.position.clone().fromArray(offset)),
        d = aim.sub(cam.getWorldPosition(cam.position.clone()));
      const diff = Math.atan2(d.x, -d.z) + rig.rotation.y;
      document
        .querySelector('#app canvas')
        .dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          movementX: (Math.atan2(Math.sin(diff), Math.cos(diff)) * 180) / Math.PI / 0.23,
          movementY: (cam.rotation.x - Math.atan2(d.y, Math.hypot(d.x, d.z))) / 0.004,
          bubbles: true,
        }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { button: 2, bubbles: true }));
    },
    { name, offset },
  );
  await page.waitForTimeout(150);
}
async function click(name, offset = [0, 0, 0], button) {
  const fixture =
    /^(Commission|ReturnSpring|instrument-chart|calibration-|orrery-|service-leaf-|service-catch-|service-knock-target|brass-cache-key|coffer-)/;
  if (controller && fixture.test(name)) {
    const mode = await useFieldController(page, name, offset, button);
    assert.equal(mode, 'immersive-vr');
    console.log('Controller', button ?? 'trigger', name);
    return;
  }
  const xy = await ev(
    ({ name, offset }) => {
      const c = window.__combat,
        cam = c.camera,
        n = c.floor.world.group.getObjectByName(name);
      const p = n.localToWorld(cam.position.clone().fromArray(offset));
      if (
        name === 'clock-ingredient' ||
        name.startsWith('FoundIngredient') ||
        name.startsWith('IngredientCradle')
      )
        p.y += 0.07;
      p.project(cam);
      const rect = document.querySelector('#app canvas').getBoundingClientRect();
      if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || p.z > 1)
        throw Error('Target off screen ' + name);
      return [rect.left + ((1 + p.x) * rect.width) / 2, rect.top + ((1 - p.y) * rect.height) / 2];
    },
    { name, offset },
  );
  await canvasClick(...xy);
  await page.waitForTimeout(130);
}
const shot = async (name) => {
  const path = join(out, name + '.jpg');
  if (!cdp) return page.screenshot({ path, type: 'jpeg', quality: 88 });
  const data = await ev(() => document.querySelector('#app canvas').toDataURL('image/jpeg', 0.92));
  await writeFile(path, Buffer.from(data.split(',')[1], 'base64'));
};
async function stair(dest) {
  await approach('staircase-' + (dest === 2 ? 'up' : 'down'), 'stair-door-handle-target', 2.6);
  await click('stair-door-handle-target');
  await ready(dest);
}
async function lift(dest) {
  await approach('astral-lift', 'astral-lift-medallion');
  await click('astral-lift-medallion');
  await ready(dest);
}
async function crossing(kind, opened) {
  const result = await ev(
    async ({ kind, opened }) => {
      const c = window.__combat,
        f = c.floor,
        w = f.world,
        cam = c.camera,
        rig = cam.parent;
      const [a, b] = w.plan.connections.find((e) => e.puzzleGate === kind);
      const door = w.rooms[a.room].doors.find((d) => d.id === a.door),
        [dx, dz] = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] }[door.facing];
      const [x, z] = door.world,
        head = cam.getWorldPosition(cam.position.clone());
      rig.position.x += x - 0.65 * dx - head.x;
      rig.position.z += z - 0.65 * dz - head.z;
      rig.updateWorldMatrix(true, true);
      w.update(x - 0.65 * dx, z - 0.65 * dz);
      const yaw = Math.atan2(dx, -dz) + rig.rotation.y;
      document
        .querySelector('#app canvas')
        .dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          movementX: (Math.atan2(Math.sin(yaw), Math.cos(yaw)) * 180) / Math.PI / 0.23,
          movementY: cam.rotation.x / 0.004,
          bubbles: true,
        }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { button: 2, bubbles: true }));
      return { a: a.room, b: b.room, phase: window.__flow.flow.phase, opened };
    },
    { kind, opened },
  );
  const key = (type) =>
    ev(
      (type) =>
        window.dispatchEvent(new KeyboardEvent(type, { key: 'w', code: 'KeyW', bubbles: true })),
      type,
    );
  await key('keydown');
  try {
    if (opened)
      await page.waitForFunction((room) => window.__combat.floor.world.current === room, result.b, {
        timeout: 8500,
        polling: 80,
      });
    else await page.waitForTimeout(1200);
  } finally {
    await key('keyup');
  }
  const current = await ev(() => window.__combat.floor.world.current);
  assert.equal(
    current,
    opened ? result.b : result.a,
    kind + ' crossing ' + JSON.stringify({ result, current }),
  );
  console.log('walk', kind, opened);
}
async function resumeAt(n) {
  await ev(() => window.__flow.flushed());
  await page.goto(base + '/?seed=' + seed + '&title&debug');
  await page.waitForFunction(
    () =>
      window.__flow?.ui?.visible &&
      document.querySelector('#loading-screen').hidden &&
      window.__flow.screenOfControl('title-continue'),
    undefined,
    { timeout: 60000 },
  );
  const xy = await ev(() => window.__flow.screenOfControl('title-continue'));
  await canvasClick(xy.x, xy.y);
  await ready(n);
}
async function exerciseFormula() {
  const names = ['Mooncap', 'StarThistle', 'EmberSalt'];
  await page.goto(base + '/?seed=' + seed + '&debug');
  await ready(1);
  // This fixture represents an earlier run that already opened the thorn ward. All archive actions use real inputs.
  await ev(async () => {
    const flow = window.__flow.flow;
    flow.travelToFloor(2, 0);
    flow.travelToFloor(3, 0);
    for (const id of flow.alchemyRecipe) {
      flow.collectIngredient(id);
      flow.addIngredient(id);
    }
    flow.applyPotion();
    flow.travelToFloor(2, 0);
    await window.__flow.flushed();
  });
  await resumeAt(2);
  await approach('formula-evidence-record', 'formula-glyph-record');
  await shot('upper-record');
  await click('formula-glyph-record');
  assert.deepEqual(await ev(() => window.__flow.flow.conservatoryFormula.clues), ['record']);
  await lift(3);
  const type = await ev(() => window.__flow.flow.conservatoryFormula.recipe);
  console.log('variant', type);
  await ev(() => {
    const f = window.__combat.floor;
    for (const r of f.world.plan.rooms) if (r.encounter) f.markCleared(r.index, true);
  });
  await crossing('archive', false);
  await approach('formula-evidence-portrait', 'formula-glyph-portrait');
  await shot('portrait-seal');
  await click('formula-glyph-portrait');
  assert.equal(await ev(() => window.__flow.flow.conservatoryFormula.clues.length), 2);
  const order = await ev(() => {
    const f = window.__combat.floor,
      flow = window.__flow.flow,
      plan = flow.conservatoryFormula.recipe;
    // Read the two earned marks from the journal, using the same board routine as the radial menu.
    const journal = window.__flow.ui;
    const cam = window.__combat.camera;
    journal.openMenu(cam);
    journal.activate('menu-items');
    const text = ['record', 'portrait'].map(
      (c) => journal.root.getObjectByName('menu-items-formula-' + c)?.userData.labelText ?? '',
    );
    journal.closeMenu();
    return text;
  });
  console.log('earned-clues', order);
  const entries = order
    .map((t) => ({
      n: t.includes('II ·') ? 1 : 0,
      id: ['Mooncap', 'Star-thistle', 'Ember salt'].findIndex((name) => t.includes(name)),
    }))
    .sort((a, b) => a.n - b.n);
  assert(entries[0].n === 0 && entries[1].n === 1 && entries.every((e) => e.id >= 0));
  const missing = await ev(() =>
    [0, 1, 2].find((i) => !window.__flow.flow.alchemy.found.includes(i)),
  );
  const specimen = 'FoundIngredient' + names[missing];
  const bay = await ev(
    (n) => window.__combat.floor.world.group.getObjectByName(n).parent.name,
    specimen,
  );
  await approach(bay, specimen);
  await click(specimen);
  assert.equal(await ev(() => window.__flow.flow.alchemy.found.length), 3);
  for (const [i, e] of entries.entries()) {
    const item = 'IngredientCradle' + names[e.id];
    await approach('brew-bench', item, 1.8);
    if (i === 0 && type === 'stillwind')
      await page.waitForFunction(() => window.__combat.floor.alchemy.inStillInterval, undefined, {
        timeout: 150000,
        polling: 60,
      });
    await click(item);
    assert.equal(await ev(() => window.__flow.flow.conservatoryFormula.added.length), i + 1);
  }
  assert(await ev(() => window.__flow.flow.conservatoryFormula.brewed));
  const [target, offset] =
    type === 'lantern-ink'
      ? ['ArchiveInkLeft', [0.4, 1.22, 0.1]]
      : type === 'stillwind'
        ? ['ArchiveWindRotor', [0, 0, 0]]
        : ['ArchiveMirrorSilver', [0, 1.22, 0.15]];
  await approach('ConservatoryArchive', target, 1.85, offset);
  await shot('door-closed');
  await click(target, offset);
  assert(await ev(() => window.__flow.flow.conservatoryFormula.revealed));
  if (type === 'lantern-ink') {
    assert.equal(await ev(() => window.__flow.flow.conservatoryFormula.opened), false);
    await shot('door-outlined');
    await resumeAt(3);
    await ev(() => {
      const f = window.__combat.floor;
      for (const r of f.world.plan.rooms) if (r.encounter) f.markCleared(r.index, true);
    });
    await approach('ConservatoryArchive', 'ArchiveInkLatch', 1.5, [0, 1.2, 0.16]);
    await click('ArchiveInkLatch', [0, 1.2, 0.16]);
  }
  assert(await ev(() => window.__flow.flow.conservatoryFormula.opened));
  await page.waitForTimeout(900);
  await shot('door-open');
  await crossing('archive', true);
  await ev(() => {
    const f = window.__combat.floor,
      c = f.world.coffers.find((c) => c.room === 6);
    if (!c || !window.__flow.flow.openLoot(6, c.socketId, c.kind))
      throw Error('Archive coffer inaccessible');
  });
  await resumeAt(3);
  assert(await ev(() => window.__flow.flow.conservatoryFormula.opened));
  await ev(() => {
    const f = window.__combat.floor;
    for (const r of f.world.plan.rooms) if (r.encounter) f.markCleared(r.index, true);
  });
  await crossing('archive', true);
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'check.json'), JSON.stringify({ seed, type, order, errors }, null, 2));
  console.log('PASS archive', type);
}
async function exerciseCommission() {
  await page.goto(base + '/?seed=' + seed + '&debug');
  await ready(1);
  const kind = await ev(() => window.__flow.flow.commission.kind);
  console.log('order', kind);
  async function spring(id) {
    const name = 'ReturnSpring' + (id + 1);
    await approach('spring-perch-' + id, name, 1.2);
    await shot('spring-' + id);
    await click(name, [0, 0.055, 0]);
    assert(await ev((id) => window.__flow.flow.commission.recovered.includes(id), id));
  }
  if (kind === 'recovery') await spring(0);
  await approach('keeper-commission-office', 'CommissionLedger', 1.15);
  await click('CommissionPaperPivot', [0.22, 0, 0.04]);
  await page.waitForTimeout(600);
  await shot('opened-letter');
  assert.equal(await ev(() => window.__flow.flow.commission.accepted), false);
  await click('CommissionStamp', [0, 0, 0.025]);
  assert(await ev(() => window.__flow.flow.commission.accepted));
  const before = await ev(() => window.__flow.flow.run.cogs);
  if (kind === 'recovery') {
    await spring(1);
    await stair(2);
    await resumeAt(2);
    await spring(2);
    await stair(1);
  } else if (kind === 'restoration') {
    // Commission verification uses the existing regulator's normal run actions.
    await ev(() => {
      const f = window.__combat.floor,
        flow = window.__flow.flow,
        room = f.world.plan.pressureWing.pumpRoom;
      for (const slip of f.notes.placements.filter((x) => x.id !== 'dispatch')) {
        flow.collectPressureNote(slip.room, slip.id);
        const i = 'ABC'.indexOf(slip.id),
          wanted = Number(slip.body.match(/(\d)\./)[1]);
        for (let t = 0; flow.pressure.dials[i] !== wanted && t < 3; t++)
          flow.turnPressureValve(room, i);
      }
      if (!flow.primePressure(room)) throw Error('Could not prime');
      window.__flow.ui.closeMenu();
    });
  } else {
    // Use an already-qualified delve fixture to exercise retroactive progress on a different floor.
    await ev(async () => {
      const flow = window.__flow.flow;
      flow.travelToFloor(2, 0);
      flow.learnFormulaClue('record');
      flow.travelToFloor(3, 0);
      flow.learnFormulaClue('portrait');
      for (const id of [0, 1, 2]) flow.collectIngredient(id);
      for (const id of flow.alchemyRecipe) flow.addIngredient(id);
      flow.applyPotion();
      for (let a = 0; a < 3 && !flow.conservatoryFormula.brewed; a++)
        for (let b = 0; b < 3 && !flow.conservatoryFormula.brewed; b++) {
          if (a === b) continue;
          if (flow.addFormulaIngredient(a, true) === 'correct') flow.addFormulaIngredient(b, true);
        }
      flow.useFormula('pour');
      if (!flow.conservatoryFormula.opened) flow.useFormula('unlatch');
      flow.travelToFloor(2, 0);
      flow.travelToFloor(1, 0);
      await window.__flow.flushed();
    });
    await resumeAt(1);
  }
  const job = await ev(() => window.__flow.flow.commission);
  assert.equal(job.total, job.progress);
  await approach('keeper-commission-office', 'CommissionPurse', 1.1);
  await shot('payment');
  await click('CommissionPurse', [0, 0.08, 0]);
  assert(await ev(() => window.__flow.flow.commission.claimed));
  assert.equal(await ev(() => window.__flow.flow.run.cogs), before + job.payout);
  await resumeAt(1);
  assert.equal(await ev(() => window.__combat.floor.office.purse.visible), false);
  assert.deepEqual(errors, []);
  await writeFile(
    join(out, 'check.json'),
    JSON.stringify({ seed, kind, payout: job.payout, errors }, null, 2),
  );
  console.log('PASS commission', kind);
}
async function exercisePanels() {
  await page.goto(base + '/?seed=' + seed + '&debug');
  await ready(1);
  await stair(2);
  const layout = await ev(() => window.__combat.floor.world.plan.hiddenPassage);
  assert(layout && layout.decoys.length, 'fixture needs a true and a solid panel');
  await crossing('panel', false);
  await ev(() => {
    const a = window.__combat.audio,
      original = a.playSfx.bind(a);
    window.knocks = [];
    a.playSfx = (id, ...args) => {
      if (id.startsWith('panel-')) window.knocks.push(id);
      return original(id, ...args);
    };
  });
  for (const ref of layout.decoys) {
    const root = 'solid-service-panel-' + ref.room;
    const leaf = 'service-leaf-' + ref.room;
    assert(
      await ev((root) => {
        const panel = window.__combat.floor.world.group.getObjectByName(root);
        return (
          !!panel.getObjectByName('service-fixed-cover-label') &&
          !panel.getObjectByName('service-knock-target')
        );
      }, root),
    );
    await approach(root, leaf, 1.6, [0.76, 1.29, 0.035]);
    await shot('fixed-cover-' + ref.room);
    await click(leaf, [0.76, 1.29, 0.035]);
    assert.equal(await ev(() => window.__flow.flow.hiddenPanel.discovered), false);
  }
  const leaf = 'service-leaf-' + layout.source.room;
  const catchName = 'service-catch-' + layout.source.room;
  await approach('hollow-service-panel', 'service-knock-target', 1.6);
  await shot('knock-circle');
  await click(leaf, [0.55, 1.24, 0.04]);
  await click(catchName);
  assert.deepEqual(await ev(() => window.knocks), []);
  for (let knock = 1; knock <= 3; knock++) {
    await click('service-knock-target');
    assert.equal(await ev(() => window.__flow.flow.hiddenPanel.discovered), knock === 3);
    await shot('knock-' + knock);
  }
  assert.deepEqual(await ev(() => window.knocks), ['panel-hollow', 'panel-hollow', 'panel-hollow']);
  await shot('sprung-catch');
  await resumeAt(2);
  assert(await ev(() => window.__flow.flow.hiddenPanel.discovered));
  await approach('hollow-service-panel', catchName, 1.5);
  await click(catchName);
  assert(await ev(() => window.__flow.flow.hiddenPanel.opened));
  await page.waitForTimeout(800);
  await shot('secret-open');
  await crossing('panel', true);
  await ev(() => {
    const f = window.__combat.floor,
      w = f.world,
      room = w.plan.hiddenPassage.treasureRoom,
      coffer = w.coffers.find((c) => c.room === room);
    if (
      w.current !== room ||
      !coffer ||
      !window.__flow.flow.openLoot(room, coffer.socketId, coffer.kind)
    )
      throw Error('Cannot reach the service recess reward');
  });
  await resumeAt(2);
  await crossing('panel', true);
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'check.json'), JSON.stringify({ seed, layout, errors }, null, 2));
  console.log('PASS service panels');
}
async function exerciseReturnJourney() {
  await page.goto(base + '/?seed=' + seed + '&debug');
  await ready(1);
  console.log(
    'renderer',
    await ev(() => {
      const gl = document.querySelector('#app canvas').getContext('webgl2');
      return gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL);
    }),
  );
  await crossing('counterweight', false);
  await crossing('pressure', false);
  await stair(2);
  console.log(
    'upstairs',
    await ev(() => ({
      room: window.__combat.floor.counterweight.room,
      lift: window.__combat.floor.lift.room,
    })),
  );
  const correct = await ev(() => window.__flow.flow.counterweightPuzzle.correct);
  const weight = async (i) => {
    const name = 'counterweight-' + (i === 0 ? 'a' : 'b') + '-target';
    await approach('counterweight-balance-station', name, 1.45);
    await click(name);
    assert.equal(await ev(() => window.__flow.flow.counterweight.selected), i);
  };
  await weight(1 - correct);
  await approach('counterweight-balance-station', 'counterweight-hook');
  await click('counterweight-hook');
  assert.equal(await ev(() => window.__flow.flow.counterweight.solved), false);
  await weight(correct);
  await shot('balance');
  await approach('counterweight-balance-station', 'counterweight-hook');
  await click('counterweight-hook');
  assert.equal(await ev(() => window.__flow.flow.counterweight.solved), true);
  await stair(1);
  await crossing('counterweight', true);
  const slips = await ev(() =>
    window.__combat.floor.notes.placements
      .filter((n) => n.id !== 'dispatch')
      .map((n) => ({ id: n.id, room: n.room, body: n.body })),
  );
  // Reveal the sources in a cleared playtest fixture, then operate the normal primer against the recovered slips.
  await ev(() => {
    const f = window.__combat.floor,
      flow = window.__flow.flow;
    for (const n of f.notes.placements) {
      if (n.id !== 'dispatch') flow.collectPressureNote(n.room, n.id);
    }
    const d = f.notes.placements.filter((n) => n.id !== 'dispatch');
    for (const n of d) {
      const index = 'ABC'.indexOf(n.id),
        setting = Number(n.body.match(/(\d)\./)[1]);
      for (let turns = 0; flow.pressure.dials[index] !== setting && turns < 3; turns++)
        flow.turnPressureValve(f.world.plan.pressureWing.pumpRoom, index);
    }
    assertGame(flow.primePressure(f.world.plan.pressureWing.pumpRoom));
    window.__flow.ui.closeMenu();
    function assertGame(ok) {
      if (!ok) throw Error('primer rejected recovered settings');
    }
  });
  console.log('slips', slips);
  await crossing('pressure', true);
  await stair(2);
  await lift(3);
  await shot('conservatory-arrival');
  const details = await ev(() => {
    const f = window.__combat.floor,
      flow = window.__flow.flow;
    return {
      hour: f.clock.hour,
      clockRoom: f.clock.room,
      clueRoom: f.clock.clueRoom,
      recipe: flow.alchemyRecipe,
      lab: f.alchemy.cauldronRoom,
      tablet: f.alchemy.tabletRoom,
      owl: [...f.world.enemies.values()].flat().map((n) => n.userData.enemyKind),
    };
  });
  console.log('conservatory', details);
  assert(details.owl.includes('clockwork-owl'));
  assert.notEqual(details.clockRoom, details.clueRoom);
  assert.notEqual(details.lab, details.tablet);
  // Test the ward independently of the owl fight, then approach the owl on a fresh floor mount.
  await ev(() => {
    const f = window.__combat.floor;
    for (const r of f.world.plan.rooms) if (r.encounter) f.markCleared(r.index, true);
  });
  const keys = ['Mooncap', 'StarThistle', 'EmberSalt'];
  const first = 'FoundIngredient' + keys[details.recipe[0]];
  const firstBay = await ev(
    (n) => window.__combat.floor.world.group.getObjectByName(n).parent.name,
    first,
  );
  await approach(firstBay, first);
  await click(first);
  assert((await ev(() => window.__flow.flow.alchemy.found)).includes(details.recipe[0]));
  await approach('RecipeTablet', 'RecipeTile' + keys[details.recipe[0]] + 'Order1');
  await shot('recipe');
  await approach('GrandfatherClock', 'ClockHourHand', 1.9);
  await shot('clock');
  await page.waitForFunction(() => window.__combat.floor.clock.target.visible, undefined, {
    timeout: 150000,
    polling: 80,
  });
  await click('clock-ingredient');
  assert((await ev(() => window.__flow.flow.alchemy.found)).includes(details.recipe[1]));
  for (const id of details.recipe) {
    const n = 'IngredientCradle' + keys[id];
    await approach('brew-bench', n, 2.1);
    await click(n);
  }
  assert(await ev(() => window.__flow.flow.alchemy.brewed));
  await shot('brew');
  await crossing('thorn', false);
  await approach('ThornWard', 'ThornWardSeal', 1.45);
  await click('ThornWardSeal');
  assert(await ev(() => window.__flow.flow.alchemy.opened));
  await crossing('thorn', true);
  // Taking the new vault's reward also creates a save at the end of the unlocked passage.
  await ev(() => {
    const f = window.__combat.floor,
      flow = window.__flow.flow,
      coffer = f.world.coffers.find((c) => c.room === 5);
    if (!coffer || !flow.openLoot(5, coffer.socketId, coffer.kind))
      throw Error('Protected collection was not claimable');
  });
  for (const i of [0, 1]) {
    await approach('conservatory-portrait-' + i, 'wizard-portrait-' + i, 1.65);
    await shot('wizard-' + i);
  }
  await ev(() => window.__flow.flushed());
  await page.goto(base + '/?seed=' + seed + '&title&debug');
  await page.waitForFunction(
    () =>
      window.__flow?.ui?.visible &&
      document.querySelector('#loading-screen').hidden &&
      window.__flow.screenOfControl('title-continue'),
    undefined,
    { timeout: 60000 },
  );
  const pt = await ev(() => window.__flow.screenOfControl('title-continue'));
  await canvasClick(pt.x, pt.y);
  await ready(3);
  assert(await ev(() => window.__flow.flow.alchemy.opened));
  await ev(() => {
    const f = window.__combat.floor;
    for (const r of f.world.plan.rooms) if (r.encounter) f.markCleared(r.index, true);
  });
  await crossing('thorn', true);
  await lift(2);
  await stair(1);
  await crossing('counterweight', true);
  await crossing('pressure', true);
  await stair(2);
  await lift(3);
  const owlRoom = await ev(() => {
    const c = window.__combat;
    const room = c.floor.world.plan.rooms.find((r) => r.encounter)?.index;
    if (room === undefined) throw Error('No owl encounter');
    return c.teleportToEncounter(room);
  });
  assert(owlRoom !== null);
  await page.waitForFunction(
    () =>
      window.__combat?.session?.controller.state.enemies.some((e) =>
        e.id.startsWith('clockwork-owl'),
      ),
    undefined,
    { timeout: 18000 },
  );
  await shot('owl-encounter');
  assert.deepEqual(errors, []);
  await writeFile(
    join(out, 'check.json'),
    JSON.stringify({ seed, details, slips, errors }, null, 2),
  );
  console.log('PASS end-to-end');
}
try {
  if (patrol)
    await exercisePatrol({
      page,
      base,
      seed,
      out,
      ev,
      ready,
      stair,
      approach,
      resumeAt,
      shot,
      errors,
      cdp,
    });
  else if (brass)
    await exerciseBrassCache({
      page,
      base,
      seed,
      out,
      ev,
      ready,
      stair,
      approach,
      click,
      resumeAt,
      shot,
      errors,
    });
  else if (commission) await exerciseCommission();
  else if (calibration)
    await exerciseCalibration({
      page,
      base,
      seed,
      out,
      ev,
      ready,
      stair,
      approach,
      click,
      resumeAt,
      crossing,
      shot,
      errors,
    });
  else if (panels) await exercisePanels();
  else if (formula) await exerciseFormula();
  else await exerciseReturnJourney();
} catch (error) {
  console.error(
    'Journey state',
    await ev(() => ({
      phase: window.__flow?.flow.phase,
      room: window.__combat?.floor?.world.current,
      floor: window.__combat?.floor?.floorNumber,
      loading: document.querySelector('#loading-screen')?.textContent?.trim(),
      transition: window.__combat?.stairTransition,
    })).catch(() => null),
  );
  throw error;
} finally {
  await page.close();
  await browser.close();
}
