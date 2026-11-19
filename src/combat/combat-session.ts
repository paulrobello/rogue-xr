import * as THREE from 'three';
import type { SfxId } from '../audio/cues.ts';
import { CanvasLabel, roundRect, wrapText } from '../combat-view/canvas-label.ts';
import { cardTip } from '../combat-view/card-keywords.ts';
import { CastFx } from '../combat-view/cast-fx.ts';
import { CastReveal } from '../combat-view/cast-reveal.ts';
import {
  type CastFxStep,
  castFxSteps,
  castLandSeconds,
  REVEAL_EFFECT_AT,
} from '../combat-view/cast-timing.ts';
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
import { FoundryFx } from '../combat-view/foundry-fx.ts';
import { HIT_RED } from '../combat-view/hit-feedback.ts';
import {
  HIT_NUMBER_RISE,
  HIT_NUMBER_SECONDS,
  HIT_NUMBER_WIDTH,
  HitNumbers,
} from '../combat-view/hit-numbers.ts';
import {
  CARD_LAUNCH_DELAY,
  CARD_POWER,
  flightSeconds,
  KNOCK_SECONDS,
  knockOffset,
} from '../combat-view/impact-timing.ts';
import { crownBounds, intentChips, READOUT_MARGIN, readoutCentreY } from '../combat-view/index.ts';
import { readoutHeightsClear } from '../combat-view/panel-layout.ts';
import {
  type AttackVisualKind,
  attackVisualKind,
  type BoltKind,
  SpellFx,
} from '../combat-view/spell-fx.ts';
import {
  drawChipsWithStatuses,
  drawTip,
  STATUS_NAME,
  type StatusRegion,
  stanceReadout,
  statusAtUv,
  statusExplanation,
} from '../combat-view/status-info.ts';
import { dropToFitView, fitsView } from '../combat-view/view-fit.ts';
import { getCard, type SliceCard } from '../content/cards.ts';
import { dieById } from '../content/dice.ts';
import { type EncounterTier, encounterSetups } from '../content/enemies.ts';
import type { ActionBus, GameAction } from '../core/actions.ts';
import { Stream } from '../core/rng.ts';
import { type DiceAsset, loadDice } from '../dice/dice-asset.ts';
import type { DieKind } from '../dice/faces.ts';
import { DicePresenter, type PresentedRoll } from '../dice/presenter.ts';
import { AUTHORED_TRAY_HALF, type DiceWorldOptions } from '../dice/world.ts';
import type { SentryActor } from '../enemies/sentry-asset.ts';
import type { AimRay } from '../hand/aim.ts';
import { CardFan } from '../hand/card-fan.ts';
import { DEFAULT_FAN, GRIP_FAN_ORIGIN } from '../hand/fan-layout.ts';
import { FlingController, type FlingTargetSite, rayFromObject } from '../hand/fling.ts';
import { PALETTE } from '../palette.ts';
import { perfMark, perfWindow } from '../perf/marks.ts';
import {
  type CombatEvent,
  type CombatState,
  canFlee,
  type Difficulty,
  foundryStance,
  intentDamage,
  PLAYER_ID,
} from '../rules/index.ts';
import {
  castPower,
  GLYPH_LAUNCH_SECONDS,
  type PlatePose,
  plateLabelCorners,
  platePoseAboveTable,
  platePoseFromNode,
  rayToPlate,
  SigilPlate,
} from '../sigil-plate/index.ts';
import type { IconId } from '../ui/icon-atlas.ts';
import {
  drawIconRow,
  type IconSheet,
  iconSheet,
  iconSheetOnFirstRender,
} from '../ui/icon-sheet.ts';
import type { EncounterDirector } from './encounter.ts';
import { chooseEncounter, enemyKindOf, fightSeed } from './encounter-choice.ts';
import { DEFAULT_TABLE_DISTANCE, type TablePose, WAIST_DROP } from './placement.ts';

export { HIT_NUMBER_SECONDS } from '../combat-view/hit-numbers.ts';
export { chooseEncounter, fightSeed } from './encounter-choice.ts';

const DEG = Math.PI / 180;
/** Seconds the victory banner holds before the table folds and the room clears. */
export const WIN_HOLD_SECONDS = 1.2;
/** Seconds the defeat banner holds before the automatons go home. */
export const DEFEAT_HOLD_SECONDS = 1.6;
const PLATE_DONE_SECONDS = 1.6;
/** The cast card's art disc: its diameter's share of the plate's shorter side, and its lift off it. */
const REVEAL_FILL = 0.8;
const REVEAL_LIFT = 0.03;
/** The ward shield forms this far from the eye toward the plate, and this far below that line. */
const SHIELD_REACH = 0.42;
const SHIELD_DROP = 0.04;
/** A sigil casts once the pen has been lifted this long, so multi-stroke glyphs (gear) can be drawn. */
export const SIGIL_CAST_SECONDS = 0.6;
/** The desktop drag plane sits this far above the table top, so a dragged card skims it. */
const DRAG_LIFT = 0.12;
const DRAG_REACH = 3;
const TIP_OFFSET = 0.06;
/** How to trace a glyph with controllers, shown above the plate and as the staged-card message. */
export const XR_SIGIL_HINT = 'Hold the trigger and point at the plate to trace the glyph';
/** The table hint while a rolled die waits for its throw, in XR and on the desktop. */
export const XR_DICE_HINT = 'Grab the glowing die and let go to throw it';
export const XR_HELD_DICE_HINT = 'Release your grip to roll';
export const DESKTOP_DICE_HINT = 'Click the glowing die to throw it (or press T)';
/** Why an elite or guardian fight shows no Flee control and refuses one. */
export const FLEE_REFUSED = 'There is no escaping this fight';
/** Why a flee is refused while the enemies act or a play's effects are still landing. */
export const FLEE_WAIT = 'Wait for your turn to flee';
/** A first FLEE press arms it; a second press within this many seconds flees. */
export const FLEE_CONFIRM_SECONDS = 4;
/** The prompt while FLEE is armed. */
export const FLEE_CONFIRM = 'Press FLEE again to flee the fight';
/** The FLEE button's label while armed. */
export const FLEE_CONFIRM_LABEL = 'CONFIRM?';
const CONTROL_AT = { right: 0.92, forward: -0.16, lift: 0.31 } as const;
const CONTROL_WIDTH = 0.28;
const CONTROL_HEIGHT = 0.1;
const CONTROL_DEPTH = 0.021;
const CONTROL_GAP = 0.13;
/** Width of the table hint label, metres; it hangs this high over the dice tray. */
const HINT_WIDTH = 0.46;
/** The status tooltip: its width, metres, and how far it floats above and in front of the badge. */
const TIP_WIDTH = 0.42;
/** Half the tooltip's height at scale 1 (its canvas is 640 x 240). */
const TIP_HALF_HEIGHT = (TIP_WIDTH * 240) / 640 / 2;
const STATUS_TIP_OFFSET = { up: 0.14, toward: 0.04 } as const;
/** Nearer than this, metres, the tooltip keeps its size; farther, it grows in proportion. */
const STATUS_TIP_NEAR = 0.9;
/** The card keyword tip: canvas height (fits a three-keyword card), width in metres, and its place
 * above the card (metres up from the card's centre, and toward the eye). */
const CARD_TIP_PX_HEIGHT = 600;
const CARD_TIP_WIDTH = 0.3;
const CARD_TIP_LIFT = 0.08;
const CARD_TIP_TOWARD = 0.03;
const HINT_LIFT = 0.17;
const TRAY_HALF_X = AUTHORED_TRAY_HALF.halfX;
const TRAY_HALF_Z = AUTHORED_TRAY_HALF.halfZ;
const ENEMY_RADIUS = 0.5;
/** The HUD stays inside this normalized device extent of the desktop view (1 is the screen edge). */
const HUD_VIEW_MARGIN = 0.92;
/** Clear space left between HUD panels in the desktop view, in normalized device units. */
const HUD_GAP = 0.04;
/** The status panel is drawn at this scale in the desktop view, so it clears the sigil plate at close tables. */
const DESKTOP_STATUS_SCALE = 0.8;
/**
 * XR layout of the player's status panel, table metres (right, toward the enemies, above the top):
 * up and left of the sigil plate, turned to face the seat `seatDistance` behind the table centre
 * (`STATUS_FACE_SEAT`, the default table distance, when not given), so a seated player sees all of
 * it from the forward pose at the 0.5 to 1.3 m placements.
 */
const STATUS_WIDTH = 0.38;
const STATUS_AT = { right: -0.38, forward: 0.32, lift: 0.68 } as const;
const STATUS_FACE_SEAT = DEFAULT_TABLE_DISTANCE;
/** Half the eye separation the XR panel clearance checks from the seat (the emulated Quest 3), metres. */
const SEAT_EYE_HALF_IPD = 0.032;
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
/**
 * A dice card's effects wait for its die (H2): they show once the thrown die settles. A rolled die
 * nobody throws is thrown for the player after this long, so an idle fight never stalls.
 */
export const DICE_AUTO_THROW_SECONDS = 30;
/** A thrown die that has not settled after this long releases its card's effects anyway. */
export const DICE_SETTLE_FALLBACK_SECONDS = 6;
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
/** Player numbers start this far above the status panel's top edge, panel metres. */
const PLAYER_NUMBER_LIFT = 0.08;
/** Player numbers are drawn this fraction of `HIT_NUMBER_WIDTH`, the size they had on the panel. */
const PLAYER_NUMBER_SCALE = 0.75;
/**
 * An enemy's number starts this far from its hit socket toward the camera and up, so it floats in
 * front of the body; numbers of one batch (a multi-hit card) step sideways and up by `NUMBER_STEP`.
 */
