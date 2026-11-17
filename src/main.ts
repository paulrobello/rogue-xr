import { createPointer } from '@par/xr-workspace';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { audioStateForFlow } from './audio/cues.ts';
import { AudioDirector } from './audio/index.ts';
import { mountCardProof } from './cards/card-proof.ts';
import { CombatHook, type CombatPick, type XrHands } from './combat/combat-session.ts';
import {
  bindTableMaterials,
  mountTableAssetProof,
  parseTableAssetManifest,
  TABLE_ASSET_BASE,
} from './combat/table-asset-proof.ts';
import {
  HitFeedback,
  hapticFor,
  projectionTan,
  pulseHaptics,
  viewTan,
} from './combat-view/hit-feedback.ts';
import { mountCombatDebugView } from './combat-view/index.ts';
import { STARTER_DECK } from './content/cards.ts';
import { ENEMIES } from './content/enemies.ts';
import { REWARD_POOL } from './content/rewards.ts';
import { ActionBus } from './core/actions.ts';
import { randomSeed } from './core/rng.ts';
import { fitCombatFraming } from './desktop/combat-framing.ts';
import { combatPitch, createDesktopControls } from './desktop/controls.ts';
import { Walker } from './desktop/walker.ts';
import { type EnemyActor, type EnemyAsset, tryLoadEnemyAsset } from './enemies/enemy-asset.ts';
import { RunFlow } from './flow/flow.ts';
import { FlowUi, rewardCardTexture } from './flow/panels.ts';
import { bindFlowPersistence } from './flow/persist.ts';
import { RewardCardFaces } from './flow/reward-cards.ts';
import { HOLO_CARD_ASPECT } from './hand/fan-layout.ts';
import { flingTraceLog } from './hand/fling-trace.ts';
import { PALETTE } from './palette.ts';
import { foveationValue, mountPerf } from './perf/index.ts';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  openDb,
  type Settings,
  saveSettings,
} from './persist/db.ts';
import { loadRunSnapshot, loadWorkshop, type RunSnapshot } from './persist/saves.ts';
import {
  DEFAULT_DIFFICULTY,
  type Difficulty,
  isDifficulty,
  runDifficulty,
} from './rules/difficulty.ts';
import { parseLootKey, type RewardTier } from './rules/run.ts';
import { createWorkshop } from './rules/workshop.ts';
import { mountUpdateNotice } from './update/index.ts';
import { type FloorView, mountFloorView, seedFromQuery } from './world/floor-view.ts';
import type { HearthPick } from './world/hearth.ts';
import { dressHeroRooms, fetchHeroRooms, loadHeroAssets } from './world/hero-rooms.ts';
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
import { mountRoomAssetProof } from './world/room-asset-proof.ts';
import {
  fetchStudyManifest,
  HERO_ROOMS,
  loadStudyAsset,
  type StudyAsset,
} from './world/study-room.ts';
import { runVeil } from './world/veil.ts';
import { ComfortVignette } from './xr/comfort-vignette.ts';
import { Locomotion, locomotionSettingsFrom } from './xr/locomotion.ts';
import { LocomotionDrive } from './xr/locomotion-drive.ts';
import { createXrRig } from './xr/session.ts';
import { TeleportView } from './xr/teleport-view.ts';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root');

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

const scene = new THREE.Scene();
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
const db = playMode ? await openDb() : null;
const workshop = db ? await loadWorkshop(db).catch(() => createWorkshop()) : createWorkshop();
let storedSnapshot: RunSnapshot | null = db ? await loadRunSnapshot(db).catch(() => null) : null;
let settings: Settings | null = db ? await loadSettings(db) : null;
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
const mountFloor = (seed: string): FloorView => {
  const view = mountFloorView(scene, rig, seed, { templates: worldTemplates });
  view.encounter.tableDistance = (settings ?? DEFAULT_SETTINGS).tableDistance;
  return view;
};
if (!proofView) floor = mountFloor(bootSeed);
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
// The in-scene notice gets its own pass after the boards, which clear depth and would cover it.
const noticeScene = new THREE.Scene();
mountUpdateNotice({ scene: noticeScene, renderer, xr, search: location.search });

// Audio: one director for the floor, resumed by the first gesture or the XR session start.
const audio = floor ? new AudioDirector({ camera }) : null;
if (audio) {
  scene.add(audio.root);
  if (settings) {
    audio.setVolumes({
      master: settings.masterVolume,
      music: settings.musicVolume,
      sfx: settings.sfxVolume,
    });
  }
  void audio.load();
  audio.unlockOnGesture(window);
  audio.unlockOnGesture(document, ['visibilitychange']);
  audio.unlockOnXrSession(renderer.xr);
}

