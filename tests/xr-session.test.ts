import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Locomotion } from '../src/xr/locomotion.ts';
import { applyViewerPose, XR_SESSION_OPTIONS } from '../src/xr/session.ts';

describe('XR session options', () => {
  it('requests medium foveation and a floor-relative space', () => {
    expect(XR_SESSION_OPTIONS.foveation).toBe('medium');
    expect(XR_SESSION_OPTIONS.referenceSpaces[0]).toBe('local-floor');
  });
});

describe('applyViewerPose', () => {
  const seatedPose = (y: number) => ({
    transform: {
      position: { x: 0.1, y, z: -0.05, w: 1 } as DOMPointReadOnly,
      orientation: { x: 0, y: Math.sin(0.2), z: 0, w: Math.cos(0.2) } as DOMPointReadOnly,
    },
  });

  it('moves the head camera to the viewer pose in rig space', () => {
    const head = new THREE.PerspectiveCamera();
    applyViewerPose(head, seatedPose(1.2));
    expect(head.position.toArray()).toEqual([0.1, 1.2, -0.05]);
    expect(head.quaternion.y).toBeCloseTo(Math.sin(0.2));
  });

  it('lets the first-frame recenter lift a seated head to standing eye height', () => {
    // main.ts zeroes the head on enter-xr and recenters on the first XR frame, before render.
    const rig = new THREE.Group();
    const head = new THREE.PerspectiveCamera();
    rig.add(head);
    const locomotion = new Locomotion(rig, head);
    locomotion.recenter();
    expect(rig.position.y).toBeCloseTo(1); // the zeroed head: clamped to the 1 m maximum lift
    applyViewerPose(head, seatedPose(1.2));
    locomotion.recenter();
    expect(rig.position.y).toBeCloseTo(0.4);
  });
});
