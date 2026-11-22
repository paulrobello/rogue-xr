import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { discTexture } from '../sigil-plate/sparks.ts';

const LIFETIME = 0.85;
const PARTICLES = 36;
type Defense = 'rivet-plate' | 'brass-bulwark' | 'anchor-glyph' | 'quench-seal' | 'counterstroke';

function mesh(geometry: THREE.BufferGeometry, color: number): THREE.Mesh {
  return new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      forceSinglePass: true,
      toneMapped: false,
    }),
  );
}

/** Each half pivots at its outer edge, bringing the two bevelled inner edges together. */
function bulwark(): THREE.Group {
  const root = new THREE.Group();
  for (const sign of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.x = sign * 0.185;
    const outline = new THREE.Shape();
    outline.moveTo(0, 0.07);
    outline.lineTo(-sign * 0.028, 0.11);
    outline.lineTo(-sign * 0.18, 0.132);
    outline.lineTo(-sign * 0.18, -0.132);
    outline.lineTo(-sign * 0.046, -0.085);
    outline.lineTo(0, -0.028);
    outline.closePath();
    const panelGeometry = new THREE.ExtrudeGeometry(outline, {
      depth: 0.012,
      bevelEnabled: true,
      bevelSegments: 1,
      bevelThickness: 0.003,
      bevelSize: 0.003,
    });
    const face = mesh(panelGeometry, 0xdaab56);
    const inset = mesh(panelGeometry, 0x98662e);
    inset.scale.set(0.8, 0.79, 0.7);
    inset.position.set(-sign * 0.018, 0.003, 0.012);
    const boss = mesh(new THREE.OctahedronGeometry(0.029), 0x516fa5);
    boss.position.set(face.position.x, 0, 0.025);
    hinge.add(face, inset, boss);
    root.add(hinge);
  }
  return root;
}

function plating(environment: THREE.Texture | null): THREE.Group {
  const root = new THREE.Group();
  const alloy = (
    color: number,
    metalness: number,
    roughness: number,
    emissive: number,
  ): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({
      color,
      metalness,
      roughness,
      emissive,
      emissiveIntensity: 0.28,
      envMap: environment,
      envMapIntensity: 0.62,
      transparent: true,
      depthWrite: false,
    });
  const brass = alloy(0x95632e, 0.76, 0.43, 0x54331a);
  const steel = alloy(0x27486a, 0.57, 0.42, 0x172b46);
  const bolts = alloy(0xd0a55d, 0.68, 0.33, 0x85632c);

  const outline = new THREE.Shape();
  outline.moveTo(-0.108, 0.031);
  outline.lineTo(-0.08, 0.057);
  outline.lineTo(0, 0.047);
  outline.lineTo(0.08, 0.057);
  outline.lineTo(0.108, 0.031);
  outline.lineTo(0.095, -0.022);
  outline.lineTo(0.06, -0.046);
  outline.lineTo(0, -0.063);
  outline.lineTo(-0.06, -0.046);
  outline.lineTo(-0.095, -0.022);
  outline.closePath();
  const rim = new THREE.ExtrudeGeometry(outline, {
    depth: 0.014,
    bevelSize: 0.003,
    bevelThickness: 0.003,
    bevelSegments: 2,
  });

  const cheeks = [-1, 1].map((side) => {
    const cheek = new THREE.Shape();
    cheek.moveTo(side * 0.0025, 0.038);
    cheek.lineTo(side * 0.079, 0.047);
    cheek.lineTo(side * 0.095, 0.028);
    cheek.lineTo(side * 0.084, -0.014);
    cheek.lineTo(side * 0.052, -0.037);
    cheek.lineTo(side * 0.0025, -0.052);
    cheek.closePath();
    const geometry = new THREE.ExtrudeGeometry(cheek, {
      depth: 0.005,
      bevelSize: 0.002,
      bevelThickness: 0.002,
      bevelSegments: 1,
    }).translate(0, 0, 0.015);
    const points = geometry.getAttribute('position');
    for (let i = 0; i < points.count; i++)
      points.setZ(i, points.getZ(i) + 0.011 * Math.max(0, 1 - Math.abs(points.getX(i)) / 0.087));
    geometry.computeVertexNormals();
    return geometry;
  });
  const face = mergeGeometries(cheeks);
  for (const geometry of cheeks) geometry.dispose();

  const stud = new THREE.CylinderGeometry(0.0078, 0.0105, 0.009, 12).rotateX(Math.PI / 2);
  const rivet = stud.toNonIndexed();
  stud.dispose();
  const fasteners = [
    [-0.069, 0.028],
    [0.069, 0.028],
    [-0.057, -0.025],
    [0.057, -0.025],
  ].map(([x, y]) => rivet.clone().translate(x, y, 0.037));
  const hardware = mergeGeometries(fasteners);
  for (const geometry of fasteners) geometry.dispose();
  rivet.dispose();
  for (let i = 0; i < 3; i++) {
    const tile = new THREE.Group();
    const layers = [
      new THREE.Mesh(rim, brass),
      new THREE.Mesh(face, steel),
      new THREE.Mesh(hardware, bolts),
    ];
    // The translucent pieces fade as one plate; rivets must draw after the metal beneath them.
    tile.renderOrder = i;
    for (const [index, layer] of layers.entries()) {
      layer.renderOrder = index;
      tile.add(layer);
    }
    tile.scale.setScalar(1 - i * 0.1);
    tile.position.set(0, (i - 1) * 0.061, i * 0.023);
    root.add(tile);
  }
  return root;
}

