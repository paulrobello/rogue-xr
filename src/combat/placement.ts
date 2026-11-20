/**
 * Combat table and enemy placement. Pure functions over plain numbers, no three.js.
 *
 * Headings are degrees, 0 faces north (-Z) and increasing clockwise seen from above, matching
 * `locomotion.ts` and `Socket.yaw`. A heading h points along `(sin h, -cos h)` on the floor
 * plane and its right-hand side is `(cos h, sin h)`. Everything here is in world space; use
 * `combatRoom` to lift a `WorldRoom` (whose template is room-local) into world space.
 *
 * Table strategy (`tableCandidates`): the ideal spot is `distance` metres straight ahead of the
 * seated player. If the table's footprint, inflated by `margin`, leaves the walkable area or hits a
 * collider, the search tries, in order: a shorter distance (down to `comfortDistance`) at the same
 * heading, then the same distances at headings rotated by +-`offsetStepDeg`, +-2 steps, and so
 * on up to `maxOffsetDeg`. Only when no heading fits at a comfortable distance does a second pass
 * walk the closer distances (below `comfortDistance`, down to `minDistance`) in the same heading
 * order, so a cramped room still gets its fight. The table always faces the player: its heading is
 * the heading from the player to the table centre, and its near edge is the side the player sits on.
 *
 * Enemy strategy (`placeEnemies`): slots lie on an arc around the table centre at a distance
 * `D`, spread laterally by `spacing`. Each enemy takes the first candidate from the ladder
 * `spreadScale 1, .75, .5, .25` x `D = preferred, then toward minDistance, then toward
 * maxDistance` that sits inside a walkable rect, clear of every collider and clear of the
 * enemies already placed. An enemy no candidate fits is reported in `failed`, never forced into
 * a wall. `planEncounter` walks the table candidates until the enemies fit too.
 */
import type { Box, Rect } from '../content/rooms.ts';
import type { WorldRoom } from '../floor/generate.ts';
import { rotateAboutPivot } from '../xr/locomotion.ts';

const DEG = Math.PI / 180;
const EPS = 1e-9;

export type Vec2 = readonly [number, number];

/** A room in world space: what placement tests against. */
export interface CombatRoom {
  footprint: Rect;
  walkable: readonly Rect[];
  colliders: readonly Box[];
}

export interface PlayerPose {
  x: number;
  z: number;
  /** Heading in degrees the seated player faces. */
  yaw: number;
  /** Head height above the floor, metres. Defaults to the virtual standing eye height. */
  eyeHeight?: number;
}

export interface TablePose {
  /** Table centre on the floor plane. */
  x: number;
  z: number;
  /** Heading of the table's forward axis, from the player toward the enemies, degrees. */
  yaw: number;
  /** Height of the table top above the floor, metres. */
  height: number;
}

export interface EnemyPlacement {
  x: number;
  z: number;
  /** Heading the enemy faces (toward the player), degrees. */
  yaw: number;
  /** Euclidean distance from the table centre. */
  distance: number;
  /** Position along the table's forward axis and to its right, from the table centre. */
  forward: number;
  lateral: number;
}

/** Unfolded table footprint half extents: 1.5 m wide (centre plus two leaves) by 0.8 m deep. */
export const TABLE_HALF_WIDTH = 0.75;
export const TABLE_HALF_DEPTH = 0.4;