const ENEMY_NUMBER_OUT = 0.35;
const ENEMY_NUMBER_UP = 0.18;
/** From an enemy number's start to the top of its label at the peak of its rise (labels are 2:1). */
const ENEMY_NUMBER_HEADROOM = HIT_NUMBER_RISE + HIT_NUMBER_WIDTH / 4;
/** An enemy number is lowered at most this far to stay inside the top of the view. */
const ENEMY_NUMBER_MAX_DROP = 0.4;
const NUMBER_STEP = { side: 0.16, up: 0.07 } as const;
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

function controlPlate(width: number, height: number, depth: number): THREE.ExtrudeGeometry {
  const x = width / 2;
  const y = height / 2;
  const cut = 0.012;
  const shape = new THREE.Shape([
    new THREE.Vector2(-x + cut, -y),
    new THREE.Vector2(x - cut, -y),
    new THREE.Vector2(x, -y + cut),
    new THREE.Vector2(x, y - cut),
    new THREE.Vector2(x - cut, y),
    new THREE.Vector2(-x + cut, y),
    new THREE.Vector2(-x, y - cut),
    new THREE.Vector2(-x, -y + cut),
  ]);
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }).translate(
    0,
    0,
    -depth / 2,
  );
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
  contentVersion?: number;
  tablePose: TablePose;
  /** Player-to-table-centre distance the table was placed at, metres. Default STATUS_FACE_SEAT. */
  seatDistance?: number;
  /** The room's automaton stand-ins, already moved to their combat places. */
  bodies: readonly THREE.Object3D[];
  /** Untransformed world root; every combat visual is added here in world coordinates. */
  root: THREE.Object3D;
  /** Desktop camera: the hand strip hangs in front of it and mouse sigils project through it. */
  camera: THREE.Camera;
  sockets: { diceTray: THREE.Object3D | null; sigilPlate: THREE.Object3D | null };
  actions: ActionBus;
  /**
   * Called once the fight is decided and its banner has held, or at once when the player flees
   * (a regular fight only, from their own input window).
   */
  end: (outcome: 'win' | 'defeat' | 'flee') => void;
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
  /** Softens the cast glyph and the impact flash and drops the knock-back (the OS preference). */
  reducedMotion?: boolean;
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

/** Where the next attack's bolt leaves from, set by the verb that played it. */
interface Launch {
  readonly from: THREE.Vector3;
  /** Session clock time the bolt leaves. */
  readonly at: number;
  readonly power: number;
  readonly kind: BoltKind;
  /** Show the cast card's art over the plate first; the effect leaves it at `at`. */
  readonly reveal?: boolean;
}

/**
 * A player attack in flight: its effects, and the view from before it, held until the bolt lands
 * on the enemy (the HP change, hit clip, death and sounds show at contact).
 */
interface Flight {
  readonly state: CombatState;
  /** The rules state right after the play: the fold start once it lands. */
  readonly after: CombatState;
  readonly events: CombatEvent[];
  readonly logLength: number;
  readonly from: THREE.Vector3;
  readonly power: number;
  readonly kind: BoltKind;
  readonly visual: AttackVisualKind;
  readonly targets: { readonly id: string; readonly at: THREE.Vector3 }[];
  /** Seconds from the play until the bolt leaves, the bolt's flight time, and the contact time. */
  readonly delay: number;
  readonly seconds: number;
  readonly contact: number;
  /** Session clock time of the play; the flight's times count from here. */
  readonly start: number;
  launched: boolean;
}

/** A body pushed back by an impact, eased home on the knock curve. */
interface Knock {
  body: THREE.Object3D | null;
  readonly home: THREE.Vector3;
  /** Parent-local displacement of one metre of push. */
  readonly away: THREE.Vector3;
  power: number;
  t: number;
}

const KNOCK_SLOTS = 4;

/** What a combat pickable is, for scripted pointer tests and the debug hook. */
export type CombatPick = 'card' | 'enemy' | 'end-turn' | 'flee' | 'dice' | 'plate' | 'table';