function anchor(): THREE.Group {
  const root = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(-0.014, 0.087);
  shape.lineTo(0.014, 0.087);
  shape.lineTo(0.014, -0.055);
  shape.quadraticCurveTo(0.069, -0.05, 0.096, 0.019);
  shape.lineTo(0.107, -0.023);
  shape.quadraticCurveTo(0.073, -0.098, 0, -0.12);
  shape.quadraticCurveTo(-0.073, -0.098, -0.107, -0.023);
  shape.lineTo(-0.096, 0.019);
  shape.quadraticCurveTo(-0.069, -0.05, -0.014, -0.055);
  shape.closePath();
  root.add(
    mesh(
      new THREE.ExtrudeGeometry(shape, { depth: 0.014, bevelEnabled: false, curveSegments: 8 }),
      0x75e3a1,
    ),
  );
  for (let i = 0; i < 3; i++) {
    const link = mesh(new THREE.TorusGeometry(0.023, 0.005, 5, 14), 0xddb563);
    link.scale.y = 1.25;
    link.rotation.y = (i % 2) * 0.95;
    link.position.set(0, 0.098 + i * 0.042, 0.008);
    root.add(link);
  }
  return root;
}

function quenchWard(): THREE.Group {
  const g = new THREE.Group();
  const outline = new THREE.Shape();
  outline.moveTo(-0.105, 0.1);
  outline.quadraticCurveTo(-0.035, 0.075, 0, 0.132);
  outline.quadraticCurveTo(0.04, 0.075, 0.105, 0.1);
  outline.quadraticCurveTo(0.107, -0.04, 0, -0.13);
  outline.quadraticCurveTo(-0.107, -0.04, -0.105, 0.1);
  g.add(mesh(new THREE.ShapeGeometry(outline, 8), 0x54bdba));
  for (const dir of [-1, 1]) {
    for (const [x, y, tilt] of [
      [0.045, -0.032, 0.7],
      [0.067, -0.012, 0.98],
      [0.029, -0.061, 0.39],
    ]) {
      const vein = mesh(new THREE.BoxGeometry(0.004, 0.058, 0.004), 0xedf6e2);
      vein.position.set(dir * x, y, 0.006);
      vein.rotation.z = -dir * tilt;
      g.add(vein);
    }
  }
  const core = mesh(new THREE.OctahedronGeometry(0.027), 0xffb655);
  core.position.set(0, 0.015, 0.011);
  g.add(core);
  return g;
}

function counterGuard(): THREE.Group {
  const g = new THREE.Group();
  const hinge = mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.13, 9), 0xeac471);
  g.add(hinge);
  for (const sign of [-1, 1]) {
    const leaf = mesh(new THREE.BoxGeometry(0.068, 0.137, 0.014), 0x9f3432);
    leaf.position.set(sign * 0.036, 0, 0);
    leaf.rotation.z = -sign * 0.12;
    g.add(leaf);
  }
  return g;
}

interface DefensePose {
  root: THREE.Group;
  materials: THREE.Material[];
  age: number;
  height: number;
}

/** Card-specific silhouettes in combat world coordinates. A resting effect has no draw calls. */
export class FoundryFx extends THREE.Group {
  private readonly poses: Record<Defense, DefensePose>;
  private readonly dustMap = discTexture();
  private readonly rustPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly destinations = new Float32Array(PARTICLES * 3);
  private rustAge = LIFETIME;
  private readonly values = new Float32Array(PARTICLES * 3);

