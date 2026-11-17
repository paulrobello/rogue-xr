// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DICE } from '../src/content/dice.ts';
import { Stream } from '../src/core/rng.ts';
import {
  CONTACT_TOLERANCE,
  correctionPoseAt,
  correctionRotation,
  D6_HALF_EXTENT,
  type DieKind,
  dieVertices,
  faceNormals,
  lowestPoint,
  planCorrection,
  upFace,
} from '../src/dice/faces.ts';
import {
  type Quat,
  quatAngle,
  quatFromUnitVectors,
  quatMul,
  quatNormalize,
  rotateVec,
  type Vec3,
} from '../src/dice/quat.ts';
import {
  CORRECTION_STEPS,
  DEFAULT_OPTIONS,
  DiceWorld,
  FIXED_STEP,
  type SettledEvent,
} from '../src/dice/world.ts';

const KINDS: readonly DieKind[] = ['d6', 'd8'];
/** A die left where physics stopped it sits within Rapier's contact slop of the floor, metres. */
const REST_SLOP = 5e-4;
const UP: Vec3 = { x: 0, y: 1, z: 0 };
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

function randomQuat(stream: Stream): Quat {
  return quatNormalize({
    x: stream.next() * 2 - 1,
    y: stream.next() * 2 - 1,
    z: stream.next() * 2 - 1,
    w: stream.next() * 2 - 1,
  });
}

interface Throw {
  position: Vec3;
  linvel: Vec3;
  angvel: Vec3;
  orientation: Quat;
  kind: DieKind;
  face: number;
}

/** A hand release over the tray: random spot, toss velocity and spin, all from the seeded stream. */
function randomThrow(stream: Stream, kind: DieKind): Throw {
  const heading = stream.next() * Math.PI * 2;
  const speed = stream.next() * 1.5;
  const spin = (): number => (stream.next() * 2 - 1) * 25;
  return {
    kind,
    position: {
      x: (stream.next() * 2 - 1) * 0.15,
      y: 0.12 + stream.next() * 0.2,
      z: (stream.next() * 2 - 1) * 0.15,
    },
    linvel: {
      x: Math.cos(heading) * speed,
      y: stream.next() * 2 - 1,
      z: Math.sin(heading) * speed,
    },
    angvel: { x: spin(), y: spin(), z: spin() },
    orientation: randomQuat(stream),
    face: stream.int(0, faceNormals(kind).length - 1),
  };
}

/** Steps `world` in frames of `dtFrame` until every die is done, failing if it never gets there. */
function runToDone(world: DiceWorld, dtFrame: number): void {
  for (let frame = 0; frame < 2000 && !world.allDone; frame++) world.step(dtFrame);
  expect(world.allDone).toBe(true);
}

describe('face tables', () => {
  it.each(KINDS)('%s normals are unit length, distinct and match the content die', (kind) => {
    const normals = faceNormals(kind);
    const die = kind === 'd6' ? DICE['brass-d6'] : DICE['glass-d8'];
    expect(normals).toHaveLength(die.faces.length);
    for (const normal of normals)
      expect(Math.hypot(normal.x, normal.y, normal.z)).toBeCloseTo(1, 12);
    for (let i = 0; i < normals.length; i++) {
      for (let j = i + 1; j < normals.length; j++) {
        expect(dot(normals[i] as Vec3, normals[j] as Vec3)).toBeLessThan(0.999);
      }
    }
  });

  it.each(KINDS)('%s opposite faces are antipodal and their values sum to a constant', (kind) => {
    const normals = faceNormals(kind);
    const die = kind === 'd6' ? DICE['brass-d6'] : DICE['glass-d8'];
    const last = normals.length - 1;
    for (let i = 0; i < normals.length; i++) {
      expect(dot(normals[i] as Vec3, normals[last - i] as Vec3)).toBeCloseTo(-1, 12);
      expect((die.faces[i] as number) + (die.faces[last - i] as number)).toBe(normals.length + 1);
    }
  });

  it.each(KINDS)('%s normals are the facets of the collider hull', (kind) => {
    // A true face normal has 4 (cube) or 3 (octahedron) hull vertices on its plane.
    const vertices = dieVertices(kind);
    const onPlane = kind === 'd6' ? 4 : 3;
    for (const normal of faceNormals(kind)) {
      const heights = vertices.map((v) => dot(v, normal));
      const top = Math.max(...heights);
      expect(heights.filter((h) => top - h < 1e-9)).toHaveLength(onPlane);
    }
  });
});

