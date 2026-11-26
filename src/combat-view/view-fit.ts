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

/** Fit a camera-facing rectangle at its existing depth, shifting before reducing its scale. */
export function fitBillboardToView(
  center: THREE.Vector3,
  width: number,
  height: number,
  camera: THREE.PerspectiveCamera,
): number {
  const view = camera.worldToLocal(center);
  const depth = -view.z;
  if (depth <= camera.near) {
    camera.localToWorld(view);
    return 1;
  }
  const projection = camera.projectionMatrix.elements;
  const halfWidth = depth / projection[0];
  const halfHeight = depth / projection[5];
  const limitX = halfWidth * VIEW_TOP_LIMIT;
  const limitY = halfHeight * VIEW_TOP_LIMIT;
  const scale = Math.min(1, (2 * limitX) / width, (2 * limitY) / height);
  const originX = projection[8] * halfWidth;
  const originY = projection[9] * halfHeight;
  const spareX = Math.max(0, limitX - (width * scale) / 2);
  const spareY = Math.max(0, limitY - (height * scale) / 2);
  view.x = originX + THREE.MathUtils.clamp(view.x - originX, -spareX, spareX);
  view.y = originY + THREE.MathUtils.clamp(view.y - originY, -spareY, spareY);
  camera.localToWorld(view);
  return scale;
}
