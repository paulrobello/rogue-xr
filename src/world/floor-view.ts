import * as THREE from 'three';
import { EncounterDirector } from '../combat/encounter.ts';
import {
  ARMORY_ALCOVE_VERSION,
  BORROWED_LIGHT_VERSION,
  BRASS_CACHE_VERSION,
  chooseEncounter,
  DARK_CIRCUIT_VERSION,
  DISPATCH_ROOM_VERSION,
  DRUM_GALLERY_VERSION,
  DUNGEON_CONTENT_VERSION,
  ENCOUNTER_CONTENT_VERSION,
  FLOAT_ELEVATOR_VERSION,
  HIDDEN_PANEL_VERSION,
  PATROL_VERSION,
  PENDULUM_GALLERY_VERSION,
  PRESSURE_WORKS_VERSION,
  PRISM_ANNEX_VERSION,
  RELIQUARY_VERSION,
  RETURN_PASSAGES_VERSION,
  SHADOW_STENCIL_VERSION,
  SPEAKING_PIPES_VERSION,
  SPRING_TENSION_VERSION,
  THEMED_FURNISHINGS_VERSION,
  UPPER_WORKS_VERSION,
  VALVEHOUSE_VERSION,
} from '../combat/encounter-choice.ts';
import { combatRoom, rigTurnAboutHead } from '../combat/placement.ts';
import { buildTableGreybox, disposeTable, TABLE_NODES } from '../combat/table-greybox.ts';
import { ARMORY_ENCOUNTER } from '../content/enemies.ts';
import { type RoomTemplate, templateById } from '../content/rooms.ts';
import { isValidSeed, normalizeSeed, randomSeed, Stream } from '../core/rng.ts';
import { BreakApart } from '../enemies/break-apart.ts';
import { ClockworkOwlFlight, makeOwlPerch } from '../enemies/conservatory-actors.ts';
import type { EnemyActor, EnemyAsset } from '../enemies/enemy-asset.ts';
import { type PatrolClips, PatrolVisual } from '../enemies/patrol-visual.ts';
import { attachArmoryAlcove } from '../floor/armory-alcove.ts';
import { attachBorrowedLight } from '../floor/borrowed-light.ts';
import { conservatoryPlan } from '../floor/conservatory.ts';
import { attachDarkCircuit } from '../floor/dark-circuit.ts';
import { attachDispatchRoom } from '../floor/dispatch-room.ts';
import { attachDrumGallery } from '../floor/drum-gallery.ts';
import { attachFloatElevator } from '../floor/float-elevator.ts';
import {
  attachPressureWing,
  type FloorPlan,
  generateFloor,
  generateUpperFloor,
  isShowcaseFloor,
  SHOWCASE_UPPER_SEED,
} from '../floor/generate.ts';
import { attachHiddenPassage } from '../floor/hidden-passage.ts';
import { type PatrolRoute, patrolPeriod, planPatrol, samplePatrol } from '../floor/patrol.ts';
import { attachPendulumGallery } from '../floor/pendulum-gallery.ts';
import { attachPrismAnnex } from '../floor/prism-annex.ts';
import { attachReliquary } from '../floor/reliquary.ts';
import { attachFloorOneTopology, withBrassCache } from '../floor/return-passages.ts';
import { attachShadowStencil } from '../floor/shadow-stencil.ts';
import { attachSpeakingPipes } from '../floor/speaking-pipes.ts';
import { attachSpringTension } from '../floor/spring-tension.ts';
import { placeStairEntry } from '../floor/stairs.ts';
import { type StoneRoom, stoneRoomsFor } from '../floor/stone-rooms.ts';
import { attachValvehouse } from '../floor/valvehouse.ts';
import { nearSet, shellSet } from '../floor/visibility.ts';
import { wallSpanIsExposed } from '../floor/wall-exposure.ts';
import { PALETTE } from '../palette.ts';
import type { RunSnapshot } from '../persist/saves.ts';
import { conservatoryFormula } from '../rules/alchemy.ts';
import type { CommissionKind } from '../rules/commissions.ts';
import type { TreasureLoot } from '../rules/run.ts';
import type { BellNote } from '../rules/types.ts';
import {
  DEFAULT_VIGNETTE,
  moveWithCollision,
  type Vec2,
  validateLanding,
  vignetteStep,
  yawFromMatrix,
} from '../xr/locomotion.ts';
import { AlchemyConservatory } from './alchemy-conservatory.ts';
import { ArmoryAlcove } from './armory-alcove.ts';
import { AstralLift } from './astral-lift.ts';
import { BellChimes } from './bell-chimes.ts';
import { BookSecret } from './book-secret.ts';
import { BorrowedLight } from './borrowed-light.ts';
import { BrassKeyStand } from './brass-key.ts';
import { CalibrationBench } from './calibration-bench.ts';
import { CalibrationCabinet, CalibrationKeyStand } from './calibration-cabinet.ts';
import { CommissionOffice } from './commission-office.ts';
import { ConservatoryArchive } from './conservatory-archive.ts';
import { ConservatoryGallery } from './conservatory-gallery.ts';
import { CounterweightStation } from './counterweight-station.ts';
import { DarkCircuit } from './dark-circuit.ts';
import { DispatchRoom } from './dispatch-room.ts';
import { DrumGallery } from './drum-gallery.ts';
import { animateFires, CANDLE_NODE, dressTorchFlames, FIRE_NODE } from './fireplace.ts';
import { FloatElevator } from './float-elevator.ts';
import { buildFloorWorld, type FloorWorld } from './floor-world.ts';
import { FormulaEvidence } from './formula-clue.ts';
import {
  type Hearth,
  type HearthMaterials,
  type HearthPick,
  hearthLines,
  pickHearth,
} from './hearth.ts';
import { InteriorFurnishings, type InteriorFurnishingsAsset } from './interior-furnishings.ts';
import type { CofferCardFace } from './loot.ts';
import {
  type Coffer,
  type LootMaterials,
  type LootPick,
  LootToast,
  pickCoffer,
  type ToastLines,
} from './loot.ts';
import { PendulumGallery } from './pendulum-gallery.ts';
import { PressureNotes } from './pressure-notes.ts';
import { PressureWorks } from './pressure-works.ts';
import { PrismAnnex } from './prism-annex.ts';
import {
  applyRoomStyle,
  applyUpperShaftFinish,
  copyHallBenches,
  copyStudyDesk,
  disposeRoomStyle,
  type RoomStyleKit,
  roomStyleFor,
} from './room-styles.ts';
import { ServicePanels } from './service-panels.ts';
import { ShadowStencil } from './shadow-stencil.ts';
import { SpeakingPipes } from './speaking-pipes.ts';
import { SpringTension } from './spring-tension.ts';
import { Stairwell } from './stairwell.ts';
import { StoneReliquary } from './stone-reliquary.ts';
import { applyStoneRoom, furnishStoneRoom, type StoneRoomKit } from './stone-rooms.ts';
import { StrikingClock } from './striking-clock.ts';
import { type RigidNode, rigidAngle } from './study-room.ts';
import { furnishThemedRoom } from './themed-furnishings.ts';
import { Valvehouse } from './valvehouse.ts';
import { WallVentSteam } from './wall-vent-steam.ts';
import { dressWindowBays, exposedWindowBays } from './window-bays.ts';
import { WindowKeyCache, windowCacheBay } from './window-light.ts';

export interface FloorAudio {
  playChime?(note: 0 | 1 | 2, at: THREE.Vector3): boolean;
  playSfx(
    id: 'door-open' | 'gear-clank' | 'pendulum-tick',
    at?: { x: number; y: number; z: number },
    volume?: number,
  ): boolean;
}

/** The run seed from `?seed=`, or a fresh random one when it is missing or malformed. */
export function seedFromQuery(search: string): string {
  const raw = new URLSearchParams(search).get('seed');
  if (raw && isValidSeed(raw)) return normalizeSeed(raw);
  if (raw) console.warn(`ignoring invalid seed "${raw}"`);
  return randomSeed();
}

/** Farthest a pointer reaches a coffer, in metres: the study's desk is about 3.5 m from its door. */
export const LOOT_REACH = 4;
/** Height above a coffer's base where its toast hangs, in metres. */
const TOAST_LIFT = 0.95;

/** Height above a hearth's base where its panel hangs, in metres (over the bowl). */
const HEARTH_TOAST_LIFT = 1.25;
/**
 * Actors in rooms seen only down a corridor step once every this many frames, in turn, with the
 * skipped seconds folded in and no look-at; actors in hidden rooms hold their pose.
 */
export const SHELL_ACTOR_EVERY = 4;

