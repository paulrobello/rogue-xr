import RAPIER from '@dimforge/rapier3d-compat';
import {
  type CorrectionPlan,
  correctionPoseAt,
  D6_HALF_EXTENT,
  type DieKind,
  dieRadius,
  dieVertices,
  faceNormals,
  numberingOffset,
  planCorrection,
  upFace,
} from './faces.ts';
import { type Pose, QUAT_IDENTITY, type Quat, quatMul, type Vec3 } from './quat.ts';

/** Fixed simulation step. The renderer's frame rate never changes it. */
export const FIXED_STEP = 1 / 120;
/** The fallback seeded-face correction lasts this many simulated seconds (D1: about 100 ms). */
export const CORRECTION_SECONDS = 0.1;
export const CORRECTION_STEPS = Math.round(CORRECTION_SECONDS / FIXED_STEP);
/** Caps catch-up work after a long frame so the physics never spirals. */
export const MAX_SUBSTEPS = 10;
/**
 * The throw's look-ahead simulates at most this many fixed steps (10 s). Past it the die keeps its
 * plain numbering and the fallback settle correction turns the seeded face up.
 */
export const LOOKAHEAD_MAX_STEPS = 1200;

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

/**
 * Inner half-extent of the authored combat table's felt tray (`combat-table.manifest.json`
 * `trayInner.size` is 0.31 x 0.19). The dice world must be this size so a resting die cannot sit
 * past the visible wall.
 */
export const AUTHORED_TRAY_HALF = { halfX: 0.155, halfZ: 0.095 } as const;

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
  /** Rendered pose: the body's pose with the die's numbering offset applied. */
  pose: Pose;
  /** Simulated time from the throw until the die came to rest (or the forced correction began). */
  rollMs: number;
  /** Simulated time the correction took; 0 when the die rested on its predicted face. */
  correctionMs: number;
  /** True when the die never came to rest or left the tray, so a guard started the correction. */
  forced: boolean;
  /** True when the throw's look-ahead found the landing face and numbered the die for it. */
  predicted: boolean;
  /**
   * True when the die came to rest on a different face than its numbering expected, so the settle
   * correction had to tip the seeded face up.
   */
  fallback: boolean;
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
  /** Rendered orientation is `body * offset`, a rotation of the solid onto itself. */
  offset: Quat;
  /** Body face that carries `targetFace`'s label: the one the settle correction turns up. */
  bodyFace: number;
  predicted: boolean;
  fallback: boolean;
}

/** Why a rolling die stops rolling this step, or null while it rolls on. */
type SettleCause = 'settled' | 'forced' | null;

let rapierReady: Promise<void> | null = null;

