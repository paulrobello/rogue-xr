// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Stream } from '../src/core/rng.ts';
import { type DieKind, dieVertices, faceNormals, upFace } from '../src/dice/faces.ts';
import { DicePresenter } from '../src/dice/presenter.ts';
import { type Quat, rotateVec, type Vec3 } from '../src/dice/quat.ts';
import { AUTHORED_TRAY_HALF, DiceWorld, type SettledEvent } from '../src/dice/world.ts';

/** What `CombatSession` passed the dice world before the fix (its `TRAY_HALF_X` / `TRAY_HALF_Z`). */
const OLD_COLLIDER = { halfX: 0.2, halfZ: 0.11 };
const KINDS: readonly DieKind[] = ['d6', 'd8'];
/**
 * Slack, metres: a die left resting against the wall where physics stopped it sits inside Rapier's
 * contact slop of it (measured worst 0.3 mm).
 */
const TOLERANCE = 5e-4;

interface TableManifest {
  tray?: unknown;
  [key: string]: unknown;
}

/** The authored table's felt floor (`trayInner.size`), full width and depth in metres. */
function manifestTrayInner(): { width: number; depth: number } {
  const manifest = JSON.parse(
    readFileSync(
      new URL('../public/assets/props/combat-table/combat-table.manifest.json', import.meta.url),
      'utf8',
    ),
  ) as TableManifest;
  const find = (node: unknown): number[] | null => {
    if (node === null || typeof node !== 'object') return null;
    const record = node as Record<string, unknown>;
    const inner = record.trayInner as { size?: number[] } | undefined;
    if (inner?.size) return inner.size;
    for (const child of Object.values(record)) {
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  const size = find(manifest);
  if (!size) throw new Error('combat-table manifest has no trayInner');
  return { width: size[0] as number, depth: size[1] as number };
}

/** Largest distance any die vertex sits beyond the visible tray's inner walls (<= 0 when inside). */
function wallOverlap(kind: DieKind, pose: { position: Vec3; quaternion: Quat }): number {
  let worst = Number.NEGATIVE_INFINITY;
  for (const vertex of dieVertices(kind)) {
    const r = rotateVec(pose.quaternion, vertex);
    worst = Math.max(
      worst,
      Math.abs(r.x + pose.position.x) - AUTHORED_TRAY_HALF.halfX,
      Math.abs(r.z + pose.position.z) - AUTHORED_TRAY_HALF.halfZ,
    );
  }
  return worst;
}

interface SweepResult {
  throws: number;
  intersecting: number;
  worst: number;
  faceMismatches: number;
  escapes: number;
  first: string | null;
}

/** Hand releases from over and past the rim, at rest and up to 6 m/s, into a world of `tray` size. */
async function sweepWorld(tray: { halfX: number; halfZ: number }): Promise<SweepResult> {
  const world = await DiceWorld.create(tray);
  const stream = Stream.fromKey('dice-wall-sweep');
  const events: SettledEvent[] = [];
  world.onSettled((event) => events.push(event));
  const result: SweepResult = {
    throws: 0,
    intersecting: 0,
    worst: Number.NEGATIVE_INFINITY,
    faceMismatches: 0,
    escapes: 0,
    first: null,
  };
  const xs = [-0.26, -0.2, -0.16, -0.12, 0, 0.12, 0.16, 0.2, 0.26];
  const zs = [-0.16, -0.11, -0.095, -0.06, 0, 0.06, 0.095, 0.11, 0.16];
  const speeds = [0, 1.5, 3, 6];
  const spin = (): number => (stream.next() * 2 - 1) * 25;
  for (const x of xs)
    for (const z of zs)
      for (const speed of speeds)
        for (const kind of KINDS) {
          const heading = stream.next() * Math.PI * 2;
          const face = Math.floor(stream.next() * faceNormals(kind).length);
          events.length = 0;
          world.throwDie(
            'die',
            kind,
            { x, y: 0.05 + stream.next() * 0.2, z },
            {
              x: Math.cos(heading) * speed,
              y: stream.next() * 2 - 1,
              z: Math.sin(heading) * speed,
            },
            { x: spin(), y: spin(), z: spin() },
            face,
          );
          for (let i = 0; i < 2400 && !world.allDone; i++) {
            world.step(1 / 120);
            const p = world.pose('die')?.position;
            // The die's centre stays inside the walls for the whole roll: no tunnelling, no push-out.
            if (p && (Math.abs(p.x) > tray.halfX || Math.abs(p.z) > tray.halfZ)) result.escapes++;
          }
          const pose = world.pose('die');
          result.throws++;
          if (!pose || events.length !== 1) {
            result.intersecting++;
            continue;
          }
          const overlap = wallOverlap(kind, pose);
          result.worst = Math.max(result.worst, overlap);
          if (overlap > TOLERANCE) {
            result.intersecting++;
            result.first ??= `${kind} at (${x}, ${z}) at ${speed} m/s overlaps by ${overlap.toFixed(4)}`;
          }
          if (events[0]?.face !== face || upFace(pose.quaternion, faceNormals(kind)) !== face)
            result.faceMismatches++;
        }
  world.dispose();
  return result;
}

describe('dice and the tray wall', () => {
  it('sizes the physics tray to the authored table tray', () => {
    const { width, depth } = manifestTrayInner();
    expect(AUTHORED_TRAY_HALF.halfX).toBeCloseTo(width / 2, 9);
    expect(AUTHORED_TRAY_HALF.halfZ).toBeCloseTo(depth / 2, 9);
  });

  it('reproduces the cause: a collider wider than the visible tray settles dice through its wall', async () => {
    const r = await sweepWorld(OLD_COLLIDER);
    console.log(
      `dice-wall old collider: ${r.intersecting}/${r.throws} dice end inside the visible wall, worst ${r.worst.toFixed(4)} m (${r.first})`,
    );
    expect(r.intersecting).toBeGreaterThan(0);
    expect(r.worst).toBeGreaterThan(0.01);
  }, 120_000);

  it('leaves every swept release inside the tray with the rolled face up', async () => {
    const r = await sweepWorld(AUTHORED_TRAY_HALF);
    console.log(
      `dice-wall authored collider: ${r.intersecting}/${r.throws} intersecting, worst ${r.worst.toFixed(4)} m`,
    );
    expect(r.intersecting).toBe(0);
    expect(r.escapes).toBe(0);
    expect(r.faceMismatches).toBe(0);
  }, 120_000);

  it('keeps hand-held and seeded presenter throws inside the tray with the rules face up', async () => {
    const presenter = await DicePresenter.create(Stream.fromKey('dice-wall-presenter'), {
      ...AUTHORED_TRAY_HALF,
    });
    const rolls: { face: number }[] = [];
    presenter.onSettled((roll) => rolls.push(roll));
    let throws = 0;
    let bad = 0;
    for (const x of [-0.3, -0.15, 0, 0.15, 0.3])
      for (const z of [-0.2, -0.09, 0, 0.09, 0.2])
        for (const kind of KINDS)
          for (const held of [true, false]) {
            presenter.showWaiting(kind);
            if (held) presenter.holdWaiting(new THREE.Vector3(x, 0.1, z));
            rolls.length = 0;
            const face = (throws * 3) % faceNormals(kind).length;
            const id = presenter.throw(kind, face, face + 1);
            for (let i = 0; i < 1200 && rolls.length === 0; i++) presenter.update(1 / 60);
            const mesh = presenter.mesh(id) as THREE.Mesh;
            const pose = {
              position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
              quaternion: {
                x: mesh.quaternion.x,
                y: mesh.quaternion.y,
                z: mesh.quaternion.z,
                w: mesh.quaternion.w,
              },
            };
            throws++;
            if (
              rolls.length !== 1 ||
              rolls[0]?.face !== face ||
              presenter.upFace(id) !== face ||
              wallOverlap(kind, pose) > TOLERANCE
            )
              bad++;
          }
    presenter.dispose();
    expect(throws).toBe(100);
    expect(bad).toBe(0);
  }, 120_000);
});
