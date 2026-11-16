import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AudioDirector } from './audio/index.ts';
import { mountCardProof } from './cards/card-proof.ts';
import { CombatHook, type CombatPick, type XrHands } from './combat/combat-session.ts';
import {
  bindTableMaterials,
  mountTableAssetProof,
  parseTableAssetManifest,
  TABLE_ASSET_BASE,
} from './combat/table-asset-proof.ts';
import { mountCombatDebugView } from './combat-view/index.ts';
import { ActionBus } from './core/actions.ts';
import { createDesktopControls } from './desktop/controls.ts';
import { mountSeedTitle } from './desktop/seed-title.ts';
import { Walker } from './desktop/walker.ts';
import { PALETTE } from './palette.ts';
import { mountPerf } from './perf/index.ts';
import { type FloorView, mountFloorView, seedFromQuery } from './world/floor-view.ts';
import { mountLightmapProof } from './world/lightmap-proof.ts';
import { mountMaterialProof } from './world/material-proof.ts';
import { mountRoomAssetProof } from './world/room-asset-proof.ts';
import { Locomotion } from './xr/locomotion.ts';
import { createXrRig } from './xr/session.ts';

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
} else {
  floor = mountFloorView(scene, rig, seedFromQuery(location.search));
}

// Debug readout: seed, current room, the last frame's draw calls (Quest budget: under 200) and,
// in a fight, the combat stage and log.
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
if (floor) app.append(hud);
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
const xr = createXrRig(renderer, scene, rig, camera, actions);
const desktop = createDesktopControls(camera, renderer.domElement, actions);
const walker = new Walker(rig, actions, () => floor?.world.nearbyColliders() ?? []);
const locomotion = new Locomotion(rig, camera);
// Head pose is only known once frames arrive, so height calibration waits for the first XR frame.
let recenterPending = false;
actions.on('recenter', () => {
  recenterPending = true;
});
const perf = mountPerf(renderer, scene, rig, { camera });
if (floor) mountSeedTitle(app, floor.seed, actions);

// Audio: one director for the floor, resumed by the first gesture or the XR session start.
const audio = floor ? new AudioDirector({ camera }) : null;
if (audio) {
  scene.add(audio.root);
  void audio.load();
  audio.unlockOnGesture(window);
  audio.unlockOnXrSession(renderer.xr);
}

// Real combat on the floor: a session opens when an encounter goes active.
const cheat = params.get('cheat');
const combat = floor
  ? new CombatHook({
      floor,
      camera,
      actions,
      ...(audio ? { audio } : {}),
      ...(cheat === 'win' ? { options: { enemyHp: 1 } } : {}),
      ...(cheat === 'lose' ? { options: { playerHp: 1 } } : {}),
    })
  : null;

// The P4-T5 table asset replaces the greybox once it loads; the greybox stays on any failure.
if (floor) {
  const target = floor;
  void (async () => {
    const manifest = parseTableAssetManifest(
      await (await fetch(`${TABLE_ASSET_BASE}/combat-table.manifest.json`)).json(),
    );
    const gltf = await new GLTFLoader().loadAsync(`${TABLE_ASSET_BASE}/${manifest.glb}`);
    await bindTableMaterials(gltf.scene, manifest, renderer).catch((error: unknown) =>
      console.warn('combat table materials fell back to factors', error),
    );
    target.useTableAsset(gltf.scene, manifest.authoredTopHeight);
  })().catch((error: unknown) =>
    console.warn('combat table asset unavailable, greybox kept', error),
  );
}

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
  else if (event.code === 'KeyK') floor.encounter.end('win');
  else if (event.code === 'KeyF') floor.encounter.end('flee');
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
  const target = floor;
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
  /** Moves the rig 1 m south of the first live automaton, facing north at it, to start that fight. */
  const teleportToEncounter = (): number | null => {
    for (const [room, bodies] of target.world.enemies) {
      const body = bodies.find((b) => b.parent !== null);
      if (!body || target.encounter.isCleared(room)) continue;
      const at = body.getWorldPosition(new THREE.Vector3());
      rig.position.set(at.x, 0, at.z + 1);
      walker.yaw = 0;
      return room;
    }
    return null;
  };
  Object.assign(window, {
    __combat: {
      get session() {
        return combat?.session ?? null;
      },
      get banner() {
        return combat?.banner ?? '';
      },
      floor: target,
      camera,
      screenOf,
      teleportToEncounter,
    },
  });
}

actions.on('new-run', ({ seed }) => {
  const url = new URL(location.href);
  if (seed) url.searchParams.set('seed', seed);
  else url.searchParams.delete('seed');
  location.assign(url);
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
enterButton.addEventListener('click', () => void xr.enter());
app.append(enterButton);
if (proofView) enterButton.hidden = true;
void xr.supported().then((ok) => {
  enterButton.disabled = !ok;
  if (!ok) enterButton.textContent = 'VR not available';
});
actions.on('enter-xr', () => {
  enterButton.style.display = 'none';
  camera.position.set(0, 0, 0);
  recenterPending = true;
});
actions.on('exit-xr', () => {
  enterButton.style.display = '';
  camera.position.set(0, 1.6, 0);
  rig.position.y = 0;
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

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
    }
    const { left, right } = xr.sticks();
    if (!floor?.locked) {
      locomotion.update(deltaSeconds, {
        moveX: left[0],
        moveY: left[1],
        turnX: right[0],
        teleportAim: null,
      });
    }
  } else {
    desktop.update();
    walker.enabled = !floor?.locked;
    walker.update(deltaSeconds);
  }
  cardProof?.update(time / 1000, xr.presenting);
  floor?.update(camera, deltaSeconds);
  combat?.update(deltaSeconds, xr.presenting ? xrHands() : null);
  if (floor && audio) {
    audio.syncGame(floor.encounter.phase === 'idle' ? 'explore' : 'combat', floor.encounter.phase);
    audio.update(deltaSeconds);
  }
  renderer.render(scene, camera);
  if (floor && !xr.presenting) {
    const room = floor.world.plan.rooms[floor.world.current];
    const fight = floor.encounter.phase === 'idle' ? '' : ` · encounter ${floor.encounter.phase}`;
    const session = combat?.session;
    const combatLines = session
      ? `\n${session.hudText()}\n${session.log.slice(-4).join('\n')}\nDrag a card at an enemy or onto the table · draw on the plate · T throw dice · E end turn · Esc cancel`
      : '';
    hud.textContent = `seed ${floor.seed} · room ${floor.world.current} ${room?.templateId} (${room?.role}) · calls ${renderer.info.render.calls}${fight}${combatLines}`;
  }
  if (floor) {
    const text = combat?.banner ?? '';
    banner.textContent = text;
    banner.style.display = text && !xr.presenting ? '' : 'none';
  }
});
