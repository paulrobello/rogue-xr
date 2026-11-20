import { createPointer, createStickRadialNavigation } from '@par/xr-workspace';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { configureTextBuilder } from 'troika-three-text';
import { glb_sha256 as alchemyRevision } from '../assets-source/props/alchemy-kit/manifest.json';
import { assets as portraitAssets } from '../assets-source/props/alchemy-kit/portraits/manifest.json';
import { sha256 as architecturalFinishRevision } from '../assets-source/props/architectural-finishes/report.json';
import { glb_sha256 as archiveRevision } from '../assets-source/props/archive-kit/manifest.json';
import { glb_sha256 as brassKeyRevision } from '../assets-source/props/brass-key-kit/manifest.json';
import { glb_sha256 as calibrationRevision } from '../assets-source/props/calibration-kit/manifest.json';
import { glb_sha256 as commissionRevision } from '../assets-source/props/commission-kit/manifest.json';
import { glb_sha256 as panelRevision } from '../assets-source/props/panel-kit/manifest.json';
import { hashes as instrumentHashes } from '../assets-source/props/puzzle-instruments/manifest.json';
import { sha256 as stairwellRevision } from '../assets-source/props/stairwell/report.json';
import { audioStateForFlow } from './audio/cues.ts';
import { AudioDirector } from './audio/index.ts';
import { requestCardFaceArt } from './cards/card-face-material.ts';
import { mountCardProof } from './cards/card-proof.ts';
import { CombatHook, type CombatPick, type XrHands } from './combat/combat-session.ts';
import {
  BRASS_CACHE_VERSION,
  ENCOUNTER_CONTENT_VERSION,
  RETURN_PASSAGES_VERSION,
} from './combat/encounter-choice.ts';
import {
  type CombatTableAsset,
  loadCombatTable,
  mountTableAssetProof,
} from './combat/table-asset-proof.ts';
import { CanvasLabel } from './combat-view/canvas-label.ts';
import {
  HitFeedback,
  hapticFor,
  projectionTan,
  pulseHaptics,
  viewTan,
} from './combat-view/hit-feedback.ts';
import { mountCombatDebugView } from './combat-view/index.ts';
import { CARDS, STARTER_DECK } from './content/cards.ts';
import { ENEMIES } from './content/enemies.ts';
import { REWARD_POOL } from './content/rewards.ts';
import { ActionBus } from './core/actions.ts';
import { isValidSeed, normalizeSeed, randomSeed } from './core/rng.ts';
import { fitCombatFraming } from './desktop/combat-framing.ts';
import { combatPitch, createDesktopControls } from './desktop/controls.ts';
import { Walker } from './desktop/walker.ts';
import { DiceWorld } from './dice/world.ts';
import { makeClockworkOwlAsset } from './enemies/conservatory-actors.ts';
import { type EnemyActor, type EnemyAsset, tryLoadEnemyAsset } from './enemies/enemy-asset.ts';
import { isShowcaseFloor, SHOWCASE_SEED } from './floor/generate.ts';
import { placeStairEntry, type StairEntry } from './floor/stairs.ts';
import { encounterStartsFight, fleeStandPoint } from './flow/flee.ts';
import { RunFlow } from './flow/flow.ts';
import { FlowUi, RUN_MENU_ITEMS, rewardCardTexture } from './flow/panels.ts';
import { bindFlowPersistence } from './flow/persist.ts';
import { RewardCardFaces } from './flow/reward-cards.ts';
import { HOLO_CARD_ASPECT } from './hand/fan-layout.ts';
import { flingTraceLog } from './hand/fling-trace.ts';
import { PALETTE } from './palette.ts';
import { foveationValue, mountPerf, perfMark, perfRoom } from './perf/index.ts';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  openDb,
  type Settings,
  saveSettings,
} from './persist/db.ts';
import { loadRunSnapshot, loadWorkshop, type RunSnapshot } from './persist/saves.ts';
import { alchemyRecipe, type FormulaClue, formulaObservation } from './rules/alchemy.ts';
import { type BellNote, bellMelody } from './rules/bell-chimes.ts';
import { BEARINGS, calibrationPlan, GEAR_TEETH } from './rules/calibration.ts';
import {
  COMMISSION_ORDERS,
  COMMISSION_PAYOUT,
  COMMISSION_TITLES,
  commissionPlan,
} from './rules/commissions.ts';
import { counterweightTarget } from './rules/counterweight.ts';
import {
  DEFAULT_DIFFICULTY,
  type Difficulty,
  isDifficulty,
  runDifficulty,
} from './rules/difficulty.ts';
import { floorSeedFor, parseLootKey, type RewardTier } from './rules/run.ts';
import { createWorkshop } from './rules/workshop.ts';
import { sharedKtx2Loader } from './ui/first-render.ts';
import { loadIconSheet } from './ui/icon-sheet.ts';
import { failLoading, revealGame, showLoading } from './ui/loading-screen.ts';
import { mountUpdateNotice } from './update/index.ts';
import type { BellChimes, BellPick } from './world/bell-chimes.ts';
import type { CalibrationAction } from './world/calibration-bench.ts';
import type { FolioPick } from './world/calibration-cabinet.ts';
import type { CommissionAction } from './world/commission-office.ts';
import {
  type FloorView,
  mountFloorView,
  playableFloorPlan,
  restoreUpperRoomLocations,
  seedFromQuery,
} from './world/floor-view.ts';
import { RECORD_TITLES } from './world/formula-clue.ts';
import type { HearthPick } from './world/hearth.ts';
import { dressHeroRooms, fetchHeroRooms, loadHeroAssets } from './world/hero-rooms.ts';
import {
  bindBookcaseAtlas,
  INTERIOR_PAINTINGS,
  loadInteriorFurnishings,
} from './world/interior-furnishings.ts';
import { createKtx2Loader } from './world/ktx2.ts';
import { mountLightmapProof } from './world/lightmap-proof.ts';
import {
  type Coffer,
  type CofferCardFace,
  type LootMaterials,
  type LootPick,
  nearestCard,
} from './world/loot.ts';
import { mountMaterialProof } from './world/material-proof.ts';
import { loadPbrSet } from './world/materials.ts';
import type { PressureAction } from './world/pressure-compartment.ts';
import { loadPressureArt, type PressureArt } from './world/pressure-works.ts';
import { dressPumpMaterials } from './world/pump-materials.ts';
import { mountRoomAssetProof } from './world/room-asset-proof.ts';
import { lightRoomStyle } from './world/room-style-lighting.ts';
import { type RoomStyleKit, roomStyleFor, roomStyleKitFromScene } from './world/room-styles.ts';
import type { PanelHit } from './world/service-panels.ts';
import { StairFade, StairTransit } from './world/stair-transit.ts';
import { loadBookBindings } from './world/study-books.ts';
import {
  fetchStudyManifest,
  HERO_ROOMS,
  loadStudyAsset,
  type StudyAsset,
} from './world/study-room.ts';
import { loadTableDecor, type TableDecor } from './world/table-decor.ts';
import { runVeil } from './world/veil.ts';
import { ComfortVignette } from './xr/comfort-vignette.ts';
import { Locomotion, locomotionSettingsFrom } from './xr/locomotion.ts';
import { LocomotionDrive } from './xr/locomotion-drive.ts';
import { ButtonEdge, MENU_BUTTON } from './xr/menu-button.ts';
import { createXrRig } from './xr/session.ts';
import { TeleportView } from './xr/teleport-view.ts';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root');

// Menu, gauge and card glyphs must share this setting before Troika's first font request.
const xrText = { sdfGlyphSize: 128, useWorker: false };
configureTextBuilder(xrText);

const params = new URLSearchParams(location.search);
const view = params.get('view');
const proofView =
  view === 'lightmap-proof' ||
  view === 'card-proof' ||
  view === 'material-proof' ||
  view === 'table-asset-proof' ||
  view === 'room-asset-proof' ||
  view === 'combat';
// Proof views keep their frame readable so a check can sample it. Stencil backs the card portals.
const renderer = new THREE.WebGLRenderer({
  antialias: true,
  stencil: true,
  preserveDrawingBuffer: proofView,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
app.append(renderer.domElement);
// Card art loads at boot so the first fight's hand opens on real faces, not flat tints.
const cardArtReady = requestCardFaceArt(sharedKtx2Loader(renderer)).catch((error: unknown) =>
  console.warn('card atlas prefetch failed; the fan retries', error),
);

const scene = new THREE.Scene();
const combatLaserRay = new THREE.Ray();
scene.background = new THREE.Color(PALETTE.void);

// The rig is the player's locomotion root; the camera sits at seated-calibrated eye height.
const rig = new THREE.Group();
rig.name = 'player-rig';
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 0);
rig.add(camera);
rig.position.set(0, 0, 2);
scene.add(rig);

let cardProof: Awaited<ReturnType<typeof mountCardProof>> | undefined;
let floor: FloorView | undefined;
if (view === 'lightmap-proof') {
  await mountLightmapProof(scene, rig, camera, renderer);
} else if (view === 'material-proof') {
  await mountMaterialProof(scene, rig, renderer);
} else if (view === 'card-proof') {
  cardProof = await mountCardProof(scene, rig);
} else if (view === 'table-asset-proof') {
  await mountTableAssetProof(scene, rig, renderer);
} else if (view === 'room-asset-proof') {
  await mountRoomAssetProof(scene, rig, camera, renderer);
} else if (view === 'combat') {
  mountCombatDebugView(scene, rig, camera, renderer, { search: location.search });
}

// The game loop (title, run, death or victory, title) for the floor view. `?seed=` starts that run
// straight away, so seed links and scripted checks land on the floor; `?title` shows the title instead.
const playMode = !proofView;
const querySeed = params.get('seed');
const showcaseLink =
  querySeed !== null && isValidSeed(querySeed) && normalizeSeed(querySeed) === SHOWCASE_SEED;
const settingsDb = playMode ? await openDb() : null;
const db =
  playMode && showcaseLink
    ? await openDb(undefined, { name: 'rogue-xr-room-showcase' })
    : settingsDb;
const workshop = db ? await loadWorkshop(db).catch(() => createWorkshop()) : createWorkshop();
let storedSnapshot: RunSnapshot | null = db ? await loadRunSnapshot(db).catch(() => null) : null;
let settings: Settings | null = settingsDb ? await loadSettings(settingsDb) : null;
// `?difficulty=casual|normal|hard` sets the level a `?seed=` link starts at and the title's choice,
// for this page only (saved once the player changes a setting).
const queryDifficulty = params.get('difficulty');
if (isDifficulty(queryDifficulty)) {
  settings = { ...(settings ?? DEFAULT_SETTINGS), difficulty: queryDifficulty };
}
const flow = new RunFlow({ workshop, starterDeck: STARTER_DECK, rewardPool: REWARD_POOL });
const directSeed = params.has('seed') && !params.has('title');
const bootSeed = params.has('seed')
  ? seedFromQuery(location.search)
  : (storedSnapshot?.run.seed ?? randomSeed());
// The baked rooms' manifests carry their extra colliders (the study's desk and shelves, the
// gear-shaft's drive), so the world is built from them before the first floor; their models, the
// sentry and the table load afterwards (P4-T9, P5-T12). Each room falls back to its greybox alone.
const heroRooms = proofView
  ? { manifests: [], templates: undefined }
  : await fetchHeroRooms(HERO_ROOMS, (id) => fetchStudyManifest(id));
const worldTemplates = heroRooms.templates;
const mountFloor = (
  seed: string,
  contentVersion?: number,
  preservedBookRooms?: readonly number[],
  floorNumber: 1 | 2 | 3 = 1,
): FloorView => {
  const view = mountFloorView(scene, rig, seed, {
    templates: worldTemplates,
    guidedShowcase: showcaseLink,
    floorNumber,
    contentVersion,
    preservedBookRooms,
  });
  view.encounter.tableDistance = (settings ?? DEFAULT_SETTINGS).tableDistance;
  return view;
};
if (!proofView) floor = mountFloor(bootSeed);
let readyFloor: FloorView | undefined;
let loadingFailed = false;
let covered = true;
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const stairTransit = new StairTransit(reducedMotion);
const stairFade = new StairFade();
renderer.compile(stairFade.scene, camera);
const busy = () => (covered && !proofView) || stairTransit.phase !== 'idle';
/** True once a run has played on the mounted floor, so the next run needs a fresh one. */
let floorUsed = false;
/** Set when a finished run returns to the title: the next frame swaps in a pristine floor (H1). */
let titleReset = false;

// Debug readout, under `?debug` only: seed, current room, the last frame's draw calls (Quest budget:
// under 200) and, in a fight, the combat stage, log and key help.
const showDebugHud = params.has('debug');
const hud = document.createElement('div');
hud.id = 'debug-hud';
Object.assign(hud.style, {
  position: 'fixed',
  top: '12px',
  left: '12px',
  font: '500 13px ui-monospace, monospace',
  color: PALETTE.candle,
  pointerEvents: 'none',
  whiteSpace: 'pre',
  textShadow: '0 1px 2px #000',
});
if (floor && showDebugHud) app.append(hud);
const banner = document.createElement('div');
banner.id = 'combat-banner';
Object.assign(banner.style, {
  position: 'fixed',
  top: '28%',
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '16px 40px',
  font: '700 44px system-ui, sans-serif',
  color: PALETTE.candle,
  background: 'rgba(18,12,7,0.85)',
  border: `2px solid ${PALETTE.brass}`,
  borderRadius: '10px',
  pointerEvents: 'none',
  display: 'none',
});
if (floor) app.append(banner);

const actions = new ActionBus();
const xr = createXrRig(renderer, scene, rig, camera, actions, {
  foveation: (settings ?? DEFAULT_SETTINGS).foveation,
});
const desktop = createDesktopControls(camera, renderer.domElement, actions);
const walker = new Walker(rig, actions, () => floor?.world.nearbyColliders() ?? []);
const locomotion = new Locomotion(
  rig,
  camera,
  locomotionSettingsFrom(settings ?? DEFAULT_SETTINGS),
);
const drive = new LocomotionDrive(locomotion);
const standingAt = new THREE.Vector3();
// Comfort cues: the teleport arc lives in the world (walls hide it), the vignette is a camera-locked
// pass drawn after the boards and before the red hit flash.
const teleportView = new TeleportView();
scene.add(teleportView.root);
const comfortVignette = new ComfortVignette();
renderer.compile(comfortVignette.scene, camera);
// Head pose is only known once frames arrive, so height calibration waits for the first XR frame.
let recenterPending = false;
actions.on('recenter', () => {
  recenterPending = true;
});
const perf = mountPerf(renderer, scene, rig, {
  camera,
  foveation: foveationValue((settings ?? DEFAULT_SETTINGS).foveation),
});
perf.setFpsCounter((settings ?? DEFAULT_SETTINGS).fpsCounter);
// The in-scene notice gets its own pass after the boards, which clear depth and would cover it.
const noticeScene = new THREE.Scene();
const updateNotice = mountUpdateNotice({
  scene: noticeScene,
  renderer,
  xr,
  search: location.search,
});

// Audio: one director for the floor, resumed by the first gesture or the XR session start.
const audio = floor ? new AudioDirector({ camera }) : null;
const soundReady = audio?.load();
if (audio) {
  scene.add(audio.root);
  if (settings) {
    audio.setVolumes({
      master: settings.masterVolume,
      music: settings.musicVolume,
      sfx: settings.sfxVolume,
    });
  }
  audio.unlockOnGesture(window);
  audio.unlockOnGesture(document, ['visibilitychange']);
  audio.unlockOnXrSession(renderer.xr);
}
floor?.setAudio(audio);

// Player hit feedback: an edge flash drawn after the boards (desktop and both XR eyes) and a
// controller pulse in XR. Settings has no reduced-motion option, so the OS preference softens it.
const hitFx = new HitFeedback({
  reducedMotion,
});
// Compiled now (compile visits hidden meshes) so the first hit does not stall on a shader build.
renderer.compile(hitFx.scene, camera);
const onPlayerHit = (hit: Parameters<HitFeedback['trigger']>[0]): void => {
  hitFx.trigger(hit);
  if (!xr.presenting) return;
  const { intensity, milliseconds } = hapticFor(hit);
  pulseHaptics(renderer.xr.getSession()?.inputSources, intensity, milliseconds);
};

// Real combat on the floor: a session opens when an encounter goes active. Each fight takes the
// run's deck and hit points; `?cheat=win|lose` (or `__flow.setCheat` under `?debug`) rigs it.
let cheat = params.get('cheat');
const fightOptions = () => {
  const run = flow.run;
  return {
    ...(run
      ? {
          deck: run.deck,
          playerHp: Math.max(1, Math.min(run.maxHp, run.hp)),
          playerMaxHp: run.maxHp,
          bonusDice: run.bonusDice ?? 0,
          difficulty: runDifficulty(run),
        }
      : {}),
    ...(cheat === 'win' ? { enemyHp: 1 } : {}),
    ...(cheat === 'lose' ? { playerHp: 1 } : {}),
  };
};
const fightTier = (target: FloorView, room: number): RewardTier =>
  room === target.world.plan.guardianRoom
    ? 'guardian'
    : (target.world.plan.rooms[room]?.encounter?.tier ?? 'regular');
const makeCombat = (target: FloorView): CombatHook => {
  const hook: CombatHook = new CombatHook({
    floor: target,
    camera,
    actions,
    ...(audio ? { audio } : {}),
    onPlayerHit,
    reducedMotion: hitFx.reducedMotion,
    fightOptions,
    // Read when a fight opens: `heroEnv` is declared below this hook's construction.
    diceEnv: () => heroEnv,
    onEnd: ({ room, outcome, playerHp }) =>
      flow.fightEnded({
        room,
        outcome,
        tier: fightTier(target, room),
        ...(playerHp === null ? {} : { playerHp }),
      }),
  });
  return hook;
};
let combat = floor ? makeCombat(floor) : null;
/** Wins the running fight outside the session (debug key): same path as a decided fight. */
const winFight = (): void => {
  const target = floor;
  if (!target || target.encounter.phase === 'idle') return;
  const room = target.encounter.activeRoom;
  target.encounter.end('win');
  flow.fightEnded({ room, outcome: 'win', tier: fightTier(target, room) });
};

// Hero assets reflect a dim neutral room until the baked probes ship, as their proof views do.
const heroEnv: THREE.Texture | null = floor
  ? (() => {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
      return texture;
    })()
  : null;
const reflect = (root: THREE.Object3D, intensity: number): void => {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !heroEnv) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const lit = m as THREE.MeshStandardMaterial;
      if (!lit.isMeshStandardMaterial) continue;
      lit.envMap = heroEnv;
      lit.envMapIntensity = intensity;
    }
  });
};

