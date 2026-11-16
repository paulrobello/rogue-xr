import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { type Box, type Rect, templateById, type Vec3 } from '../src/content/rooms.ts';
import {
  applyDeadzone,
  calibrateHeight,
  DEFAULT_TELEPORT,
  DEFAULT_VIGNETTE,
  Locomotion,
  moveWithCollision,
  normalizeYaw,
  quantizeYaw,
  readThumbstick,
  resolveCollision,
  resolveTeleport,
  rotateAboutPivot,
  SNAP_TURN_INITIAL,
  type SnapTurnState,
  sampleTeleportArc,
  segmentBoxHit,
  smoothMove,
  smoothTurnRate,
  stepSnapTurn,
  type TeleportEnv,
  validateLanding,
  vignetteStep,
  vignetteTarget,
  yawFromMatrix,
} from '../src/xr/locomotion.ts';

/**
 * Fixture room: the greybox study at the world origin. Footprint -4..4, perimeter walls 0.2 m
 * thick centred on the edges, a 1.2 m pillar at the centre, doors at S (x -1) and E (z -1).
 * An extra walkable rect sits beyond the south door so a teleport can cross the threshold.
 */
const study = templateById('study');
const COLLIDERS: readonly Box[] = study.colliders;
const OUTSIDE_SOUTH: Rect = { min: [-1.8, 4.4], max: [-0.2, 7] };
const ENV: TeleportEnv = { walkable: [...study.walkable, OUTSIDE_SOUTH], colliders: COLLIDERS };

function near(v: readonly number[], expected: readonly number[], digits = 6) {
  expect(v).toHaveLength(expected.length);
  expected.forEach((e, i) => {
    expect(v[i]).toBeCloseTo(e, digits);
  });
}

describe('sticks', () => {
  it('zeroes the deadzone and rescales so the outer edge is 1', () => {
    expect(applyDeadzone(0.1, 0.1)).toEqual([0, 0]);
    near(applyDeadzone(1, 0), [1, 0]);
    near(applyDeadzone(0, -1), [0, -1]);
    const [x] = applyDeadzone(0.575, 0);
    expect(x).toBeCloseTo(0.5, 6);
    expect(Math.hypot(...applyDeadzone(1, 1))).toBeCloseTo(1, 6);
  });

  it('survives NaN and reads Quest axes with up as forward', () => {
    expect(applyDeadzone(Number.NaN, 1)).toEqual([0, 0]);
    expect(readThumbstick([0, 0, 0.5, -1])).toEqual([0.5, 1]);
    expect(readThumbstick([0.2, 0.4])).toEqual([0.2, -0.4]);
    expect(readThumbstick([0, 0, Number.NaN, Number.NaN])).toEqual([0, -0]);
  });
});

describe('snap turn', () => {
  function run(samples: number[], step?: number): number[] {
    let state: SnapTurnState = SNAP_TURN_INITIAL;
    return samples.map((x) => {
      const r = stepSnapTurn(state, x, step);
      state = r.state;
      return r.degrees;
    });
  }

  it('fires exactly one 30 degree step per push and ignores sub-threshold input', () => {
    expect(run([0.5, 0.69, 0.7, 1, 1, 1])).toEqual([0, 0, 30, 0, 0, 0]);
    expect(run([-1, -1, 0])).toEqual([-30, 0, 0]);
  });

  it('needs a return below the re-arm threshold before it fires again (hysteresis)', () => {
    expect(run([1, 0.5, 1, 0.2, 1])).toEqual([30, 0, 0, 0, 30]);
    expect(run([1, 0, -1])).toEqual([30, 0, -30]);
  });

  it('only ever turns by 0 or plus or minus the step', () => {
    const stick = [1, 0, -1, 0, 0.9, 0.1, -0.8, 0.0, 1, 0.5, 0.2, 0.75];
    for (const step of [15, 30, 45]) {
      for (const d of run(stick, step)) expect([0, step, -step]).toContain(d);
    }
  });

  it('quantizes the heading: twelve right snaps return to the start, offsets round to steps', () => {
    const snaps = run(Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? 1 : 0)));
    expect(snaps.filter((d) => d !== 0)).toHaveLength(12);
    expect(normalizeYaw(snaps.reduce((a, b) => a + b, 0))).toBe(0);
    expect(quantizeYaw(44, 30)).toBe(30);
    expect(quantizeYaw(46, 30)).toBe(60);
    expect(quantizeYaw(-14, 30)).toBe(0);
    expect(quantizeYaw(-16, 30)).toBe(330);
    expect(quantizeYaw(359, 30)).toBe(0);
    expect(normalizeYaw(-30)).toBe(330);
    expect(normalizeYaw(720)).toBe(0);
  });

  it('falls back to 30 degrees on a bad step', () => {
    expect(run([1], 0)).toEqual([30]);
    expect(run([1], -5)).toEqual([30]);
    expect(run([Number.NaN, 1])).toEqual([0, 30]);
  });

  it('smooth turn scales with deflection and is clockwise for right', () => {
    expect(smoothTurnRate(0.1)).toBe(0);
    expect(smoothTurnRate(1, 120)).toBeCloseTo(120, 6);
    expect(smoothTurnRate(-1, 120)).toBeCloseTo(-120, 6);
    expect(smoothTurnRate(0.575, 100)).toBeCloseTo(50, 6);
  });
});

