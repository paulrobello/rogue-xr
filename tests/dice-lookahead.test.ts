// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Stream } from '../src/core/rng.ts';
import {
  type DieKind,
  dieVertices,
  faceNormals,
  numberingOffset,
  SOLID_ROTATIONS,
  upFace,
} from '../src/dice/faces.ts';
import { DicePresenter, type PresentedRoll } from '../src/dice/presenter.ts';
import {
  type Pose,
  QUAT_IDENTITY,
  type Quat,
  quatAngle,
  quatConjugate,
  quatFromUnitVectors,
  quatMul,
  quatNormalize,
  rotateVec,
  type Vec3,
} from '../src/dice/quat.ts';
import {
  AUTHORED_TRAY_HALF,
  DEFAULT_OPTIONS,
  DiceWorld,
  type DiceWorldOptions,
  FIXED_STEP,
  type SettledEvent,
} from '../src/dice/world.ts';

const KINDS: readonly DieKind[] = ['d6', 'd8'];
/** A die resting on its predicted face is left alone: it must not turn or move after it settles. */
const MAX_HIT_TURN_DEGREES = 1e-4;
const MAX_HIT_SHIFT_METRES = 1e-9;

/** Angle between two orientations, accurate near zero where `quatAngle`'s acos is not. */
function smallAngle(a: Quat, b: Quat): number {
  const r = quatMul(quatConjugate(a), b);
  return 2 * Math.atan2(Math.hypot(r.x, r.y, r.z), Math.abs(r.w));
}

const near = (a: Vec3, b: Vec3): boolean => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-9;

describe('solid rotations', () => {
  it('are 24 distinct proper rotations that map each die onto itself', () => {
    expect(SOLID_ROTATIONS).toHaveLength(24);
    for (let i = 0; i < 24; i++)
      for (let j = i + 1; j < 24; j++)
        expect(quatAngle(SOLID_ROTATIONS[i] as Quat, SOLID_ROTATIONS[j] as Quat)).toBeGreaterThan(
          0.1,
        );
    expect(quatAngle(SOLID_ROTATIONS[0] as Quat, QUAT_IDENTITY)).toBeCloseTo(0, 12);
    for (const kind of KINDS)
      for (const rotation of SOLID_ROTATIONS) {
        for (const set of [faceNormals(kind), dieVertices(kind)])
          for (const v of set) expect(set.some((w) => near(rotateVec(rotation, v), w))).toBe(true);
      }
  });

  it.each(KINDS)(
    '%s numbering offset carries every target label onto every landing face',
    (kind) => {
      const normals = faceNormals(kind);
      for (let target = 0; target < normals.length; target++)
        for (let landing = 0; landing < normals.length; landing++) {
          const offset = numberingOffset(kind, target, landing);
          expect(near(rotateVec(offset, normals[target] as Vec3), normals[landing] as Vec3)).toBe(
            true,
          );
          // A body resting with `landing` up, drawn as body * offset, shows `target`.
          const body = quatFromUnitVectors(normals[landing] as Vec3, { x: 0, y: 1, z: 0 });
          const shown = quatNormalize(quatMul(body, offset));
          expect(upFace(shown, normals)).toBe(target);
        }
      expect(numberingOffset(kind, 2, 2)).toEqual(QUAT_IDENTITY);
    },
  );
});

interface Throw {
  position: Vec3;
  linvel: Vec3;
  angvel: Vec3;
  orientation: Quat;
}

/** The presenter's seeded tray throw: from the player's side toward the far wall, upright. */
function trayThrow(s: Stream, tray: { halfX: number; halfZ: number }): Throw {
  const span = (k: number): number => (s.next() * 2 - 1) * k;
  return {
    position: { x: span(tray.halfX * 0.5), y: 0.1 + s.next() * 0.04, z: tray.halfZ * 0.55 },
    linvel: { x: span(0.25), y: -0.1 - s.next() * 0.2, z: -(0.5 + s.next() * 0.5) },
    angvel: { x: span(18), y: span(18), z: span(18) },
    orientation: QUAT_IDENTITY,
  };
}

