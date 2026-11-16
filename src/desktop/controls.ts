import * as THREE from 'three';
import type { ActionBus } from '../core/actions.ts';

/** Degrees of turn per pixel of mouse travel. */
const LOOK_DEGREES_PER_PIXEL = 0.23;
const PITCH_RADIANS_PER_PIXEL = 0.004;
const PITCH_LIMIT = 1.4;

/**
 * Desktop presenter: WASD becomes `move` intents and mouse drag becomes `turn` intents on the
 * action bus, so desktop and XR drive the same walker. Pitch is presentation only and stays on
 * the camera.
 */
export function createDesktopControls(
  camera: THREE.PerspectiveCamera,
  element: HTMLElement,
  actions: ActionBus,
) {
  const keys = new Set<string>();
  let pitch = 0;
  let dragging = false;

  element.addEventListener('pointerdown', () => {
    dragging = true;
  });
  window.addEventListener('pointerup', () => {
    dragging = false;
  });
  window.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    if (event.movementX)
      actions.emit({ type: 'turn', degrees: event.movementX * LOOK_DEGREES_PER_PIXEL });
    pitch = THREE.MathUtils.clamp(
      pitch - event.movementY * PITCH_RADIANS_PER_PIXEL,
      -PITCH_LIMIT,
      PITCH_LIMIT,
    );
  });
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    keys.add(event.code);
  });
  window.addEventListener('keyup', (event) => keys.delete(event.code));
  window.addEventListener('blur', () => keys.clear());

  return {
    update() {
      camera.rotation.set(pitch, 0, 0);
      const forward =
        Number(keys.has('KeyW') || keys.has('ArrowUp')) -
        Number(keys.has('KeyS') || keys.has('ArrowDown'));
      const strafe = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
      const turn = Number(keys.has('ArrowRight')) - Number(keys.has('ArrowLeft'));
      if (forward || strafe) actions.emit({ type: 'move', forward, strafe });
      if (turn) actions.emit({ type: 'turn', degrees: turn * 2 });
    },
  };
}
