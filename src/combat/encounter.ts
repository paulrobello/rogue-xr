import * as THREE from 'three';
import type { Box, Vec3 } from '../content/rooms.ts';
import {
  type PatrolApproach,
  type PatrolApproachSample,
  planPatrolApproach,
} from '../enemies/patrol-approach.ts';
import type { FloorPlan, WorldRoom } from '../floor/generate.ts';
import { segmentBoxHit } from '../xr/locomotion.ts';
import {
  combatRoom,
  DEFAULT_TABLE_DISTANCE,
  type EnemyPlacement,
  forwardOf,
  MIN_TABLE_DISTANCE,
  type PlayerPose,
  planEncounter,
  rightOf,
  type TablePlacement,
  type TablePose,
  type Vec2,
} from './placement.ts';
import {
  buildTableGreybox,
  disposeTable,
  setTableHeight,
  setTableUnfold,
} from './table-greybox.ts';

const DEG = Math.PI / 180;
const REGULAR_RADIUS = 0.5;
const GUARDIAN_RADIUS = 0.8;
const ENCOUNTER_TRIGGER_RADIUS = 2.5;
/**
 * Clear space kept between the seated head and any automaton's horizontal extent when a fight ends.
 * An automaton whose pre-fight home is closer than its extent plus this holds its combat slot.
 */
export const HEAD_CLEARANCE = 0.3;
const EPS = 1e-9;

export type EncounterPhase = 'idle' | 'unfolding' | 'active' | 'folding';
/** How a fight ended: a win clears the room, the others send the automatons home. */
export type EncounterOutcome = 'win' | 'defeat' | 'flee';

/** The slice of `FloorWorld` the director reads. The enemy meshes and `group` are mutated, nothing else. */
export interface EncounterWorld {
  plan: FloorPlan;
  rooms: readonly WorldRoom[];
  colliders?: readonly (readonly Box[])[];
  /** Placeholder automatons per room; each carries `userData {room, tier, socketId}`. */
  enemies: ReadonlyMap<number, readonly THREE.Object3D[]>;
  current: number;
  /** Untransformed world root; the table is added here in world coordinates. */
  group: THREE.Object3D;
}

export interface EncounterConfig {
  world: EncounterWorld;
  /** Called with true when combat starts and false once the table has folded away. */
  lockLocomotion: (locked: boolean) => void;
  /** Releases rewards and doors after the room's first clear, including on save restore. */
  onCleared?: (room: number) => void;
  /** Replaces the greybox table; it must expose `leaf-left` and `leaf-right` nodes. */
  table?: THREE.Object3D;
  triggerRadius?: number;
  unfoldSeconds?: number;
  moveSeconds?: number;
  frozenTimeScale?: number;
  timeScaleRampSeconds?: number;
  /** Seconds after a failed placement or a finished fight before a trigger can fire again. */
  retryCooldown?: number;
  /** Ideal player-to-table-centre distance, metres. Defaults to `DEFAULT_TABLE_DISTANCE`. */
  tableDistance?: number;
}

export interface EncounterTrigger {
  room: number;
  enemy: THREE.Object3D;
  /** Floor-plane distance from the player to that enemy, metres. */
  distance: number;
}

export type BeginResult =
  | { ok: true; table: TablePlacement; enemies: EnemyPlacement[] }
  | { ok: false; reason: string };

interface Home {
  x: number;
  y: number;
  z: number;
  rotY: number;
}

interface Move {
  obj: THREE.Object3D;
  from: THREE.Vector3;
  to: THREE.Vector3;
  fromRotY: number;
  toRotY: number;
  approach?: PatrolApproach;
  parentYaw?: number;
}

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/**
 * How far an automaton reaches from its origin on the floor plane: the farthest corner of its world
 * bounding box, and at least its placement radius.
 */