/** The treasure coffers of a floor: picking, opening and the found-item panel. */
export interface FloorLoot {
  readonly coffers: readonly Coffer[];
  /** The nearest unopened coffer in the current room a ray reaches, or null. */
  pick(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance?: number): LootPick | null;
  /** Swings the coffer's lid open and shows `found` on a panel over it. Returns false for an unknown coffer. */
  open(room: number, socketId: string, found: TreasureLoot): boolean;
  /** Shows the lock message if the coffer still belongs to an uncleared encounter. */
  showLock(room: number, socketId: string): boolean;
  /** Shows a coffer already open, with no panel (resuming a saved run). */
  markOpened(room: number, socketId: string): void;
  /** Dresses the coffers in the game's walnut and brass (the flat placeholders stay on a failure). */
  dress(materials: LootMaterials): void;
  /** The panel on screen: its first line (what was found) and the canvas it is drawn on. */
  readonly toast: { readonly text: string; readonly canvas: HTMLCanvasElement } | null;
  /** A floor point `distance` m from the coffer toward its room's centre, for scripted approaches. */
  approachPoint(room: number, socketId: string, distance?: number): THREE.Vector3 | null;
  syncBrassLock(spent: boolean, immediate?: boolean): void;
  nearBrassLock(point: THREE.Vector3, reach: number): { room: number; socketId: string } | null;
}

/** The rest-room hearths of a floor: picking, using and the hp panel. */
export interface FloorHearths {
  readonly hearths: readonly Hearth[];
  /** The nearest unused hearth in the current room a ray reaches, or null. */
  pick(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance?: number): HearthPick | null;
  /** Dims the hearth's coals and shows '+healed hp' on a panel over it. Returns false for an unknown hearth. */
  use(room: number, socketId: string, healed: number): boolean;
  /** Shows a hearth already spent, with no panel (resuming a saved run). */
  markUsed(room: number, socketId: string): void;
  /** Dresses the hearths' brass (the flat placeholder stays on a failure). */
  dress(materials: HearthMaterials): void;
  /** The panel on screen (shared with the coffers: one at a time) and the canvas it is drawn on. */
  readonly toast: { readonly text: string; readonly canvas: HTMLCanvasElement } | null;
  /** A floor point `distance` m from the hearth toward its room's centre, for scripted approaches. */
  approachPoint(room: number, socketId: string, distance?: number): THREE.Vector3 | null;
}

export interface FloorView {
  world: FloorWorld;
  readonly floorNumber: 1 | 2 | 3;
  readonly stairs: Stairwell | null;
  readonly chimes: BellChimes | null;
  readonly windowCache: WindowKeyCache | null;
  readonly alchemy: AlchemyConservatory | null;
  readonly clock: StrikingClock | null;
  readonly formulaEvidence: FormulaEvidence | null;
  readonly archive: ConservatoryArchive | null;
  readonly prismAnnex: PrismAnnex | null;
  dressPrism(art: THREE.Object3D, runSeed: string, reducedMotion: boolean): void;
  readonly lift: AstralLift | null;
  dressConservatory(
    art: THREE.Object3D,
    archiveKit: THREE.Object3D,
    textures: readonly THREE.Texture[],
    runSeed: string,
    reducedMotion: boolean,
  ): void;
  readonly office: CommissionOffice | null;
  dressCommission(art: THREE.Object3D, kind: CommissionKind, reducedMotion: boolean): void;
  readonly calibrationBench: CalibrationBench | null;
  readonly chartCabinet: CalibrationCabinet | null;
  readonly calibrationKey: CalibrationKeyStand | null;
  dressCalibration(
    art: THREE.Object3D,
    tools: THREE.Object3D,
    seed: string,
    face: (id: string) => CofferCardFace,
    reduced: boolean,
  ): void;
  readonly panels: ServicePanels | null;
  dressPanels(art: THREE.Object3D, reducedMotion: boolean): void;
  readonly dispatchRoom: DispatchRoom | null;
  dressDispatch(art: THREE.Object3D, runSeed: string, reducedMotion: boolean): void;
  readonly speakingPipes: SpeakingPipes | null;
  dressSpeakingPipes(
    art: THREE.Object3D | undefined,
    runSeed: string,
    reducedMotion: boolean,
  ): void;
  readonly floatElevator: FloatElevator | null;
  dressFloatElevator(
    art: THREE.Object3D | undefined,
    seed: string,
    reduced: boolean,
    environment: THREE.Texture | null,
  ): void;
  readonly shadowStencil: ShadowStencil | null;
  dressShadowStencil(
    art: THREE.Object3D | undefined,
    seed: string,
    reduced: boolean,
    environment: THREE.Texture | null,
  ): void;
  readonly springTension: SpringTension | null;
  readonly darkCircuit: DarkCircuit | null;
  readonly drumGallery: DrumGallery | null;
  dressDrumGallery(
    art: THREE.Object3D | undefined,
    seed: string,
    reduced: boolean,
    environment: THREE.Texture | null,
    onBeat: (notes: readonly BellNote[], at: THREE.Vector3) => void,
    onRelease: (at: THREE.Vector3) => void,
  ): void;
  dressDarkCircuit(
    runSeed: string,
    reducedMotion: boolean,
    environment: THREE.Texture | null,
  ): void;
  dressSpringTension(
    art: THREE.Object3D | undefined,
    seed: string,
    reduced: boolean,
    environment: THREE.Texture | null,
  ): void;
  readonly borrowedLight: BorrowedLight | null;
  dressBorrowedLight(
    art: THREE.Object3D | undefined,
    seed: string,
    reduced: boolean,
    environment: THREE.Texture | null,
  ): void;
  readonly pendulumGallery: PendulumGallery | null;
  dressPendulumGallery(
    art: THREE.Object3D | undefined,
    seed: string,
    reduced: boolean,
    finish: () => 'ignored' | 'wrong' | 'opened',
    tick: (at: THREE.Vector3) => void,
  ): void;
  readonly armoryAlcove: ArmoryAlcove | null;
  challengeArmor(head: THREE.Object3D): boolean;
  readonly valvehouse: Valvehouse | null;
  dressValvehouse(runSeed: string, reducedMotion: boolean): void;
  readonly reliquary: StoneReliquary | null;
  dressReliquary(runSeed: string, reducedMotion: boolean): void;
  readonly counterweight: CounterweightStation | null;
  dressChimes(art: THREE.Object3D): void;
  dressStairs(model: THREE.Object3D): void;
  readonly styledRooms: readonly THREE.Group[];
  readonly stoneRooms: ReadonlyMap<number, StoneRoom>;
  readonly stoneTorches: ReadonlyMap<number, THREE.Object3D>;
  dressStoneFurnishings(kit: StoneRoomKit): void;
  dressThemedFurnishings(kit: StoneRoomKit): void;
  dressRoomTorches(reducedMotion: boolean): void;
  loot: FloorLoot;
  readonly brassKeyStand: BrassKeyStand | null;
  dressBrassKey(art: THREE.Object3D): void;
  hearth: FloorHearths;
  book: BookSecret;
  showBookSecret(lines: ToastLines, head: THREE.Object3D): void;
  dismissPuzzleToast(): void;
  pressure: PressureWorks | null;
  notes: PressureNotes | null;
  readonly furnishings: InteriorFurnishings | null;
  setFurnishings(
    asset: InteriorFurnishingsAsset,
    paintings: readonly THREE.Texture[],
    reducedMotion: boolean,
  ): void;
  setCandleMaterials(
    materials: readonly THREE.MeshStandardMaterial[],
    reducedMotion: boolean,
  ): void;
  seed: string;
  readonly contentVersion: number;
  encounter: EncounterDirector;
  /** True while an encounter holds the player in place. */
  readonly locked: boolean;
  /**
   * Comfort vignette strength (0 to `DEFAULT_VIGNETTE.maxStrength`) from the snap that turned the
   * rig to face a fight's table; it fades on the locomotion release ramp. 0 when nothing turned.
   */
  readonly turnVignette: number;
  /**
   * Streams rooms around the head and triggers encounters. `head` is the camera; call once per
   * frame before rendering. A fight whose table had to turn off the head's heading snaps the rig
   * about the head by that turn as the fight starts, so the player faces the table.
   */
  update(head: THREE.Object3D, dt: number, cameras?: readonly THREE.Camera[]): void;
  /** Updates the preference and repositions the rig during a fight when the path is clear. */
  setTableDistance(distance: number, head: THREE.Object3D): boolean;
  /**
   * Swaps the greybox table for a loaded asset (the P4-T5 GLB). The asset must expose `leaf-left`
   * and `leaf-right`; its top is `authoredTopHeight` above its origin and is fitted to each
   * encounter's waist height on a parent group, since `setTableUnfold` owns the root's scale.
   */
  useTableAsset(asset: THREE.Object3D, authoredTopHeight: number): void;
  /** True once `useTableAsset` replaced the greybox. */
  readonly realTable: boolean;
  /** The table's dice-tray and sigil-plate sockets (the greybox has no plate socket). */
  tableSockets(): { diceTray: THREE.Object3D | null; sigilPlate: THREE.Object3D | null };
  /**
   * Dresses every room built from `templateId` with `instantiate()`'s baked model in place of its
   * greybox. Rooms keep the greybox when this is never called (the asset failed to load). Each
   * instance's `rigidNodes` turn from then on while their room is shown, until `dispose`.
   */
  useRoomAsset(
    templateId: string,
    instantiate: () => THREE.Object3D,
    rigidNodes?: readonly RigidNode[],
    roomStyleKit?: RoomStyleKit,
    instantiateClosedHall?: () => THREE.Object3D,
    stoneKit?: StoneRoomKit,
  ): number;
  /** Rigid nodes (the gear-shaft crown gear) this floor turns each frame. */
  readonly spinnerCount: number;
  /**
   * Adds loaded models, keyed by enemy kind, and swaps each placeholder of that kind for a spawned
   * actor as soon as no fight is running. Calls accumulate, so models can arrive one at a time;
   * kinds never given keep their capsules. Bodies already removed (cleared rooms) are skipped.
   * `prepare` runs on each new actor before it is placed. The assets stay the caller's: disposing
   * the floor disposes its actors, never the shared assets.
   */
  useEnemyAssets(
    assets: ReadonlyMap<string, EnemyAsset>,
    prepare?: (actor: EnemyActor) => void,
  ): void;
  /** The actor standing in for an automaton body, or null for a placeholder. */
  actorOf(body: THREE.Object3D): EnemyActor | null;
  readonly patrolBody: THREE.Object3D | null;
  dressPatrol(asset: EnemyAsset, clips: PatrolClips, prepare: (actor: EnemyActor) => void): void;
  clearPatrol(): void;
  /** Live automaton actors on this floor. */
  readonly actors: readonly EnemyActor[];
  /**
   * While true, `update` still runs the encounter (so a finished fight folds away) but never starts a
   * new one. The game flow sets it outside exploration, so a lost fight cannot re-trigger.
   */
  suspendTriggers: boolean;
  /** Removes `room`'s automatons so its encounter never fires again (resuming a saved run). */
  markCleared(room: number, silent?: boolean): void;
  /** Connects the shared audio director after the floor is mounted. */
  setAudio(audio: FloorAudio | null): void;
  dressVentSteam(reducedMotion: boolean): void;
  /** A standing point about 1 m inside `room` from its first door, or null for an unknown room. */
  standPoint(room: number): THREE.Vector3 | null;
  /** Removes the floor, its lights and the table from the scene and frees their GPU resources. */
  dispose(): void;
}

