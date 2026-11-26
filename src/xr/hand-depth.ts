import * as THREE from 'three';

const HAND_DEPTH_ORDER = -10_000;

/** Draws hand depth and the boards together, before the XR target can discard depth. */
export function createHandDepthPass(
  renderer: Pick<THREE.WebGLRenderer, 'render'>,
  world: THREE.Scene,
  hands: THREE.Group,
) {
  const depth = new THREE.MeshDepthMaterial({ colorWrite: false });

  return {
    render(boards: THREE.Scene, camera: THREE.Camera): void {
      if (!hands.visible || !hands.children.some((hand) => hand.visible)) {
        renderer.render(boards, camera);
        return;
      }
      const materials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
      const orders = new Map<THREE.Object3D, number>();
      // Both scenes have identity transforms, so the live skin and wrist keep their world pose.
      boards.add(hands);
      try {
        hands.traverseVisible((object) => {
          if (object instanceof THREE.Group || object instanceof THREE.Mesh) {
            orders.set(object, object.renderOrder);
            object.renderOrder = HAND_DEPTH_ORDER;
          }
          if (!(object instanceof THREE.Mesh)) return;
          const original = object.material;
          materials.set(object, original);
          object.material = Array.isArray(original)
            ? original.map((material) => (material.visible ? depth : material))
            : original.visible
              ? depth
              : original;
        });
        renderer.render(boards, camera);
      } finally {
        for (const [mesh, material] of materials) mesh.material = material;
        for (const [object, order] of orders) object.renderOrder = order;
        world.add(hands);
      }
    },
    dispose: () => depth.dispose(),
  };
}
