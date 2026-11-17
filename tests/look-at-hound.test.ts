// @vitest-environment node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  type EnemyActor,
  type EnemyAsset,
  parseEnemyAsset,
  parseEnemyManifest,
} from '../src/enemies/enemy-asset.ts';
import { LOOK_LIMITS } from '../src/enemies/look-at.ts';

const DEG = Math.PI / 180;
const HZ = 72;
const L = LOOK_LIMITS;
/** Peak rate of a critically damped spring of rate `omega` closing `angle` from rest, per frame. */
const springStep = (omega: number, angle: number): number => (omega * angle) / Math.E / HZ;
const FULL_TURN = Math.hypot(L.maxYaw, L.maxPitch);
/**
 * Largest smooth frame-to-frame head change while watching (about 2.4 degrees at 72 Hz), with a
 * margin for the idle; the bug measured 96 to 168 degrees.
 */
const MAX_STEP = 1.25 * springStep(L.omega, FULL_TURN);
/** The same for the fast release on freeze and death (about 7 degrees). */
const MAX_RELEASE_STEP = 1.25 * springStep(L.releaseOmega, FULL_TURN);
/**
 * The neck and head each turn their share about their own pivot, and the two yaw-pitch shares do
 * not compose to the whole yaw-pitch exactly: up to 3 degrees off at the clamp corner (yaw 60,
 * pitch 30), the same on the sentry. The idle moving the pivot adds a little.
 */
const AIM_TOLERANCE = 3.5 * DEG;

const assets = new Map<string, Promise<EnemyAsset>>();
function load(id: string): Promise<EnemyAsset> {
  let asset = assets.get(id);
  if (!asset) {
    const base = new URL(`../public/assets/enemies/${id}/`, import.meta.url);
    const manifest = parseEnemyManifest(
      JSON.parse(readFileSync(new URL(`${id}.manifest.json`, base), 'utf8')),
      id,
    );
    const bytes = readFileSync(new URL(`${id}.glb`, base));
    const glb = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    asset = parseEnemyAsset(glb as ArrayBuffer, manifest, null);
    assets.set(id, asset);
  }
  return asset;
}

/** Body-frame offset at `yaw`/`pitch` (look-at convention: +yaw toward -X, +pitch up). */
function offsetAt(yaw: number, pitch: number, distance: number): THREE.Vector3 {
  const flat = Math.cos(pitch) * distance;
  return new THREE.Vector3(
    -Math.sin(yaw) * flat,
    Math.sin(pitch) * distance,
    -Math.cos(yaw) * flat,
  );
}

const bodyQuat = (root: THREE.Object3D, bone: THREE.Object3D): THREE.Quaternion => {
  const q = bone.quaternion.clone();
  for (let p = bone.parent; p && p !== root; p = p.parent) q.premultiply(p.quaternion);
  return q;
};

const headOf = (actor: EnemyActor): THREE.Object3D => {
  const head = actor.headLook?.head;
  if (!head) throw new Error(`${actor.kind}: no head`);
  return head;
};

interface Pair {
  watcher: EnemyActor;
  still: EnemyActor;
}

/**
 * A watcher and an identical actor that never looks, placed and turned alike, so the watcher's look
 * is the head rotation it has beyond the still one's (the animation cancels out).
 */
function pair(asset: EnemyAsset): Pair {
  const scene = new THREE.Scene();
  const watcher = asset.spawn();
  const still = asset.spawn();
  for (const a of [watcher, still]) {
    a.object.position.set(1, 0, 3);
    a.object.rotation.y = -0.6;
    scene.add(a.object);
    a.update(0);
  }
  scene.updateMatrixWorld(true);
  return { watcher, still };
}

const dispose = ({ watcher, still }: Pair): void => {
  watcher.dispose();
  still.dispose();
};

/** The look's rotation of the head in the body frame: watcher head over the still head. */
const lookDelta = ({ watcher, still }: Pair): THREE.Quaternion =>
  bodyQuat(watcher.object, headOf(watcher)).multiply(
    bodyQuat(still.object, headOf(still)).invert(),
  );

/** World point at a body-frame offset from the still actor's current head pivot. */
const targetAt = ({ still }: Pair, local: THREE.Vector3): THREE.Vector3 =>
  headOf(still)
    .getWorldPosition(new THREE.Vector3())
    .add(local.clone().applyQuaternion(still.object.quaternion));

interface Run {
  /** Largest frame-to-frame change of the look's head rotation, radians. */
  maxStep: number;
  /** Largest frame-to-frame change over the last half second. */
  settledStep: number;
  /** Body forward (-Z) turned by the final look. */
  aimed: THREE.Vector3;
}

