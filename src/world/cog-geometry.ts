import * as THREE from 'three';

/** A brass cog, centered on its axle and facing local +Z. */
export function cogGeometry(radius = 0.045): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const teeth = 8;
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? radius : radius * 0.72;
    const a0 = (i / (teeth * 2)) * Math.PI * 2;
    const a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2;
    if (i === 0) shape.moveTo(Math.cos(a0) * r, Math.sin(a0) * r);
    else shape.lineTo(Math.cos(a0) * r, Math.sin(a0) * r);
    shape.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
  }
  const hole = new THREE.Path();
  hole.absarc(0, 0, radius * 0.28, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: radius * 0.35,
    bevelEnabled: false,
    curveSegments: 6,
  });
  geometry.center();
  geometry.computeBoundingBox();
  return geometry;
}
