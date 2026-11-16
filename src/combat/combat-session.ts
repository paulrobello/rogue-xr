import * as THREE from 'three';
import type { SfxId } from '../audio/cues.ts';
import { CanvasLabel, roundRect } from '../combat-view/canvas-label.ts';
import { CombatController, type CombatOptions, type Stage } from '../combat-view/controller.ts';
import { intentText } from '../combat-view/index.ts';
import { getCard } from '../content/cards.ts';
import { dieById } from '../content/dice.ts';
import {
  ENCOUNTERS,
  type Encounter,
  type EncounterTier,
  encounterSetups,
} from '../content/enemies.ts';
import type { ActionBus, GameAction } from '../core/actions.ts';
import { Stream } from '../core/rng.ts';
import type { DieKind } from '../dice/faces.ts';
import { DicePresenter, type PresentedRoll } from '../dice/presenter.ts';
import type { DiceWorldOptions } from '../dice/world.ts';
import type { AimRay } from '../hand/aim.ts';
import { CardFan } from '../hand/card-fan.ts';
import { FlingController, type FlingTargetSite, rayFromObject } from '../hand/fling.ts';
import { PALETTE } from '../palette.ts';
import { type CombatEvent, intentDamage, PLAYER_ID } from '../rules/index.ts';
import {
  type PlatePose,
  platePoseAboveTable,
  platePoseFromNode,
  rayToPlate,
  SigilPlate,
} from '../sigil-plate/index.ts';
import type { EncounterDirector } from './encounter.ts';
import type { TablePose } from './placement.ts';

const DEG = Math.PI / 180;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Seconds the victory banner holds before the table folds and the room clears. */
export const WIN_HOLD_SECONDS = 1.2;
/** Seconds the defeat banner holds before the automatons go home. */
export const DEFEAT_HOLD_SECONDS = 1.6;
const PLATE_DONE_SECONDS = 1.6;
/** A sigil casts once the pen has been lifted this long, so multi-stroke glyphs (gear) can be drawn. */
export const SIGIL_CAST_SECONDS = 0.6;
/** The desktop drag plane sits this far above the table top, so a dragged card skims it. */
const DRAG_LIFT = 0.12;
const DRAG_REACH = 3;
const TIP_OFFSET = 0.06;
const TRAY_HALF_X = 0.2;
const TRAY_HALF_Z = 0.11;
const ENEMY_RADIUS = 0.5;

type Vec3T = readonly [number, number, number];

/** The audio cues the session plays; `AudioDirector` satisfies it. */
export interface CombatAudio {
  playSfx(id: SfxId, at?: { x: number; y: number; z: number }, volume?: number): boolean;
  playCombatEvent(event: CombatEvent, at?: { x: number; y: number; z: number }): SfxId | null;
  startLoop(id: SfxId, at?: { x: number; y: number; z: number }): boolean;
  stopLoop(id: SfxId): void;
}

/** XR inputs for one frame: the main-hand grip and target ray, and the off-hand grip that holds the fan. */
export interface XrHands {
  main: THREE.Object3D | null;
  mainRay: THREE.Object3D | null;
  off: THREE.Object3D | null;
}

/** The encounter the floor plan's room gets: one of its tier whose size matches the room's automatons. */
export function chooseEncounter(
  seed: string,
  room: number,
  tier: EncounterTier,
  count: number,
): Encounter {
  const fits = ENCOUNTERS[tier].filter((e) => e.enemies.length === count);
  return Stream.fromKey(`${seed}:room-${room}:encounter`).pick(
    fits.length > 0 ? fits : ENCOUNTERS[tier],
  );
}

/** A per-room combat seed derived from the run seed, so each fight shuffles and rolls its own way. */
export function fightSeed(seed: string, room: number): string {
  const s = Stream.fromKey(`${seed}:room-${room}:fight`);
  return Array.from({ length: 8 }, () => CROCKFORD[s.int(0, 31)]).join('');
}

function safeLabel(px: number, py: number, width: number): CanvasLabel | null {
  try {
    return new CanvasLabel(px, py, width);
  } catch {
    return null;
  }
}

export interface CombatSessionDeps {
  /** Run seed. */
  seed: string;
  room: number;
  tier: EncounterTier;
  tablePose: TablePose;
  /** The room's automaton stand-ins, already moved to their combat places. */
  bodies: readonly THREE.Object3D[];
  /** Untransformed world root; every combat visual is added here in world coordinates. */
  root: THREE.Object3D;
  /** Desktop camera: the hand strip hangs in front of it and mouse sigils project through it. */
  camera: THREE.Camera;
  sockets: { diceTray: THREE.Object3D | null; sigilPlate: THREE.Object3D | null };
  actions: ActionBus;
  /** Called once the fight is decided and its banner has held. */
  end: (outcome: 'win' | 'defeat') => void;
  audio?: CombatAudio;
  /** Debug cheats and deck override passed to the controller. */
  options?: Pick<CombatOptions, 'enemyHp' | 'playerHp' | 'deck'>;
  /** Typeset card labels with troika (off in tests). */
  syncLabels?: boolean;
  dice?: Partial<DiceWorldOptions>;
}

