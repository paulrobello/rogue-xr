import * as THREE from 'three';

export const HAND_HORIZONTAL_OFFSET = 0.008;

/** Moves the whole hand after its bones have been posed in tracking space. */
export function createTrackedHandOffset(
  rig: THREE.Object3D,
  hand: THREE.Object3D,
  enabled: boolean,
) {
  const world = new THREE.Vector3();
  const local = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  const localAxes = new THREE.Matrix3();

  return {
    world,
    reset(): void {
      hand.position.sub(local);
      world.set(0, 0, 0);
      local.set(0, 0, 0);
    },
    apply(side: 'left' | 'right'): void {
      if (!enabled || !hand.visible || !hand.parent) return;
      rig.updateWorldMatrix(true, false);
      world
        .set(1, 0, 0)
        .transformDirection(rig.matrixWorld)
        .multiplyScalar(side === 'left' ? HAND_HORIZONTAL_OFFSET : -HAND_HORIZONTAL_OFFSET);
      hand.parent.updateWorldMatrix(true, false);
      inverse.copy(hand.parent.matrixWorld).invert();
      local.copy(world).applyMatrix3(localAxes.setFromMatrix4(inverse));
      hand.position.add(local);
    },
  };
}