/** A hand release anywhere over (and past) the rim, any orientation, up to a hard toss. */
function handThrow(s: Stream, tray: { halfX: number; halfZ: number }): Throw {
  const heading = s.next() * Math.PI * 2;
  const speed = s.next() * 2.5;
  const spin = (): number => (s.next() * 2 - 1) * 25;
  return {
    position: {
      x: (s.next() * 2 - 1) * tray.halfX * 1.3,
      y: 0.08 + s.next() * 0.2,
      z: (s.next() * 2 - 1) * tray.halfZ * 1.3,
    },
    linvel: { x: Math.cos(heading) * speed, y: s.next() * 2 - 1, z: Math.sin(heading) * speed },
    angvel: { x: spin(), y: spin(), z: spin() },
    orientation: quatNormalize({
      x: s.next() * 2 - 1,
      y: s.next() * 2 - 1,
      z: s.next() * 2 - 1,
      w: s.next() * 2 - 1,
    }),
  };
}

interface SweepResult {
  throws: number;
  predicted: number;
  fallbacks: number;
  forced: number;
  shownMismatches: number;
  worstHitTurnDegrees: number;
  worstHitShift: number;
  /** Rests on the predicted face with the up normal more than `COCKED_DEGREES` off vertical. */
  cocked: number;
  worstTiltDegrees: number;
  lookAheadMs: number[];
  /** Fixed steps each throw rolled for: the look-ahead simulated the same count. */
  rollSteps: number[];
}

/** A die resting this far off flat is cocked against the wall (left so, since flattening it is a turn). */
const COCKED_DEGREES = 15;

/** Frame lengths: a steady 72 Hz, a jittery 5 to 30 ms, and a 250 ms hitch that hits `MAX_SUBSTEPS`. */
function frameLength(schedule: number, frame: number, jitter: Stream): number {
  if (schedule === 0) return 1 / 72;
  if (schedule === 1) return 0.005 + jitter.next() * 0.025;
  return frame % 7 === 3 ? 0.25 : 1 / 72;
}

async function sweep(
  tray: Partial<DiceWorldOptions> & { halfX: number; halfZ: number },
  style: 'tray' | 'hand',
  count: number,
  key: string,
): Promise<SweepResult> {
  const world = await DiceWorld.create(tray);
  const stream = Stream.fromKey(key);
  const jitter = Stream.fromKey(`${key}-jitter`);
  const events: SettledEvent[] = [];
  world.onSettled((event) => events.push(event));
  const result: SweepResult = {
    throws: 0,
    predicted: 0,
    fallbacks: 0,
    forced: 0,
    shownMismatches: 0,
    worstHitTurnDegrees: 0,
    worstHitShift: 0,
    cocked: 0,
    worstTiltDegrees: 0,
    lookAheadMs: [],
    rollSteps: [],
  };
  for (let n = 0; n < count; n++) {
    const kind = KINDS[n % 2] as DieKind;
    const t = style === 'tray' ? trayThrow(stream, tray) : handThrow(stream, tray);
    const face = stream.int(0, faceNormals(kind).length - 1);
    events.length = 0;
    const started = performance.now();
    world.throwDie('die', kind, t.position, t.linvel, t.angvel, face, t.orientation);
    result.lookAheadMs.push(performance.now() - started);
    const schedule = n % 3;
    for (let frame = 0; frame < 4000 && events.length === 0; frame++)
      world.step(frameLength(schedule, frame, jitter));
    expect(events).toHaveLength(1);
    const event = events[0] as SettledEvent;
    result.throws++;
    result.rollSteps.push(Math.round(event.rollMs / (FIXED_STEP * 1000)));
    // The renderer keeps drawing the die after it settles; it must not move.
    for (let frame = 0; frame < 36; frame++) world.step(1 / 72);
    const shown = world.pose('die') as Pose;
    if (event.face !== face || upFace(shown.quaternion, faceNormals(kind)) !== face)
      result.shownMismatches++;
    if (event.predicted) result.predicted++;
    if (event.predicted && event.fallback) result.fallbacks++;
    if (event.forced) result.forced++;
    if (event.predicted && !event.fallback) {
      expect(event.correctionMs).toBe(0);
      const turn = (smallAngle(event.pose.quaternion, shown.quaternion) * 180) / Math.PI;
      const p = event.pose.position;
      const q = shown.position;
      result.worstHitTurnDegrees = Math.max(result.worstHitTurnDegrees, turn);
      const up = rotateVec(shown.quaternion, faceNormals(kind)[face] as Vec3);
      const tilt = (Math.acos(Math.min(1, up.y)) * 180) / Math.PI;
      if (tilt > COCKED_DEGREES) result.cocked++;
      result.worstTiltDegrees = Math.max(result.worstTiltDegrees, tilt);
      result.worstHitShift = Math.max(
        result.worstHitShift,
        Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z),
      );
    }
  }
  world.dispose();
  return result;
}