describe('smooth move', () => {
  it('moves along the head heading with north as -Z and east as +X', () => {
    near(smoothMove(0, 1, 0, 2, 1), [0, -2]);
    near(smoothMove(90, 1, 0, 2, 1), [2, 0]);
    near(smoothMove(180, 1, 0, 2, 1), [0, 2]);
    near(smoothMove(270, 1, 0, 2, 1), [-2, 0]);
  });

  it('strafes to the head right and backs away from it', () => {
    near(smoothMove(0, 0, 1, 2, 1), [2, 0]);
    near(smoothMove(90, 0, 1, 2, 1), [0, 2]);
    near(smoothMove(0, -1, 0, 2, 1), [0, 2]);
  });

  it('does not speed up on diagonals or oversized input, and scales with dt', () => {
    expect(Math.hypot(...smoothMove(33, 1, 1, 2, 1))).toBeCloseTo(2, 6);
    expect(Math.hypot(...smoothMove(33, 5, 0, 2, 1))).toBeCloseTo(2, 6);
    expect(Math.hypot(...smoothMove(33, 0.5, 0, 2, 0.5))).toBeCloseTo(0.5, 6);
    expect(smoothMove(33, 0, 0, 2, 1)).toEqual([0, 0]);
  });

  it('reads heading from a world matrix and rotates points clockwise about a pivot', () => {
    for (const deg of [0, 30, 90, 200, 315]) {
      const m = new THREE.Matrix4().makeRotationY(-deg * (Math.PI / 180));
      expect(yawFromMatrix(m.elements)).toBeCloseTo(deg, 4);
    }
    near(rotateAboutPivot([0, -1], [0, 0], 90), [1, 0]);
    near(rotateAboutPivot([3, 2], [2, 2], 180), [1, 2]);
    near(rotateAboutPivot([2, 2], [2, 2], 77), [2, 2]);
  });
});

describe('comfort vignette', () => {
  it('targets zero at rest and ramps with speed up to the cap', () => {
    expect(vignetteTarget(0, 0)).toBe(0);
    const half = vignetteTarget(DEFAULT_VIGNETTE.speedForMax / 2, 0);
    expect(half).toBeCloseTo(DEFAULT_VIGNETTE.maxStrength / 2, 6);
    expect(vignetteTarget(99, 0)).toBe(DEFAULT_VIGNETTE.maxStrength);
  });

  it('takes the larger of move and turn demand and ignores turn direction', () => {
    const t = vignetteTarget(0.5, -DEFAULT_VIGNETTE.turnRateForMax);
    expect(t).toBe(DEFAULT_VIGNETTE.maxStrength);
    expect(vignetteTarget(0.5, 0)).toBeLessThan(t);
  });

  it('attacks faster than it releases and never overshoots', () => {
    const dt = 1 / 72;
    const up = vignetteStep(0, 0.7, dt);
    const down = 0.7 - vignetteStep(0.7, 0, dt);
    expect(up).toBeCloseTo(DEFAULT_VIGNETTE.attack * dt, 9);
    expect(down).toBeCloseTo(DEFAULT_VIGNETTE.release * dt, 9);
    expect(up).toBeGreaterThan(down);
    expect(vignetteStep(0.69, 0.7, 1)).toBe(0.7);
    expect(vignetteStep(0.01, 0, 1)).toBe(0);
    expect(vignetteStep(0.3, 0.3, dt)).toBe(0.3);
  });

  it('ramps in under 0.2 s, holds while moving and fades out over a few tenths', () => {
    const dt = 1 / 72;
    let s = 0;
    let frames = 0;
    while (s < DEFAULT_VIGNETTE.maxStrength && frames < 1000) {
      s = vignetteStep(s, DEFAULT_VIGNETTE.maxStrength, dt);
      frames++;
    }
    expect(frames * dt).toBeLessThan(0.2);
    expect(vignetteStep(s, DEFAULT_VIGNETTE.maxStrength, dt)).toBe(DEFAULT_VIGNETTE.maxStrength);
    let fade = 0;
    while (s > 0 && fade < 1000) {
      s = vignetteStep(s, 0, dt);
      fade++;
    }
    expect(fade * dt).toBeGreaterThan(0.2);
    expect(fade * dt).toBeLessThan(0.5);
  });
});