/** Runs both actors `frames` frames through the real mixer, the watcher looking at `target(i)`. */
function run(p: Pair, frames: number, target: (i: number) => THREE.Vector3 | null): Run {
  let prev = lookDelta(p);
  let maxStep = 0;
  let settledStep = 0;
  for (let i = 0; i < frames; i++) {
    p.watcher.update(1 / HZ, target(i));
    p.still.update(1 / HZ);
    const delta = lookDelta(p);
    const step = delta.angleTo(prev);
    maxStep = Math.max(maxStep, step);
    if (i >= frames - HZ / 2) settledStep = Math.max(settledStep, step);
    prev = delta;
  }
  return { maxStep, settledStep, aimed: new THREE.Vector3(0, 0, -1).applyQuaternion(prev) };
}

describe('Spring Hound head look on the real rig', () => {
  it('cause: the idle leaves neck.2 unwritten on some frames, so a turn left on it would compound', async () => {
    const asset = await load('spring-hound');
    const actor = asset.spawn();
    actor.update(0);
    const neck = actor.headLook?.bones[0]?.bone;
    expect(neck?.name).toBe('neck2');
    const sentinel = new THREE.Quaternion(0.6, 0, 0, 0.8);
    let unwritten = 0;
    for (let i = 0; i < 2 * HZ; i++) {
      neck?.quaternion.copy(sentinel);
      actor.update(1 / HZ);
      if (neck?.quaternion.equals(sentinel)) unwritten++;
    }
    // Measured: 30 of 144 frames at 72 Hz (the idle's neck.2 track holds identity for stretches).
    expect(unwritten).toBeGreaterThan(10);
    actor.dispose();
  });

  it('turns smoothly onto targets in front, to the sides, above and below, within its limits', async () => {
    const asset = await load('spring-hound');
    for (const pitchDeg of [0, 20, -20, 45, -45]) {
      for (const yawDeg of [0, 30, -30, 55, -55, 70, -70]) {
        const p = pair(asset);
        const local = offsetAt(yawDeg * DEG, pitchDeg * DEG, 2.2);
        const target = targetAt(p, local);
        const r = run(p, 3 * HZ, () => target);
        const want = offsetAt(
          Math.max(-L.maxYaw, Math.min(L.maxYaw, yawDeg * DEG)),
          Math.max(-L.maxPitch, Math.min(L.maxPitch, pitchDeg * DEG)),
          1,
        );
        const where = `yaw ${yawDeg} pitch ${pitchDeg}`;
        expect(p.watcher.headLook?.tracking, where).toBe(true);
        expect(r.maxStep, where).toBeLessThan(MAX_STEP);
        expect(r.settledStep, where).toBeLessThan(0.5 * DEG);
        expect(r.aimed.angleTo(want), where).toBeLessThan(AIM_TOLERANCE);
        dispose(p);
      }
    }
  });

  it('keeps the animated head for a player behind it, beyond the look cone', async () => {
    const asset = await load('spring-hound');
    for (const yawDeg of [90, -90, 135, -135, 180]) {
      const p = pair(asset);
      const target = targetAt(p, offsetAt(yawDeg * DEG, 10 * DEG, 2));
      const r = run(p, 2 * HZ, () => target);
      expect(p.watcher.headLook?.tracking).toBe(false);
      expect(r.maxStep).toBe(0);
      expect(headOf(p.watcher).quaternion.angleTo(headOf(p.still).quaternion)).toBe(0);
      dispose(p);
    }
  });

  it('follows a player circling it at three heights without a jump, across the cone edge', async () => {
    const asset = await load('spring-hound');
    for (const pitchDeg of [-25, 5, 35]) {
      const p = pair(asset);
      // One turn in 8 s from straight ahead: in, clamped at the side, let go behind, picked up again.
      const r = run(p, 8 * HZ, (i) =>
        targetAt(p, offsetAt((i / (8 * HZ)) * 2 * Math.PI, pitchDeg * DEG, 1.8)),
      );
      expect(r.maxStep, `pitch ${pitchDeg}`).toBeLessThan(MAX_STEP);
      dispose(p);
    }
  });

  it('takes the turn off with the actor reset, even on a bone the mixer leaves alone', async () => {
    const asset = await load('spring-hound');
    const p = pair(asset);
    const target = targetAt(p, offsetAt(-45 * DEG, 0, 2));
    run(p, HZ, () => target);
    p.watcher.reset();
    p.still.reset();
    expect(p.watcher.headLook?.yaw).toBe(0);
    const r = run(p, HZ, () => null);
    expect(r.maxStep).toBe(0);
    expect(lookDelta(p).angleTo(new THREE.Quaternion())).toBe(0);
    dispose(p);
  });
});