/**
 * Player-to-table-centre distance on the floor plane, metres: the ideal, the closest comfortable
 * fallback, and the last resort for a cramped room. The table top sits `WAIST_DROP` (0.75 m) below
 * the eye, so the view down to a point `d` ahead is atan(0.75 / d) below level.
 *
 * At 1.1 m the centre is 34 degrees down, the near edge (0.4 m before the centre) 47, the table
 * asset's dice tray (0.18 m toward the seat) 39 and the buttons (0.28 m toward the seat, 0.55 m
 * aside) 37. At the 0.95 m comfortable fallback the centre is 38 degrees down and the near edge 54;
 * only a cramped room, below that, trades more angle for fit. The 2026-11-16 Quest playtests found
 * the 0.85 m table (centre 41, near edge 59, tray 48 degrees) too steep and the 1.2 m one (centre
 * 32, near edge 43) too far.
 *
 * Every control reached through the table works by controller ray (buttons, tray, sigil plate) or
 * by a flick across it; only a slow card drop needs a hand over the footprint, whose 0.3 m drop
 * margin starts 0.4 m ahead of the eye, inside a seated arm's reach.
 */
export const DEFAULT_TABLE_DISTANCE = 1.1;
/**
 * Table distances the settings offer, nearest first, in 0.1 m steps around the default. A farther
 * choice still falls back toward `COMFORT_TABLE_DISTANCE` (then closer) when it does not fit.
 */
export const TABLE_DISTANCE_CHOICES: readonly number[] = [0.9, 1.0, 1.1, 1.2, 1.3];
export const COMFORT_TABLE_DISTANCE = 0.95;
export const MIN_TABLE_DISTANCE = 0.5;

export const DEFAULT_EYE_HEIGHT = 1.6;
/** Table-top height is the eye height minus this drop, clamped, which lands near a seated waist. */
export const WAIST_DROP = 0.75;
export const MIN_TABLE_HEIGHT = 0.6;
export const MAX_TABLE_HEIGHT = 1.1;

export interface TableOptions {
  /** Ideal player-to-table-centre distance, metres. */
  distance?: number;
  /** Shortest distance the first pass, over every heading, tries before any closer one. */
  comfortDistance?: number;
  /** Shortest distance the search may fall back to. */
  minDistance?: number;
  distanceStep?: number;
  offsetStepDeg?: number;
  maxOffsetDeg?: number;
  /** Clearance kept between the table footprint and any wall or walkable edge. */
  margin?: number;
  eyeHeight?: number;
  waistDrop?: number;
}

export interface TablePlacement {
  pose: TablePose;
  /** Heading offset from the player's facing that this candidate needed, degrees. */
  offsetDeg: number;
  /** Player-to-table-centre distance, metres. */
  distance: number;
}

export type PlaceTableResult = ({ ok: true } & TablePlacement) | { ok: false; reason: string };

export interface EnemyOptions {
  /** Where the player sits, so enemies face them. Defaults to `tableDistance` behind the table on its axis. */
  player?: Vec2;
  /** Player-to-table-centre distance the default `player` sits at. Defaults to `DEFAULT_TABLE_DISTANCE`. */
  tableDistance?: number;
  /** Clear radius around each enemy. */
  radius?: number;
  clearApproach?: (x: number, z: number) => boolean;
  preferred?: number;
  minDistance?: number;
  maxDistance?: number;
  /** Lateral gap between neighbouring enemy centres at full spread. */
  spacing?: number;
  /** Closest two enemy centres may be. */
  separation?: number;
  /** Extra clearance from colliders and walkable edges beyond `radius`. */
  margin?: number;
}

export type PlaceEnemiesResult =
  | { ok: true; placements: EnemyPlacement[]; failed: [] }
  | { ok: false; placements: (EnemyPlacement | null)[]; failed: number[] };

export type PlanEncounterResult =
  | { ok: true; table: TablePlacement; enemies: EnemyPlacement[] }
  | { ok: false; reason: string };

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Normalises a heading into [0, 360). */
export function wrapHeading(degrees: number): number {
  const w = ((degrees % 360) + 360) % 360;
  return w >= 360 ? 0 : w;
}

/** Unit forward vector of a heading on the floor plane. */
export function forwardOf(yawDeg: number): Vec2 {
  const a = yawDeg * DEG;
  return [Math.sin(a), -Math.cos(a)];
}

