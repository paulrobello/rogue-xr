import * as THREE from 'three';
import { ActionBus } from './core/actions.ts';
import { createDesktopControls } from './desktop/controls.ts';
import { PALETTE } from './palette.ts';
import { createPlaceholderRoom } from './world/placeholder-room.ts';
import { createXrRig } from './xr/session.ts';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
app.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.void);
scene.add(createPlaceholderRoom());

// The rig is the player's locomotion root; the camera sits at seated-calibrated eye height.
const rig = new THREE.Group();
rig.name = 'player-rig';
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 0);
rig.add(camera);
rig.position.set(0, 0, 2);
scene.add(rig);

const actions = new ActionBus();
const xr = createXrRig(renderer, scene, rig, camera, actions);
const desktop = createDesktopControls(rig, camera, renderer.domElement);

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
void xr.supported().then((ok) => {
  enterButton.disabled = !ok;
  if (!ok) enterButton.textContent = 'VR not available';
});
actions.on('enter-xr', () => {
  enterButton.style.display = 'none';
  camera.position.set(0, 0, 0);
});
actions.on('exit-xr', () => {
  enterButton.style.display = '';
  camera.position.set(0, 1.6, 0);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const timer = new THREE.Timer();
renderer.setAnimationLoop((time, frame) => {
  timer.update(time);
  const deltaSeconds = Math.min(timer.getDelta(), 0.1);
  if (xr.presenting) xr.update(deltaSeconds, frame);
  else desktop.update(deltaSeconds);
  renderer.render(scene, camera);
});
