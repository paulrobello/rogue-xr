import * as THREE from 'three';
import { PALETTE } from '../palette.ts';

/** Beam length when the ray hits nothing the app reports, in metres. */
export const LASER_IDLE_LENGTH = 1.5;
const RADIUS = 0.0018;
const TIP_RADIUS = 0.006;

/** Ray intersections for visible UI surfaces, including book paper with no click target. */
export function createLaserSurfacePicker() {
  const raycaster = new THREE.Raycaster(undefined, undefined, 0.001, 6);
  const meshes: THREE.Mesh[] = [];
  const hits: THREE.Intersection<THREE.Mesh>[] = [];
  const rendered = (material: THREE.Material): boolean =>
    material.visible && material.colorWrite && material.opacity > 0;

  return {
    setRoot(root: THREE.Object3D): void {
      meshes.length = 0;
      root.updateWorldMatrix(true, true);
      root.traverseVisible((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = object.material;
        if (Array.isArray(materials) ? materials.some(rendered) : rendered(materials))
          meshes.push(object);
      });
    },
    distanceFrom(ray: THREE.Object3D): number | null {
      ray.updateWorldMatrix(true, false);
      raycaster.ray.origin.setFromMatrixPosition(ray.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).transformDirection(ray.matrixWorld);
      hits.length = 0;
      // Menu plates disable interaction raycasts even though their geometry stops the beam.
      for (const mesh of meshes) {
        if (!mesh.layers.test(raycaster.layers)) continue;
        if (mesh.constructor === THREE.Mesh)
          THREE.Mesh.prototype.raycast.call(mesh, raycaster, hits);
        else mesh.raycast(raycaster, hits);
      }
      let nearest = Infinity;
      for (const { object, face, distance } of hits) {
        const material = Array.isArray(object.material)
          ? object.material[face?.materialIndex ?? 0]
          : object.material;
        if (material && rendered(material)) nearest = Math.min(nearest, distance);
      }
      return Number.isFinite(nearest) ? nearest : null;
    },
  };
}

export interface Laser {
  readonly beam: THREE.Mesh;
  readonly tip: THREE.Mesh;
  /**
   * Places the beam along `ray`'s -Z axis. `hitDistance` ends it on a hit and shows the tip dot;
   * null draws the idle length with no tip. Hidden when `visible` is false.
   */
  follow(ray: THREE.Object3D, hitDistance: number | null, visible: boolean): void;
  dispose(): void;
}

/**
 * A controller pointer beam. It lives in its own scene (`root`) drawn after the menu boards, which
 * render over a cleared depth buffer and would otherwise paint over it.
 */
export function createLaser(root: THREE.Object3D): Laser {
  const beamGeometry = new THREE.CylinderGeometry(RADIUS, RADIUS, 1, 6, 1, true);
  // Unit length from the origin along -Z, so scale.z is the beam length.
  beamGeometry.rotateX(Math.PI / 2).translate(0, 0, -0.5);
  const beamMaterial = new THREE.MeshBasicMaterial({
    color: PALETTE.brass,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    toneMapped: false,
  });
  const beam = new THREE.Mesh(beamGeometry, beamMaterial);
  const tipGeometry = new THREE.SphereGeometry(TIP_RADIUS, 10, 8);
  const tipMaterial = new THREE.MeshBasicMaterial({ color: PALETTE.brass, toneMapped: false });
  const tip = new THREE.Mesh(tipGeometry, tipMaterial);
  for (const mesh of [beam, tip]) {
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    mesh.visible = false;
    root.add(mesh);
  }
  const scale = new THREE.Matrix4();
  const offset = new THREE.Matrix4();

  return {
    beam,
    tip,
    follow(ray, hitDistance, visible) {
      beam.visible = visible;
      tip.visible = visible && hitDistance !== null;
      if (!visible) return;
      ray.updateWorldMatrix(true, false);
      const length = hitDistance ?? LASER_IDLE_LENGTH;
      beam.matrix.multiplyMatrices(ray.matrixWorld, scale.makeScale(1, 1, length));
      beam.matrixWorld.copy(beam.matrix);
      tip.matrix.multiplyMatrices(ray.matrixWorld, offset.makeTranslation(0, 0, -length));
      tip.matrixWorld.copy(tip.matrix);
    },
    dispose() {
      root.remove(beam, tip);
      beamGeometry.dispose();
      beamMaterial.dispose();
      tipGeometry.dispose();
      tipMaterial.dispose();
    },
  };
}
