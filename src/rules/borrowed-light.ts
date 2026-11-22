import { Stream } from '../core/rng.ts';
import type { BorrowedLightControl, BorrowedLightDetent, BorrowedLightState } from './types.ts';

export type { BorrowedLightControl, BorrowedLightDetent, BorrowedLightState } from './types.ts';

type Vec3 = readonly [number, number, number];
type Box = { readonly min: Vec3; readonly max: Vec3 };

export const BORROWED_SKY: Vec3 = [-1, 3.98, 1];
export const BORROWED_MIRRORS: readonly [Vec3, Vec3] = [
  [-1, 1.38, 1],
  [2.45, 1.26, 1],
];
export const BORROWED_RECEIVER: Vec3 = [2.45, 0.012, -1.6];
export const BORROWED_SCREEN: Box = { min: [-0.26, 0, -0.56], max: [1.44, 1.55, -0.28] };
export const BORROWED_MIRROR_RADIUS = 0.26;

const EPS = 1e-6;
const ROOM_MIN: Vec3 = [-4.86, BORROWED_RECEIVER[1], -4.86];
const ROOM_MAX: Vec3 = [4.86, 3.96, 4.86];

const delta = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vec3): number => Math.sqrt(dot(a, a));
const add = (p: Vec3, d: Vec3, t: number): Vec3 => [
  p[0] + d[0] * t,
  p[1] + d[1] * t,
  p[2] + d[2] * t,
];

function unit(v: Vec3): Vec3 {
  const scale = 1 / length(v);
  return [v[0] * scale, v[1] * scale, v[2] * scale];
}

const incoming = unit(delta(BORROWED_MIRRORS[0], BORROWED_SKY));
const crossRoom = unit(delta(BORROWED_MIRRORS[1], BORROWED_MIRRORS[0]));
const downToSeal = unit(delta(BORROWED_RECEIVER, BORROWED_MIRRORS[1]));
const alignedNormals: readonly [Vec3, Vec3] = [
  unit(delta(crossRoom, incoming)),
  unit(delta(downToSeal, crossRoom)),
];

function yaw([x, y, z]: Vec3, turns: number): Vec3 {
  const angle = (turns * Math.PI) / 2;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + z * s, y, z * c - x * s];
}

function reflect(direction: Vec3, normal: Vec3): Vec3 {
  return add(direction, normal, -2 * dot(direction, normal));
}

function screenHit(origin: Vec3, direction: Vec3): number {
  let enter = 0;
  let exit = Number.POSITIVE_INFINITY;
  for (const i of [0, 1, 2] as const) {
    const min = BORROWED_SCREEN.min[i] - origin[i];
    const max = BORROWED_SCREEN.max[i] - origin[i];
    const along = direction[i];
    if (Math.abs(along) < EPS) {
      if (min > 0 || max < 0) return Number.POSITIVE_INFINITY;
      continue;
    }
    enter = Math.max(enter, Math.min(min / along, max / along));
    exit = Math.min(exit, Math.max(min / along, max / along));
    if (enter > exit) return Number.POSITIVE_INFINITY;
  }
  return enter;
}

/** Distance to the first solid occluder in the instrument's local room. */
function stop(origin: Vec3, direction: Vec3): number {
  let hit = screenHit(origin, direction);
  for (const i of [0, 1, 2] as const) {
    const along = direction[i];
    if (Math.abs(along) < EPS) continue;
    const wall = along > 0 ? ROOM_MAX[i] : ROOM_MIN[i];
    hit = Math.min(hit, (wall - origin[i]) / along);
  }
  return hit;
}

export function borrowedLightTarget(seed: string): BorrowedLightState['detents'] {
  const random = Stream.fromKey(`${seed}:borrowed-light-detents`);
  return [random.int(0, 3) as BorrowedLightDetent, random.int(0, 3) as BorrowedLightDetent];
}

export interface BorrowedLightTrace {
  readonly normals: readonly [Vec3, Vec3];
  readonly points: readonly Vec3[];
  readonly reachesReceiver: boolean;
}

/** The same two-bounce trace decides the latch and draws the visible beam. */
export function traceBorrowedLight(
  seed: string,
  detents: BorrowedLightState['detents'],
): BorrowedLightTrace {
  const correct = borrowedLightTarget(seed);
  const normals: BorrowedLightTrace['normals'] = [
    yaw(alignedNormals[0], detents[0] - correct[0]),
    yaw(alignedNormals[1], detents[1] - correct[1]),
  ];
  return traceBorrowedLightNormals(normals);
}

export function traceBorrowedLightNormals(
  normals: BorrowedLightTrace['normals'],
): BorrowedLightTrace {
  const [first, second] = BORROWED_MIRRORS;
  const fromFirst = reflect(incoming, normals[0]);
  const reach = stop(first, fromFirst);
  const cosine = dot(fromFirst, normals[1]);
  const t = Math.abs(cosine) < EPS ? -1 : dot(delta(second, first), normals[1]) / cosine;
  if (t > EPS && t < reach) {
    const bounce = add(first, fromFirst, t);
    if (length(delta(bounce, second)) <= BORROWED_MIRROR_RADIUS) {
      const fromSecond = reflect(fromFirst, normals[1]);
      const end = add(bounce, fromSecond, stop(bounce, fromSecond));
      return {
        normals,
        points: [BORROWED_SKY, first, bounce, end],
        reachesReceiver: length(delta(end, BORROWED_RECEIVER)) < 0.16,
      };
    }
  }
  return {
    normals,
    points: [BORROWED_SKY, first, add(first, fromFirst, reach)],
    reachesReceiver: false,
  };
}

function next(detent: BorrowedLightDetent): BorrowedLightDetent {
  return ((detent + 1) % 4) as BorrowedLightDetent;
}

export function readBorrowedLight(run: {
  readonly seed: string;
  readonly borrowedLight?: BorrowedLightState;
}): BorrowedLightState {
  if (run.borrowedLight) return run.borrowedLight;
  const [a, b] = borrowedLightTarget(run.seed);
  const random = Stream.fromKey(`${run.seed}:borrowed-light-start`);
  const left = random.int(0, 3) as BorrowedLightDetent;
  const right = random.int(0, 3) as BorrowedLightDetent;
  const detents: BorrowedLightState['detents'] =
    left === a && right === b ? [next(left), right] : [left, right];
  return { detents, open: false };
}

export function operateBorrowedLight(
  seed: string,
  state: BorrowedLightState,
  control: BorrowedLightControl,
): BorrowedLightState {
  const [a, b] = state.detents;
  const detents: BorrowedLightState['detents'] =
    control === 'reset'
      ? readBorrowedLight({ seed }).detents
      : control === 0
        ? [next(a), b]
        : [a, next(b)];
  if (detents[0] === a && detents[1] === b) return state;
  return { detents, open: state.open || traceBorrowedLight(seed, detents).reachesReceiver };
}