  constructor(
    private readonly reducedMotion = false,
    environment: THREE.Texture | null = null,
  ) {
    super();
    this.name = 'foundry-fx';
    const make = (root: THREE.Group, id: Defense): DefensePose => {
      root.name = `fx-${id}`;
      root.visible = false;
      this.add(root);
      const materials = new Set<THREE.Material>();
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) materials.add(o.material);
      });
      return { root, materials: [...materials], age: LIFETIME, height: 0 };
    };
    this.poses = {
      'rivet-plate': make(plating(environment), 'rivet-plate'),
      'brass-bulwark': make(bulwark(), 'brass-bulwark'),
      'anchor-glyph': make(anchor(), 'anchor-glyph'),
      'quench-seal': make(quenchWard(), 'quench-seal'),
      counterstroke: make(counterGuard(), 'counterstroke'),
    };
    this.poseEntries = Object.entries(this.poses) as [Defense, DefensePose][];
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.values, 3).setUsage(THREE.DynamicDrawUsage),
    );
    const material = new THREE.PointsMaterial({
      color: 0xd97835,
      map: this.dustMap,
      size: 0.054,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    this.rustPoints = new THREE.Points(geometry, material);
    this.rustPoints.name = 'fx-rust-spray';
    this.rustPoints.visible = false;
    this.rustPoints.frustumCulled = false;
    this.add(this.rustPoints);
  }

  play(
    cardId: string,
    origin: THREE.Vector3,
    player: THREE.Vector3,
    targets: readonly THREE.Vector3[],
    ward?: THREE.Vector3,
    delay = 0,
  ): void {
    const id = cardId.replace(/\+$/, '');
    if (id === 'rust-spray') {
      if (!targets.length) return;
      this.rustAge = -delay;
      this.rustPoints.position.copy(origin);
      for (let i = 0; i < PARTICLES; i++) {
        const target = targets[i % targets.length] as THREE.Vector3;
        this.destinations[i * 3] = target.x - origin.x;
        this.destinations[i * 3 + 1] = target.y - origin.y;
        this.destinations[i * 3 + 2] = target.z - origin.z;
      }
      return;
    }
    if (!Object.hasOwn(this.poses, id)) return;
    const pose = this.poses[id as Defense];
    pose.root.position.copy(id === 'anchor-glyph' ? origin : (ward ?? origin));
    pose.height = pose.root.position.y;
    pose.root.lookAt(player);
    pose.age = -delay;
  }

  update(dt: number): void {
    const step = Math.max(0, dt);
    for (const [id, pose] of this.poseEntries) {
      if (pose.age >= LIFETIME) continue;
      pose.age += step;
      pose.root.visible = pose.age >= 0 && pose.age < LIFETIME;
      if (!pose.root.visible) continue;
      const snap = this.reducedMotion ? 1 : Math.min(1, pose.age / 0.25);
      const fade = Math.min(1, pose.age / 0.08, (LIFETIME - pose.age) / 0.25);
      for (const mat of pose.materials) mat.opacity = fade;
      if (id === 'brass-bulwark') {
        pose.root.children[0].rotation.y = (1 - snap) * 1.35;
        pose.root.children[1].rotation.y = -(1 - snap) * 1.35;
      } else if (id === 'rivet-plate') {
        pose.root.children.forEach((part, i) => {
          part.position.x = (i - 1) * (1 - snap) * 0.13;
        });
      } else if (id === 'anchor-glyph') {
        pose.root.position.y = pose.height + 0.1 * (1 - snap);
      } else if (id === 'counterstroke') {
        pose.root.scale.x = 0.28 + 0.72 * snap;
        pose.root.rotation.z = (1 - snap) * -0.52;
      } else if (id === 'quench-seal') {
        pose.materials[0].opacity = fade * (0.35 + 0.35 * snap);
      }
    }
    if (this.rustAge >= LIFETIME) return;
    this.rustAge += step;
    this.rustPoints.visible = this.rustAge >= 0 && this.rustAge < LIFETIME;
    if (!this.rustPoints.visible) return;
    const progress = this.rustAge / LIFETIME;
    for (let i = 0; i < PARTICLES; i++) {
      const along = Math.min(1, Math.max(0, progress * 1.7 - (i % 6) * 0.075));
      const radius = (this.reducedMotion ? 0.065 : 0.13) * along;
      this.values[i * 3] = this.destinations[i * 3] * along + Math.sin(i * 2.4) * radius;
      this.values[i * 3 + 1] = this.destinations[i * 3 + 1] * along + Math.cos(i * 2.4) * radius;
      this.values[i * 3 + 2] = this.destinations[i * 3 + 2] * along + Math.sin(i * 0.91) * radius;
    }
    this.rustPoints.geometry.attributes.position.needsUpdate = true;
    this.rustPoints.material.opacity = Math.min(0.88, (1 - progress) * 2);
  }

  private readonly poseEntries: [Defense, DefensePose][];

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.traverse((node) => {
      if (node instanceof THREE.Mesh || node instanceof THREE.Points) {
        geometries.add(node.geometry);
        materials.add(node.material);
      }
    });
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    this.dustMap.dispose();
    this.removeFromParent();
  }
}
