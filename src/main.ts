import * as THREE from 'three';
import { mountCardProof } from './cards/card-proof.ts';
import { ActionBus } from './core/actions.ts';
import { createDesktopControls } from './desktop/controls.ts';
import { mountSeedTitle } from './desktop/seed-title.ts';
import { Walker } from './desktop/walker.ts';
import { PALETTE } from './palette.ts';
import { mountPerf } from './perf/index.ts';
import { type FloorView, mountFloorView, seedFromQuery } from './world/floor-view.ts';
import { mountLightmapProof } from './world/lightmap-proof.ts';
import { mountMaterialProof } from './world/material-proof.ts';
import { Locomotion } from './xr/locomotion.ts';
import { createXrRig } from './xr/session.ts';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root');

const view = new URLSearchParams(location.search).get('view');
const proofView = view === 'lightmap-proof' || view === 'card-proof' || view === 'material-proof';
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
} else {
  floor = mountFloorView(scene, rig, seedFromQuery(location.search));
}

// Debug readout: seed, current room and the last frame's draw calls (Quest budget: under 200).
const hud = document.createElement('div');
hud.id = 'debug-hud';
Object.assign(hud.style, {
  position: 'fixed',
  top: '12px',
  left: '12px',
  font: '500 13px ui-monospace, monospace',
  color: PALETTE.candle,
  pointerEvents: 'none',
});
if (floor) app.append(hud);

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
// Until the combat loop is wired in, debug keys resolve a fight.
window.addEventListener('keydown', (event) => {
  if (!floor || floor.encounter.phase !== 'active') return;
  if (event.code === 'KeyK') floor.encounter.end('win');
  if (event.code === 'KeyF') floor.encounter.end('flee');
});
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
  renderer.render(scene, camera);
  if (floor && !xr.presenting) {
    const room = floor.world.plan.rooms[floor.world.current];
    const fight =
      floor.encounter.phase === 'idle'
        ? ''
        : ` · encounter ${floor.encounter.phase} (K win, F flee)`;
    hud.textContent = `seed ${floor.seed} · room ${floor.world.current} ${room?.templateId} (${room?.role}) · calls ${renderer.info.render.calls}${fight}`;
  }
});
