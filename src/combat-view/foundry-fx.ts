import * as THREE from 'three';
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

function plating(): THREE.Group {
  const root = new THREE.Group();
  const shape = new THREE.Shape();
  shape.moveTo(-0.1, 0.035);
  shape.lineTo(-0.078, 0.057);
  shape.quadraticCurveTo(0, 0.035, 0.078, 0.057);
  shape.lineTo(0.1, 0.035);
  shape.lineTo(0.087, -0.026);
  shape.quadraticCurveTo(0, -0.074, -0.087, -0.026);
  shape.closePath();
  for (let i = 0; i < 3; i++) {
    const tile = new THREE.Group();
    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: 0.012,
      bevelEnabled: true,
      bevelSize: 0.003,
      bevelThickness: 0.002,
      bevelSegments: 1,
      curveSegments: 6,
    });
    const rim = mesh(geom, 0xd9ae60);
    const panel = mesh(geom, i % 2 === 0 ? 0x496fa9 : 0x2d477b);
    panel.scale.set(0.88, 0.78, 0.5);
    panel.position.z = 0.01;
    const stud = mesh(
      new THREE.CylinderGeometry(0.013, 0.018, 0.012, 9).rotateX(Math.PI / 2),
      0xffca77,
    );
    stud.position.z = 0.019;
    tile.add(rim, panel, stud);
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
  materials: THREE.MeshBasicMaterial[];
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

  constructor(private readonly reducedMotion = false) {
    super();
    this.name = 'foundry-fx';
    const make = (root: THREE.Group, id: Defense): DefensePose => {
      root.name = `fx-${id}`;
      root.visible = false;
      this.add(root);
      const materials: THREE.MeshBasicMaterial[] = [];
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) materials.push(o.material);
      });
      return { root, materials, age: LIFETIME, height: 0 };
    };
    this.poses = {
      'rivet-plate': make(plating(), 'rivet-plate'),
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
    this.traverse((node) => {
      if (node instanceof THREE.Mesh || node instanceof THREE.Points) {
        geometries.add(node.geometry);
        node.material.dispose();
      }
    });
    for (const geometry of geometries) geometry.dispose();
    this.dustMap.dispose();
    this.removeFromParent();
  }
}