describe('every shipped automaton', () => {
  for (const id of [
    'cog-sentry',
    'bellows-golem',
    'spring-hound',
    'orrery-warden',
    'grand-escapement',
  ]) {
    it(`${id}: a circling player never makes the head jump`, async () => {
      const asset = await load(id);
      const p = pair(asset);
      const r = run(p, 6 * HZ, (i) =>
        targetAt(p, offsetAt((i / (6 * HZ)) * 2 * Math.PI, 15 * DEG, 2)),
      );
      expect(r.maxStep).toBeLessThan(MAX_STEP);
      dispose(p);
    });

    it(`${id}: stays smooth through attack, hit, freeze, thaw and death with a player in view`, async () => {
      const asset = await load(id);
      const p = pair(asset);
      const target = targetAt(p, offsetAt(40 * DEG, 15 * DEG, 2));
      const both = (f: (a: EnemyActor) => void): void => {
        f(p.watcher);
        f(p.still);
      };
      const phase = (seconds: number, bound: number, what: string): void => {
        expect(run(p, seconds * HZ, () => target).maxStep, what).toBeLessThan(bound);
      };
      phase(1.5, MAX_STEP, 'idle');
      both((a) => a.attack());
      phase(1.5, MAX_STEP, 'attack');
      both((a) => a.hit());
      phase(1, MAX_STEP, 'hit');
      expect(p.watcher.headLook?.tracking).toBe(true);
      both((a) => a.freeze());
      // The held frozen clip leaves every bone unwritten while the look lets go.
      phase(1.5, MAX_RELEASE_STEP, 'freeze');
      expect(lookDelta(p).angleTo(new THREE.Quaternion())).toBeLessThan(0.1 * DEG);
      both((a) => a.unfreeze());
      phase(1.5, MAX_STEP, 'thaw');
      both((a) => void a.die());
      phase(2.5, MAX_RELEASE_STEP, 'death');
      expect(headOf(p.watcher).quaternion.angleTo(headOf(p.still).quaternion)).toBeLessThan(
        0.1 * DEG,
      );
      dispose(p);
    });
  }
});

/**
 * The Cog Sentry's look before the hound fix (its mixer rewrites the head and neck every frame), as
 * [yaw, pitch, neck quaternion, head quaternion] after 2 s on each target.
 */
const SENTRY_BEFORE: readonly (readonly number[])[] = [
  [
    -0.524240354771123, 0.20965658911066268, 0.04168883195221714, -0.10456408378455183,
    0.004387081305288003, 0.9936343126071975, 0.06276916206938178, -0.15604139694179783,
    0.009811560559852491, 0.9857052541266789,
  ],
  [
    0.9609221204503162, -0.349296019983327, -0.06851728760256375, 0.19053766777949713,
    0.013332505775545003, 0.9791950892168949, -0.10411459712237757, 0.28138326706464956,
    0.02943799242773258, 0.9534762777772154,
  ],
  [
    1.0471844895740219, 0.5235922447870109, 0.10224305170479778, 0.20677021596539802,
    -0.021732152365850747, 0.9727898795327078, 0.1555755975091623, 0.3019391309589962,
    -0.047461578550954384, 0.9393489198465311,
  ],
];

describe('Cog Sentry look unchanged', () => {
  it('lands on the same yaw, pitch and bone rotations as before the fix', async () => {
    const asset = await load('cog-sentry');
    const targets = [
      [-30, 12],
      [55, -20],
      [70, 40],
    ] as const;
    targets.forEach(([yaw, pitch], k) => {
      const p = pair(asset);
      const target = targetAt(p, offsetAt(yaw * DEG, pitch * DEG, 2.4));
      run(p, 2 * HZ, () => target);
      const look = p.watcher.headLook;
      const got = [
        look?.yaw ?? 0,
        look?.pitch ?? 0,
        ...(look?.bones.flatMap((b) => b.bone.quaternion.toArray()) ?? []),
      ];
      const want = SENTRY_BEFORE[k] ?? [];
      expect(got.length).toBe(want.length);
      got.forEach((v, j) => {
        expect(v).toBeCloseTo(want[j] ?? Number.NaN, 12);
      });
      dispose(p);
    });
  });
});
