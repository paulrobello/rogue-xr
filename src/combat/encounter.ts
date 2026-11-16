import * as THREE from 'three';
import type { FloorPlan, WorldRoom } from '../floor/generate.ts';
import {
  combatRoom,
  type EnemyPlacement,
  type PlayerPose,
  planEncounter,
  rightOf,
  type TablePlacement,
  type TablePose,
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
const EPS = 1e-9;

export type EncounterPhase = 'idle' | 'unfolding' | 'active' | 'folding';
/** How a fight ended: a win clears the room, the others send the automatons home. */
export type EncounterOutcome = 'win' | 'defeat' | 'flee';

/** The slice of `FloorWorld` the director reads. The enemy meshes and `group` are mutated, nothing else. */
export interface EncounterWorld {
  plan: FloorPlan;
  rooms: readonly WorldRoom[];
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
  /** Replaces the greybox table; it must expose `leaf-left` and `leaf-right` nodes. */
  table?: THREE.Object3D;
  triggerRadius?: number;
  unfoldSeconds?: number;
  moveSeconds?: number;
  frozenTimeScale?: number;
  timeScaleRampSeconds?: number;
  /** Seconds after a failed placement or a finished fight before a trigger can fire again. */
  retryCooldown?: number;
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
}

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

function wrapRadians(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
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
  private readonly ownsTable: boolean;
  private readonly triggerRadius: number;
  private readonly unfoldSeconds: number;
  private readonly moveSeconds: number;
  private readonly frozenTimeScale: number;
  private readonly rampSeconds: number;
  private readonly retryCooldown: number;
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
  private pose: TablePose | null = null;
  private moves: Move[] = [];
  private movesDone = true;

  constructor(config: EncounterConfig) {
    this.world = config.world;
    this.lock = config.lockLocomotion;
    this.ownsTable = !config.table;
    this.table = config.table ?? buildTableGreybox();
    this.triggerRadius = config.triggerRadius ?? 1.2;
    this.unfoldSeconds = config.unfoldSeconds ?? 0.6;
    this.moveSeconds = config.moveSeconds ?? 0.8;
    this.frozenTimeScale = config.frozenTimeScale ?? 0.05;
    this.rampSeconds = config.timeScaleRampSeconds ?? 0.3;
    this.retryCooldown = config.retryCooldown ?? 1.5;
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

  /** Where the table stands during combat, or null. */
  get tablePose(): TablePose | null {
    return this.pose;
  }

  isCleared(room: number): boolean {
    return this.cleared.has(room);
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
  begin(room: number, player: PlayerPose): BeginResult {
    if (this.phaseValue !== 'idle')
      return { ok: false, reason: `encounter already ${this.phaseValue}` };
    const worldRoom = this.world.rooms[room];
    const enemies = this.liveEnemies(room);
    if (!worldRoom || enemies.length === 0)
      return { ok: false, reason: `room ${room} has no enemies` };
    const guardian = enemies.some((e) => e.userData.tier === 'guardian');
    const plan = planEncounter(player, enemies.length, combatRoom(worldRoom), {
      enemies: { radius: guardian ? GUARDIAN_RADIUS : REGULAR_RADIUS },
    });
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
    this.pose = pose;
    this.table.position.set(pose.x, 0, pose.z);
    this.table.rotation.y = -pose.yaw * DEG;
    setTableHeight(this.table, pose.height);
    setTableUnfold(this.table, 0);
    this.startMoves(
      targets.map((t) => ({ obj: t.obj, world: [t.x, t.z], worldRotY: -t.yaw * DEG })),
    );
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
   * room; any other outcome sends them back to their sockets. Locomotion unlocks and the freeze
   * lifts when the table has finished folding.
   */
  end(outcome: EncounterOutcome): void {
    if (this.phaseValue !== 'unfolding' && this.phaseValue !== 'active') return;
    this.targetScale = 1;
    this.elapsed = 0;
    this.phaseValue = 'folding';
    if (outcome === 'win') {
      for (const e of this.liveEnemies(this.room)) e.removeFromParent();
      this.cleared.add(this.room);
      this.moves = [];
      this.movesDone = true;
      return;
    }
    const moves = this.liveEnemies(this.room).flatMap((obj) => {
      const home = this.homes.get(obj);
      if (!home || !obj.parent) return [];
      obj.parent.updateWorldMatrix(true, false);
      const w = obj.parent.localToWorld(new THREE.Vector3(home.x, home.y, home.z));
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
    this.open = Math.min(
      1,
      Math.max(0, this.open + ((opening ? 1 : -1) * dt) / this.unfoldSeconds),
    );
    setTableUnfold(this.table, this.open);
    this.stepMoves();
    const done = (opening ? this.open >= 1 - EPS : this.open <= EPS) && this.movesDone;
    if (!done) return;
    if (this.phaseValue === 'unfolding') {
      this.phaseValue = 'active';
      return;
    }
    this.phaseValue = 'idle';
    this.frozenValue = false;
    this.room = -1;
    this.pose = null;
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
      return [
        {
          obj,
          from,
          to: new THREE.Vector3(world[0], from.y, world[1]),
          fromRotY: obj.rotation.y,
          toRotY: obj.rotation.y + wrapRadians(worldRotY - this.parentRotY(obj) - obj.rotation.y),
        },
      ];
    });
    this.movesDone = this.moves.length === 0;
  }

  private stepMoves(): void {
    if (this.moves.length === 0) return;
    const t = smoothstep(this.elapsed / this.moveSeconds);
    const p = new THREE.Vector3();
    for (const m of this.moves) {
      p.lerpVectors(m.from, m.to, t);
      m.obj.parent?.updateWorldMatrix(true, false);
      m.obj.parent?.worldToLocal(p);
      m.obj.position.copy(p);
      m.obj.rotation.y = m.fromRotY + (m.toRotY - m.fromRotY) * t;
    }
    this.movesDone = this.elapsed >= this.moveSeconds - EPS;
  }
}