// The P4-T5 table asset replaces the greybox once it loads; the greybox stays on any failure.
// Every rebuilt floor gets a clone of the same loaded asset.
const tableAsset: Promise<CombatTableAsset | null> = floor
  ? loadCombatTable(renderer).then((asset) => {
      if (asset) reflect(asset.scene, 0.45);
      return asset;
    })
  : Promise.resolve(null);
let tableUses = 0;
const fitTable = (target: FloorView): Promise<void> =>
  tableAsset.then((asset) => {
    if (!asset || target !== floor) return;
    target.useTableAsset(tableUses++ === 0 ? asset.scene : asset.scene.clone(true), asset.top);
  });

// P4-T9 hero assets: the baked rooms dress their templates and each automaton model replaces its
// kind's capsules. One KTX2 material set backs them all; each falls back to its greybox on its own
// failure.
const heroSet = floor
  ? (async () => {
      const ktx2 = createKtx2Loader(renderer);
      const set = await loadPbrSet('/assets/materials', {
        anisotropy: renderer.capabilities.getMaxAnisotropy(),
        ktx2,
      });
      return { ktx2, set };
    })()
  : null;
const libraryBindings = heroSet
  ?.then(({ ktx2 }) => loadBookBindings(ktx2))
  .catch((error: unknown) => {
    console.warn('Book binding atlas unavailable', error);
    return null;
  });
const roomAssets: Promise<StudyAsset[]> = heroSet
  ? heroSet
      .then(({ ktx2, set }) =>
        loadHeroAssets(heroRooms.manifests, async (study) =>
          loadStudyAsset({
            study,
            set,
            ktx2,
            bookBindings: study.template.id === 'study' ? await libraryBindings : undefined,
            envMap: heroEnv,
            reducedMotion: hitFx.reducedMotion,
          }),
        ),
      )
      .catch((error: unknown) => {
        console.warn('hero material set unavailable, greybox rooms kept', error);
        return [];
      })
  : Promise.resolve([]);
// Sealed doorways close with a walnut leaf from the same set, reflecting like the room surfaces.
const sealedDoorMaterial: Promise<{ material: THREE.Material; tileMeters: number } | null> = heroSet
  ? heroSet
      .then(({ set }) => {
        const walnut = set.materials.get('walnut');
        const tileMeters = set.manifest.walnut?.tileMeters;
        if (!walnut || !tileMeters) return null;
        const material = walnut.clone();
        material.name = 'sealed-door';
        if (heroEnv) {
          material.envMap = heroEnv;
          material.envMapIntensity = 0.12;
        }
        return { material, tileMeters };
      })
      .catch(() => null)
  : Promise.resolve(null);
// Treasure coffers: walnut and aged brass from the same set, cloned so the rooms' own materials keep
// their probe intensity. The flat placeholders in `CofferKit` stay on any failure.
const lootMaterials: Promise<LootMaterials | null> = heroSet
  ? heroSet
      .then(({ set }) => {
        const wood = set.materials.get('walnut');
        const brass = set.materials.get('brass-aged');
        if (!wood || !brass) return null;
        const dress = (source: THREE.MeshStandardMaterial, name: string, intensity: number) => {
          const material = source.clone();
          material.name = name;
          if (heroEnv) {
            material.envMap = heroEnv;
            material.envMapIntensity = intensity;
          }
          return material;
        };
        return {
          wood: dress(wood, 'coffer-wood', 0.12),
          brass: dress(brass, 'coffer-brass', 0.45),
        };
      })
      .catch(() => null)
  : Promise.resolve(null);
// Table decorations: one atlas material lit like the automatons (hero probe and the floor's lights).
const tableDecor: Promise<TableDecor | null> = heroSet
  ? heroSet
      .then(async ({ ktx2 }) => {
        const decor = await loadTableDecor(ktx2);
        decor.material.envMap = heroEnv;
        return decor;
      })
      .catch((error: unknown) => {
        console.warn('table decorations unavailable, tables left bare', error);
        return null;
      })
  : Promise.resolve(null);
// One fetch per enemy kind for the session, whatever the floor count. A kind whose model is not
// shipped yet resolves null at once (one console.info) and keeps its capsules.
const enemyMaterials = heroSet?.then(({ set }) => set).catch(() => null) ?? null;
const enemyAssets = new Map<string, Promise<EnemyAsset | null>>(
  enemyMaterials
    ? Object.keys(ENEMIES)
        .filter((kind) => kind !== 'clockwork-owl')
        .map((kind) => [
          kind,
          enemyMaterials.then((set) => (set ? tryLoadEnemyAsset(kind, { materials: set }) : null)),
        ])
    : [],
);
const loadedEnemies = async (): Promise<EnemyAsset[]> =>
  (await Promise.all(enemyAssets.values())).filter((a): a is EnemyAsset => a !== null);
const prepareEnemy = (actor: EnemyActor): void => reflect(actor.object, 0.45);
let stairArt: Promise<Map<1 | 2, THREE.Object3D>> | undefined;
function stairModels() {
  stairArt ??= new GLTFLoader()
    .loadAsync(`/assets/props/stairwell/stairwell.glb?v=${stairwellRevision}`)
    .then(({ scene }) => {
      reflect(scene, 0.46);
      const up = scene.getObjectByName('StairUp'),
        down = scene.getObjectByName('StairDown');
      if (!up || !down) throw Error('Stair landings missing from the staircase kit');
      return new Map<1 | 2, THREE.Object3D>([
        [1, up],
        [2, down],
      ]);
    })
    .catch((error: unknown) => {
      stairArt = undefined;
      throw error;
    });
  return stairArt;
}
let styleKit: Promise<RoomStyleKit> | undefined;
function architecturalFinishes(): Promise<RoomStyleKit> {
  styleKit ??= new GLTFLoader()
    .loadAsync(
      `/assets/props/architectural-finishes/architectural-finishes.glb?v=${architecturalFinishRevision}`,
    )
    .then(({ scene }) => {
      reflect(scene, 0.48);
      return roomStyleKitFromScene(scene);
    })
    .catch((error: unknown) => {
      styleKit = undefined;
      throw error;
    });
  return styleKit;
}
let instruments: Promise<THREE.Object3D> | undefined;
function puzzleInstruments() {
  instruments ??= new GLTFLoader()
    .loadAsync(
      `/assets/props/puzzle-instruments/puzzle-instruments.glb?v=${instrumentHashes['puzzle-instruments.glb']}`,
    )
    .then(({ scene }) => {
      reflect(scene, 0.5);
      return scene;
    })
    .catch((error: unknown) => {
      instruments = undefined;
      throw error;
    });
  return instruments;
}
let alchemyKit: Promise<THREE.Object3D> | undefined;
let portraitTextures: Promise<THREE.Texture[]> | undefined;
function conservatoryKit(): Promise<THREE.Object3D> {
  alchemyKit ??= new GLTFLoader()
    .loadAsync(`/assets/props/alchemy-kit/alchemy-kit.glb?v=${alchemyRevision}`)
    .then(({ scene }) => {
      reflect(scene, 0.58);
      return scene;
    })
    .catch((error) => {
      alchemyKit = undefined;
      throw error;
    });
  return alchemyKit;
}
let archiveArt: Promise<THREE.Object3D> | undefined;
function archiveKit(): Promise<THREE.Object3D> {
  archiveArt ??= new GLTFLoader()
    .loadAsync(`/assets/props/archive-kit/archive-kit.glb?v=${archiveRevision}`)
    .then(({ scene }) => {
      reflect(scene, 0.54);
      return scene;
    })
    .catch((error) => {
      archiveArt = undefined;
      throw error;
    });
  return archiveArt;
}
let commissionArt: Promise<THREE.Object3D> | undefined;
function commissionKit(): Promise<THREE.Object3D> {
  commissionArt ??= new GLTFLoader()
    .loadAsync(`/assets/props/commission-kit/commission-kit.glb?v=${commissionRevision}`)
    .then(({ scene }) => {
      reflect(scene, 0.54);
      return scene;
    })
    .catch((error) => {
      commissionArt = undefined;
      throw error;
    });
  return commissionArt;
}
let calibrationArt: Promise<THREE.Object3D> | undefined;
function calibrationKit(): Promise<THREE.Object3D> {
  calibrationArt ??= new GLTFLoader()
    .loadAsync(`/assets/props/calibration-kit/calibration-kit.glb?v=${calibrationRevision}`)
    .then(({ scene }) => {
      reflect(scene, 0.55);
      return scene;
    })
    .catch((error) => {
      calibrationArt = undefined;
      throw error;
    });
  return calibrationArt;
}
let brassKeyArt: Promise<THREE.Object3D> | undefined;
let panelArt: Promise<THREE.Object3D> | undefined;
function panelKit(): Promise<THREE.Object3D> {
  panelArt ??= new GLTFLoader()
    .loadAsync(`/assets/props/panel-kit/panel-kit.glb?v=${panelRevision}`)
    .then(({ scene }) => {
      reflect(scene, 0.52);
      return scene;
    })
    .catch((error) => {
      panelArt = undefined;
      throw error;
    });
  return panelArt;
}
function wizardPaintings(): Promise<THREE.Texture[]> {
  portraitTextures ??= Promise.all(
    portraitAssets.map(async ({ name, runtimeSha256 }) => {
      const texture = await new THREE.TextureLoader().loadAsync(
        `/assets/props/alchemy-kit/${name}.webp?v=${runtimeSha256}`,
      );
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      return texture;
    }),
  ).catch((error) => {
    portraitTextures = undefined;
    throw error;
  });
  return portraitTextures;
}
function syncPuzzles(target: FloorView, immediate = false): void {
  const run = flow.run;
  if (!run) return;
  if (immediate) {
    target.panels?.sync(flow.hiddenPanel, true);
    target.world.setPuzzleGateOpen('panel', flow.hiddenPanel.opened, true);
    target.office?.sync(flow.commission);
    target.loot.syncBrassLock(flow.brassKey === 'spent', true);
    target.brassKeyStand?.sync(flow.brassKey !== 'missing');
    target.calibrationBench?.sync(flow.calibration, true);
    target.chartCabinet?.sync(flow.calibration, true);
  }
  const state = flow.counterweight;
  target.counterweight?.sync(state.selected, counterweightTarget(run.seed), state.solved);
  target.world.setPuzzleGateOpen('counterweight', state.solved, immediate);
  target.world.setPuzzleGateOpen('pressure', flow.pressure.solved, immediate);
  target.world.setPuzzleGateOpen('thorn', flow.alchemy.opened, immediate);
  const formula = flow.conservatoryFormula;
  target.alchemy?.sync(flow.alchemy, immediate, formula);
  target.archive?.sync(formula, immediate);
  target.world.setPuzzleGateOpen('archive', formula.opened, immediate);
  target.clock?.sync(flow.alchemy.found.includes(alchemyRecipe(run.seed)[1]));
}
let pressureArt: Promise<PressureArt> | undefined;
let interiors:
  | Promise<[Awaited<ReturnType<typeof loadInteriorFurnishings>>, THREE.Texture[]]>
  | undefined;