/** The enemy kind each body will play, in socket order, from the room's seeded encounter. */
function tagEnemyKinds(
  world: FloorWorld,
  seed: string,
  contentVersion: number,
  floorNumber: number,
  stoneRooms: ReadonlyMap<number, StoneRoom>,
): void {
  for (const [room, bodies] of world.enemies) {
    const tier = world.plan.rooms[room]?.encounter?.tier;
    if (!tier || bodies.length === 0) continue;
    const { enemies } =
      world.plan.armoryAlcove?.room === room
        ? ARMORY_ENCOUNTER
        : chooseEncounter(
            seed,
            room,
            tier,
            bodies.length,
            contentVersion,
            floorNumber,
            stoneRooms.get(room) === 'dungeon',
          );
    bodies.forEach((body, i) => {
      const kind = enemies[i];
      if (kind) body.userData.enemyKind = kind;
    });
  }
}

export interface FloorViewOptions {
  floorNumber?: 1 | 2 | 3;
  /** The reserved room-showcase launch enables walkthrough plaques. */
  guidedShowcase?: boolean;
  preservedBookRooms?: readonly number[];
  /** Templates the world is built from (the floor plan always uses the greybox set). */
  templates?: readonly RoomTemplate[];
  /** Encounter content generation used to build this floor. */
  contentVersion?: number;
}

export function playableFloorPlan(
  seed: string,
  contentVersion: number,
  floorNumber: 1 | 2 | 3 = 1,
) {
  if (floorNumber === 3) {
    const plan = conservatoryPlan(seed);
    const prism = contentVersion >= PRISM_ANNEX_VERSION ? attachPrismAnnex(plan) : plan;
    const gallery =
      contentVersion >= PENDULUM_GALLERY_VERSION ? attachPendulumGallery(prism) : prism;
    const optics =
      contentVersion >= BORROWED_LIGHT_VERSION ? attachBorrowedLight(gallery) : gallery;
    if (contentVersion < DRUM_GALLERY_VERSION) return optics;
    const windows = exposedWindowBays(optics, 3);
    return attachDrumGallery(optics, (candidate) => {
      const retained = exposedWindowBays(candidate, 3);
      return windows.every((old) =>
        retained.some((bay) => bay.room === old.room && bay.x === old.x && bay.z === old.z),
      );
    });
  }
  const upperWorks = floorNumber === 2 && contentVersion >= UPPER_WORKS_VERSION;
  const generated = upperWorks ? generateUpperFloor(seed) : generateFloor(seed);
  const base =
    floorNumber === 2 && seed === SHOWCASE_UPPER_SEED
      ? { ...generated, rooms: generated.rooms.map((r) => ({ ...r, encounter: null })) }
      : generated;
  if (floorNumber === 2 && contentVersion >= HIDDEN_PANEL_VERSION) {
    const upper = attachHiddenPassage(base);
    const dispatch = contentVersion >= DISPATCH_ROOM_VERSION ? attachDispatchRoom(upper) : upper;
    const pipes =
      contentVersion >= SPEAKING_PIPES_VERSION ? attachSpeakingPipes(dispatch) : dispatch;
    const reliquary = contentVersion >= RELIQUARY_VERSION ? attachReliquary(pipes) : pipes;
    const armory =
      contentVersion >= ARMORY_ALCOVE_VERSION ? attachArmoryAlcove(reliquary) : reliquary;
    if (contentVersion < SPRING_TENSION_VERSION) return armory;
    const preserveAccess = (original: FloorPlan) => {
      const landing = placeStairEntry(original);
      const windows = exposedWindowBays(original, 2);
      return (candidate: FloorPlan) => {
        const entry = placeStairEntry(candidate);
        if (entry?.room !== landing?.room || entry?.door !== landing?.door) return false;
        const remaining = exposedWindowBays(candidate, 2);
        return windows.every((window) =>
          remaining.some((bay) => bay.room === window.room && bay.x === window.x),
        );
      };
    };
    const workshop = attachSpringTension(armory, preserveAccess(armory));
    return contentVersion >= DARK_CIRCUIT_VERSION
      ? attachDarkCircuit(workshop, preserveAccess(workshop))
      : workshop;
  }
  if (contentVersion < PRESSURE_WORKS_VERSION || floorNumber !== 1) return base;
  if (contentVersion < RETURN_PASSAGES_VERSION) return attachPressureWing(base);
  const lower = attachFloorOneTopology(base);
  const brass = contentVersion >= BRASS_CACHE_VERSION ? withBrassCache(lower) : lower;
  const valves = contentVersion >= VALVEHOUSE_VERSION ? attachValvehouse(brass) : brass;
  if (contentVersion < FLOAT_ELEVATOR_VERSION) return valves;
  const windows = exposedWindowBays(valves, 1);
  const preservesWindows = (candidate: typeof valves): boolean => {
    const remaining = exposedWindowBays(candidate, 1);
    return windows.every((window) =>
      remaining.some((bay) => bay.room === window.room && bay.x === window.x),
    );
  };
  const reservoir = attachFloatElevator(valves, preservesWindows);
  return contentVersion >= SHADOW_STENCIL_VERSION
    ? attachShadowStencil(reservoir, preservesWindows)
    : reservoir;
}

/** The former upper pressure wing occupied the two appended room indices. */
export function restoreUpperRoomLocations(
  snapshot: RunSnapshot,
  templates?: readonly RoomTemplate[],
): RunSnapshot {
  const upstairs = snapshot.floorNumber === 2;
  const archived = snapshot.floors?.find((f) => f.floorNumber === 2);
  const upperSeed = upstairs ? snapshot.floorSeed : archived?.floorSeed;
  if (!upperSeed) return snapshot;
  const plan = playableFloorPlan(upperSeed, snapshot.contentVersion ?? 1, 2);
  const available = (index: number) => index >= 0 && index < plan.rooms.length;
  if (upstairs) {
    const visits = snapshot.reachedRooms;
    if (available(snapshot.roomIndex) && !visits?.some((i) => !available(i))) return snapshot;
    return {
      ...snapshot,
      roomIndex: available(snapshot.roomIndex)
        ? snapshot.roomIndex
        : (placeStairEntry(plan, templates)?.room ?? 0),
      ...(visits && { reachedRooms: visits.filter(available) }),
    };
  }
  if (!archived?.reachedRooms.some((i) => !available(i))) return snapshot;
  return {
    ...snapshot,
    floors: snapshot.floors?.map((f) =>
      f === archived ? { ...f, reachedRooms: f.reachedRooms.filter(available) } : f,
    ),
  };
}