export type SessionStage = Stage | 'dice';

/** What a combat pickable is, for scripted pointer tests and the debug hook. */
export type CombatPick = 'card' | 'enemy' | 'end-turn' | 'throw' | 'plate' | 'table';

/**
 * One fight on the exploration floor, alive while the encounter is `active`. It owns the
 * `CombatController` for the room's encounter and every combat visual: the card fan (camera strip on
 * the desktop, off-hand grip in XR), the fling, the dice in the tray, the sigil plate, End Turn and
 * Throw controls and the enemy readouts. Input arrives only through the action bus.
 */
export class CombatSession {
  readonly controller: CombatController;
  readonly room: number;
  readonly fan: CardFan;
  readonly fling: FlingController;
  readonly dice: DicePresenter;
  readonly plate = new SigilPlate();
  /** Parent of the desktop hand strip; a child of the camera. */
  readonly handAnchor = new THREE.Group();
  /** The desktop virtual grip a dragged card follows: the mouse ray on the drag plane. */
  readonly mouseGrip = new THREE.Object3D();
  /** Rolls the presenter showed, newest last. */
  readonly rolls: PresentedRoll[] = [];
  /** Victory or defeat banner text, or ''. */
  banner = '';
  /** Latest prompt or refusal, for the HUD. */
  message = '';