const dressFloor = async (target: FloorView): Promise<void> => {
  // Each model dresses its kind as soon as it lands, so a slow or broken one holds back no other.
  const dressed = [...enemyAssets.values()].map((pending) =>
    pending.then((asset) => {
      if (asset && target === floor)
        target.useEnemyAssets(new Map([[asset.id, asset]]), prepareEnemy);
    }),
  );
  if (target.pressure) {
    pressureArt ??= Promise.all([loadPressureArt(), heroSet?.catch(() => null)]).then(
      ([art, resources]) => {
        for (const model of Object.values(art)) reflect(model, 0.38);
        if (resources) dressPumpMaterials(art, resources.set);
        return art;
      },
    );
    dressed.push(
      pressureArt
        .then((art) => {
          if (target === floor) target.pressure?.dress(art);
        })
        .catch((error: unknown) => console.warn('Pressure Works dressing unavailable', error)),
    );
  }
  const furnish = Boolean(target.pressure) || target.floorNumber === 2;
  if (furnish) {
    interiors ??= Promise.all([
      Promise.all([loadInteriorFurnishings(), libraryBindings]).then(([asset, atlas]) => {
        if (atlas) bindBookcaseAtlas(asset, atlas);
        reflect(asset.scene, 0.34);
        return asset;
      }),
      Promise.all(
        INTERIOR_PAINTINGS.map(async (url) => {
          const tex = await new THREE.TextureLoader().loadAsync(url);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          return tex;
        }),
      ),
    ]);
  }
  const [rooms, door, coffers, decor, furnishings, styles, stairs, chimeArt] = await Promise.all([
    roomAssets,
    sealedDoorMaterial,
    lootMaterials,
    tableDecor,
    furnish
      ? interiors?.catch((error: unknown) => {
          console.warn('Interior furnishing kit unavailable', error);
          return null;
        })
      : null,
    target.world.plan.rooms.some((_, index) =>
      roomStyleFor(target.world.plan, index, target.floorNumber),
    )
      ? architecturalFinishes()
      : undefined,
    target.floorNumber !== 3 && target.world.stairEntry ? stairModels() : undefined,
    target.floorNumber !== 3 && target.world.stairEntry
      ? puzzleInstruments().catch((error: unknown) => {
          console.warn('Chime instruments unavailable', error);
          return undefined;
        })
      : undefined,
    fitTable(target),
    ...dressed,
  ]);
  if (target === floor) {
    const missing = target.world.plan.rooms.find(
      (placed) => !rooms.some((room) => room.manifest.template.id === placed.templateId),
    );
    if (missing) throw new Error(`Couldn't load the ${missing.templateId} room`);
    const stair = target.floorNumber === 3 ? undefined : stairs?.get(target.floorNumber);
    if (stair) {
      target.dressStairs(stair);
    }
    dressHeroRooms(target, rooms, decor, styles);
    const candles = new Set<THREE.MeshStandardMaterial>();
    for (const group of target.world.roomGroups)
      group.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        for (const m of Array.isArray(node.material) ? node.material : [node.material]) {
          if (m instanceof THREE.MeshStandardMaterial && m.name.endsWith('_flame')) candles.add(m);
        }
      });
    if (decor) candles.add(decor.material);
    target.setCandleMaterials([...candles], hitFx.reducedMotion);
    if (furnishings) target.setFurnishings(furnishings[0], furnishings[1], hitFx.reducedMotion);
    if (chimeArt) {
      target.dressChimes(chimeArt);
      target.chimes?.sync(flow.run?.bellChimes);
    }
    if (target.floorNumber > 1 && target.contentVersion >= RETURN_PASSAGES_VERSION) {
      const [kit, secrets, portraits] = await Promise.all([
        conservatoryKit(),
        archiveKit(),
        target.floorNumber === 3 ? wizardPaintings() : Promise.resolve([]),
      ]);
      if (target !== floor) return;
      target.dressConservatory(
        kit,
        secrets,
        portraits,
        flow.run?.seed ?? target.seed,
        hitFx.reducedMotion,
      );
      if (target.floorNumber === 3) {
        const owl = makeClockworkOwlAsset(kit.getObjectByName('ClockworkOwl')!);
        target.useEnemyAssets(new Map([[owl.id, owl]]), prepareEnemy);
      }
    }
    if (target.contentVersion >= RETURN_PASSAGES_VERSION && target.floorNumber !== 3) {
      const kind = commissionPlan(
        target.floorNumber === 1 ? target.seed : (flow.run?.seed ?? target.seed),
      );
      if (target.floorNumber === 1 || kind === 'recovery') {
        const art = await commissionKit();
        if (target !== floor) return;
        target.dressCommission(art, kind, hitFx.reducedMotion);
      }
    }
    if (chimeArt && target.contentVersion >= RETURN_PASSAGES_VERSION && target.floorNumber !== 3) {
      const art = await calibrationKit();
      if (target !== floor) return;
      target.dressCalibration(
        art,
        chimeArt,
        target.floorNumber === 1 ? target.seed : (flow.run?.seed ?? target.seed),
        chestCardFace,
        hitFx.reducedMotion,
      );
    }
    if (
      target.contentVersion >= BRASS_CACHE_VERSION &&
      (target.world.plan.brassCache || (target.floorNumber === 2 && flow.brassCache))
    ) {
      brassKeyArt ??= new GLTFLoader()
        .loadAsync(`/assets/props/brass-key-kit/brass-key-kit.glb?v=${brassKeyRevision}`)
        .then(({ scene }) => {
          reflect(scene, 0.56);
          return scene;
        })
        .catch((error) => {
          brassKeyArt = undefined;
          throw error;
        });
      const art = await brassKeyArt;
      if (target !== floor) return;
      target.dressBrassKey(art);
    }
    if (target.world.plan.hiddenPassage) {
      const art = await panelKit();
      if (target !== floor) return;
      target.dressPanels(art, hitFx.reducedMotion);
    }
    syncPuzzles(target, true);
    for (const room of target.styledRooms)
      lightRoomStyle(room, target.furnishings?.placements ?? []);
    if (door) target.world.dressSealedDoors(door.material, door.tileMeters);
    if (coffers) {
      target.loot.dress(coffers);
      target.hearth.dress({ brass: coffers.brass });
    }
  }
};
async function prepareFloor(target: FloorView, boot = false): Promise<void> {
  covered = true;
  loadingFailed = false;
  if (stairTransit.phase !== 'loading') showLoading('Loading the tower…');
  try {
    await dressFloor(target);
    if (floor !== target) return;
    ui?.sync(camera);
    await ui?.waitForArtwork();
    if (boot) {
      showLoading('Preparing the scene…');

      const [rooms, models] = await Promise.all([roomAssets, loadedEnemies()]);
      await Promise.all([
        cardArtReady,
        soundReady,
        xr.handsReady,
        loadIconSheet().catch((error: unknown) => console.warn('UI icon atlas unavailable', error)),
      ]);
      // One instance per baked room and per loaded automaton, so every program (the corridor's
      // cloth and lamp glass, the vault's braziers, each model's skinning) links behind the veil
      // even when this floor never places it.
      const variants: THREE.Object3D[] = rooms.map((room) => room.instantiate());
      const actors = models.map((model) => model.spawn());
      for (const actor of actors) {
        prepareEnemy(actor);
        variants.push(actor.object);
      }
      const table = await tableAsset;
      if (table) variants.push(table.scene);
      const decor = await tableDecor;
      const decorSample = decor?.sample() ?? null;
      if (decorSample) variants.push(decorSample);
      try {
        await DiceWorld.warmUp();
        const textures = new Set([
          ...rooms.flatMap((room) => room.textures),
          ...(decor?.textures ?? []),
        ]);
        for (const room of target.styledRooms) {
          variants.push(room);
          textures.add(room.userData.finishLightMap);
          room.traverse((mesh) => {
            if (
              !(mesh instanceof THREE.Mesh) ||
              !(mesh.material instanceof THREE.MeshStandardMaterial)
            )
              return;
            for (const map of [
              mesh.material.map,
              mesh.material.normalMap,
              mesh.material.roughnessMap,
              mesh.material.metalnessMap,
            ]) {
              if (map) textures.add(map);
            }
          });
        }
        await runVeil(renderer, scene, camera, [...textures], { variants, fadeFrames: 0 });
      } finally {
        for (const actor of actors) actor.dispose();
        decorSample?.geometry.dispose();
      }
    }
    if (floor === target) {
      if (liftArrival === target && target.lift) {
        const eye = camera.getWorldPosition(new THREE.Vector3());
        const at = target.lift.object.localToWorld(new THREE.Vector3(0, 0, 1.5));
        rig.position.x += at.x - eye.x;
        rig.position.z += at.z - eye.z;
        rig.updateMatrixWorld(true);
        target.world.update(at.x, at.z);
        flow.enterRoom(target.world.current);
        liftArrival = null;
      }
      readyFloor = target;
    }
  } catch (error) {
    if (floor === target) {
      loadingFailed = true;
      failLoading(error);
    }
  } finally {
    if (boot)
      void heroSet?.then(
        ({ ktx2 }) => ktx2.dispose(),
        () => {},
      );
  }
}

// Flow glue: persistence, the in-scene boards, starting and resuming runs on a fresh floor.
const persistence = db
  ? bindFlowPersistence(flow, db, () => floor?.world.current ?? flow.room)
  : null;
/** Width of the card a coffer raises, metres: about a reward-board card, readable from the approach. */
const CHEST_CARD_WIDTH = 0.18;
/** The card face a coffer raises: the reward board's atlas face for one card. */
const chestCardFace = (id: string): CofferCardFace => {
  const height = CHEST_CARD_WIDTH * HOLO_CARD_ASPECT;
  const faces = new RewardCardFaces(
    [{ id, x: 0, y: 0, width: CHEST_CARD_WIDTH, height }],
    rewardCardTexture,
  );
  return { object: faces.root, width: CHEST_CARD_WIDTH, height, dispose: () => faces.dispose() };
};
const cofferAt = (target: FloorView, room: number, socketId: string): Coffer | undefined =>
  target.loot.coffers.find((c) => c.room === room && c.socketId === socketId);
