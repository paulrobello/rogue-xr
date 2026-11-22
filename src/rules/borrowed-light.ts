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
export const BORROWED_REFLECTOR: Vec3 = [2.45, 1.02, -0.55];
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
const downToReflector = unit(delta(BORROWED_REFLECTOR, BORROWED_MIRRORS[1]));
const reflectorToSeal = unit(delta(BORROWED_RECEIVER, BORROWED_REFLECTOR));
const alignedNormals: readonly [Vec3, Vec3, Vec3] = [
  unit(delta(crossRoom, incoming)),
  unit(delta(downToReflector, crossRoom)),
  unit(delta(reflectorToSeal, downToReflector)),
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
  return [0, random.int(0, 3) as BorrowedLightDetent, random.int(0, 3) as BorrowedLightDetent];
}

export interface BorrowedLightTrace {
  readonly normals: readonly [Vec3, Vec3, Vec3];
  readonly points: readonly Vec3[];
  readonly reachesReceiver: boolean;
}

/** The same three-bounce trace decides the latch and draws the visible beam. */
export function traceBorrowedLight(
  seed: string,
  detents: BorrowedLightState['detents'],
): BorrowedLightTrace {
  const correct = borrowedLightTarget(seed);
  return traceBorrowedLightNormals([
    yaw(alignedNormals[0], detents[0] - correct[0]),
    yaw(alignedNormals[1], detents[1] - correct[1]),
    yaw(alignedNormals[2], detents[2] - correct[2]),
  ]);
}

export function traceBorrowedLightNormals(
  normals: BorrowedLightTrace['normals'],
  installed = true,
): BorrowedLightTrace {
  let origin = BORROWED_MIRRORS[0];
  let direction = reflect(incoming, normals[0]);
  const points = [BORROWED_SKY, origin];
  const nextMirrors = installed ? ([1, 2] as const) : ([1] as const);
  for (const index of nextMirrors) {
    const mirror = index === 1 ? BORROWED_MIRRORS[1] : BORROWED_REFLECTOR;
    const limit = stop(origin, direction);
    const incidence = dot(direction, normals[index]);
    const t =
      Math.abs(incidence) < EPS ? -1 : dot(delta(mirror, origin), normals[index]) / incidence;
    const bounce = add(origin, direction, t);
    if (t <= EPS || t >= limit || length(delta(bounce, mirror)) > BORROWED_MIRROR_RADIUS) {
      points.push(add(origin, direction, limit));
      return { normals, points, reachesReceiver: false };
    }
    points.push(bounce);
    origin = bounce;
    direction = reflect(direction, normals[index]);
  }
  const end = add(origin, direction, stop(origin, direction));
  points.push(end);
  return {
    normals,
    points,
    reachesReceiver: installed && length(delta(end, BORROWED_RECEIVER)) < 0.16,
  };
}

function next(detent: BorrowedLightDetent): BorrowedLightDetent {
  return ((detent + 1) % 4) as BorrowedLightDetent;
}

export function readBorrowedLight(run: {
  readonly seed: string;
  readonly borrowedLight?: BorrowedLightState;
}): BorrowedLightState {
  if (run.borrowedLight)
    return {
      detents: [
        run.borrowedLight.detents[0],
        run.borrowedLight.detents[1],
        run.borrowedLight.detents[2] ?? 0,
      ],
      reflector: run.borrowedLight.reflector ?? run.borrowedLight.open ?? false,
      reflectorFound:
        run.borrowedLight.reflectorFound ??
        run.borrowedLight.reflector ??
        run.borrowedLight.open ??
        false,
      open: run.borrowedLight.open,
    };
  const [, b, c] = borrowedLightTarget(run.seed);
  const random = Stream.fromKey(`${run.seed}:borrowed-light-start`);
  let left = random.int(0, 3) as BorrowedLightDetent;
  const right = random.int(0, 3) as BorrowedLightDetent;
  const third = random.int(0, 3) as BorrowedLightDetent;
  if (left === 0) left = 1;
  let detents: BorrowedLightState['detents'] = [left, right, third];
  if (detents[1] === b && detents[2] === c) detents = [left, right, next(third)];
  return { detents, reflectorFound: false, reflector: false, open: false };
}

export function operateBorrowedLight(
  seed: string,
  state: BorrowedLightState,
  control: BorrowedLightControl,
): BorrowedLightState {
  if (state.open) return state;
  const [a, b, c] = state.detents;
  if (control === 'reset') {
    const initial = readBorrowedLight({ seed });
    return initial.detents.every((value, i) => value === state.detents[i]) &&
      state.reflector === initial.reflector &&
      state.reflectorFound === initial.reflectorFound &&
      state.open === initial.open
      ? state
      : initial;
  }
  if (control === 'take-reflector')
    return state.reflectorFound ? state : { ...state, reflectorFound: true };
  if (control === 'install')
    return !state.reflectorFound || state.reflector
      ? state
      : {
          ...state,
          reflector: true,
          open: traceBorrowedLight(seed, state.detents).reachesReceiver,
        };
  if (control === 2 && !state.reflector) return state;
  const detents: BorrowedLightState['detents'] =
    control === 0 ? [next(a), b, c] : control === 1 ? [a, next(b), c] : [a, b, next(c)];
  if (detents.every((value, i) => value === state.detents[i])) return state;
  return {
    ...state,
    detents,
    open:
      state.open || (state.reflector === true && traceBorrowedLight(seed, detents).reachesReceiver),
  };
}