describe('height calibration', () => {
  it('lifts a seated head to the standing eye height', () => {
    expect(calibrateHeight(1.2)).toBeCloseTo(0.4, 6);
    expect(calibrateHeight(1.2, 1.7)).toBeCloseTo(0.5, 6);
    expect(calibrateHeight(1.6)).toBe(0);
  });

  it('lowers a head above target, clamps absurd readings and ignores non-finite input', () => {
    expect(calibrateHeight(1.8)).toBeCloseTo(-0.2, 6);
    expect(calibrateHeight(3)).toBe(-0.3);
    expect(calibrateHeight(0.1)).toBe(1);
    expect(calibrateHeight(Number.NaN)).toBe(0);
    expect(calibrateHeight(1.2, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('collision against the fixture room', () => {
  it('leaves a free circle alone', () => {
    expect(resolveCollision([2, 2], COLLIDERS)).toEqual([2, 2]);
  });

  it('pushes a circle out of a wall to exactly its radius', () => {
    // South wall spans z 3.9..4.1, so the circle centre rests at 3.9 - 0.25.
    const [x, z] = resolveCollision([2, 3.8], COLLIDERS);
    expect(x).toBe(2);
    expect(z).toBeCloseTo(3.65, 4);
  });

  it('slides along a wall instead of stopping dead', () => {
    const [x, z] = moveWithCollision([2, 3.6], [1, 1], COLLIDERS);
    expect(x).toBeCloseTo(3, 3);
    expect(z).toBeCloseTo(3.65, 3);
  });

  it('stops at the pillar and slides around its face', () => {
    // Pillar is -0.6..0.6. Walk east at z 0.2 into the west face.
    const [x] = moveWithCollision([-2, 0.2], [2, 0], COLLIDERS);
    expect(x).toBeCloseTo(-0.85, 2);
    const [, z] = moveWithCollision([-2, 0.2], [2, 0.6], COLLIDERS);
    expect(z).toBeGreaterThan(0.2);
  });

  it('rounds a corner rather than snagging', () => {
    // North-east pillar corner at (0.6, 0.6). Approach diagonally from outside.
    const [x, z] = moveWithCollision([1.5, 1.5], [-1, -1], COLLIDERS);
    expect(Math.hypot(x - 0.6, z - 0.6)).toBeGreaterThanOrEqual(0.25 - 1e-4);
    expect(Math.hypot(x - 0.6, z - 0.6)).toBeLessThan(0.3);
  });

  it('ejects a circle whose centre ended up inside a box through the nearest face', () => {
    const [x, z] = resolveCollision([0.5, 0], COLLIDERS);
    expect(x).toBeCloseTo(0.85, 4);
    expect(z).toBe(0);
  });

  it('cannot tunnel through a thin wall in one large frame step', () => {
    const [, z] = moveWithCollision([2, 3], [0, 3], COLLIDERS);
    expect(z).toBeLessThan(3.9);
    expect(z).toBeCloseTo(3.65, 3);
  });

  it('walks through the door gap but not the wall beside it', () => {
    // South door at x -1 spans -1.8..-0.2.
    const through = moveWithCollision([-1, 3], [0, 3], COLLIDERS);
    expect(through[1]).toBeCloseTo(6, 3);
    const beside = moveWithCollision([1, 3], [0, 3], COLLIDERS);
    expect(beside[1]).toBeCloseTo(3.65, 3);
  });

  it('ignores boxes below step height or above the body', () => {
    const rug: Box = { min: [-1, 0, -1], max: [1, 0.05, 1] };
    const beam: Box = { min: [-1, 2.5, -1], max: [1, 3, 1] };
    expect(resolveCollision([0, 0], [rug, beam])).toEqual([0, 0]);
    expect(resolveCollision([0, 0], [rug], { stepHeight: 0.01 })[0]).not.toBe(0);
  });
});

describe('teleport arc', () => {
  const slow = { ...DEFAULT_TELEPORT, speed: 5 };

  it('samples a parabola from the origin: constant horizontal speed, one apex', () => {
    const pts = sampleTeleportArc([0, 1.2, 0], [0, 1, -1], slow);
    expect(pts[0]).toEqual([0, 1.2, 0]);
    const dz = pts.map((p, i) => (i === 0 ? 0 : p[2] - (pts[i - 1] as Vec3)[2]));
    for (const d of dz.slice(1)) expect(d).toBeCloseTo(dz[1] as number, 6);
    const ys = pts.map((p) => p[1]);
    const apex = ys.indexOf(Math.max(...ys));
    expect(apex).toBeGreaterThan(0);
    expect(apex).toBeLessThan(ys.length - 1);
    expect(sampleTeleportArc([1, 1, 1], [0, 0, 0])).toEqual([[1, 1, 1]]);
  });

  it('lands on the floor where ballistics says and validates inside the room', () => {
    // 20 degrees up at 5 m/s from 1.2 m, aimed west.
    const a = (20 * Math.PI) / 180;
    const dir: Vec3 = [-Math.cos(a), Math.sin(a), 0];
    const r = resolveTeleport([2, 1.2, 2], dir, ENV, slow);
    const vy = 5 * Math.sin(a);
    const t = (vy + Math.sqrt(vy * vy + 2 * 9.81 * 1.2)) / 9.81;
    expect(r.reason).toBe('ok');
    expect(r.valid).toBe(true);
    expect(r.landing?.[1]).toBe(0);
    expect(r.landing?.[0]).toBeCloseTo(2 - 5 * Math.cos(a) * t, 1);
    expect(r.landing?.[2]).toBeCloseTo(2, 6);
    expect(r.points.at(-1)).toEqual(r.landing);
  });

  it('is blocked by a wall even when a sample step straddles it', () => {
    const r = resolveTeleport([0, 1.2, 2], [0, 0.1, 1], ENV);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('blocked');
    expect(r.landing).toBeNull();
    expect(r.points.at(-1)?.[2]).toBeCloseTo(3.9, 3);
  });

  it('passes through the door gap and lands in the walkable area beyond', () => {
    const a = (20 * Math.PI) / 180;
    const r = resolveTeleport([-1, 1.2, 2], [0, Math.sin(a), Math.cos(a)], ENV, slow);
    expect(r.reason).toBe('ok');
    expect(r.landing?.[2]).toBeGreaterThan(4.4);
    expect(r.landing?.[2]).toBeLessThan(7);
  });

  it('rejects landings outside the walkable area', () => {
    // Same throw without the extra rect beyond the door.
    const a = (20 * Math.PI) / 180;
    const env: TeleportEnv = { walkable: study.walkable, colliders: COLLIDERS };
    const r = resolveTeleport([-1, 1.2, 2], [0, Math.sin(a), Math.cos(a)], env, slow);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('out-of-bounds');
    expect(r.landing).not.toBeNull();
  });

  it('reports arcs that never come down, are too far, or have no direction', () => {
    expect(resolveTeleport([0, 1.2, 2], [0, 1, 0], ENV, { ...slow, maxSeconds: 0.2 }).reason).toBe(
      'no-landing',
    );
    const far = resolveTeleport([2, 1.2, 2], [-1, 0.3, 0], ENV, { ...slow, maxRange: 0.5 });
    expect(far.reason).toBe('too-far');
    expect(far.valid).toBe(false);
    expect(resolveTeleport([0, 1, 0], [0, 0, 0], ENV).reason).toBe('no-direction');
  });

  it('validates landing points: walkable bounds, collider clearance, door threshold', () => {
    expect(validateLanding([2, 2], ENV)).toBe('ok');
    expect(validateLanding([3.6, 0], ENV)).toBe('ok');
    expect(validateLanding([3.7, 0], ENV)).toBe('out-of-bounds');
    expect(validateLanding([9, 9], ENV)).toBe('out-of-bounds');
    expect(validateLanding([0, 0], ENV)).toBe('obstructed');
    expect(validateLanding([0.7, 0], ENV)).toBe('obstructed');
    expect(validateLanding([0.9, 0], ENV)).toBe('ok');
    expect(validateLanding([-1, 5], ENV)).toBe('ok');
  });

  it('finds a segment hit on a thin box and misses when it stops short', () => {
    const wall: Box = { min: [-1, 0, 3.9], max: [1, 4, 4.1] };
    expect(segmentBoxHit([0, 1, 3], [0, 1, 5], wall)).toBeCloseTo(0.45, 6);
    expect(segmentBoxHit([0, 1, 3], [0, 1, 3.8], wall)).toBeNull();
    expect(segmentBoxHit([5, 1, 3], [5, 1, 5], wall)).toBeNull();
    expect(segmentBoxHit([0, 5, 3], [0, 5, 5], wall)).toBeNull();
  });
});

describe('Locomotion rig wiring', () => {
  function build(settings = {}) {
    const rig = new THREE.Group();
    const head = new THREE.PerspectiveCamera();
    rig.add(head);
    head.position.set(0, 1.2, 0);
    const loco = new Locomotion(rig, head, settings);
    loco.setWorld(COLLIDERS, ENV.walkable);
    return { rig, head, loco };
  }
  const idle = { moveX: 0, moveY: 0, turnX: 0, teleportAim: null };

  function headWorld(head: THREE.Object3D): THREE.Vector3 {
    head.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  }

  it('recenters seated height to the virtual standing eye height', () => {
    const { rig, head, loco } = build();
    loco.recenter();
    expect(headWorld(head).y).toBeCloseTo(1.6, 6);
    expect(rig.position.y).toBeCloseTo(0.4, 6);
  });

  it('snap turns 30 degrees clockwise about the head, once per push', () => {
    const { rig, head, loco } = build();
    rig.position.set(2, 0, 2);
    head.position.set(0.3, 1.2, 0);
    const before = headWorld(head);
    loco.update(1 / 72, { ...idle, turnX: 1 });
    loco.update(1 / 72, { ...idle, turnX: 1 });
    const after = headWorld(head);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.z).toBeCloseTo(before.z, 6);
    expect(yawFromMatrix(head.matrixWorld.elements)).toBeCloseTo(30, 4);
  });

  it('walks where the head faces and stops at a wall', () => {
    const { rig, head, loco } = build({ turnMode: 'smooth' });
    rig.position.set(0, 0, 3);
    for (let i = 0; i < 72 * 6; i++) loco.update(1 / 72, { ...idle, moveY: 1 });
    // Facing north from z 3, the pillar's south face (0.6) plus the radius stops the head at 0.85.
    expect(headWorld(head).z).toBeCloseTo(0.85, 1);
    expect(headWorld(head).x).toBeCloseTo(0, 3);
    expect(loco.vignetteStrength).toBe(0);
  });

  it('raises the vignette while moving and fades it after the stick is released', () => {
    const { rig, loco } = build();
    rig.position.set(2, 0, 2);
    for (let i = 0; i < 20; i++) loco.update(1 / 72, { ...idle, moveY: 1 });
    expect(loco.vignetteStrength).toBeGreaterThan(0.3);
    for (let i = 0; i < 72; i++) loco.update(1 / 72, idle);
    expect(loco.vignetteStrength).toBe(0);
  });

  it('teleports on release of a valid aim and stays put on an invalid one', () => {
    const { rig, head, loco } = build({ teleport: true });
    rig.position.set(2, 0, 2);
    const a = (20 * Math.PI) / 180;
    const aim = { origin: [2, 1.2, 2] as Vec3, direction: [-Math.cos(a), Math.sin(a), 0] as Vec3 };
    loco.update(1 / 72, { ...idle, teleportAim: aim });
    expect(loco.teleportPreview?.valid).toBe(true);
    const landing = loco.teleportPreview?.landing as Vec3;
    loco.update(1 / 72, idle);
    expect(headWorld(head).x).toBeCloseTo(landing[0], 6);
    expect(headWorld(head).z).toBeCloseTo(landing[2], 6);
    expect(loco.teleportPreview).toBeNull();

    const wall = { origin: [0, 1.2, 2] as Vec3, direction: [0, 0.1, 1] as Vec3 };
    const startX = headWorld(head).x;
    loco.update(1 / 72, { ...idle, teleportAim: wall });
    expect(loco.teleportPreview?.valid).toBe(false);
    loco.update(1 / 72, idle);
    expect(headWorld(head).x).toBeCloseTo(startX, 6);
  });
});
