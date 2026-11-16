import RAPIER from '@dimforge/rapier3d-compat';
import {
  type CorrectionPlan,
  correctionPoseAt,
  D6_HALF_EXTENT,
  type DieKind,
  dieVertices,
  faceNormals,
  planCorrection,
  upFace,
} from './faces.ts';
import { type Pose, QUAT_IDENTITY, type Quat, type Vec3 } from './quat.ts';

/** Fixed simulation step. The renderer's frame rate never changes it. */
export const FIXED_STEP = 1 / 120;
/** The seeded-face correction lasts this many simulated seconds (D1: about 100 ms). */
export const CORRECTION_SECONDS = 0.1;
export const CORRECTION_STEPS = Math.round(CORRECTION_SECONDS / FIXED_STEP);
/** Caps catch-up work after a long frame so the physics never spirals. */
export const MAX_SUBSTEPS = 10;

/** Settled means both speeds stay under these for `SETTLE_STEPS` consecutive fixed steps. */
export const SETTLE_LINEAR_SPEED = 0.05;
export const SETTLE_ANGULAR_SPEED = 0.8;
export const SETTLE_STEPS = 10;

export interface DiceWorldOptions {
  /** Inner half-extent of the tray floor in metres, along x and z. */
  halfX: number;
  halfZ: number;
  wallHeight: number;
  /** A die still moving this long after the throw is corrected anyway. */
  maxRollSeconds: number;
}

export const DEFAULT_OPTIONS: Readonly<DiceWorldOptions> = {
  halfX: 0.3,
  halfZ: 0.3,
  wallHeight: 0.3,
  maxRollSeconds: 4,
};

const WALL_THICKNESS = 0.03;
const TABLE_THICKNESS = 0.05;
/** A die centre this far below the table surface has left the tray. */
const ESCAPE_DEPTH = 0.1;

export type DiePhase = 'rolling' | 'correcting' | 'done';

export interface DiePose extends Pose {
  phase: DiePhase;
}

export interface SettledEvent {
  id: string;
  kind: DieKind;
  /** The face index showing up in the final pose. Always the throw's `targetFace`. */
  face: number;
  pose: Pose;
  /** Simulated time from the throw until settle (or the forced correction) began. */
  rollMs: number;
  /** Simulated time the correction took. */
  correctionMs: number;
  /** True when the die never came to rest or left the tray, so a guard started the correction. */
  forced: boolean;
}

export type SettledListener = (event: SettledEvent) => void;

interface DieEntry {
  id: string;
  kind: DieKind;
  targetFace: number;
  body: RAPIER.RigidBody;
  phase: DiePhase;
  rollSteps: number;
  calmSteps: number;
  forced: boolean;
  correctionStep: number;
  plan: CorrectionPlan | null;
}

let rapierReady: Promise<void> | null = null;