describe('upFace and correctionRotation', () => {
  it.each(KINDS)('%s upFace finds each face when it is turned up', (kind) => {
    const normals = faceNormals(kind);
    for (let i = 0; i < normals.length; i++) {
      const q = quatFromUnitVectors(normals[i] as Vec3, UP);
      expect(upFace(q, normals)).toBe(i);
    }
  });

  it.each(KINDS)('%s correction turns the target face up by the shortest arc', (kind) => {
    const normals = faceNormals(kind);
    const stream = Stream.fromKey(`correction-${kind}`);
    for (let n = 0; n < 200; n++) {
      const q = randomQuat(stream);
      const target = stream.int(0, normals.length - 1);
      const delta = correctionRotation(q, normals, target);
      const turned = quatMul(delta, q);
      expect(upFace(turned, normals)).toBe(target);
      const up = rotateVec(turned, normals[target] as Vec3);
      expect(up.y).toBeCloseTo(1, 9);
      const before = rotateVec(q, normals[target] as Vec3);
      expect(quatAngle({ x: 0, y: 0, z: 0, w: 1 }, delta)).toBeCloseTo(
        Math.acos(Math.min(1, before.y)),
        6,
      );
    }
  });

  it('handles a face that is exactly face down', () => {
    const normals = faceNormals('d6');
    const delta = correctionRotation({ x: 0, y: 0, z: 0, w: 1 }, normals, 5);
    expect(rotateVec(delta, normals[5] as Vec3).y).toBeCloseTo(1, 12);
    expect(Math.abs(delta.y)).toBeLessThan(1e-12);
  });

  it('does nothing to a die already showing the target', () => {
    const delta = correctionRotation({ x: 0, y: 0, z: 0, w: 1 }, faceNormals('d6'), 0);
    expect(quatAngle({ x: 0, y: 0, z: 0, w: 1 }, delta)).toBeCloseTo(0, 12);
  });
});

