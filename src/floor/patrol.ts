import type { Box, Rect } from '../content/rooms.ts';
import { Stream } from '../core/rng.ts';
import { type FloorPlan, guardedConnection, type WorldRoom } from './generate.ts';

type Point = readonly [number, number];
export interface PatrolRoute {
  readonly rooms: readonly [number, number];
  readonly ends: readonly [Point, Point];
  readonly cycles: number;
}

export const PATROL_GAIT = { speed: 0.9, start: 0.5, walk: 1.2, stop: 0.7, turn: 1.2 } as const;
const { speed: PACE, start: START, walk: STRIDE, stop: STOP, turn: TURN } = PATROL_GAIT;
const PAUSE = 1.2;
const CLEARANCE = 0.45;

function inside(rect: Rect, x: number, z: number): boolean {
  return (
    x >= rect.min[0] - 0.001 &&
    x <= rect.max[0] + 0.001 &&
    z >= rect.min[1] - 0.001 &&
    z <= rect.max[1] + 0.001
  );
}

function sweepClear(
  ends: PatrolRoute['ends'],
  walkable: readonly Rect[],
  obstacles: readonly Box[],
): boolean {
  const [[x0, z0], [x1, z1]] = ends;
  const steps = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 0.1);
  for (let i = 0; i <= steps; i++) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const z = z0 + ((z1 - z0) * i) / steps;
    for (const [dx, dz] of [
      [-CLEARANCE, -CLEARANCE],
      [CLEARANCE, -CLEARANCE],
      [CLEARANCE, CLEARANCE],
      [-CLEARANCE, CLEARANCE],
    ]) {
      if (!walkable.some((rect) => inside(rect, x + dx, z + dz))) return false;
    }
    if (
      obstacles.some(
        (box) =>
          box.max[1] > 0.06 &&
          box.min[1] < 2.05 &&
          x > box.min[0] - CLEARANCE &&
          x < box.max[0] + CLEARANCE &&
          z > box.min[2] - CLEARANCE &&
          z < box.max[2] + CLEARANCE,
      )
    )
      return false;
  }
  return true;
}

/** Choose an ordinary doorway between two encounter-free rooms. Size each leg to whole gait cycles. */
export function planPatrol(
  plan: FloorPlan,
  rooms: readonly WorldRoom[],
  colliders: readonly (readonly Box[])[],
): PatrolRoute | null {
  const stream = Stream.fromKey(plan.seed + ':sentry-patrol');
  const guarded = guardedConnection(plan);
  const candidates = stream.shuffle(
    plan.connections.filter(
      (edge) =>
        edge !== guarded &&
        !edge.puzzleGate &&
        edge.every(
          ({ room }) => room !== 0 && room !== plan.guardianRoom && !plan.rooms[room]?.encounter,
        ),
    ),
  );
  for (const [a, b] of candidates) {
    const door = rooms[a.room]?.doors.find((d) => d.id === a.door);
    if (!door || door.width < 1.2) continue;
    const [cx, cz] = door.world;
    const [dx, dz] = ({ N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] } as const)[door.facing];
    const walkable = [a, b].flatMap(({ room }) => {
      const [x, z] = plan.rooms[room].position;
      return rooms[room].template.walkable.map((r) => ({
        min: [r.min[0] + x, r.min[1] + z] as Point,
        max: [r.max[0] + x, r.max[1] + z] as Point,
      }));
    });
    // Walkable rectangles are inset for teleport. Bridge only the width of this actual opening.
    const halfWidth = door.width / 2;
    const bridgeX = Math.abs(dx) * 0.65 + Math.abs(dz) * halfWidth;
    const bridgeZ = Math.abs(dz) * 0.65 + Math.abs(dx) * halfWidth;
    walkable.push({ min: [cx - bridgeX, cz - bridgeZ], max: [cx + bridgeX, cz + bridgeZ] });
    const obstacles = [...(colliders[a.room] ?? []), ...(colliders[b.room] ?? [])];
    for (const cycles of stream.shuffle([3, 4, 5, 6])) {
      const half = (PACE * ((START + STOP) / 2 + STRIDE * cycles)) / 2;
      const ends = [
        [cx - dx * half, cz - dz * half],
        [cx + dx * half, cz + dz * half],
      ] as const;
      if (sweepClear(ends, walkable, obstacles)) return { rooms: [a.room, b.room], ends, cycles };
    }
  }
  return null;
}

export type PatrolMotion = 'idle' | 'start' | 'walk' | 'stop' | 'turn-left';
export interface PatrolSample {
  readonly motion: PatrolMotion;
  readonly time: number;
  readonly speed: number;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly room: number;
}

export function patrolPeriod(route: PatrolRoute): number {
  return 2 * (START + STRIDE * route.cycles + STOP + PAUSE + 2 * TURN);
}

export function samplePatrol(route: PatrolRoute, elapsed: number): PatrolSample {
  const walk = route.cycles * STRIDE;
  const leg = patrolPeriod(route) / 2;
  const t = elapsed % (leg * 2);
  const side = t >= leg ? 1 : 0;
  const local = t - side * leg;
  const from = route.ends[side];
  const to = route.ends[1 - side];
  const yaw = Math.atan2(from[0] - to[0], from[1] - to[1]);
  const finish = START + walk + STOP;
  let motion: PatrolMotion;
  let time: number;
  let speed = 0;
  let distance = PACE * (walk + (START + STOP) / 2);
  let rotation = yaw;
  if (local < START) {
    motion = 'start';
    time = local;
    speed = (PACE * time) / START;
    distance = (speed * time) / 2;
  } else if (local < START + walk) {
    motion = 'walk';
    time = local - START;
    speed = PACE;
    distance = PACE * (START / 2 + time);
  } else if (local < finish) {
    motion = 'stop';
    time = local - START - walk;
    speed = PACE * (1 - time / STOP);
    distance = PACE * (START / 2 + walk + time * (1 - time / (2 * STOP)));
  } else if (local < finish + PAUSE) {
    motion = 'idle';
    time = local - finish;
  } else {
    motion = 'turn-left';
    const turn = local - finish - PAUSE;
    time = turn % TURN;
    const p = time / TURN;
    rotation += ((Math.floor(turn / TURN) + p * p * (3 - 2 * p)) * Math.PI) / 2;
  }
  const along = distance / (PACE * (walk + (START + STOP) / 2));
  return {
    motion,
    time,
    speed,
    yaw: rotation,
    x: from[0] + (to[0] - from[0]) * along,
    z: from[1] + (to[1] - from[1]) * along,
    room: route.rooms[along < 0.5 ? side : 1 - side],
  };
}
