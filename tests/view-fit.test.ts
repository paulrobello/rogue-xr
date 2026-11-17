// @vitest-environment node
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { dropToFitView, fitsView, VIEW_TOP_LIMIT } from '../src/combat-view/view-fit.ts';

/** A seated eye at 1.2 m looking down 33 degrees, as the desktop combat framing does. */
function seatedCamera(): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(60, 1.6, 0.05, 50);
  camera.position.set(0, 1.2, 0);
  camera.rotation.set(THREE.MathUtils.degToRad(-33), 0, 0);
  return camera;
}

function ndcY(point: THREE.Vector3, camera: THREE.Camera): number {
  return point.clone().project(camera).y;
}

describe('view fit', () => {
  it('leaves a readout that is already inside the view where it is', () => {
    const camera = seatedCamera();
    const point = new THREE.Vector3(0, 0.8, -1.5);
    expect(fitsView(point, 0.1, camera)).toBe(true);
    expect(dropToFitView(point, 0.1, camera)).toBe(0);
  });

  it('lowers a readout whose top would leave the view until it fits', () => {
    const camera = seatedCamera();
    const point = new THREE.Vector3(0, 0.95, -2.6);
    expect(fitsView(point, 0.22, camera)).toBe(false);
    const drop = dropToFitView(point, 0.22, camera);
    expect(drop).toBeGreaterThan(0);
    expect(drop).toBeLessThan(0.6);
    const top = point.clone();
    top.y += 0.22 - drop;
    camera.updateMatrixWorld();
    expect(ndcY(top, camera)).toBeLessThanOrEqual(VIEW_TOP_LIMIT);
  });

  it('stops at the largest drop it is allowed', () => {
    const camera = seatedCamera();
    const point = new THREE.Vector3(0, 1.6, -3);
    expect(dropToFitView(point, 0.2, camera, 0.3)).toBe(0.3);
  });

  it('treats a point behind the camera as fitting', () => {
    const camera = seatedCamera();
    expect(fitsView(new THREE.Vector3(0, 2, 3), 0.2, camera)).toBe(true);
  });
});
