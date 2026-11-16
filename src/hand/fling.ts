import * as THREE from 'three';
import type { TablePose } from '../combat/placement.ts';
import type { CombatController, Stage } from '../combat-view/controller.ts';
import { livingEnemies } from '../rules/index.ts';
import {
  type AimRay,
  type AimTarget,
  DEFAULT_CONE_DEG,
  DEFAULT_MIN_SPEED,
  DEFAULT_POINT_RADIUS,
  DEFAULT_TABLE_HALF_EXTENTS,
  isOverTable,
  pickFlingTarget,
  pickPointTarget,
  speedOf,
  type TableHalfExtents,
  throwCrossesTable,
} from './aim.ts';
import type { CardFan, GrabbedCard } from './card-fan.ts';
import { DEFAULT_WINDOW_SECONDS, releaseVelocity, SampleWindow, type Vec3 } from './velocity.ts';

/** Where an enemy stands, world space. The controller decides whether it is a legal target. */
export interface FlingTargetSite {
  readonly id: string;
  readonly position: Vec3;
  readonly radius?: number;
}

export interface FlingTuning {
  /** Half angle of the aim cone, degrees. */
  coneDeg: number;
  /** Slowest throw that counts as a flick, metres per second. */
  minSpeed: number;
  /** Span of the velocity fit, seconds. */
  windowSeconds: number;
  /** Point-and-trigger hit radius around a target, metres. */
  pointRadius: number;
}

export const DEFAULT_TUNING: FlingTuning = {
  coneDeg: DEFAULT_CONE_DEG,
  minSpeed: DEFAULT_MIN_SPEED,
  windowSeconds: DEFAULT_WINDOW_SECONDS,
  pointRadius: DEFAULT_POINT_RADIUS,
};

export interface FlingOptions {
  fan: CardFan;
  combat: CombatController;
  /** Enemy positions in world space; read once per release. */
  targets: () => readonly FlingTargetSite[];
  /** The combat table, or null while it is not unfolded (nothing can be dropped on it then). */
  table: () => { pose: TablePose; halfExtents?: TableHalfExtents } | null;
  /** Main-hand pointing ray in world space for the point-and-trigger fallback, if available. */
  pointRay?: () => AimRay | null;
  mainGrip?: THREE.Object3D;
  tuning?: Partial<FlingTuning>;
}

/** How a release was resolved: a flick at a target, a point at a target, or a drop on the table. */
export type FlingVia = 'flick' | 'point' | 'drop' | 'none';

export interface FlingDecision {
  /** `staged`: the controller now waits for the sigil plate, and the card stays out of the fan. */
  readonly outcome: 'played' | 'staged' | 'sprung-back';
  readonly via: FlingVia;
  readonly uid: number;
  readonly cardId: string;
  readonly targetId: string | null;
  /** Throw speed at release, metres per second. */
  readonly speed: number;
  /** Angle between throw and target for a flick, degrees. */
  readonly angleDeg: number | null;
  /** The rules' or the aim's reason when the card sprang back. */
  readonly reason: string | null;
}

const HISTORY = 20;

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

/** World ray along an object's -Z axis, which is a WebXR target-ray space's pointing direction. */
export function rayFromObject(object: THREE.Object3D): AimRay {
  object.updateWorldMatrix(true, false);
  object.getWorldPosition(tmpPos);
  object.getWorldQuaternion(tmpQuat);
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(tmpQuat);
  return { origin: [tmpPos.x, tmpPos.y, tmpPos.z], direction: [dir.x, dir.y, dir.z] };
}

/**
 * Turns the main hand's grab and release of a fan card into combat calls. It owns no rules: the
 * `CombatController` is the single authority, shared with the desktop view, and every refusal comes
 * back as its `PlayResult`.
 *
 * - `grab(index)` picks the card up and selects it; an unaffordable card springs straight back.
 * - `update(dt)` samples the main grip into the velocity window while a card is held.
 * - `release()` resolves the throw. A targeted card plays at the flick's aim-assisted target, else at
 *   the target the main-hand ray points at, else springs back. An untargeted card plays when
 *   released over the table or flicked across it, else springs back. A card the rules refuse springs
 *   back and the selection is cancelled.
 *
 * A played card is left hidden in the fan until the caller re-sets the hand. A `staged` sigil card
 * stays selected for the sigil plate, which calls `abortStaged()` if the cast is abandoned; grabbing another card aborts it too.
 */
export class FlingController {
  readonly tuning: FlingTuning;
  /** Newest decisions, oldest first, for the debug readout. */
  readonly history: FlingDecision[] = [];

  private readonly fan: CardFan;
  private readonly combat: CombatController;
  private readonly targetsOf: FlingOptions['targets'];
  private readonly tableOf: FlingOptions['table'];
  private readonly pointRay: FlingOptions['pointRay'];
  private mainGrip: THREE.Object3D | undefined;
  private readonly window = new SampleWindow();
  private clock = 0;
  private held: GrabbedCard | null = null;
  private staged: GrabbedCard | null = null;

  constructor(options: FlingOptions) {
    this.fan = options.fan;
    this.combat = options.combat;
    this.targetsOf = options.targets;
    this.tableOf = options.table;
    this.pointRay = options.pointRay;
    this.mainGrip = options.mainGrip;
    this.tuning = { ...DEFAULT_TUNING, ...options.tuning };
  }

  setMainGrip(grip: THREE.Object3D | undefined): void {
    this.mainGrip = grip;
  }

  get lastDecision(): FlingDecision | null {
    return this.history[this.history.length - 1] ?? null;
  }

  /** The card in the main hand, if any. */
  get holding(): GrabbedCard | null {
    return this.held;
  }