/** Initialises the Rapier wasm module once per process; every `DiceWorld.create` awaits it. */
function initRapier(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

/**
 * Rapier world holding a table surface (top at y = 0), a four-wall tray and the dice thrown into it.
 * Coordinates are tray-local metres with +Y up, so the caller places the group on the combat table.
 * The engine decides each die's result before the throw (D1); physics only presents it: once a die
 * comes to rest it is tipped about its lowest contact point so `targetFace` is up, eased over
 * `CORRECTION_SECONDS` of simulated time.
 */
export class DiceWorld {
  private readonly world: RAPIER.World;
  private readonly options: DiceWorldOptions;
  private readonly dice = new Map<string, DieEntry>();
  private readonly listeners = new Set<SettledListener>();
  private accumulator = 0;
  private stepCount = 0;

  private constructor(options: DiceWorldOptions) {
    this.options = options;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = FIXED_STEP;
    // Dice are centimetres across; scale Rapier's contact tolerances down from their 1 m defaults.
    this.world.integrationParameters.lengthUnit = 0.1;
    this.buildTray();
  }

  static async create(options: Partial<DiceWorldOptions> = {}): Promise<DiceWorld> {
    await initRapier();
    return new DiceWorld({ ...DEFAULT_OPTIONS, ...options });
  }

  /** Total fixed steps simulated so far. */
  get steps(): number {
    return this.stepCount;
  }

  /** True when every die in the world has finished its correction (vacuously true when empty). */
  get allDone(): boolean {
    for (const die of this.dice.values()) if (die.phase !== 'done') return false;
    return true;
  }

  onSettled(listener: SettledListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Releases a die from the hand. `targetFace` is the face index the engine rolled (`DiceRoll.face`).
   * Throwing an id that is already in the world replaces that die.
   */
  throwDie(
    id: string,
    kind: DieKind,
    position: Vec3,
    linvel: Vec3,
    angvel: Vec3,
    targetFace: number,
    orientation: Quat = QUAT_IDENTITY,
  ): void {
    if (!Number.isInteger(targetFace) || targetFace < 0 || targetFace >= faceNormals(kind).length) {
      throw new RangeError(`Face ${targetFace} does not exist on a ${kind}`);
    }
    this.removeDie(id);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setRotation(orientation)
        .setLinvel(linvel.x, linvel.y, linvel.z)
        .setAngvel(angvel)
        .setLinearDamping(0.1)
        .setAngularDamping(0.5)
        .setCanSleep(false)
        .setCcdEnabled(true),
    );
    const shape =
      kind === 'd6'
        ? RAPIER.ColliderDesc.cuboid(D6_HALF_EXTENT, D6_HALF_EXTENT, D6_HALF_EXTENT)
        : RAPIER.ColliderDesc.convexHull(
            new Float32Array(dieVertices(kind).flatMap((v) => [v.x, v.y, v.z])),
          );
    if (shape === null) throw new Error(`Could not build a ${kind} collider`);
    this.world.createCollider(shape.setFriction(0.6).setRestitution(0.35).setDensity(1000), body);
    this.dice.set(id, {
      id,
      kind,
      targetFace,
      body,
      phase: 'rolling',
      rollSteps: 0,
      calmSteps: 0,
      forced: false,
      correctionStep: 0,
      plan: null,
    });
  }

  removeDie(id: string): void {
    const die = this.dice.get(id);
    if (die === undefined) return;
    this.world.removeRigidBody(die.body);
    this.dice.delete(id);
  }

  /** The die's pose as of the last fixed step, for the renderer to copy onto its mesh. */
  pose(id: string): DiePose | undefined {
    const die = this.dice.get(id);
    if (die === undefined) return undefined;
    const t = die.body.translation();
    const r = die.body.rotation();
    return {
      phase: die.phase,
      position: { x: t.x, y: t.y, z: t.z },
      quaternion: { x: r.x, y: r.y, z: r.z, w: r.w },
    };
  }

  /**
   * Advances by one rendered frame of `dtFrame` seconds. The simulation runs in whole `FIXED_STEP`
   * increments, so the same throw reaches the same result at any frame rate. Returns the number of
   * fixed steps taken.
   */
  step(dtFrame: number): number {
    this.accumulator += Math.max(0, dtFrame);
    let taken = 0;
    while (this.accumulator >= FIXED_STEP && taken < MAX_SUBSTEPS) {
      this.fixedStep();
      this.accumulator -= FIXED_STEP;
      taken++;
    }
    if (taken === MAX_SUBSTEPS) this.accumulator %= FIXED_STEP;
    return taken;
  }

  dispose(): void {
    this.dice.clear();
    this.listeners.clear();
    this.world.free();
  }

  private buildTray(): void {
    const { halfX, halfZ, wallHeight } = this.options;
    const fixed = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const slab = (hx: number, hy: number, hz: number, x: number, y: number, z: number): void => {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(x, y, z)
          .setFriction(0.8)
          .setRestitution(0.3),
        fixed,
      );
    };
    const outerX = halfX + WALL_THICKNESS;
    const outerZ = halfZ + WALL_THICKNESS;
    slab(outerX, TABLE_THICKNESS / 2, outerZ, 0, -TABLE_THICKNESS / 2, 0);
    const wallY = wallHeight / 2;
    slab(WALL_THICKNESS / 2, wallHeight / 2, outerZ, halfX + WALL_THICKNESS / 2, wallY, 0);
    slab(WALL_THICKNESS / 2, wallHeight / 2, outerZ, -halfX - WALL_THICKNESS / 2, wallY, 0);
    slab(halfX, wallHeight / 2, WALL_THICKNESS / 2, 0, wallY, halfZ + WALL_THICKNESS / 2);
    slab(halfX, wallHeight / 2, WALL_THICKNESS / 2, 0, wallY, -halfZ - WALL_THICKNESS / 2);
  }

  private fixedStep(): void {
    for (const die of this.dice.values()) {
      if (die.phase !== 'correcting' || die.plan === null) continue;
      const pose = correctionPoseAt(die.plan, (die.correctionStep + 1) / CORRECTION_STEPS);
      die.body.setNextKinematicTranslation(pose.position);
      die.body.setNextKinematicRotation(pose.quaternion);
    }
    this.world.step();
    this.stepCount++;
    for (const die of this.dice.values()) {
      if (die.phase === 'rolling') this.advanceRolling(die);
      else if (die.phase === 'correcting') this.advanceCorrecting(die);
    }
  }

  private advanceRolling(die: DieEntry): void {
    die.rollSteps++;
    const v = die.body.linvel();
    const w = die.body.angvel();
    const calm =
      Math.hypot(v.x, v.y, v.z) < SETTLE_LINEAR_SPEED &&
      Math.hypot(w.x, w.y, w.z) < SETTLE_ANGULAR_SPEED;
    die.calmSteps = calm ? die.calmSteps + 1 : 0;
    // A die that cleared the walls falls past the table edge; rescue it at once instead of after the timeout.
    const escaped = die.body.translation().y < -ESCAPE_DEPTH;
    const timedOut = die.rollSteps * FIXED_STEP >= this.options.maxRollSeconds;
    if (die.calmSteps >= SETTLE_STEPS || timedOut || escaped)
      this.beginCorrection(die, die.calmSteps < SETTLE_STEPS);
  }

  private beginCorrection(die: DieEntry, forced: boolean): void {
    const t = die.body.translation();
    const r = die.body.rotation();
    const { halfX, halfZ } = this.options;
    die.plan = planCorrection(
      { position: { x: t.x, y: t.y, z: t.z }, quaternion: { x: r.x, y: r.y, z: r.z, w: r.w } },
      die.kind,
      die.targetFace,
      0,
      { halfX, halfZ },
    );
    die.forced = forced;
    die.phase = 'correcting';
    die.correctionStep = 0;
    die.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    die.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    die.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, false);
  }

  private advanceCorrecting(die: DieEntry): void {
    die.correctionStep++;
    if (die.correctionStep < CORRECTION_STEPS || die.plan === null) return;
    die.phase = 'done';
    const pose = correctionPoseAt(die.plan, 1);
    const event: SettledEvent = {
      id: die.id,
      kind: die.kind,
      face: upFace(pose.quaternion, faceNormals(die.kind)),
      pose,
      rollMs: die.rollSteps * FIXED_STEP * 1000,
      correctionMs: die.correctionStep * FIXED_STEP * 1000,
      forced: die.forced,
    };
    for (const listener of [...this.listeners]) listener(event);
  }
}
