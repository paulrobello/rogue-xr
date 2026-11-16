import * as THREE from 'three';
import type { SfxId } from '../audio/cues.ts';
import { CanvasLabel, roundRect } from '../combat-view/canvas-label.ts';
import {
  CombatController,
  type CombatOptions,
  describeEvent,
  type Stage,
} from '../combat-view/controller.ts';
import {
  type EnemyBeat,
  foldEvents,
  type PlayerHit,
  playerHit,
  segmentEvents,
  type TurnSegment,
} from '../combat-view/enemy-turn.ts';
import { HIT_RED } from '../combat-view/hit-feedback.ts';
import { intentChips } from '../combat-view/index.ts';
import { getCard } from '../content/cards.ts';
import { dieById } from '../content/dice.ts';
import { type EncounterTier, encounterSetups } from '../content/enemies.ts';
import type { ActionBus, GameAction } from '../core/actions.ts';
import { Stream } from '../core/rng.ts';
import { type DiceAsset, loadDice } from '../dice/dice-asset.ts';
import type { DieKind } from '../dice/faces.ts';
import { DicePresenter, type PresentedRoll } from '../dice/presenter.ts';
import type { DiceWorldOptions } from '../dice/world.ts';
import type { SentryActor } from '../enemies/sentry-asset.ts';
import type { AimRay } from '../hand/aim.ts';
import { CardFan } from '../hand/card-fan.ts';
import { DEFAULT_FAN, GRIP_FAN_ORIGIN } from '../hand/fan-layout.ts';
import { FlingController, type FlingTargetSite, rayFromObject } from '../hand/fling.ts';
import { PALETTE } from '../palette.ts';
import {
  type CombatEvent,
  type CombatState,
  type Difficulty,
  intentDamage,
  PLAYER_ID,
} from '../rules/index.ts';
import {
  type PlatePose,
  plateLabelCorners,
  platePoseAboveTable,
  platePoseFromNode,
  rayToPlate,
  SigilPlate,
} from '../sigil-plate/index.ts';
import { type IconId, STATUS_ICON } from '../ui/icon-atlas.ts';
import {
  drawIconRow,
  type IconSheet,
  iconSheet,
  iconSheetOnFirstRender,
} from '../ui/icon-sheet.ts';
import type { EncounterDirector } from './encounter.ts';
import { chooseEncounter, enemyKindOf, fightSeed } from './encounter-choice.ts';
import type { TablePose } from './placement.ts';

export { chooseEncounter, fightSeed } from './encounter-choice.ts';

const DEG = Math.PI / 180;
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
/** How to trace a glyph with controllers, shown above the plate and as the staged-card message. */
export const XR_SIGIL_HINT = 'Hold the trigger and point at the plate to trace the glyph';
const TRAY_HALF_X = 0.2;
const TRAY_HALF_Z = 0.11;
const ENEMY_RADIUS = 0.5;
/** The HUD stays inside this normalized device extent of the desktop view (1 is the screen edge). */
const HUD_VIEW_MARGIN = 0.92;
/** Clear space left between HUD panels in the desktop view, in normalized device units. */
const HUD_GAP = 0.04;
/** The status panel is drawn at this scale in the desktop view, so it clears the sigil plate at close tables. */
const DESKTOP_STATUS_SCALE = 0.8;
/**
 * XR layout of the player's status panel, table metres (right, toward the enemies, above the top):
 * up and left of the sigil plate, turned to face a seat `STATUS_FACE_SEAT` behind the table centre,
 * so a seated player sees all of it from the forward pose at the 0.5 to 0.65 m placements.
 */
const STATUS_WIDTH = 0.38;
const STATUS_AT = { right: -0.38, forward: 0.32, lift: 0.68 } as const;
const STATUS_FACE_SEAT = 0.6;
/** The desktop hand strip, a camera child: its pose at the base field of view. */
const HAND_HOME = { position: [0, -0.26, -0.42] as const, pitch: 0.2, scale: 0.9 } as const;
/**
 * Highest normalized device y the desktop hand strip reaches. The framing keeps the dice tray above
 * it (`framingPoints().floor`), so a thrown die is never behind the cards.
 */
export const DESKTOP_HAND_TOP = -0.48;
/** Readout sizes tried, largest first, when no position clears the sigil plate at full size. */
const READOUT_SHRINK = [1, 0.75, 0.55] as const;
/** Longest the win handover waits on death clips, from the first death; a stalled clip never hangs it. */
export const DEATH_WAIT_SECONDS = 3;
/** Seconds between one enemy's turn resolving and the next one starting. */
export const ENEMY_GAP_SECONDS = 0.35;
/** A capsule's lunge at the player; its blow lands at the peak. */
export const LUNGE_SECONDS = 0.6;
const LUNGE_METRES = 0.35;
/** A move that deals no damage (block, buff, debuff): a short rise and settle; it lands at the top. */
export const BRACE_SECONDS = 0.55;
const BRACE_METRES = 0.12;
/** An enemy that only took its Overheat tick (and may have died of it) holds the stage this long. */
export const LEAD_ONLY_SECONDS = 0.6;
/** An actor's blow lands at its clip's `impact` beat, or this long after it if the event never fires. */
const IMPACT_GRACE_SECONDS = 0.4;
/** Longest an actor's attack may run past its clip before its turn resolves anyway. */
const CLIP_GRACE_SECONDS = 0.5;
/** The floating damage number rises and fades, and the HP readout's red tint fades, over this long. */
export const HIT_NUMBER_SECONDS = 1.1;
const HIT_NUMBER_RISE = 0.08;
/** Kept entries of the turn trace and hit log. */
const TRACE_CAP = 60;

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

function safeLabel(px: number, py: number, width: number): CanvasLabel | null {
  try {
    return new CanvasLabel(px, py, width);
  } catch {
    return null;
  }
}

interface NdcRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** Mean distance in front of the camera, metres. */
  depth: number;
}

/** The eight corners of a mesh's geometry bounds in world space. */
function worldCorners(mesh: THREE.Mesh): THREE.Vector3[] {
  mesh.geometry.computeBoundingBox();
  const box = mesh.geometry.boundingBox;
  if (!box) return [];
  const out: THREE.Vector3[] = [];
  for (const x of [box.min.x, box.max.x])
    for (const y of [box.min.y, box.max.y])
      for (const z of [box.min.z, box.max.z])
        out.push(new THREE.Vector3(x, y, z).applyMatrix4(mesh.matrixWorld));
  return out;
}

