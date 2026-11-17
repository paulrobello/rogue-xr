import * as THREE from 'three';

/** Highest normalised device y a readout's top may reach, leaving a margin under the view's edge. */
export const VIEW_TOP_LIMIT = 0.9;

const probe = new THREE.Vector3();

/** Whether `point.y + headroom` is inside the top of `camera`'s view (or behind the camera). */
export function fitsView(point: THREE.Vector3, headroom: number, camera: THREE.Camera): boolean {
  camera.updateWorldMatrix(true, false);
  probe.copy(point);
  probe.y += headroom;
  probe.project(camera);
  return probe.z > 1 || probe.y <= VIEW_TOP_LIMIT;
}

/**
 * How far to lower a readout at `point` so that `point.y + headroom` stays inside the top of
 * `camera`'s view, in `step` metre steps up to `maxDrop`. Zero when it already fits.
 */
export function dropToFitView(
  point: THREE.Vector3,
  headroom: number,
  camera: THREE.Camera,
  maxDrop = 0.6,
  step = 0.02,
): number {
  for (let drop = 0; drop < maxDrop; drop += step) {
    if (fitsView(point, headroom - drop, camera)) return drop;
  }
  return maxDrop;
}
