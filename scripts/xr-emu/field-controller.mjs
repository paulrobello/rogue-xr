import { readFile } from 'node:fs/promises';

export async function installFieldControllers(context) {
  const [runtime, hooks] = await Promise.all([
    readFile(new URL('../../node_modules/iwer/build/iwer.min.js', import.meta.url), 'utf8'),
    readFile(new URL('./page-hooks.js', import.meta.url), 'utf8'),
  ]);
  await context.addInitScript({ content: runtime + '\n' + hooks });
}

export async function useFieldController(page, name, offset, button = 'trigger') {
  await page.evaluate(() => window.__xrEmu.setHead(1.55, 0, 0));
  await page.getByRole('button', { name: 'Enter VR' }).click();
  await page.waitForFunction(() => window.__xrEmu.ctx().renderer?.xr.isPresenting);
  try {
    return await page.evaluate(
      async ({ name, offset, button }) => {
        const xr = window.__xrEmu;
        await xr.frames(4);
        const target = xr.worldOf(name, offset);
        if (!target) throw Error('Missing controller target ' + name);
        if (button === 'squeeze') {
          const aim = { ...target, y: target.y - 0.1 };
          xr.placeAt('right', target, aim);
        } else {
          xr.aimAt('right', target, [0.16, -0.24, -0.22]);
        }
        await xr.frames(4);
        const controller = xr.device.controllers.right;
        controller.updateButtonValue(button, 1);
        await xr.frames(6);
        controller.updateButtonValue(button, 0);
        await xr.frames(6);
        return xr.session.mode;
      },
      { name, offset, button },
    );
  } finally {
    await page.evaluate(() => window.__xrEmu.session.session.end());
    await page.waitForFunction(() => !window.__xrEmu.ctx().renderer?.xr.isPresenting);
  }
}
