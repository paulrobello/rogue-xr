import * as THREE from 'three';
import { type FireboxShape, fireboxFlameGeometry, flameMaterial } from './hearth-coals.ts';

/** A baked room's open fireplace: where its firebox stands in the template's frame. */
export interface Firebox extends FireboxShape {
  /** The hearth floor under the fire, template-local metres. */
  readonly centre: readonly [number, number, number];
  /** Turn about +Y that points the firebox's local +z out of its opening, radians (a quarter-turn multiple). */
  readonly yaw: number;
}

/**
 * The fireplaces the baked rooms carry, keyed by template id. The hall's follows `kit.fireplace` on
 * wall N at wall-local a = -3.55 (build-room-kit.py HALL): opening 0.9 m wide and 0.8 m tall, back
 * lining 0.08 m and opening 0.45 m off the wall, flame cards 0.25 m off it, wall N at z = -5.
 */
export const FIREBOXES: Readonly<Record<string, Firebox>> = {
  hall: {
    centre: [-3.55, 0, -4.75],
    yaw: 0,
    halfWidth: 0.45,
    height: 0.8,
    back: -0.17,
    front: 0.2,
  },
};

/** Colours of a wood fire: a yellow-white heart, amber body and deep orange-red tips. */
const WOOD_FIRE = {
  core: '#ffc84a',
  mid: '#ff7414',
  tip: '#b42208',
  hot: '#fff2d2',
  ember: '#7a1004',
} as const;
/** How much a reduced-motion fire still sways and breathes (sparks are hidden below 0.5). */
const REDUCED_MOTION = 0.3;
/** The fire mesh's name inside a room model. */
export const FIRE_NODE = 'fireplace-fire';

/** The template-local box of `firebox`'s opening, floor to lintel and back lining to opening. */
export function fireboxBounds(firebox: Firebox): THREE.Box3 {
  const local = new THREE.Box3(
    new THREE.Vector3(-firebox.halfWidth, 0, firebox.back),
    new THREE.Vector3(firebox.halfWidth, firebox.height, firebox.front),
  );
  return local.applyMatrix4(fireboxMatrix(firebox));
}

/** The firebox frame in the template's frame. */
export function fireboxMatrix(firebox: Firebox): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...firebox.centre),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), firebox.yaw),
    new THREE.Vector3(1, 1, 1),
  );
}

/**
 * Drops from `root`'s meshes whose material `isFire` names every triangle whose centroid lies in
 * `box` (root-local), so the baked fire goes and the candle flames sharing its slot stay. A mesh left
 * with no triangles is hidden. Geometry is replaced, not edited, so meshes sharing it elsewhere keep
 * theirs. Returns the triangles dropped.
 */
export function stripBakedFire(
  root: THREE.Object3D,
  box: THREE.Box3,
  isFire: (materialName: string) => boolean,
): number {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  let dropped = 0;
  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && !Array.isArray(mesh.material) && isFire(mesh.material.name))
      meshes.push(mesh);
  });
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const toLocal = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
    const source = geometry.index
      ? Array.from(geometry.index.array)
      : Array.from({ length: position.count }, (_, i) => i);
    const kept: number[] = [];
    for (let t = 0; t + 2 < source.length; t += 3) {
      const [i, j, k] = [source[t] ?? 0, source[t + 1] ?? 0, source[t + 2] ?? 0];
      a.fromBufferAttribute(position, i).applyMatrix4(toLocal);
      b.fromBufferAttribute(position, j).applyMatrix4(toLocal);
      c.fromBufferAttribute(position, k).applyMatrix4(toLocal);
      if (box.containsPoint(a.add(b).add(c).divideScalar(3))) dropped++;
      else kept.push(i, j, k);
    }
    if (kept.length === source.length) continue;
    const stripped = geometry.clone();
    stripped.setIndex(kept);
    stripped.clearGroups();
    stripped.computeBoundingSphere();
    stripped.computeBoundingBox();
    mesh.geometry = stripped;
    if (kept.length === 0) mesh.visible = false;
  }
  return dropped;
}

/** The live fire for one room model: its mesh and what drives it. */
export interface FireplaceFire {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  dispose(): void;
}

/**
 * The animated fire for `firebox`, a template-local mesh named `fireplace-fire` placed in its
 * firebox: one geometry and one additive material, so one draw call, unlit, no shadow. `key` seeds
 * its layout; `reducedMotion` softens the sway and breathing and hides the sparks.
 */
export function buildFireplaceFire(
  key: string,
  firebox: Firebox,
  reducedMotion = false,
): FireplaceFire {
  const geometry = fireboxFlameGeometry(key, firebox);
  const material = flameMaterial({ ...WOOD_FIRE, motion: reducedMotion ? REDUCED_MOTION : 1 });
  material.name = 'fireplace-flames';
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = FIRE_NODE;
  mesh.position.set(...firebox.centre);
  mesh.rotation.y = firebox.yaw;
  mesh.renderOrder = 1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return {
    mesh,
    material,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}

/**
 * Swaps a room model's baked fire for the live one when its template has a fireplace: strips the
 * flame-slot triangles inside the firebox and adds the fire to `model`. Returns null otherwise.
 */
export function dressFireplace(
  templateId: string,
  model: THREE.Object3D,
  isFire: (materialName: string) => boolean,
  reducedMotion = false,
): FireplaceFire | null {
  const firebox = FIREBOXES[templateId];
  if (!firebox) return null;
  const dropped = stripBakedFire(model, fireboxBounds(firebox), isFire);
  if (dropped === 0)
    console.warn(`${templateId}: no baked fire in the firebox; live fire added anyway`);
  const fire = buildFireplaceFire(templateId, firebox, reducedMotion);
  model.add(fire.mesh);
  return fire;
}

/** Sets every room fire's clock to `seconds` while its room shows. */
export function animateFires(
  fires: readonly { material: THREE.ShaderMaterial; room: THREE.Object3D }[],
  seconds: number,
): void {
  for (const f of fires) {
    const time = f.material.uniforms.uTime;
    if (f.room.visible && time) time.value = seconds;
  }
}
