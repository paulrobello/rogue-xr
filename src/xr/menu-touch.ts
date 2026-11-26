import { createPointer } from '@par/xr-workspace';
import * as THREE from 'three';

const TOUCH_DEPTH = 0.008;
const RELEASE_DEPTH = 0.026;
const PROBE_OFFSET = 0.065;

/** A tracked index tip presses a visible button by approaching from the front of the menu. */
export function createMenuTouch() {
  const pointer = createPointer({ far: PROBE_OFFSET * 2 });
  const backward = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const previous = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const heldPoint = new THREE.Vector3();
  const heldNormal = new THREE.Vector3();
  const result = { hovered: null as string | null, pressed: null as string | null };
  let tracked = false;
  let armed = false;
  let held = false;

  return {
    get held(): boolean {
      return held;
    },
    sample(
      tip: THREE.Vector3 | null,
      front: THREE.Vector3,
      targets: readonly THREE.Object3D[],
      controlAt: (object: THREE.Object3D) => string | null,
    ) {
      result.hovered = result.pressed = null;
      if (!tip || !targets.length) {
        tracked = armed = held = false;
        return result;
      }

      if (held && offset.subVectors(tip, heldPoint).dot(heldNormal) >= RELEASE_DEPTH) {
        held = false;
        armed = true;
      }
      const hit = pointer.cast(
        origin.copy(tip).addScaledVector(front, PROBE_OFFSET),
        backward.copy(front).negate(),
        targets,
      );
      const control = hit ? controlAt(hit.object) : null;
      if (hit && control) {
        const depth = hit.distance - PROBE_OFFSET;
        const priorDepth = offset.subVectors(previous, hit.point).dot(front);
        if (depth >= -TOUCH_DEPTH && depth < RELEASE_DEPTH) result.hovered = control;
        if (!held && (depth >= RELEASE_DEPTH || (tracked && priorDepth >= RELEASE_DEPTH)))
          armed = true;
        if (!held && armed && tracked && priorDepth > TOUCH_DEPTH && depth <= TOUCH_DEPTH) {
          held = true;
          armed = false;
          heldPoint.copy(hit.point);
          heldNormal.copy(front);
          result.pressed = control;
        }
      }
      previous.copy(tip);
      tracked = true;
      return result;
    },
  };
}