/** Unit right-hand vector of a heading (clockwise from forward, seen from above). */
export function rightOf(yawDeg: number): Vec2 {
  const a = yawDeg * DEG;
  return [Math.cos(a), Math.sin(a)];
}

/** Heading from `from` to `to`; 0 when they coincide. */
export function headingTo(from: Vec2, to: Vec2): number {
  const dx = to[0] - from[0];
  const dz = to[1] - from[1];
  if (Math.hypot(dx, dz) < EPS) return 0;
  return wrapHeading(Math.atan2(dx, -dz) / DEG);
}

/** Smallest absolute angle between two headings, degrees in [0, 180]. */
export function headingDelta(a: number, b: number): number {
  const d = Math.abs(wrapHeading(a) - wrapHeading(b));
  return d > 180 ? 360 - d : d;
}

/** Lifts a room-local, rotated `WorldRoom` template into world-space walkable rects and colliders. */
export function combatRoom(room: WorldRoom): CombatRoom {
  const ox = room.footprint.min[0] - room.template.footprint.min[0];
  const oz = room.footprint.min[1] - room.template.footprint.min[1];
  const shiftRect = (r: Rect): Rect => ({
    min: [r.min[0] + ox, r.min[1] + oz],
    max: [r.max[0] + ox, r.max[1] + oz],
  });
  return {
    footprint: room.footprint,
    walkable: room.template.walkable.map(shiftRect),
    colliders: room.template.colliders.map((b) => ({
      min: [b.min[0] + ox, b.min[1], b.min[2] + oz],
      max: [b.max[0] + ox, b.max[1], b.max[2] + oz],
    })),
  };
}

/** Table-top height for a head height: eye height minus `waistDrop`, clamped to a sane range. */
export function tableHeightFor(eyeHeight = DEFAULT_EYE_HEIGHT, waistDrop = WAIST_DROP): number {
  const h = Number.isFinite(eyeHeight) ? eyeHeight : DEFAULT_EYE_HEIGHT;
  return clamp(h - waistDrop, MIN_TABLE_HEIGHT, MAX_TABLE_HEIGHT);
}

function insideAnyRect(rects: readonly Rect[], x: number, z: number): boolean {
  return rects.some((r) => x >= r.min[0] && x <= r.max[0] && z >= r.min[1] && z <= r.max[1]);
}

/** Boxes that matter below a height: they reach above the floor and start under `top`. */
function blockingBoxes(boxes: readonly Box[], top: number): Box[] {
  return boxes.filter((b) => b.max[1] > 0.05 && b.min[1] < top);
}

/** Separating-axis test between an oriented floor rectangle and an axis-aligned box. */
function obbOverlapsBox(
  cx: number,
  cz: number,
  yawDeg: number,
  hw: number,
  hd: number,
  b: Box,
): boolean {
  const [fx, fz] = forwardOf(yawDeg);
  const [ux, uz] = rightOf(yawDeg);
  const dx = (b.min[0] + b.max[0]) / 2 - cx;
  const dz = (b.min[2] + b.max[2]) / 2 - cz;
  const hx = (b.max[0] - b.min[0]) / 2;
  const hz = (b.max[2] - b.min[2]) / 2;
  if (Math.abs(dx) > hw * Math.abs(ux) + hd * Math.abs(fx) + hx) return false;
  if (Math.abs(dz) > hw * Math.abs(uz) + hd * Math.abs(fz) + hz) return false;
  if (Math.abs(dx * ux + dz * uz) > hw + hx * Math.abs(ux) + hz * Math.abs(uz)) return false;
  if (Math.abs(dx * fx + dz * fz) > hd + hx * Math.abs(fx) + hz * Math.abs(fz)) return false;
  return true;
}