function summary(label: string, r: SweepResult): string {
  // The first throw pays the process's one-off snapshot and wasm warm-up; it is reported apart.
  const sorted = r.lookAheadMs.slice(1).sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] as number;
  const steps = r.rollSteps.slice(1).reduce((a, b) => a + b, 0);
  const perStep = r.lookAheadMs.slice(1).reduce((a, b) => a + b, 0) / steps;
  const timeoutSteps = DEFAULT_OPTIONS.maxRollSeconds / FIXED_STEP;
  return (
    `${label}: ${r.throws} throws, predicted ${r.predicted}, live landed as predicted ` +
    `${r.predicted - r.fallbacks}/${r.predicted}, fallbacks ${r.fallbacks}, forced ${r.forced}, ` +
    `shown != seeded ${r.shownMismatches}, post-settle turn ${r.worstHitTurnDegrees.toExponential(1)} deg ` +
    `shift ${r.worstHitShift.toExponential(1)} m, throw+look-ahead mean ${mean.toFixed(2)} ms ` +
    `p95 ${p95.toFixed(2)} ms max ${(sorted[sorted.length - 1] as number).toFixed(2)} ms ` +
    `(first throw ${(r.lookAheadMs[0] as number).toFixed(2)} ms), cocked >${COCKED_DEGREES} deg ` +
    `${r.cocked}, worst tilt ${r.worstTiltDegrees.toFixed(1)} deg, ` +
    `${(perStep * 1000).toFixed(2)} us per look-ahead step, so ${(perStep * timeoutSteps).toFixed(2)} ms ` +
    `for a ${timeoutSteps}-step timeout throw`
  );
}

describe('throw look-ahead', () => {
  it.each([
    ['authored tray, tray throws', AUTHORED_TRAY_HALF, 'tray'],
    ['authored tray, hand throws', AUTHORED_TRAY_HALF, 'hand'],
    ['default tray, tray throws', DEFAULT_OPTIONS, 'tray'],
    ['default tray, hand throws', DEFAULT_OPTIONS, 'hand'],
  ] as const)(
    '%s land on the predicted face showing the seeded roll',
    async (label, tray, style) => {
      const r = await sweep(tray, style, 150, `lookahead-${label}`);
      console.log(summary(`dice-lookahead ${label}`, r));
      expect(r.shownMismatches).toBe(0);
      expect(r.predicted).toBe(r.throws - r.forced);
      expect(r.fallbacks).toBe(0);
      expect(r.worstHitTurnDegrees).toBeLessThan(MAX_HIT_TURN_DEGREES);
      expect(r.worstHitShift).toBeLessThan(MAX_HIT_SHIFT_METRES);
    },
    120_000,
  );

  it('falls back to the settle correction when a later die knocks a predicted one', async () => {
    const world = await DiceWorld.create();
    const events: SettledEvent[] = [];
    world.onSettled((event) => events.push(event));
    const still = { x: 0, y: 0, z: 0 };
    world.throwDie('a', 'd6', { x: 0, y: 0.12, z: 0 }, still, still, 3);
    world.throwDie('b', 'd6', { x: -0.25, y: 0.1, z: 0.01 }, { x: 3, y: 0.3, z: 0 }, still, 1);
    for (let frame = 0; frame < 2000 && !world.allDone; frame++) world.step(1 / 72);
    const a = events.find((event) => event.id === 'a') as SettledEvent;
    const b = events.find((event) => event.id === 'b') as SettledEvent;
    expect(a.predicted).toBe(true);
    expect(a.fallback).toBe(true);
    expect(a.correctionMs).toBeGreaterThan(0);
    expect(a.face).toBe(3);
    expect(upFace(world.pose('a')?.quaternion as Quat, faceNormals('d6'))).toBe(3);
    // The second die's look-ahead replayed the first, so it landed as predicted.
    expect(b.fallback).toBe(false);
    expect(b.face).toBe(1);
    world.dispose();
  });

  it('skips the prediction when the die would only stop through a guard', async () => {
    const world = await DiceWorld.create({ maxRollSeconds: 0.2 });
    const events: SettledEvent[] = [];
    world.onSettled((event) => events.push(event));
    world.throwDie(
      'die',
      'd8',
      { x: 0, y: 0.3, z: 0 },
      { x: 1, y: 0, z: 0.5 },
      { x: 20, y: 10, z: -15 },
      3,
    );
    for (let frame = 0; frame < 2000 && !world.allDone; frame++) world.step(1 / 60);
    world.dispose();
    expect(events[0]?.forced).toBe(true);
    expect(events[0]?.predicted).toBe(false);
    expect(events[0]?.face).toBe(3);
  });
});

