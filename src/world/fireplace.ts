import * as THREE from 'three';
import { candleMaterial } from './candle-flame.ts';
import {
  type FireboxShape,
  FLAME_KIND,
  type FlameQuad,
  fireboxFlameGeometry,
  flameMaterial,
  flameQuadGeometry,
  flameReach,
} from './hearth-coals.ts';

/** A baked room's open fireplace: where its firebox stands in the template's frame. */
export interface Firebox extends FireboxShape {
  /** The hearth floor under the fire, template-local metres. */
  readonly centre: readonly [number, number, number];
  /** Turn about +Y that points the firebox's local +z out of its opening, radians (a quarter-turn multiple). */
  readonly yaw: number;
  /** Compresses the flame geometry along its depth behind a shallow grate. */
  readonly depthScale?: number;
}

/**
 * The fireplaces the baked rooms carry, keyed by template id. The hall's follows `kit.fireplace` on
 * wall N at wall-local a = -3.55 (build-room-kit.py HALL): opening 0.9 m wide and 0.8 m tall, back
 * lining 0.08 m and opening 0.45 m off the wall, flame cards 0.25 m off it, wall N at z = -5.
 */
export const FIREBOXES: Readonly<Record<string, Firebox | readonly Firebox[]>> = {
  hall: {
    centre: [-3.55, 0, -4.75],
    yaw: 0,
    halfWidth: 0.45,
    height: 0.8,
    back: -0.17,
    front: 0.2,
  },
  // Runtime +Z points out of the south grate. The coals are at radius 1.00 m and bars start at 1.06 m.
  'gear-shaft': [0, 1, 2, 3].map((turn): Firebox => {
    const yaw = (turn * Math.PI) / 2;
    return {
      centre: [Math.sin(yaw) * 1.03, 0.148, Math.cos(yaw) * 1.03],
      yaw,
      halfWidth: 0.45,
      height: 0.65,
      back: -0.028,
      front: 0.028,
      depthScale: 0.12,
    };
  }),
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
export const CANDLE_NODE = 'room-candle-flames';
export const TORCH_FLAME_NODE = 'room-torch-flames';

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
  box: THREE.Box3 | readonly THREE.Box3[],
  isFire: (materialName: string) => boolean,
): number {
  root.updateMatrixWorld(true);
  const toRoot = root.matrixWorld.clone().invert();
  const boxes: readonly THREE.Box3[] = box instanceof THREE.Box3 ? [box] : box;
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
      const centre = a.add(b).add(c).divideScalar(3);
      if (boxes.some((bounds) => bounds.containsPoint(centre))) dropped++;
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
  readonly extras?: readonly THREE.Mesh[];
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
  firebox: Firebox | readonly Firebox[],
  reducedMotion = false,
): FireplaceFire {
  const boxes: readonly Firebox[] = Array.isArray(firebox) ? firebox : [firebox as Firebox];
  const material = flameMaterial({ ...WOOD_FIRE, motion: reducedMotion ? REDUCED_MOTION : 1 });
  material.name = 'fireplace-flames';
  const meshes = boxes.map((box, i) => {
    const depthScale = box.depthScale ?? 1;
    const shape = { ...box, back: box.back / depthScale, front: box.front / depthScale };
    const geometry = fireboxFlameGeometry(i === 0 ? key : `${key}-${i}`, shape);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = FIRE_NODE;
    mesh.position.set(...box.centre);
    mesh.rotation.y = box.yaw;
    mesh.scale.z = depthScale;
    mesh.renderOrder = 1;
    return mesh;
  });
  const [mesh, ...extras] = meshes;
  if (!mesh) throw new Error('No firebox opening');
  return {
    mesh,
    extras,
    material,
    dispose() {
      for (const part of meshes) part.geometry.dispose();
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
  const configured = FIREBOXES[templateId];
  if (!configured) return null;
  const fireboxes = Array.isArray(configured) ? configured : [configured];
  const dropped = stripBakedFire(model, fireboxes.map(fireboxBounds), isFire);
  if (dropped === 0)
    console.warn(`${templateId}: no baked fire in the firebox; live fire added anyway`);
  const fire = buildFireplaceFire(templateId, fireboxes, reducedMotion);
  model.add(fire.mesh, ...(fire.extras ?? []));
  return fire;
}

// The hall GLB packs two crossed triangles per wick in hall_flame, with both sharing a tip.
// The fireplace has already been stripped from that slot before the wicks are collected.
export function dressCandleFlames(
  model: THREE.Object3D,
  isFlame: (name: string) => boolean,
  reducedMotion = false,
): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null {
  model.updateWorldMatrix(true, true);
  const inverse = model.matrixWorld.clone().invert();
  const flames = new Map<string, FlameQuad>();
  model.traverse((mesh) => {
    if (
      !(mesh instanceof THREE.Mesh) ||
      Array.isArray(mesh.material) ||
      !isFlame(mesh.material.name)
    )
      return;
    const geometry = mesh.geometry;
    const p = geometry.getAttribute('position');
    const transform = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const vertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < (geometry.index?.count ?? p.count); i += 3) {
      for (const [k, v] of vertices.entries())
        v.fromBufferAttribute(p, geometry.index?.getX(i + k) ?? i + k).applyMatrix4(transform);
      const tip = vertices.reduce((top, v) => (v.y > top.y ? v : top));
      const key = tip
        .toArray()
        .map((n) => n.toFixed(5))
        .join(',');
      if (flames.has(key)) continue;
      const base = Math.min(...vertices.map((v) => v.y));
      flames.set(key, {
        x: tip.x,
        y: base - 0.01,
        z: tip.z,
        seed: flames.size * 2.39996,
        width: 0.044,
        height: 0.078,
        kind: FLAME_KIND.billboard,
      });
    }
    mesh.visible = false;
  });
  if (!flames.size) return null;
  const quads = [...flames.values()];
  const geometry = flameQuadGeometry(quads);
  const bounds = new THREE.Box3();
  for (const q of quads) {
    bounds.expandByPoint(new THREE.Vector3(q.x - q.width / 2, q.y, q.z - q.width / 2));
    bounds.expandByPoint(new THREE.Vector3(q.x + q.width / 2, q.y + q.height, q.z + q.width / 2));
  }
  geometry.boundingSphere = bounds.getBoundingSphere(new THREE.Sphere());
  const material = candleMaterial(0, reducedMotion, true);
  material.name = CANDLE_NODE;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = CANDLE_NODE;
  mesh.raycast = () => undefined;
  model.add(mesh);
  return mesh;
}

/** Replaces each mounted stone-kit torch flame with the room's animated flame shader. */
export function dressTorchFlames(
  room: THREE.Object3D,
  reducedMotion: boolean,
): FireplaceFire | null {
  room.updateWorldMatrix(true, true);
  const inverse = room.matrixWorld.clone().invert();
  const quads: FlameQuad[] = [];
  room.traverse((node) => {
    if (node.name !== 'StoneTorchFlame' || !node.visible) return;
    const base = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld).applyMatrix4(inverse);
    node.visible = false;
    const seed = quads.length * 2.39996;
    for (const [x, height] of [
      [-0.027, 0.17],
      [0.027, 0.23],
    ] as const) {
      quads.push({
        x: base.x + x,
        y: base.y,
        z: base.z,
        width: 0.115,
        height,
        seed: seed + x * 36,
        kind: FLAME_KIND.billboard,
      });
    }
  });
  if (!quads.length) return null;
  const geometry = flameQuadGeometry(quads);
  geometry.boundingSphere = flameReach(quads).getBoundingSphere(new THREE.Sphere());
  const material = flameMaterial({ ...WOOD_FIRE, motion: reducedMotion ? REDUCED_MOTION : 1 });
  material.name = TORCH_FLAME_NODE;
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = TORCH_FLAME_NODE;
  mesh.renderOrder = 1;
  mesh.raycast = () => undefined;
  room.add(mesh);
  return {
    mesh,
    material,
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
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
