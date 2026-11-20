import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function exerciseBrassCache({
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
}) {
  await page.goto(base + '/?seed=' + seed + '&debug');
  await ready(1);
  const cache = await ev(() => window.__combat.floor.world.plan.brassCache);
  assert(cache, 'This seed needs an optional lower-floor cache');
  const coffer = `coffer-${cache.room}-${cache.socketId}`;
  const face = [0, 0.22, -0.18];
  async function visitCoffer(button) {
    await approach(coffer, coffer, -1.25, face);
    await click(coffer, face, button);
  }
  const isOpen = () =>
    ev(({ room, socketId }) => window.__flow.flow.isLootOpened(room, socketId), cache);
  await visitCoffer();
  assert.equal(await isOpen(), false);
  assert(await ev(() => window.__flow.flow.run.brassCacheSeen));
  await shot('brass-lock');
  await stair(2);
  const source = await ev(() => {
    const stand = window.__combat.floor.brassKeyStand;
    return { room: stand.room, anchor: stand.object.name, key: stand.key.name };
  });
  await approach(source.anchor, source.key, 1.25);
  await shot('brass-key');
  await click(source.key, [0, 0, 0], 'squeeze');
  assert.equal(await ev(() => window.__flow.flow.brassKey), 'held');
  await resumeAt(2);
  assert.equal(await ev(() => window.__combat.floor.brassKeyStand.key.visible), false);
  await stair(1);
  await visitCoffer('squeeze');
  assert.equal(await ev(() => window.__flow.flow.brassKey), 'spent');
  assert.equal(await isOpen(), false);
  await resumeAt(1);
  await visitCoffer();
  assert.equal(await isOpen(), true);
  await shot('opened-coffer');
  await resumeAt(1);
  assert.equal(await isOpen(), true);
  assert.equal(await ev(() => window.__flow.flow.brassKey), 'spent');
  assert.deepEqual(errors, []);
  await writeFile(
    join(out, 'check.json'),
    JSON.stringify({ seed, cache, keyRoom: source.room, errors }, null, 2),
  );
  console.log('PASS brass cache', seed, cache.room, source.room);
}
