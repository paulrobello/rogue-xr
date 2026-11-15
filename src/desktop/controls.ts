import * as THREE from 'three';

const LOOK_SPEED = 0.004;
const MOVE_SPEED = 2;

/** Placeholder desktop camera: drag to look, WASD to walk. Replaced by P1-T5's action-bus controls. */
export function createDesktopControls(
  rig: THREE.Group,
  camera: THREE.PerspectiveCamera,
  element: HTMLElement,
) {
  const keys = new Set<string>();
  let yaw = 0;
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
    yaw -= event.movementX * LOOK_SPEED;
    pitch = THREE.MathUtils.clamp(pitch - event.movementY * LOOK_SPEED, -1.4, 1.4);
  });
  window.addEventListener('keydown', (event) => keys.add(event.code));
  window.addEventListener('keyup', (event) => keys.delete(event.code));

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  return {
    update(deltaSeconds: number) {
      rig.rotation.y = yaw;
      camera.rotation.set(pitch, 0, 0);
      const ahead = Number(keys.has('KeyW')) - Number(keys.has('KeyS'));
      const strafe = Number(keys.has('KeyD')) - Number(keys.has('KeyA'));
      if (!ahead && !strafe) return;
      forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      right.set(Math.cos(yaw), 0, -Math.sin(yaw));
      rig.position.addScaledVector(forward, ahead * MOVE_SPEED * deltaSeconds);
      rig.position.addScaledVector(right, strafe * MOVE_SPEED * deltaSeconds);
    },
  };
}
