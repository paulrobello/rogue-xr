import * as THREE from 'three';

/** The pump occupies one copy of the study. Extend its north wallpaper bay over the
 * lancet using the bay's original lightmap island and full-size wallpaper repeat. */
export function closePumpRoomWindow(model: THREE.Object3D): THREE.BufferGeometry[] {
  const owned: THREE.BufferGeometry[] = [];
  model.traverse((mesh) => {
    if (!(mesh instanceof THREE.Mesh) || Array.isArray(mesh.material)) return;
    const slot = mesh.material.name;
    if (slot === 'study_stained-glass') {
      mesh.visible = false;
      return;
    }
    if (slot !== 'study_wallpaper' && slot !== 'study_walnut') return;
    const original: THREE.BufferGeometry = mesh.geometry;
    const index = original.getIndex();
    if (!index) return;
    const pos = original.getAttribute('position');
    const keep: number[] = [];
    const extend = new Set<number>();
    for (let t = 0; t < index.count; t += 3) {
      const vertices = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
      if (slot === 'study_wallpaper' && vertices.every((i) => Math.abs(pos.getZ(i) + 4) < 0.001)) {
        // The right-hand bay runs from the glass jamb at x=.6 to the corner at x=4.
        if (!vertices.every((i) => pos.getX(i) >= 0.599)) continue;
        for (const i of vertices) if (Math.abs(pos.getX(i) - 0.6) < 0.001) extend.add(i);
      }
      if (
        slot === 'study_walnut' &&
        vertices.every(
          (i) =>
            Math.abs(pos.getX(i)) <= 0.771 &&
            pos.getY(i) >= 1.299 &&
            pos.getY(i) <= 3.711 &&
            pos.getZ(i) < -3.739 &&
            pos.getZ(i) >= -4.001,
        )
      )
        continue;
      keep.push(...vertices);
    }
    if (keep.length === index.count && !extend.size) return;
    const geometry = original.clone();
    geometry.setIndex(keep);
    const position = geometry.getAttribute('position'),
      uv = geometry.getAttribute('uv');
    for (const i of extend) {
      uv.setX(i, uv.getX(i) + (-4 - position.getX(i)) / 0.75);
      position.setX(i, -4);
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    mesh.geometry = geometry;
    owned.push(geometry);
  });
  return owned;
}
