import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import { type Box, type Facing, rotateRect, templateById } from '../content/rooms.ts';
import type { FloorPlan } from '../floor/generate.ts';
import { PALETTE } from '../palette.ts';
import { PRESSURE_REWARD, type PressureState, pressureTarget } from '../rules/pressure.ts';
import type { FloorWorld } from './floor-world.ts';

type Valve = 0 | 1 | 2;
const FIXTURES = ['manifold', 'gallery-pipes', 'accumulator-bank'] as const;
type Fixture = (typeof FIXTURES)[number];
const VALVES = [0, 1, 2] as const;
const CIRCUITS = ['A', 'B', 'C'] as const;
const WHEEL_X = [-0.82, 0, 0.82];
const PUMP_Z = -3.0;
const PIPE_X = -0.81;
const BANK_X = [-2.2, 2.2] as const;
const BANK_Z = -3.5;
const FACING_IN: Record<Facing, number> = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 };
const NORMAL = new THREE.Vector3(0, 0, 1);

export type PressureArt = Readonly<Partial<Record<Fixture, THREE.Group>>>;

export async function loadPressureArt(): Promise<PressureArt> {
  const loader = new GLTFLoader();
  const out: Partial<Record<Fixture, THREE.Group>> = {};
  await Promise.all(
    FIXTURES.map(async (kind) => {
      try {
        out[kind] = (await loader.loadAsync(`/assets/props/pressure-works/${kind}.glb`)).scene;
      } catch (error) {
        console.warn(`Pressure Works ${kind} unavailable`, error);
      }
    }),
  );
  return out;
}

/** The authored fixtures extend inwards from the unrotated room walls. */
export function pressureColliders(plan: FloorPlan, index: number): Box[] {
  const wing = plan.pressureWing;
  if (!wing || (index !== wing.gallery && index !== wing.pumpRoom)) return [];
  const placed = plan.rooms[index];
  const [x, z] = placed.position;
  const box = (x0: number, z0: number, x1: number, z1: number, top: number): Box => {
    const r = rotateRect({ min: [x0, z0], max: [x1, z1] }, placed.turns);
    return { min: [x + r.min[0], 0, z + r.min[1]], max: [x + r.max[0], top, z + r.max[1]] };
  };
  if (index === wing.gallery) return [box(-1, -1.66, PIPE_X + 0.18, 1.66, 2.22)];
  return [
    box(-1.42, PUMP_Z - 0.41, 1.42, PUMP_Z + 0.49, 2.22),
    ...BANK_X.map((cx) => box(cx - 1.31, BANK_Z, cx + 1.31, BANK_Z + 0.38, 2.85)),
  ];
}