/** Greybox exploration view: the generated floor, flat greybox lighting, the rig at the entry. */
export function mountFloorView(
  scene: THREE.Scene,
  rig: THREE.Object3D,
  seed: string,
  options: FloorViewOptions = {},
): FloorView {
  const contentVersion = options.contentVersion ?? ENCOUNTER_CONTENT_VERSION;
  const plan = playableFloorPlan(seed, contentVersion, options.floorNumber);
  let stairs: Stairwell | null = null;
  let chimes: BellChimes | null = null;
  let alchemy: AlchemyConservatory | null = null,
    clockwork: StrikingClock | null = null,
    lift: AstralLift | null = null,
    gallery: ConservatoryGallery | null = null;
  let formulaEvidence: FormulaEvidence | null = null,
    archive: ConservatoryArchive | null = null;
  let prismAnnex: PrismAnnex | null = null;
  let office: CommissionOffice | null = null;
  let calibrationBench: CalibrationBench | null = null,
    chartCabinet: CalibrationCabinet | null = null,
    calibrationKey: CalibrationKeyStand | null = null;
  let panels: ServicePanels | null = null;
  let dispatchRoom: DispatchRoom | null = null;
  let speakingPipes: SpeakingPipes | null = null;
  let reliquary: StoneReliquary | null = null;
  let valvehouse: Valvehouse | null = null;
  let pendulumGallery: PendulumGallery | null = null;
  let borrowedLight: BorrowedLight | null = null;
  let floatElevator: FloatElevator | null = null;
  let shadowStencil: ShadowStencil | null = null;
  let springTension: SpringTension | null = null;
  let darkCircuit: DarkCircuit | null = null;
  let drumGallery: DrumGallery | null = null;
  let counterweight: CounterweightStation | null = null;
  const floorNumber = options.floorNumber ?? 1;
  const stoneRooms: ReadonlyMap<number, StoneRoom> =
    contentVersion >= DUNGEON_CONTENT_VERSION ? stoneRoomsFor(plan, floorNumber) : new Map();
  const world = buildFloorWorld(plan, options.templates);
  const windowBays = exposedWindowBays(plan, floorNumber);
  const cacheBay = floorNumber === 1 ? windowCacheBay(world, windowBays, seed) : undefined;
  const windowDressing = new Map<number, () => void>();
  let windowCache: WindowKeyCache | null = null;
  const brassCache = plan.brassCache;
  let ventSteam: WallVentSteam | null = null;
  let brassKeyStand: BrassKeyStand | null = null;
  const notes = plan.pressureWing ? new PressureNotes(world, contentVersion) : null;
  const guided =
    options.guidedShowcase === true && floorNumber !== 3 && isShowcaseFloor(plan.seed, floorNumber);
  const pressure = plan.pressureWing ? new PressureWorks(world, plan.pressureWing, guided) : null;
  tagEnemyKinds(world, seed, contentVersion, floorNumber, stoneRooms);
  scene.add(world.group);
  // Greybox lighting is two global lights; per-room sockets get real lights with the lightmaps (P4-T7).
  const sun = new THREE.DirectionalLight(PALETTE.candle, 1.4);
  sun.position.set(6, 12, 4);
  const sky = new THREE.HemisphereLight(PALETTE.candle, PALETTE.void, 0.8);
  if (floorNumber === 3) {
    sun.color.set(0xc3d4ff);
    sky.color.set(0xdbe6ff);
    sky.groundColor.set(0x564357);
    sky.intensity = 1.25;
  }
  scene.add(sun, sky);
  // x/z only: in XR the rig's y holds the seated-height lift, and floors rebuild mid-session.
  const spawn = world.spawnPoint();
  rig.position.set(spawn.x, rig.position.y, spawn.z);

  let locked = false;
  let floorAudio: FloorAudio | null = null;
  const tickClock = (at: THREE.Vector3, volume: number) =>
    floorAudio?.playSfx('pendulum-tick', at, volume);
  let suppressUnlockAudio = false;
  const reducedUnlockMotion =
    typeof globalThis.matchMedia === 'function' &&
    globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const armory = plan.armoryAlcove
    ? new ArmoryAlcove(world, plan.armoryAlcove.room, reducedUnlockMotion)
    : null;
  let suspended = false;
  let turnVignette = 0;
  let patrolSeatTurn = 0;
  // The director keeps this host for its life; the greybox or the real asset hangs under it.
  const tableHost = new THREE.Group();
  tableHost.name = 'combat-table-host';
  let greybox: THREE.Object3D | null = buildTableGreybox();
  tableHost.add(greybox);
  let fit: THREE.Group | null = null;
  let authoredTop = 1;
  let patrol: {
    actor: EnemyActor;
    gait: PatrolVisual;
    route: PatrolRoute;
    elapsed: number;
  } | null = null;
  const wall = new THREE.Box3();
  const crossing = new THREE.Vector3();
  const sight = new THREE.Ray();
  const encounter = new EncounterDirector({
    world,
    table: tableHost,
    onCleared: (room) => {
      if (room === armory?.room) armory.sync(true, true);
      const doorAt = world.releaseGuardedDoor(room, suppressUnlockAudio);
      if (doorAt && !suppressUnlockAudio) floorAudio?.playSfx('door-open', doorAt);
      for (const coffer of world.coffers) {
        if (coffer.room !== room || !plan.rooms[room]?.encounter) continue;
        if (!coffer.unlock(suppressUnlockAudio || reducedUnlockMotion)) continue;
        const at = coffer.object.getWorldPosition(new THREE.Vector3());
        if (!suppressUnlockAudio) floorAudio?.playSfx('gear-clank', at);
      }
    },
    lockLocomotion: (l) => {
      locked = l;
    },
  });
  const at = new THREE.Vector3();
  const alignSeat = (degrees: number, eye: THREE.Vector3): void => {
    if (degrees === 0) return;
    const turn = rigTurnAboutHead([rig.position.x, rig.position.z], [eye.x, eye.z], degrees);
    rig.position.x = turn.x;
    rig.position.z = turn.z;
    rig.rotation.y += turn.rotationY;
    rig.updateMatrixWorld(true);
    turnVignette = DEFAULT_VIGNETTE.maxStrength;
  };
  const actors = new Map<THREE.Object3D, EnemyActor>();
  const owls = new Map<
    EnemyActor,
    { perch: ReturnType<typeof makeOwlPerch>; flight: ClockworkOwlFlight }
  >();
  /** Per actor: its turn among shell-room steps and the seconds not yet stepped. */
  const paces = new Map<EnemyActor, { slot: number; pending: number }>();
  let slots = 0;
  let frame = 0;
  let tiersFor = -1;
  let near = new Set<number>();
  let shell = new Set<number>();
  // H9: an automaton whose death clip has ended falls apart into its parts, under the floor group
  // so a cleared room (which unparents and disposes the actor) never takes the pieces with it.
  const debris = new BreakApart(world.group);
  const shattered = new WeakSet<EnemyActor>();
  let shatters = 0;
  const models = new Map<
    string,
    { asset: EnemyAsset; prepare?: ((actor: EnemyActor) => void) | undefined }
  >();
  let undressed = false;
  const dressEnemies = (): void => {
    if (!undressed || encounter.phase !== 'idle') return;
    undressed = false;
    for (const [room, bodies] of world.enemies) {
      for (const [index, body] of [...bodies].entries()) {
        const kind = body.userData.enemyKind;
        const model = typeof kind === 'string' ? models.get(kind) : undefined;
        if (!model || actors.has(body) || !body.parent) continue;
        const actor = model.asset.spawn(index);
        model.prepare?.(actor);
        if (world.replaceEnemy(room, body, actor.object)) {
          actors.set(actor.object, actor);
          paces.set(actor, { slot: slots++, pending: 0 });
          if (kind === 'clockwork-owl') {
            const perch = makeOwlPerch();
            perch.object.position.copy(actor.object.position);
            perch.object.rotation.y = actor.object.rotation.y;
            world.roomGroups[room].add(perch.object);
            owls.set(actor, { perch, flight: new ClockworkOwlFlight(actor.object) });
          }
          // Poses the idle clip now, so a hidden room's actor never shows its bind pose.
          actor.update(0);
        } else actor.dispose();
      }
    }
  };
  interface Spinner {
    node: THREE.Object3D;
    axis: THREE.Vector3;
    radPerSec: number;
    room: THREE.Object3D;
  }
  const styledRooms: THREE.Group[] = [];
  const stoneFixtureReleases: (() => void)[] = [];
  let themedFurnishingsDressed = false;
  const stoneTorches = new Map<number, THREE.Object3D>();
  const shaftFinishes: THREE.Material[] = [];
  const spinners: Spinner[] = [];
  /** Live fireplace fires (the hall's); instances of one template share the material and its clock. */
  const fires: { material: THREE.ShaderMaterial; room: THREE.Object3D }[] = [];
  let furnishings: InteriorFurnishings | null = null;
  const book = new BookSecret(world, null);
  let candleMotion = 1;
  let candles: { material: THREE.MeshStandardMaterial; intensity: number }[] = [];
  let clock = 0;
  const spin = (dt: number, cameras: readonly THREE.Camera[]): void => {
    clock += dt;
    for (const s of spinners) {
      if (s.room.visible)
        s.node.quaternion.setFromAxisAngle(s.axis, rigidAngle(s.radPerSec, clock));
    }
    animateFires(fires, clock);
    const light =
      1 + candleMotion * (0.055 * Math.sin(clock * 3.1) + 0.022 * Math.sin(clock * 6.8));
    for (const c of candles) c.material.emissiveIntensity = c.intensity * light;
    furnishings?.update(dt, candleMotion < 1, cameras);
  };
  const disposeActor = (actor: EnemyActor): void => {
    actors.delete(actor.object);
    paces.delete(actor);
    owls.get(actor)?.perch.dispose();
    owls.delete(actor);
    actor.dispose();
  };
  const stepActor = (actor: EnemyActor, dt: number, gaze: THREE.Vector3 | null): void => {
    actor.update(dt, gaze);
    const owl = owls.get(actor);
    if (owl) {
      const fighting =
        encounter.activeRoom === actor.object.userData.room && !encounter.activePatrol;
      owl.flight.update(dt, fighting && !actor.dead);
    }
  };
  let toast: LootToast | null = null;
  let toastRoom = world.current;
  const dropToast = (): void => {
    toast?.dispose();
    toast = null;
    toastRoom = world.current;
  };
  const cofferOf = (room: number, socketId: string): Coffer | undefined =>
    world.coffers.find((c) => c.room === room && c.socketId === socketId);
  const lootLocked = (room: number): boolean =>
    (world.plan.floatElevator?.room === room && !floatElevator?.released) ||
    (world.plan.shadowStencil?.room === room && !shadowStencil?.released) ||
    (world.plan.springTension?.recess === room && !springTension?.released) ||
    (world.plan.darkCircuit?.recess === room && !darkCircuit?.released) ||
    (world.plan.drumGallery?.recess === room && !drumGallery?.released) ||
    (world.plan.rooms[room]?.encounter != null && !encounter.isCleared(room));
  const lockPosition = new THREE.Vector3();
  const loot: FloorLoot = {
    coffers: world.coffers,
    pick(origin, direction, maxDistance = LOOT_REACH) {
      const here = world.coffers.filter((c) => c.room === world.current);
      return pickCoffer(here, origin, direction, maxDistance);
    },
    open(room, socketId, found) {
      const coffer = cofferOf(room, socketId);
      if (!coffer || lootLocked(room)) return false;
      coffer.open(true);
      if (found.kind === 'cogs') coffer.showCogs(found.cogs);
      dropToast();
      const at = coffer.object.getWorldPosition(new THREE.Vector3());
      toast = new LootToast(found, at.setY(at.y + TOAST_LIFT));
      world.group.add(toast.root);
      return true;
    },
    showLock(room, socketId) {
      const coffer = cofferOf(room, socketId);
      if (!coffer || !lootLocked(room)) return false;
      dropToast();
      const at = coffer.object.getWorldPosition(new THREE.Vector3());
      toast = new LootToast(
        {
          text: 'Locked',
          caption:
            plan.floatElevator?.room === room
              ? floatElevator?.opening
                ? 'Wait for the shutter'
                : 'Recover the fitting from the open hatch'
              : plan.shadowStencil?.room === room
                ? 'Follow the lantern’s floor symbol'
                : plan.springTension?.recess === room
                  ? 'Release the spring at the marked tension'
                  : plan.darkCircuit?.recess === room
                    ? 'Power the marked lamps to release the grille'
                    : plan.drumGallery?.recess === room
                      ? 'Repair and play the drum to release the grille'
                      : 'Defeat this room’s automatons',
        },
        at.setY(at.y + TOAST_LIFT),
      );
      world.group.add(toast.root);
      return true;
    },
    markOpened(room, socketId) {
      const coffer = cofferOf(room, socketId);
      coffer?.unlock(true);
      coffer?.open(false);
    },
    dress(materials) {
      world.dressCoffers(materials);
    },
    get toast() {
      return toast ? { text: toast.text, canvas: toast.canvas } : null;
    },
    approachPoint(room, socketId, distance = 2.2) {
      const coffer = cofferOf(room, socketId);
      const footprint = world.rooms[room]?.footprint;
      if (!coffer || !footprint) return null;
      const base = coffer.object.getWorldPosition(new THREE.Vector3());
      const toCentre = new THREE.Vector3(
        (footprint.min[0] + footprint.max[0]) / 2 - base.x,
        0,
        (footprint.min[1] + footprint.max[1]) / 2 - base.z,
      );
      if (toCentre.lengthSq() < 1e-6) toCentre.set(0, 0, 1);
      return new THREE.Vector3(base.x, 0, base.z).addScaledVector(toCentre.normalize(), distance);
    },
    syncBrassLock(spent, immediate = false) {
      if (!brassCache) return;
      cofferOf(brassCache.room, brassCache.socketId)?.syncKeyLock(spent, immediate);
    },
    nearBrassLock(point, reach) {
      if (!brassCache || brassCache.room !== world.current) return null;
      const lock = cofferOf(brassCache.room, brassCache.socketId)?.object.getObjectByName(
        'coffer-padlock',
      );
      if (!lock?.visible) return null;
      return lock.getWorldPosition(lockPosition).distanceTo(point) <= reach ? brassCache : null;
    },
  };
  const hearthOf = (room: number, socketId: string): Hearth | undefined =>
    world.hearths.find((h) => h.room === room && h.socketId === socketId);
  const hearth: FloorHearths = {
    hearths: world.hearths,
    pick(origin, direction, maxDistance = LOOT_REACH) {
      const here = world.hearths.filter((h) => h.room === world.current);
      return pickHearth(here, origin, direction, maxDistance);
    },
    use(room, socketId, healed) {
      const found = hearthOf(room, socketId);
      if (!found) return false;
      found.use(true);
      dropToast();
      const at = found.object.getWorldPosition(new THREE.Vector3());
      toast = new LootToast(hearthLines(healed), at.setY(at.y + HEARTH_TOAST_LIFT));
      world.group.add(toast.root);
      return true;
    },
    markUsed(room, socketId) {
      hearthOf(room, socketId)?.use(false);
    },
    dress(materials) {
      world.dressHearths(materials);
    },
    get toast() {
      return toast ? { text: toast.text, canvas: toast.canvas } : null;
    },
    approachPoint(room, socketId, distance = 2.2) {
      const found = hearthOf(room, socketId);
      const footprint = world.rooms[room]?.footprint;
      if (!found || !footprint) return null;
      const base = found.object.getWorldPosition(new THREE.Vector3());
      const toCentre = new THREE.Vector3(
        (footprint.min[0] + footprint.max[0]) / 2 - base.x,
        0,
        (footprint.min[1] + footprint.max[1]) / 2 - base.z,
      );
      if (toCentre.lengthSq() < 1e-6) toCentre.set(0, 0, 1);
      return new THREE.Vector3(base.x, 0, base.z).addScaledVector(toCentre.normalize(), distance);
    },
  };
  return {
    world,
    floorNumber,
    get dispatchRoom() {
      return dispatchRoom;
    },
    dressDispatch(art, runSeed, reducedMotion) {
      dispatchRoom ??= DispatchRoom.mount(
        world,
        art,
        runSeed,
        reducedMotion,
        furnishings?.placements,
      );
    },
    get speakingPipes() {
      return speakingPipes;
    },
    dressSpeakingPipes(art, runSeed, reducedMotion) {
      speakingPipes ??= SpeakingPipes.mount(
        world,
        art,
        runSeed,
        reducedMotion,
        furnishings?.placements,
      );
    },
    get floatElevator() {
      return floatElevator;
    },
    dressFloatElevator(art, runSeed, reducedMotion, environment) {
      floatElevator ??= FloatElevator.mount(
        world,
        runSeed,
        reducedMotion,
        art,
        environment,
        furnishings?.placements,
      );
    },
    get shadowStencil() {
      return shadowStencil;
    },
    dressShadowStencil(art, runSeed, reducedMotion, environment) {
      shadowStencil ??= ShadowStencil.mount(
        world,
        runSeed,
        reducedMotion,
        art,
        environment,
        furnishings?.placements,
      );
    },
    get springTension() {
      return springTension;
    },
    get darkCircuit() {
      return darkCircuit;
    },
    get drumGallery() {
      return drumGallery;
    },
    dressDrumGallery(art, seed, reduced, environment, onBeat, onRelease) {
      if (plan.drumGallery)
        drumGallery ??= new DrumGallery(
          world,
          plan.drumGallery,
          seed,
          reduced,
          art,
          environment,
          furnishings?.placements ?? [],
          { onBeat, onRelease },
        );
    },
    dressDarkCircuit(runSeed, reducedMotion, environment) {
      if (plan.darkCircuit)
        darkCircuit ??= new DarkCircuit(
          world,
          plan.darkCircuit,
          runSeed,
          reducedMotion,
          environment,
          furnishings?.placements ?? [],
        );
    },
    dressSpringTension(art, runSeed, reducedMotion, environment) {
      if (plan.springTension)
        springTension ??= new SpringTension(
          world,
          plan.springTension,
          runSeed,
          reducedMotion,
          art,
          environment,
          furnishings?.placements,
        );
    },
    get borrowedLight() {
      return borrowedLight;
    },
    dressBorrowedLight(art, runSeed, reducedMotion, environment) {
      if (plan.borrowedLight)
        borrowedLight ??= new BorrowedLight(
          world,
          plan.borrowedLight,
          runSeed,
          reducedMotion,
          art,
          environment,
        );
    },
    get pendulumGallery() {
      return pendulumGallery;
    },
    dressPendulumGallery(art, runSeed, reducedMotion, finish, tick) {
      pendulumGallery ??= PendulumGallery.mount(
        world,
        art,
        runSeed,
        reducedMotion,
        finish,
        tick,
        furnishings?.placements,
      );
    },
    armoryAlcove: armory,
    challengeArmor(head) {
      if (!armory?.canChallenge || suspended || encounter.phase !== 'idle') return false;
      head.getWorldPosition(at);
      const began = encounter.begin(armory.room, {
        x: at.x,
        z: at.z,
        yaw: yawFromMatrix(head.matrixWorld.elements),
        eyeHeight: at.y,
      });
      if (!began.ok) {
        this.showBookSecret(
          { text: 'Make room for the table', caption: 'Step back and face the armor' },
          head,
        );
        return false;
      }
      armory.showFight(true);
      if (fit) fit.scale.set(1, began.table.pose.height / authoredTop, 1);
      alignSeat(began.table.offsetDeg, at);
      return true;
    },
    get valvehouse() {
      return valvehouse;
    },
    dressValvehouse(runSeed, reducedMotion) {
      valvehouse ??= Valvehouse.mount(world, runSeed, reducedMotion, furnishings?.placements);
    },
    get reliquary() {
      return reliquary;
    },
    dressReliquary(runSeed, reducedMotion) {
      reliquary ??= StoneReliquary.mount(world, runSeed, reducedMotion, furnishings?.placements);
    },
    get brassKeyStand() {
      return brassKeyStand;
    },
    dressBrassKey(art) {
      if (floorNumber === 2 && !brassKeyStand) {
        brassKeyStand = BrassKeyStand.mount(world, art, furnishings?.placements ?? []);
      } else if (floorNumber === 1 && brassCache) {
        const lock = cofferOf(brassCache.room, brassCache.socketId)?.object.getObjectByName(
          'coffer-padlock',
        );
        if (!lock || lock.getObjectByName('brass-wards-badge')) return;
        const badge = art.getObjectByName('BrassWardsBadge')?.clone(true);
        if (!badge) return;
        badge.name = 'brass-wards-badge';
        badge.position.set(0.043, -0.014, -0.002);
        badge.rotation.y = Math.PI;
        lock.add(badge);
      }
    },
    get stairs() {
      return stairs;
    },
    dressChimes(art) {
      if (!stairs || floorNumber === 3) return;
      chimes ??= BellChimes.mount(
        world,
        floorNumber,
        art,
        furnishings?.placements,
        guided,
        contentVersion >= RETURN_PASSAGES_VERSION,
      );
      if (floorNumber === 2 && contentVersion >= RETURN_PASSAGES_VERSION && !counterweight) {
        const safe = plan.rooms
          .filter((r) => !r.encounter && r.role !== 'guardian')
          .map((r) => r.index);
        const mount = (rooms: number[]) =>
          CounterweightStation.mount(world, art, { rooms, props: furnishings?.placements ?? [] });
        counterweight =
          mount(safe.filter((room) => room !== chimes?.room)) ??
          mount(safe) ??
          mount(plan.rooms.filter((r) => r.role !== 'guardian').map((r) => r.index));
        if (!counterweight) throw Error('Missing accessible counterweight station');
      }
    },
    get alchemy() {
      return alchemy;
    },
    get clock() {
      return clockwork;
    },
    get lift() {
      return lift;
    },
    get formulaEvidence() {
      return formulaEvidence;
    },
    get archive() {
      return archive;
    },
    get prismAnnex() {
      return prismAnnex;
    },
    dressPrism(art, runSeed, reducedMotion) {
      if (plan.prismAnnex && !prismAnnex)
        prismAnnex = PrismAnnex.mount(world, art, runSeed, reducedMotion, furnishings?.placements);
    },
    dressConservatory(art, archiveKit, textures, runSeed, reducedMotion) {
      if (floorNumber === 1 || lift) return;
      lift = AstralLift.mount(world, art, floorNumber === 2 ? 3 : 2, furnishings?.placements);
      if (floorNumber === 2) {
        formulaEvidence = FormulaEvidence.mount(
          world,
          art,
          archiveKit,
          runSeed,
          null,
          furnishings?.placements,
          contentVersion,
        );
        return;
      }
      alchemy = new AlchemyConservatory(
        world,
        art,
        runSeed,
        reducedMotion,
        furnishings?.placements,
        contentVersion,
      );
      clockwork = StrikingClock.mount(world, art, runSeed, reducedMotion, furnishings?.placements);
      gallery = ConservatoryGallery.mount(
        world,
        art,
        textures,
        reducedMotion,
        [0, 1, 2, 3, 4],
        furnishings?.placements,
      );
      if (!clockwork || !gallery) throw Error('Missing a Conservatory wall bay');
      formulaEvidence = FormulaEvidence.mount(
        world,
        art,
        archiveKit,
        runSeed,
        gallery,
        [],
        contentVersion,
      );
      archive = ConservatoryArchive.mount(
        world,
        archiveKit,
        conservatoryFormula(runSeed).recipe,
        reducedMotion,
      );
    },
    get office() {
      return office;
    },
    dressCommission(art, kind, reducedMotion) {
      if (!office && floorNumber !== 3)
        office = CommissionOffice.mount(
          world,
          art,
          floorNumber,
          kind,
          furnishings?.placements,
          reducedMotion,
        );
    },
    get calibrationBench() {
      return calibrationBench;
    },
    get chartCabinet() {
      return chartCabinet;
    },
    get calibrationKey() {
      return calibrationKey;
    },
    dressCalibration(art, tools, runSeed, face, reduced) {
      const props = furnishings?.placements ?? [];
      counterweight?.dress(art, reduced);
      if (floorNumber === 1 && !chartCabinet)
        chartCabinet = CalibrationCabinet.mount(world, art, tools, runSeed, props, face, reduced);
      if (floorNumber === 2 && !calibrationBench) {
        calibrationBench = CalibrationBench.mount(world, art, tools, runSeed, props, reduced);
        if (calibrationBench.plan.kind === 'orrery')
          calibrationKey = CalibrationKeyStand.mount(world, tools, props, calibrationBench.room);
      }
    },
    get panels() {
      return panels;
    },
    dressPanels(art, reducedMotion) {
      if (!panels && world.plan.hiddenPassage)
        panels = new ServicePanels(world, art, reducedMotion);
    },
    get counterweight() {
      return counterweight;
    },
    get chimes() {
      return chimes;
    },
    get windowCache() {
      return windowCache;
    },
    dressStairs(model) {
      if (stairs || floorNumber === 3) return;
      const landing = world.openStairEntry(floorNumber);
      if (landing) {
        stairs = new Stairwell(landing, floorNumber === 1 ? 2 : 1, world, model);
      }
    },
    styledRooms,
    stoneRooms,
    stoneTorches,
    dressStoneFurnishings(kit) {
      for (const room of styledRooms) {
        if (!stoneRooms.has(room.userData.room) || !room.userData.roomStyle?.startsWith('stone-'))
          continue;
        stoneFixtureReleases.push(
          ...furnishStoneRoom(
            world,
            room.userData.room,
            room,
            kit,
            furnishings?.placements ?? [],
            armory?.room === room.userData.room ? armory?.object : undefined,
          ),
        );
        const torch = room.getObjectByName('SocketTorchLight');
        if (torch) stoneTorches.set(room.userData.room, torch);
      }
    },
    dressThemedFurnishings(kit) {
      if (contentVersion < THEMED_FURNISHINGS_VERSION || themedFurnishingsDressed) return;
      themedFurnishingsDressed = true;
      const styled = new Map(styledRooms.map((room) => [room.userData.room, room]));
      for (const [index, parent] of world.roomGroups.entries()) {
        if (stoneRooms.has(index) || cacheBay?.room === index) continue;
        stoneFixtureReleases.push(
          ...furnishThemedRoom(
            world,
            index,
            styled.get(index) ?? parent,
            kit,
            furnishings?.placements ?? [],
            floorNumber,
          ),
        );
      }
    },
    dressRoomTorches(reducedMotion) {
      for (const room of world.roomGroups) {
        const fire = dressTorchFlames(room, reducedMotion);
        if (!fire) continue;
        fires.push({ material: fire.material, room });
        stoneFixtureReleases.push(() => fire.dispose());
      }
    },
    loot,
    hearth,
    book,
    pressure,
    notes,
    dismissPuzzleToast: dropToast,
    showBookSecret(lines, head) {
      dropToast();
      const anchor = head.localToWorld(new THREE.Vector3(0, 0.32, -1.65));
      toast = new LootToast(lines, anchor);
      world.group.add(toast.root);
    },
    get furnishings() {
      return furnishings;
    },
    setFurnishings(asset, paintings, reducedMotion) {
      if (!furnishings) {
        furnishings = new InteriorFurnishings(world, asset, {
          paintings,
          seededClues: contentVersion >= RETURN_PASSAGES_VERSION,
          reducedMotion,
          floorNumber,
          preservedBookRooms: options.preservedBookRooms,
        });
        book.mount(furnishings);
        const assetForFight = armory?.dress(asset.roots.ClockworkArmor);
        if (assetForFight) {
          models.set(assetForFight.id, { asset: assetForFight });
          undressed = true;
          dressEnemies();
        }
      }
    },
    setCandleMaterials(materials, reducedMotion) {
      candleMotion = reducedMotion ? 0.25 : 1;
      for (const fire of fires) {
        if (fire.material.name === CANDLE_NODE)
          fire.material.uniforms.uMotion.value = reducedMotion ? 0 : 1;
      }
      candles = materials.map((material) => {
        material.userData.baseCandleIntensity ??= material.emissiveIntensity;
        return { material, intensity: material.userData.baseCandleIntensity as number };
      });
    },
    seed,
    contentVersion,
    encounter,
    get suspendTriggers() {
      return suspended;
    },
    set suspendTriggers(value) {
      suspended = value;
    },
    markCleared(room, silent = false) {
      suppressUnlockAudio = silent;
      try {
        encounter.markCleared(room);
      } finally {
        suppressUnlockAudio = false;
      }
    },
    dressVentSteam(reducedMotion) {
      ventSteam ??= new WallVentSteam(world, reducedMotion);
    },
    setAudio(audio) {
      floorAudio = audio;
    },
    standPoint(room) {
      const r = world.rooms[room];
      if (!r) return null;
      const { min, max } = r.footprint;
      const cx = (min[0] + max[0]) / 2;
      const cz = (min[1] + max[1]) / 2;
      const door = r.doors[0]?.world;
      if (!door) return new THREE.Vector3(cx, 0, cz);
      const dx = cx - door[0];
      const dz = cz - door[1];
      const len = Math.hypot(dx, dz) || 1;
      return new THREE.Vector3(door[0] + dx / len, 0, door[1] + dz / len);
    },
    get patrolBody() {
      return patrol?.actor.object.parent ? patrol.actor.object : null;
    },
    dressPatrol(asset, clips, prepare) {
      if (patrol || floorNumber !== 2 || guided || contentVersion < PATROL_VERSION) return;
      const route = planPatrol(plan, world.rooms, world.colliders);
      if (!route) return;
      const actor = asset.spawn(0);
      try {
        prepare(actor);
        const gait = PatrolVisual.create(actor, clips);
        const pose = samplePatrol(route, 0);
        actor.object.name = 'roaming-cog-sentry';
        actor.object.userData = { room: pose.room, tier: 'regular', enemyKind: 'cog-sentry' };
        actor.object.position.set(pose.x, 0, pose.z);
        actor.object.rotation.y = pose.yaw;
        actor.object.visible = world.roomGroups[pose.room]?.visible === true;
        gait.update(0, pose);
        world.group.add(actor.object);
        actors.set(actor.object, actor);
        patrol = { actor, gait, route, elapsed: 0 };
      } catch (error) {
        actor.dispose();
        console.warn('Could not fit the roaming sentry rig', error);
      }
    },
    clearPatrol() {
      if (!patrol) return;
      patrol.actor.object.removeFromParent();
      disposeActor(patrol.actor);
      patrol = null;
    },
    get actors() {
      return [...actors.values()];
    },
    actorOf(body) {
      return actors.get(body) ?? null;
    },
    useEnemyAssets(assets, prepare) {
      for (const [kind, asset] of assets) {
        models.set(kind, { asset, prepare });
        // Splits each kind once now, so the first death does not pay for it.
        debris.prepareAsset(asset);
      }
      undressed = true;
      dressEnemies();
    },
    useRoomAsset(
      templateId,
      instantiate,
      rigidNodes = [],
      roomStyleKit,
      instantiateClosedHall,
      stoneKit,
    ) {
      if (floorNumber === 3 && roomStyleKit)
        world.dressEncounterDoor(roomStyleKit.EncounterDoorLeaf);
      let dressed = 0;
      world.plan.rooms.forEach((room, index) => {
        if (room.templateId !== templateId) return;
        const style = roomStyleKit && roomStyleFor(world.plan, index, floorNumber);
        const stone = stoneKit && stoneRooms.get(index);
        const closedHall =
          templateId === 'hall' && !style && !stone && !windowBays.some((bay) => bay.room === index)
            ? instantiateClosedHall
            : undefined;
        const model = (closedHall ?? instantiate)();
        if ((style && roomStyleKit) || (stone && stoneKit)) {
          const styled = new THREE.Group();
          const doors = templateById(room.templateId).doors.map((door) => ({
            facing: door.facing,
            position: door.position,
            closed:
              world.plan.sealed.some(
                (d) => d.room === index && d.door === door.id && d.style === 'wall',
              ) && !(stairs?.entry.room === index && stairs.entry.door === door.id),
          }));
          const edge = templateById(templateId).footprint.max[0];
          if (stone && stoneKit)
            applyStoneRoom(styled, stone, stoneKit, doors, edge, (wall, along, width) =>
              wallSpanIsExposed(plan, room, wall, along, width),
            );
          else if (style && roomStyleKit) applyRoomStyle(styled, style, roomStyleKit, doors, edge);
          const keepDesk = style === 'timber' || (templateId === 'study' && room.loot.length > 0);
          if (templateId === 'hall') copyHallBenches(model, styled);
          else if (keepDesk) copyStudyDesk(model, styled);
          world.removeRoomFixtureColliders(index, templateId === 'hall' || keepDesk);
          styled.userData.conservatory = floorNumber === 3 && !stone;
          styledRooms.push(styled);
          world.dressRoom(index, styled);
          dressed++;
          return;
        }
        if (floorNumber === 2 && templateId === 'gear-shaft')
          shaftFinishes.push(...applyUpperShaftFinish(model));
        windowDressing.get(index)?.();
        const releaseWindows = closedHall
          ? undefined
          : dressWindowBays(model, plan, index, floorNumber, cacheBay);
        if (cacheBay?.room === index) {
          windowCache?.dispose();
          windowCache = new WindowKeyCache(world, cacheBay, model);
        }
        if (releaseWindows) windowDressing.set(index, releaseWindows);
        else windowDressing.delete(index);
        world.dressRoom(index, model);
        const group = world.roomGroups[index];
        for (const rigid of rigidNodes) {
          const node = model.getObjectByName(rigid.node);
          if (!node || !group) {
            console.warn(`${templateId}: rigid node ${rigid.node} missing; it stays still`);
            continue;
          }
          const axis = new THREE.Vector3(...rigid.axis).normalize();
          spinners.push({ node, axis, radPerSec: rigid.radPerSec, room: group });
        }
        const fire = model.getObjectByName(FIRE_NODE) as THREE.Mesh | undefined;
        if (fire && group && fire.material instanceof THREE.ShaderMaterial)
          fires.push({ material: fire.material, room: group });
        const candles = model.getObjectByName(CANDLE_NODE) as THREE.Mesh | undefined;
        if (candles && group && candles.material instanceof THREE.ShaderMaterial)
          fires.push({ material: candles.material, room: group });
        dressed++;
      });
      return dressed;
    },
    get spinnerCount() {
      return spinners.length;
    },
    dispose() {
      ventSteam?.dispose();
      ventSteam = null;
      formulaEvidence?.dispose();
      archive?.dispose();
      prismAnnex?.dispose();
      gallery?.dispose();
      clockwork?.dispose();
      alchemy?.dispose();
      lift?.dispose();
      office?.dispose();
      calibrationBench?.dispose();
      chartCabinet?.dispose();
      calibrationKey?.dispose();
      panels?.dispose();
      dispatchRoom?.dispose();
      speakingPipes?.dispose();
      reliquary?.dispose();
      valvehouse?.dispose();
      armory?.dispose();
      pendulumGallery?.dispose();
      borrowedLight?.dispose();
      floatElevator?.dispose();
      shadowStencil?.dispose();
      springTension?.dispose();
      darkCircuit?.dispose();
      drumGallery?.dispose();
      counterweight?.dispose();
      chimes?.dispose();
      windowCache?.dispose();
      for (const release of windowDressing.values()) release();
      windowDressing.clear();
      stairs?.dispose();
      for (const release of stoneFixtureReleases) release();
      for (const room of styledRooms) disposeRoomStyle(room);
      for (const material of shaftFinishes) material.dispose();
      book.dispose();
      furnishings?.dispose();
      notes?.dispose();
      pressure?.dispose();
      brassKeyStand?.dispose();
      dropToast();
      spinners.length = 0;
      fires.length = 0;
      debris.dispose();
      for (const actor of [...actors.values()]) disposeActor(actor);
      models.clear();
      undressed = false;
      encounter.dispose();
      if (greybox) disposeTable(greybox);
      greybox = null;
      tableHost.removeFromParent();
      sun.removeFromParent();
      sky.removeFromParent();
      sun.dispose();
      sky.dispose();
      world.dispose();
    },
    get locked() {
      return locked;
    },
    get turnVignette() {
      return turnVignette;
    },
    get realTable() {
      return fit !== null;
    },
    useTableAsset(asset, authoredTopHeight) {
      if (greybox) {
        greybox.removeFromParent();
        disposeTable(greybox);
        greybox = null;
      }
      fit?.removeFromParent();
      fit = new THREE.Group();
      fit.name = 'combat-table-fit';
      fit.add(asset);
      authoredTop = authoredTopHeight;
      tableHost.add(fit);
      const pose = encounter.tablePose;
      if (pose) fit.scale.set(1, pose.height / authoredTop, 1);
    },
    tableSockets() {
      return {
        diceTray:
          tableHost.getObjectByName('socket-dice-tray') ??
          tableHost.getObjectByName(TABLE_NODES.diceTray) ??
          null,
        sigilPlate: tableHost.getObjectByName('socket-sigil-plate') ?? null,
      };
    },
    setTableDistance(distance, head) {
      if (encounter.phase === 'idle') {
        encounter.tableDistance = distance;
        return true;
      }
      const delta = encounter.adjustTableDistance(distance, (shift) => {
        const room = world.rooms[encounter.activeRoom];
        if (!room) return false;
        const colliders = world.colliders[encounter.activeRoom] ?? [];
        head.getWorldPosition(at);
        const from: Vec2 = [at.x, at.z];
        const target: Vec2 = [at.x + shift[0], at.z + shift[1]];
        const moved = moveWithCollision(from, shift, colliders);
        return (
          Math.hypot(moved[0] - target[0], moved[1] - target[1]) < 1e-4 &&
          validateLanding(target, { colliders, walkable: combatRoom(room).walkable }) === 'ok'
        );
      });
      if (!delta)
        return (
          encounter.tableDistance === distance &&
          (encounter.seatDistance === null || Math.abs(encounter.seatDistance - distance) < 1e-6)
        );
      rig.position.x += delta[0];
      rig.position.z += delta[1];
      rig.updateMatrixWorld(true);
      return true;
    },
    update(head, dt, cameras = []) {
      notes?.update(head);
      pressure?.update(dt);
      if (!suspended && !locked && clockwork) {
        clockwork.setWitness(world.current);
        if (clockwork.update(dt, head.getWorldPosition(at), tickClock))
          floorAudio?.playChime?.(1, clockwork.object.getWorldPosition(at));
      }
      if (gallery) gallery.update(dt, head.getWorldPosition(at));
      archive?.update(dt);
      prismAnnex?.update(dt);
      alchemy?.update(dt, clockwork?.dialHours);
      office?.update(dt);
      calibrationBench?.update(dt);
      chartCabinet?.update(dt);
      panels?.update(dt);
      dispatchRoom?.update(dt);
      speakingPipes?.update(dt);
      reliquary?.update(dt);
      valvehouse?.update(dt);
      armory?.update(suspended ? 0 : dt);
      pendulumGallery?.update(dt, suspended || locked);
      if (!suspended && !locked) {
        borrowedLight?.update(dt);
        floatElevator?.update(dt);
        shadowStencil?.update(dt);
        springTension?.update(dt);
        darkCircuit?.update(dt);
        drumGallery?.update(dt);
      }
      counterweight?.update(dt);
      chimes?.update(dt);
      world.updateAnimations(dt);
      ventSteam?.update(encounter.scaledDt(dt));
      turnVignette = vignetteStep(turnVignette, 0, dt, DEFAULT_VIGNETTE);
      spin(dt, cameras);
      book.update(dt, head);
      for (const coffer of world.coffers) coffer.update(dt);
      for (const lit of world.hearths) lit.update(dt);
      if (toast) {
        head.getWorldPosition(at);
        if (toastRoom !== world.current || !toast.update(dt, at)) dropToast();
      }
      const previousPhase = encounter.phase;
      encounter.update(dt);
      if (previousPhase !== 'idle' && encounter.phase === 'idle') {
        armory?.showFight(false);
        for (const [actor, { perch }] of owls) {
          if (!actor.object.parent) continue;
          perch.object.position.copy(actor.object.position);
          perch.object.rotation.y = actor.object.rotation.y;
        }
      }
      if (
        patrolSeatTurn &&
        encounter.activePatrol &&
        (encounter.patrolAtSlot || encounter.phase === 'active')
      ) {
        alignSeat(patrolSeatTurn, head.getWorldPosition(at));
        patrolSeatTurn = 0;
      }
      if (
        patrol &&
        encounter.activePatrol === patrol.actor.object &&
        previousPhase === 'unfolding' &&
        encounter.phase === 'active'
      )
        patrol.gait.release();
      dressEnemies();
      head.getWorldPosition(at);
      if (tiersFor !== world.current) {
        tiersFor = world.current;
        near = nearSet(world.plan, tiersFor);
        shell = shellSet(world.plan, tiersFor);
      }
      frame++;
      // Clips run on real seconds; the freeze is a pose, not a slowed clock.
      for (const actor of [...actors.values()]) {
        if (!actor.object.parent) {
          disposeActor(actor);
          if (patrol?.actor === actor) patrol = null;
          continue;
        }
        if (patrol?.actor === actor) {
          if (encounter.phase === 'idle') continue;
          if (
            (encounter.phase === 'unfolding' || encounter.phase === 'folding') &&
            encounter.activePatrol === actor.object &&
            encounter.patrolApproachPose
          ) {
            if (actor.frozen && encounter.patrolApproachPose.returning) actor.unfreeze();
            patrol.gait.approach(dt, encounter.patrolApproachPose);
            continue;
          }
        }
        if (encounter.frozen) {
          if (!actor.frozen && !actor.dead && actor.state === 'idle') actor.freeze();
        } else if (actor.frozen) actor.unfreeze();
        const room = actor.object.userData.room as number;
        const pace = paces.get(actor);
        if (!pace || near.has(room) || room === encounter.activeRoom) {
          stepActor(actor, dt + (pace?.pending ?? 0), at);
          if (pace) pace.pending = 0;
        } else if (shell.has(room)) {
          pace.pending += dt;
          if ((frame + pace.slot) % SHELL_ACTOR_EVERY === 0) {
            stepActor(actor, pace.pending, null);
            pace.pending = 0;
          }
        }
        if (actor.dead && !shattered.has(actor) && !actor.action('death').isRunning()) {
          shattered.add(actor);
          debris.shatterActor(actor, Stream.fromKey(`${world.plan.seed}:shatter:${shatters++}`));
        }
      }
      debris.update(dt);
      head.getWorldPosition(at);
      // The fight owns the room until it ends, so streaming holds still meanwhile.
      if (encounter.phase !== 'idle') return;
      world.update(at.x, at.z);
      if (suspended) return;
      let roamingBody: THREE.Object3D | undefined;
      if (patrol) {
        const { actor, gait, route } = patrol;
        if (actor.frozen) actor.unfreeze();
        const body = actor.object;
        const next = (patrol.elapsed + dt) % patrolPeriod(route);
        let pose = samplePatrol(route, next);
        const separation = Math.hypot(at.x - pose.x, at.z - pose.z);
        const yielding =
          separation < 0.7 &&
          separation < Math.hypot(at.x - body.position.x, at.z - body.position.z);
        if (yielding) pose = samplePatrol(route, patrol.elapsed);
        else patrol.elapsed = next;
        body.position.set(pose.x, 0, pose.z);
        body.rotation.y = pose.yaw;
        body.userData.room = pose.room;
        body.visible = world.roomGroups[pose.room]?.visible === true;
        if (body.visible) {
          if (yielding) {
            gait.release();
            actor.update(dt, at);
          } else gait.update(dt, pose);
        }
        const distance = Math.hypot(at.x - pose.x, at.z - pose.z);
        if (pose.room === world.current && distance <= 0.85) {
          sight.origin.set(at.x, 1, at.z);
          sight.direction.set(pose.x - at.x, 0, pose.z - at.z).normalize();
          const occluded = world.colliders[pose.room].some((box) => {
            wall.min.fromArray(box.min);
            wall.max.fromArray(box.max);
            return (
              sight.intersectBox(wall, crossing) !== null &&
              crossing.distanceTo(sight.origin) < distance - 0.015
            );
          });
          if (!occluded) roamingBody = body;
        }
      }
      const hit = encounter.checkTrigger({ x: at.x, z: at.z });
      if (!hit && !roamingBody) return;
      const began = encounter.begin(
        hit?.room ?? world.current,
        {
          x: at.x,
          z: at.z,
          yaw: yawFromMatrix(head.matrixWorld.elements),
          eyeHeight: at.y,
        },
        hit ? undefined : roamingBody,
      );
      if (!began.ok) return;
      if (fit) fit.scale.set(1, began.table.pose.height / authoredTop, 1);
      if (encounter.activePatrol) patrolSeatTurn = began.table.offsetDeg;
      else alignSeat(began.table.offsetDeg, at);
    },
  };
}