/** The hand that grabbed the waiting card for the claim in flight; the card flies to the head otherwise. */
let claimHand: THREE.Object3D | null = null;
const syncNotes = (target: FloorView | null | undefined): void => {
  target?.notes?.sync(
    flow.pressure.notes,
    (room) => flow.cleared.includes(room),
    (room, socket) => flow.isLootOpened(room, socket),
  );
};
flow.onChange((event) => {
  syncNotes(floor);
  if (event.type === 'loot') {
    perfMark(`chest-${event.stage}`);
    storedSnapshot = flow.snapshot(Date.now(), floor?.world.current ?? flow.room);
    const coffer = floor ? cofferAt(floor, event.room, event.socketId) : undefined;
    const at = coffer?.object.getWorldPosition(new THREE.Vector3());
    if (event.stage === 'claimed') {
      // The card flies to the claimer; the panel over the coffer then names it.
      coffer?.claimCard(claimHand ?? camera, claimHand ? 0 : 0.3);
      if (floor?.loot.open(event.room, event.socketId, event.loot)) audio?.playSfx('card-draw', at);
    } else if (event.loot.kind === 'card') {
      // The card rises out of the coffer and waits there to be claimed: no panel yet.
      if (coffer) {
        coffer.open(true);
        if (event.loot.cogs) coffer.showCogs(event.loot.cogs);
        coffer.showCard(event.loot.card, chestCardFace(event.loot.card), true, camera);
        audio?.playSfx('gear-clank', at);
      }
    } else if (floor?.loot.open(event.room, event.socketId, event.loot)) {
      audio?.playSfx('gear-clank', at);
      audio?.playSfx('cog-pickup', at);
    }
    return;
  }
  if (event.type === 'brass-key') {
    floor?.brassKeyStand?.sync(flow.brassKey !== 'missing');
    floor?.loot.syncBrassLock(flow.brassKey === 'spent', false);
    storedSnapshot = flow.snapshot(Date.now(), floor?.world.current ?? flow.room);
    return;
  }
  if (event.type === 'commission') {
    floor?.office?.sync(flow.commission, event.action === 'claim' ? camera : undefined);
    storedSnapshot = flow.snapshot(Date.now(), floor?.world.current ?? flow.room);
    return;
  }
  if (event.type === 'calibration') {
    floor?.chartCabinet?.sync(
      flow.calibration,
      false,
      event.action === 'claim' ? camera : undefined,
    );
    floor?.calibrationBench?.sync(flow.calibration);
    storedSnapshot = flow.snapshot(Date.now(), floor?.world.current ?? flow.room);
    return;
  }
  if (event.type === 'hidden-panel') {
    floor?.panels?.sync(flow.hiddenPanel);
    floor?.world.setPuzzleGateOpen('panel', flow.hiddenPanel.opened);
    storedSnapshot = flow.snapshot(Date.now(), floor?.world.current ?? flow.room);
    return;
  }
  if (event.type === 'counterweight' || event.type === 'alchemy' || event.type === 'formula') {
    if (event.type === 'formula') floor?.office?.sync(flow.commission);
    if (floor) syncPuzzles(floor);
    storedSnapshot = flow.snapshot(Date.now(), floor?.world.current ?? flow.room);
    return;
  }
  if (event.type === 'bell-chimes') {
    floor?.chimes?.sync(flow.run?.bellChimes, event.feedback === 'claimed' ? camera : undefined);
    storedSnapshot = flow.snapshot(Date.now(), floor?.world.current ?? flow.room);
    return;
  }
  if (event.type === 'pressure') {
    storedSnapshot = flow.snapshot(Date.now(), event.room);
    if (event.action === 'prime') {
      floor?.world.setPuzzleGateOpen('pressure', event.solved);
      floor?.office?.sync(flow.commission);
    }
    if (event.action === 'note') {
      if (event.note) ui?.readNote(event.note, camera);
    } else {
      floor?.pressure?.sync(event, !hitFx.reducedMotion, event.action);
      const at = floor?.pressure?.pump.getWorldPosition(new THREE.Vector3());
      audio?.playSfx(event.action === 'claim' ? 'cog-pickup' : 'gear-clank', at);
      if (event.action === 'prime') audio?.playSfx('steam-vent', at);
    }
    return;
  }
  if (event.type === 'hearth') {
    storedSnapshot = flow.snapshot(Date.now(), floor?.world.current ?? flow.room);
    if (floor?.hearth.use(event.room, event.socketId, event.healed)) {
      const lit = floor.hearth.hearths.find(
        (h) => h.room === event.room && h.socketId === event.socketId,
      );
      const at = lit?.object.getWorldPosition(new THREE.Vector3());
      audio?.playSfx('steam-vent', at);
      audio?.playSfx('cog-pickup', at);
    }
    return;
  }
  if (event.type === 'book-secret') {
    storedSnapshot = flow.snapshot(Date.now(), event.room);
    floor?.book.setStage(event.room, event.stage);
    floor?.showBookSecret(
      {
        text:
          event.stage === 'key'
            ? 'Clockmaker’s key'
            : event.stage === 'unlock'
              ? 'Unlocked'
              : `+${event.cogs} cogs`,
        caption: event.inscription,
      },
      camera,
    );
    const at = floor?.book.objectAt(event.room)?.getWorldPosition(new THREE.Vector3());
    audio?.playSfx(event.stage === 'unlock' ? 'gear-clank' : 'cog-pickup', at);
    return;
  }
  if (event.type !== 'phase') return;
  perfMark(`phase ${event.to}`);
  // Only a flee goes from a fight straight back to exploring: the player steps back to the doorway
  // they came in by, before the snapshot below records the room.
  if (event.from === 'combat' && event.to === 'explore') standAtEntry(flow.room);
  const abandoned = event.to === 'title' && (event.from === 'explore' || event.from === 'combat');
  if (event.to === 'explore' || event.to === 'reward' || event.to === 'guardian-cleared') {
    storedSnapshot = flow.snapshot(Date.now(), floor?.world.current ?? flow.room);
  } else if (event.to === 'death' || event.to === 'victory' || abandoned) {
    storedSnapshot = null;
  }
  if (event.to === 'title' && (event.from === 'death' || event.from === 'victory' || abandoned))
    titleReset = true;
});
/**
 * Moves the player to just inside `room`'s entry doorway (x/z only: in XR the rig's y holds the
 * seated lift), keeping the head where the rig puts it, and faces the desktop view into the room.
 */
function standAtEntry(room: number): void {
  const target = floor;
  const at = target && fleeStandPoint(target.world.plan, target.world.rooms, room);
  if (!target || !at) return;
  rig.updateMatrixWorld(true);
  const head = camera.getWorldPosition(new THREE.Vector3());
  rig.position.x += at.x - head.x;
  rig.position.z += at.z - head.z;
  const r = target.world.rooms[room];
  if (r && !xr.presenting) {
    const cx = (r.footprint.min[0] + r.footprint.max[0]) / 2;
    const cz = (r.footprint.min[1] + r.footprint.max[1]) / 2;
    walker.yaw = (Math.atan2(cx - at.x, -(cz - at.z)) * 180) / Math.PI;
  }
  rig.updateMatrixWorld(true);
}
/** Puts a pristine floor for `seed` under the player, rebuilding in place (no reload, XR stays up). */
const freshFloor = (
  seed: string,
  contentVersion?: number,
  preservedBookRooms?: readonly number[],
  floorNumber: 1 | 2 | 3 = 1,
): FloorView => {
  if (
    floor &&
    floor.seed === seed &&
    floor.floorNumber === floorNumber &&
    floor.contentVersion === (contentVersion ?? ENCOUNTER_CONTENT_VERSION) &&
    !floorUsed &&
    !preservedBookRooms?.length
  )
    return floor;
  locomotion.setGroundOffset(0);
  combat?.dispose();
  floor?.dispose();
  floor = mountFloor(seed, contentVersion, preservedBookRooms, floorNumber);
  floor.setAudio(audio);
  combat = makeCombat(floor);
  void prepareFloor(floor);
  return floor;
};
const startRun = (seed: string, difficulty: Difficulty): void => {
  if (flow.phase !== 'title') return;
  const target = freshFloor(seed);
  // x/z only: in XR the rig's y holds the seated-height lift from the recenter.
  const spawn = target.world.spawnPoint();
  rig.position.set(spawn.x, rig.position.y, spawn.z);
  walker.yaw = 0;
  floorUsed = true;
  flow.newRun(target.seed, difficulty);
};
const savedFloor = (snap: RunSnapshot): FloorView => {
  const preservedBookRooms = [
    ...new Set([
      ...(snap.run.bookSecretKeyRooms ?? []),
      ...(snap.run.bookSecretCabinetRooms ?? []),
      ...(snap.run.bookSecretOpenedRooms ?? []),
    ]),
  ];
  const target = freshFloor(
    snap.floorSeed,
    snap.contentVersion ?? 1,
    preservedBookRooms,
    snap.floorNumber === 3 ? 3 : snap.floorNumber === 2 ? 2 : 1,
  );
  for (const room of snap.clearedEncounters) target.markCleared(Number(room), true);
  for (const key of snap.run.openedLoot ?? []) {
    const opened = parseLootKey(key);
    if (opened) target.loot.markOpened(opened.room, opened.socketId);
  }
  for (const { key, card } of snap.run.pendingLoot ?? []) {
    const opened = parseLootKey(key);
    const coffer = opened && cofferAt(target, opened.room, opened.socketId);
    coffer?.showCard(card, chestCardFace(card), false, camera);
  }
  for (const key of snap.run.usedHearths ?? []) {
    const used = parseLootKey(key);
    if (used) target.hearth.markUsed(used.room, used.socketId);
  }
  target.book.restore(snap.run);
  target.chimes?.sync(snap.run.bellChimes);
  return target;
};

function arriveAtLanding(target: FloorView, entry: StairEntry): void {
  const [fx, fz] = entry.facing;
  if (xr.presenting) {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    rig.rotation.y += Math.atan2(-fx, -fz) - Math.atan2(dir.x, dir.z);
  } else {
    walker.yaw = THREE.MathUtils.radToDeg(Math.atan2(-fx, fz));
    rig.rotation.y = -THREE.MathUtils.degToRad(walker.yaw);
  }
  rig.updateMatrixWorld(true);
  const eye = camera.getWorldPosition(new THREE.Vector3());
  const [x, z] = entry.approach;
  rig.position.x += x - eye.x;
  rig.position.z += z - eye.z;
  rig.updateMatrixWorld(true);
  target.world.update(x, z);
}

let liftArrival: FloorView | null = null;
function travelStairs(byLift = false): boolean {
  const source = floor;
  const stairs = source?.stairs;
  const transport = byLift ? source?.lift : stairs;
  if (!source || !transport || busy() || flow.phase !== 'explore' || source.locked || !flow.run)
    return false;
  const destination = transport.destination;
  const nextSeed = floorSeedFor(flow.run.seed, destination);
  const next = byLift
    ? null
    : placeStairEntry(
        playableFloorPlan(nextSeed, source.contentVersion, destination),
        worldTemplates,
      );
  if (!next && !byLift) return false;
  const pull = (byLift ? source.lift!.target : stairs!.handle).getWorldPosition(
    new THREE.Vector3(),
  );
  let sounded = false;
  const started = stairTransit.start({
    swing(fraction) {
      if (!byLift) stairs?.open(fraction);
      if (!sounded && fraction > 0.04) {
        sounded = true;
        audio?.playSfx('door-open', pull);
      }
    },
    cross() {
      if (floor !== source || !flow.travelToFloor(destination, next?.room ?? 0)) {
        if (!byLift) stairs?.open(0);
        return;
      }
      const snap = flow.snapshot(Date.now(), next?.room ?? 0);
      if (!snap) throw Error('No exploration state after crossing the staircase');
      const target = savedFloor(snap);
      if (next) arriveAtLanding(target, next);
      else liftArrival = target;
      syncPuzzles(target, true);
      target.pressure?.sync(flow.pressure);
      syncNotes(target);
      storedSnapshot = snap;
    },
  });
  if (started) audio?.playSfx('gear-clank', pull, 0.5);
  return started;
}

const continueRun = (): void => {
  if (!storedSnapshot || flow.phase !== 'title') return;
  const snap = restoreUpperRoomLocations(storedSnapshot, worldTemplates);
  const target = savedFloor(snap);
  const at = target.standPoint(snap.roomIndex) ?? target.world.spawnPoint();
  rig.position.set(at.x, rig.position.y, at.z);
  target.world.update(at.x, at.z);
  floorUsed = true;
  if (snap.floorNumber && target.world.stairEntry?.room === snap.roomIndex)
    arriveAtLanding(target, target.world.stairEntry);
  flow.continueRun(snap);
  syncPuzzles(target, true);
  target.pressure?.sync(flow.pressure);
  syncNotes(target);
};
const ui = floor
  ? new FlowUi({
      flow,
      locationLabel: () => {
        if (!floor) return null;
        if (floor.floorNumber === 3) return 'Floor 3 · Alchemical Conservatory';
        const name = floor.floorNumber === 2 ? 'Floor 2 · Upper Works' : 'Floor 1';
        if (!isShowcaseFloor(floor.seed, floor.floorNumber)) return name;
        const index = floor.world.current;
        const { template, footprint } = floor.world.rooms[index];
        const width = footprint.max[0] - footprint.min[0],
          depth = footprint.max[1] - footprint.min[1];
        return `${name} · Room ${index} · ${template.id.replaceAll('-', ' ')} · ${width} × ${depth} m`;
      },
      onNoteOpened: (at) => audio?.playSfx('paper-unfold', at),
      noteRecord: (id) => floor?.notes?.record(id) ?? null,
      keyArt: { url: '/assets/ui/title-2048.jpg', titleSafe: { x: 0.03, y: 0.3, w: 0.27, h: 0.4 } },
      seed: bootSeed,
      snapshot: () => storedSnapshot,
      settings: () => settings ?? { ...DEFAULT_SETTINGS },
      onNewRun: startRun,
      onContinue: continueRun,
      update: updateNotice,
      // A picked reward card flies to the hand whose ray picked it, else to just before the head.
      dialProbe: heroEnv,
      flyTarget: () =>
        rewardHand ? { object: rewardHand, standoff: 0 } : { object: camera, standoff: 0.3 },
      setTableDistance: (distance) => floor?.setTableDistance(distance, camera) ?? true,
      onSettings: (next) => {
        settings = next;
        audio?.setVolumes({
          master: next.masterVolume,
          music: next.musicVolume,
          sfx: next.sfxVolume,
        });
        Object.assign(locomotion.settings, locomotionSettingsFrom(next));
        xr.setFoveation(next.foveation);
        perf.setFoveation(foveationValue(next.foveation));
        perf.setFpsCounter(next.fpsCounter);
        if (settingsDb) void saveSettings(settingsDb, next);
      },
    })
  : null;
