import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import provenance from '../../assets-source/props/pressure-works/provenance.json';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import { type Box, type Facing, rotateRect, templateById } from '../content/rooms.ts';
import type { FloorPlan } from '../floor/generate.ts';
import { PALETTE } from '../palette.ts';
import {
  type NormalizedPressureState,
  PRESSURE_REWARD,
  type PressureState,
} from '../rules/pressure.ts';
import type { FloorWorld } from './floor-world.ts';
import { normalizePressureState, type PressureAction, primeMiss } from './pressure-compartment.ts';

type Valve = 0 | 1 | 2;
const FIXTURES = [
  'manifold',
  'gallery-pipes',
  'accumulator-bank',
  'service-compartment',
  'pump-drive',
] as const;
type Fixture = (typeof FIXTURES)[number];
const VALVES = [0, 1, 2] as const;
const CIRCUITS = ['A', 'B', 'C'] as const;
const WHEEL_X = [-0.82, 0, 0.82];
const PUMP_Z = -3.0;
const PIPE_X = -0.898;
const BANK_X = [-2.2, 2.2] as const;
const BANK_Z = -3.5;
const FACING_IN: Record<Facing, number> = { N: 0, S: Math.PI, W: Math.PI / 2, E: -Math.PI / 2 };
const NORMAL = new THREE.Vector3(0, 0, 1);
const PRESSURE_GLBS = new Map(
  Object.entries(provenance.sha256)
    .filter(
      ([path]) => path.startsWith('public/assets/props/pressure-works/') && path.endsWith('.glb'),
    )
    .map(([path, hash]) => [path.slice('public/assets/'.length), hash] as const),
);

export type PressureArt = Readonly<Partial<Record<Fixture, THREE.Group>>>;