/** True when the inflated table rectangle sits inside walkable space and touches no collider. */
export function tableFootprintClear(pose: TablePose, room: CombatRoom, margin = 0.1): boolean {
  const hw = TABLE_HALF_WIDTH + margin;
  const hd = TABLE_HALF_DEPTH + margin;
  const [fx, fz] = forwardOf(pose.yaw);
  const [ux, uz] = rightOf(pose.yaw);
  for (const sx of [-1, 0, 1]) {
    for (const sf of [-1, 0, 1]) {
      const x = pose.x + ux * hw * sx + fx * hd * sf;
      const z = pose.z + uz * hw * sx + fz * hd * sf;
      if (!insideAnyRect(room.walkable, x, z)) return false;
    }
  }
  return !blockingBoxes(room.colliders, pose.height + 0.05).some((b) =>
    obbOverlapsBox(pose.x, pose.z, pose.yaw, hw, hd, b),
  );
}

function offsets(step: number, max: number): number[] {
  const out = [0];
  for (let k = 1; k * step <= max + EPS; k++) {
    out.push(k * step);
    if (k * step < 180 - EPS) out.push(-k * step);
  }
  return out;
}

/** Every clear table placement, best first (see the module comment for the order). */
export function tableCandidates(
  player: PlayerPose,
  room: CombatRoom,
  opts: TableOptions = {},
): TablePlacement[] {
  const distance = opts.distance ?? DEFAULT_TABLE_DISTANCE;
  const minDistance = Math.min(opts.minDistance ?? MIN_TABLE_DISTANCE, distance);
  const comfort = clamp(opts.comfortDistance ?? COMFORT_TABLE_DISTANCE, minDistance, distance);
  const step = Math.max(opts.distanceStep ?? 0.05, 0.01);
  const margin = opts.margin ?? 0.1;
  const height = tableHeightFor(opts.eyeHeight ?? player.eyeHeight, opts.waistDrop);
  const near: number[] = [];
  const close: number[] = [];
  for (let d = distance; d >= minDistance - EPS; d -= step) {
    (d >= comfort - EPS ? near : close).push(d);
  }
  const headings = offsets(opts.offsetStepDeg ?? 15, opts.maxOffsetDeg ?? 180);
  const out: TablePlacement[] = [];
  for (const distances of [near, close]) {
    for (const offsetDeg of headings) {
      const yaw = wrapHeading(player.yaw + offsetDeg);
      const [fx, fz] = forwardOf(yaw);
      for (const d of distances) {
        const pose: TablePose = { x: player.x + fx * d, z: player.z + fz * d, yaw, height };
        if (tableFootprintClear(pose, room, margin)) out.push({ pose, offsetDeg, distance: d });
      }
    }
  }
  return out;
}

/** The best clear table placement, or an explicit failure when no candidate fits. */
export function placeTable(
  player: PlayerPose,
  room: CombatRoom,
  opts: TableOptions = {},
): PlaceTableResult {
  const best = tableCandidates(player, room, opts)[0];
  if (!best) return { ok: false, reason: 'no table placement is clear of walls and colliders' };
  return { ok: true, ...best };
}

function circleClear(room: CombatRoom, x: number, z: number, r: number): boolean {
  const fitsRect = room.walkable.some(
    (w) => x - r >= w.min[0] && x + r <= w.max[0] && z - r >= w.min[1] && z + r <= w.max[1],
  );
  if (!fitsRect) return false;
  for (const b of blockingBoxes(room.colliders, 1.8)) {
    const dx = x - clamp(x, b.min[0], b.max[0]);
    const dz = z - clamp(z, b.min[2], b.max[2]);
    if (dx * dx + dz * dz < r * r) return false;
  }
  return true;
}

function distanceLadder(preferred: number, min: number, max: number): number[] {
  const out: number[] = [preferred];
  for (let d = preferred - 0.25; d >= min - EPS; d -= 0.25) out.push(d);
  for (let d = preferred + 0.25; d <= max + EPS; d += 0.25) out.push(d);
  return out;
}

const SPREAD_SCALES = [1, 0.75, 0.5, 0.25] as const;

