import * as THREE from 'three';
import type { ActionBus } from '../core/actions.ts';

/** Degrees of turn per pixel of mouse travel. */
const LOOK_DEGREES_PER_PIXEL = 0.23;
const PITCH_RADIANS_PER_PIXEL = 0.004;
const PITCH_LIMIT = 1.4;
/** Where the table centre sits in a fight's opening view, as normalized device y (-1 is the bottom). */
const TABLE_NDC_Y = -0.7;

/**
 * The desktop pitch a fight opens at: the table centre `distance` metres ahead and `drop` metres
 * below the eye lands at `TABLE_NDC_Y`. At the default placement (0.65 m ahead, 0.75 m down, 70°
 * fov) that is about -0.4 rad, which keeps the table, dice tray, sigil plate and the automatons'
 * readouts in view at 1600x1000 (measured in the P6-T2 bug bash); End Turn and Throw stay on E and T.
 */
export function combatPitch(distance: number, drop: number, fovDeg: number): number {
  const down = Math.atan2(drop, Math.max(distance, 1e-3));
  const below = Math.atan(-TABLE_NDC_Y * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  return THREE.MathUtils.clamp(below - down, -PITCH_LIMIT, 0);
}

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
  /** The pitch before a fight framed the table, restored when it ends; null outside a fight. */
  let beforeCombat: number | null = null;

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
    get pitch(): number {
      return pitch;
    },
    /**
     * Tilts the view to `combatPitchRad` when a fight opens (see `combatPitch`) and back to the
     * earlier pitch once it ends (null). Later calls during the fight keep the player's own look.
     * Returns true on the call that framed a new fight, so the caller can turn to the table too.
     */
    frameCombat(combatPitchRad: number | null): boolean {
      if (combatPitchRad !== null && beforeCombat === null) {
        beforeCombat = pitch;
        pitch = combatPitchRad;
        return true;
      }
      if (combatPitchRad === null && beforeCombat !== null) {
        pitch = beforeCombat;
        beforeCombat = null;
      }
      return false;
    },
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
