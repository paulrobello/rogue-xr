import * as THREE from 'three';

/** Fits curved foliage inside the existing stone-kit planter and keeps it batched as one mesh. */
export function dressPlanterFoliage(planter: THREE.Object3D): void {
  const placeholders: THREE.Mesh[] = [];
  planter.traverse((object) => {
    if (
      object instanceof THREE.Mesh &&
      !Array.isArray(object.material) &&
      /^Stone (young )?leaves$/.test(object.material.name)
    )
      placeholders.push(object);
  });
  if (!placeholders.length) return;
  for (const object of placeholders) object.removeFromParent();

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const rows = 10;
  const columns = 5;
  const green = new THREE.Color();
  for (let leaf = 0; leaf < 15; leaf++) {
    const angle = leaf * 2.399963;
    const outward = Math.cos(angle);
    const sideways = Math.sin(angle);
    const reach = 0.11 + ((leaf * 7) % 13) * 0.011;
    const height = 0.21 + ((leaf * 11) % 13) * 0.012;
    const width = 0.032 + (leaf % 4) * 0.006;
    const start = positions.length / 3;
    for (let row = 0; row <= rows; row++) {
      const t = row / rows;
      const spread = width * Math.max(0.018, Math.sin(t * Math.PI) ** 0.82) * t ** 0.26;
      const radius = reach * t ** 1.42;
      const rise = height * Math.sin(t * 1.94) + 0.014 * t;
      for (let column = 0; column < columns; column++) {
        const across = (2 * column) / (columns - 1) - 1;
        const off = spread * across;
        const camber = spread * (0.47 * (1 - across * across) + across * 0.13 * t);
        positions.push(
          radius * outward - off * sideways,
          0.322 + rise + camber,
          radius * sideways + off * outward,
        );
        const midrib = column === (columns - 1) / 2 ? 0.044 * Math.sin(Math.PI * t) : 0;
        green.setHSL(
          0.282 - 0.006 * (leaf % 6) + 0.015 * t,
          0.44 + 0.036 * (leaf % 5),
          0.19 + 0.035 * t + midrib,
        );
        colors.push(green.r, green.g, green.b);
        if (row === 0 || column === 0) continue;
        const i = start + row * columns + column;
        indices.push(i - columns - 1, i - 1, i - columns, i - columns, i - 1, i);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.73, side: THREE.DoubleSide }),
  );
  mesh.name = 'planter-curved-foliage';
  planter.add(mesh);
}
