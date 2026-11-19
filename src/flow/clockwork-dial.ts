import * as THREE from 'three';
import { PALETTE } from '../palette.ts';
import { cogGeometry } from '../world/cog-geometry.ts';

/** Fits the metalwork to the toolkit's animated, ray-pickable button faces. */
export function dressClockworkDial(root: THREE.Group, probe: THREE.Texture | null): () => void {
  const rim = new THREE.Group();
  rim.name = 'menu-clockwork-rim';
  root.add(rim);
  const ownedMaterials: THREE.Material[] = [];
  const ownedGeometry: THREE.BufferGeometry[] = [];
  function finish(color: string, metalness: number, roughness: number): THREE.MeshStandardMaterial {
    const material = new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness,
      envMap: probe,
      envMapIntensity: 1.15,
    });
    ownedMaterials.push(material);
    return material;
  }
  const brass = finish('#be9254', 0.87, 0.32);
  const bronze = finish('#705037', 0.84, 0.42);
  const engraving = finish('#2f2924', 0.65, 0.48);
  function addHardware(mesh: THREE.Mesh): void {
    mesh.raycast = () => undefined;
    ownedGeometry.push(mesh.geometry);
    rim.add(mesh);
  }
  function turned(profile: readonly [number, number][], material: THREE.Material): void {
    const shape = new THREE.LatheGeometry(
      profile.map(([r, z]) => new THREE.Vector2(r, z)),
      112,
    );
    addHardware(new THREE.Mesh(shape.rotateX(Math.PI / 2), material));
  }
  // Profile coordinates are radius and depth from the button faces, in metres.
  turned(
    [
      [0.001, -0.04],
      [0.39, -0.04],
      [0.402, -0.032],
      [0.405, -0.024],
      [0.405, -0.01],
      [0.399, -0.004],
      [0.373, -0.004],
      [0.366, -0.013],
      [0.001, -0.013],
    ],
    bronze,
  );
  turned(
    [
      [0.403, -0.021],
      [0.409, -0.018],
      [0.409, -0.007],
      [0.403, 0.004],
      [0.397, 0.008],
      [0.392, 0.005],
      [0.39, -0.002],
    ],
    brass,
  );
  turned(
    [
      [0.378, -0.006],
      [0.376, 0.002],
      [0.372, 0.004],
      [0.369, -0.002],
    ],
    brass,
  );
  turned(
    [
      [0.137, -0.011],
      [0.134, -0.002],
      [0.13, 0.002],
      [0.121, 0.002],
      [0.117, -0.001],
      [0.112, -0.009],
    ],
    bronze,
  );
  turned(
    [
      [0.125, -0.002],
      [0.123, 0.004],
      [0.12, 0.005],
      [0.118, 0.001],
    ],
    brass,
  );

  const matrix = new THREE.Object3D();
  const teeth = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), brass, 60);
  for (let i = 0; i < teeth.count; i++) {
    const a = (i * Math.PI) / 30;
    const major = i % 5 === 0;
    matrix.rotation.set(0, 0, -a);
    matrix.position.set(Math.sin(a) * 0.384, Math.cos(a) * 0.384, -0.002);
    matrix.scale.set(major ? 0.0036 : 0.0017, major ? 0.012 : 0.007, 0.002);
    matrix.updateMatrix();
    teeth.setMatrixAt(i, matrix.matrix);
  }
  addHardware(teeth);
  const heads = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 10), brass, 6);
  const slots = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), engraving, 6);
  for (let i = 0; i < heads.count; i++) {
    const a = ((i + 0.5) * Math.PI) / 3;
    matrix.position.set(Math.sin(a) * 0.383, Math.cos(a) * 0.383, -0.0005);
    matrix.rotation.set(0, 0, a);
    matrix.scale.set(0.008, 0.008, 0.004);
    matrix.updateMatrix();
    heads.setMatrixAt(i, matrix.matrix);
    matrix.position.z += 0.0038;
    matrix.scale.set(0.01, 0.0016, 0.0006);
    matrix.updateMatrix();
    slots.setMatrixAt(i, matrix.matrix);
  }
  addHardware(heads);
  addHardware(slots);

  for (const node of root.getObjectsByProperty('type', 'Mesh')) {
    if (!(node instanceof THREE.Mesh)) continue;
    const source = node.geometry;
    if (node.name === 'radial-outline') {
      node.material = brass;
      continue;
    }
    const isSector = source instanceof THREE.ShapeGeometry;
    const isHub = source instanceof THREE.CircleGeometry;
    if ((!isSector && !isHub) || !node.userData.radialAction) continue;
    const shape = isSector
      ? source.parameters.shapes
      : new THREE.Shape().absarc(0, 0, source.parameters.radius, 0, Math.PI * 2, false);
    const thickness = 0.009;
    const casting = new THREE.ExtrudeGeometry(shape, {
      depth: thickness,
      bevelSize: 0.003,
      bevelThickness: 0.002,
      bevelSegments: 2,
      curveSegments: 24,
    }).translate(0, 0, -thickness - 0.0022);
    ownedGeometry.push(casting);
    const face = finish(PALETTE.warmBlack, isHub ? 0.7 : 0.5, isHub ? 0.32 : 0.42);
    // The toolkit updates this Color in place on hover and on open.
    face.envMapIntensity = isHub ? 0.47 : 0.26;
    face.color = (node.material as THREE.MeshBasicMaterial).color;
    node.geometry = casting;
    node.material = isHub ? face : [face, brass];
  }
  for (const action of ['settings', 'deck', 'items']) {
    const label = root
      .getObjectByName(`radial-menu-${action}`)
      ?.children.find((child) => child.userData.labelTextObject);
    if (!label) continue;
    const symbol = new THREE.Group();
    symbol.position.set(0, 0.047, 0.003);
    label.add(symbol);
    function emboss(geometry: THREE.BufferGeometry, x = 0, y = 0, z = 0, rotation = 0): void {
      const piece = new THREE.Mesh(geometry, brass);
      piece.position.set(x, y, z);
      piece.rotation.z = rotation;
      piece.raycast = () => undefined;
      ownedGeometry.push(geometry);
      symbol.add(piece);
    }
    if (action === 'settings') emboss(cogGeometry(0.023));
    else if (action === 'deck') {
      const card = new THREE.Shape();
      card.moveTo(-0.012, -0.017);
      card.lineTo(0.012, -0.017);
      card.lineTo(0.012, 0.017);
      card.lineTo(-0.012, 0.017);
      card.closePath();
      const cut = new THREE.Path();
      cut.moveTo(-0.009, -0.014);
      cut.lineTo(-0.009, 0.014);
      cut.lineTo(0.009, 0.014);
      cut.lineTo(0.009, -0.014);
      cut.closePath();
      card.holes.push(cut);
      for (const tilt of [-0.32, 0.18])
        emboss(
          new THREE.ExtrudeGeometry(card, { depth: 0.001, bevelEnabled: false }),
          -tilt * 0.023,
          0,
          tilt * 0.004,
          tilt,
        );
    } else {
      symbol.rotation.z = -0.55;
      emboss(new THREE.TorusGeometry(0.008, 0.0025, 8, 20), 0, 0.012);
      emboss(new THREE.BoxGeometry(0.0045, 0.028, 0.003), 0, -0.01);
      emboss(new THREE.BoxGeometry(0.012, 0.004, 0.003), 0.004, -0.02);
    }
  }
  const key = new THREE.DirectionalLight(0xffe3b5, 2.2);
  key.position.set(-1.4, 2.1, 2.4);
  rim.add(key, key.target);
  return () => {
    rim.removeFromParent();
    for (const geometry of ownedGeometry) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
    for (const batch of [teeth, heads, slots]) batch.dispose();
  };
}