/** How far to move a span `[lo, hi]` so it sits inside `[-margin, margin]` (centred when too wide). */
function shiftInto(lo: number, hi: number, margin: number): number {
  if (hi - lo > 2 * margin) return -(lo + hi) / 2;
  if (lo < -margin) return -margin - lo;
  if (hi > margin) return margin - hi;
  return 0;
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
  /**
   * The run's deck, hp, max hp and bonus dice, plus debug cheats, passed to the controller, and the
   * run's difficulty, which scales the encounter's enemies (absent: the content as written).
   */
  options?: Pick<CombatOptions, 'enemyHp' | 'playerHp' | 'playerMaxHp' | 'bonusDice' | 'deck'> & {
    readonly difficulty?: Difficulty;
  };
  /** The animated actor standing in for a body (the Cog Sentry), or null for a placeholder. */
  actorOf?: (body: THREE.Object3D) => SentryActor | null;
  /** Called as damage lands on the player (or is fully blocked), at the blow's impact. */
  onPlayerHit?: (hit: PlayerHit) => void;
  /** Typeset card labels with troika (off in tests). */
  syncLabels?: boolean;
  dice?: Partial<DiceWorldOptions>;
  /** The authored dice, owned by the caller; null keeps the greybox dice. */
  models?: DiceAsset | null;
  /** The room reflection probe the dice reflect (see `DicePresenterOptions.envMap`). */
  diceEnv?: THREE.Texture | null;
}

export type SessionStage = Stage | 'dice' | 'enemy';

export type EnemyMotion = 'clip' | 'lunge' | 'brace' | 'none';

/** One enemy's turn as it played, on the session clock (seconds since the session opened). */
export interface EnemyTurnTrace {
  readonly enemyId: string;
  readonly moveId: string | null;
  readonly motion: EnemyMotion;
  readonly start: number;
  /** When its move's effects were shown; null until then. */
  impact: number | null;
  /** When its turn resolved (motion back home); null until then. */
  end: number | null;
}

/** A player hit as the HUD showed it, on the session clock. */
export type ShownHit = PlayerHit & { readonly at: number; readonly enemyId: string | null };

