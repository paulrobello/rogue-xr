// Run against a production preview: node scripts/loading/check.mjs http://localhost:4261
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://localhost:4261';
const output = process.argv[3];
if (output) await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  channel: 'chromium',
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
      : [],
});

async function assertCovered(page) {
  assert(await page.locator('#loading-screen').isVisible());
  assert(await page.locator('#app').evaluate((app) => app.inert));
  assert(
    await page.evaluate(() =>
      document
        .getElementById('loading-screen')
        .contains(document.elementFromPoint(innerWidth / 2, innerHeight / 2)),
    ),
  );
}

try {
  for (const mode of ['title', 'seed=MAPTEST2']) {
    const page = await browser.newPage();
    try {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const entry = Promise.withResolvers();
      const room = Promise.withResolvers();
      const font = Promise.withResolvers();
      if (mode === 'title') {
        await page.route('**/fonts/NotoSans-Regular.ttf', async (route) => {
          await font.promise;
          await route.continue();
        });
      }
      await page.route(/\.js(?:\?|$)/, async (route) => {
        await entry.promise;
        await route.continue();
      });
      await page.route('**/rooms/hall/hall.glb', async (route) => {
        await room.promise;
        await route.continue();
      });
      await page.goto(`${base}/?${mode}&debug`, { waitUntil: 'commit' });
      await page.locator('#loading-status').waitFor();
      await assertCovered(page);
      const requested = page.waitForRequest('**/rooms/hall/hall.glb');
      entry.resolve();
      await requested;
      await page.waitForFunction(() => !!window.__combat?.floor);
      await assertCovered(page);
      assert(await page.locator('#enter-vr').isDisabled());
      if (output)
        await page.screenshot({
          path: join(output, `loading-${mode === 'title' ? 'title' : 'showcase'}.jpg`),
          type: 'jpeg',
          quality: 90,
        });
      room.resolve();
      if (mode === 'title') {
        await page.waitForFunction(
          () => !!window.__combat.floor.world.group.getObjectByName('hall-model'),
        );
        await assertCovered(page);
        font.resolve();
      }
      await page.locator('#loading-screen').waitFor({ state: 'hidden', timeout: 60000 });
      assert(!(await page.locator('#app').evaluate((app) => app.inert)));
      assert.equal(
        await page.evaluate(() => window.__flow.flow.phase),
        mode === 'title' ? 'title' : 'explore',
      );
      assert(
        await page.evaluate(
          () => !!window.__combat.floor.world.group.getObjectByName('hall-model'),
        ),
      );
      if (output)
        await page.screenshot({
          path: join(output, `ready-${mode === 'title' ? 'title' : 'showcase'}.jpg`),
          type: 'jpeg',
          quality: 90,
        });
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  }

  const page = await browser.newPage();
  await page.route('**/rooms/hall/hall.glb', (route) => route.abort(), { times: 1 });
  await page.goto(`${base}/?seed=MAPTEST2&debug`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Retry' }).waitFor({ timeout: 60000 });
  await assertCovered(page);
  await page.getByRole('button', { name: 'Retry' }).click();
  await page.locator('#loading-screen').waitFor({ state: 'hidden', timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__combat.floor.seed), 'MAPTEST2');
  console.log('Cold title and showcase launches, delayed assets, failed room, and retry passed.');
} finally {
  await browser.close();
}
