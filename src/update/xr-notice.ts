import * as THREE from 'three';
import { configureTextTexture } from '../combat-view/canvas-label.ts';
import { PALETTE } from '../palette.ts';
import { BUTTONS, buttonAtUv, type NoticeButton, PANEL } from './layout.ts';

export interface XrNotice {
  /** Shows or hides the panel; showing it (re)places it in front of the head. */
  setVisible(visible: boolean): void;
  dispose(): void;
}

interface XrNoticeOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  onReload(): void;
  onLater(): void;
}

/** The panel sits this far ahead of the head and a little below eye level. */
const DISTANCE = 1.1;
const DROP = 0.15;
/** Beyond this angle from the gaze the panel is brought back in front of the player. */
const RECALL_ANGLE = Math.PI / 3;

function draw(canvas: HTMLCanvasElement, hover: NoticeButton | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = 'rgba(18,12,7,0.94)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = PALETTE.brass;
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
  ctx.textAlign = 'center';
  ctx.fillStyle = PALETTE.candle;
  ctx.font = '700 44px system-ui, sans-serif';
  ctx.fillText('New version available', canvas.width / 2, 70);
  ctx.fillStyle = PALETTE.parchment;
  ctx.font = '500 28px system-ui, sans-serif';
  ctx.fillText('Reload to play the latest build.', canvas.width / 2, 120);
  const labels: Record<NoticeButton, string> = { reload: 'Reload', later: 'Later' };
  for (const name of ['reload', 'later'] as const) {
    const { x, y, width, height } = BUTTONS[name];
    const primary = name === 'reload';
    ctx.fillStyle = primary ? PALETTE.brass : PALETTE.warmBlack;
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = hover === name ? PALETTE.parchment : PALETTE.brassDark;
    ctx.lineWidth = hover === name ? 8 : 4;
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = primary ? PALETTE.void : PALETTE.parchment;
    ctx.font = '700 40px system-ui, sans-serif';
    ctx.fillText(labels[name], x + width / 2, y + height / 2 + 14);
  }
}

/**
 * A canvas panel in the scene for the immersive session, where the desktop bar is not visible.
 * Controller select presses its Reload or Later button. It is drawn over the world, and while
 * shown it follows the player's gaze only when they turn well away from it.
 */
export function createXrNotice({ scene, renderer, onReload, onLater }: XrNoticeOptions): XrNotice {
  const canvas = document.createElement('canvas');
  canvas.width = PANEL.canvasWidth;
  canvas.height = PANEL.canvasHeight;
  const texture = new THREE.CanvasTexture(canvas);
  configureTextTexture(texture);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const geometry = new THREE.PlaneGeometry(PANEL.width, PANEL.height);
  const panel = new THREE.Mesh(geometry, material);
  panel.name = 'update-notice';
  panel.renderOrder = 1000;
  // Placement runs in onBeforeRender, which a culled mesh never reaches.
  panel.frustumCulled = false;
  panel.visible = false;
  scene.add(panel);

  const controllers = [0, 1].map((index) => renderer.xr.getController(index));
  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const head = new THREE.Vector3();
  const gaze = new THREE.Vector3();
  const toPanel = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  let hover: NoticeButton | null = null;
  let placed = false;

  const buttonUnder = (controller: THREE.Object3D): NoticeButton | null => {
    controller.getWorldPosition(origin);
    controller.getWorldQuaternion(rotation);
    direction.set(0, 0, -1).applyQuaternion(rotation);
    raycaster.set(origin, direction);
    const hit = raycaster.intersectObject(panel, false)[0];
    return hit?.uv ? buttonAtUv(hit.uv.x, hit.uv.y) : null;
  };

  const place = (eye: THREE.Camera): void => {
    head.setFromMatrixPosition(eye.matrixWorld);
    gaze.setFromMatrixColumn(eye.matrixWorld, 2).negate();
    gaze.y = 0;
    if (gaze.lengthSq() < 1e-6) gaze.set(0, 0, -1);
    gaze.normalize();
    panel.position.copy(head).addScaledVector(gaze, DISTANCE);
    panel.position.y = head.y - DROP;
    panel.lookAt(head.x, panel.position.y, head.z);
    panel.updateMatrixWorld();
    placed = true;
  };

  // Runs once per eye while the panel is drawn: places it on the first frame, keeps hover
  // feedback current and recalls it when the player has turned away.
  panel.onBeforeRender = (_renderer, _scene, eye) => {
    if (!placed) place(eye);
    else {
      head.setFromMatrixPosition(eye.matrixWorld);
      gaze.setFromMatrixColumn(eye.matrixWorld, 2).negate();
      toPanel.copy(panel.position).sub(head).normalize();
      if (gaze.angleTo(toPanel) > RECALL_ANGLE) place(eye);
    }
    let next: NoticeButton | null = null;
    for (const controller of controllers) next ??= buttonUnder(controller);
    if (next !== hover) {
      hover = next;
      draw(canvas, hover);
      texture.needsUpdate = true;
    }
  };

  const onSelect = (event: { target: unknown }): void => {
    if (!panel.visible) return;
    const pressed = buttonUnder(event.target as THREE.Object3D);
    if (pressed === 'reload') onReload();
    else if (pressed === 'later') onLater();
  };
  for (const controller of controllers) controller.addEventListener('select', onSelect);

  draw(canvas, null);
  texture.needsUpdate = true;

  return {
    setVisible(visible) {
      if (visible && !panel.visible) placed = false;
      panel.visible = visible;
    },
    dispose() {
      for (const controller of controllers) controller.removeEventListener('select', onSelect);
      scene.remove(panel);
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