export class PressureWorks {
  readonly pump = new THREE.Group();
  readonly gallery = new THREE.Group();
  readonly entrance = new THREE.Group();
  readonly targets: THREE.Mesh[] = [];
  private readonly parts: Record<Fixture, THREE.Group> = {
    manifold: new THREE.Group(),
    'gallery-pipes': new THREE.Group(),
    'accumulator-bank': new THREE.Group(),
  };
  private readonly labels: CanvasLabel[] = [];
  private readonly values: (CanvasLabel | null)[] = [];
  private readonly heading: CanvasLabel | null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly hits: THREE.Intersection[] = [];
  private readonly box = new THREE.Box3();
  private readonly crossing = new THREE.Vector3();
  private readonly spin = new THREE.Quaternion();
  private readonly wheels: {
    node: THREE.Object3D;
    rest: THREE.Quaternion;
    goal: THREE.Quaternion;
  }[] = [];
  private readonly fallbackGeometries: THREE.BufferGeometry[] = [];
  private readonly fallbackMaterials: THREE.Material[] = [];
  private turning = false;
  private painted = false;
  private state: PressureState = { dials: [1, 1, 1], solved: false };
  constructor(
    private readonly world: FloorWorld,
    private readonly wing: NonNullable<FloorPlan['pressureWing']>,
  ) {
    const { gallery, pumpRoom, source } = this.wing;
    this.pump.name = 'pressure-regulator';
    this.pump.position.z = PUMP_Z;
    this.gallery.name = 'pressure-pipe-gallery';
    this.gallery.position.x = PIPE_X;
    this.gallery.rotation.y = Math.PI / 2;
    this.entrance.name = 'pressure-works-entrance';
    const door = templateById(world.plan.rooms[source.room].templateId).doors.find(
      (d) => d.id === source.door,
    );
    if (!door) throw new Error('Pressure Works entrance is missing its host door');
    this.entrance.position.set(...door.position);
    this.entrance.rotation.y = FACING_IN[door.facing];
    this.entrance.translateZ(0.18);
    world.roomGroups[pumpRoom].add(this.pump);
    world.roomGroups[gallery].add(this.gallery);
    world.roomGroups[source.room].add(this.entrance);
    this.pump.add(this.parts.manifold);
    this.gallery.add(this.parts['gallery-pipes']);
    world.roomGroups[pumpRoom].add(this.parts['accumulator-bank']);
    const shell = new THREE.MeshBasicMaterial({ color: PALETTE.walnut });
    const metal = new THREE.MeshBasicMaterial({ color: PALETTE.brass });
    const invisible = new THREE.MeshBasicMaterial({ visible: false });
    this.fallbackMaterials.push(shell, metal, invisible);
    const cabinet = new THREE.BoxGeometry(2.65, 1.4, 0.67);
    const wheel = new THREE.TorusGeometry(0.21, 0.038, 8, 24);
    const spoke = new THREE.BoxGeometry(0.4, 0.034, 0.03);
    const hit = new THREE.PlaneGeometry(0.59, 0.87);
    this.fallbackGeometries.push(cabinet, wheel, spoke, hit);
    const body = new THREE.Mesh(cabinet, shell);
    body.position.y = 0.7;
    this.parts.manifold.add(body);
    this.heading = this.sign(this.pump, 'regulator-heading', 2.04, 0.4, 0, 1.96, 0.49);
    for (const i of VALVES) {
      const knob = new THREE.Mesh(wheel, metal);
      knob.position.set(WHEEL_X[i], 1.05, 0.39);
      knob.name = `valve-${i}`;
      knob.add(new THREE.Mesh(spoke, metal));
      this.parts.manifold.add(knob);
      const target = new THREE.Mesh(hit, invisible);
      target.name = `pressure-wheel-${i}`;
      target.position.set(WHEEL_X[i], 1.19, 0.51);
      this.pump.add(target);
      this.targets.push(target);
      this.values.push(
        this.sign(this.pump, `pressure-reading-${i}`, 0.55, 0.26, WHEEL_X[i], 1.54, 0.48),
      );
    }
    const code = pressureTarget(world.plan.seed);
    this.paint(
      this.sign(this.entrance, 'pressure-works-nameplate', 1.52, 0.29, 0, 2.64, 0),
      'Pressure Works',
    );
    this.paint(
      this.sign(this.gallery, 'pressure-calibration-record', 1.62, 0.6, 0, 1.68, 0.17),
      'Pipe Gallery',
      code.map((n, i) => `${CIRCUITS[i]} = ${n}`).join('       '),
      'Required pump settings',
    );
    this.bindWheels();
    this.sync(this.state);
  }

  private sign(
    group: THREE.Object3D,
    name: string,
    width: number,
    height: number,
    x: number,
    y: number,
    z: number,
  ): CanvasLabel | null {
    if (typeof document === 'undefined' || !document.createElement('canvas').getContext('2d'))
      return null;
    const label = new CanvasLabel(1024, Math.round((1024 * height) / width), width, false);
    label.mesh.name = name;
    label.mesh.position.set(x, y, z);
    label.mesh.raycast = () => undefined;
    group.add(label.mesh);
    this.labels.push(label);
    return label;
  }