  /** The combat controller's next expected input; `sigil` means the plate owns the card now. */
  get stage(): Stage {
    return this.combat.stage;
  }

  /** Current throw speed estimate while holding a card, metres per second; 0 otherwise. */
  get speed(): number {
    const v = this.held ? releaseVelocity(this.window, this.tuning) : null;
    return v ? speedOf(v) : 0;
  }

  /** One line for a debug panel. */
  debugText(): string {
    const d = this.lastDecision;
    const live = this.held ? ` holding ${this.held.card.id} v=${this.speed.toFixed(2)}m/s` : '';
    if (!d) return `fling: idle${live}`;
    const tail = d.reason ?? d.targetId ?? '';
    return `fling: ${d.outcome} ${d.via} ${d.cardId} v=${d.speed.toFixed(2)}${tail ? ` ${tail}` : ''}${live}`;
  }

  /** Picks up fan card `index` with the main hand. Null when it could not be grabbed or played. */
  grab(index: number): GrabbedCard | null {
    if (this.held) return null;
    const grip = this.mainGrip;
    const grabbed = this.fan.grab(index, grip);
    if (!grabbed || !grip) return null;
    this.abortStaged();
    this.window.clear();
    this.sample(grip);
    const result =
      this.combat.selectedUid === grabbed.uid
        ? { ok: true as const }
        : this.combat.select(grabbed.uid);
    if (!result.ok) {
      this.fan.returnToFan(index);
      this.combat.cancel();
      this.record(grabbed, 'sprung-back', 'none', null, 0, null, result.reason);
      return null;
    }
    this.held = grabbed;
    return grabbed;
  }

  /** Samples the main grip while a card is held. Call every frame with the frame time step. */
  update(dt: number): void {
    this.clock += Math.max(0, dt);
    if (this.held && this.mainGrip) this.sample(this.mainGrip);
  }

  /** Lets go of the held card and resolves the throw. Null when nothing is held. */
  release(): FlingDecision | null {
    const held = this.held;
    if (!held) return null;
    this.held = null;
    const released = this.fan.release();
    if (!released) return null;

    const velocity = releaseVelocity(this.window, this.tuning);
    const speed = velocity ? speedOf(velocity) : 0;
    const flick = velocity !== null && speed >= this.tuning.minSpeed;
    const origin: Vec3 = [released.position.x, released.position.y, released.position.z];
    const sites = this.targetsOf();
    const alive = new Set(livingEnemies(this.combat.state).map((e) => e.id));
    const targets: AimTarget[] = sites.map((s) => ({
      ...s,
      valid: alive.has(s.id),
    }));
    const springBack = (via: FlingVia, reason: string, targetId: string | null = null) => {
      this.fan.returnToFan(held.index);
      this.combat.cancel();
      return this.record(held, 'sprung-back', via, targetId, speed, null, reason);
    };

    if (released.card.target === 'enemy') {
      let via: FlingVia = 'flick';
      let angleDeg: number | null = null;
      let id: string | null = null;
      if (flick) {
        const pick = pickFlingTarget(origin, velocity, targets, this.tuning);
        if (pick) {
          id = pick.id;
          angleDeg = pick.angleDeg;
        }
      }
      if (id === null) {
        via = 'point';
        const ray = this.pointRay?.() ?? null;
        id = ray ? (pickPointTarget(ray, targets, this.tuning.pointRadius)?.id ?? null) : null;
      }
      if (id === null) return springBack('none', 'No target in reach, aim at an enemy');
      const result = this.combat.target(id);
      if (!result.ok) return springBack(via, result.reason, id);
      return this.settle(held, via, id, speed, angleDeg);
    }

    const table = this.tableOf();
    const extents = table?.halfExtents ?? DEFAULT_TABLE_HALF_EXTENTS;
    const overTable =
      table !== null &&
      (isOverTable(origin, table.pose, extents) ||
        (flick && throwCrossesTable(origin, velocity, table.pose, extents)));
    if (!overTable) return springBack('none', 'Drop the card on the table');
    // A sigil card is already waiting on the plate; `table()` would refuse it.
    if (this.combat.stage !== 'sigil') {
      const result = this.combat.table();
      if (!result.ok) return springBack('drop', result.reason);
    }
    return this.settle(held, flick ? 'flick' : 'drop', null, speed, null);
  }

  /** Abandons a staged sigil cast: cancels the selection and springs the card back to the fan. */
  abortStaged(): void {
    const staged = this.staged;
    if (!staged) return;
    this.staged = null;
    this.fan.returnToFan(staged.index);
    this.combat.cancel();
  }

  private settle(
    held: GrabbedCard,
    via: FlingVia,
    targetId: string | null,
    speed: number,
    angleDeg: number | null,
  ): FlingDecision {
    if (this.combat.stage === 'sigil') {
      this.staged = held;
      return this.record(held, 'staged', via, targetId, speed, angleDeg, null);
    }
    return this.record(held, 'played', via, targetId, speed, angleDeg, null);
  }

  private sample(grip: THREE.Object3D): void {
    grip.updateWorldMatrix(true, false);
    grip.getWorldPosition(tmpPos);
    this.window.push(this.clock, tmpPos.x, tmpPos.y, tmpPos.z);
  }

  private record(
    card: GrabbedCard,
    outcome: FlingDecision['outcome'],
    via: FlingVia,
    targetId: string | null,
    speed: number,
    angleDeg: number | null,
    reason: string | null,
  ): FlingDecision {
    const decision: FlingDecision = {
      outcome,
      via,
      uid: card.uid,
      cardId: card.card.id,
      targetId,
      speed,
      angleDeg,
      reason,
    };
    this.history.push(decision);
    if (this.history.length > HISTORY) this.history.shift();
    return decision;
  }
}
