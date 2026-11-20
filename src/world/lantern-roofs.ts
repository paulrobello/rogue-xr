import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const ROOFS: Readonly<Record<string, readonly (readonly [number, number, number])[]>> = {
  corridor: [
    [0.8, 2.355, 0],
    [-0.8, 2.355, -3],
    [-0.8, 2.355, 3],
  ],
  'gear-shaft': [
    [3.6, 2.555, -5.6],
    [-3.6, 2.555, 5.6],
  ],
};

/** Close the baked lantern cage using the stamped roof's existing brass and lightmap charts. */
export function closeLanternRoofs(
  room: string,
  geometry: THREE.BufferGeometry,
): THREE.BufferGeometry {
  const centers = ROOFS[room];
  const index = geometry.index;
  if (!centers || !index) return geometry;
  const pos = geometry.getAttribute('position');
  const vertices: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i),
      b = index.getX(i + 1),
      c = index.getX(i + 2);
    if (
      centers.some(([x, y, z]) =>
        [a, b, c].every(
          (j) =>
            Math.abs(pos.getY(j) - y) < 0.0001 &&
            Math.hypot(pos.getX(j) - x, pos.getZ(j) - z) <= 0.106,
        ),
      )
    )
      vertices.push(a, c, b);
  }
  if (!vertices.length) return geometry;
  const underside = new THREE.BufferGeometry();
  for (const [key, attr] of Object.entries(geometry.attributes)) {
    const values = new Float32Array(vertices.length * attr.itemSize);
    vertices.forEach((src, i) => {
      for (let k = 0; k < attr.itemSize; k++) {
        let value = attr.getComponent(src, k);
        if (key === 'position' && k === 1) value -= 0.025;
        if (key === 'normal' && k === 1) value = -1;
        values[i * attr.itemSize + k] = value;
      }
    });
    underside.setAttribute(key, new THREE.Float32BufferAttribute(values, attr.itemSize));
  }
  underside.setIndex(vertices.map((_, i) => i));
  const merged = mergeGeometries([geometry, underside]);
  underside.dispose();
  if (!merged) throw Error('Cannot close the baked lantern roof');
  return merged;
}