  private paint(label: CanvasLabel | null, title: string, detail = '', kicker = ''): void {
    label?.draw((ctx, w, h) => {
      ctx.fillStyle = '#18322f';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = PALETTE.brass;
      ctx.lineWidth = 5;
      ctx.strokeRect(5, 5, w - 10, h - 10);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = PALETTE.parchment;
      if (kicker) {
        ctx.font = `600 ${Math.round(h * 0.12)}px system-ui, sans-serif`;
        ctx.fillText(kicker, w / 2, h * 0.48);
      }
      ctx.font = `bold ${Math.round(h * (detail ? 0.24 : 0.55))}px system-ui, sans-serif`;
      ctx.fillText(title, w / 2, h * (detail ? 0.23 : 0.5), w * 0.92);
      if (detail) {
        ctx.fillStyle = PALETTE.candle;
        ctx.font = `600 ${Math.round(h * (kicker ? 0.26 : 0.22))}px system-ui, sans-serif`;
        ctx.fillText(detail, w / 2, h * (kicker ? 0.76 : 0.7), w * 0.93);
      }
    });
  }

  dress(art: PressureArt): void {
    for (const kind of FIXTURES) {
      const model = art[kind];
      if (!model) continue;
      const group = this.parts[kind];
      group.clear();
      if (kind === 'accumulator-bank') {
        for (const x of BANK_X) {
          const bank = model.clone(true);
          bank.position.set(x, 0, BANK_Z);
          group.add(bank);
        }
      } else group.add(model.clone(true));
    }
    this.bindWheels();
    this.sync(this.state);
  }

  private bindWheels(): void {
    this.wheels.length = 0;
    for (const i of VALVES) {
      const node = this.parts.manifold.getObjectByName(`valve-${i}`);
      if (node)
        this.wheels[i] = { node, rest: node.quaternion.clone(), goal: node.quaternion.clone() };
    }
  }

  sync(state: PressureState, animate = false): void {
    this.turning = animate;
    const previous = this.state;
    this.state = state;
    if (!this.painted || previous.solved !== state.solved) {
      this.paint(
        this.heading,
        state.solved ? 'Pressure restored' : 'Pump Room',
        state.solved
          ? `${PRESSURE_REWARD} run cogs paid`
          : 'Set the valves to the Pipe Gallery readings',
      );
    }
    for (const i of VALVES) {
      const val = state.dials[i];
      if (!this.painted || previous.dials[i] !== val) {
        this.paint(this.values[i] ?? null, `${CIRCUITS[i]} · ${val}`);
      }
      const wheel = this.wheels[i];
      if (wheel) {
        wheel.goal
          .copy(wheel.rest)
          .premultiply(this.spin.setFromAxisAngle(NORMAL, (-(val - 1) * Math.PI * 2) / 3));
        if (!animate) wheel.node.quaternion.copy(wheel.goal);
      }
    }
    this.painted = true;
  }

  update(dt: number): void {
    if (!this.turning) return;
    this.turning = false;
    for (const wheel of this.wheels) {
      wheel.node.quaternion.rotateTowards(wheel.goal, 10 * dt);
      if (wheel.node.quaternion.angleTo(wheel.goal) > 0.001) this.turning = true;
    }
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): { valve: Valve; distance: number } | null {
    if (this.state.solved || this.world.current !== this.wing.pumpRoom) return null;
    this.raycaster.set(origin, direction);
    this.raycaster.far = 4;
    this.pump.updateWorldMatrix(true, true);
    this.hits.length = 0;
    const first = this.raycaster.intersectObjects(this.targets, false, this.hits)[0];
    if (!first) return null;
    for (const obstacle of this.world.colliders[this.wing.pumpRoom] ?? []) {
      this.box.min.fromArray(obstacle.min);
      this.box.max.fromArray(obstacle.max);
      if (
        this.raycaster.ray.intersectBox(this.box, this.crossing) &&
        this.crossing.distanceTo(origin) < first.distance - 0.015
      )
        return null;
    }
    return {
      valve: this.targets.indexOf(first.object as THREE.Mesh) as Valve,
      distance: first.distance,
    };
  }

  dispose(): void {
    for (const g of [this.pump, this.gallery, this.entrance, this.parts['accumulator-bank']])
      g.removeFromParent();
    for (const label of this.labels) label.dispose();
    for (const geo of this.fallbackGeometries) geo.dispose();
    for (const mat of this.fallbackMaterials) mat.dispose();
  }
}