export function enemyReach(obj: THREE.Object3D): number {
  const base = obj.userData.tier === 'guardian' ? GUARDIAN_RADIUS : REGULAR_RADIUS;
  const box = new THREE.Box3().setFromObject(obj);
  if (box.isEmpty()) return base;
  const at = obj.getWorldPosition(new THREE.Vector3());
  const dx = Math.max(Math.abs(box.min.x - at.x), Math.abs(box.max.x - at.x));
  const dz = Math.max(Math.abs(box.min.z - at.z), Math.abs(box.max.z - at.z));
  return Math.max(base, Math.hypot(dx, dz));
}

function wrapRadians(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

function clearsPlayer(from: THREE.Vector3, to: Vec3, x: number, z: number): boolean {
  return (
    segmentBoxHit([from.x, 1, from.z], to, {
      min: [x - 0.66, 0, z - 0.66],
      max: [x + 0.66, 2.05, z + 0.66],
    }) === null
  );
}

/**
 * Runs the explore to combat hand-off: trigger test, time freeze, locomotion lock, table unfold,
 * enemy placement and the reverse on combat end. It owns no clock: call `update(dt)` each frame
 * with real seconds. Consumers read `frozen` (pause enemy idle loops) and `timeScale` (multiply
 * ambient animation time, such as dust motes) and own the `GameStateMachine` transitions.
 */
export class EncounterDirector {
  readonly table: THREE.Object3D;
  private readonly world: EncounterWorld;
  private readonly lock: (locked: boolean) => void;
  private readonly onCleared: ((room: number) => void) | undefined;
  private readonly ownsTable: boolean;
  private readonly triggerRadius: number;
  private readonly unfoldSeconds: number;
  private readonly moveSeconds: number;
  private readonly frozenTimeScale: number;
  private readonly rampSeconds: number;
  private readonly retryCooldown: number;
  /**
   * Ideal player-to-table-centre distance the next fight aims for, metres (the settings' table
   * distance). Read at `begin`; a table that does not fit there falls back closer.
   */
  tableDistance: number;
  private readonly homes = new WeakMap<THREE.Object3D, Home>();
  private readonly cleared = new Set<number>();
  private phaseValue: EncounterPhase = 'idle';
  private frozenValue = false;
  private scale = 1;
  private targetScale = 1;
  private elapsed = 0;
  /** Table unfold progress, 0 folded to 1 open. */
  private open = 0;
  private cooldown = 0;
  private room = -1;
  private patrol: THREE.Object3D | null = null;
  patrolApproachPose: PatrolApproachSample | null = null;
  private pose: TablePose | null = null;
  private placedDistance: number | null = null;
  /** Where the seated player was when the fight began, on the floor plane. */
  private seat: readonly [number, number] | null = null;
  private moves: Move[] = [];
  private movesDone = true;
  private patrolTableDelay = 0;
  private patrolReturn: { foldSeconds: number; from: number } | null = null;

  constructor(config: EncounterConfig) {
    this.world = config.world;
    this.lock = config.lockLocomotion;
    this.onCleared = config.onCleared;
    this.ownsTable = !config.table;
    this.table = config.table ?? buildTableGreybox();
    this.triggerRadius = config.triggerRadius ?? ENCOUNTER_TRIGGER_RADIUS;
    this.unfoldSeconds = config.unfoldSeconds ?? 0.6;
    this.moveSeconds = config.moveSeconds ?? 0.8;
    this.frozenTimeScale = config.frozenTimeScale ?? 0.05;
    this.rampSeconds = config.timeScaleRampSeconds ?? 0.3;
    this.retryCooldown = config.retryCooldown ?? 1.5;
    this.tableDistance = config.tableDistance ?? DEFAULT_TABLE_DISTANCE;
    setTableUnfold(this.table, 0);
    this.world.group.add(this.table);
  }

  get phase(): EncounterPhase {
    return this.phaseValue;
  }

  /** True from `begin` until the table has folded away: enemy idle loops stay paused. */
  get frozen(): boolean {
    return this.frozenValue;
  }

  /** Multiplier for ambient animation time: 1 when exploring, ramps to `frozenTimeScale` in combat. */
  get timeScale(): number {
    return this.scale;
  }

  /** The room whose encounter is running, or -1. */
  get activeRoom(): number {
    return this.room;
  }

  get activePatrol(): THREE.Object3D | null {
    return this.patrol;
  }

  get patrolAtSlot(): boolean {
    return this.patrol !== null && this.movesDone && this.phaseValue === 'unfolding';
  }

  /** Where the table stands during combat, or null. */
  get tablePose(): TablePose | null {
    return this.pose;
  }

  /**
   * Player-to-table-centre distance the running fight was placed at, metres, or null. Shorter than
   * `tableDistance` when the room forced a closer table.
   */
  get seatDistance(): number | null {
    return this.pose ? this.placedDistance : null;
  }

  /** Applies the preference now if the running fight has room to move the seat along the table axis. */
  adjustTableDistance(distance: number, canMove: (delta: Vec2) => boolean): Vec2 | null {
    const { pose, seat, placedDistance } = this;
    if (!pose || !seat || placedDistance === null || this.phaseValue === 'folding') {
      this.tableDistance = distance;
      return null;
    }
    const requested = Math.max(MIN_TABLE_DISTANCE, distance);
    if (Math.abs(placedDistance - requested) < EPS) {
      this.tableDistance = distance;
      return null;
    }
    const [fx, fz] = forwardOf(pose.yaw);
    const [rx, rz] = rightOf(pose.yaw);
    const candidates: Vec2[] = [
      [pose.x - fx * requested - seat[0], pose.z - fz * requested - seat[1]],
    ];
    for (let degrees = 5; degrees <= 20; degrees += 5) {
      const radians = (degrees * Math.PI) / 180;
      for (const sign of [-1, 1]) {
        const angle = radians * sign;
        const target: Vec2 = [
          pose.x - fx * requested * Math.cos(angle) + rx * requested * Math.sin(angle),
          pose.z - fz * requested * Math.cos(angle) + rz * requested * Math.sin(angle),
        ];
        candidates.push([target[0] - seat[0], target[1] - seat[1]]);
      }
    }
    const move = this.patrol ? this.moves[0] : undefined;
    const delta = candidates.find(
      (candidate) =>
        canMove(candidate) &&
        (!move ||
          clearsPlayer(
            move.from,
            [move.to.x, 1, move.to.z],
            seat[0] + candidate[0],
            seat[1] + candidate[1],
          )),
    );
    if (!delta) return null;
    this.tableDistance = distance;
    this.seat = [seat[0] + delta[0], seat[1] + delta[1]];
    this.placedDistance = requested;
    return delta;
  }

  isCleared(room: number): boolean {
    return this.cleared.has(room);
  }

  markCleared(room: number): void {
    if (this.cleared.has(room)) return;
    this.cleared.add(room);
    for (const enemy of this.liveEnemies(room)) enemy.removeFromParent();
    this.onCleared?.(room);
  }

  /** Real delta seconds scaled by the freeze, for ambient animation. */
  scaledDt(dt: number): number {
    return dt * this.scale;
  }

  private liveEnemies(room: number): THREE.Object3D[] {
    return (this.world.enemies.get(room) ?? []).filter((e) => e.parent !== null);
  }

  /** The nearest live automaton of the current room inside the trigger radius, when exploring. */
  checkTrigger(player: { x: number; z: number }): EncounterTrigger | null {
    if (this.phaseValue !== 'idle' || this.cooldown > 0) return null;
    const room = this.world.current;
    if (this.cleared.has(room) || !this.world.plan.rooms[room]?.encounter) return null;
    const footprint = this.world.rooms[room]?.footprint;
    if (!footprint) return null;
    const { min, max } = footprint;
    if (player.x < min[0] || player.x > max[0] || player.z < min[1] || player.z > max[1])
      return null;
    const p = new THREE.Vector3();
    let best: EncounterTrigger | null = null;
    for (const enemy of this.liveEnemies(room)) {
      enemy.getWorldPosition(p);
      const distance = Math.hypot(p.x - player.x, p.z - player.z);
      if (distance <= this.triggerRadius && (!best || distance < best.distance)) {
        best = { room, enemy, distance };
      }
    }
    return best;
  }

  /**
   * Starts the fight in `room`: freezes exploration, locks locomotion, unfolds the table at the
   * player's seat and sends the room's automatons to their places. Returns a failure, touching
   * nothing, when the table and enemies cannot be placed clear of walls.
   */
  begin(room: number, player: PlayerPose, patrol?: THREE.Object3D): BeginResult {
    if (this.phaseValue !== 'idle')
      return { ok: false, reason: `encounter already ${this.phaseValue}` };
    if (patrol && (this.cooldown > 0 || room !== this.world.current || !patrol.parent))
      return { ok: false, reason: 'patrol unavailable' };
    const worldRoom = this.world.rooms[room];
    const enemies = patrol ? [patrol] : this.liveEnemies(room);
    if (!worldRoom || enemies.length === 0)
      return { ok: false, reason: `room ${room} has no enemies` };
    const guardian = enemies.some((e) => e.userData.tier === 'guardian');
    const space = combatRoom(worldRoom);
    const origin = patrol?.getWorldPosition(new THREE.Vector3());
    const loadedColliders = patrol ? this.world.colliders?.[room] : undefined;
    const blockers = loadedColliders ?? space.colliders;
    const clearApproach = origin
      ? (x: number, z: number) => {
          const from: Vec3 = [origin.x, 1, origin.z];
          const to: Vec3 = [x, 1, z];
          const radius = 0.43;
          return (
            !blockers.some(
              (b) =>
                b.max[1] > 0.06 &&
                b.min[1] < 2.05 &&
                segmentBoxHit(from, to, {
                  min: [b.min[0] - radius, 0, b.min[2] - radius],
                  max: [b.max[0] + radius, 2.05, b.max[2] + radius],
                }) !== null,
            ) && clearsPlayer(origin, to, player.x, player.z)
          );
        }
      : undefined;
    const plan = planEncounter(
      player,
      enemies.length,
      patrol
        ? {
            ...space,
            colliders: blockers,
            walkable: space.walkable.map((rect) => ({
              min: [
                Math.max(space.footprint.min[0], rect.min[0] - 0.28),
                Math.max(space.footprint.min[1], rect.min[1] - 0.28),
              ],
              max: [
                Math.min(space.footprint.max[0], rect.max[0] + 0.28),
                Math.min(space.footprint.max[1], rect.max[1] + 0.28),
              ],
            })),
          }
        : space,
      {
        table: {
          distance: this.tableDistance,
          ...(patrol ? { maxOffsetDeg: 180, margin: 0.05 } : {}),
        },
        enemies: patrol
          ? {
              radius: 0.43,
              margin: 0.06,
              minDistance: 1.25,
              preferred: 1.75,
              maxDistance: 2.75,
              ...(clearApproach ? { clearApproach } : {}),
            }
          : { radius: guardian ? GUARDIAN_RADIUS : REGULAR_RADIUS },
      },
    );
    if (!plan.ok) {
      this.cooldown = this.retryCooldown;
      return { ok: false, reason: plan.reason };
    }

    const pose = plan.table.pose;
    const [rx, rz] = rightOf(pose.yaw);
    const lateralOf = (e: THREE.Object3D) => {
      const w = e.getWorldPosition(new THREE.Vector3());
      return (w.x - pose.x) * rx + (w.z - pose.z) * rz;
    };
    // Left to right across the table, so the tweens never cross.
    const ordered = enemies
      .map((e) => ({ e, lateral: lateralOf(e) }))
      .sort((a, b) => a.lateral - b.lateral)
      .map((entry) => entry.e);
    const targets = ordered.map((obj, i) => {
      const slot = plan.enemies[i] as EnemyPlacement;
      return { obj, x: slot.x, z: slot.z, yaw: slot.yaw };
    });
    for (const { obj } of targets) {
      if (!this.homes.has(obj)) {
        this.homes.set(obj, {
          x: obj.position.x,
          y: obj.position.y,
          z: obj.position.z,
          rotY: obj.rotation.y,
        });
      }
    }

    this.room = room;
    this.patrol = patrol ?? null;
    this.patrolApproachPose = null;
    this.pose = pose;
    this.placedDistance = plan.table.distance;
    this.seat = [player.x, player.z];
    this.table.position.set(pose.x, 0, pose.z);
    this.table.rotation.y = -pose.yaw * DEG;
    setTableHeight(this.table, pose.height);
    setTableUnfold(this.table, 0);
    this.startMoves(
      targets.map((t) => ({ obj: t.obj, world: [t.x, t.z], worldRotY: -t.yaw * DEG })),
    );
    this.patrolTableDelay = this.patrol ? (this.moves[0]?.approach?.duration ?? 0) + 0.12 : 0;
    this.phaseValue = 'unfolding';
    this.elapsed = 0;
    this.open = 0;
    this.frozenValue = true;
    this.targetScale = this.frozenTimeScale;
    this.lock(true);
    return { ok: true, table: plan.table, enemies: plan.enemies };
  }

  /**
   * Ends the fight and reverses everything. A win removes the room's automatons and clears the
   * room. A defeat ends the run, so the automatons hold their combat slots, 2 to 3 m beyond the
   * table. A flee sends them back to their sockets, except one whose socket would put it inside the
   * seated player's head clearance (its home is where the trigger fired, within the trigger radius,
   * and the guardian is 3.5 m wide): that one holds its slot too. Locomotion unlocks and the freeze
   * lifts when the table has finished folding.
   */
  end(outcome: EncounterOutcome): void {
    if (this.phaseValue !== 'unfolding' && this.phaseValue !== 'active') return;
    this.patrolApproachPose = null;
    const approach = this.moves[0]?.approach;
    if (outcome === 'flee' && this.patrol && approach) {
      this.patrolReturn = {
        foldSeconds: this.open * this.unfoldSeconds,
        from: Math.min(this.elapsed, approach.duration),
      };
      this.movesDone = false;
    }
    this.targetScale = 1;
    this.elapsed = 0;
    this.phaseValue = 'folding';
    if (outcome === 'win') {
      if (this.patrol) this.patrol.removeFromParent();
      else this.markCleared(this.room);
      this.moves = [];
      this.movesDone = true;
      return;
    }
    if (outcome === 'defeat') {
      this.moves = [];
      this.movesDone = true;
      return;
    }
    if (this.patrolReturn) return;
    const seat = this.seat;
    const moves = this.liveEnemies(this.room).flatMap((obj) => {
      const home = this.homes.get(obj);
      if (!home || !obj.parent) return [];
      obj.parent.updateWorldMatrix(true, false);
      const w = obj.parent.localToWorld(new THREE.Vector3(home.x, home.y, home.z));
      if (seat && Math.hypot(w.x - seat[0], w.z - seat[1]) < enemyReach(obj) + HEAD_CLEARANCE) {
        return [];
      }
      const parentRotY = this.parentRotY(obj);
      return [{ obj, world: [w.x, w.z] as const, worldRotY: home.rotY + parentRotY }];
    });
    this.startMoves(moves);
  }

  /** Advances timers by `dt` real seconds. */
  update(dt: number): void {
    if (!(dt > 0)) return;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.scale !== this.targetScale) {
      const step = ((1 - this.frozenTimeScale) / Math.max(this.rampSeconds, 1e-6)) * dt;
      this.scale =
        this.scale < this.targetScale
          ? Math.min(this.targetScale, this.scale + step)
          : Math.max(this.targetScale, this.scale - step);
    }
    if (this.phaseValue === 'idle' || this.phaseValue === 'active') return;
    this.elapsed += dt;
    const opening = this.phaseValue === 'unfolding';
    const progress =
      opening && this.patrol
        ? (this.elapsed - this.patrolTableDelay) / this.unfoldSeconds
        : this.open + ((opening ? 1 : -1) * dt) / this.unfoldSeconds;
    this.open = Math.min(1, Math.max(0, progress));
    setTableUnfold(this.table, this.open);
    const returning = this.patrolReturn;
    if (!returning) this.stepMoves(this.elapsed);
    else if (this.elapsed >= returning.foldSeconds) {
      const t = Math.max(0, returning.from - (this.elapsed - returning.foldSeconds));
      this.stepMoves(t);
      this.movesDone = t === 0;
    }
    const done = (opening ? this.open >= 1 - EPS : this.open <= EPS) && this.movesDone;
    if (!done) return;
    if (this.phaseValue === 'unfolding') {
      this.phaseValue = 'active';
      return;
    }
    this.phaseValue = 'idle';
    this.frozenValue = false;
    this.room = -1;
    this.patrol = null;
    this.patrolReturn = null;
    this.patrolApproachPose = null;
    this.pose = null;
    this.seat = null;
    this.cooldown = this.retryCooldown;
    setTableUnfold(this.table, 0);
    this.lock(false);
  }

  dispose(): void {
    this.table.removeFromParent();
    if (this.ownsTable) disposeTable(this.table);
  }

  private parentRotY(obj: THREE.Object3D): number {
    if (!obj.parent) return 0;
    obj.parent.updateWorldMatrix(true, false);
    const q = obj.parent.getWorldQuaternion(new THREE.Quaternion());
    return new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
  }

  private startMoves(
    targets: readonly {
      obj: THREE.Object3D;
      world: readonly [number, number];
      worldRotY: number;
    }[],
  ): void {
    this.moves = targets.flatMap(({ obj, world, worldRotY }) => {
      if (!obj.parent) return [];
      const from = obj.getWorldPosition(new THREE.Vector3());
      const parentYaw = this.parentRotY(obj);
      const approach =
        obj === this.patrol
          ? planPatrolApproach(
              world[0] - from.x,
              world[1] - from.z,
              obj.rotation.y + parentYaw,
              worldRotY,
            )
          : undefined;
      return [
        {
          obj,
          from,
          to: new THREE.Vector3(world[0], from.y, world[1]),
          fromRotY: obj.rotation.y,
          toRotY: obj.rotation.y + wrapRadians(worldRotY - parentYaw - obj.rotation.y),
          ...(approach ? { approach, parentYaw } : {}),
        },
      ];
    });
    this.movesDone = this.moves.length === 0;
  }

  private stepMoves(elapsed: number): void {
    if (this.moves.length === 0) return;
    const t = smoothstep(elapsed / this.moveSeconds);
    const p = new THREE.Vector3();
    let done = true;
    for (const m of this.moves) {
      const pose = m.approach?.sample(elapsed);
      if (pose)
        this.patrolApproachPose = this.patrolReturn
          ? { ...pose, returning: true, speed: -pose.speed }
          : pose;
      p.lerpVectors(m.from, m.to, pose?.along ?? t);
      m.obj.parent?.updateWorldMatrix(true, false);
      m.obj.parent?.worldToLocal(p);
      m.obj.position.copy(p);
      m.obj.rotation.y = pose
        ? pose.yaw - (m.parentYaw ?? 0)
        : m.fromRotY + (m.toRotY - m.fromRotY) * t;
      done &&= elapsed >= (m.approach?.duration ?? this.moveSeconds) - EPS;
    }
    this.movesDone = done;
  }
}