describe('planCorrection', () => {
  it.each(KINDS)('%s never sinks, ends flat on the surface and stays inside the tray', (kind) => {
    const stream = Stream.fromKey(`plan-${kind}`);
    const inner = { halfX: 0.3, halfZ: 0.3 };
    for (let n = 0; n < 100; n++) {
      const start = {
        position: {
          x: (stream.next() * 2 - 1) * 0.29,
          y: 0.02 + stream.next() * 0.01,
          z: (stream.next() * 2 - 1) * 0.29,
        },
        quaternion: randomQuat(stream),
      };
      const target = stream.int(0, faceNormals(kind).length - 1);
      const plan = planCorrection(start, kind, target, 0, inner);
      for (let k = 0; k <= 12; k++) {
        const pose = correctionPoseAt(plan, k / 12);
        expect(lowestPoint(plan.vertices, pose).y).toBeGreaterThan(-1e-9);
      }
      const end = correctionPoseAt(plan, 1);
      expect(upFace(end.quaternion, faceNormals(kind))).toBe(target);
      expect(lowestPoint(plan.vertices, end).y).toBeCloseTo(0, 9);
      expect(Math.abs(end.position.x)).toBeLessThanOrEqual(0.3 + 1e-9);
      expect(Math.abs(end.position.z)).toBeLessThanOrEqual(0.3 + 1e-9);
      // The finished die rests on a face, so the whole face is within contact tolerance of the surface.
      const touching = plan.vertices.filter((v) => {
        const r = rotateVec(end.quaternion, v);
        return r.y + end.position.y < CONTACT_TOLERANCE;
      });
      expect(touching.length).toBe(kind === 'd6' ? 4 : 3);
    }
  });

  it('turns about the contact point: a die tipped on an edge keeps that edge on the table', () => {
    // A cube resting on its -Y face, target the +X face: the pivot is the face centre and the die tips over.
    const start = {
      position: { x: 0.1, y: D6_HALF_EXTENT, z: -0.05 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
    };
    const plan = planCorrection(start, 'd6', 1, 0, { halfX: 0.3, halfZ: 0.3 });
    expect(plan.pivot.x).toBeCloseTo(0.1, 9);
    expect(plan.pivot.z).toBeCloseTo(-0.05, 9);
    expect(plan.pivot.y).toBeCloseTo(0, 9);
    const end = correctionPoseAt(plan, 1);
    expect(end.position.y).toBeCloseTo(D6_HALF_EXTENT, 9);
  });
});

describe('DiceWorld', () => {
  it('lands 500 seeded throws on the RNG face, resting on the table with no fallback', async () => {
    const world = await DiceWorld.create();
    const stream = Stream.fromKey('dice-physics-500');
    const events: SettledEvent[] = [];
    world.onSettled((event) => events.push(event));
    const started = performance.now();
    let forced = 0;
    let worstCorrectionMs = 0;
    let worstRollMs = 0;
    let totalRollMs = 0;
    let faceMismatches = 0;
    let outOfTray = 0;
    let fallbacks = 0;
    let worstSink = 0;

    for (let n = 0; n < 500; n++) {
      const kind = KINDS[n % 2] as DieKind;
      const t = randomThrow(stream, kind);
      events.length = 0;
      world.throwDie('die', kind, t.position, t.linvel, t.angvel, t.face, t.orientation);
      runToDone(world, 1 / 60);
      expect(events).toHaveLength(1);
      const event = events[0] as SettledEvent;
      const pose = world.pose('die');
      if (event.face !== t.face || upFace(pose?.quaternion as Quat, faceNormals(kind)) !== t.face)
        faceMismatches++;
      if (event.forced) forced++;
      if (event.fallback) fallbacks++;
      worstCorrectionMs = Math.max(worstCorrectionMs, event.correctionMs);
      worstRollMs = Math.max(worstRollMs, event.rollMs);
      totalRollMs += event.rollMs;
      const p = event.pose.position;
      const limit = DEFAULT_OPTIONS.halfX;
      const sink = Math.abs(p.y - lowestRestHeight(kind, event));
      worstSink = Math.max(worstSink, sink);
      if (Math.abs(p.x) > limit || Math.abs(p.z) > limit || sink > REST_SLOP) {
        outOfTray++;
      }
    }

    const elapsed = performance.now() - started;
    console.log(
      `dice-physics: 500/500 throws, ${elapsed.toFixed(0)} ms wall, roll mean ${(totalRollMs / 500).toFixed(0)} ms ` +
        `max ${worstRollMs.toFixed(0)} ms, worst correction ${worstCorrectionMs.toFixed(2)} ms, forced ${forced}, ` +
        `fallbacks ${fallbacks}, worst floor contact ${(worstSink * 1000).toFixed(3)} mm`,
    );
    world.dispose();

    expect(faceMismatches).toBe(0);
    expect(outOfTray).toBe(0);
    expect(forced).toBe(0);
    expect(fallbacks).toBe(0);
    expect(worstCorrectionMs).toBeLessThanOrEqual(100 + FIXED_STEP * 1000);
    expect(CORRECTION_STEPS * FIXED_STEP).toBeCloseTo(0.1, 12);
  }, 60_000);

  it('reaches the same result at any frame rate', async () => {
    const t = randomThrow(Stream.fromKey('frame-rate'), 'd8');
    const results: SettledEvent[] = [];
    for (const dtFrame of [1 / 30, 1 / 72, 1 / 144, 0.0173]) {
      const world = await DiceWorld.create();
      world.onSettled((event) => results.push(event));
      world.throwDie('die', t.kind, t.position, t.linvel, t.angvel, t.face, t.orientation);
      runToDone(world, dtFrame);
      world.dispose();
    }
    expect(results).toHaveLength(4);
    const [first, ...rest] = results as [SettledEvent, ...SettledEvent[]];
    for (const other of rest) {
      expect(other.rollMs).toBe(first.rollMs);
      expect(other.pose.position.x).toBeCloseTo(first.pose.position.x, 9);
      expect(other.pose.position.z).toBeCloseTo(first.pose.position.z, 9);
      expect(quatAngle(other.pose.quaternion, first.pose.quaternion)).toBeLessThan(1e-6);
    }
  });

  it('caps catch-up steps after a long frame', async () => {
    const world = await DiceWorld.create();
    expect(world.step(5)).toBe(10);
    world.dispose();
    const fresh = await DiceWorld.create();
    expect(fresh.step(FIXED_STEP * 0.5)).toBe(0);
    expect(fresh.step(FIXED_STEP * 0.6)).toBe(1);
    fresh.dispose();
  });

  it('settles several dice thrown together on their own target faces', async () => {
    const world = await DiceWorld.create();
    const stream = Stream.fromKey('together');
    const targets = new Map<string, number>();
    const done = new Map<string, number>();
    world.onSettled((event) => done.set(event.id, event.face));
    for (let n = 0; n < 4; n++) {
      const kind = KINDS[n % 2] as DieKind;
      const t = randomThrow(stream, kind);
      targets.set(`die-${n}`, t.face);
      world.throwDie(`die-${n}`, kind, t.position, t.linvel, t.angvel, t.face, t.orientation);
    }
    runToDone(world, 1 / 72);
    world.dispose();
    expect(done).toEqual(targets);
  });

  it('forces the correction when a die has not stopped, still ending on the target face', async () => {
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
    runToDone(world, 1 / 60);
    world.dispose();
    expect(events).toHaveLength(1);
    expect(events[0]?.forced).toBe(true);
    expect(events[0]?.face).toBe(3);
    expect(events[0]?.correctionMs).toBeCloseTo(100, 6);
  });

  it('rescues a die thrown clean out of the tray and puts it back inside on its target face', async () => {
    const world = await DiceWorld.create();
    const events: SettledEvent[] = [];
    world.onSettled((event) => events.push(event));
    world.throwDie(
      'die',
      'd6',
      { x: 0, y: 0.5, z: 0 },
      { x: 6, y: 4, z: 0 },
      { x: 5, y: 0, z: 5 },
      4,
    );
    runToDone(world, 1 / 60);
    world.dispose();
    const event = events[0] as SettledEvent;
    expect(event.forced).toBe(true);
    expect(event.rollMs).toBeLessThan(2000);
    expect(event.face).toBe(4);
    expect(Math.abs(event.pose.position.x)).toBeLessThan(DEFAULT_OPTIONS.halfX);
    expect(event.pose.position.y).toBeCloseTo(D6_HALF_EXTENT, 6);
  });

  it('rejects a face the die does not have and replaces a re-thrown id', async () => {
    const world = await DiceWorld.create();
    const origin = { x: 0, y: 0.1, z: 0 };
    const still = { x: 0, y: 0, z: 0 };
    expect(() => world.throwDie('a', 'd6', origin, still, still, 6)).toThrow(RangeError);
    world.throwDie('a', 'd6', origin, still, still, 2);
    world.throwDie('a', 'd6', origin, still, still, 4);
    runToDone(world, 1 / 60);
    const pose = world.pose('a');
    expect(pose?.phase).toBe('done');
    expect(upFace(pose?.quaternion as Quat, faceNormals('d6'))).toBe(4);
    world.removeDie('a');
    expect(world.pose('a')).toBeUndefined();
    world.dispose();
  });
});

/** Height of a die's centre when it lies flat: the cube's half edge, or the octahedron's face inradius. */
function lowestRestHeight(kind: DieKind, event: SettledEvent): number {
  const vertices = dieVertices(kind);
  const lowest = lowestPoint(vertices, {
    position: { x: 0, y: 0, z: 0 },
    quaternion: event.pose.quaternion,
  });
  return -lowest.y;
}