interface BeatRun {
  readonly seg: EnemyBeat;
  readonly trace: EnemyTurnTrace;
  readonly actor: SentryActor | null;
  readonly body: THREE.Object3D | null;
  /** The body's local position before the motion, restored when the turn resolves. */
  readonly home: THREE.Vector3 | null;
  /** Local-frame displacement of one metre of motion (toward the player, or up). */
  readonly toward: THREE.Vector3 | null;
  readonly impactAt: number;
  readonly endAt: number;
  t: number;
  impacted: boolean;
  /** The actor's clip passed its `impact` event. */
  cue: boolean;
}

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
  /** Each enemy turn played, oldest first (capped): order and timing evidence for checks. */
  readonly turnTrace: EnemyTurnTrace[] = [];
  /** Each player hit shown, oldest first (capped). */
  readonly hitLog: ShownHit[] = [];

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
  /** Objects the desktop view may slide to keep them on screen, with their XR layout positions. */
  private readonly anchors: {
    object: THREE.Mesh;
    home: THREE.Vector3;
    /** XR layout rotation; the desktop view turns the status panel to face the camera instead. */
    turn: THREE.Quaternion;
    /** Scale in the desktop view; 1 in the XR layout. */
    scale: number;
    kind: 'button' | 'readout' | 'status';
  }[] = [];
  private hudMoved = false;
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
  /** Animated actors by rules enemy id. */
  private readonly actors = new Map<string, SentryActor>();
  /**
   * The state the view shows while the enemy phase plays one enemy at a time; null otherwise, when
   * the view shows the rules state. The rules have already resolved the whole phase.
   */
  private shown: CombatState | null = null;
  /** The rules state as of the last presented batch: the fold's starting point. */
  private lastShown: CombatState;
  /** Segments waiting to be shown, in rules order. */
  private readonly queue: TurnSegment[] = [];
  private beat: BeatRun | null = null;
  private gap = 0;
  private clock = 0;
  private readonly hitNumber: CanvasLabel | null;
  private hitNumberAge = Infinity;
  /** While the enemy phase plays: the log before it, and the lines of what has been shown since. */
  private logBase: readonly string[] = [];
  private readonly logShown: string[] = [];
  private hpPulse = 0;
  private hpRed = false;
  private endText = '';
  /** Actors playing their death clip; checked each frame, since `die()`'s promise settles a task late. */
  private readonly dying = new Set<SentryActor>();
  private deathWait = -1;

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
    const ordered = [...deps.bodies].sort((a, b) => lateral(a) - lateral(b));
    const encounter = chooseEncounter(deps.seed, deps.room, deps.tier, ordered.length);
    const { difficulty, ...controllerOptions } = deps.options ?? {};
    this.controller = new CombatController({
      ...controllerOptions,
      seed: fightSeed(deps.seed, deps.room),
      setups: encounterSetups(encounter, difficulty),
    });
    this.lastShown = this.controller.state;
    this.enemyIds = this.controller.state.enemies.map((e) => e.id);
    // A body the floor tagged with an enemy kind wears that kind's model, so it plays that enemy;
    // untagged bodies take the rest left to right.
    const free = [...ordered];
    const take = (kind: string): THREE.Object3D | undefined => {
      const tagged = free.findIndex((b) => b.userData.enemyKind === kind);
      const at = tagged >= 0 ? tagged : free.findIndex((b) => b.userData.enemyKind === undefined);
      return free.splice(at >= 0 ? at : 0, 1)[0];
    };
    this.bodies = [...this.enemyIds.map((id) => take(enemyKindOf(id))), ...free].filter(
      (b): b is THREE.Object3D => b !== undefined,
    );
    this.enemyIds.forEach((id, i) => {
      const body = this.bodies[i];
      const actor = body ? (deps.actorOf?.(body) ?? null) : null;
      if (!actor) return;
      this.actors.set(id, actor);
      actor.onEvent = (event) => {
        if (event === 'impact' && this.beat?.actor === actor) this.beat.cue = true;
      };
    });
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
      drawButtonText(label, text);
      return label;
    };
    this.endLabel = buttonLabel(this.endButton, 'END TURN');
    this.endText = 'END TURN';
    this.throwLabel = buttonLabel(this.throwButton, 'THROW');

    this.status = safeLabel(512, 320, STATUS_WIDTH);
    if (this.status) {
      this.status.mesh.position.copy(onTable(STATUS_AT.right, STATUS_AT.forward, STATUS_AT.lift));
      this.status.mesh.rotation.y =
        yawRad + Math.atan2(-STATUS_AT.right, STATUS_AT.forward + STATUS_FACE_SEAT);
      this.group.add(this.status.mesh);
    }
    // The floating damage number rides on the status panel, so it follows the desktop HUD fit.
    this.hitNumber = this.status ? safeLabel(384, 192, 0.3) : null;
    if (this.status && this.hitNumber) {
      this.hitNumber.mesh.name = 'hit-number';
      this.hitNumber.mesh.visible = false;
      this.hitNumber.mesh.renderOrder = 1;
      this.status.mesh.add(this.hitNumber.mesh);
    }
    this.enemyIds.forEach((id, i) => {
      const body = this.bodies[i];
      const label = safeLabel(640, 260, 0.85);
      if (!body || !label) return;
      const at = body.getWorldPosition(new THREE.Vector3());
      // Float the readout clear of the automaton's top so the body never hides it.
      const top = new THREE.Box3().setFromObject(body).max.y;
      const lift = Number.isFinite(top) ? top - at.y + 0.22 : 0.75;
      label.mesh.position.set(
        at.x,
        at.y + Math.max(lift, body.userData.tier === 'guardian' ? 1.3 : 0.75),
        at.z,
      );
      label.mesh.rotation.y = yawRad;
      this.group.add(label.mesh);
      this.labels.push({ id, label });
    });
    const anchor = (object: THREE.Mesh, kind: 'button' | 'readout' | 'status', scale = 1) =>
      this.anchors.push({
        object,
        home: object.position.clone(),
        turn: object.quaternion.clone(),
        scale,
        kind,
      });
    anchor(this.endButton, 'button');
    anchor(this.throwButton, 'button');
    for (const { label } of this.labels) anchor(label.mesh, 'readout');
    // The status panel goes last so it can step clear of the readouts.
    if (this.status) anchor(this.status.mesh, 'status', DESKTOP_STATUS_SCALE);
    // UI atlas icons are drawn into these canvases; the page loads when a label is first drawn.
    const iconHost = this.status?.mesh ?? this.labels[0]?.label.mesh;
    if (iconHost)
      iconSheetOnFirstRender(iconHost, () => {
        this.dirty = true;
      });

    this.platePose = deps.sockets.sigilPlate
      ? platePoseFromNode(deps.sockets.sigilPlate)
      : platePoseAboveTable(this.pose);
    this.plate.hide();
    deps.root.add(this.plate);

    this.handAnchor.name = 'desktop-hand';
    this.handAnchor.position.set(...HAND_HOME.position);
    this.handAnchor.rotation.x = HAND_HOME.pitch;
    this.handAnchor.scale.setScalar(HAND_HOME.scale);
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
      {
        halfX: TRAY_HALF_X,
        halfZ: TRAY_HALF_Z,
        ...(deps.models ? { models: deps.models } : {}),
        ...(deps.diceEnv ? { envMap: deps.diceEnv } : {}),
      },
      deps.dice,
    );
    return new CombatSession(deps, presenter);
  }

  /** The combat stage for the HUD: the controller's, or `dice` while a rolled die waits to be thrown. */
  get stage(): SessionStage {
    if (this.shown) return 'enemy';
    if (this.controller.stage === 'over') return 'over';
    return this.pendingThrow ? 'dice' : this.controller.stage;
  }

  /** True while the enemy phase plays one enemy at a time; the player cannot act meanwhile. */
  get enemyPhase(): boolean {
    return this.shown !== null;
  }

  /** Seconds since the session opened: the clock of `turnTrace` and `hitLog`. */
  get time(): number {
    return this.clock;
  }

  /** The state the view shows: the enemy phase's partial replay while it plays, else the rules state. */
  get view(): CombatState {
    return this.shown ?? this.controller.state;
  }

  /** The combat log as far as the view has shown it: an enemy's lines appear when it acts. */
  get log(): readonly string[] {
    return this.shown ? [...this.logBase, ...this.logShown] : this.controller.log;
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
    const { player, turn } = this.view;
    const foes = this.view.enemies
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
      case 'enemy': {
        const enemy = this.enemies.find((e) => e.id === key);
        return enemy ? this.aimOf(enemy.id, enemy.body) : null;
      }
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

  /**
   * World-space corners of every HUD element a desktop player must be able to see: End Turn,
   * Throw, the dice tray, the sigil plate, the status panel and each automaton's readout.
   */
  hudPoints(): { name: string; points: THREE.Vector3[] }[] {
    this.deps.root.updateWorldMatrix(true, true);
    const out: { name: string; points: THREE.Vector3[] }[] = [
      { name: 'end-turn', points: worldCorners(this.endButton) },
      { name: 'throw', points: worldCorners(this.throwButton) },
      { name: 'tray', points: worldCorners(this.trayHit) },
      { name: 'plate', points: this.plateCorners() },
    ];
    if (this.status) out.push({ name: 'status', points: worldCorners(this.status.mesh) });
    for (const { id, label } of this.labels)
      out.push({ name: `readout:${id}`, points: worldCorners(label.mesh) });
    return out;
  }

  /**
   * What the desktop framing fits: `must` (the dice tray and the sigil plate, which sit in the
   * world), `want` (each automaton's aim point) and `floor`, the lowest view y the `must` points may
   * take, which keeps the tray above the hand strip. The buttons, status panel and readouts are
   * not here because `fitHudToView` moves them into whatever view results.
   */
  framingPoints(): { must: THREE.Vector3[]; want: THREE.Vector3[]; floor: number } {
    this.deps.root.updateWorldMatrix(true, true);
    const want = this.enemies.map(({ id, body }) => this.aimOf(id, body));
    return {
      must: [...worldCorners(this.trayHit), ...this.plateCorners()],
      want,
      floor: DESKTOP_HAND_TOP + HUD_GAP,
    };
  }

  /**
   * Desktop only: slides the buttons, status panel and readouts from their XR layout positions
   * into `camera`'s view wherever the view would cut them off. Each is moved in the camera's
   * plane, so its size on screen is unchanged. The status panel is also scaled down and then
   * steps below any readout it would cover, turned parallel to the view so it reads square on
   * (in XR it keeps its turn toward the seat). A readout the sigil plate or its result label would
   * cover rises above them, else moves to the side, shrinking if it must. The hand strip keeps its
   * screen size at any field of view and stays below `DESKTOP_HAND_TOP`.
   * Call `resetHud` when the camera is not the player's desktop view.
   */
  fitHudToView(camera: THREE.PerspectiveCamera, margin = HUD_VIEW_MARGIN): void {
    if (this.disposed) return;
    this.deps.root.updateWorldMatrix(true, true);
    camera.updateWorldMatrix(true, false);
    const tanY = Math.tan((camera.fov * DEG) / 2);
    const tanX = tanY * camera.aspect;
    const rotation = camera.getWorldQuaternion(new THREE.Quaternion());
    const inverse = camera.matrixWorld.clone().invert();
    const rectOfPoints = (corners: THREE.Vector3[]): NdcRect | null => {
      const rect: NdcRect = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, depth: 0 };
      for (const corner of corners) {
        const c = corner.clone().applyMatrix4(inverse);
        if (c.z > -0.02) return null;
        rect.x0 = Math.min(rect.x0, c.x / (-c.z * tanX));
        rect.x1 = Math.max(rect.x1, c.x / (-c.z * tanX));
        rect.y0 = Math.min(rect.y0, c.y / (-c.z * tanY));
        rect.y1 = Math.max(rect.y1, c.y / (-c.z * tanY));
        rect.depth += -c.z / corners.length;
      }
      return rect;
    };
    const rectOf = (mesh: THREE.Mesh): NdcRect | null => {
      mesh.updateMatrixWorld(true);
      return rectOfPoints(worldCorners(mesh));
    };
    const overlaps = (a: NdcRect, b: NdcRect): boolean =>
      a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
    const inside = (r: NdcRect): boolean =>
      r.x0 >= -margin && r.x1 <= margin && r.y0 >= -margin && r.y1 <= margin;
    const move = (mesh: THREE.Mesh, rect: NdcRect, dx: number, dy: number): void => {
      mesh.position.add(
        new THREE.Vector3(dx * tanX * rect.depth, dy * tanY * rect.depth, 0).applyQuaternion(
          rotation,
        ),
      );
    };
    this.hudMoved = true;
    this.fitHand(camera, rectOfPoints);
    const plate = rectOfPoints(this.plateCorners());
    const label = rectOfPoints(this.resultLabelCorners());
    const zone =
      plate && label
        ? {
            x0: Math.min(plate.x0, label.x0),
            x1: Math.max(plate.x1, label.x1),
            y0: Math.min(plate.y0, label.y0),
            y1: Math.max(plate.y1, label.y1),
            depth: plate.depth,
          }
        : plate;
    const placed: NdcRect[] = [];
    const readouts: NdcRect[] = [];
    for (const anchor of this.anchors) {
      const mesh = anchor.object;
      mesh.position.copy(anchor.home);
      mesh.scale.setScalar(anchor.scale);
      if (anchor.kind === 'status' && mesh.parent) {
        mesh.quaternion
          .copy(mesh.parent.getWorldQuaternion(new THREE.Quaternion()))
          .invert()
          .multiply(rotation);
      }
      let rect = rectOf(mesh);
      for (let pass = 0; pass < 3 && rect; pass++) {
        const dx = shiftInto(rect.x0, rect.x1, margin);
        const dy = shiftInto(rect.y0, rect.y1, margin);
        if (dx === 0 && dy === 0) break;
        move(mesh, rect, dx, dy);
        rect = rectOf(mesh);
      }
      if (rect && anchor.kind === 'status') {
        const cover = placed.find((p) => rect && overlaps(p, rect));
        if (cover && cover.y0 - HUD_GAP - (rect.y1 - rect.y0) >= -margin) {
          move(mesh, rect, 0, cover.y0 - HUD_GAP - rect.y1);
          rect = rectOf(mesh);
        }
      } else if (rect && zone && anchor.kind === 'readout') {
        // A cast must never hide a readout: try above the plate and its result label, then the
        // side nearer the readout, then the far side, at full size and then smaller.
        const blocked = (r: NdcRect): boolean =>
          overlaps(zone, r) || readouts.some((p) => overlaps(p, r));
        if (blocked(rect)) {
          const start = mesh.position.clone();
          let found: NdcRect | null = null;
          for (const shrink of READOUT_SHRINK) {
            mesh.position.copy(start);
            mesh.scale.setScalar(anchor.scale * shrink);
            const r = rectOf(mesh);
            if (!r) break;
            const left = zone.x0 - HUD_GAP - r.x1;
            const right = zone.x1 + HUD_GAP - r.x0;
            const near = r.x0 + r.x1 <= zone.x0 + zone.x1 ? [left, right] : [right, left];
            const moves: [number, number][] = [
              [0, zone.y1 + HUD_GAP - r.y0],
              [near[0] as number, 0],
              [near[1] as number, 0],
              [0, 0],
            ];
            for (const [dx, dy] of moves) {
              mesh.position.copy(start);
              move(mesh, r, dx, dy);
              const moved = rectOf(mesh);
              if (moved && inside(moved) && !blocked(moved)) {
                found = moved;
                break;
              }
            }
            if (found) break;
          }
          if (found) rect = found;
          else {
            mesh.position.copy(start);
            mesh.scale.setScalar(anchor.scale);
            rect = rectOf(mesh);
          }
        }
        if (rect) readouts.push(rect);
      }
      if (rect) placed.push(rect);
    }
  }

  /**
   * World corners of each card of the desktop hand at rest (hover lifts one card above this),
   * for the HUD fit and tests.
   */
  handCorners(): THREE.Vector3[] {
    const root = this.fan.root;
    root.updateWorldMatrix(true, false);
    const out: THREE.Vector3[] = [];
    const slot = new THREE.Matrix4();
    const euler = new THREE.Euler();
    for (const s of this.fan.layout) {
      euler.set(s.rotation.pitch, s.rotation.yaw, s.rotation.roll, 'YXZ');
      slot.compose(
        new THREE.Vector3(...s.position),
        new THREE.Quaternion().setFromEuler(euler),
        new THREE.Vector3(s.scale, s.scale, s.scale),
      );
      for (const x of [-0.5, 0.5])
        for (const y of [-0.5, 0.5])
          out.push(
            new THREE.Vector3(x * DEFAULT_FAN.cardWidth, y * DEFAULT_FAN.cardHeight, 0)
              .applyMatrix4(slot)
              .applyMatrix4(root.matrixWorld),
          );
    }
    return out;
  }

  /** World corners of the sigil plate's result label, where it shows after a cast. */
  resultLabelCorners(): THREE.Vector3[] {
    return plateLabelCorners(this.platePose).map((p) => new THREE.Vector3(p.x, p.y, p.z));
  }

  /**
   * Desktop hand strip: back at its home pose, then lowered if its top would pass
   * `DESKTOP_HAND_TOP`, where the framing keeps the dice tray. A wider field of view (close tables)
   * draws the strip smaller and higher, so this is where it moves.
   */
  private fitHand(
    camera: THREE.PerspectiveCamera,
    rectOfPoints: (corners: THREE.Vector3[]) => NdcRect | null,
  ): void {
    const anchor = this.handAnchor;
    anchor.position.set(...HAND_HOME.position);
    if (this.fan.root.parent !== anchor || this.fan.count === 0) return;
    anchor.updateMatrixWorld(true);
    const rect = rectOfPoints(this.handCorners());
    if (rect && rect.y1 > DESKTOP_HAND_TOP) {
      anchor.position.y -=
        (rect.y1 - DESKTOP_HAND_TOP) * Math.tan((camera.fov * DEG) / 2) * rect.depth;
    }
  }

  /** Puts the buttons, status panel and readouts back at their XR layout positions. */
  resetHud(): void {
    if (!this.hudMoved) return;
    this.hudMoved = false;
    for (const anchor of this.anchors) {
      anchor.object.position.copy(anchor.home);
      anchor.object.quaternion.copy(anchor.turn);
      anchor.object.scale.setScalar(1);
    }
  }

  private plateCorners(): THREE.Vector3[] {
    const p = this.platePose;
    const out: THREE.Vector3[] = [];
    for (const x of [-p.halfWidth, p.halfWidth])
      for (const y of [-p.halfHeight, p.halfHeight])
        out.push(
          new THREE.Vector3(
            p.center.x + p.right.x * x + p.up.x * y,
            p.center.y + p.right.y * x + p.up.y * y,
            p.center.z + p.right.z * x + p.up.z * y,
          ),
        );
    return out;
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
    this.clock += dt;
    this.setXr(xr);
    // Before sync, so the frame the enemy phase ends also deals the new hand.
    this.advance(dt);
    if (this.dirty) this.sync();
    this.stepHitFeedback(dt);
    if (this.xr && this.holding === null && this.xr.mainRay) {
      const r = rayFromObject(this.xr.mainRay);
      this.fan.pointerHover(
        new THREE.Ray(new THREE.Vector3(...r.origin), new THREE.Vector3(...r.direction)),
      );
    }
    this.plate.setHint(this.xr ? XR_SIGIL_HINT : '');
    if (this.drawing === 'xr' && this.xr?.main) {
      const tip = this.tipOf(this.xr.main);
      const ray = this.xr.mainRay ? rayFromObject(this.xr.mainRay) : null;
      const added = this.plate.addPen(
        tip,
        ray && { origin: toV(ray.origin), direction: toV(ray.direction) },
      );
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
      if (this.plateDone >= PLATE_DONE_SECONDS) {
        this.plate.hide();
        // A sigil card staged while the last result still showed gets its plate now.
        this.dirty = true;
      }
    }
    if (this.deathWait > 0) this.deathWait -= dt;
    // A fight decided mid-phase (the killing blow) shows its banner once that blow has played.
    const outcome = this.shown ? null : this.controller.outcome;
    if (outcome !== null && !this.ended) {
      if (this.endTimer < 0) {
        this.endTimer = outcome === 'won' ? WIN_HOLD_SECONDS : DEFEAT_HOLD_SECONDS;
        this.banner = outcome === 'won' ? 'VICTORY' : 'DEFEAT';
        this.sfx(outcome === 'won' ? 'victory-sting' : 'defeat-sting');
        this.paint();
      }
      this.endTimer -= dt;
      // A win hands over only once the last automaton lies still, because the room clears on `end`.
      for (const actor of this.dying) {
        if (actor.disposed || !actor.action('death').isRunning()) this.dying.delete(actor);
      }
      const deathsDone = outcome !== 'won' || this.dying.size === 0 || this.deathWait <= 1e-6;
      if (this.endTimer <= 0 && deathsDone) {
        this.ended = true;
        this.deps.end(outcome === 'won' ? 'win' : 'defeat');
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deps.audio?.stopLoop('sigil-trace');
    for (const actor of this.actors.values()) actor.onEvent = null;
    if (this.beat?.body && this.beat.home) this.beat.body.position.copy(this.beat.home);
    this.beat = null;
    this.queue.length = 0;
    this.shown = null;
    this.hitNumber?.dispose();
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
    if (this.controller.outcome !== null || this.busy()) return;
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
    if (action.pressed && this.busy()) return;
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
    if (this.busy()) return;
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
    if (decision?.outcome === 'staged')
      this.message = this.xr ? XR_SIGIL_HINT : 'Draw the sigil on the plate';
  }

  private endTurn(): void {
    if (this.disposed || this.controller.outcome !== null || this.busy()) return;
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
    if (this.disposed || this.busy()) return;
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

  /** True (with a HUD prompt) while the enemy phase plays: every player verb waits for it. */
  private busy(): boolean {
    if (!this.shown) return false;
    this.message = 'Enemies are acting';
    return true;
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
    const events = this.controller.drainEvents();
    const segments = segmentEvents(events);
    if (this.shown || segments.some((seg) => seg.kind === 'enemy')) {
      // The enemy phase plays one enemy at a time from the state the view last showed.
      if (!this.shown) {
        this.shown = this.lastShown;
        const state = this.controller.state;
        const fresh = events.filter((e) => describeEvent(e, state) !== null).length;
        this.logBase = this.controller.log.slice(
          0,
          Math.max(0, this.controller.log.length - fresh),
        );
        this.logShown.length = 0;
      }
      this.queue.push(...segments);
      this.advance(0);
    } else {
      for (const seg of segments) if (seg.kind === 'instant') this.present(seg.events);
      this.lastShown = this.controller.state;
    }
    const state = this.controller.state;
    // The new hand is dealt once the enemies are done; the fan stays empty meanwhile.
    const hand = this.shown ? [] : state.piles.hand;
    const key = hand.map((c) => c.uid).join(',');
    if (key !== this.handKey) {
      this.handKey = key;
      this.fan.setHand(
        hand.map((c) => getCard(c.def.id)),
        hand.map((c) => c.uid),
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
    this.showBodies();
    this.paint();
  }

  /** An actor stays visible to play its death and lie on the floor; a placeholder just vanishes. */
  private showBodies(): void {
    this.view.enemies.forEach((enemy, i) => {
      const body = this.bodies[i];
      if (body && !this.actors.has(enemy.id)) body.visible = enemy.hp > 0;
    });
  }

  // ---- the enemy phase, one enemy at a time ------------------------------------------------------

  /**
   * Plays the queued segments: instant ones at once, each enemy beat to its end plus a gap before
   * the next. When the queue empties the view goes back to the rules state and the hand is dealt.
   */
  private advance(dt: number): void {
    if (!this.shown) return;
    if (this.beat) {
      this.stepBeat(this.beat, dt);
      if (!this.beatDone(this.beat)) return;
      this.finishBeat(this.beat);
      this.beat = null;
      this.gap = ENEMY_GAP_SECONDS;
      return;
    }
    if (this.gap > 0) {
      this.gap -= dt;
      if (this.gap > 1e-9) return;
      this.gap = 0;
    }
    while (this.queue.length > 0) {
      const next = this.queue.shift() as TurnSegment;
      if (next.kind === 'instant') {
        this.present(next.events);
        continue;
      }
      this.beat = this.startBeat(next);
      this.stepBeat(this.beat, 0);
      return;
    }
    this.shown = null;
    this.lastShown = this.controller.state;
    this.dirty = true;
  }

  private startBeat(seg: EnemyBeat): BeatRun {
    const id = seg.enemyId;
    this.present(seg.lead);
    const actor = this.actors.get(id) ?? null;
    const body = this.enemies.find((e) => e.id === id)?.body ?? null;
    const alive = (this.view.enemies.find((e) => e.id === id)?.hp ?? 0) > 0;
    const motion: EnemyMotion =
      seg.act.length === 0 || !alive
        ? 'none'
        : seg.attacks && actor && !actor.dead
          ? 'clip'
          : seg.attacks
            ? 'lunge'
            : 'brace';
    const trace: EnemyTurnTrace = {
      enemyId: id,
      moveId: seg.moveId,
      motion,
      start: this.clock,
      impact: null,
      end: null,
    };
    this.turnTrace.push(trace);
    if (this.turnTrace.length > TRACE_CAP) this.turnTrace.shift();
    let impactAt = 0;
    let endAt = seg.lead.length > 0 ? LEAD_ONLY_SECONDS : 0;
    if (motion === 'clip' && actor) {
      const spec = actor.asset.manifest.clips.attack;
      actor.attack();
      impactAt = (spec.events.impact ?? spec.duration / 2) + IMPACT_GRACE_SECONDS;
      endAt = spec.duration + CLIP_GRACE_SECONDS;
    } else if (motion === 'lunge') {
      impactAt = LUNGE_SECONDS / 2;
      endAt = LUNGE_SECONDS;
    } else if (motion === 'brace') {
      impactAt = BRACE_SECONDS / 2;
      endAt = BRACE_SECONDS;
    }
    let home: THREE.Vector3 | null = null;
    let toward: THREE.Vector3 | null = null;
    const parent = body?.parent;
    if (body && parent && (motion === 'lunge' || motion === 'brace')) {
      home = body.position.clone();
      body.updateWorldMatrix(true, false);
      const world = body.getWorldPosition(new THREE.Vector3());
      const dir = new THREE.Vector3(0, 1, 0);
      if (motion === 'lunge') {
        const eye = this.deps.camera.getWorldPosition(new THREE.Vector3());
        dir.set(eye.x - world.x, 0, eye.z - world.z);
        if (dir.lengthSq() < 1e-8)
          dir.set(-Math.sin(this.pose.yaw * DEG), 0, Math.cos(this.pose.yaw * DEG));
        dir.normalize();
      }
      toward = parent.worldToLocal(world.clone().add(dir)).sub(parent.worldToLocal(world.clone()));
    }
    this.paint();
    return {
      seg,
      trace,
      actor,
      body,
      home,
      toward,
      impactAt,
      endAt,
      t: 0,
      impacted: false,
      cue: false,
    };
  }

  private stepBeat(b: BeatRun, dt: number): void {
    b.t += dt;
    if (b.body && b.home && b.toward) {
      const lunge = b.trace.motion === 'lunge';
      const k = Math.min(1, b.t / (lunge ? LUNGE_SECONDS : BRACE_SECONDS));
      const reach = (lunge ? LUNGE_METRES : BRACE_METRES) * Math.sin(Math.PI * k);
      b.body.position.copy(b.home).addScaledVector(b.toward, reach);
    }
    const due = b.trace.motion === 'clip' ? b.cue || b.t >= b.impactAt : b.t >= b.impactAt;
    if (!b.impacted && due) {
      b.impacted = true;
      b.trace.impact = this.clock;
      this.present(b.seg.act);
      this.paint();
    }
  }

  private beatDone(b: BeatRun): boolean {
    if (!b.impacted) return false;
    if (b.trace.motion === 'clip' && b.actor) {
      return b.actor.dead || b.actor.state !== 'attack' || b.t >= b.endAt;
    }
    return b.t >= b.endAt;
  }

  private finishBeat(b: BeatRun): void {
    if (b.body && b.home) b.body.position.copy(b.home);
    b.trace.end = this.clock;
  }

  /** Shows a batch of rules events: folds them into the shown state, sounds them, reacts to them. */
  private present(events: readonly CombatEvent[]): void {
    if (events.length === 0) return;
    if (this.shown) {
      this.shown = foldEvents(this.shown, events);
      for (const event of events) {
        const line = describeEvent(event, this.shown);
        if (line !== null) this.logShown.push(line);
      }
    }
    const hits = new Set<SentryActor>();
    const deaths = new Set<SentryActor>();
    const phases = new Set<SentryActor>();
    for (const event of events) {
      if (event.type === 'damage-dealt' && event.target === PLAYER_ID) {
        // A fully blocked blow rings the ward (in showPlayerHit) instead of the clank.
        if (event.hpLost > 0) this.deps.audio?.playCombatEvent(event);
        continue;
      }
      const target = 'target' in event ? (event.target as string | null) : null;
      const enemyId = 'enemyId' in event ? (event.enemyId as string) : target;
      const actor = enemyId ? this.actors.get(enemyId) : undefined;
      if (actor && event.type === 'damage-dealt' && event.amount > 0) hits.add(actor);
      if (actor && event.type === 'enemy-died') deaths.add(actor);
      if (actor && event.type === 'enemy-phase') phases.add(actor);
      const at = enemyId && enemyId !== PLAYER_ID ? this.aimOfId(enemyId) : null;
      this.deps.audio?.playCombatEvent(event, at ?? undefined);
    }
    for (const actor of deaths) {
      hits.delete(actor);
      if (actor.dead) continue;
      this.dying.add(actor);
      if (this.deathWait < 0) this.deathWait = DEATH_WAIT_SECONDS;
      void actor.die();
    }
    for (const actor of hits) actor.hit();
    // After the hit reaction, so the opening case takes over the pose from the blow that caused it.
    for (const actor of phases) actor.openCase();
    const hit = playerHit(events);
    if (hit) this.showPlayerHit(hit);
    this.showBodies();
  }

  /** The HUD side of a hit: HP readout tint, floating number, block chime, and the caller's flash. */
  private showPlayerHit(hit: PlayerHit): void {
    this.hitLog.push({ ...hit, at: this.clock, enemyId: this.beat?.seg.enemyId ?? null });
    if (this.hitLog.length > TRACE_CAP) this.hitLog.shift();
    if (hit.blocked > 0) this.sfx('block-ward');
    if (hit.hpLost > 0) this.hpPulse = 1;
    this.hitNumberAge = 0;
    this.hitNumber?.draw((ctx, w, h) => {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(18,12,7,0.9)';
      const line = (text: string, color: string, y: number, size: number) => {
        ctx.font = `bold ${size}px system-ui, sans-serif`;
        ctx.strokeText(text, w / 2, y);
        ctx.fillStyle = color;
        ctx.fillText(text, w / 2, y);
      };
      if (hit.kind === 'blocked') line(`Blocked ${hit.blocked}`, PALETTE.brass, h / 2, 64);
      else if (hit.kind === 'hit') line(`-${hit.hpLost}`, HIT_RED, h / 2, 110);
      else {
        line(`-${hit.hpLost}`, HIT_RED, h * 0.36, 96);
        line(`Blocked ${hit.blocked}`, PALETTE.brass, h * 0.8, 48);
      }
    });
    this.deps.onPlayerHit?.(hit);
  }

  /** Steps the floating number and the HP readout's red tint. */
  private stepHitFeedback(dt: number): void {
    const number = this.hitNumber?.mesh;
    if (number && this.status) {
      this.hitNumberAge += dt;
      const k = this.hitNumberAge / HIT_NUMBER_SECONDS;
      number.visible = k < 1;
      if (number.visible) {
        const half = this.status.mesh.geometry.parameters.height / 2;
        number.position.set(0, half + 0.08 + HIT_NUMBER_RISE * k, 0.005);
        number.material.opacity = 1 - k * k;
      }
    }
    if (this.hpPulse > 0) {
      this.hpPulse = Math.max(0, this.hpPulse - dt / HIT_NUMBER_SECONDS);
      const p = this.hpPulse;
      this.status?.mesh.material.color.setRGB(1, 1 - 0.55 * p, 1 - 0.55 * p);
    }
    const red = this.hpPulse > 0.35;
    if (red !== this.hpRed) {
      this.hpRed = red;
      this.paint();
    }
  }

  private paint(): void {
    const state = this.view;
    const icons: IconSheet | null = iconSheet();
    const statusChips = (statuses: Readonly<Partial<Record<keyof typeof STATUS_ICON, number>>>) =>
      (Object.entries(statuses) as [keyof typeof STATUS_ICON, number | undefined][])
        .filter(([, n]) => (n ?? 0) > 0)
        .map(([status, n]) => ({ icon: STATUS_ICON[status], text: String(n), fallback: status }));
    const vitals = (hp: number, maxHp: number, block: number) => [
      { icon: 'hp' as IconId, text: `${hp}/${maxHp}`, fallback: 'HP' },
      ...(block ? [{ icon: 'block' as IconId, text: String(block), fallback: 'Block' }] : []),
    ];
    for (const { id, label } of this.labels) {
      const enemy = state.enemies.find((e) => e.id === id);
      if (!enemy) continue;
      label.mesh.visible = enemy.hp > 0;
      label.draw((ctx, w, h) => {
        ctx.fillStyle = 'rgba(18,12,7,0.82)';
        roundRect(ctx, 4, 4, w - 8, h - 8, 14);
        ctx.fill();
        ctx.fillStyle = PALETTE.parchment;
        ctx.font = 'bold 38px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(enemy.name, w / 2, 38);
        ctx.font = 'bold 44px system-ui, sans-serif';
        drawIconRow(
          ctx,
          icons,
          vitals(enemy.hp, enemy.maxHp, enemy.block),
          w / 2,
          104,
          64,
          'center',
        );
        // One icon chip per intent part (attack 4, block 7), then the enemy's statuses.
        const intent = intentChips(enemy, intentDamage(state, enemy.id));
        ctx.fillStyle = PALETTE.candle;
        ctx.font = 'bold 50px system-ui, sans-serif';
        drawIconRow(
          ctx,
          icons,
          [...intent, ...statusChips(enemy.statuses)],
          w / 2,
          200,
          92,
          'center',
        );
      });
    }
    this.status?.draw((ctx, w, h) => {
      ctx.fillStyle = 'rgba(18,12,7,0.82)';
      roundRect(ctx, 4, 4, w - 8, h - 8, 16);
      ctx.fill();
      if (this.hpRed) {
        ctx.strokeStyle = HIT_RED;
        ctx.lineWidth = 8;
        roundRect(ctx, 8, 8, w - 16, h - 16, 14);
        ctx.stroke();
      }
      ctx.fillStyle = this.hpRed ? HIT_RED : PALETTE.parchment;
      ctx.font = 'bold 40px system-ui, sans-serif';
      const p = state.player;
      drawIconRow(ctx, icons, vitals(p.hp, p.maxHp, p.block), 24, 50, 60);
      ctx.fillStyle = PALETTE.parchment;
      drawIconRow(
        ctx,
        icons,
        [{ icon: 'steam', text: String(p.steam), fallback: 'Steam' }, ...statusChips(p.statuses)],
        24,
        122,
        60,
      );
      ctx.fillStyle = PALETTE.candle;
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Turn ${state.turn}`, 24, 186);
      ctx.fillText(this.banner || `Stage: ${this.stage}`, 24, 236);
      const last = this.rolls[this.rolls.length - 1];
      if (last) ctx.fillText(`Last roll ${last.value}`, 24, 284);
    });
    (this.throwButton.material as THREE.MeshStandardMaterial).emissive.set(
      this.pendingThrow ? PALETTE.brass : '#000000',
    );
    // End Turn reads as disabled while the enemies act.
    const waiting = this.shown !== null;
    (this.endButton.material as THREE.MeshStandardMaterial).color.set(
      waiting ? PALETTE.warmBlack : PALETTE.walnut,
    );
    const endText = waiting ? 'ENEMY TURN' : 'END TURN';
    if (this.endLabel && endText !== this.endText) {
      this.endText = endText;
      drawButtonText(this.endLabel, endText, waiting ? PALETTE.brassDark : PALETTE.parchment);
    }
  }

  private targetSites(): FlingTargetSite[] {
    return this.enemies.map(({ id, body }) => {
      const p = this.aimOf(id, body);
      return { id, position: [p.x, p.y, p.z], radius: ENEMY_RADIUS };
    });
  }

  /** Where cards aim at an enemy: an actor's hit socket (its origin is at its feet), else the body. */
  private aimOf(id: string, body: THREE.Object3D): THREE.Vector3 {
    const socket = this.actors.get(id)?.socket('socket-hit');
    return (socket ?? body).getWorldPosition(new THREE.Vector3());
  }

  private aimOfId(id: string): THREE.Vector3 | null {
    const body = this.enemies.find((e) => e.id === id)?.body;
    return body ? this.aimOf(id, body) : null;
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
      if (this.fan.root.parent !== next.off)
        this.fan.attach(next.off as THREE.Object3D, GRIP_FAN_ORIGIN);
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

function drawButtonText(label: CanvasLabel, text: string, color: string = PALETTE.parchment): void {
  label.draw((ctx, w, h) => {
    ctx.fillStyle = color;
    ctx.font = `bold ${text.length > 8 ? 36 : 44}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);
  });
}

function toV(v: readonly number[]): { x: number; y: number; z: number } {
  return { x: v[0] as number, y: v[1] as number, z: v[2] as number };
}

let sharedModels: Promise<DiceAsset | null> | null = null;

/**
 * The authored dice, fetched once and shared by every fight and floor for the page's lifetime
 * (never disposed). A failed load resolves null so the fight keeps its greybox dice, and the next
 * fight tries again.
 */
function sharedDiceModels(): Promise<DiceAsset | null> {
  if (!sharedModels) {
    const load = loadDice().then(
      (asset) => asset,
      (error: unknown) => {
        console.warn('dice models unavailable, greybox dice kept', error);
        if (sharedModels === load) sharedModels = null;
        return null;
      },
    );
    sharedModels = load;
  }
  return sharedModels;
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
  /** The animated actor standing in for a body, when the floor has one. */
  actorOf?(body: THREE.Object3D): SentryActor | null;
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
  /** The dice models every fight uses, or null for greybox; loaded once and shared when absent. */
  models?: DiceAsset | null;
  /** The room reflection probe for the dice, read when each fight opens. */
  diceEnv?: () => THREE.Texture | null;
  /** Called with each new session, e.g. for a debug handle. */
  onSession?: (session: CombatSession | null) => void;
  /** Passed to each session: damage landing on the player (the edge flash and haptics). */
  onPlayerHit?: (hit: PlayerHit) => void;
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
  /** True once the open fight's `onEnd` fired; cleared when the next fight opens. */
  private handedOver = false;

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
    if (this.handedOver) {
      this.banner = '';
      this.bannerTimer = 0;
    } else if (this.session?.banner) {
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
    this.handedOver = false;
    const models =
      this.deps.models === undefined ? sharedDiceModels() : Promise.resolve(this.deps.models);
    const promise = models.then((diceModels) =>
      CombatSession.create({
        seed: floor.seed,
        room,
        tier,
        tablePose: pose,
        bodies,
        root: floor.world.group,
        camera: this.deps.camera,
        sockets: floor.tableSockets(),
        actions: this.deps.actions,
        actorOf: (body) => floor.actorOf?.(body) ?? null,
        ...(this.deps.onPlayerHit ? { onPlayerHit: this.deps.onPlayerHit } : {}),
        end: (outcome) => {
          const playerHp = this.session?.controller.state.player.hp ?? null;
          // The flow's board takes over from here, so the banner must not cover it.
          this.handedOver = true;
          floor.encounter.end(outcome);
          this.deps.onEnd?.({ room, outcome, playerHp });
        },
        ...(this.deps.audio ? { audio: this.deps.audio } : {}),
        ...(options ? { options } : {}),
        ...(this.deps.syncLabels === undefined ? {} : { syncLabels: this.deps.syncLabels }),
        ...(this.deps.dice ? { dice: this.deps.dice } : {}),
        ...(diceModels ? { models: diceModels } : {}),
        diceEnv: this.deps.diceEnv?.() ?? null,
      }),
    );
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