// The boards draw in their own pass over a cleared depth buffer, so the automatons and walls of the
// fight that just ended never hide the reward or summary in front of the player.
const uiScene = new THREE.Scene();
/** The grip of the controller whose ray picked a board control, while that pick is handled. */
let rewardHand: THREE.Object3D | null = null;
/**
 * Opens the in-run menu over exploring or a fight, or closes it. Opening it mid-fight first drops
 * a staged card or a stroke (Escape's old job in a fight). Returns whether anything changed.
 */
const toggleMenu = (): boolean => {
  if (!ui || busy()) return false;
  if (!ui.menuOpen && flow.phase === 'combat') actions.emit({ type: 'combat-cancel' });
  return ui.toggleMenu(camera);
};
const menuEdge = new ButtonEdge();
const menuStick = createStickRadialNavigation<(typeof RUN_MENU_ITEMS)[number]['id'], 'right'>({
  menu: {
    get isOpen() {
      return ui?.menuView === 'main';
    },
    get interactive() {
      return ui?.radialInteractive ?? false;
    },
    setHovered(action) {
      ui?.hover(action ? `menu-${action}` : null);
    },
  },
  items: RUN_MENU_ITEMS.map((item) => item.id),
  isBusy: () => busy() || Boolean(ui?.visible),
  onOpen: toggleMenu,
  onClose: () => ui?.closeMenu(),
});
let releaseMenuStick = false;
renderer.xr.addEventListener('sessionend', () => {
  menuStick.reset();
  menuStick.update('right', { x: 0, y: 0, pressed: false });
  releaseMenuStick = false;
});
// Escape toggles the in-run menu; the boards' own Escape (back to the title) is handled below.
window.addEventListener('keydown', (event) => {
  if (busy()) return;
  if (event.key !== 'Escape' || event.repeat || xr.presenting) return;
  if (toggleMenu()) event.preventDefault();
});
if (ui) uiScene.add(ui.root);
if (ui && directSeed) startRun(bootSeed, settings?.difficulty ?? DEFAULT_DIFFICULTY);
ui?.sync(camera);
const heroReady = floor ? prepareFloor(floor, true) : Promise.resolve();
actions.on('select', ({ controlId }) => {
  if (busy()) return;
  ui?.activate(controlId);
});
const uiPointer = createPointer({ far: 6 });
const pickUi = (origin: THREE.Vector3, direction: THREE.Vector3): string | null => {
  if (!ui?.visible) return null;
  const hit = uiPointer.cast(origin, direction, ui.targets());
  return hit ? ui.controlAt(hit.object) : null;
};
const mouseRay = (event: PointerEvent): THREE.Ray => {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  camera.updateMatrixWorld(true);
  const caster = new THREE.Raycaster();
  caster.setFromCamera(ndc, camera);
  return caster.ray;
};
// Board presses are claimed in the capture phase, so they never start drag-to-look.
window.addEventListener(
  'pointerdown',
  (event) => {
    if (!ui?.visible || xr.presenting || event.button !== 0) return;
    if (event.target !== renderer.domElement) return;
    const ray = mouseRay(event);
    const id = pickUi(ray.origin, ray.direction);
    event.stopImmediatePropagation();
    if (id) actions.emit({ type: 'select', controlId: id });
  },
  { capture: true },
);
window.addEventListener('pointermove', (event) => {
  if (!ui?.visible || xr.presenting || event.target !== renderer.domElement) return;
  const ray = mouseRay(event);
  ui.hover(pickUi(ray.origin, ray.direction));
});
// Treasure: a desktop click on a coffer in the current room opens it, in the capture phase so the
// press never starts drag-to-look. A click that misses falls through to looking around.
const canOpenLoot = (): boolean =>
  !!floor &&
  !busy() &&
  flow.phase === 'explore' &&
  floor.encounter.phase === 'idle' &&
  !ui?.visible;
function takeBrassKey(): boolean {
  const stand = floor?.brassKeyStand;
  if (!stand || !flow.takeBrassKey()) return false;
  audio?.playSfx('cog-pickup', stand.key.getWorldPosition(chimePosition), 0.55);
  floor?.showBookSecret(
    { text: 'Brass key', caption: 'Stamped for a lower-floor coffer.' },
    camera,
  );
  return true;
}
function tryBrassLock(room: number, socketId: string): boolean {
  const cache = floor?.world.plan.brassCache;
  if (!cache || room !== cache.room || socketId !== cache.socketId || flow.brassKey === 'spent')
    return false;
  if (!flow.inspectBrassLock(room, socketId)) return false;
  const opened = flow.run?.brassKey === 'spent';
  const coffer = floor?.loot.coffers.find((c) => c.room === room && c.socketId === socketId);
  audio?.playSfx(
    'gear-clank',
    coffer?.object.getWorldPosition(chimePosition),
    opened ? 0.65 : 0.25,
  );
  floor?.showBookSecret(
    opened
      ? { text: 'Lock released', caption: 'The brass key turns in the ward.' }
      : { text: 'Brass lock', caption: 'Its brass plate bears the Upper Works stamp.' },
    camera,
  );
  return true;
}
/** Opens the shut coffer, or claims the card waiting over an open one, that a pick found. */
const openCoffer = (pick: LootPick | null): boolean => {
  if (!pick || !canOpenLoot()) return false;
  if (tryBrassLock(pick.room, pick.socketId)) return true;
  if (floor?.loot.showLock(pick.room, pick.socketId)) return true;
  if (!pick.claim) return flow.openLoot(pick.room, pick.socketId, pick.kind) !== null;
  claimHand = null;
  return flow.claimLoot(pick.room, pick.socketId) !== null;
};
/** How near a hand must be to the waiting card for a squeeze to grab it, metres. */
const GRAB_REACH = 0.25;
/** Claims the waiting card in the current room that `hand` is close enough to grab. */
const grabLootCard = (hand: THREE.Object3D | null): boolean => {
  if (!floor || !hand || !canOpenLoot()) return false;
  const here = floor.loot.coffers.filter((c) => c.room === floor?.world.current);
  const coffer = nearestCard(here, hand.getWorldPosition(new THREE.Vector3()), GRAB_REACH);
  if (!coffer) return false;
  claimHand = hand;
  const claimed = flow.claimLoot(coffer.room, coffer.socketId) !== null;
  claimHand = null;
  return claimed;
};
const useHearth = (pick: HearthPick | null): boolean =>
  !!pick && canOpenLoot() && flow.useHearth(pick.room, pick.socketId) !== null;
const openBook = (pick: ReturnType<FloorView['book']['pick']> | null): boolean => {
  if (!pick || !canOpenLoot()) return false;
  if (pick.kind === 'cabinet') return flow.unlockBookSecret(pick.room);
  if (pick.kind === 'cog') return flow.claimBookSecret(pick.room);
  return flow.findBookSecretKey(pick.room);
};
function operateMachine(hit: PressureAction, hand?: XRHandedness): boolean {
  if (!floor || !canOpenLoot()) return false;
  const room = floor.world.current;
  const result =
    hit.action === 'turn'
      ? flow.turnPressureValve(room, hit.valve)
      : hit.action === 'prime'
        ? flow.primePressure(room)
        : hit.action === 'open'
          ? flow.openPressureDrawer(room)
          : flow.claimPressureReward(room);
  if (!result && hit.action === 'prime') floor.pressure?.primeMiss(!hitFx.reducedMotion);
  if (hand) {
    const inputs = Array.from(renderer.xr.getSession()?.inputSources ?? []).filter(
      (source) => source.handedness === hand,
    );
    pulseHaptics(
      inputs,
      result ? (hit.action === 'prime' ? 0.6 : hit.action === 'open' ? 0.36 : 0.2) : 0.12,
      result && hit.action === 'prime' ? 260 : 70,
    );
  }
  return true;
}

const BEAT_SECONDS = 0.7;
let playback: { box: BellChimes; notes: readonly BellNote[]; next: number; delay: number } | null =
  null;
const chimePosition = new THREE.Vector3();

function ringNote(box: BellChimes, note: BellNote): void {
  box.cue(note);
  audio?.playChime(note, box.object.getWorldPosition(chimePosition));
}

function operateChimes(pick: BellPick): boolean {
  const box = floor?.chimes;
  if (!box || !canOpenLoot()) return false;
  if (pick.action === 'listen') {
    if (!flow.run || !flow.listenToChimes()) return false;
    const notes = bellMelody(flow.run.seed);
    ringNote(box, notes[0]);
    playback = { box, notes, next: 1, delay: BEAT_SECONDS };
    return true;
  }
  if (pick.action === 'strike' && pick.note !== undefined) {
    const result = flow.strikeChime(pick.note);
    if (!result) return false;
    ringNote(box, pick.note);
    if (result === 'mistake') box.miss();
    if (result === 'solved')
      audio?.playSfx('gear-clank', box.object.getWorldPosition(chimePosition));
    return true;
  }
  if (pick.action === 'claim' && flow.claimChimeReward()) {
    audio?.playSfx('cog-pickup', box.object.getWorldPosition(chimePosition));
    return true;
  }
  return false;
}

function advanceMusicBox(dt: number): void {
  if (!playback) return;
  const { box, notes } = playback;
  if (floor?.chimes !== box || floor.world.current !== box.room || !canOpenLoot()) {
    playback = null;
    return;
  }
  playback.delay -= dt;
  if (playback.delay > 0) return;
  ringNote(box, notes[playback.next++]);
  if (playback.next === notes.length) playback = null;
  else playback.delay += BEAT_SECONDS;
}

