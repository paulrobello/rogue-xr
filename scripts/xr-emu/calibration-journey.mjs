import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function exerciseCalibration({
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
}) {
  await page.goto(base + '/?seed=' + seed + '&debug');
  await ready(1);
  assert(await ev(() => !!window.__combat.floor.chartCabinet));
  // Stage only the already-tested service repair. The chart, machine, return and card use physical targets.
  await ev(() => {
    const f = window.__combat.floor,
      flow = window.__flow.flow,
      room = f.world.plan.pressureWing.pumpRoom;
    for (const note of f.notes.placements.filter((n) => n.id !== 'dispatch')) {
      flow.collectPressureNote(note.room, note.id);
      const i = 'ABC'.indexOf(note.id),
        goal = Number(note.body.match(/(\d)\./)[1]);
      for (let n = 0; flow.pressure.dials[i] !== goal && n < 3; n++)
        flow.turnPressureValve(room, i);
    }
    if (!flow.primePressure(room)) throw Error('Could not stage the service repair');
    window.__flow.ui.closeMenu();
  });
  await crossing('pressure', true);
  const cabinet = 'calibration-chart-cabinet',
    bench = 'calibration-bench';
  await approach(cabinet, 'instrument-chart');
  await shot('service-chart');
  await click('instrument-chart');
  assert(await ev(() => window.__flow.flow.calibration.chart));
  const chart = await ev(() => {
    const ui = window.__flow.ui;
    ui.openMenu(window.__combat.camera);
    ui.activate('menu-items');
    const label = ui.root.getObjectByName('menu-items-instrument-diagram')?.userData.labelText;
    ui.closeMenu();
    return label;
  });
  console.log('chart', chart);
  const kind = await ev(() => window.__flow.flow.calibration.kind);
  if (kind === 'orrery') {
    await approach(cabinet, 'orrery-drive-spare', 1.5);
    await shot('spare-shaft-coupling');
    await click('orrery-drive-spare');
    assert(await ev(() => window.__flow.flow.calibration.spare));
  }
  await stair(2);
  await approach(bench, 'calibration-wind-target', 1.6);
  await click('calibration-wind-target');
  assert.equal(await ev(() => window.__flow.flow.calibration.solved), false);
  async function use(n) {
    await approach(bench, n, 1.55);
    await click(n);
  }
  if (kind === 'gears') {
    const order = chart.match(/12|18|24/g).map((n) => [12, 18, 24].indexOf(Number(n)));
    assert.equal(order.length, 3);
    const mixed = [order[1], order[0], order[2]];
    for (const [slot, id] of mixed.entries()) {
      await use('calibration-wheel-hit-' + id);
      await use('calibration-socket-' + slot);
    }
    assert.deepEqual(await ev(() => window.__flow.flow.calibration.slots), mixed);
    await use('calibration-wind-target');
    assert.equal(await ev(() => window.__flow.flow.calibration.solved), false);
    await resumeAt(2);
    assert.deepEqual(await ev(() => window.__flow.flow.calibration.slots), mixed);
    await use('calibration-wheel-hit-' + order[0]);
    await use('calibration-socket-0');
    assert.deepEqual(await ev(() => window.__flow.flow.calibration.slots), order);
  } else {
    await use('orrery-control-0');
    assert.deepEqual(await ev(() => window.__flow.flow.calibration.detents), [0, 0, 0]);
    assert.equal(await ev(() => window.__flow.flow.calibration.repaired), false);
    await approach(bench, 'orrery-repair-target', 1.55);
    await shot('broken-orrery-drive');
    await click('orrery-repair-target');
    assert(await ev(() => window.__flow.flow.calibration.repaired));
    await resumeAt(2);
    assert(await ev(() => window.__flow.flow.calibration.repaired));
    assert.equal(await ev(() => window.__flow.flow.calibration.key), 'missing');
    assert(
      await ev(() => {
        const { calibrationBench, calibrationKey } = window.__combat.floor;
        return calibrationKey && calibrationKey.room !== calibrationBench.room;
      }),
    );
    await use('calibration-wind-target');
    assert.equal(await ev(() => window.__flow.flow.calibration.key), 'missing');
    await approach('orrery-key-stand', 'orrery-winding-key', 1.4);
    await shot('winding-key-in-upper-works');
    await click('orrery-winding-key');
    assert.equal(await ev(() => window.__flow.flow.calibration.key), 'held');
    await resumeAt(2);
    assert.equal(await ev(() => window.__flow.flow.calibration.key), 'held');
    await approach(bench, 'calibration-wind-target');
    await shot('empty-winding-socket');
    await click('calibration-wind-target');
    assert.equal(await ev(() => window.__flow.flow.calibration.key), 'inserted');
    await page.waitForTimeout(450);
    await shot('winding-key-seated');
    assert.equal(await ev(() => window.__flow.flow.calibration.solved), false);
    const detents = [...chart.matchAll(/ ([NESW])(?=\s*\/|$)/g)].map((m) => 'NESW'.indexOf(m[1]));
    assert.equal(detents.length, 3);
    for (const [id, d] of detents.entries()) {
      for (let i = 0; i < d; i++) await use('orrery-control-' + id);
      if (id === 1) await resumeAt(2);
    }
    assert.deepEqual(await ev(() => window.__flow.flow.calibration.detents), detents);
  }
  if (kind === 'orrery')
    assert.equal(await ev(() => window.__flow.flow.calibration.key), 'inserted');
  await use('calibration-wind-target');
  assert(await ev(() => window.__flow.flow.calibration.solved));
  await shot('instrument-solved');
  await stair(1);
  await approach(cabinet, 'calibration-card');
  await shot('drawer-card');
  const before = await ev(() => window.__flow.flow.run.deck);
  await click('calibration-card');
  const after = await ev(() => window.__flow.flow.run.deck);
  assert.deepEqual(after.slice(0, -1), before);
  const card = after.at(-1);
  assert(card);
  await resumeAt(1);
  assert.equal(await ev(() => window.__flow.flow.calibration.claimed), true);
  assert.deepEqual(await ev(() => window.__flow.flow.run.deck), after);
  assert.deepEqual(errors, []);
  await writeFile(
    join(out, 'check.json'),
    JSON.stringify({ seed, kind, chart, card, errors }, null, 2),
  );
  console.log('PASS calibration', kind, card);
}