/** Runs a presenter through a fixed mix of tray and hand-held throws, recording every settle. */
async function presenterRun(key: string): Promise<{ rolls: PresentedRoll[]; poses: number[][] }> {
  const presenter = await DicePresenter.create(Stream.fromKey(key), { ...AUTHORED_TRAY_HALF });
  const rolls: PresentedRoll[] = [];
  const poses: number[][] = [];
  presenter.onSettled((roll) => rolls.push(roll));
  const hand = Stream.fromKey(`${key}-hand`);
  for (let n = 0; n < 60; n++) {
    const kind = KINDS[n % 2] as DieKind;
    presenter.showWaiting(kind);
    if (n % 3 !== 0)
      presenter.holdWaiting(
        new THREE.Vector3(
          (hand.next() * 2 - 1) * 0.25,
          0.05 + hand.next() * 0.2,
          (hand.next() * 2 - 1) * 0.15,
        ),
      );
    const face = (n * 5) % faceNormals(kind).length;
    const before = rolls.length;
    const id = presenter.throw(kind, face, face + 1);
    for (let i = 0; i < 2000 && rolls.length === before; i++) presenter.update(1 / 72);
    expect(rolls.length).toBe(before + 1);
    expect(rolls[before]?.face).toBe(face);
    expect(presenter.upFace(id)).toBe(face);
    const mesh = presenter.mesh(id) as THREE.Mesh;
    poses.push([...mesh.position.toArray(), ...mesh.quaternion.toArray()]);
  }
  presenter.dispose();
  return { rolls, poses };
}

describe('presenter throws', () => {
  it('rest on the seeded face without a fallback, and a seeded run replays exactly', async () => {
    const first = await presenterRun('lookahead-presenter');
    const again = await presenterRun('lookahead-presenter');
    const fallbacks = first.rolls.filter((roll) => roll.fallback).length;
    console.log(`dice-lookahead presenter: 60 throws (40 hand-held), fallbacks ${fallbacks}`);
    expect(fallbacks).toBe(0);
    expect(again.rolls).toEqual(first.rolls);
    expect(again.poses).toEqual(first.poses);
  }, 120_000);
});

describe('warm-up', () => {
  it('settles a throwaway d6 and d8 and leaves later throws unchanged', async () => {
    await DiceWorld.warmUp();
    const world = await DiceWorld.create();
    const settled: number[] = [];
    world.onSettled((event) => settled.push(event.face));
    world.throwDie(
      'a',
      'd6',
      { x: 0, y: 0.1, z: 0 },
      { x: 0.3, y: 0, z: 0 },
      { x: 5, y: 2, z: -3 },
      2,
    );
    for (let n = 0; n < 2000 && !world.allDone; n++) world.step(1 / 72);
    expect(settled).toEqual([2]);
    world.dispose();
  });
});