export async function loadPressureArt(): Promise<PressureArt> {
  const loader = new GLTFLoader();
  const out: Partial<Record<Fixture, THREE.Group>> = {};
  await Promise.all(
    FIXTURES.map(async (kind) => {
      try {
        const path = `props/pressure-works/${kind}.glb`;
        const stamp = PRESSURE_GLBS.get(path);
        out[kind] = (await loader.loadAsync(`/assets/${path}${stamp ? `?v=${stamp}` : ''}`)).scene;
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
    'service-compartment': new THREE.Group(),
    'pump-drive': new THREE.Group(),
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
  private readonly compartment = new THREE.Group();
  private readonly drawer = new THREE.Group();
  private readonly cogs = new THREE.Group();
  private readonly primer = new THREE.Group();
  private readonly compartmentTargets: THREE.Object3D[] = [];
  private steam!: THREE.Points;
  private steamMaterial!: THREE.ShaderMaterial;
  private readonly authoredCompartment = new THREE.Group();
  private readonly fallbackVisuals = new THREE.Group();
  private drawerModel?: THREE.Object3D;
  private leverModel?: THREE.Object3D;
  private goldModel?: THREE.Object3D;
  private drawerRest = 0.34;
  private readonly enabledTargets: THREE.Object3D[] = [];
  private readonly targetPoint = new THREE.Vector3();
  private readonly driveRotors: THREE.Group[] = [];
  private driveAngle = 0;
  private driveSpeed = 0;
  private steamTime = 0;

  private steamClock = 0;
  private motionEnabled = true;
  private drawerGoal = 0;
  private leverGoal = 0;
  private turning = false;
  private painted = false;
  private state: NormalizedPressureState = normalizePressureState({
    dials: [1, 1, 1],
    solved: false,
  });
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
    this.pump.add(this.parts.manifold, this.parts['pump-drive']);
    this.pump.add(this.compartment);
    this.compartment.name = 'pressure-service-compartment';

    this.compartment.add(this.authoredCompartment, this.fallbackVisuals);
    this.fallbackVisuals.add(this.drawer, this.primer);
    this.drawer.add(this.cogs);
    this.authoredCompartment.name = 'service-compartment-authored';
    this.drawer.name = 'reward-drawer';
    this.primer.name = 'primer-lever';
    this.cogs.name = 'reward-cogs';
    this.gallery.add(this.parts['gallery-pipes']);
    world.roomGroups[pumpRoom].add(this.parts['accumulator-bank']);
    const shell = new THREE.MeshBasicMaterial({ color: PALETTE.walnut });
    const metal = new THREE.MeshBasicMaterial({ color: PALETTE.brass });
    const invisible = new THREE.MeshBasicMaterial({ visible: false });
    this.fallbackMaterials.push(shell, metal, invisible);
    this.buildCompartment(shell, metal, invisible);
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
    this.paint(
      this.sign(this.entrance, 'pressure-works-nameplate', 1.52, 0.29, 0, 2.64, 0),
      'Pressure Works',
    );
    // The banner sits 4 cm off the wall. Stand the plate just proud of the cloth and between the downpipes.
    const plateDepth = -0.046;
    const mount = new THREE.BoxGeometry(0.046, 0.12, 0.05);
    const plate = new THREE.BoxGeometry(1.5, 0.55, 0.008);
    this.fallbackGeometries.push(mount, plate);
    for (const x of [-0.65, 0.65]) {
      const post = new THREE.Mesh(mount, metal);
      post.position.set(x, 1.68, plateDepth - 0.033);
      this.gallery.add(post);
    }
    const backing = new THREE.Mesh(plate, shell);
    backing.position.set(0, 1.68, plateDepth - 0.005);
    this.gallery.add(backing);
    this.paint(
      this.sign(this.gallery, 'pressure-calibration-record', 1.5, 0.55, 0, 1.68, plateDepth),
      'Pipe Gallery',
      'Recover the three service slips',
      'Calibration records missing',
    );
    const inscription = this.sign(
      this.compartment,
      'pressure-inscription',
      0.72,
      0.12,
      -0.2,
      0.626,
      0.577,
    );
    inscription?.draw((ctx, w, h) => {
      ctx.fillStyle = '#4b392a';
      ctx.fillRect(0, 0, w, h);
      ctx.font = `italic 600 ${Math.round(h * 0.53)}px Georgia,serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#1c1411';
      ctx.fillText('Pull the maker’s mark', w / 2 + 2, h / 2 + 3, w * 0.96);
      ctx.fillStyle = '#ddc8a0';
      ctx.fillText('Pull the maker’s mark', w / 2, h / 2, w * 0.96);
    });
    this.bindWheels();
    this.sync(this.state);
  }

  private buildCompartment(
    shell: THREE.Material,
    metal: THREE.Material,
    invisible: THREE.Material,
  ): void {
    const cabinet = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.9, 0.46), shell);
    this.fallbackGeometries.push(cabinet.geometry);
    cabinet.position.set(0, 0.52, 0);
    this.fallbackVisuals.add(cabinet);
    const lever = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.08), metal);
    this.fallbackGeometries.push(lever.geometry);
    lever.position.set(1.1, 0.67, 0.45);
    this.primer.add(lever);
    const drawerBody = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.23, 0.42), shell);
    this.fallbackGeometries.push(drawerBody.geometry);
    drawerBody.position.set(0, 0.23, 0.34);
    this.drawer.add(drawerBody);
    for (let i = 0; i < 3; i++) {
      const cog = new THREE.Mesh(new THREE.TorusGeometry(0.09 + i * 0.012, 0.022, 6, 12), metal);
      this.fallbackGeometries.push(cog.geometry);
      cog.position.set((i - 1) * 0.16, 0.38, 0.56);
      this.cogs.add(cog);
    }
    const target = (name: string, position: THREE.Vector3, size: [number, number]): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(...size), invisible);
      this.fallbackGeometries.push(mesh.geometry);
      mesh.name = name;
      mesh.position.copy(position);
      this.compartment.add(mesh);
      this.compartmentTargets.push(mesh);
      return mesh;
    };
    target('pressure-primer', new THREE.Vector3(1.12, 0.66, 0.64), [0.31, 0.35]);
    target('pressure-maker-mark', new THREE.Vector3(0, 0.43, 0.645), [0.42, 0.24]);
    target('pressure-reward-cogs', new THREE.Vector3(0, 0.53, 0.94), [0.98, 0.29]);
    const vapor = new THREE.BufferGeometry();
    const count = 48;
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (i % 2 === 0 ? -1 : 1) * 0.67;
      positions[i * 3 + 1] = 0.25;
      positions[i * 3 + 2] = 0.5;
      phases[i] = (i * 0.618034) % 1;
    }
    vapor.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    vapor.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
    this.fallbackGeometries.push(vapor);
    this.steamMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
      vertexShader: `
        uniform float uTime;
        attribute float phase;
        varying float life;
        varying float swirl;
        void main(){
          life=fract(uTime*.74+phase);
          swirl=phase*39.0+uTime*1.7;
          vec3 p=position;
          p.x+=sign(p.x)*(.48*life+.12*life*sin(swirl));
          p.y+=life*(.66+.24*life);
          p.z+=.48*life+.12*life*sin(swirl*.73);
          vec4 view=modelViewMatrix*vec4(p,1.0);
          gl_Position=projectionMatrix*view;
          gl_PointSize=clamp((48.0+185.0*life)/max(.55,-view.z),4.0,120.0);
        }`,
      fragmentShader: `
        uniform float uOpacity;
        varying float life;
        varying float swirl;
        void main(){
          vec2 uv=gl_PointCoord*2.0-1.0;
          float angle=atan(uv.y,uv.x);
          float edge=length(uv)+.095*sin(angle*3.0+swirl)+.05*sin(angle*5.0-swirl);
          float puff=1.0-smoothstep(.12,1.0,edge);
          float alpha=puff*smoothstep(0.,.16,life)*(1.-smoothstep(.5,1.,life))*uOpacity*.48;
          gl_FragColor=vec4(mix(vec3(.67,.74,.72),vec3(.97,.95,.87),puff),alpha);
        }`,
    });
    this.fallbackMaterials.push(this.steamMaterial);
    this.steam = new THREE.Points(vapor, this.steamMaterial);
    this.steam.name = 'pressure-steam-plumes';
    this.steam.visible = false;
    this.compartment.add(this.steam);
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
      if (kind === 'pump-drive') {
        const assembly = this.parts['pump-drive'];
        assembly.clear();
        this.driveRotors.length = 0;
        for (const [i, name] of ['gear_small', 'gear_medium'].entries()) {
          const source = model.getObjectByName(name);
          if (!source) continue;
          const pivot = new THREE.Group();
          pivot.name = `pressure-drive-${name}`;
          pivot.position.set(-1.195 + i * 0.405 * 0.76, 0.52, 0.52);
          const cog = source.clone(true);
          cog.rotation.x = Math.PI / 2;
          cog.scale.setScalar(0.76);
          pivot.add(cog);
          assembly.add(pivot);
          this.driveRotors.push(pivot);
        }
        continue;
      }
      if (kind === 'service-compartment') {
        this.authoredCompartment.clear();
        const clone = model.clone(true);
        clone.position.set(0, 0, 0);
        this.authoredCompartment.add(clone);
        this.drawerModel = clone.getObjectByName('reward-drawer');
        this.leverModel = clone.getObjectByName('primer-lever');
        this.goldModel = clone.getObjectByName('reward-cogs');
        this.drawerRest = this.drawerModel?.position.z ?? 0.34;
        this.fallbackVisuals.visible = false;
        continue;
      }
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

  sync(
    state: PressureState | NormalizedPressureState,
    animate = false,
    action?: PressureAction['action'],
  ): void {
    this.turning = animate;
    this.motionEnabled = animate;
    const previous = this.state;
    this.state = normalizePressureState(state);
    const notes = this.state.notes.filter((id) => id !== 'dispatch').length;
    this.paint(
      this.heading,
      this.state.solved ? 'Pressure restored' : 'Pump Room',
      this.state.rewardClaimed
        ? `${PRESSURE_REWARD} run cogs collected`
        : this.state.drawerOpen
          ? 'Take the cogs from the drawer'
          : this.state.solved
            ? 'The maker’s mark is unlocked'
            : notes < 3
              ? `Service slips: ${notes} of 3 · Review them in Items`
              : 'Set A, B and C, then pull the primer',
    );
    for (const i of VALVES) {
      const val = this.state.dials[i];
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
    this.drawerGoal = this.state.drawerOpen ? 0.42 : 0;
    this.leverGoal = this.state.solved ? -0.9 : 0;
    if (!animate) {
      this.drawer.position.z = this.drawerGoal;
      this.primer.rotation.x = this.leverGoal;
    }
    this.applyMechanismPose();
    this.cogs.visible = this.state.drawerOpen && !this.state.rewardClaimed;
    if (this.goldModel) this.goldModel.visible = this.cogs.visible;
    this.enabledTargets.length = 0;
    if (!this.state.solved) this.enabledTargets.push(...this.targets, this.compartmentTargets[0]);
    else if (!this.state.drawerOpen) this.enabledTargets.push(this.compartmentTargets[1]);
    else if (!this.state.rewardClaimed) this.enabledTargets.push(this.compartmentTargets[2]);
    if (action === 'prime') {
      this.steamTime = 2.2;
      this.steamClock = 0;
    }
    this.painted = true;
  }

  update(dt: number): void {
    if (this.turning) {
      this.turning = false;
      for (const wheel of this.wheels) {
        wheel.node.quaternion.rotateTowards(wheel.goal, 10 * dt);
        if (wheel.node.quaternion.angleTo(wheel.goal) > 0.001) this.turning = true;
      }
    }
    this.drawer.position.z = THREE.MathUtils.damp(this.drawer.position.z, this.drawerGoal, 8, dt);
    this.primer.rotation.x = THREE.MathUtils.damp(this.primer.rotation.x, this.leverGoal, 12, dt);
    this.applyMechanismPose();
    if (!this.state.solved || !this.pump.parent?.visible) return;
    const speed = this.motionEnabled ? 4.8 : 1.15;
    this.driveSpeed = THREE.MathUtils.damp(this.driveSpeed, speed, 2.8, dt);
    this.driveAngle = (this.driveAngle + this.driveSpeed * dt) % (6 * Math.PI);
    if (this.driveRotors[0]) this.driveRotors[0].rotation.z = this.driveAngle;
    if (this.driveRotors[1])
      this.driveRotors[1].rotation.z = Math.PI + Math.PI / 18 - (this.driveAngle * 2) / 3;
    this.steamClock += dt;
    this.steamTime = Math.max(0, this.steamTime - dt);
    const vent = this.steamClock % 5;
    const opacity =
      this.steamTime > 0
        ? Math.min(1, this.steamTime / 0.5, this.steamClock / 0.16) * 0.78
        : vent < 1.2
          ? Math.sin((vent / 1.2) * Math.PI) * 0.26
          : 0;
    this.steam.visible = opacity > 0.01;
    this.steamMaterial.uniforms.uTime.value = this.steamClock;
    this.steamMaterial.uniforms.uOpacity.value = opacity * (this.motionEnabled ? 1 : 0.5);
  }

  private applyMechanismPose(): void {
    if (this.drawerModel) this.drawerModel.position.z = this.drawerRest + this.drawer.position.z;
    if (this.leverModel) this.leverModel.rotation.x = this.primer.rotation.x;
    this.compartmentTargets[2].position.z = 0.53 + this.drawer.position.z;
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): PressureAction | null {
    if (this.world.current !== this.wing.pumpRoom) return null;
    this.raycaster.set(origin, direction);
    this.raycaster.far = 4;
    this.pump.updateWorldMatrix(true, true);
    this.hits.length = 0;
    const first = this.raycaster.intersectObjects(this.enabledTargets, false, this.hits)[0];
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
    return this.actionFor(first.object, first.distance);
  }

  private actionFor(object: THREE.Object3D, distance: number): PressureAction {
    const i = this.targets.indexOf(object as THREE.Mesh);
    if (i >= 0) return { action: 'turn', valve: i as Valve, distance };
    const index = this.compartmentTargets.indexOf(object);
    return { action: index === 0 ? 'prime' : index === 1 ? 'open' : 'claim', distance };
  }
  near(point: THREE.Vector3, reach = 0.25): PressureAction | null {
    if (this.world.current !== this.wing.pumpRoom) return null;
    let result: PressureAction | null = null;
    for (const t of this.enabledTargets) {
      const distance = t.getWorldPosition(this.targetPoint).distanceTo(point);
      if (distance <= reach && (!result || distance < result.distance))
        result = this.actionFor(t, distance);
    }
    return result;
  }
  primeMiss(): void {
    this.paint(this.heading, 'Primer held', primeMiss(this.state));
  }

  dispose(): void {
    for (const g of [this.pump, this.gallery, this.entrance, this.parts['accumulator-bank']])
      g.removeFromParent();
    for (const label of this.labels) label.dispose();
    for (const geo of this.fallbackGeometries) geo.dispose();
    for (const mat of this.fallbackMaterials) mat.dispose();
  }
}