/**
 * One fight on the exploration floor, alive while the encounter is `active`. It owns the
 * `CombatController` for the room's encounter and every combat visual: the card fan (camera strip on
 * the desktop, off-hand grip in XR), the fling, the dice in the tray (a rolled die waits there,
 * pulsing, until it is grabbed and let go, or clicked), the sigil plate, End Turn, the table hint and
 * the enemy readouts. Input arrives only through the action bus.
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
  private readonly controlFrames: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>[] =
    [];
  /** The Flee control beside End Turn, only in a fight `canFlee` allows. */
  private readonly fleeButton: THREE.Mesh | null;
  private readonly fleeLabel: CanvasLabel | null;
  private readonly trayHit: THREE.Mesh;
  private readonly labels: { id: string; label: CanvasLabel }[] = [];
  private readonly status: CanvasLabel | null;
  private readonly endLabel: CanvasLabel | null;
  /** The table hint over the dice tray: how to throw the die, or how to play the held card. */
  private readonly hintLabel: CanvasLabel | null;
  /** The table hint's text, '' when hidden. */
  hint = '';
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
  private readonly controlSurfaces: THREE.Object3D[] = [];
  private readonly controlIntersections: THREE.Intersection[] = [];
  private readonly handPoint = new THREE.Vector3();
  private readonly numberAt = new THREE.Vector3();
  /** Where each label drew its status badges, rebuilt with every paint, for the pointer tooltip. */
  private readonly statusHits: {
    label: CanvasLabel;
    owner: string;
    who: 'you' | 'it';
    regions: StatusRegion[];
  }[] = [];
  /** The tooltip naming and explaining the status the pointer is on. */
  private readonly tip: CanvasLabel | null;
  private tipKey = '';
  /**
   * The status the laser (XR) or mouse (desktop) is on: whose, which, its explanation, and the
   * ray distance to it (the beam ends there). Null when none.
   */
  statusHover: {
    owner: string;
    id: StatusRegion['id'];
    stacks: number | null;
    name: string;
    text: string;
    distance: number;
  } | null = null;
  /** The tip listing the keywords of the card the pointer is on, or of the held card. */
  private readonly cardTipLabel: CanvasLabel | null;
  private cardTipKey = '';
  /** The card whose keyword tip shows, by id, or null. For tests and the HUD. */
  cardTipShown: { id: string; titles: string[] } | null = null;
  private readonly eye = new THREE.Vector3();
  private platePose: PlatePose;
  private handKey = '';
  private lastDice: CombatController['lastDice'] = null;
  private pendingThrow: { kind: DieKind; face: number; value: number }[] | null = null;
  private settlingDice = 0;
  private keptDiceHint = '';
  private lastResolvedRoll: number | null = null;
  /**
   * A played dice card's effects and the view from before it, held until its die settles: `waiting`
   * counts seconds since the roll (before the throw) or since the throw (after it).
   */
  private held: {
    state: CombatState;
    events: CombatEvent[];
    logLength: number;
    waiting: number;
  } | null = null;
  private lastRay: AimRay | null = null;
  private lastNdc: readonly [number, number] | null = null;
  private holding: 'mouse' | 'xr' | null = null;
  /** True while the XR main hand holds the waiting die (squeeze held); letting go throws it. */
  private holdingDie = false;
  /** True while the XR main-hand squeeze is down, whatever it holds. */
  private mainSqueezed = false;
  /** A dice card was just used in XR: its die goes to the main hand if the grip is still held. */
  private takeDie = false;
  /** Seconds left to confirm a flee with a second press; 0 while FLEE is not armed. */
  private fleeArmed = 0;
  private fleeText = 'FLEE';
  private drawing: 'mouse' | 'xr' | null = null;
  private plateDone = 0;
  private castTimer = -1;
  private endTimer = -1;
  private ended = false;
  private disposed = false;
  private pausedValue = false;
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
  /** Floating damage numbers over enemies and the player's status panel, pooled. */
  readonly numbers = new HitNumbers();
  /** While the enemy phase plays: the log before it, and the lines of what has been shown since. */
  private logBase: readonly string[] = [];
  private readonly logShown: string[] = [];
  private hpPulse = 0;
  private hpRed = false;
  private endText = '';
  /** Actors playing their death clip; checked each frame, since `die()`'s promise settles a task late. */
  private readonly dying = new Set<SentryActor>();
  private deathWait = -1;
  /** Spell bolts and impact bursts. */
  private readonly fx: SpellFx;
  /** The non-attack effect FX (shield, steam, motes, draw shimmer) and the cast card reveal. */
  private readonly effectFx: CastFx;
  private readonly foundryFx: FoundryFx;
  private readonly revealCard: CastReveal;
  private launch: Launch | null = null;
  private flight: Flight | null = null;
  private readonly knocks: Knock[] = Array.from({ length: KNOCK_SLOTS }, () => ({
    body: null,
    home: new THREE.Vector3(),
    away: new THREE.Vector3(),
    power: 0,
    t: 0,
  }));

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
    const encounter = chooseEncounter(
      deps.seed,
      deps.room,
      deps.tier,
      ordered.length,
      deps.contentVersion,
    );
    const { difficulty, ...controllerOptions } = deps.options ?? {};
    this.controller = new CombatController({
      ...controllerOptions,
      ...(difficulty === undefined ? {} : { difficulty }),
      seed: fightSeed(deps.seed, deps.room),
      setups: encounterSetups(encounter, difficulty),
    });
    this.plate.level = difficulty ?? 'casual';
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

    const button = (name: string, edge: string): THREE.Mesh => {
      const mesh = new THREE.Mesh(
        controlPlate(CONTROL_WIDTH, CONTROL_HEIGHT, CONTROL_DEPTH),
        new THREE.MeshStandardMaterial({
          color: PALETTE.warmBlack,
          roughness: 0.43,
          metalness: 0.14,
        }),
      );
      mesh.name = name;
      const frame = new THREE.Mesh(
        controlPlate(CONTROL_WIDTH + 0.018, CONTROL_HEIGHT + 0.018, 0.016),
        new THREE.MeshStandardMaterial({
          color: edge,
          roughness: 0.34,
          metalness: 0.62,
          emissive: edge,
          emissiveIntensity: 0.18,
        }),
      );
      frame.name = `${name}-frame`;
      frame.position.z = -0.008;
      mesh.add(frame);
      this.controlFrames.push(frame);
      this.controlSurfaces.push(mesh, frame);
      return mesh;
    };
    this.endButton = button('end-turn', PALETTE.brass);
    this.endButton.position.copy(onTable(CONTROL_AT.right, CONTROL_AT.forward, CONTROL_AT.lift));
    this.endButton.rotation.y = yawRad;
    this.endButton.rotateX(-0.2);
    this.group.add(this.endButton);
    const buttonLabel = (mesh: THREE.Mesh, text: string): CanvasLabel | null => {
      const label = safeLabel(512, 192, CONTROL_WIDTH - 0.025);
      if (!label) return null;
      label.mesh.position.z = CONTROL_DEPTH / 2 + 0.001;
      mesh.add(label.mesh);
      drawButtonText(label, text);
      return label;
    };
    this.endLabel = buttonLabel(this.endButton, 'END TURN');
    this.endText = 'END TURN';
    // The desktop HUD moves both controls as one group.
    this.fleeButton = canFlee(deps.tier) ? button('flee', PALETTE.ruby) : null;
    if (this.fleeButton) {
      this.fleeButton.position.y = -CONTROL_GAP;
      this.endButton.add(this.fleeButton);
    }
    this.fleeLabel = this.fleeButton ? buttonLabel(this.fleeButton, 'FLEE') : null;
    this.faceControlsToEye();
    this.tip = safeLabel(640, 240, TIP_WIDTH);
    if (this.tip) {
      this.tip.mesh.name = 'status-tip';
      this.tip.mesh.visible = false;
      this.tip.mesh.renderOrder = 4;
      this.tip.mesh.material.depthTest = false;
      this.group.add(this.tip.mesh);
    }
    this.cardTipLabel = safeLabel(640, CARD_TIP_PX_HEIGHT, CARD_TIP_WIDTH);
    if (this.cardTipLabel) {
      this.cardTipLabel.mesh.name = 'card-tip';
      this.cardTipLabel.mesh.visible = false;
      this.cardTipLabel.mesh.renderOrder = 4;
      this.cardTipLabel.mesh.material.depthTest = false;
      this.group.add(this.cardTipLabel.mesh);
    }
    this.hintLabel = safeLabel(768, 192, HINT_WIDTH);
    if (this.hintLabel) {
      const mesh = this.hintLabel.mesh;
      mesh.name = 'table-hint';
      mesh.visible = false;
      mesh.renderOrder = 2;
      mesh.position.copy(dice.root.position);
      mesh.position.y += HINT_LIFT;
      // Faces the seat, leaning back so it reads from above the table.
      mesh.rotation.set(-0.35, yawRad, 0, 'YXZ');
      this.group.add(mesh);
    }

    this.status = safeLabel(512, 320, STATUS_WIDTH);
    if (this.status) {
      this.status.mesh.position.copy(onTable(STATUS_AT.right, STATUS_AT.forward, STATUS_AT.lift));
      this.status.mesh.rotation.y =
        yawRad +
        Math.atan2(-STATUS_AT.right, STATUS_AT.forward + (deps.seatDistance ?? STATUS_FACE_SEAT));
      this.group.add(this.status.mesh);
    }
    this.group.add(this.numbers);
    const eye = deps.camera.getWorldPosition(new THREE.Vector3());
    this.enemyIds.forEach((id, i) => {
      const body = this.bodies[i];
      const label = safeLabel(640, 260, 0.85);
      if (!body || !label) return;
      const at = body.getWorldPosition(new THREE.Vector3());
      const actor = this.actors.get(id);
      let y: number;
      if (actor) {
        // Clear of the head as the seat sees it, from the manifest (a skinned mesh's cached box can
        // be from another pose). A brace's 0.12 m rise may touch the panel's edge for its peak.
        body.updateWorldMatrix(true, false);
        const { manifest } = actor.asset;
        const crown = crownBounds(manifest.bounds, manifest.sockets['socket-eye']?.position);
        const bounds = new THREE.Box3(
          new THREE.Vector3(...crown.min),
          new THREE.Vector3(...crown.max),
        ).applyMatrix4(body.matrixWorld);
        y = readoutCentreY(eye, at, bounds, label.mesh.geometry.parameters.height, {
          margin: READOUT_MARGIN,
        });
      } else {
        // A placeholder capsule: float the readout clear of its top.
        const top = new THREE.Box3().setFromObject(body).max.y;
        const lift = Number.isFinite(top) ? top - at.y + 0.22 : 0.75;
        y = at.y + Math.max(lift, body.userData.tier === 'guardian' ? 1.3 : 0.75);
      }
      label.mesh.position.set(at.x, y, at.z);
      label.mesh.rotation.y = yawRad;
      this.group.add(label.mesh);
      this.labels.push({ id, label });
    });
    this.clearReadoutsOfStatus(deps.seatDistance ?? STATUS_FACE_SEAT);
    const anchor = (object: THREE.Mesh, kind: 'button' | 'readout' | 'status', scale = 1) =>
      this.anchors.push({
        object,
        home: object.position.clone(),
        turn: object.quaternion.clone(),
        scale,
        kind,
      });
    anchor(this.endButton, 'button');
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
    this.plate.reducedMotion = deps.reducedMotion ?? false;
    deps.root.add(this.plate);
    this.fx = new SpellFx({ reducedMotion: deps.reducedMotion ?? false });
    this.group.add(this.fx);
    this.effectFx = new CastFx({ reducedMotion: deps.reducedMotion ?? false });
    this.group.add(this.effectFx);
    this.foundryFx = new FoundryFx(deps.reducedMotion ?? false);
    this.group.add(this.foundryFx);
    this.revealCard = new CastReveal({ reducedMotion: deps.reducedMotion ?? false });
    this.group.add(this.revealCard);

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
        perfMark('dice-settled');
        this.rolls.push(roll);
        if (this.settlingDice > 0 && --this.settlingDice === 0) this.releaseHeld();
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

  /**
   * The combat stage for the HUD: the controller's, or `dice` from the roll of a dice card until its
   * die settles (its effects wait for that, even a killing blow's).
   */
  get stage(): SessionStage {
    if (this.shown) return 'enemy';
    if (this.pendingThrow || this.held) return 'dice';
    return this.controller.stage;
  }

  /** True when this fight offers the Flee control (a regular fight). */
  get fleeable(): boolean {
    return this.fleeButton !== null;
  }

  /**
   * While true the fight stands still (the in-run menu is up): `update` advances nothing, so every
   * timer, the enemy turn and the dice hold, and combat input is ignored. A card held at the pause
   * stays held (letting go meanwhile is ignored too) and is let go by the next release after it.
   */
  get paused(): boolean {
    return this.pausedValue;
  }
  set paused(value: boolean) {
    this.pausedValue = value;
  }

  /** True while a hand card is held (picked up, not yet used or put back). */
  get holdingCard(): boolean {
    return this.holding !== null;
  }

  /** True while FLEE waits for its confirming second press. */
  get fleeConfirming(): boolean {
    return this.fleeArmed > 0;
  }

  /**
   * A press of FLEE (the button or the desktop F key). The first press only arms it: the button
   * reads CONFIRM and a second press within `FLEE_CONFIRM_SECONDS` flees. Any other verb, the
   * timeout or the enemy turn disarms it. The flee ends the fight through `end('flee')`, keeping the
   * player's hp; an automaton already killed is taken off the floor. Refused (false, with a message,
   * and disarmed) in an elite or guardian fight, while the enemies act, a card is held or a play's
   * effects (or a death) are still playing, while a die waits, and once the fight is decided. A
   * refused flee is not queued. True only for the press that fled.
   */
  flee(): boolean {
    if (this.disposed || this.pausedValue || this.ended || this.controller.outcome !== null)
      return false;
    if (!this.fleeButton) {
      this.message = FLEE_REFUSED;
      return false;
    }
    if (this.busy() || this.diceFirst()) return false;
    const dying = [...this.dying].some((a) => !a.disposed && a.action('death').isRunning());
    if (this.flight || this.launch || this.castTimer > 0 || this.holding !== null || dying) {
      this.disarmFlee();
      this.message = FLEE_WAIT;
      return false;
    }
    if (this.fleeArmed <= 0) {
      this.fleeArmed = FLEE_CONFIRM_SECONDS;
      this.message = FLEE_CONFIRM;
      this.sfx('ui-tick');
      this.paintFlee();
      return false;
    }
    this.cancel();
    // An automaton killed before the flee stays dead, as a win would leave it; the rest go home.
    for (const { id, body } of this.enemies) {
      const enemy = this.controller.state.enemies.find((e) => e.id === id);
      if (enemy && enemy.hp <= 0) body.removeFromParent();
    }
    this.ended = true;
    this.sfx('ui-tick');
    perfMark('flee');
    this.deps.end('flee');
    return true;
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
    return this.shown ?? this.held?.state ?? this.flight?.state ?? this.controller.state;
  }

  /**
   * True while a play's effects are on their way (an attack's bolt, or a block, steam, status or
   * draw FX): they show when it lands.
   */
  get attackInFlight(): boolean {
    return this.flight !== null;
  }

  /** The spell bolts and impact bursts, for checks. */
  get spellFx(): SpellFx {
    return this.fx;
  }

  /** The non-attack effect FX, for checks. */
  get castFx(): CastFx {
    return this.effectFx;
  }

  /** The cast card's art over the plate, for checks. */
  get castReveal(): CastReveal {
    return this.revealCard;
  }

  /** The combat log as far as the view has shown it: an enemy's lines appear when it acts. */
  get log(): readonly string[] {
    if (this.shown) return [...this.logBase, ...this.logShown];
    if (this.held) return this.controller.log.slice(0, this.held.logLength);
    return this.flight ? this.controller.log.slice(0, this.flight.logLength) : this.controller.log;
  }

  get awaitingThrow(): boolean {
    return this.pendingThrow !== null;
  }

  /** True from a dice card's roll until its die settles: its effects are not shown yet. */
  get awaitingDice(): boolean {
    return this.held !== null;
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
      case 'flee':
        return this.fleeButton?.getWorldPosition(new THREE.Vector3()) ?? null;
      case 'dice':
        return (this.dice.waiting ?? this.trayHit).getWorldPosition(new THREE.Vector3());
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
   * Playtest 2026-11-17: the status panel stands near eye level left of centre, which is where a
   * short automaton's readout (the Spring Hound's) lands seen from the seat. Raises each readout the
   * seat (both eyes, `SEAT_EYE_HALF_IPD` aside) would see overlapping the status panel or an earlier
   * readout until it clears; it runs before the anchors record their XR home positions.
   */
  private clearReadoutsOfStatus(seatDistance: number): void {
    if (this.labels.length === 0) return;
    this.deps.root.updateWorldMatrix(true, true);
    const forward: [number, number] = [
      Math.sin(this.pose.yaw * DEG),
      -Math.cos(this.pose.yaw * DEG),
    ];
    const seat = {
      x: this.pose.x - forward[0] * seatDistance,
      y: this.pose.height + WAIST_DROP,
      z: this.pose.z - forward[1] * seatDistance,
    };
    const eyes = [-SEAT_EYE_HALF_IPD, SEAT_EYE_HALF_IPD].map((side) => ({
      x: seat.x - forward[1] * side,
      y: seat.y,
      z: seat.z + forward[0] * side,
    }));
    const fixed = this.status ? [worldCorners(this.status.mesh)] : [];
    const panels = this.labels.map(({ label }) => ({
      centre: label.mesh.getWorldPosition(new THREE.Vector3()),
      width: label.mesh.geometry.parameters.width,
      height: label.mesh.geometry.parameters.height,
    }));
    const heights = readoutHeightsClear({ eyes, forward }, fixed, panels);
    this.labels.forEach(({ label }, i) => {
      label.mesh.position.y +=
        (heights[i] as number) - (panels[i] as { centre: THREE.Vector3 }).centre.y;
    });
  }

  /**
   * World-space corners of every HUD element a desktop player must be able to see: End Turn, the
   * dice tray, the sigil plate, the status panel and each automaton's readout.
   */
  hudPoints(): { name: string; points: THREE.Vector3[] }[] {
    this.deps.root.updateWorldMatrix(true, true);
    const out: { name: string; points: THREE.Vector3[] }[] = [
      { name: 'end-turn', points: worldCorners(this.endButton) },
      { name: 'tray', points: worldCorners(this.trayHit) },
      { name: 'plate', points: this.plateCorners() },
    ];
    if (this.fleeButton) out.push({ name: 'flee', points: worldCorners(this.fleeButton) });
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
    const seatedEye = camera.getWorldPosition(this.eye);
    const rectOf = (mesh: THREE.Mesh): NdcRect | null => {
      if (mesh === this.endButton) {
        this.faceControlsToEye(seatedEye);
        mesh.updateWorldMatrix(true, true);
        return rectOfPoints(
          this.controlFrames
            .flatMap((frame) => worldCorners(frame))
            .concat(worldCorners(mesh), this.fleeButton ? worldCorners(this.fleeButton) : []),
        );
      }
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
        // The panel never covers a readout: try below, above, left and right of the readouts in
        // its way, at full size and then smaller.
        const onReadout = (r: NdcRect): boolean => readouts.some((p) => overlaps(p, r));
        if (rect && onReadout(rect)) {
          const start = mesh.position.clone();
          let found: NdcRect | null = null;
          for (const shrink of READOUT_SHRINK) {
            mesh.position.copy(start);
            mesh.scale.setScalar(anchor.scale * shrink);
            const r = rectOf(mesh);
            if (!r) break;
            const hits = readouts.filter((p) => overlaps(p, r));
            const moves: [number, number][] = [[0, 0]];
            if (hits.length > 0) {
              moves.push(
                [0, Math.min(...hits.map((p) => p.y0)) - HUD_GAP - r.y1],
                [0, Math.max(...hits.map((p) => p.y1)) + HUD_GAP - r.y0],
                [Math.min(...hits.map((p) => p.x0)) - HUD_GAP - r.x1, 0],
                [Math.max(...hits.map((p) => p.x1)) + HUD_GAP - r.x0, 0],
              );
            }
            for (const [dx, dy] of moves) {
              mesh.position.copy(start);
              move(mesh, r, dx, dy);
              const moved = rectOf(mesh);
              if (moved && inside(moved) && !onReadout(moved)) {
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
    this.faceControlsToEye();
  }

  /** Faces the paired controls at the current seated eye, retaining their table-space positions. */
  private faceControlsToEye(eye = this.deps.camera.getWorldPosition(this.eye)): void {
    this.endButton.lookAt(eye);
    this.fleeButton?.lookAt(eye);
  }

  /** Both aiming and activation use the frontmost plaque or rim under the ray. */
  private controlHit(ray: THREE.Ray): THREE.Intersection | undefined {
    this.raycaster.ray.copy(ray);
    this.endButton.updateWorldMatrix(true, true);
    this.controlIntersections.length = 0;
    return this.raycaster.intersectObjects(
      this.controlSurfaces,
      false,
      this.controlIntersections,
    )[0];
  }

  rayDistance(ray: THREE.Ray): number | null {
    if (this.disposed || this.pausedValue) return null;
    return this.controlHit(ray)?.distance ?? null;
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
    if (this.disposed || this.pausedValue || this.controller.outcome !== null) return false;
    // A held card's use click lands anywhere the mouse aims, an enemy body included.
    if (this.holding === 'mouse') return true;
    const ray = new THREE.Ray(new THREE.Vector3(...origin), new THREE.Vector3(...direction));
    return this.hitAt(ray) !== null;
  }

  /** Per-frame step. `xr` is the tracked hands while presenting, null on the desktop. */
  update(dt: number, xr: XrHands | null = null): void {
    if (this.disposed || this.pausedValue) return;
    this.clock += dt;
    this.setXr(xr);
    if (this.xr) this.faceControlsToEye();
    // Before sync, so the frame the enemy phase ends also deals the new hand.
    this.advance(dt);
    if (this.dirty) this.sync();
    if (this.takeDie) {
      this.takeDie = false;
      if (this.pendingThrow && this.mainSqueezed && this.holding === null) this.holdingDie = true;
    }
    if (this.fleeArmed > 0) {
      this.fleeArmed = this.shown ? 0 : Math.max(0, this.fleeArmed - dt);
      if (this.fleeArmed === 0) {
        if (this.message === FLEE_CONFIRM) this.message = '';
        this.paintFlee();
      }
    }
    this.stepHitFeedback(dt);
    if (this.xr && this.holding === null && this.xr.mainRay) {
      const r = rayFromObject(this.xr.mainRay);
      const ray = new THREE.Ray(new THREE.Vector3(...r.origin), new THREE.Vector3(...r.direction));
      this.fan.pointerHover(ray);
      this.pointStatus(this.drawing || this.holdingDie ? null : ray);
    } else if (this.xr) this.pointStatus(null);
    this.plate.setHint(this.xr ? XR_SIGIL_HINT : '');
    this.stepHeldDie();
    this.showHint(this.tableHint());
    this.showCardTip();
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
    this.stepHeld(dt);
    // Bolts step before the flight check, so a bolt reaches its target on the frame it lands.
    this.fx.update(dt);
    this.effectFx.update(dt);
    this.foundryFx.update(dt);
    this.revealCard.update(dt);
    this.stepFlight();
    this.stepKnocks(dt);
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
    const outcome = this.shown || this.held || this.flight ? null : this.controller.outcome;
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
    for (const actor of this.actors.values()) {
      actor.onEvent = null;
      actor.showIntent(null);
    }
    if (this.beat?.body && this.beat.home) this.beat.body.position.copy(this.beat.home);
    this.beat = null;
    this.queue.length = 0;
    this.shown = null;
    this.held = null;
    this.flight = null;
    this.launch = null;
    this.settleKnocks();
    this.fx.dispose();
    this.effectFx.dispose();
    this.foundryFx.dispose();
    this.revealCard.dispose();
    this.numbers.dispose();
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
    this.fleeLabel?.dispose();
    this.hintLabel?.dispose();
    this.tip?.dispose();
    this.cardTipLabel?.dispose();
    for (const mesh of [this.endButton, this.fleeButton, this.trayHit, ...this.controlFrames]) {
      if (!mesh) continue;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
    for (const body of this.bodies) if (body.parent) body.visible = true;
    for (const body of this.hidden) body.visible = true;
  }

  // ---- input -----------------------------------------------------------------------------------

  private pointer(action: Extract<GameAction, { type: 'combat-pointer' }>): void {
    if (this.xr || this.disposed || this.pausedValue) return;
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
      this.pointStatus(this.drawing || this.holding ? null : ray);
      return;
    }
    if (action.phase === 'up') {
      if (this.drawing === 'mouse') this.liftPen();
      return;
    }
    // The desktop verbs mirror XR: a click picks a card up (the grip), the next click uses it where
    // the mouse aims (the trigger), and a right click puts it back (`combat-cancel`, the release).
    if (this.holding === 'mouse') {
      this.placeMouseGrip(ray);
      this.use();
      return;
    }
    if ((this.controller.outcome !== null && !this.pendingThrow) || this.busy()) return;
    const hit = this.hitAt(ray);
    if (hit !== 'flee') this.disarmFlee();
    if (hit === 'tray') this.throwDice();
    else if (hit === 'plate') {
      this.plate.beginStroke();
      this.castTimer = -1;
      this.drawing = 'mouse';
      this.feedMouse(ray);
    } else if (hit === 'end-turn') this.endTurn();
    else if (hit === 'flee') this.flee();
    else if (typeof hit === 'number') {
      this.placeMouseGrip(ray);
      this.grab(hit, 'mouse');
    }
  }

  private hand(action: Extract<GameAction, { type: 'combat-hand' }>): void {
    const xr = this.xr;
    if (action.hand === 'main' && action.control === 'squeeze') this.mainSqueezed = action.pressed;
    if (!xr || action.hand !== 'main' || this.disposed || this.pausedValue) return;
    if (action.pressed && this.busy()) return;
    if (action.control === 'squeeze') {
      if (action.pressed) this.disarmFlee();
      // A rolled die is grabbed by the main hand and thrown as it is let go, even once the rules
      // have decided the fight (a killing dice card waits for its die).
      if (action.pressed && this.pendingThrow && this.holding === null) {
        this.holdingDie = true;
        return;
      }
      if (!action.pressed && this.holdingDie) {
        this.holdingDie = false;
        this.throwDice();
        return;
      }
      if (action.pressed) {
        const index = this.fan.hovered;
        if (index !== null && this.controller.outcome === null) this.grab(index, 'xr');
      } else if (this.holding === 'xr') this.putBack();
      return;
    }
    if (!action.pressed) {
      if (this.drawing === 'xr') this.liftPen();
      return;
    }
    // The trigger uses the held card; a card still in the fan must be grabbed first.
    if (this.holding === 'xr') {
      this.use();
      return;
    }
    if (this.pendingThrow) {
      this.disarmFlee();
      this.throwDice();
      return;
    }
    if (this.controller.outcome !== null) return;
    if (this.plateLive()) {
      this.disarmFlee();
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
      if (hit !== 'flee') this.disarmFlee();
      if (hit === 'end-turn') this.endTurn();
      else if (hit === 'flee') this.flee();
      else if (hit === 'tray') this.throwDice();
    }
  }

  /** Picks up fan card `index`; false when it could not be grabbed. */
  private grab(index: number, by: 'mouse' | 'xr'): boolean {
    if (this.busy() || this.diceFirst()) return false;
    if (!this.fling.grab(index)) return false;
    this.holding = by;
    this.message = '';
    this.sfx('card-draw', this.fan.root.getWorldPosition(new THREE.Vector3()));
    return true;
  }

  /**
   * Uses the held card (the trigger, or the desktop's second click). A targeted card plays at the
   * aimed enemy, an untargeted one plays, a sigil card is laid down and its plate opens (the next
   * trigger presses draw), and a dice card hands its die to a main hand still gripping. A card with
   * no target in reach stays held, with the reason as the message.
   */
  private use(): void {
    this.disarmFlee();
    const grip = this.holding === 'xr' ? this.xr?.main : this.mouseGrip;
    const dice = this.fling.holding?.card.dice !== undefined;
    const decision = this.fling.activate();
    if (!decision) return;
    if (decision.outcome === 'held') {
      if (decision.reason) this.message = decision.reason;
      return;
    }
    this.holding = null;
    if (decision.outcome === 'played' && grip) {
      this.launch = {
        from: grip.getWorldPosition(new THREE.Vector3()),
        at: this.clock + CARD_LAUNCH_DELAY,
        power: CARD_POWER,
        kind: 'card',
      };
    }
    if (decision.outcome === 'staged')
      this.message = this.xr ? XR_SIGIL_HINT : 'Draw the sigil on the plate';
    this.takeDie = dice && this.xr !== null;
    this.dirty = true;
  }

  /** Lets go of the held card without using it: it springs back to the fan. */
  private putBack(): void {
    this.holding = null;
    this.fling.putBack();
  }

  private endTurn(): void {
    this.disarmFlee();
    if (this.disposed || this.pausedValue || this.controller.outcome !== null || this.busy())
      return;
    if (this.diceFirst()) return;
    this.fling.abortStaged();
    this.plate.hide();
    this.sfx('ui-tick');
    this.controller.endTurn();
    this.message = '';
  }

  private throwDice(): void {
    this.disarmFlee();
    if (this.disposed || this.pausedValue || this.busy()) return;
    const pending = this.pendingThrow;
    if (!pending) {
      this.message = 'No dice to throw';
      return;
    }
    this.pendingThrow = null;
    this.holdingDie = false;
    if (this.held) this.held.waiting = 0;
    this.dice.throwMany(pending);
    this.settlingDice = pending.length;
    perfMark('dice-throw');
    this.sfx('dice-roll', this.dice.root.position);
    this.message = '';
    this.paint();
  }

  /**
   * F6: finds the status badge `ray` points at on an enemy readout or the status panel, and shows
   * its name and explanation in the tooltip above it (hidden for null or a miss).
   */
  private pointStatus(ray: THREE.Ray | null): void {
    let found: {
      hit: THREE.Intersection;
      owner: string;
      who: 'you' | 'it';
      region: StatusRegion;
    } | null = null;
    if (ray && !this.disposed) {
      this.raycaster.ray.copy(ray);
      for (const { label, owner, who, regions } of this.statusHits) {
        if (regions.length === 0 || !label.mesh.visible) continue;
        label.mesh.updateWorldMatrix(true, false);
        const hit = this.raycaster.intersectObject(label.mesh, false)[0];
        if (!hit?.uv || (found && found.hit.distance <= hit.distance)) continue;
        const region = statusAtUv(regions, hit.uv.x, hit.uv.y, label.pxWidth, label.pxHeight);
        if (region) found = { hit, owner, who, region };
      }
    }
    if (!found) {
      this.statusHover = null;
      this.tipKey = '';
      if (this.tip) this.tip.mesh.visible = false;
      return;
    }
    const { id, stacks } = found.region;
    const { name, text } =
      stacks === null
        ? stanceReadout(id)
        : { name: STATUS_NAME[id], text: statusExplanation(id, stacks, found.who) };
    this.statusHover = { owner: found.owner, id, stacks, name, text, distance: found.hit.distance };
    const tip = this.tip;
    if (!tip) return;
    const key = `${found.owner}:${id}:${stacks}`;
    if (key !== this.tipKey) {
      this.tipKey = key;
      tip.draw((ctx, w, h) =>
        drawTip(ctx, w, h, [{ title: stacks === null ? name : `${name} ${stacks}`, text }]),
      );
    }
    // Above the badge (below it when that would leave the top of the view), nudged toward the
    // viewer, turned to face them, and grown with distance so it reads as it would at
    // `STATUS_TIP_NEAR` (enemy readouts stand 2 to 3 m away).
    const eye = this.deps.camera.getWorldPosition(this.eye);
    const grow = Math.max(1, eye.distanceTo(found.hit.point) / STATUS_TIP_NEAR);
    tip.mesh.scale.setScalar(grow);
    const at = tip.mesh.position.copy(found.hit.point);
    at.addScaledVector(eye.sub(found.hit.point).normalize(), STATUS_TIP_OFFSET.toward * grow);
    const above = at.y + STATUS_TIP_OFFSET.up * grow;
    at.y = above;
    if (!fitsView(at, TIP_HALF_HEIGHT * grow, this.deps.camera)) {
      at.y = above - 2 * STATUS_TIP_OFFSET.up * grow;
    }
    this.deps.camera.getWorldQuaternion(tip.mesh.quaternion);
    tip.mesh.visible = true;
  }

  /**
   * Playtest 2026-11-17: the card the laser or mouse is on in the fan, or the card in hand, shows
   * the explanation of each keyword it uses beside it (statuses in the badge tooltip's wording).
   */
  private showCardTip(): void {
    const label = this.cardTipLabel;
    if (!label) return;
    let card: SliceCard | null = null;
    let at: THREE.Vector3 | null = null;
    const held = this.holding ? this.fling.holding : null;
    if (held && !this.drawing) {
      card = getCard(held.card.id);
      at = (this.xr?.main ?? this.mouseGrip).getWorldPosition(new THREE.Vector3());
    } else if (!this.holding && this.statusHover === null && this.fan.hovered !== null) {
      const uid = this.controller.state.piles.hand[this.fan.hovered]?.uid;
      card = this.handCard(this.fan.hovered);
      at = uid === undefined ? null : this.worldOf('card', uid);
    }
    const entries = card ? cardTip(card) : [];
    if (!card || !at || entries.length === 0) {
      this.cardTipShown = null;
      this.cardTipKey = '';
      label.mesh.visible = false;
      return;
    }
    if (card.id !== this.cardTipKey) {
      this.cardTipKey = card.id;
      label.draw((ctx, w, h) => drawTip(ctx, w, h, entries, true));
    }
    this.cardTipShown = { id: card.id, titles: entries.map((e) => e.title) };
    // Its bottom edge (where the fitted plate stands) just above the card, nudged toward the eye
    // and turned to face it.
    const eye = this.deps.camera.getWorldPosition(this.eye);
    const mesh = label.mesh;
    mesh.position.copy(at);
    mesh.position.addScaledVector(eye.sub(at).normalize(), CARD_TIP_TOWARD);
    mesh.position.y += CARD_TIP_LIFT + mesh.geometry.parameters.height / 2;
    this.deps.camera.getWorldQuaternion(mesh.quaternion);
    mesh.visible = true;
  }

  /** The waiting die follows the XR main hand while it is held; it drops back if the hand is lost. */
  private stepHeldDie(): void {
    if (!this.holdingDie) return;
    const main = this.xr?.main;
    if (!this.pendingThrow || !main) {
      this.holdingDie = false;
      this.dice.holdWaiting(null);
      return;
    }
    main.updateWorldMatrix(true, false);
    this.dice.root.updateWorldMatrix(true, false);
    this.dice.holdWaiting(this.dice.root.worldToLocal(main.getWorldPosition(this.handPoint)));
  }

  /** The card definition at fan slot `index` (the fan shows the hand in order). */
  private handCard(index: number): ReturnType<typeof getCard> | null {
    const card = this.shown ? undefined : this.controller.state.piles.hand[index];
    return card ? getCard(card.def.id) : null;
  }

  /**
   * What the table hint says now: how to throw the waiting die, or how to play an untargeted card
   * held (or, in XR, pointed at in the fan), or ''.
   */
  private tableHint(): string {
    if (this.pendingThrow) {
      if (!this.xr) return DESKTOP_DICE_HINT;
      return this.holdingDie ? XR_HELD_DICE_HINT : XR_DICE_HINT;
    }
    const held = this.holding ? this.fling.holding?.card : undefined;
    if (held?.target === 'none') return untargetedHint(held.name, this.xr ? 'held-xr' : 'held');
    if (held) return targetedHint(held.name, this.xr ? 'held-xr' : 'held');
    if (this.xr && this.holding === null && this.controller.stage === 'idle') {
      const hovered = this.fan.hovered;
      const card = hovered === null ? null : this.handCard(hovered);
      if (card?.target === 'none') return untargetedHint(card.name, 'pointed-xr');
    }
    return this.keptDiceHint;
  }

  /** Shows `text` on the table hint label (hidden for ''), redrawing only when it changes. */
  private showHint(text: string): void {
    if (text === this.hint) return;
    this.hint = text;
    const label = this.hintLabel;
    if (!label) return;
    label.mesh.visible = text !== '';
    if (text === '') return;
    label.draw((ctx, w, h) => {
      ctx.fillStyle = 'rgba(18,12,7,0.82)';
      roundRect(ctx, 4, 4, w - 8, h - 8, 18);
      ctx.fill();
      ctx.fillStyle = PALETTE.candle;
      ctx.font = 'bold 44px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // One line when it fits, else two, centred.
      const lines = ctx.measureText(text).width > w - 40 ? 2 : 1;
      wrapText(ctx, text, w / 2, h / 2 - ((lines - 1) * 52) / 2, w - 40, 52);
    });
  }

  /** True (with a HUD prompt) from a dice card's roll until its die settles: the next verb waits. */
  private diceFirst(): boolean {
    if (this.pendingThrow) {
      this.message = 'Throw the dice first';
      return true;
    }
    if (this.held) {
      this.message = 'The dice are rolling';
      return true;
    }
    return false;
  }

  /** Steps a held dice card: throws for an idle player, or releases a die that never settles. */
  private stepHeld(dt: number): void {
    const held = this.held;
    if (!held) return;
    held.waiting += dt;
    if (this.pendingThrow) {
      if (held.waiting >= DICE_AUTO_THROW_SECONDS) this.throwDice();
    } else if (held.waiting >= DICE_SETTLE_FALLBACK_SECONDS) this.releaseHeld();
  }

  /** Shows a dice card's held effects once its die has settled. */
  private releaseHeld(): void {
    const held = this.held;
    if (!held || this.pendingThrow) return;
    this.held = null;
    this.settlingDice = 0;
    const readout = this.controller.lastDice;
    if (readout) {
      this.lastResolvedRoll = readout.value;
      this.keptDiceHint =
        readout.rolls.length > 1 ? `${readout.rolls.join(' and ')} · Kept ${readout.value}` : '';
      this.message = this.keptDiceHint || `Rolled ${readout.value}`;
    }
    // A dice attack flies once its die settles: from the plate for a sigil, else from the tray.
    const sigil = this.launch?.kind === 'sigil' ? this.launch : null;
    this.launch = {
      from: sigil?.from ?? this.dice.root.getWorldPosition(new THREE.Vector3()),
      at: this.clock + (sigil ? REVEAL_EFFECT_AT : 0),
      power: sigil?.power ?? CARD_POWER,
      kind: sigil ? 'sigil' : 'card',
      reveal: sigil !== null,
    };
    if (!this.startFlight(held.state, held.events, held.logLength)) this.present(held.events);
    this.launch = null;
    this.lastShown = this.controller.state;
    this.dirty = true;
  }

  /** Drops an armed FLEE back to its resting state. */
  private disarmFlee(): void {
    if (this.fleeArmed <= 0) return;
    this.fleeArmed = 0;
    if (this.message === FLEE_CONFIRM) this.message = '';
    this.paintFlee();
  }

  /** FLEE's colour and label: dark while the enemies act, ruby CONFIRM? while armed. */
  private paintFlee(): void {
    if (!this.fleeButton) return;
    const armed = this.fleeArmed > 0;
    (this.fleeButton.material as THREE.MeshStandardMaterial).color.set(
      armed && this.shown === null ? PALETTE.ruby : PALETTE.warmBlack,
    );
    const text = armed ? FLEE_CONFIRM_LABEL : 'FLEE';
    if (this.fleeLabel && text !== this.fleeText) {
      this.fleeText = text;
      drawButtonText(this.fleeLabel, text);
    }
  }

  /** True (with a HUD prompt) while the enemy phase plays: every player verb waits for it. */
  private busy(): boolean {
    if (!this.shown) return false;
    this.message = 'Enemies are acting';
    return true;
  }

  private cancel(): void {
    this.disarmFlee();
    if (this.holding !== null) this.putBack();
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
    // The card's art blooms from the plate centre as the cast glyph collapses into it, and the
    // spell leaves it as the card burns away.
    const c = this.platePose.center;
    this.launch = {
      from: new THREE.Vector3(c.x, c.y, c.z),
      at: this.clock + GLYPH_LAUNCH_SECONDS + REVEAL_EFFECT_AT,
      power: castPower(result.multiplier),
      kind: 'sigil',
      reveal: true,
    };
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

  private hitAt(ray: THREE.Ray): 'tray' | 'plate' | 'end-turn' | 'flee' | number | null {
    this.raycaster.ray.copy(ray);
    this.group.updateWorldMatrix(true, true);
    if (this.pendingThrow) {
      const die = this.dice.waiting;
      if (die && this.raycaster.intersectObject(die, true).length > 0) return 'tray';
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
    const control = this.controlHit(ray)?.object;
    if (control)
      return control === this.fleeButton || control.parent === this.fleeButton
        ? 'flee'
        : 'end-turn';
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
    // Anything new lands the bolt in flight first, so its effects keep their rules order.
    if (this.flight && events.length > 0) this.landFlight();
    const segments = segmentEvents(events);
    const rolled = this.controller.lastDice !== this.lastDice ? this.controller.lastDice : null;
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
    } else if (rolled && getCard(rolled.cardId).dice !== undefined) {
      // The card waits for its die: the view keeps the state from before the play until it settles.
      const state = this.controller.state;
      const fresh = events.filter((e) => describeEvent(e, state) !== null).length;
      this.held = {
        state: this.lastShown,
        events: segments.flatMap((seg) => (seg.kind === 'instant' ? seg.events : [])),
        logLength: Math.max(0, this.controller.log.length - fresh),
        waiting: 0,
      };
    } else {
      const instant = segments.flatMap((seg) => (seg.kind === 'instant' ? seg.events : []));
      const state = this.controller.state;
      const fresh = events.filter((e) => describeEvent(e, state) !== null).length;
      const logLength = Math.max(0, this.controller.log.length - fresh);
      if (!this.startFlight(this.lastShown, instant, logLength)) this.present(instant);
      this.lastShown = state;
    }
    // A launch waits for its play only while the play's die rolls.
    if (!this.held) this.launch = null;
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
        this.keptDiceHint = '';
        this.pendingThrow = roll.rolls.map((value) => ({
          kind: die.faces.length === 6 ? 'd6' : die.faces.length === 8 ? 'd8' : 'd4',
          face: die.faces.indexOf(value),
          value,
        }));
        this.dice.showWaiting(this.pendingThrow[0]?.kind ?? 'd6');
        this.message =
          roll.rolls.length > 1
            ? `Throw ${roll.rolls.length} × ${die.name}`
            : `Throw the ${die.name}`;
      }
    }
    const awaited = this.controller.awaitedSigil;
    // A held sigil card is selected but not used yet: its plate opens once the trigger lays it down.
    if (awaited && this.plate.phase === 'hidden' && this.holding === null)
      this.plate.show(awaited, this.platePose);
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
    this.settleKnocks();
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
      actor.attack(seg.moveId ?? undefined);
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
      this.deathWait = DEATH_WAIT_SECONDS;
      void actor.die();
    }
    for (const actor of hits) actor.hit();
    // After the hit reaction, so the opening case takes over the pose from the blow that caused it.
    for (const actor of phases) actor.openCase();
    this.showEnemyNumbers(events);
    const hit = playerHit(events);
    if (hit) this.showPlayerHit(hit);
    this.showBodies();
  }

  /**
   * Holds a play's effects while its FX play: an attack's bolt until it lands on the enemy, a
   * block, steam, status or draw FX until it lands on its target. A sigil cast shows its card's
   * art over the plate first. `state` and `logLength` are the view from before the play. Returns
   * false (nothing held) for a play with no such FX. The rules have already resolved it.
   */
  private startFlight(state: CombatState, events: CombatEvent[], logLength: number): boolean {
    const ids: string[] = [];
    for (const e of events) {
      if (
        e.type === 'damage-dealt' &&
        e.source === PLAYER_ID &&
        e.target !== PLAYER_ID &&
        !ids.includes(e.target)
      )
        ids.push(e.target);
    }
    const launch = this.launch;
    const played = events.find((e) => e.type === 'card-played');
    const card = played?.type === 'card-played' ? getCard(played.cardId) : null;
    // Only a play the player made (with a launch point) gets effect FX besides the bolt.
    const gainedBlock = events.reduce(
      (total, e) => total + (e.type === 'block-gained' && e.target === PLAYER_ID ? e.amount : 0),
      0,
    );
    const steps = card && launch ? castFxSteps(card, gainedBlock) : [];
    const from = launch?.from ?? this.fan.root.getWorldPosition(new THREE.Vector3());
    const targets = ids.flatMap((id) => {
      const at = this.aimOfId(id);
      return at ? [{ id, at }] : [];
    });
    const land = castLandSeconds(steps);
    if (targets.length === 0 && land <= 0) return false;
    let seconds = 0;
    for (const t of targets) seconds = Math.max(seconds, flightSeconds(t.at.distanceTo(from)));
    const delay = launch ? Math.max(0, launch.at - this.clock) : 0;
    if (launch?.reveal && card) this.showReveal(card.id, Math.max(0, delay - REVEAL_EFFECT_AT));
    this.playEffectFx(steps, events, from, targets, delay, seconds, played);
    if (steps.length > 0 || targets.length > 0) perfWindow('cast');
    // The card's fling sounds with the play; everything else waits for contact.
    for (const e of events) if (e.type === 'card-played') this.deps.audio?.playCombatEvent(e);
    this.flight = {
      state,
      after: this.controller.state,
      events: events.filter((e) => e.type !== 'card-played'),
      logLength,
      from,
      power: launch?.power ?? CARD_POWER,
      kind: launch?.kind ?? 'card',
      visual: attackVisualKind(card?.id),
      targets,
      delay,
      seconds,
      contact: delay + (targets.length > 0 ? seconds : land),
      start: this.clock,
      launched: false,
    };
    return true;
  }

  /** Shows the cast card `cardId` over the plate, `delay` seconds from now. */
  private showReveal(cardId: string, delay: number): void {
    const p = this.platePose;
    const width = Math.min(2 * p.halfWidth, 2 * p.halfHeight) * REVEAL_FILL;
    const centre = {
      x: p.center.x + p.normal.x * REVEAL_LIFT,
      y: p.center.y + p.normal.y * REVEAL_LIFT,
      z: p.center.z + p.normal.z * REVEAL_LIFT,
    };
    // The card's face points along the plate normal, toward the player.
    const right = {
      x: p.up.y * p.normal.z - p.up.z * p.normal.y,
      y: p.up.z * p.normal.x - p.up.x * p.normal.z,
      z: p.up.x * p.normal.y - p.up.y * p.normal.x,
    };
    this.revealCard.show(cardId, centre, right, p.up, width, delay);
  }

  /**
   * Starts a play's FX other than the bolt, each at its step time after the effect leaves `from`
   * (`delay` from now): the ward shield in front of the player, steam from where the spell left,
   * status motes to their targets (riding with the bolt on an attack), the shimmer to the hand.
   */
  private playEffectFx(
    steps: readonly CastFxStep[],
    events: readonly CombatEvent[],
    from: THREE.Vector3,
    targets: readonly { id: string; at: THREE.Vector3 }[],
    delay: number,
    seconds: number,
    played: CombatEvent | undefined,
  ): void {
    if (steps.length === 0) return;
    const cardId = played?.type === 'card-played' ? played.cardId.replace(/\+$/, '') : undefined;
    const eye = this.deps.camera.getWorldPosition(new THREE.Vector3());
    const c = this.platePose.center;
    const ward = eye.clone().lerp(new THREE.Vector3(c.x, c.y, c.z), SHIELD_REACH);
    ward.y -= SHIELD_DROP;
    if (played?.type === 'card-played' && cardId === 'quench-seal' && played.target) {
      const heat = events.find(
        (e) => e.type === 'status-ticked' && e.target === played.target && e.status === 'overheat',
      );
      const source = this.aimOfId(played.target);
      if (heat?.type === 'status-ticked' && source) {
        for (let i = 0; i < heat.from - heat.to; i++)
          this.effectFx.motes(source, ward, 'overheat', delay + 0.055 * i);
      }
    }
    const strikes = steps.some((s) => s.kind === 'bolt');
    let block = 0;
    for (const e of events)
      if (e.type === 'block-gained' && e.target === PLAYER_ID) block += e.amount;
    if (played?.type === 'card-played') {
      const affected = events.flatMap((e) => {
        if (e.type !== 'status-applied' || e.status !== 'rust') return [];
        const at = this.aimOfId(e.target);
        return at ? [at] : [];
      });
      if (cardId !== 'counterstroke' || block > 0)
        this.foundryFx.play(played.cardId, from, eye, affected, ward, delay);
    }
    for (const step of steps) {
      const at = delay + step.at;
      if (step.kind === 'shield') {
        if (cardId === 'brass-bulwark' || cardId === 'counterstroke' || cardId === 'quench-seal')
          continue;
        this.effectFx.shield(ward, eye.clone().sub(ward), block || step.amount, at);
      } else if (step.kind === 'steam') {
        this.effectFx.steam(from, step.amount, at);
      } else if (step.kind === 'draw') {
        this.effectFx.draw(from, this.fan.root.getWorldPosition(new THREE.Vector3()), at);
      } else if (step.kind === 'motes' && step.status) {
        if (cardId === 'rust-spray' || cardId === 'rivet-plate') continue;
        if (step.toward === 'player') {
          this.effectFx.motes(from, ward, step.status, at);
          continue;
        }
        if (strikes) {
          for (const t of targets) this.effectFx.motes(from, t.at, step.status, at, seconds);
          continue;
        }
        const ids = new Set<string>();
        for (const e of events)
          if (e.type === 'status-applied' && e.target !== PLAYER_ID && e.status === step.status)
            ids.add(e.target);
        if (ids.size === 0 && played?.type === 'card-played' && played.target)
          ids.add(played.target);
        for (const id of ids) {
          const aim = this.aimOfId(id);
          if (aim) this.effectFx.motes(from, aim, step.status, at);
        }
      }
    }
  }

  /** Steps the attack in flight: sends the bolts after the launch delay, lands them at contact. */
  private stepFlight(): void {
    const f = this.flight;
    if (!f) return;
    const t = this.clock - f.start;
    if (!f.launched && t >= f.delay - 1e-9) {
      f.launched = true;
      for (const target of f.targets)
        this.fx.launch(f.from, target.at, f.seconds, f.power, f.kind, t - f.delay, f.visual);
    }
    if (t >= f.contact - 1e-9) {
      this.landFlight();
      this.paint();
    }
  }

  /** The bolts land: impact bursts, knock-back, then the held effects (HP, hit clips, sounds). */
  private landFlight(): void {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    this.lastShown = f.after;
    for (const target of f.targets) {
      this.fx.impact(target.at, f.from, f.power, f.visual);
      this.knock(target.id, f.from, f.power);
    }
    this.present(f.events);
  }

  /** Pushes enemy `id`'s body away from `from`; it eases back home on the knock curve. */
  private knock(id: string, from: THREE.Vector3, power: number): void {
    if (this.deps.reducedMotion) return;
    const body = this.enemies.find((e) => e.id === id)?.body;
    const parent = body?.parent;
    if (!body || !parent) return;
    let slot = this.knocks.find((k) => k.body === body);
    if (!slot) {
      slot = this.knocks.find((k) => k.body === null);
      if (!slot) return;
      slot.home.copy(body.position);
    }
    slot.body = body;
    slot.power = power;
    slot.t = 0;
    body.updateWorldMatrix(true, false);
    const world = body.getWorldPosition(new THREE.Vector3());
    const dir = new THREE.Vector3(world.x - from.x, 0, world.z - from.z);
    if (dir.lengthSq() < 1e-8)
      dir.set(Math.sin(this.pose.yaw * DEG), 0, -Math.cos(this.pose.yaw * DEG));
    dir.normalize();
    slot.away.copy(parent.worldToLocal(world.clone().add(dir))).sub(parent.worldToLocal(world));
  }

  private stepKnocks(dt: number): void {
    for (const k of this.knocks) {
      const body = k.body;
      if (!body) continue;
      k.t += dt;
      if (k.t >= KNOCK_SECONDS) {
        body.position.copy(k.home);
        k.body = null;
        continue;
      }
      body.position.copy(k.home).addScaledVector(k.away, knockOffset(k.t, k.power, false));
    }
  }

  /** Puts every knocked body straight back home. */
  private settleKnocks(): void {
    for (const k of this.knocks) {
      if (!k.body) continue;
      k.body.position.copy(k.home);
      k.body = null;
    }
  }

  /** The HUD side of a hit: HP readout tint, floating number, block chime, and the caller's flash. */
  private showPlayerHit(hit: PlayerHit): void {
    this.hitLog.push({ ...hit, at: this.clock, enemyId: this.beat?.seg.enemyId ?? null });
    if (this.hitLog.length > TRACE_CAP) this.hitLog.shift();
    if (hit.blocked > 0) this.sfx('block-ward');
    if (hit.hpLost > 0) this.hpPulse = 1;
    // The player's number rises from the top of the status panel, wherever the desktop fit put it;
    // without a panel, from just below the line of sight.
    const at = this.numberAt;
    if (this.status) {
      const half = this.status.mesh.geometry.parameters.height / 2;
      this.status.mesh.updateWorldMatrix(true, false);
      this.status.mesh.localToWorld(at.set(0, half + PLAYER_NUMBER_LIFT, 0.005));
    } else {
      this.deps.camera.updateWorldMatrix(true, false);
      this.deps.camera.localToWorld(at.set(0, -0.15, -0.7));
    }
    this.numbers.spawn(at, hit, PLAYER_NUMBER_SCALE);
    this.deps.onPlayerHit?.(hit);
  }

  /**
   * Floats each enemy's damage up from in front of it: one number per hit, a batch's numbers
   * (a multi-hit card) stepped sideways and up so they do not cover each other.
   */
  private showEnemyNumbers(events: readonly CombatEvent[]): void {
    const counts = new Map<string, number>();
    const eye = this.deps.camera.getWorldPosition(this.eye);
    for (const event of events) {
      if (event.type !== 'damage-dealt' || event.target === PLAYER_ID) continue;
      const aim = this.aimOfId(event.target);
      if (!aim) continue;
      const n = counts.get(event.target) ?? 0;
      counts.set(event.target, n + 1);
      const toward = this.numberAt.copy(eye).sub(aim).setY(0);
      if (toward.lengthSq() < 1e-8) toward.set(0, 0, 1);
      toward.normalize();
      const side = n === 0 ? 0 : (n % 2 === 1 ? 1 : -1) * Math.ceil(n / 2) * NUMBER_STEP.side;
      aim.addScaledVector(toward, ENEMY_NUMBER_OUT);
      aim.x -= toward.z * side;
      aim.y += ENEMY_NUMBER_UP + n * NUMBER_STEP.up;
      aim.z += toward.x * side;
      aim.y -= dropToFitView(aim, ENEMY_NUMBER_HEADROOM, this.deps.camera, ENEMY_NUMBER_MAX_DROP);
      this.numbers.spawn(aim, event);
    }
  }

  /** Steps the floating numbers and the HP readout's red tint. */
  private stepHitFeedback(dt: number): void {
    this.numbers.update(dt, this.deps.camera);
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
    for (const enemy of state.enemies) {
      if (enemy.hp > 0) this.actors.get(enemy.id)?.showIntent(enemy.intent?.id ?? null);
    }
    const icons: IconSheet | null = iconSheet();
    const vitals = (hp: number, maxHp: number, block: number) => [
      { icon: 'hp' as IconId, text: `${hp}/${maxHp}`, fallback: 'HP' },
      ...(block ? [{ icon: 'block' as IconId, text: String(block), fallback: 'Block' }] : []),
    ];
    this.statusHits.length = 0;
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
        // Vitals, then the enemy's statuses as badges the laser can point at.
        const regions = drawChipsWithStatuses(
          ctx,
          icons,
          vitals(enemy.hp, enemy.maxHp, enemy.block),
          enemy.statuses,
          w / 2,
          104,
          64,
          'center',
          w - 24,
        );
        this.statusHits.push({ label, owner: enemy.name, who: 'it', regions });
        // One icon chip per intent part (attack 4, block 7).
        const intent = intentChips(enemy, intentDamage(state, enemy.id));
        ctx.fillStyle = PALETTE.candle;
        ctx.font = 'bold 50px system-ui, sans-serif';
        const stance = foundryStance(enemy);
        if (stance === 'neutral') {
          drawIconRow(ctx, icons, intent, w / 2, 200, 92, 'center');
        } else {
          drawIconRow(ctx, icons, intent, w / 2, 172, 62, 'center');
          const { label: description } = stanceReadout(stance);
          ctx.font = 'bold 32px system-ui, sans-serif';
          ctx.fillStyle = stance === 'guarded' ? '#d9f2ff' : '#ffe0a6';
          ctx.textAlign = 'center';
          ctx.fillText(description, w / 2, 229);
          const half = ctx.measureText(description).width / 2 + 12;
          regions.push({
            id: stance,
            stacks: null,
            x0: w / 2 - half,
            x1: w / 2 + half,
            y0: 207,
            y1: 253,
          });
        }
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
      const regions = drawChipsWithStatuses(
        ctx,
        icons,
        [{ icon: 'steam', text: String(p.steam), fallback: 'Steam' }],
        p.statuses,
        24,
        122,
        60,
        'left',
        w - 48,
      );
      if (this.status)
        this.statusHits.push({ label: this.status, owner: 'You', who: 'you', regions });
      ctx.fillStyle = PALETTE.candle;
      ctx.font = '600 30px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Turn ${state.turn}`, 24, 186);
      ctx.fillText(this.banner || `Stage: ${this.stage}`, 24, 236);
      if (this.lastResolvedRoll !== null)
        ctx.fillText(`Last roll ${this.lastResolvedRoll}`, 24, 284);
    });
    // End Turn reads as disabled while the enemies act.
    const waiting = this.shown !== null;
    (this.endButton.material as THREE.MeshStandardMaterial).color.set(
      waiting ? PALETTE.void : PALETTE.warmBlack,
    );
    this.paintFlee();
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

/**
 * The table hint for an untargeted card (block, a sweep, a sigil card): held with the mouse, held in
 * the XR main hand, or pointed at in the XR fan.
 */
export function untargetedHint(name: string, how: 'held' | 'held-xr' | 'pointed-xr'): string {
  if (how === 'held') return `Click to play ${name}, right click to put it back`;
  if (how === 'held-xr') return `Pull the trigger to play ${name}, let go to put it back`;
  return `Grip to pick up ${name}, then pull the trigger`;
}

/** The table hint for a held card that needs an enemy: with the mouse, or in the XR main hand. */
export function targetedHint(name: string, how: 'held' | 'held-xr'): string {
  if (how === 'held') return `Click an enemy to play ${name}, right click to put it back`;
  return `Aim at an enemy and pull the trigger to play ${name}, let go to put it back`;
}

function drawButtonText(label: CanvasLabel, text: string, color: string = PALETTE.parchment): void {
  label.draw((ctx, w, h) => {
    ctx.fillStyle = color;
    ctx.font = `bold ${text.length > 8 ? 68 : 82}px Georgia, serif`;
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
  contentVersion?: number;
  encounter: Pick<EncounterDirector, 'phase' | 'activeRoom' | 'tablePose' | 'end'> & {
    readonly seatDistance?: number | null;
  };
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
  /** Passed to each session: softer spell effects (the OS reduced-motion preference). */
  reducedMotion?: boolean;
  /**
   * Called once a fight is decided and its banner has held, or as the player flees, with the
   * player's remaining hp.
   */
  onEnd?: (end: {
    room: number;
    outcome: 'win' | 'defeat' | 'flee';
    playerHp: number | null;
  }) => void;
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
  /** Holds the open fight still (and every fight that opens meanwhile); see `CombatSession.paused`. */
  paused = false;

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
    if (this.session) this.session.paused = this.paused;
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
    const seat = floor.encounter.seatDistance;
    this.handedOver = false;
    const models =
      this.deps.models === undefined ? sharedDiceModels() : Promise.resolve(this.deps.models);
    const promise = models.then((diceModels) =>
      CombatSession.create({
        seed: floor.seed,
        room,
        tier,
        ...(floor.contentVersion === undefined ? {} : { contentVersion: floor.contentVersion }),
        tablePose: pose,
        ...(seat == null ? {} : { seatDistance: seat }),
        bodies,
        root: floor.world.group,
        camera: this.deps.camera,
        sockets: floor.tableSockets(),
        actions: this.deps.actions,
        actorOf: (body) => floor.actorOf?.(body) ?? null,
        ...(this.deps.onPlayerHit ? { onPlayerHit: this.deps.onPlayerHit } : {}),
        ...(this.deps.reducedMotion === undefined
          ? {}
          : { reducedMotion: this.deps.reducedMotion }),
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