// Player hit feedback: an edge flash drawn after the boards (desktop and both XR eyes) and a
// controller pulse in XR. Settings has no reduced-motion option, so the OS preference softens it.
const hitFx = new HitFeedback({
  reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
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
/** Ends the running fight outside the session (debug keys): same path as a decided fight. */
const endFight = (outcome: 'win' | 'flee'): void => {
  const target = floor;
  if (!target || target.encounter.phase === 'idle') return;
  const room = target.encounter.activeRoom;
  target.encounter.end(outcome);
  flow.fightEnded({ room, outcome, tier: fightTier(target, room) });
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
const tableAsset: Promise<{ scene: THREE.Object3D; top: number } | null> = floor
  ? (async () => {
      const manifest = parseTableAssetManifest(
        await (await fetch(`${TABLE_ASSET_BASE}/combat-table.manifest.json`)).json(),
      );
      const gltf = await new GLTFLoader().loadAsync(`${TABLE_ASSET_BASE}/${manifest.glb}`);
      await bindTableMaterials(gltf.scene, manifest, renderer).catch((error: unknown) =>
        console.warn('combat table materials fell back to factors', error),
      );
      reflect(gltf.scene, 0.45);
      return { scene: gltf.scene, top: manifest.authoredTopHeight };
    })().catch((error: unknown) => {
      console.warn('combat table asset unavailable, greybox kept', error);
      return null;
    })
  : Promise.resolve(null);
let tableUses = 0;
const fitTable = (target: FloorView): void => {
  void tableAsset.then((asset) => {
    if (!asset || target !== floor) return;
    target.useTableAsset(tableUses++ === 0 ? asset.scene : asset.scene.clone(true), asset.top);
  });
};
if (floor) fitTable(floor);

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
const roomAssets: Promise<StudyAsset[]> = heroSet
  ? heroSet
      .then(({ ktx2, set }) =>
        loadHeroAssets(heroRooms.manifests, (study) =>
          loadStudyAsset({ study, set, ktx2, envMap: heroEnv }),
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
// One fetch per enemy kind for the session, whatever the floor count. A kind whose model is not
// shipped yet resolves null at once (one console.info) and keeps its capsules.
const enemyMaterials = heroSet?.then(({ set }) => set).catch(() => null) ?? null;
const enemyAssets = new Map<string, Promise<EnemyAsset | null>>(
  enemyMaterials
    ? Object.keys(ENEMIES).map((kind) => [
        kind,
        enemyMaterials.then((set) => (set ? tryLoadEnemyAsset(kind, { materials: set }) : null)),
      ])
    : [],
);
const loadedEnemies = async (): Promise<EnemyAsset[]> =>
  (await Promise.all(enemyAssets.values())).filter((a): a is EnemyAsset => a !== null);
const prepareEnemy = (actor: EnemyActor): void => reflect(actor.object, 0.45);
const dressFloor = async (target: FloorView): Promise<void> => {
  // Each model dresses its kind as soon as it lands, so a slow or broken one holds back no other.
  const dressed = [...enemyAssets.values()].map((pending) =>
    pending.then((asset) => {
      if (asset && target === floor)
        target.useEnemyAssets(new Map([[asset.id, asset]]), prepareEnemy);
    }),
  );
  const [rooms, door, coffers] = await Promise.all([roomAssets, sealedDoorMaterial, lootMaterials]);
  if (target === floor) {
    dressHeroRooms(target, rooms);
    if (door) target.world.dressSealedDoors(door.material, door.tileMeters);
    if (coffers) {
      target.loot.dress(coffers);
      target.hearth.dress({ brass: coffers.brass });
    }
  }
  await Promise.all(dressed);
};
/** Resolves once the boot floor wears its hero assets and their programs are compiled. */
const heroReady: Promise<void> = floor
  ? (async () => {
      const target = floor;
      await dressFloor(target);
      void heroSet?.then(({ ktx2 }) => ktx2.dispose());
      const [rooms, models] = await Promise.all([roomAssets, loadedEnemies()]);
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
      try {
        const textures = new Set(rooms.flatMap((room) => room.textures));
        await runVeil(renderer, scene, camera, [...textures], { variants });
      } finally {
        for (const actor of actors) actor.dispose();
      }
    })().catch((error: unknown) => console.warn('hero asset warm-up failed', error))
  : Promise.resolve();

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
flow.onChange((event) => {
  if (event.type === 'loot') {
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
        coffer.showCard(event.loot.card, chestCardFace(event.loot.card), true, camera);
        audio?.playSfx('gear-clank', at);
      }
    } else if (floor?.loot.open(event.room, event.socketId, event.loot)) {
      audio?.playSfx('gear-clank', at);
      audio?.playSfx('cog-pickup', at);
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
  if (event.type !== 'phase') return;
  if (event.to === 'explore' || event.to === 'reward') {
    storedSnapshot = flow.snapshot(Date.now(), floor?.world.current ?? flow.room);
  } else if (event.to === 'death' || event.to === 'victory') {
    storedSnapshot = null;
  }
  if (event.to === 'title' && (event.from === 'death' || event.from === 'victory'))
    titleReset = true;
});
/** Puts a pristine floor for `seed` under the player, rebuilding in place (no reload, XR stays up). */
const freshFloor = (seed: string): FloorView => {
  if (floor && floor.seed === seed && !floorUsed) return floor;
  combat?.dispose();
  floor?.dispose();
  floor = mountFloor(seed);
  combat = makeCombat(floor);
  fitTable(floor);
  void dressFloor(floor);
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
const continueRun = (): void => {
  const snap = storedSnapshot;
  if (!snap || flow.phase !== 'title') return;
  const target = freshFloor(snap.floorSeed);
  for (const room of snap.clearedEncounters) target.markCleared(Number(room));
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
  const at = target.standPoint(snap.roomIndex) ?? target.world.spawnPoint();
  rig.position.set(at.x, rig.position.y, at.z);
  target.world.update(at.x, at.z);
  floorUsed = true;
  flow.continueRun(snap);
};
const ui = floor
  ? new FlowUi({
      flow,
      keyArt: { url: '/assets/ui/title-2048.jpg', titleSafe: { x: 0.03, y: 0.3, w: 0.27, h: 0.4 } },
      seed: bootSeed,
      snapshot: () => storedSnapshot,
      settings: () => settings ?? { ...DEFAULT_SETTINGS },
      onNewRun: startRun,
      onContinue: continueRun,
      onSettings: (next) => {
        settings = next;
        audio?.setVolumes({
          master: next.masterVolume,
          music: next.musicVolume,
          sfx: next.sfxVolume,
        });
        Object.assign(locomotion.settings, locomotionSettingsFrom(next));
        if (floor) floor.encounter.tableDistance = next.tableDistance;
        xr.setFoveation(next.foveation);
        perf.setFoveation(foveationValue(next.foveation));
        if (db) void saveSettings(db, next);
      },
    })
  : null;
// The boards draw in their own pass over a cleared depth buffer, so the automatons and walls of the
// fight that just ended never hide the reward or summary in front of the player.
const uiScene = new THREE.Scene();
if (ui) uiScene.add(ui.root);
if (ui && directSeed) startRun(bootSeed, settings?.difficulty ?? DEFAULT_DIFFICULTY);
actions.on('select', ({ controlId }) => {
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
    event.stopPropagation();
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
  !!floor && flow.phase === 'explore' && floor.encounter.phase === 'idle' && !ui?.visible;
/** Opens the shut coffer, or claims the card waiting over an open one, that a pick found. */
const openCoffer = (pick: LootPick | null): boolean => {
  if (!pick || !canOpenLoot()) return false;
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
/** Opens the coffer or uses the hearth a ray reaches in the current room (a room holds only one kind). */
const activatePickup = (origin: THREE.Vector3, direction: THREE.Vector3): boolean =>
  !!floor &&
  (openCoffer(floor.loot.pick(origin, direction)) ||
    useHearth(floor.hearth.pick(origin, direction)));
/** How far a ray reaches a coffer or hearth it can act on, or null. */
const pickupDistance = (origin: THREE.Vector3, direction: THREE.Vector3): number | null => {
  if (!floor) return null;
  const near = [floor.loot.pick(origin, direction), floor.hearth.pick(origin, direction)].filter(
    (pick) => pick !== null,
  );
  return near.length === 0 ? null : Math.min(...near.map((pick) => pick.distance));
};
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
    if (activatePickup(origin, direction)) event.stopPropagation();
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
  if (!session || xr.presenting) return false;
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
window.addEventListener('keydown', (event) => {
  if (floor?.encounter.phase !== 'active' || event.repeat) return;
  if (event.code === 'KeyE') actions.emit({ type: 'end-turn' });
  else if (event.code === 'KeyT' || event.code === 'Space') actions.emit({ type: 'throw-dice' });
  else if (event.code === 'Escape') actions.emit({ type: 'combat-cancel' });
  // Debug resolutions, kept from the greybox phase.
  else if (event.code === 'KeyK') endFight('win');
  else if (event.code === 'KeyF') endFight('flee');
});

// XR combat verbs: main hand (right) squeeze grabs and flings, trigger draws, throws and presses.
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
  controller.addEventListener('select', () => {
    if (!ui?.visible) {
      if (floor && canOpenLoot() && xr.presenting) {
        const { origin, direction } = controllerRay(controller);
        activatePickup(origin, direction);
      }
      return;
    }
    const hit = uiPointer.castFrom(controller, ui.targets());
    const id = hit ? ui.controlAt(hit.object) : null;
    if (id) actions.emit({ type: 'select', controlId: id });
  });
  // Exploring, a squeeze with the hand at the card waiting over an open coffer grabs it.
  controller.addEventListener('squeezestart', (event) => {
    const side = (event as unknown as { data?: XRInputSource }).data?.handedness;
    if (xr.presenting && (side === 'left' || side === 'right')) grabLootCard(xr.grips()[side]);
  });
  bind('squeezestart', 'squeeze', true);
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
   * regular room, or the guardian's with `{ guardian: true }`.
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
      (c) => !c.opened && (room === undefined || c.room === room),
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
        const node = ui?.root.getObjectByName(controlId);
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
  audio?.unlock('enter-vr');
  void xr.enter();
});
app.append(enterButton);
if (proofView) enterButton.hidden = true;
void xr.supported().then((ok) => {
  enterButton.disabled = !ok;
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
  rig.position.y = 0;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const sceneStats = { calls: 0, triangles: 0 };
let framedSession: unknown = null;
let framedAspect = 0;
const timer = new THREE.Timer();
renderer.setAnimationLoop((time, frame) => {
  perf.frame(null, time);
  timer.update(time);
  const deltaSeconds = Math.min(timer.getDelta(), 0.1);
  if (xr.presenting) {
    xr.update(deltaSeconds, frame);
    if (floor) locomotion.setWorld(floor.world.nearbyColliders(), floor.world.nearbyWalkable());
    if (recenterPending && frame) {
      locomotion.recenter();
      recenterPending = false;
      // A board up at Enter VR (the title) still holds its desktop placement, which can sit
      // behind a player who entered facing elsewhere.
      ui?.recenter(camera);
    }
    const { left, right } = xr.sticks();
    const aimSource = xr.rays().right;
    const aimRay = aimSource ? controllerRay(aimSource) : null;
    drive.step({
      dt: deltaSeconds,
      left,
      right,
      rightRay: aimRay
        ? {
            origin: [aimRay.origin.x, aimRay.origin.y, aimRay.origin.z],
            direction: [aimRay.direction.x, aimRay.direction.y, aimRay.direction.z],
          }
        : null,
      locked: floor?.locked ?? false,
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
    walker.enabled = !floor?.locked && !ui?.visible;
    walker.update(deltaSeconds);
  }
  cardProof?.update(time / 1000, xr.presenting);
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
  if (floor) floor.suspendTriggers = flow.phase !== 'explore';
  floor?.update(camera, deltaSeconds);
  if (floor && flow.inRun) {
    flow.enterRoom(floor.world.current);
    if (floor.encounter.phase !== 'idle' && flow.phase === 'explore') {
      flow.fightStarted(floor.encounter.activeRoom);
    }
  }
  combat?.update(deltaSeconds, xr.presenting ? xrHands() : null);
  // The XR layout is the 3D table's; only the desktop view slides the HUD into frame.
  if (xr.presenting) combat?.session?.resetHud();
  else combat?.session?.fitHudToView(camera);
  ui?.sync(camera);
  const laserHits = { left: null as number | null, right: null as number | null };
  // The beam ends on the status badge whose explanation it is showing.
  const statusAt = xr.presenting ? combat?.session?.statusHover?.distance : undefined;
  if (statusAt !== undefined) laserHits[MAIN_HAND] = statusAt;
  if (ui?.visible && xr.presenting) {
    const ray = xr.rays()[MAIN_HAND];
    const hit = ray ? uiPointer.castFrom(ray, ui.targets()) : null;
    ui.hover(hit ? ui.controlAt(hit.object) : null);
    laserHits[MAIN_HAND] = hit ? hit.distance : null;
  }
  if (floor && xr.presenting && canOpenLoot()) {
    // The beam ends on a coffer it can open.
    for (const side of ['left', 'right'] as const) {
      const source = xr.rays()[side];
      if (!source) continue;
      const { origin, direction } = controllerRay(source);
      const distance = pickupDistance(origin, direction);
      if (distance !== null) laserHits[side] = distance;
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
  teleportView.update(xr.presenting ? locomotion.teleportPreview : null);
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
  if (floor && showDebugHud && !xr.presenting) {
    const room = floor.world.plan.rooms[floor.world.current];
    const fight = floor.encounter.phase === 'idle' ? '' : ` · encounter ${floor.encounter.phase}`;
    const session = combat?.session;
    const combatLines = session
      ? `\n${session.hudText()}\n${session.log.slice(-4).join('\n')}\nDrag a card at an enemy or onto the table · draw on the plate · T throw dice · E end turn · Esc cancel`
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
});
