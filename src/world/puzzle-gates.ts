import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SteamPuffs } from '../combat-view/steam-puffs.ts';
import type { PbrSet } from './materials.ts';

type Kind = 'counterweight' | 'pressure';
type Finish = 'steel' | 'brass';

class Castings {
  private readonly parts: Record<Finish, THREE.BufferGeometry[]> = { steel: [], brass: [] };

  part(finish: Finish, geo: THREE.BufferGeometry, x: number, y: number, z: number): void {
    geo.translate(x, y, z);
    this.parts[finish].push(geo.index ? geo.toNonIndexed() : geo);
  }

  box(finish: Finish, x: number, y: number, z: number, w: number, h: number, d: number): void {
    this.part(finish, new THREE.BoxGeometry(w, h, d), x, y, z);
  }

  disk(
    finish: Finish,
    x: number,
    y: number,
    z: number,
    radius: number,
    depth: number,
    sides = 24,
  ): void {
    const geo = new THREE.CylinderGeometry(radius, radius, depth, sides).rotateX(Math.PI / 2);
    this.part(finish, geo, x, y, z);
  }

  /** Raised cast panel with cropped corners and a narrow bevel that catches the room probe. */
  plate(x: number, y: number, z: number, w: number, h: number, depth: number): void {
    const a = w / 2 - 0.008,
      b = h / 2 - 0.008,
      corner = 0.055;
    const shape = new THREE.Shape();
    shape.moveTo(-a + corner, -b);
    shape.lineTo(a - corner, -b);
    shape.lineTo(a, -b + corner);
    shape.lineTo(a, b - corner);
    shape.lineTo(a - corner, b);
    shape.lineTo(-a + corner, b);
    shape.lineTo(-a, b - corner);
    shape.lineTo(-a, -b + corner);
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: depth - 0.016,
      bevelThickness: 0.008,
      bevelSize: 0.008,
      bevelSegments: 1,
    }).center();
    this.part('steel', geo, x, y, z);
  }

  install(root: THREE.Object3D, finishes: Record<Finish, THREE.MeshStandardMaterial>): void {
    for (const finish of ['steel', 'brass'] as const) {
      if (!this.parts[finish].length) continue;
      const geometry = mergeGeometries(this.parts[finish]);
      const positions = geometry.getAttribute('position'),
        uv = geometry.getAttribute('uv');
      const a = new THREE.Vector3(),
        b = new THREE.Vector3(),
        c = new THREE.Vector3();
      for (let i = 0; i < positions.count; i += 3) {
        a.fromBufferAttribute(positions, i);
        b.fromBufferAttribute(positions, i + 1).sub(a);
        c.fromBufferAttribute(positions, i + 2).sub(a);
        b.cross(c);
        const x = Math.abs(b.x),
          y = Math.abs(b.y),
          z = Math.abs(b.z);
        for (let v = i; v < i + 3; v++) {
          const px = positions.getX(v),
            py = positions.getY(v),
            pz = positions.getZ(v);
          uv.setXY(v, x > y && x > z ? pz : px, y > x && y > z ? pz : py);
        }
      }
      const mesh = new THREE.Mesh(geometry, finishes[finish]);
      mesh.name = `${root.name}-${finish}`;
      root.add(mesh);
    }
  }
}

/** The moving member descends into the threshold pocket between two joined room floors. */
export class PuzzleGateVisual {
  readonly object = new THREE.Group();
  readonly handle = new THREE.Group();
  readonly pickTarget: THREE.Object3D;
  private readonly leaf = new THREE.Group();
  private readonly finishes = {
    steel: new THREE.MeshStandardMaterial({
      name: 'gate-gunmetal',
      color: 0x657279,
      metalness: 0.43,
      roughness: 0.65,
    }),
    brass: new THREE.MeshStandardMaterial({
      name: 'gate-brass',
      color: 0xc59b58,
      metalness: 0.63,
      roughness: 0.53,
    }),
  };
  private readonly travel: number;
  private goal = 0;
  private rattling = 0;
  private readonly steam?: SteamPuffs;
  private steamTime = 0;
  private reducedSteam = false;