/** Initialises the Rapier wasm module once per process; every `DiceWorld.create` awaits it. */
function initRapier(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

/**
 * Rapier world holding a table surface (top at y = 0), a four-wall tray and the dice thrown into it.
 * Coordinates are tray-local metres with +Y up, so the caller places the group on the combat table.
 * The engine decides each die's result before the throw (D1); physics only presents it. At the
 * throw a look-ahead runs the same fixed steps on a snapshot of this world to find the body face
 * the die will come to rest on, and the die is numbered (`DieEntry.offset`) so that face carries
 * `targetFace`'s label; the live die then lands on the seeded number by itself and is left where it
 * rests. Only when it lands off the prediction (another die knocked it) or a guard fires (it never
 * stops, or leaves the tray) is it tipped about its lowest contact point so `targetFace` is up,
 * eased over `CORRECTION_SECONDS` of simulated time.
 */
export class DiceWorld {
  private readonly world: RAPIER.World;
  private readonly options: DiceWorldOptions;
  private readonly dice = new Map<string, DieEntry>();
  private readonly listeners = new Set<SettledListener>();
  private accumulator = 0;
  private stepCount = 0;

  /** `restored` is a snapshot copy of another world, tray included: the throw's look-ahead. */
  private constructor(options: DiceWorldOptions, restored?: RAPIER.World) {
    this.options = options;
    if (restored) {
      this.world = restored;
      return;
    }
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

  /**
   * Throws a d6 and a d8 in a throwaway world and lets them settle, so the first throw of a fight
   * does not pay for Rapier's first snapshot, restore and contact paths (209 ms once on a slow
   * core against 7 ms later). Call it behind a loading screen; it draws on no random stream.
   */
  static async warmUp(): Promise<void> {
    const world = await DiceWorld.create();
    try {
      const spin = { x: 9, y: 4, z: -6 };
      world.throwDie(
        'warm-d6',
        'd6',
        { x: -0.05, y: 0.1, z: 0 },
        { x: 0.4, y: 0, z: 0.1 },
        spin,
        0,
      );
      world.throwDie(
        'warm-d8',
        'd8',
        { x: 0.05, y: 0.1, z: 0 },
        { x: -0.4, y: 0, z: -0.1 },
        spin,
        0,
      );
      for (let n = 0; n < LOOKAHEAD_MAX_STEPS && !world.allDone; n++) world.fixedStep();
    } finally {
      world.dispose();
    }
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
   * Throwing an id that is already in the world replaces that die. The look-ahead runs here, so the
   * die is numbered for its landing before the first live step.
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
    // A release at or past the rim would start the die inside a wall, and the 3 cm wall can push it out the far side.
    const reachX = Math.max(0, this.options.halfX - dieRadius(kind));
    const reachZ = Math.max(0, this.options.halfZ - dieRadius(kind));
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(
          Math.min(reachX, Math.max(-reachX, position.x)),
          position.y,
          Math.min(reachZ, Math.max(-reachZ, position.z)),
        )
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
    const die: DieEntry = {
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
      offset: QUAT_IDENTITY,
      bodyFace: targetFace,
      predicted: false,
      fallback: false,
    };
    this.dice.set(id, die);
    const landing = this.lookAhead(die);
    if (landing !== null) {
      die.offset = numberingOffset(kind, targetFace, landing);
      die.bodyFace = landing;
      die.predicted = true;
    }
  }

  /**
   * Runs this world forward on a snapshot copy until `die` stops rolling and returns the body face
   * then up, or null when only a guard would stop it or it is still rolling after
   * `LOOKAHEAD_MAX_STEPS`. The copy steps exactly as this world will: same state, same fixed step,
   * the same settle rule, and the other dice's corrections replayed.
   */
  private lookAhead(die: DieEntry): number | null {
    const scratch = new DiceWorld(
      this.options,
      RAPIER.World.restoreSnapshot(this.world.takeSnapshot()),
    );
    try {
      for (const entry of this.dice.values()) {
        scratch.dice.set(entry.id, {
          ...entry,
          body: scratch.world.getRigidBody(entry.body.handle),
        });
      }
      const ghost = scratch.dice.get(die.id) as DieEntry;
      for (let n = 0; n < LOOKAHEAD_MAX_STEPS && ghost.phase === 'rolling'; n++)
        scratch.fixedStep();
      if (ghost.phase === 'rolling' || ghost.forced) return null;
      return upFace(ghost.body.rotation(), faceNormals(die.kind));
    } finally {
      scratch.dispose();
    }
  }

  removeDie(id: string): void {
    const die = this.dice.get(id);
    if (die === undefined) return;
    this.world.removeRigidBody(die.body);
    this.dice.delete(id);
  }

  /**
   * The die's rendered pose as of the last fixed step, for the renderer to copy onto its mesh: the
   * body's pose with the numbering offset applied, so face `i` of the mesh shows label `i`.
   */
  pose(id: string): DiePose | undefined {
    const die = this.dice.get(id);
    if (die === undefined) return undefined;
    const t = die.body.translation();
    const r = die.body.rotation();
    return {
      phase: die.phase,
      position: { x: t.x, y: t.y, z: t.z },
      quaternion: quatMul({ x: r.x, y: r.y, z: r.z, w: r.w }, die.offset),
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
    const cause = this.settleCause(die);
    if (cause !== null) this.beginCorrection(die, cause === 'forced');
  }

  /** Counts one rolling step and decides whether the die stops rolling. */
  private settleCause(die: DieEntry): SettleCause {
    die.rollSteps++;
    const v = die.body.linvel();
    const w = die.body.angvel();
    const calm =
      Math.hypot(v.x, v.y, v.z) < SETTLE_LINEAR_SPEED &&
      Math.hypot(w.x, w.y, w.z) < SETTLE_ANGULAR_SPEED;
    die.calmSteps = calm ? die.calmSteps + 1 : 0;
    if (die.calmSteps >= SETTLE_STEPS) return 'settled';
    // A die that cleared the walls falls past the table edge; rescue it at once instead of after the timeout.
    const escaped = die.body.translation().y < -ESCAPE_DEPTH;
    const timedOut = die.rollSteps * FIXED_STEP >= this.options.maxRollSeconds;
    return timedOut || escaped ? 'forced' : null;
  }

  /**
   * Freezes the stopped die. A die resting with `bodyFace` up (the predicted landing) stays exactly
   * where physics left it, even cocked against a wall. Otherwise (a guard fired, or it landed off
   * the prediction) it is tipped about its lowest contact point so `bodyFace` is up.
   */
  private beginCorrection(die: DieEntry, forced: boolean): void {
    const t = die.body.translation();
    const r = die.body.rotation();
    const rest: Pose = {
      position: { x: t.x, y: t.y, z: t.z },
      quaternion: { x: r.x, y: r.y, z: r.z, w: r.w },
    };
    die.forced = forced;
    die.fallback = upFace(rest.quaternion, faceNormals(die.kind)) !== die.bodyFace;
    die.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
    die.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    die.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, false);
    // A kinematic body otherwise moves to the target the last dynamic step predicted.
    die.body.setNextKinematicTranslation(rest.position);
    die.body.setNextKinematicRotation(rest.quaternion);
    if (!forced && !die.fallback) {
      this.finish(die, rest);
      return;
    }
    const { halfX, halfZ } = this.options;
    die.plan = planCorrection(rest, die.kind, die.bodyFace, 0, { halfX, halfZ });
    die.phase = 'correcting';
    die.correctionStep = 0;
  }

  private advanceCorrecting(die: DieEntry): void {
    die.correctionStep++;
    if (die.correctionStep < CORRECTION_STEPS || die.plan === null) return;
    this.finish(die, correctionPoseAt(die.plan, 1));
  }

  /** Marks the die done at body pose `end` and reports its rendered pose to the listeners. */
  private finish(die: DieEntry, end: Pose): void {
    die.phase = 'done';
    const pose: Pose = { position: end.position, quaternion: quatMul(end.quaternion, die.offset) };
    const event: SettledEvent = {
      id: die.id,
      kind: die.kind,
      face: upFace(pose.quaternion, faceNormals(die.kind)),
      pose,
      rollMs: die.rollSteps * FIXED_STEP * 1000,
      correctionMs: die.correctionStep * FIXED_STEP * 1000,
      forced: die.forced,
      predicted: die.predicted,
      fallback: die.fallback,
    };
    for (const listener of [...this.listeners]) listener(event);
  }
}
