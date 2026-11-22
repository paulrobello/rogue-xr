import * as THREE from 'three';

function planterVessel(): THREE.Mesh {
  const profile = [
    [0, 0.008],
    [0.112, 0.008],
    [0.125, 0.017],
    [0.135, 0.039],
    [0.142, 0.052],
    [0.163, 0.147],
    [0.179, 0.239],
    [0.181, 0.25],
    [0.179, 0.257],
    [0.182, 0.265],
    [0.194, 0.276],
    [0.198, 0.291],
    [0.193, 0.306],
    [0.183, 0.311],
    [0.17, 0.304],
    [0.164, 0.285],
    [0.149, 0.11],
    [0, 0.1],
  ].map(([radius, height]) => new THREE.Vector2(radius, height));
  const geometry = new THREE.LatheGeometry(profile, 36);
  const colors: number[] = [];
  const color = new THREE.Color();
  for (let i = 0; i < geometry.getAttribute('position').count; i++) {
    const row = i % profile.length;
    const column = Math.floor(i / profile.length) % 36;
    const worn = Math.sin(column * 1.57 + row * 2.23) * 0.025;
    const shade = row >= 9 && row <= 14 ? 0.88 : row === 7 || row === 8 ? 0.51 : 0.72;
    color.setRGB(shade + worn, shade * 0.81 + worn, shade * 0.66 + worn);
    colors.push(color.r, color.g, color.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  const material = new THREE.MeshStandardMaterial({
    name: 'Stone ceramic',
    color: 0xbc7651,
    vertexColors: true,
    roughness: 0.69,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'planter-rolled-clay-pot';
  return mesh;
}

function planterSoil(): THREE.Mesh {
  const vertices: number[] = [0, 0.314, 0];
  const dirt = new THREE.Color(0x382415);
  const colors = dirt.toArray();
  const indices: number[] = [];
  const segments = 36;
  const rings = 8;
  const fleck = new THREE.Color(0x8b6b49);
  const color = new THREE.Color();
  for (let ring = 1; ring <= rings; ring++) {
    const t = ring / rings;
    for (let spoke = 0; spoke < segments; spoke++) {
      const angle = (spoke * Math.PI * 2) / segments;
      const radius = 0.174 * t;
      const grain = (Math.sin(spoke * 76.17 + ring * 19.61) + 1) / 2;
      const y = 0.314 - t * 0.028 + (grain - 0.5) * 0.017 * Math.sin(t * Math.PI);
      vertices.push(radius * Math.cos(angle), y, radius * Math.sin(angle));
      color.copy(dirt).lerp(fleck, grain ** 5 * 0.68);
      colors.push(color.r, color.g, color.b);
      const here = 1 + (ring - 1) * segments + spoke;
      const next = 1 + (ring - 1) * segments + ((spoke + 1) % segments);
      if (ring === 1) indices.push(0, next, here);
      else indices.push(here - segments, next, here, here - segments, next - segments, next);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }),
  );
  mesh.name = 'planter-granular-soil';
  return mesh;
}

/** Fits curved foliage inside the existing stone-kit planter and keeps it batched as one mesh. */
export function dressPlanterFoliage(planter: THREE.Object3D): void {
  const placeholders: THREE.Mesh[] = [];
  const vesselParts: THREE.Mesh[] = [];
  planter.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
    const name = object.material.name;
    if (/^Stone (young )?leaves$/.test(name)) placeholders.push(object);
    if (/^Stone (ceramic|soil|worn edges)$/.test(name)) vesselParts.push(object);
  });
  if (!placeholders.length) return;
  for (const object of placeholders) object.removeFromParent();
  for (const object of vesselParts) object.removeFromParent();
  planter.add(planterVessel(), planterSoil());

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