  private readonly deps: CombatSessionDeps;
  private readonly pose: TablePose;
  private readonly group = new THREE.Group();
  private readonly enemyIds: string[];
  private readonly bodies: THREE.Object3D[];
  private readonly hidden: THREE.Object3D[] = [];
  private readonly endButton: THREE.Mesh;
  private readonly throwButton: THREE.Mesh;
  private readonly trayHit: THREE.Mesh;
  private readonly labels: { id: string; label: CanvasLabel }[] = [];
  private readonly status: CanvasLabel | null;
  private readonly endLabel: CanvasLabel | null;
  private readonly throwLabel: CanvasLabel | null;
  private readonly disposers: (() => void)[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private platePose: PlatePose;
  private handKey = '';
  private lastDice: CombatController['lastDice'] = null;
  private pendingThrow: { kind: DieKind; face: number; value: number } | null = null;
  private lastRay: AimRay | null = null;
  private lastNdc: readonly [number, number] | null = null;
  private holding: 'mouse' | 'xr' | null = null;
  private drawing: 'mouse' | 'xr' | null = null;
  private plateDone = 0;
  private castTimer = -1;
  private endTimer = -1;
  private ended = false;
  private disposed = false;
  private xr: XrHands | null = null;
  private dirty = true;

  private constructor(deps: CombatSessionDeps, dice: DicePresenter) {
    this.deps = deps;
    this.room = deps.room;
    this.pose = deps.tablePose;
    this.dice = dice;
    const [rx, rz] = [Math.cos(deps.tablePose.yaw * DEG), Math.sin(deps.tablePose.yaw * DEG)];
    const lateral = (o: THREE.Object3D) => {
      const w = o.getWorldPosition(new THREE.Vector3());
      return (w.x - this.pose.x) * rx + (w.z - this.pose.z) * rz;
    };
    // Left to right across the table, the order the director placed them in.
    this.bodies = [...deps.bodies].sort((a, b) => lateral(a) - lateral(b));
    const encounter = chooseEncounter(deps.seed, deps.room, deps.tier, this.bodies.length);
    this.controller = new CombatController({
      ...deps.options,
      seed: fightSeed(deps.seed, deps.room),
      setups: encounterSetups(encounter),
    });
    this.enemyIds = this.controller.state.enemies.map((e) => e.id);
    for (const body of this.bodies.slice(this.enemyIds.length)) {
      if (body.visible) this.hidden.push(body);
      body.visible = false;
    }

    this.group.name = 'combat-session';
    deps.root.add(this.group);
    const yawRad = -this.pose.yaw * DEG;
    const fx = Math.sin(this.pose.yaw * DEG);
    const fz = -Math.cos(this.pose.yaw * DEG);
    const onTable = (right: number, forward: number, lift: number) =>
      new THREE.Vector3(
        this.pose.x + rx * right + fx * forward,
        this.pose.height + lift,
        this.pose.z + rz * right + fz * forward,
      );

    // Dice tray: the table's socket, or the greybox tray spot.
    const tray = deps.sockets.diceTray;
    if (tray) {
      tray.updateWorldMatrix(true, false);
      dice.root.position.setFromMatrixPosition(tray.matrixWorld);
    } else dice.root.position.copy(onTable(0, 0.18, 0));
    dice.root.rotation.y = yawRad;
    this.group.add(dice.root);
    this.trayHit = new THREE.Mesh(
      new THREE.BoxGeometry(TRAY_HALF_X * 2, 0.08, TRAY_HALF_Z * 2),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    this.trayHit.name = 'dice-tray-hit';
    this.trayHit.position.y = 0.04;
    dice.root.add(this.trayHit);

    const button = (name: string, color: string, at: THREE.Vector3): THREE.Mesh => {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 0.03, 0.09),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.4 }),
      );
      mesh.name = name;
      mesh.position.copy(at);
      mesh.rotation.y = yawRad;
      this.group.add(mesh);
      return mesh;
    };
    this.endButton = button('end-turn', PALETTE.walnut, onTable(0.55, -0.28, 0.02));
    this.throwButton = button('throw-dice', PALETTE.brassDark, onTable(-0.55, -0.28, 0.02));
    const buttonLabel = (mesh: THREE.Mesh, text: string): CanvasLabel | null => {
      const label = safeLabel(256, 96, 0.2);
      if (!label) return null;
      label.mesh.position.set(0, 0.017, 0);
      label.mesh.rotation.x = -Math.PI / 2;
      mesh.add(label.mesh);
      label.draw((ctx, w, h) => {
        ctx.fillStyle = PALETTE.parchment;
        ctx.font = 'bold 44px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, w / 2, h / 2);
      });
      return label;
    };
    this.endLabel = buttonLabel(this.endButton, 'END TURN');
    this.throwLabel = buttonLabel(this.throwButton, 'THROW');

    this.status = safeLabel(512, 256, 0.5);
    if (this.status) {
      this.status.mesh.position.copy(onTable(-0.6, 0.15, 0.45));
      this.status.mesh.rotation.y = yawRad;
      this.group.add(this.status.mesh);
    }
    this.enemyIds.forEach((id, i) => {
      const body = this.bodies[i];
      const label = safeLabel(384, 160, 0.6);
      if (!body || !label) return;
      const at = body.getWorldPosition(new THREE.Vector3());
      label.mesh.position.set(at.x, at.y + (body.userData.tier === 'guardian' ? 1.3 : 0.75), at.z);
      label.mesh.rotation.y = yawRad;
      this.group.add(label.mesh);
      this.labels.push({ id, label });
    });

    this.platePose = deps.sockets.sigilPlate
      ? platePoseFromNode(deps.sockets.sigilPlate)
      : platePoseAboveTable(this.pose);
    this.plate.hide();
    deps.root.add(this.plate);

    this.handAnchor.name = 'desktop-hand';
    this.handAnchor.position.set(0, -0.26, -0.42);
    this.handAnchor.rotation.x = 0.2;
    this.handAnchor.scale.setScalar(0.9);
    deps.camera.add(this.handAnchor);
    this.mouseGrip.name = 'mouse-grip';
    this.group.add(this.mouseGrip);

    this.fan = new CardFan({ syncLabels: deps.syncLabels ?? true, mainGrip: this.mouseGrip });
    this.fan.attach(this.handAnchor);
    this.fling = new FlingController({
      fan: this.fan,
      combat: this.controller,
      targets: () => this.targetSites(),
      table: () => ({ pose: this.pose }),
      pointRay: () => this.pointRay(),
      mainGrip: this.mouseGrip,
    });

    this.disposers.push(
      this.controller.subscribe((update) => {
        if (update.type === 'invalid') this.message = update.reason;
        else this.dirty = true;
      }),
      dice.onSettled((roll) => {
        this.rolls.push(roll);
        this.message = `Rolled ${roll.value}`;
        this.sfx('dice-settle', dice.root.position);
      }),
      deps.actions.on('combat-pointer', (a) => this.pointer(a)),
      deps.actions.on('combat-hand', (a) => this.hand(a)),
      deps.actions.on('end-turn', () => this.endTurn()),
      deps.actions.on('throw-dice', () => this.throwDice()),
      deps.actions.on('combat-cancel', () => this.cancel()),
    );
    this.sync();
  }

  /** Builds the session (the dice physics loads asynchronously). */
  static async create(deps: CombatSessionDeps): Promise<CombatSession> {
    const stream = Stream.fromKey(`${deps.seed}:room-${deps.room}:dice-throw`);
    const presenter = await DicePresenter.create(
      stream,
      { halfX: TRAY_HALF_X, halfZ: TRAY_HALF_Z },
      deps.dice,
    );
    return new CombatSession(deps, presenter);
  }

  /** The combat stage for the HUD: the controller's, or `dice` while a rolled die waits to be thrown. */
  get stage(): SessionStage {
    if (this.controller.stage === 'over') return 'over';
    return this.pendingThrow ? 'dice' : this.controller.stage;
  }

  get log(): readonly string[] {
    return this.controller.log;
  }

  get awaitingThrow(): boolean {
    return this.pendingThrow !== null;
  }

  /** The rules enemy id for each stand-in body, left to right. */
  get enemies(): readonly { id: string; body: THREE.Object3D }[] {
    return this.enemyIds.flatMap((id, i) => {
      const body = this.bodies[i];
      return body ? [{ id, body }] : [];
    });
  }

  /** One HUD line. */
  hudText(): string {
    const { player, turn } = this.controller.state;
    const foes = this.controller.state.enemies
      .map((e) => `${e.name} ${e.hp}/${e.maxHp}${e.block ? ` [${e.block}]` : ''}`)
      .join(', ');
    const msg = this.message ? ` · ${this.message}` : '';
    return `combat ${this.stage} · turn ${turn} · HP ${player.hp}/${player.maxHp}${player.block ? ` [${player.block}]` : ''} · steam ${player.steam} · ${foes}${msg}`;
  }

  /** World position of a pickable, for scripted pointer tests (plate: `u`, `v` in 0..1). */
  worldOf(kind: CombatPick, key?: number | string, u = 0.5, v = 0.5): THREE.Vector3 | null {
    this.deps.root.updateWorldMatrix(true, true);
    this.deps.camera.updateWorldMatrix(true, true);
    switch (kind) {
      case 'card': {
        const index = this.controller.state.piles.hand.findIndex((c) => c.uid === key);
        const slot = this.fan.layout[index];
        if (!slot) return null;
        this.fan.root.updateWorldMatrix(true, false);
        return this.fan.root.localToWorld(new THREE.Vector3(...slot.position));
      }
      case 'enemy':
        return (
          this.enemies.find((e) => e.id === key)?.body.getWorldPosition(new THREE.Vector3()) ?? null
        );
      case 'end-turn':
        return this.endButton.getWorldPosition(new THREE.Vector3());
      case 'throw':
        return this.throwButton.getWorldPosition(new THREE.Vector3());
      case 'plate': {
        const p = this.platePose;
        const x = (u - 0.5) * 2 * p.halfWidth;
        const y = (v - 0.5) * 2 * p.halfHeight;
        return new THREE.Vector3(
          p.center.x + p.right.x * x + p.up.x * y,
          p.center.y + p.right.y * x + p.up.y * y,
          p.center.z + p.right.z * x + p.up.z * y,
        );
      }
      case 'table': {
        const fx = Math.sin(this.pose.yaw * DEG);
        const fz = -Math.cos(this.pose.yaw * DEG);
        return new THREE.Vector3(
          this.pose.x - fx * 0.15,
          this.pose.height + 0.02,
          this.pose.z - fz * 0.15,
        );
      }
    }
  }

  /** The current sigil plate pose, world space. */
  get platePoseNow(): PlatePose {
    return this.platePose;
  }

  /** True when a pointer press along this ray would land on a combat control (the desktop bridge claims it). */
  claims(origin: Vec3T, direction: Vec3T): boolean {
    if (this.disposed || this.controller.outcome !== null) return false;
    const ray = new THREE.Ray(new THREE.Vector3(...origin), new THREE.Vector3(...direction));
    return this.hitAt(ray) !== null;
  }

  /** Per-frame step. `xr` is the tracked hands while presenting, null on the desktop. */
  update(dt: number, xr: XrHands | null = null): void {
    if (this.disposed) return;
    this.setXr(xr);
    if (this.dirty) this.sync();
    if (this.xr && this.holding === null && this.xr.mainRay) {
      const r = rayFromObject(this.xr.mainRay);
      this.fan.pointerHover(
        new THREE.Ray(new THREE.Vector3(...r.origin), new THREE.Vector3(...r.direction)),
      );
    }
    if (this.drawing === 'xr' && this.xr?.main) {
      const tip = this.tipOf(this.xr.main);
      const ray = this.xr.mainRay ? rayFromObject(this.xr.mainRay) : null;
      const added =
        this.plate.addTip(tip) ||
        (ray !== null && this.plate.addRay(toV(ray.origin), toV(ray.direction)));
      if (added) this.deps.audio?.startLoop('sigil-trace', this.platePose.center);
    }
    if (this.castTimer > 0 && this.drawing === null) {
      this.castTimer -= dt;
      if (this.castTimer <= 0) this.finishSigil();
    }
    this.fling.update(dt);
    this.fan.update(dt);
    this.dice.update(dt);
    this.plate.update(dt);
    if (this.plate.phase === 'done') {
      this.plateDone += dt;
      if (this.plateDone >= PLATE_DONE_SECONDS) this.plate.hide();
    }
    const outcome = this.controller.outcome;
    if (outcome !== null && !this.ended) {
      if (this.endTimer < 0) {
        this.endTimer = outcome === 'won' ? WIN_HOLD_SECONDS : DEFEAT_HOLD_SECONDS;
        this.banner = outcome === 'won' ? 'VICTORY' : 'DEFEAT';
        this.sfx(outcome === 'won' ? 'victory-sting' : 'defeat-sting');
        this.paint();
      }
      this.endTimer -= dt;
      if (this.endTimer <= 0) {
        this.ended = true;
        this.deps.end(outcome === 'won' ? 'win' : 'defeat');
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deps.audio?.stopLoop('sigil-trace');
    for (const off of this.disposers.splice(0)) off();
    this.fan.dispose();
    this.fan.detach();
    this.dice.dispose();
    this.plate.dispose();
    this.plate.removeFromParent();
    this.handAnchor.removeFromParent();
    for (const { label } of this.labels) label.dispose();
    this.status?.dispose();
    this.endLabel?.dispose();
    this.throwLabel?.dispose();
    for (const mesh of [this.endButton, this.throwButton, this.trayHit]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
    for (const body of this.bodies) if (body.parent) body.visible = true;
    for (const body of this.hidden) body.visible = true;
  }

  // ---- input -----------------------------------------------------------------------------------

  private pointer(action: Extract<GameAction, { type: 'combat-pointer' }>): void {
    if (this.xr || this.disposed) return;
    this.lastRay = { origin: action.origin, direction: action.direction };
    this.lastNdc = action.ndc ?? null;
    const ray = new THREE.Ray(
      new THREE.Vector3(...action.origin),
      new THREE.Vector3(...action.direction).normalize(),
    );
    if (action.phase === 'move') {
      if (this.drawing === 'mouse') this.feedMouse(ray);
      else if (this.holding === 'mouse') this.placeMouseGrip(ray);
      else this.fan.pointerHover(ray);
      return;
    }
    if (action.phase === 'up') {
      if (this.drawing === 'mouse') this.liftPen();
      if (this.holding === 'mouse') this.release(ray);
      return;
    }
    if (this.controller.outcome !== null) return;
    const hit = this.hitAt(ray);
    if (hit === 'throw' || hit === 'tray') this.throwDice();
    else if (hit === 'plate') {
      this.plate.beginStroke();
      this.castTimer = -1;
      this.drawing = 'mouse';
      this.feedMouse(ray);
    } else if (hit === 'end-turn') this.endTurn();
    else if (typeof hit === 'number') {
      this.placeMouseGrip(ray);
      this.grab(hit, 'mouse');
    }
  }

  private hand(action: Extract<GameAction, { type: 'combat-hand' }>): void {
    const xr = this.xr;
    if (!xr || action.hand !== 'main' || this.disposed) return;
    if (action.control === 'squeeze') {
      if (action.pressed) {
        const index = this.fan.hovered;
        if (index !== null && this.controller.outcome === null) this.grab(index, 'xr');
      } else if (this.holding === 'xr') this.release(null);
      return;
    }
    if (!action.pressed) {
      if (this.drawing === 'xr') this.liftPen();
      return;
    }
    if (this.controller.outcome !== null) return;
    if (this.pendingThrow) {
      this.throwDice();
      return;
    }
    if (this.plateLive()) {
      this.plate.beginStroke();
      this.castTimer = -1;
      this.drawing = 'xr';
      return;
    }
    if (xr.mainRay) {
      const r = rayFromObject(xr.mainRay);
      const hit = this.hitAt(
        new THREE.Ray(new THREE.Vector3(...r.origin), new THREE.Vector3(...r.direction)),
      );
      if (hit === 'end-turn') this.endTurn();
      else if (hit === 'throw' || hit === 'tray') this.throwDice();
    }
  }

  private grab(index: number, by: 'mouse' | 'xr'): void {
    if (this.pendingThrow) {
      this.message = 'Throw the dice first';
      return;
    }
    if (this.fling.grab(index)) {
      this.holding = by;
      this.message = '';
      this.sfx('card-draw', this.fan.root.getWorldPosition(new THREE.Vector3()));
    }
  }

  private release(ray: THREE.Ray | null): void {
    if (ray) this.placeMouseGrip(ray);
    this.holding = null;
    const decision = this.fling.release();
    if (decision?.outcome === 'sprung-back' && decision.reason) this.message = decision.reason;
    if (decision?.outcome === 'staged') this.message = 'Draw the sigil on the plate';
  }

  private endTurn(): void {
    if (this.disposed || this.controller.outcome !== null) return;
    if (this.pendingThrow) {
      this.message = 'Throw the dice first';
      return;
    }
    this.fling.abortStaged();
    this.plate.hide();
    this.sfx('ui-tick');
    this.controller.endTurn();
    this.message = '';
  }

  private throwDice(): void {
    if (this.disposed) return;
    const pending = this.pendingThrow;
    if (!pending) {
      this.message = 'No dice to throw';
      return;
    }
    this.pendingThrow = null;
    this.dice.throw(pending.kind, pending.face, pending.value);
    this.sfx('dice-roll', this.dice.root.position);
    this.message = '';
    this.paint();
  }

  private cancel(): void {
    this.castTimer = -1;
    if (this.drawing) {
      this.drawing = null;
      this.deps.audio?.stopLoop('sigil-trace');
    }
    this.plate.hide();
    this.fling.abortStaged();
    this.controller.cancel();
  }

  /** Ends a stroke; the glyph casts after `SIGIL_CAST_SECONDS` unless another stroke starts. */
  private liftPen(): void {
    this.drawing = null;
    this.deps.audio?.stopLoop('sigil-trace');
    this.plate.endStroke();
    this.castTimer = SIGIL_CAST_SECONDS;
  }

  private finishSigil(): void {
    this.castTimer = -1;
    if (!this.plateLive()) return;
    const result = this.plate.finish();
    if (!result) {
      this.message = 'Trace too short, draw the glyph';
      return;
    }
    const played = this.controller.submitSigil(this.plate.strokes);
    this.plateDone = 0;
    this.sfx(
      played.ok && result.quality !== 'Fizzle' ? 'sigil-cast' : 'sigil-fizzle',
      this.platePose.center,
    );
  }

  private feedMouse(ray: THREE.Ray): void {
    const ndc = this.lastNdc;
    const added = ndc
      ? this.plate.addMouse({ x: ndc[0], y: ndc[1] }, this.deps.camera)
      : this.plate.addRay(toV(ray.origin.toArray()), toV(ray.direction.toArray()));
    if (added) this.deps.audio?.startLoop('sigil-trace', this.platePose.center);
  }

  /** The desktop drag plane: the mouse ray meets a plane just above the table top. */
  private placeMouseGrip(ray: THREE.Ray): void {
    const planeY = this.pose.height + DRAG_LIFT;
    const dy = ray.direction.y;
    let t = Math.abs(dy) > 1e-6 ? (planeY - ray.origin.y) / dy : -1;
    const at = new THREE.Vector3();
    if (t > 0) ray.at(t, at);
    if (t <= 0 || Math.hypot(at.x - this.pose.x, at.z - this.pose.z) > DRAG_REACH) {
      t = 1.2;
      ray.at(t, at);
    }
    this.mouseGrip.position.copy(at);
    this.deps.camera.getWorldQuaternion(this.mouseGrip.quaternion);
    this.mouseGrip.updateMatrixWorld(true);
  }

  private hitAt(ray: THREE.Ray): 'throw' | 'tray' | 'plate' | 'end-turn' | number | null {
    this.raycaster.ray.copy(ray);
    this.group.updateWorldMatrix(true, true);
    if (this.pendingThrow) {
      if (this.raycaster.intersectObject(this.throwButton, false).length > 0) return 'throw';
      if (this.raycaster.intersectObject(this.trayHit, false).length > 0) return 'tray';
    }
    if (this.plateLive()) {
      const hit = rayToPlate(
        this.platePose,
        toV(ray.origin.toArray()),
        toV(ray.direction.toArray()),
      );
      if (
        hit &&
        Math.abs(hit.x) <= this.platePose.halfWidth &&
        Math.abs(hit.y) <= this.platePose.halfHeight
      )
        return 'plate';
    }
    if (this.raycaster.intersectObject(this.endButton, false).length > 0) return 'end-turn';
    if (this.raycaster.intersectObject(this.throwButton, false).length > 0) return 'throw';
    const card = this.fan.pointerHover(ray);
    return card;
  }

  private plateLive(): boolean {
    return (
      this.controller.stage === 'sigil' &&
      (this.plate.phase === 'ready' || this.plate.phase === 'drawing')
    );
  }

  // ---- state to visuals ------------------------------------------------------------------------

  private sync(): void {
    this.dirty = false;
    const state = this.controller.state;
    for (const event of this.controller.drainEvents()) {
      const target = 'target' in event ? (event.target as string | null) : null;
      const enemyId = 'enemyId' in event ? (event.enemyId as string) : target;
      const body =
        enemyId && enemyId !== PLAYER_ID
          ? this.enemies.find((e) => e.id === enemyId)?.body
          : undefined;
      const at = body?.getWorldPosition(new THREE.Vector3());
      this.deps.audio?.playCombatEvent(event, at);
    }
    const key = state.piles.hand.map((c) => c.uid).join(',');
    if (key !== this.handKey) {
      this.handKey = key;
      this.fan.setHand(
        state.piles.hand.map((c) => getCard(c.def.id)),
        state.piles.hand.map((c) => c.uid),
      );
    }
    if (this.controller.lastDice !== this.lastDice) {
      this.lastDice = this.controller.lastDice;
      const roll = this.lastDice;
      const dieId = roll ? getCard(roll.cardId).dice : undefined;
      if (roll && dieId) {
        const die = dieById(dieId);
        this.pendingThrow = {
          kind: die.faces.length === 6 ? 'd6' : 'd8',
          face: die.faces.indexOf(roll.value),
          value: roll.value,
        };
        this.message = `Throw the ${die.name}`;
      }
    }
    const awaited = this.controller.awaitedSigil;
    if (awaited && this.plate.phase === 'hidden') this.plate.show(awaited, this.platePose);
    else if (!awaited && (this.plate.phase === 'ready' || this.plate.phase === 'drawing'))
      this.plate.hide();
    state.enemies.forEach((enemy, i) => {
      const body = this.bodies[i];
      if (body) body.visible = enemy.hp > 0;
    });
    this.paint();
  }

  private paint(): void {
    const state = this.controller.state;
    for (const { id, label } of this.labels) {
      const enemy = state.enemies.find((e) => e.id === id);
      if (!enemy) continue;
      label.mesh.visible = enemy.hp > 0;
      label.draw((ctx, w, h) => {
        ctx.fillStyle = 'rgba(18,12,7,0.82)';
        roundRect(ctx, 4, 4, w - 8, h - 8, 14);
        ctx.fill();
        ctx.fillStyle = PALETTE.parchment;
        ctx.font = 'bold 34px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${enemy.name}  ${enemy.hp}/${enemy.maxHp}`, w / 2, 52);
        ctx.font = '600 28px system-ui, sans-serif';
        ctx.fillStyle = PALETTE.candle;
        const intent = intentText(enemy, intentDamage(state, enemy.id));
        ctx.fillText(`${intent}${enemy.block ? `  [${enemy.block} block]` : ''}`, w / 2, 110);
      });
    }
    this.status?.draw((ctx, w, h) => {
      ctx.fillStyle = 'rgba(18,12,7,0.82)';
      roundRect(ctx, 4, 4, w - 8, h - 8, 16);
      ctx.fill();
      ctx.fillStyle = PALETTE.parchment;
      ctx.font = 'bold 36px system-ui, sans-serif';
      const p = state.player;
      ctx.fillText(`HP ${p.hp}/${p.maxHp}${p.block ? `  [${p.block}]` : ''}`, 24, 60);
      ctx.fillText(`Steam ${p.steam}   Turn ${state.turn}`, 24, 110);
      ctx.fillStyle = PALETTE.candle;
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.fillText(this.banner || `Stage: ${this.stage}`, 24, 170);
      const last = this.rolls[this.rolls.length - 1];
      if (last) ctx.fillText(`Last roll ${last.value}`, 24, 220);
    });
    (this.throwButton.material as THREE.MeshStandardMaterial).emissive.set(
      this.pendingThrow ? PALETTE.brass : '#000000',
    );
  }

  private targetSites(): FlingTargetSite[] {
    return this.enemies.map(({ id, body }) => {
      const p = body.getWorldPosition(new THREE.Vector3());
      return { id, position: [p.x, p.y, p.z], radius: ENEMY_RADIUS };
    });
  }

  private pointRay(): AimRay | null {
    if (this.xr?.mainRay) return rayFromObject(this.xr.mainRay);
    return this.lastRay;
  }

  private tipOf(grip: THREE.Object3D): { x: number; y: number; z: number } {
    grip.updateWorldMatrix(true, false);
    const p = new THREE.Vector3(0, 0, -TIP_OFFSET).applyMatrix4(grip.matrixWorld);
    return { x: p.x, y: p.y, z: p.z };
  }

  private setXr(xr: XrHands | null): void {
    const next = xr?.off && xr.main ? xr : null;
    const was = this.xr;
    this.xr = next;
    if (next) {
      if (this.fan.root.parent !== next.off) this.fan.attach(next.off as THREE.Object3D);
      if (was?.main !== next.main) {
        this.fling.setMainGrip(next.main ?? undefined);
        this.fan.setMainGrip(next.main ?? undefined);
      }
    } else if (was || this.fan.root.parent !== this.handAnchor) {
      this.fan.attach(this.handAnchor);
      this.fling.setMainGrip(this.mouseGrip);
      this.fan.setMainGrip(this.mouseGrip);
    }
  }

  private sfx(id: SfxId, at?: { x: number; y: number; z: number }): void {
    this.deps.audio?.playSfx(id, at ? { x: at.x, y: at.y, z: at.z } : undefined);
  }
}

function toV(v: readonly number[]): { x: number; y: number; z: number } {
  return { x: v[0] as number, y: v[1] as number, z: v[2] as number };
}

export interface CombatHookFloor {
  seed: string;
  encounter: Pick<EncounterDirector, 'phase' | 'activeRoom' | 'tablePose' | 'end'>;
  world: {
    plan: { rooms: readonly ({ encounter: { tier: EncounterTier } | null } | undefined)[] };
    enemies: ReadonlyMap<number, readonly THREE.Object3D[]>;
    group: THREE.Object3D;
  };
  tableSockets(): CombatSessionDeps['sockets'];
}

export interface CombatHookDeps {
  floor: CombatHookFloor;
  camera: THREE.Camera;
  actions: ActionBus;
  audio?: CombatAudio;
  options?: CombatSessionDeps['options'];
  /** Per-fight options read when each session opens (the run's deck and hp); wins over `options`. */
  fightOptions?: () => CombatSessionDeps['options'];
  syncLabels?: boolean;
  dice?: Partial<DiceWorldOptions>;
  /** Called with each new session, e.g. for a debug handle. */
  onSession?: (session: CombatSession | null) => void;
  /** Called once a fight is decided and its banner has held, with the player's remaining hp. */
  onEnd?: (end: { room: number; outcome: 'win' | 'defeat'; playerHp: number | null }) => void;
}

/**
 * Floor-loop glue: opens a `CombatSession` when the encounter goes `active` and tears it down when
 * the encounter leaves `active`. Call `update(dt, xr)` every frame after the floor view updates.
 */
export class CombatHook {
  session: CombatSession | null = null;
  /** The last fight's banner, kept for a few seconds after the session closes. */
  banner = '';
  private bannerTimer = 0;
  private pending: { room: number; promise: Promise<CombatSession> } | null = null;
  private readonly deps: CombatHookDeps;
  private disposed = false;

  constructor(deps: CombatHookDeps) {
    this.deps = deps;
  }

  /** Resolves when a session is open, for tests and scripted checks. */
  async ready(): Promise<CombatSession | null> {
    if (this.pending) await this.pending.promise;
    return this.session;
  }

  update(dt: number, xr: XrHands | null = null): void {
    if (this.disposed) return;
    const { encounter } = this.deps.floor;
    const active = encounter.phase === 'active';
    if (this.session && (!active || encounter.activeRoom !== this.session.room)) this.close();
    if (active && !this.session && !this.pending) this.open();
    this.session?.update(dt, xr);
    if (this.session?.banner) {
      this.banner = this.session.banner;
      this.bannerTimer = 3;
    } else if (!this.session && this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner = '';
    }
  }

  dispose(): void {
    this.disposed = true;
    this.close();
  }

  private open(): void {
    const { floor } = this.deps;
    const room = floor.encounter.activeRoom;
    const pose = floor.encounter.tablePose;
    const tier = floor.world.plan.rooms[room]?.encounter?.tier;
    if (!pose || !tier) return;
    const bodies = (floor.world.enemies.get(room) ?? []).filter((b) => b.parent !== null);
    const options = this.deps.fightOptions?.() ?? this.deps.options;
    const promise = CombatSession.create({
      seed: floor.seed,
      room,
      tier,
      tablePose: pose,
      bodies,
      root: floor.world.group,
      camera: this.deps.camera,
      sockets: floor.tableSockets(),
      actions: this.deps.actions,
      end: (outcome) => {
        const playerHp = this.session?.controller.state.player.hp ?? null;
        floor.encounter.end(outcome);
        this.deps.onEnd?.({ room, outcome, playerHp });
      },
      ...(this.deps.audio ? { audio: this.deps.audio } : {}),
      ...(options ? { options } : {}),
      ...(this.deps.syncLabels === undefined ? {} : { syncLabels: this.deps.syncLabels }),
      ...(this.deps.dice ? { dice: this.deps.dice } : {}),
    });
    this.pending = { room, promise };
    void promise.then(
      (session) => {
        this.pending = null;
        const still =
          !this.disposed &&
          floor.encounter.phase === 'active' &&
          floor.encounter.activeRoom === room;
        if (!still) {
          session.dispose();
          return;
        }
        this.session = session;
        this.deps.onSession?.(session);
      },
      (error: unknown) => {
        this.pending = null;
        console.error('combat session failed to start', error);
      },
    );
  }

  private close(): void {
    if (!this.session) return;
    this.session.dispose();
    this.session = null;
    this.deps.onSession?.(null);
  }
}