  constructor(kind: Kind, width: number, height: number) {
    this.object.name = `puzzle-gate-${kind}`;
    this.leaf.name = kind === 'pressure' ? 'pressure-door-panel' : 'counterweight-grille';
    this.pickTarget = kind === 'pressure' ? this.leaf : this.handle;
    this.travel = height + 0.055;
    const half = width / 2;
    const frame = new Castings(),
      leaf = new Castings(),
      handle = new Castings();
    for (const side of [-1, 1]) {
      // The cheeks confine the panel edge. Their inside faces are stepped in from the architectural jamb.
      const jamb = side * (half - 0.018);
      frame.box('steel', jamb, height / 2, 0, 0.054, height, 0.096);
      for (const face of [-1, 1]) {
        frame.box('brass', jamb, height / 2, face * 0.061, 0.043, height, 0.026);
        for (const y of [0.13, height / 2, height - 0.13])
          frame.disk('steel', jamb, y, face * 0.076, 0.013, 0.009, 6);
      }
    }
    frame.box('steel', 0, height + 0.012, 0, width + 0.04, 0.075, 0.16);
    for (const face of [-1, 1]) {
      frame.box('brass', 0, height + 0.022, face * 0.081, width - 0.03, 0.016, 0.014);
      frame.box('steel', 0, 0.013, face * 0.157, width - 0.045, 0.026, 0.054);
      frame.box('brass', 0, 0.025, face * 0.166, width - 0.09, 0.008, 0.013);
    }
    frame.install(this.object, this.finishes);

    if (kind === 'pressure') {
      leaf.box('steel', 0, height / 2, 0, width - 0.052, height - 0.01, 0.058);
      for (const side of [-1, 1]) {
        for (const y of [height * 0.25, height * 0.75]) {
          leaf.plate(0, y, side * 0.036, width - 0.19, height / 2 - 0.09, 0.027);
          for (const x of [-half + 0.155, half - 0.155])
            for (const dy of [-height / 4 + 0.114, height / 4 - 0.114])
              leaf.disk('brass', x, y + dy, side * 0.053, 0.019, 0.013, 6);
        }
        leaf.box('brass', 0, height / 2, side * 0.036, width - 0.15, 0.022, 0.015);
      }
    } else {
      for (let i = -5; i <= 5; i++) {
        const x = (i * (width - 0.19)) / 10;
        leaf.part(
          'steel',
          new THREE.CylinderGeometry(0.029, 0.029, height - 0.012, 8),
          x,
          height / 2,
          0,
        );
        for (const y of [0.275, height - 0.275])
          leaf.part('brass', new THREE.CylinderGeometry(0.037, 0.037, 0.047, 8), x, y, 0);
      }
      for (const y of [0.045, 0.275, 1.05, height - 0.275, height - 0.045])
        leaf.box('steel', 0, y, 0, width - 0.057, 0.045, 0.039);
    }
    leaf.install(this.leaf, this.finishes);

    this.handle.name = 'puzzle-gate-handle';
    this.handle.position.y = 1.05;
    this.handle.userData.gatePart = 'handle';
    for (const side of [-1, 1]) {
      handle.disk('brass', 0, 0, side * 0.054, kind === 'pressure' ? 0.15 : 0.078, 0.042);
      handle.disk('steel', 0, 0, side * 0.083, 0.069, 0.045, 12);
      if (kind === 'pressure') {
        for (let i = 0; i < 3; i++) {
          const a = (i * 2 * Math.PI) / 3;
          const spoke = new THREE.BoxGeometry(0.12, 0.019, 0.024).rotateZ(a);
          handle.part('brass', spoke, 0.075 * Math.cos(a), 0.075 * Math.sin(a), side * 0.112);
        }
        handle.part('brass', new THREE.TorusGeometry(0.14, 0.016, 8, 32), 0, 0, side * 0.112);
        handle.disk('brass', 0.099, 0.099, side * 0.127, 0.026, 0.035, 6);
        handle.disk('steel', 0.099, 0.099, side * 0.146, 0.013, 0.004);
      }
      handle.disk('brass', 0, 0, side * 0.103, 0.044, 0.032, 8);
    }
    handle.install(this.handle, this.finishes);
    if (kind === 'pressure') {
      this.steam = new SteamPuffs(6, new THREE.Color(0xe1eeed));
      this.steam.name = 'pressure-gate-steam';
      this.steam.position.copy(this.handle.position);
      this.object.add(this.steam);
    }
    this.leaf.add(this.handle);
    this.object.add(this.leaf);
  }