/**
 * Places `count` enemies 2 to 3 m beyond the table centre along its forward axis, spread
 * laterally, each facing the player. Enemies are numbered left to right as the player sees them.
 */
export function placeEnemies(
  table: TablePose,
  count: number,
  room: CombatRoom,
  opts: EnemyOptions = {},
): PlaceEnemiesResult {
  const radius = opts.radius ?? 0.5;
  const margin = opts.margin ?? 0.1;
  const min = opts.minDistance ?? 2;
  const max = opts.maxDistance ?? 3;
  const preferred = clamp(opts.preferred ?? 2.5, min, max);
  const spacing = opts.spacing ?? 1.2;
  const separation = opts.separation ?? Math.max(0.9, radius * 2);
  const [fx, fz] = forwardOf(table.yaw);
  const [ux, uz] = rightOf(table.yaw);
  const seat = opts.tableDistance ?? DEFAULT_TABLE_DISTANCE;
  const player: Vec2 = opts.player ?? [table.x - fx * seat, table.z - fz * seat];
  const ladder = distanceLadder(preferred, min, max);
  const placements: (EnemyPlacement | null)[] = [];
  const failed: number[] = [];
  for (let i = 0; i < count; i++) {
    const slot = (i - (count - 1) / 2) * spacing;
    let found: EnemyPlacement | null = null;
    search: for (const scale of SPREAD_SCALES) {
      const lateral = slot * scale;
      for (const d of ladder) {
        if (Math.abs(lateral) >= d) continue;
        const forward = Math.sqrt(d * d - lateral * lateral);
        const x = table.x + fx * forward + ux * lateral;
        const z = table.z + fz * forward + uz * lateral;
        if (!circleClear(room, x, z, radius + margin) || opts.clearApproach?.(x, z) === false)
          continue;
        const crowded = placements.some(
          (p) => p !== null && Math.hypot(p.x - x, p.z - z) < separation,
        );
        if (crowded) continue;
        found = { x, z, yaw: headingTo([x, z], player), distance: d, forward, lateral };
        break search;
      }
    }
    placements.push(found);
    if (!found) failed.push(i);
  }
  if (failed.length === 0) {
    return { ok: true, placements: placements as EnemyPlacement[], failed: [] };
  }
  return { ok: false, placements, failed };
}

/** A rig move on the floor plane: the new rig position and the change to its `rotation.y`, radians. */
export interface RigTurn {
  x: number;
  z: number;
  rotationY: number;
}

/**
 * The snap that turns a seated view `degrees` clockwise (seen from above) about the head, the way
 * `Locomotion` snap-turns: the head stays where it is and its heading gains `degrees`. Turning by a
 * table placement's `offsetDeg` leaves the player facing the table. The rig must have no parent
 * transform.
 */
export function rigTurnAboutHead(rig: Vec2, head: Vec2, degrees: number): RigTurn {
  const [x, z] = rotateAboutPivot(rig, head, degrees);
  return { x, z, rotationY: -degrees * DEG };
}

/**
 * Finds a table and enemy layout that both fit: walks the clear table candidates and returns the
 * first whose enemies all place. Fails explicitly when none do.
 */
export function planEncounter(
  player: PlayerPose,
  count: number,
  room: CombatRoom,
  opts: { table?: TableOptions; enemies?: EnemyOptions } = {},
): PlanEncounterResult {
  const candidates = tableCandidates(player, room, opts.table);
  if (candidates.length === 0) {
    return { ok: false, reason: 'no table placement is clear of walls and colliders' };
  }
  for (const table of candidates) {
    const enemies = placeEnemies(table.pose, count, room, {
      ...opts.enemies,
      player: [player.x, player.z],
    });
    if (enemies.ok) return { ok: true, table, enemies: enemies.placements };
  }
  return { ok: false, reason: 'no table placement leaves room for every enemy 2 to 3 m beyond it' };
}
