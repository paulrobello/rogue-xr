import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function exercisePatrol({
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
}) {
  await page.goto(base + '/?seed=' + seed + '&debug');
  await ready(1);
  await stair(2);
  await page.waitForFunction(() => window.__combat.floor.patrolBody !== null);
  await approach('roaming-cog-sentry', 'roaming-cog-sentry', 1.7, [0, 0.9, 0]);
  await shot('patrol-start');
  if (!cdp) {
    await ev(() => {
      const canvas = document.querySelector('#app canvas');
      const mimeType = 'video/webm;codecs=vp8';
      const recorded = [];
      const recorder = new MediaRecorder(canvas.captureStream(30), {
        mimeType,
        videoBitsPerSecond: 2500000,
      });
      const actor = window.__combat.floor.patrolBody;
      const camera = window.__combat.camera;
      const a = camera.position.clone();
      const b = a.clone();
      let frame;
      const follow = () => {
        // Observe at seated eye height, behind the actor. Only the test camera is repositioned.
        const floor = window.__combat.floor;
        if (!actor.parent || floor.encounter.phase !== 'idle') return;
        const rig = camera.parent;
        const facing = actor.rotation.y;
        rig.position.x = actor.position.x + Math.sin(facing) * 1.8;
        rig.position.z = actor.position.z + Math.cos(facing) * 1.8;
        rig.rotation.y = facing;
        a.set(actor.position.x, 1.02, actor.position.z);
        b.copy(camera.position);
        camera.rotation.x = Math.atan2(a.y - b.y - rig.position.y, 1.8);
        rig.updateWorldMatrix(true, true);
        frame = requestAnimationFrame(follow);
      };
      window.patrolRecording = new Promise((resolve) => {
        recorder.ondataavailable = (e) => recorded.push(e.data);
        recorder.onstop = () => {
          cancelAnimationFrame(frame);
          for (const track of recorder.stream.getTracks()) track.stop();
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(new Blob(recorded, { type: mimeType }));
        };
      });
      recorder.start();
      setTimeout(() => recorder.stop(), 11_000);
      frame = requestAnimationFrame(follow);
    });
    const film = await ev(() => window.patrolRecording);
    await writeFile(join(out, 'doorway-patrol.webm'), Buffer.from(film.split(',')[1], 'base64'));
  }
  const rooms = await ev(async () => {
    const c = window.__combat;
    const f = c.floor;
    const found = new Set();
    for (let i = 0; i < 650 && found.size < 2; i++) {
      found.add(f.patrolBody.userData.room);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return [...found];
  });
  assert.equal(rooms.length, 2, 'patrol crosses the ordinary doorway');
  const cleared = await ev(() => [...window.__flow.flow.cleared]);
  const seat =
    seed === 'W1ND0001' || seed === 'WIND0001'
      ? { x: 4, z: -48.31, yaw: 0 }
      : { x: 1, z: 8.77, yaw: Math.PI };
  async function engagePatrol() {
    await ev(({ x, z, yaw }) => {
      const { camera } = window.__combat;
      const rig = camera.parent;
      const eye = camera.getWorldPosition(camera.position.clone());
      rig.position.x += x - eye.x;
      rig.position.z += z - eye.z;
      rig.rotation.y = yaw;
      camera.rotation.x = 0;
      rig.updateWorldMatrix(true, true);
    }, seat);
    await page.waitForFunction(
      () => window.__combat?.session?.controller.state.enemies[0]?.id === 'cog-sentry',
      undefined,
      { timeout: 35000 },
    );
  }
  await engagePatrol();
  await shot('roaming-encounter');
  const initialCogs = await ev(() => window.__flow.flow.run.cogs);
  const fled = await ev(async () => {
    const session = window.__combat.session;
    for (let i = 0; i < 30; i++) {
      if (session.flee() || session.flee()) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  });
  assert(fled, 'regular patrol allows fleeing');
  await page.waitForFunction(() => {
    const { floor } = window.__combat;
    return floor.encounter.phase === 'idle' && window.__flow.flow.phase === 'explore';
  });
  assert.equal(await ev(() => window.__flow.flow.run.cogs), initialCogs);
  assert.equal(await ev(() => window.__flow.flow.run.patrolDefeated), undefined);
  assert.deepEqual(await ev(() => window.__flow.flow.cleared), cleared);
  await approach('roaming-cog-sentry', 'roaming-cog-sentry', 1.9, [0, 0.9, 0]);
  const returned = await ev(() => window.__combat.floor.patrolBody.position.toArray());
  await page.waitForFunction(
    ([x, , z]) => {
      const { floor } = window.__combat;
      const p = floor.patrolBody.position;
      return floor.encounter.phase === 'idle' && Math.hypot(p.x - x, p.z - z) > 0.15;
    },
    returned,
    { timeout: 8000 },
  );
  await engagePatrol();
  await page.keyboard.press('k');
  await page.waitForFunction(() => window.__flow.flow.phase === 'reward');
  assert(await ev(() => window.__flow.flow.run.patrolDefeated));
  assert.deepEqual(await ev(() => window.__flow.flow.cleared), cleared);
  await ev(() => window.__flow.flow.pickReward('skip'));
  await resumeAt(2);
  assert(await ev(() => window.__flow.flow.run.patrolDefeated));
  assert.equal(await ev(() => window.__combat.floor.patrolBody), null);
  assert.deepEqual(errors, []);
  await writeFile(join(out, 'check.json'), JSON.stringify({ seed, rooms, errors }, null, 2));
  console.log('PASS roaming sentry', seed, rooms);
}