  dress(set: PbrSet, environment: THREE.Texture | null): void {
    const { steel, brass } = this.finishes;
    for (const [material, slot] of [
      [steel, 'brass-aged'],
      [brass, 'brass-polished'],
    ] as const) {
      const source = set.materials.get(slot);
      if (!source) continue;
      material.map = source.map;
      material.normalMap = source.normalMap;
      material.normalScale.setScalar(material === steel ? 0.13 : 0.21);
      material.roughnessMap = source.roughnessMap;
      material.roughness = material === steel ? 0.95 : 0.88;
      material.envMap = environment;
      material.envMapIntensity = material === steel ? 0.58 : 0.72;
      // Balance aged brass pigment to a cool gunmetal while retaining the actual worn grain.
      if (material === steel) material.color.setRGB(0.26, 0.48, 1.73);
      else material.color.setRGB(0.93, 0.88, 0.71);
      material.needsUpdate = true;
    }
  }

  setOpen(open: boolean, immediate = false): void {
    this.goal = open ? -this.travel : 0;
    if ((open || immediate) && this.steam) this.steam.visible = false;
    if (immediate) {
      this.leaf.position.set(0, this.goal, 0);
      this.leaf.visible = !open;
      this.rattling = 0;
    } else this.leaf.visible = true;
  }

  rattle(reducedMotion = false): void {
    if (this.goal !== 0) return;
    if (!reducedMotion) this.rattling = 0.22;
    if (this.steam) {
      this.steamTime = 0;
      this.reducedSteam = reducedMotion;
      this.steam.visible = true;
      this.updateSteam(0);
    }
  }

  private updateSteam(dt: number): void {
    const steam = this.steam;
    if (!steam?.visible) return;
    steam.position.x = this.leaf.position.x;
    this.steamTime += dt;
    let visible = false;
    for (let i = 0; i < 6; i++) {
      const lobe = Math.floor(i / 2);
      const age = (this.steamTime - (this.reducedSteam ? 0 : lobe * 0.11)) / 0.58;
      if (age < 0 || age >= 1) {
        steam.hide(i);
        continue;
      }
      const rise = this.reducedSteam ? 0.12 + lobe * 0.23 : age;
      const side = i % 2 ? -1 : 1;
      steam.puff(
        i,
        0.099 + 0.16 * rise + 0.023 * Math.sin(lobe * 2.4 + rise * 3),
        0.099 + 0.25 * rise * rise,
        side * (0.154 + 0.21 * rise),
        0.078 + 0.18 * rise,
        0.86 * (1 - age),
        lobe * 1.8 + rise * 0.35,
      );
      visible = true;
    }
    steam.commit(visible);
  }

  update(dt: number): void {
    this.leaf.position.y = THREE.MathUtils.damp(this.leaf.position.y, this.goal, 7, dt);
    this.leaf.visible = this.leaf.position.y > -this.travel + 0.002;
    this.rattling = Math.max(0, this.rattling - dt);
    this.leaf.position.x = Math.sin(this.rattling * 72) * this.rattling * 0.038;
    this.updateSteam(dt);
  }

  dispose(): void {
    this.steam?.removeFromParent();
    this.steam?.dispose();
    this.object.removeFromParent();
    this.object.traverse((node) => {
      if (node instanceof THREE.Mesh) node.geometry.dispose();
    });
    for (const material of Object.values(this.finishes)) material.dispose();
  }
}