function operateWeight(
  hit: NonNullable<ReturnType<NonNullable<FloorView['counterweight']>['pick']>>,
): boolean {
  const station = floor?.counterweight;
  if (!station || station.room !== floor?.world.current) return false;
  const result =
    hit.action === 'weigh' ? flow.weighCounterweight(hit.weight) : flow.hangCounterweight();
  if (result === 'mistake') station.miss();
  if (result) audio?.playSfx('gear-clank', station.object.getWorldPosition(chimePosition));
  return !!result;
}
function operateCommission(input: CommissionAction): boolean {
  if (!floor?.office || !canOpenLoot()) return false;
  const job = flow.commission;
  if (input.action === 'spring') {
    if (!flow.collectSpring(input.spring)) return false;
    floor.showBookSecret(
      { text: 'Marked escapement', caption: `${flow.commission.progress} of 3 recovered` },
      camera,
    );
    audio?.playSfx('gear-clank');
    return true;
  }
  if (input.action === 'read') {
    floor.office.read();
    floor.showBookSecret(
      {
        text: COMMISSION_TITLES[job.kind],
        caption: job.claimed
          ? 'Paid in full.'
          : job.accepted && job.progress === job.total
            ? 'The keeper has left your payment.'
            : COMMISSION_ORDERS[job.kind],
      },
      camera,
    );
    audio?.playSfx('card-draw');
    return true;
  }
  if (input.action === 'accept') {
    if (!flow.acceptCommission()) return false;
    floor.showBookSecret({ text: 'Order filed', caption: COMMISSION_TITLES[job.kind] }, camera);
    audio?.playSfx('gear-clank');
    return true;
  }
  if (!flow.claimCommission()) return false;
  floor.showBookSecret(
    { text: `+${COMMISSION_PAYOUT[job.kind]} cogs`, caption: 'Commission settled' },
    camera,
  );
  audio?.playSfx('cog-pickup');
  return true;
}
function readFolio(input: FolioPick): boolean {
  if (!floor || !flow.run) return false;
  const plan = calibrationPlan(flow.run.seed);
  if (input.action === 'card') {
    const card = flow.claimCalibrationCard();
    if (!card) return false;
    audio?.playSfx('card-draw');
    floor.showBookSecret(
      { text: 'Card added to deck', caption: CARDS.find((c) => c.id === card)?.name ?? card },
      camera,
    );
    return true;
  }
  const acquired = flow.takeCalibrationChart();
  floor.showBookSecret(
    {
      text: acquired
        ? 'Winding key and chart'
        : plan.kind === 'gears'
          ? 'Service diagram'
          : 'Celestial table',
      caption:
        plan.kind === 'gears'
          ? plan.gearOrder.map((id) => GEAR_TEETH[id]).join(' · ') + ' teeth'
          : plan.detents.map((d) => BEARINGS[d]).join(' · '),
    },
    camera,
  );
  audio?.playSfx(acquired ? 'gear-clank' : 'card-draw');
  return true;
}
function operateCalibration(hit: CalibrationAction): boolean {
  const bench = floor?.calibrationBench;
  if (!bench) return false;
  if (hit.action === 'wind') {
    const outcome = flow.windCalibration();
    if (outcome) {
      bench.drive(outcome);
      audio?.playSfx(outcome === 'solved' ? 'door-open' : 'gear-clank');
    } else if (!flow.calibration.chart)
      floor?.showBookSecret(
        { text: 'Empty winding arbor', caption: 'A square key fits this spindle.' },
        camera,
      );
    return true;
  }
  const changed =
    hit.action === 'gear'
      ? flow.selectCalibrationGear(hit.id)
      : hit.action === 'seat'
        ? flow.seatCalibrationGear(hit.id)
        : flow.turnCalibrationRing(hit.id);
  if (changed) audio?.playSfx('gear-clank', undefined, 0.48);
  return changed;
}
function operatePanel(hit: PanelHit, side?: XRHandedness): boolean {
  if (!floor?.panels || !canOpenLoot()) return false;
  const at = floor.panels.strike(hit.index);
  if (hit.action === 'unlatch') {
    if (!flow.openHiddenPanel()) return false;
    audio?.playSfx('door-open', at);
  } else {
    audio?.playSfx(hit.hollow ? 'panel-hollow' : 'panel-solid', at);
    if (hit.hollow && flow.discoverHiddenPanel())
      floor.showBookSecret(
        { text: 'Hollow service panel', caption: 'A recessed catch springs loose.' },
        camera,
      );
  }
  if (side) {
    const inputs = Array.from(renderer.xr.getSession()?.inputSources ?? []).filter(
      (s) => s.handedness === side,
    );
    pulseHaptics(inputs, hit.hollow ? 0.29 : 0.15, hit.hollow ? 110 : 35);
  }
  return true;
}
function inspectFormula(clue: FormulaClue): boolean {
  if (!floor || !flow.run) return false;
  flow.learnFormulaClue(clue);
  const recipe = flow.conservatoryFormula.recipe;
  floor.showBookSecret(
    {
      text: clue === 'portrait' ? 'The painted seal' : RECORD_TITLES[recipe],
      caption: formulaObservation(flow.run.seed, clue),
    },
    camera,
  );
  audio?.playSfx('card-draw');
  return true;
}
function operateArchive(action: 'pour' | 'unlatch'): boolean {
  const success = flow.useFormula(action);
  if (!success) return false;
  audio?.playSfx(action === 'unlatch' ? 'door-open' : 'steam-vent');
  return true;
}
function operateAlchemy(
  hit: NonNullable<ReturnType<NonNullable<FloorView['alchemy']>['pick']>>,
): boolean {
  if (hit.action === 'apply') return flow.applyPotion();
  if (hit.ingredient === undefined) return false;
  const result =
    hit.action === 'collect'
      ? flow.collectIngredient(hit.ingredient)
      : flow.alchemy.opened
        ? flow.addFormulaIngredient(hit.ingredient, floor?.alchemy?.inStillInterval ?? false)
        : flow.addIngredient(hit.ingredient);
  if (result === 'waiting')
    floor?.showBookSecret(
      { text: 'The draft stirs the mixture', caption: 'The chart marks the still interval.' },
      camera,
    );
  if (result && result !== 'waiting')
    audio?.playSfx(hit.action === 'collect' ? 'card-draw' : 'steam-vent');
  return !!result;
}
function fieldHit(origin: THREE.Vector3, direction: THREE.Vector3) {
  if (!floor) return null;
  const stair = floor.stairs?.pick(floor.world.current, origin, direction);
  const note = floor.notes?.pick(origin, direction);
  const machine = floor.pressure?.pick(origin, direction);
  const coffer = floor.loot.pick(origin, direction);
  const hearth = floor.hearth.pick(origin, direction);
  const book = floor.book.pick(origin, direction);
  const chime = floor.chimes?.pick(origin, direction);
  const weight =
    floor.counterweight?.room === floor.world.current
      ? floor.counterweight.pick(origin, direction)
      : null;
  const gate = floor.world.pickPuzzleGate(origin, direction);
  const lift = floor.lift?.pick(origin, direction);
  const brew = floor.alchemy?.pick(origin, direction);
  const clock = floor.clock?.pick(origin, direction);
  const archive = floor.archive?.pick(origin, direction);
  const evidence = floor.formulaEvidence?.pick(origin, direction);
  const office = floor.office?.pick(origin, direction);
  const calibration = floor.calibrationBench?.pick(origin, direction),
    folio = floor.chartCabinet?.pick(origin, direction);
  const key = floor.brassKeyStand?.pick(origin, direction);
  const panel = floor.panels?.pick(origin, direction);
  const hits = [
    ...(key ? [{ kind: 'brass-key' as const, hit: key }] : []),
    ...(office ? [{ kind: 'commission' as const, hit: office }] : []),
    ...(calibration ? [{ kind: 'calibration' as const, hit: calibration }] : []),
    ...(folio ? [{ kind: 'folio' as const, hit: folio }] : []),
    ...(panel ? [{ kind: 'hidden-panel' as const, hit: panel }] : []),
    ...(archive ? [{ kind: 'archive' as const, hit: archive }] : []),
    ...(evidence ? [{ kind: 'formula-clue' as const, hit: evidence }] : []),
    ...(weight ? [{ kind: 'counterweight' as const, hit: weight }] : []),
    ...(gate ? [{ kind: 'gate' as const, hit: gate }] : []),
    ...(lift ? [{ kind: 'lift' as const, hit: lift }] : []),
    ...(brew ? [{ kind: 'alchemy' as const, hit: brew }] : []),
    ...(clock ? [{ kind: 'clock' as const, hit: clock }] : []),
    ...(chime ? [{ kind: 'chime' as const, hit: chime }] : []),
    ...(stair ? [{ kind: 'stairs' as const, hit: stair }] : []),
    ...(note ? [{ kind: 'note' as const, hit: note }] : []),
    ...(machine ? [{ kind: 'machine' as const, hit: machine }] : []),
    ...(coffer ? [{ kind: 'coffer' as const, hit: coffer }] : []),
    ...(hearth ? [{ kind: 'hearth' as const, hit: hearth }] : []),
    ...(book ? [{ kind: 'book' as const, hit: book }] : []),
  ];
  return hits.sort((a, b) => a.hit.distance - b.hit.distance)[0] ?? null;
}
const activatePickup = (
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  hand?: XRHandedness,
): boolean => {
  if (!canOpenLoot()) return false;
  const pick = fieldHit(origin, direction);
  if (!pick) return false;
  switch (pick.kind) {
    case 'brass-key':
      return takeBrassKey();
    case 'commission':
      return operateCommission(pick.hit);
    case 'calibration':
      return operateCalibration(pick.hit);
    case 'folio':
      return readFolio(pick.hit);
    case 'hidden-panel':
      return operatePanel(pick.hit, hand);
    case 'archive':
      return operateArchive(pick.hit.action);
    case 'formula-clue':
      return inspectFormula(pick.hit.clue);
    case 'counterweight':
      return operateWeight(pick.hit);
    case 'clock':
      return flow.collectIngredient(pick.hit.ingredient);
    case 'alchemy':
      return operateAlchemy(pick.hit);
    case 'lift':
      return travelStairs(true);
    case 'gate': {
      const at = floor?.world.rattlePuzzleGate(pick.hit.kind);
      if (at) audio?.playSfx('gear-clank', at);
      return !!at;
    }
    case 'chime':
      return operateChimes(pick.hit);
    case 'stairs':
      return travelStairs();
    case 'note':
      return flow.collectPressureNote(pick.hit.room, pick.hit.id) !== null;
    case 'machine':
      return operateMachine(pick.hit, hand);
    case 'coffer':
      return openCoffer(pick.hit);
    case 'hearth':
      return useHearth(pick.hit);
    case 'book':
      return openBook(pick.hit);
  }
};
const pickupDistance = (origin: THREE.Vector3, direction: THREE.Vector3): number | null =>
  fieldHit(origin, direction)?.hit.distance ?? null;
/** Ray origin and direction of an XR controller (its -Z axis, the beam the laser draws). */
const controllerRay = (
  controller: THREE.Object3D,
): { origin: THREE.Vector3; direction: THREE.Vector3 } => {
  controller.updateWorldMatrix(true, false);
  return {
    origin: new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld),
    direction: new THREE.Vector3(0, 0, -1).transformDirection(controller.matrixWorld),
  };
};
window.addEventListener(
  'pointerdown',
  (event) => {
    if (xr.presenting || event.button !== 0 || event.target !== renderer.domElement) return;
    if (!floor || !canOpenLoot()) return;
    const { origin, direction } = mouseRay(event);
    if (activatePickup(origin, direction)) event.stopImmediatePropagation();
  },
  { capture: true },
);
window.addEventListener('pointermove', (event) => {
  if (xr.presenting || event.target !== renderer.domElement) return;
  let over = false;
  if (floor && canOpenLoot()) {
    const { origin, direction } = mouseRay(event);
    over = pickupDistance(origin, direction) !== null;
  }
  renderer.domElement.style.cursor = over ? 'pointer' : '';
});
// Keyboard on the boards: type a seed, arrows move focus, Enter activates, Escape backs out.
let focusIndex = -1;
window.addEventListener('keydown', (event) => {
  if (busy()) return;
  if (!ui?.visible || xr.presenting) return;
  if (ui.typeKey(event.key)) {
    event.preventDefault();
    return;
  }
  const ids = ui.controlIds();
  if (ids.length === 0) return;
  if (['ArrowDown', 'ArrowRight', 'Tab'].includes(event.key)) {
    focusIndex = (focusIndex + 1) % ids.length;
  } else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) {
    focusIndex = (focusIndex - 1 + ids.length) % ids.length;
  } else if (event.key === 'Enter' && focusIndex >= 0 && ids[focusIndex]) {
    actions.emit({ type: 'select', controlId: ids[focusIndex] as string });
    focusIndex = -1;
    event.preventDefault();
    return;
  } else if (event.key === 'Escape') {
    flow.toTitle();
    return;
  } else return;
  event.preventDefault();
  ui.hover(ids[focusIndex] ?? null);
});

// Desktop combat verbs: the mouse becomes combat-pointer actions. Presses that land on a combat
// control are claimed in the capture phase so they never start drag-to-look.
const pointerNdc = new THREE.Vector2();
const pointerRaycaster = new THREE.Raycaster();
let pointerCaptured = false;
const emitPointer = (event: PointerEvent, phase: 'down' | 'move' | 'up'): boolean => {
  const session = combat?.session;
  if (!session || xr.presenting || ui?.menuOpen) return false;
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  camera.updateMatrixWorld(true);
  pointerRaycaster.setFromCamera(pointerNdc, camera);
  const { origin, direction } = pointerRaycaster.ray;
  const o = [origin.x, origin.y, origin.z] as const;
  const d = [direction.x, direction.y, direction.z] as const;
  if (phase === 'down' && !session.claims(o, d)) return false;
  actions.emit({
    type: 'combat-pointer',
    phase,
    origin: o,
    direction: d,
    ndc: [pointerNdc.x, pointerNdc.y],
  });
  return true;
};
window.addEventListener(
  'pointerdown',
  (event) => {
    if (event.button !== 0 || event.target !== renderer.domElement) return;
    if (!emitPointer(event, 'down')) return;
    event.stopPropagation();
    pointerCaptured = true;
  },
  { capture: true },
);
window.addEventListener('pointermove', (event) => {
  if (pointerCaptured || event.target === renderer.domElement) emitPointer(event, 'move');
});
const pointerUp = (event: PointerEvent): void => {
  if (!pointerCaptured) return;
  pointerCaptured = false;
  emitPointer(event, 'up');
};
window.addEventListener('pointerup', pointerUp);
window.addEventListener('pointercancel', pointerUp);
// A right click puts a picked-up card back in the hand, the desktop form of letting go of the grip.
renderer.domElement.addEventListener('contextmenu', (event) => {
  if (!combat?.session?.holdingCard || xr.presenting) return;
  event.preventDefault();
  actions.emit({ type: 'combat-cancel' });
});
window.addEventListener('keydown', (event) => {
  if (busy()) return;
  if (floor?.encounter.phase !== 'active' || event.repeat || ui?.menuOpen) return;
  if (event.code === 'KeyE') actions.emit({ type: 'end-turn' });
  else if (event.code === 'KeyT' || event.code === 'Space') actions.emit({ type: 'throw-dice' });
  // F flees through the session, so an elite or guardian fight refuses it as the button would.
  else if (event.code === 'KeyF') combat?.session?.flee();
  // Debug resolution, kept from the greybox phase.
  else if (event.code === 'KeyK') winFight();
});

