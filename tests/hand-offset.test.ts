import * as THREE from 'three';
import { expect, it } from 'vitest';
import { createTrackedHandOffset, HAND_HORIZONTAL_OFFSET } from '../src/xr/hand-offset.ts';

it('moves both wrists and fingertips inward by the same amount after each tracked pose', () => {
  const rig = new THREE.Group();
  rig.rotation.y = 0.6;
  const parent = new THREE.Group();
  parent.rotation.x = 0.4;
  for (const side of ['left', 'right'] as const) {
    const hand = new THREE.Group();
    const wrist = new THREE.Bone();
    const tip = new THREE.Bone();
    hand.position.set(0.2, 1, -0.4);
    tip.position.z = -0.08;
    wrist.add(tip);
    hand.add(wrist);
    parent.add(hand);
    const offset = createTrackedHandOffset(rig, hand, true);
    for (let frame = 0; frame < 3; frame++) {
      offset.reset();
      wrist.position.y = frame * 0.01;
      const rawTip = tip.getWorldPosition(new THREE.Vector3());
      const rawWrist = wrist.getWorldPosition(new THREE.Vector3());
      offset.apply(side);
      const renderedTip = tip.getWorldPosition(new THREE.Vector3());
      const renderedWrist = wrist.getWorldPosition(new THREE.Vector3());
      expect(rawTip.clone().add(offset.world).distanceTo(renderedTip)).toBeLessThan(1e-8);
      expect(rawWrist.clone().add(offset.world).distanceTo(renderedWrist)).toBeLessThan(1e-8);
      expect(renderedWrist.distanceTo(renderedTip)).toBeCloseTo(0.08);
      const inward = new THREE.Vector3(side === 'left' ? 1 : -1, 0, 0).transformDirection(
        rig.matrixWorld,
      );
      expect(offset.world.dot(inward)).toBeCloseTo(HAND_HORIZONTAL_OFFSET);
    }
  }
});

it('keeps hand positions as tracked when the translation is disabled', () => {
  const rig = new THREE.Group();
  const hand = new THREE.Group();
  rig.add(hand);
  const offset = createTrackedHandOffset(rig, hand, false);
  offset.apply('left');
  expect(offset.world.lengthSq()).toBe(0);
  expect(hand.position.lengthSq()).toBe(0);
});