// XR combat verbs: main hand (right) squeeze grabs a card (letting go puts it back) and holds the
// die; the trigger uses the held card, draws on the plate, throws and presses.
let pullMark: { side: 'left' | 'right'; hand: THREE.Object3D; start: THREE.Vector3 } | null = null;
const pullPoint = new THREE.Vector3();
const MAIN_HAND = 'right' as const;
const OFF_HAND = 'left' as const;
for (const index of [0, 1]) {
  const controller = renderer.xr.getController(index);
  const bind = (
    type: 'squeezestart' | 'squeezeend' | 'selectstart' | 'selectend',
    control: 'squeeze' | 'trigger',
    pressed: boolean,
  ): void => {
    controller.addEventListener(type, (event) => {
      if (busy()) return;
      const side = (event as unknown as { data?: XRInputSource }).data?.handedness;
      if (side !== 'left' && side !== 'right') return;
      actions.emit({
        type: 'combat-hand',
        hand: side === MAIN_HAND ? 'main' : 'off',
        control,
        pressed,
      });
    });
  };
  controller.addEventListener('select', (event) => {
    if (busy()) return;
    if (!ui?.visible) {
      if (floor && canOpenLoot() && xr.presenting) {
        const { origin, direction } = controllerRay(controller);
        activatePickup(
          origin,
          direction,
          (event as unknown as { data?: XRInputSource }).data?.handedness,
        );
      }
      return;
    }
    const side = (event as unknown as { data?: XRInputSource }).data?.handedness;
    if (side === 'right' && menuStick.owns(side)) {
      if (ui.radialInteractive) {
        const action = menuStick.confirm() ?? 'cancel';
        actions.emit({ type: 'select', controlId: `menu-${action}` });
      }
      return;
    }
    const hit = uiPointer.castFrom(controller, ui.targets());
    const id = hit ? ui.controlAt(hit.object) : null;
    if (!id) return;
    rewardHand = renderer.xr.getControllerGrip(index);
    actions.emit({ type: 'select', controlId: id });
    rewardHand = null;
  });
  // Exploring, a squeeze with the hand at the card waiting over an open coffer grabs it.
  controller.addEventListener('squeezestart', (event) => {
    if (busy()) return;
    const side = (event as unknown as { data?: XRInputSource }).data?.handedness;
    if (!xr.presenting || (side !== 'left' && side !== 'right') || !canOpenLoot() || !floor) return;
    const hand = xr.grips()[side];
    if (!hand) return;
    const position = hand.getWorldPosition(new THREE.Vector3());
    const note = floor.notes?.near(position, GRAB_REACH)[0];
    if (note) {
      flow.collectPressureNote(note.room, note.id);
      return;
    }
    if (floor.brassKeyStand?.near(position, GRAB_REACH) && takeBrassKey()) return;
    const brassLock = floor.loot.nearBrassLock(position, GRAB_REACH);
    if (brassLock && tryBrassLock(brassLock.room, brassLock.socketId)) return;
    const office = floor.office?.near(position, GRAB_REACH);
    if (office && operateCommission(office)) return;
    const cal = floor.calibrationBench?.near(position, GRAB_REACH);
    if (cal && operateCalibration(cal)) return;
    const folio = floor.chartCabinet?.near(position, GRAB_REACH);
    if (folio && readFolio(folio)) return;
    const panel = floor.panels?.near(position, GRAB_REACH);
    if (panel && operatePanel(panel, side)) return;
    const archive = floor.archive?.near(position, GRAB_REACH);
    if (archive && operateArchive(archive.action)) return;
    const evidence = floor.formulaEvidence?.near(position, GRAB_REACH);
    if (evidence && inspectFormula(evidence.clue)) return;
    const clock = floor.clock?.near(position, GRAB_REACH);
    if (clock && flow.collectIngredient(clock.ingredient)) return;
    const brew = floor.alchemy?.near(position, GRAB_REACH);
    if (brew && operateAlchemy(brew)) return;
    const weight =
      floor.counterweight?.room === floor.world.current
        ? floor.counterweight.near(position, GRAB_REACH)
        : null;
    if (weight && operateWeight(weight)) return;
    const chime = floor.chimes?.near(position, GRAB_REACH);
    if (chime && operateChimes(chime)) return;
    const book = floor.book.near(position, GRAB_REACH);
    if (book) {
      openBook(book);
      return;
    }
    const machine = floor.pressure?.near(position, GRAB_REACH);
    if (floor.pressure && machine?.action === 'open') {
      // A nearby grip can physically pull the badge; the laser offers the same action at a distance.
      pullMark = { side, hand, start: floor.pressure.pump.worldToLocal(position) };
      return;
    }
    if (machine) {
      operateMachine(machine, side);
      return;
    }
    grabLootCard(hand);
  });
  bind('squeezestart', 'squeeze', true);
  controller.addEventListener('squeezeend', (event) => {
    if (
      pullMark &&
      (event as unknown as { data?: XRInputSource }).data?.handedness === pullMark.side
    )
      pullMark = null;
  });
  bind('squeezeend', 'squeeze', false);
  bind('selectstart', 'trigger', true);
  bind('selectend', 'trigger', false);
}
const xrHands = (): XrHands => {
  const grips = xr.grips();
  return { main: grips[MAIN_HAND], mainRay: xr.rays()[MAIN_HAND], off: grips[OFF_HAND] };
};

// Scripted-check handle: `?debug` exposes the session and a projection for pointer automation.
if (floor && params.has('debug')) {
  const screenOf = (kind: CombatPick, key?: number | string, u?: number, v?: number) => {
    const point = combat?.session?.worldOf(kind, key, u, v);
    if (!point) return null;
    camera.updateMatrixWorld(true);
    point.project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((point.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - point.y) / 2) * rect.height,
    };
  };
  /**
   * Moves the rig 1 m south of the first live automaton, facing north at it, to start that fight.
   * A room number picks that room's fight (guardian included); otherwise the first uncleared
   * room that is not the guardian's (regular or elite), or the guardian's with `{ guardian: true }`.
   */
  const teleportToEncounter = (opts: { guardian?: boolean } | number = {}): number | null => {
    const target = floor;
    if (!target) return null;
    const only = typeof opts === 'number' ? opts : null;
    const guardian = typeof opts === 'number' ? false : (opts.guardian ?? false);
    for (const [room, bodies] of target.world.enemies) {
      const body = bodies.find((b) => b.parent !== null);
      if (!body || target.encounter.isCleared(room)) continue;
      if (only !== null ? room !== only : (room === target.world.plan.guardianRoom) !== guardian)
        continue;
      const at = body.getWorldPosition(new THREE.Vector3());
      rig.position.set(at.x, rig.position.y, at.z + 1);
      walker.yaw = 0;
      return room;
    }
    return null;
  };
  /** Where a scripted approach stands facing the first unopened coffer (or `room`'s), or null. */
  const lootStand = (
    room?: number,
  ): { x: number; z: number; yaw: number; coffer: string } | null => {
    const target = floor;
    if (!target) return null;
    const coffer = target.loot.coffers.find(
      (c) =>
        !c.opened &&
        (room === undefined
          ? target.world.plan.rooms[c.room]?.role === 'treasure'
          : c.room === room),
    );
    const at = coffer ? target.loot.approachPoint(coffer.room, coffer.socketId) : null;
    if (!coffer || !at) return null;
    const there = coffer.object.getWorldPosition(new THREE.Vector3());
    const yaw = (Math.atan2(there.x - at.x, -(there.z - at.z)) * 180) / Math.PI;
    return { x: at.x, z: at.z, yaw, coffer: coffer.object.name };
  };
  /** Where a scripted approach stands facing the first unused hearth (or `room`'s), or null. */
  const hearthStand = (
    room?: number,
  ): { x: number; z: number; yaw: number; hearth: string } | null => {
    const target = floor;
    if (!target) return null;
    const lit = target.hearth.hearths.find(
      (h) => !h.used && (room === undefined || h.room === room),
    );
    const at = lit ? target.hearth.approachPoint(lit.room, lit.socketId) : null;
    if (!lit || !at) return null;
    const there = lit.object.getWorldPosition(new THREE.Vector3());
    const yaw = (Math.atan2(there.x - at.x, -(there.z - at.z)) * 180) / Math.PI;
    return { x: at.x, z: at.z, yaw, hearth: lit.object.name };
  };
  /** Screen point `lift` m above a coffer's or hearth's base, for pointer automation, or null when it is behind the view. */
  const screenOfCoffer = (name: string, lift = 0.3) => {
    const node = floor?.world.group.getObjectByName(name);
    if (!node) return null;
    const p = node.getWorldPosition(new THREE.Vector3());
    p.y += lift;
    camera.updateMatrixWorld(true);
    p.project(camera);
    if (p.z > 1) return null;
    const rect = renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((p.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - p.y) / 2) * rect.height,
    };
  };
  Object.assign(window, {
    __combat: {
      get stairTransition() {
        return { phase: stairTransit.phase, opacity: stairTransit.opacity };
      },
      /** Moves the rig to a spot facing the first unopened coffer (or `room`'s), as the walk does for fights. */
      teleportToLoot(room?: number) {
        const stand = lootStand(room);
        if (!stand) return null;
        rig.position.set(stand.x, rig.position.y, stand.z);
        walker.yaw = stand.yaw;
        return stand.coffer;
      },
      screenOfCoffer,
      /** Screen point of the card waiting over the coffer `name`, for a claim click, or null. */
      screenOfLootCard(name: string) {
        const node = floor?.world.group.getObjectByName(name)?.getObjectByName('coffer-card');
        return node?.parent ? screenOfCoffer(name, node.position.y) : null;
      },
      /**
       * Lowers the live phase-1 guardian to `margin` hp (default 1) above its phase-2 threshold, so
       * the next card that damages it crosses the threshold through the rules' own `checkPhase`.
       * Never raises hp, and flips no flag. Returns the new hp and the threshold, or null when no
       * fight is live or no enemy with a phase 2 is in phase 1.
       */
      setGuardianNearPhaseTwo(margin = 1) {
        const controller = combat?.session?.controller;
        const enemy = controller?.state.enemies.find(
          (e) => e.phaseTwo && e.phase === 1 && e.hp > 0,
        );
        if (!controller || !enemy?.phaseTwo) return null;
        const threshold = enemy.maxHp * enemy.phaseTwo.hpFraction;
        const hp = Math.min(enemy.hp, Math.floor(threshold) + Math.max(1, Math.floor(margin)));
        controller.state = {
          ...controller.state,
          enemies: controller.state.enemies.map((e) => (e.id === enemy.id ? { ...e, hp } : e)),
        };
        return { id: enemy.id, hp, maxHp: enemy.maxHp, threshold };
      },
      /** Moves the rig to a spot facing the first unused hearth (or `room`'s). Returns its node name, or null. */
      teleportToHearth(room?: number) {
        const stand = hearthStand(room);
        if (!stand) return null;
        rig.position.set(stand.x, rig.position.y, stand.z);
        walker.yaw = stand.yaw;
        return stand.hearth;
      },
      get session() {
        return combat?.session ?? null;
      },
      /** The floor's audio director, for reading its state and music request. */
      get audio() {
        return audio;
      },
      get banner() {
        return combat?.banner ?? '';
      },
      get floor() {
        return floor;
      },
      camera,
      screenOf,
      /** Stand beside a service slip, facing it, for a seeded exploration walk. */
      teleportToNote(id: Parameters<RunFlow['collectPressureNote']>[1]) {
        const note = floor?.notes?.placements.find((p) => p.id === id);
        if (!floor || !note) return null;
        const at = note.location;
        const room = floor.world.rooms[note.room];
        const cx = (room.footprint.min[0] + room.footprint.max[0]) / 2,
          cz = (room.footprint.min[1] + room.footprint.max[1]) / 2;
        const dir = new THREE.Vector3(cx - at.x, 0, cz - at.z);
        if (dir.lengthSq() < 0.01) dir.set(0, 0, 1);
        dir.normalize();
        for (const angle of [0, Math.PI / 2, -Math.PI / 2, Math.PI]) {
          const side = dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
          const x = at.x + side.x * 1.8,
            z = at.z + side.z * 1.8;
          if (
            x < room.footprint.min[0] + 0.25 ||
            x > room.footprint.max[0] - 0.25 ||
            z < room.footprint.min[1] + 0.25 ||
            z > room.footprint.max[1] - 0.25
          )
            continue;
          if (
            floor.world.colliders[note.room].some(
              (b) =>
                x > b.min[0] - 0.18 &&
                x < b.max[0] + 0.18 &&
                z > b.min[2] - 0.18 &&
                z < b.max[2] + 0.18,
            )
          )
            continue;
          rig.position.set(x, rig.position.y, z);
          walker.yaw = (Math.atan2(at.x - x, -(at.z - z)) * 180) / Math.PI;
          floor.world.update(x, z);
          return note.room;
        }
        return null;
      },
      teleportToPressure(place: 'entrance' | 'gallery' | 'pump') {
        const works = floor?.pressure;
        if (!works || !floor) return null;
        const fixture = works[place];
        const offset = place === 'gallery' ? 1.25 : place === 'pump' ? 2.38 : 2.6;
        const at = fixture.localToWorld(new THREE.Vector3(place === 'pump' ? 0.24 : 0, 0, offset));
        const target = fixture.getWorldPosition(new THREE.Vector3());
        rig.position.set(at.x, rig.position.y, at.z);
        walker.yaw = (Math.atan2(target.x - at.x, -(target.z - at.z)) * 180) / Math.PI;
        floor.world.update(at.x, at.z);
        return floor.world.current;
      },
      teleportToEncounter,
      hitFx,
      locomotion,
      drive,
      comfortVignette,
      teleportView,
      heroReady,
      /** Draw calls and triangles of the last scene pass (before the board pass). */
      get stats() {
        return { ...sceneStats };
      },
    },
    __flow: {
      flow,
      ui,
      setCheat(next: 'win' | 'lose' | null) {
        cheat = next;
      },
      /** Screen point of a board control, for pointer automation. */
      screenOfControl(controlId: string) {
        const radialNames: Record<string, string> = {
          'menu-settings': 'radial-menu-settings',
          'menu-deck': 'radial-menu-deck',
          'menu-items': 'radial-menu-items',
          'menu-cancel': 'radial-menu-cancel',
          'menu-resume': 'radial-menu-cancel',
        };
        const node = ui?.root.getObjectByName(radialNames[controlId] ?? controlId);
        if (!node) return null;
        const p = node.getWorldPosition(new THREE.Vector3());
        camera.updateMatrixWorld(true);
        p.project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        return {
          x: rect.left + ((p.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - p.y) / 2) * rect.height,
        };
      },
      flushed: () => persistence?.flushed() ?? Promise.resolve(),
    },
  });
}

actions.on('new-run', ({ seed }) => {
  if (flow.phase === 'title') {
    startRun(seed ?? ui?.seed ?? randomSeed(), settings?.difficulty ?? DEFAULT_DIFFICULTY);
  }
});

const enterButton = document.createElement('button');
enterButton.id = 'enter-vr';
enterButton.textContent = 'Enter VR';
enterButton.disabled = true;
Object.assign(enterButton.style, {
  position: 'fixed',
  bottom: '24px',
  left: '50%',
  transform: 'translateX(-50%)',
  padding: '12px 28px',
  font: '600 16px system-ui, sans-serif',
  color: PALETTE.void,
  background: PALETTE.brass,
  border: 'none',
  borderRadius: '6px',
});
enterButton.addEventListener('click', () => {
  // Resume audio inside the click, before requestSession: window gestures stop once immersive.
  if (busy()) return;
  audio?.unlock('enter-vr');
  void xr.enter();
});
app.append(enterButton);
if (proofView) enterButton.hidden = true;
let vrSupported = false;
void xr.supported().then((ok) => {
  vrSupported = ok;
  enterButton.disabled = busy() || !ok;
  if (!ok) enterButton.textContent = 'VR not available';
});
// `?debug` keeps every card release as a replay trace (P3-T3) and offers them as one JSON download
// outside the headset session, for `tests/fixtures/fling/recorded/`.
const traceButton = document.createElement('button');
traceButton.id = 'fling-trace-download';
Object.assign(traceButton.style, {
  position: 'fixed',
  bottom: '24px',
  right: '24px',
  padding: '10px 18px',
  font: '600 14px system-ui, sans-serif',
  color: PALETTE.void,
  background: PALETTE.candle,
  border: 'none',
  borderRadius: '6px',
  display: 'none',
});
traceButton.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([flingTraceLog.toJson()], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `fling-traces-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
let traceCount = -1;
const syncTraceButton = (inXr: boolean): void => {
  const n = flingTraceLog.traces.length;
  if (n !== traceCount) {
    traceCount = n;
    traceButton.textContent = `Download ${n} fling trace${n === 1 ? '' : 's'}`;
  }
  traceButton.style.display = !inXr && n > 0 ? '' : 'none';
};
if (showDebugHud) {
  flingTraceLog.enabled = true;
  app.append(traceButton);
}
actions.on('enter-xr', () => {
  enterButton.style.display = 'none';
  syncTraceButton(true);
  camera.position.set(0, 0, 0);
  recenterPending = true;
});
actions.on('exit-xr', () => {
  enterButton.style.display = '';
  syncTraceButton(false);
  camera.position.set(0, 1.6, 0);
  rig.position.y = locomotion.standingFloorY;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const sceneStats = { calls: 0, triangles: 0 };
let framedSession: unknown = null;
let framedAspect = 0;
const loadingScene = new THREE.Scene();
loadingScene.background = new THREE.Color(PALETTE.void);
let loadingLabel: CanvasLabel | undefined;
const timer = new THREE.Timer();
const desktopEyes = [camera];
renderer.setAnimationLoop((time, frame) => {
  perf.frame(null, time);
  timer.update(time);
  const deltaSeconds = Math.min(timer.getDelta(), 0.1);
  if (titleReset) {
    // Rebuilt between frames: Return to title fires inside the board's input handling.
    titleReset = false;
    const target = freshFloor(ui?.seed ?? randomSeed());
    const spawn = target.world.spawnPoint();
    rig.position.set(spawn.x, rig.position.y, spawn.z);
    floorUsed = false;
    // The title board was placed before the move: re-place it in front of the moved head.
    rig.updateMatrixWorld(true);
    ui?.recenter(camera);
  }
  stairTransit.update(deltaSeconds, floor === readyFloor || loadingFailed);
  if (floor && floor !== readyFloor) {
    if (stairTransit.phase === 'loading' && !loadingFailed) {
      stairFade.render(renderer, camera, 1);
      return;
    }
    if (xr.presenting) {
      loadingLabel ??= new CanvasLabel(768, 128, 0.85);
      const message = loadingFailed ? 'Load failed · Exit VR to retry' : 'Loading the tower…';
      if (loadingLabel.mesh.userData.message !== message) {
        loadingLabel.mesh.userData.message = message;
        loadingLabel.draw((ctx, w, h) => {
          ctx.font = '46px Georgia, serif';
          ctx.fillStyle = PALETTE.parchment;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(message, w / 2, h / 2);
        });
        loadingScene.add(loadingLabel.mesh);
      }
      camera.getWorldQuaternion(loadingLabel.mesh.quaternion);
      camera.getWorldPosition(loadingLabel.mesh.position);
      loadingLabel.mesh.translateZ(-1.4);
      renderer.render(loadingScene, camera);
    }
    return;
  }
  if (xr.presenting) {
    xr.update(deltaSeconds, frame);
    if (floor)
      locomotion.setWorld(
        floor.world.nearbyColliders(),
        floor.world.nearbyWalkable(),
        0,
        floor.world.teleportSurfaceHeight,
      );
    if (recenterPending && frame) {
      locomotion.recenter();
      recenterPending = false;
      // A board up at Enter VR (the title) still holds its desktop placement, which can sit
      // behind a player who entered facing elsewhere.
      ui?.recenter(camera);
    }
    if (menuEdge.step(xr.buttonPressed(MENU_BUTTON.side, MENU_BUTTON.index))) toggleMenu();
    const { left, right } = xr.sticks();
    // Locomotion reports +Y forward; the shared radial uses WebXR's raw -Y for up.
    menuStick.update('right', { x: right[0], y: -right[1], pressed: xr.buttonPressed('right', 3) });
    if (menuStick.active) releaseMenuStick = true;
    else if (Math.hypot(...right) < 0.2) releaseMenuStick = false;
    const aimSource = xr.rays().right;
    const aimRay = aimSource ? controllerRay(aimSource) : null;
    drive.step({
      dt: deltaSeconds,
      left,
      right: releaseMenuStick ? [0, 0] : right,
      rightRay: aimRay
        ? {
            origin: [aimRay.origin.x, aimRay.origin.y, aimRay.origin.z],
            direction: [aimRay.direction.x, aimRay.direction.y, aimRay.direction.z],
          }
        : null,
      locked: stairTransit.phase !== 'idle' || (floor?.locked ?? false),
      boardVisible: ui?.visible ?? false,
    });
  } else {
    const pose = floor?.encounter.tablePose;
    const fighting = floor?.encounter.phase === 'unfolding' || floor?.encounter.phase === 'active';
    if (fighting && pose) {
      const eye = camera.getWorldPosition(new THREE.Vector3());
      const ahead = Math.hypot(pose.x - eye.x, pose.z - eye.z);
      // Walls can push the table off the player's heading, and the walker cannot turn mid-fight,
      // so the desktop view turns to the table as the fight opens.
      if (desktop.frameCombat(combatPitch(ahead, eye.y - pose.height, camera.fov))) {
        walker.yaw = pose.yaw;
      }
      // Once the HUD exists, fit the tray, plate and automatons (wider fov if the table is close).
      const session = combat?.session;
      if (session && (framedSession !== session || framedAspect !== camera.aspect)) {
        framedSession = session;
        framedAspect = camera.aspect;
        const { must, want, floor: handFloor } = session.framingPoints();
        desktop.refineCombat(
          fitCombatFraming({
            eye,
            headingDeg: pose.yaw,
            aspect: camera.aspect,
            baseFov: desktop.baseFov,
            must,
            want,
            floor: handFloor,
          }),
        );
      }
    } else {
      desktop.frameCombat(null);
      framedSession = null;
    }
    desktop.update();
    walker.enabled = !floor?.locked && !ui?.visible && stairTransit.phase === 'idle';
    walker.update(deltaSeconds, locomotion.standingFloorY);
  }
  camera.getWorldPosition(standingAt);
  locomotion.followGround(
    standingAt.x,
    standingAt.z,
    floor?.world.stairGroundHeight(standingAt.x, standingAt.z) ?? 0,
  );
  cardProof?.update(time / 1000, xr.presenting);
  // The in-run menu pauses the floor and the fight: no triggers, no encounter clock, no session.
  if (xr.presenting) renderer.xr.updateCamera(camera);
  else camera.updateWorldMatrix(true, false);
  advanceMusicBox(deltaSeconds);
  const paused = stairTransit.phase !== 'idle' || (ui?.menuOpen ?? false);
  if (floor) floor.suspendTriggers = flow.phase !== 'explore' || paused;
  floor?.update(
    camera,
    paused ? 0 : deltaSeconds,
    xr.presenting ? renderer.xr.getCamera().cameras : desktopEyes,
  );
  if (floor && flow.inRun) {
    flow.enterRoom(floor.world.current);
    perfRoom(floor.world);
    if (encounterStartsFight(floor.encounter.phase, flow.phase)) {
      flow.fightStarted(floor.encounter.activeRoom);
    }
  }
  if (combat) combat.paused = paused;
  combat?.update(deltaSeconds, xr.presenting ? xrHands() : null);
  // The XR layout is the 3D table's; only the desktop view slides the HUD into frame.
  if (xr.presenting) combat?.session?.resetHud();
  else combat?.session?.fitHudToView(camera);
  ui?.sync(camera);
  ui?.update(deltaSeconds);
  const laserHits = { left: null as number | null, right: null as number | null };
  if (xr.presenting && combat?.session && !ui?.visible) {
    const rays = xr.rays();
    for (const side of ['left', 'right'] as const) {
      const source = rays[side];
      if (!source) continue;
      source.updateWorldMatrix(true, false);
      combatLaserRay.origin.setFromMatrixPosition(source.matrixWorld);
      combatLaserRay.direction.set(0, 0, -1).transformDirection(source.matrixWorld);
      laserHits[side] = combat.session.rayDistance(combatLaserRay);
    }
    const status = combat.session.statusHover?.distance;
    if (status !== undefined)
      laserHits[MAIN_HAND] = Math.min(laserHits[MAIN_HAND] ?? Infinity, status);
  }
  if (ui?.visible && xr.presenting) {
    const ray = xr.rays()[MAIN_HAND];
    const hit = ray ? uiPointer.castFrom(ray, ui.targets()) : null;
    if (!menuStick.active) {
      ui.hover(hit ? ui.controlAt(hit.object) : null);
      laserHits[MAIN_HAND] = hit ? hit.distance : null;
    }
  }
  if (pullMark) {
    if (!xr.presenting || !canOpenLoot() || !floor?.pressure) pullMark = null;
    else {
      pullMark.hand.getWorldPosition(pullPoint);
      const before = pullMark.start;
      const now = floor.pressure.pump.worldToLocal(pullPoint);
      if (now.z - before.z >= 0.085) {
        const hand = pullMark.side;
        pullMark = null;
        operateMachine({ action: 'open', distance: 0 }, hand);
      }
    }
  }
  if (floor && xr.presenting && canOpenLoot()) {
    // The beam ends on a coffer it can open.
    for (const side of ['left', 'right'] as const) {
      const source = xr.rays()[side];
      if (!source) continue;
      const { origin, direction } = controllerRay(source);
      const distance = pickupDistance(origin, direction);
      if (distance !== null)
        laserHits[side] =
          laserHits[side] === null ? distance : Math.min(laserHits[side] as number, distance);
    }
  }
  if (floor && audio) {
    const fighting = floor.encounter.phase !== 'idle';
    audio.setState(
      audioStateForFlow(flow.phase, floor.encounter.phase, {
        tier: fighting ? fightTier(floor, floor.encounter.activeRoom) : null,
        room: floor.world.plan.rooms[floor.world.current]?.role ?? null,
      }),
    );
    audio.update(deltaSeconds);
  }
  const preview = xr.presenting ? locomotion.teleportPreview : null;
  const mark = preview?.landing;
  teleportView.update(
    preview,
    !!mark && floor?.world.teleportSurfaceHeight(mark[0], mark[2]) != null,
  );
  renderer.render(scene, camera);
  sceneStats.calls = renderer.info.render.calls;
  sceneStats.triangles = renderer.info.render.triangles;
  if (ui?.visible) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(uiScene, camera);
    renderer.autoClear = true;
  }
  // Comfort vignette, then the red hit flash on top of it, so the two stack.
  comfortVignette.update(
    xr.presenting
      ? Math.max(
          locomotion.vignetteStrength,
          locomotion.settings.vignette ? (floor?.turnVignette ?? 0) : 0,
        )
      : 0,
    camera,
    xr.presenting ? projectionTan(renderer.xr.getCamera().projectionMatrix) : viewTan(camera),
    xr.presenting,
  );
  if (comfortVignette.active) {
    renderer.autoClear = false;
    renderer.render(comfortVignette.scene, camera);
    renderer.autoClear = true;
  }
  hitFx.update(
    deltaSeconds,
    camera,
    xr.presenting ? projectionTan(renderer.xr.getCamera().projectionMatrix) : viewTan(camera),
    xr.presenting,
  );
  if (hitFx.active) {
    renderer.autoClear = false;
    renderer.render(hitFx.scene, camera);
    renderer.autoClear = true;
  }
  if (xr.presenting) {
    renderer.autoClear = false;
    renderer.render(noticeScene, camera);
    renderer.render(xr.updateLasers(laserHits), camera);
    renderer.autoClear = true;
  }
  stairFade.render(renderer, camera, stairTransit.opacity);
  if (floor && showDebugHud && !xr.presenting) {
    const room = floor.world.plan.rooms[floor.world.current];
    const fight = floor.encounter.phase === 'idle' ? '' : ` · encounter ${floor.encounter.phase}`;
    const session = combat?.session;
    const combatLines = session
      ? `\n${session.hudText()}\n${session.log.slice(-4).join('\n')}\nClick a card to pick it up, click again to use it (at an enemy) · right click puts it back · draw on the plate · T throw dice · E end turn · F twice flee · Esc menu`
      : '';
    syncTraceButton(renderer.xr.isPresenting);
    hud.textContent = `seed ${floor.seed} · room ${floor.world.current} ${room?.templateId} (${room?.role}) · calls ${renderer.info.render.calls}${fight}${audio ? `\n${audio.statusLine}` : ''}${combatLines}`;
  }
  if (floor) {
    const text = combat?.banner ?? '';
    banner.textContent = text;
    // A flow board (reward, death, victory) replaces the fight banner, never sits under it.
    banner.style.display = text && !xr.presenting && !ui?.visible ? '' : 'none';
  }
  if (covered && (!floor || floor === readyFloor)) {
    revealGame();
    covered = false;
    enterButton.disabled = !vrSupported;
  }
});
