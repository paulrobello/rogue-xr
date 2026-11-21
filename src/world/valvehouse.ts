import * as THREE from 'three';
import { SteamPuffs } from '../combat-view/steam-puffs.ts';
import { gasketFor, type ValvehouseState } from '../rules/valvehouse.ts';
import { ClockInscription } from './clock-inscription.ts';
import { DOOR_HEIGHT, type FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import type { PbrSet } from './materials.ts';
import { findPuzzleMount, type PuzzleMount } from './puzzle-placement.ts';

type Layout = NonNullable<FloorWorld['plan']['valvehouse']>;
type Shape = ReturnType<typeof gasketFor>;
type Action = 'collect' | 'seat' | 'test';
export type ValvehousePick = { readonly action: Action; readonly distance: number };

const YAW = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 } as const;
const GATE_TIME = 1.12;
const PUFF_COUNT = 7;

function profile(path: THREE.Path, shape: Shape, radius: number): void {
  const sides = shape === 'round' ? 32 : shape === 'triangular' ? 3 : 4;
  for (let i = 0; i < sides; i++) {
    const a = Math.PI / 2 - (i * Math.PI * 2) / sides + (shape === 'square' ? Math.PI / 4 : 0);
    const x = radius * Math.cos(a);
    const y = radius * Math.sin(a);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  path.closePath();
}

export class Valvehouse {
  readonly supply = new THREE.Group();
  readonly controls = new THREE.Group();
  readonly chamber = new THREE.Group();
  readonly gate = new THREE.Group();
  readonly joint = new THREE.Group();

  private readonly leaf = new THREE.Group();
  private readonly lever = new THREE.Group();
  private readonly needle = new THREE.Group();
  private readonly gasket = new THREE.Group();
  private readonly installed = new THREE.Group();
  private readonly plume = new SteamPuffs(PUFF_COUNT, new THREE.Color(0xdfebeb));
  private readonly geometry: THREE.BufferGeometry[] = [];
  private readonly steel = new THREE.MeshStandardMaterial({
    color: 0x586161,
    metalness: 0.56,
    roughness: 0.62,
  });
  private readonly dark = new THREE.MeshStandardMaterial({
    color: 0x2e363b,
    metalness: 0.46,
    roughness: 0.7,
  });
  private readonly copper = new THREE.MeshStandardMaterial({
    color: 0xa16c4e,
    metalness: 0.61,
    roughness: 0.49,
  });
  private readonly bronze = new THREE.MeshStandardMaterial({
    color: 0xd0aa62,
    metalness: 0.62,
    roughness: 0.47,
  });
  private readonly enamel = new THREE.MeshStandardMaterial({
    color: 0x25584c,
    emissive: 0x316958,
    emissiveIntensity: 0.4,
    roughness: 0.57,
  });
  private readonly fault = new THREE.MeshStandardMaterial({
    color: 0xb65d40,
    emissive: 0xb74733,
    emissiveIntensity: 0.22,
    roughness: 0.58,
  });
  private readonly labels: ClockInscription[] = [];
  private readonly status: Record<ValvehouseState, THREE.Object3D>;
  private readonly fixtures: (() => void)[] = [];
  private readonly actions = new Map<Action, THREE.Object3D>();
  private readonly ray = new THREE.Ray();
  private readonly box = new THREE.Box3();
  private readonly hit = new THREE.Vector3();
  private readonly blocker = new THREE.Vector3();
  private state: ValvehouseState = 'missing';
  private age = 0;
  private gateTime = 0;
  private failTime = 0;

  static mount(
    world: FloorWorld,
    runSeed: string,
    reducedMotion: boolean,
    furnishings: readonly InteriorPlacement[] = [],
  ): Valvehouse | null {
    const layout = world.plan.valvehouse;
    if (!layout) return null;
    const source = findPuzzleMount(
      world,
      [layout.source.room],
      furnishings,
      'valvehouse-joint',
      0.78,
      0.8,
      1.88,
    );
    const supply = findPuzzleMount(
      world,
      [layout.supplyRoom],
      furnishings,
      'valvehouse-supply',
      0.55,
      0.66,
      1.7,
    );
    const pipeBay = findPuzzleMount(
      world,
      [layout.valvehouseRoom],
      furnishings,
      'valvehouse-delivery',
      0.65,
      0.62,
      1.8,
    );
    const door = world.rooms[layout.source.room]?.doors.find(
      (item) => item.id === layout.source.door,
    );
    if (!source || !supply || !door) return null;

    const puzzle = new Valvehouse(world, layout, gasketFor(runSeed), reducedMotion);
    puzzle.place(puzzle.controls, source);
    puzzle.controls.add(puzzle.plume);
    puzzle.place(puzzle.supply, supply);
    if (pipeBay) puzzle.place(puzzle.chamber, pipeBay);
    puzzle.makeGate(door);
    puzzle.sync('missing', true);
    return puzzle;
  }

  private constructor(
    private readonly world: FloorWorld,
    private readonly layout: Layout,
    shape: Shape,
    private readonly reducedMotion: boolean,
  ) {
    this.supply.name = 'valvehouse-supply';
    this.controls.name = 'valvehouse-controls';
    this.chamber.name = 'valvehouse-delivery';
    this.gate.name = 'valvehouse-gate';
    this.leaf.name = 'valvehouse-grille';
    this.joint.name = 'valvehouse-joint';
    this.gasket.name = 'valvehouse-gasket';
    this.gasket.userData.profile = shape;
    this.installed.name = 'valvehouse-seated-gasket';
    this.installed.userData.profile = shape;
    this.lever.name = 'valvehouse-test-lever';
    this.needle.name = 'valvehouse-gauge-needle';
    this.plume.name = 'valvehouse-leak-plume';

    this.makeSupply(shape);
    this.makeControls(shape);
    this.makeDelivery();
    this.status = {
      missing: this.sign(
        this.controls,
        1.24,
        1.66,
        'Valvehouse',
        'Find a matching gasket.',
        'The joint is losing pressure.',
      ),
      held: this.sign(
        this.controls,
        1.24,
        1.66,
        'Valvehouse',
        'Select the leaking joint.',
        'Fit the gasket before testing.',
      ),
      seated: this.sign(
        this.controls,
        1.24,
        1.66,
        'Valvehouse',
        'Gasket seated.',
        'Pull the pressure test lever.',
      ),
      open: this.sign(
        this.controls,
        1.24,
        1.66,
        'Valvehouse',
        'Pressure restored.',
        'The maintenance gate is open.',
      ),
    };
  }

  private mesh(
    group: THREE.Group,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    this.geometry.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
  }

  private boxPart(
    group: THREE.Group,
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    material = this.steel,
  ): THREE.Mesh {
    return this.mesh(group, new THREE.BoxGeometry(...size), material, ...at);
  }

  private disk(
    group: THREE.Group,
    r: number,
    depth: number,
    at: readonly [number, number, number],
    material = this.steel,
  ): void {
    this.mesh(
      group,
      new THREE.CylinderGeometry(r, r, depth, 20).rotateX(Math.PI / 2),
      material,
      ...at,
    );
  }

  private pipe(
    group: THREE.Group,
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    radius: number,
    material = this.copper,
  ): void {
    const start = new THREE.Vector3(...a);
    const end = new THREE.Vector3(...b);
    const mid = start.clone().lerp(end, 0.5);
    const axis = end.sub(start);
    const cylinder = this.mesh(
      group,
      new THREE.CylinderGeometry(radius, radius, axis.length(), 16),
      material,
      mid.x,
      mid.y,
      mid.z,
    );
    cylinder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
  }

  private ring(
    group: THREE.Group,
    shape: Shape,
    size: number,
    thickness: number,
    material: THREE.Material,
  ): void {
    const outer = new THREE.Shape();
    profile(outer, shape, size);
    const opening = new THREE.Path();
    profile(opening, shape, size * 0.59);
    outer.holes.push(opening);
    this.mesh(
      group,
      new THREE.ExtrudeGeometry(outer, {
        depth: thickness,
        bevelEnabled: false,
        curveSegments: 12,
      }),
      material,
      0,
      0,
      0,
    );
  }

  private sign(
    group: THREE.Group,
    width: number,
    y: number,
    title: string,
    line1: string,
    line2: string,
  ): THREE.Object3D {
    const sign = new ClockInscription(`${group.name}-sign`, width, title, line1, line2);
    sign.object.position.set(0, y, 0.17);
    group.add(sign.object);
    this.labels.push(sign);
    return sign.object;
  }

  dress(set: PbrSet): void {
    const aged = set.materials.get('brass-aged');
    const polished = set.materials.get('brass-polished');
    for (const material of [this.steel, this.dark, this.copper, this.bronze]) {
      const source = material === this.bronze ? polished : aged;
      if (!source) continue;
      material.normalMap = source.normalMap;
      material.normalScale.setScalar(0.13);
      material.roughnessMap = source.roughnessMap;
      if (material === this.bronze) material.map = source.map;
      material.needsUpdate = true;
    }
  }

  private makeSupply(shape: Shape): void {
    this.boxPart(this.supply, [0.64, 0.57, 0.095], [0, 1.13, 0.02], this.dark);
    this.boxPart(this.supply, [0.76, 0.08, 0.28], [0, 0.86, 0.1], this.steel);
    for (const x of [-0.28, 0.28])
      this.boxPart(this.supply, [0.056, 0.31, 0.17], [x, 1.05, 0.11], this.steel);
    this.disk(this.supply, 0.022, 0.084, [0, 1.24, 0.109], this.steel);
    this.gasket.position.set(0, 1.17, 0.105);
    this.ring(this.gasket, shape, 0.18, 0.062, this.bronze);
    this.supply.add(this.gasket);
    this.sign(this.supply, 0.95, 1.54, 'Spare gasket', 'Take this to the Valvehouse.', '');
    this.actions.set('collect', this.gasket);
  }

  private makeControls(shape: Shape): void {
    this.boxPart(this.controls, [1.44, 0.72, 0.13], [0, 1.14, 0.055], this.dark);
    for (const x of [-0.59, 0.59])
      for (const y of [0.86, 1.41])
        this.disk(this.controls, 0.028, 0.02, [x, y, 0.14], this.bronze);
    for (const x of [-0.64, 0.64])
      this.boxPart(this.controls, [0.058, 0.58, 0.06], [x, 1.15, 0.14], this.steel);
    this.joint.position.set(-0.36, 1.22, 0.22);
    this.ring(this.joint, shape, 0.2, 0.07, this.steel);
    this.disk(this.joint, 0.074, 0.04, [0, 0, -0.01], this.dark);
    this.ring(this.installed, shape, 0.167, 0.045, this.bronze);
    this.installed.position.z = 0.074;
    this.plume.position.copy(this.joint.position).add(new THREE.Vector3(0, 0.03, 0.122));
    this.joint.add(this.installed);
    this.controls.add(this.joint);

    const gauge = new THREE.Group();
    gauge.name = 'valvehouse-pressure-gauge';
    gauge.position.set(0.09, 1.28, 0.16);
    this.disk(gauge, 0.157, 0.08, [0, 0, 0], this.bronze);
    this.disk(gauge, 0.129, 0.033, [0, 0, 0.035], this.dark);
    for (const [x, material] of [
      [-0.075, this.fault],
      [0.075, this.enamel],
    ] as const)
      this.disk(gauge, 0.021, 0.007, [x, 0.068, 0.056], material);
    this.boxPart(this.needle, [0.014, 0.121, 0.01], [0, 0.048, 0.06], this.bronze);
    gauge.add(this.needle);
    this.controls.add(gauge);

    this.lever.position.set(0.47, 1.05, 0.22);
    this.disk(this.lever, 0.078, 0.09, [0, 0, 0], this.steel);
    this.boxPart(this.lever, [0.038, 0.197, 0.038], [0, 0.083, 0.062]);
    this.boxPart(this.lever, [0.108, 0.055, 0.075], [0, 0.175, 0.08], this.bronze);
    this.controls.add(this.lever);
    this.pipe(this.controls, [-0.56, 0.69, 0.11], [-0.22, 0.69, 0.11], 0.061);
    this.pipe(this.controls, [-0.36, 0.67, 0.11], [-0.36, 1.19, 0.11], 0.053);
    this.pipe(this.controls, [0.08, 0.75, 0.11], [0.08, 1.15, 0.11], 0.045);
    this.actions.set('seat', this.joint);
    this.actions.set('test', this.lever);
  }

  private makeDelivery(): void {
    for (const x of [-0.48, 0.48]) {
      this.pipe(this.chamber, [x, 0.22, 0.17], [x, 1.57, 0.17], 0.078);
      this.pipe(this.chamber, [x, 0.22, -0.07], [x, 0.22, 0.17], 0.078);
      this.disk(this.chamber, 0.135, 0.05, [x, 0.22, 0.011], this.steel);
      this.pipe(this.chamber, [x, 1.44, 0.17], [x, 1.51, 0.17], 0.093, this.bronze);
      for (const y of [0.38, 1.26])
        this.boxPart(this.chamber, [0.22, 0.12, 0.25], [x, y, 0.09], this.dark);
    }
    this.pipe(this.chamber, [-0.48, 1.57, 0.17], [0.48, 1.57, 0.17], 0.078);
    this.disk(this.chamber, 0.145, 0.13, [0, 1.57, 0.21], this.bronze);
    this.disk(this.chamber, 0.081, 0.055, [0, 1.57, 0.285], this.enamel);
    this.sign(this.chamber, 1.02, 0.95, 'Maintenance feed', 'Line pressure restored.', '');
  }

  private place(group: THREE.Group, mount: PuzzleMount): void {
    group.position.copy(mount.wallSurface).setY(0);
    group.rotation.y = mount.yaw;
    group.translateZ(0.1);
    this.world.roomGroups[mount.room].add(group);
    const b = this.box.setFromObject(group);
    this.fixtures.push(
      this.world.addFixtureCollider(mount.room, { min: b.min.toArray(), max: b.max.toArray() }),
    );
  }

  private makeGate(door: FloorWorld['rooms'][number]['doors'][number]): void {
    const width = door.width - 0.08;
    this.gate.position.set(door.world[0], 0, door.world[1]);
    this.gate.rotation.y = YAW[door.facing];
    for (const side of [-1, 1]) {
      this.boxPart(
        this.gate,
        [0.064, DOOR_HEIGHT, 0.16],
        [side * (door.width / 2 - 0.025), DOOR_HEIGHT / 2, 0],
        this.dark,
      );
      this.boxPart(
        this.leaf,
        [0.082, DOOR_HEIGHT - 0.02, 0.08],
        [side * width * 0.47, DOOR_HEIGHT / 2, 0],
        this.steel,
      );
    }
    for (let i = -4; i <= 4; i++)
      this.boxPart(
        this.leaf,
        [0.055, DOOR_HEIGHT - 0.02, 0.075],
        [(i * width) / 10, DOOR_HEIGHT / 2, 0],
        this.steel,
      );
    for (const y of [0.07, 0.67, 1.31, DOOR_HEIGHT - 0.07])
      this.boxPart(this.leaf, [width, 0.082, 0.1], [0, y, 0], this.steel);
    this.boxPart(this.leaf, [0.29, 0.18, 0.08], [0, 1.31, 0.047], this.bronze);
    const sign = this.sign(
      this.leaf,
      0.79,
      1.92,
      'Valvehouse',
      'Restore pressure at the joint.',
      '',
    );
    sign.position.z = 0.075;
    this.gate.add(this.leaf);
    this.world.roomGroups[this.layout.source.room].attach(this.gate);
  }

  private activeControls(): readonly Action[] {
    if (this.world.current === this.layout.supplyRoom && this.state === 'missing')
      return ['collect'];
    if (this.world.current !== this.layout.source.room || this.state === 'open') return [];
    return this.state === 'seated' ? ['test'] : ['seat', 'test'];
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): ValvehousePick | null {
    this.ray.set(origin, direction);
    let nearest: ValvehousePick | null = null;
    for (const action of this.activeControls()) {
      const target = this.actions.get(action);
      if (!target?.parent || target.parent.worldToLocal(this.hit.copy(origin)).z <= 0) continue;
      if (!this.ray.intersectBox(this.box.setFromObject(target), this.hit)) continue;
      const distance = this.hit.distanceTo(origin);
      if (distance > 4 || (nearest && distance >= nearest.distance)) continue;
      const blocked = this.world.colliders[this.world.current].some((b) => {
        this.box.min.fromArray(b.min);
        this.box.max.fromArray(b.max);
        return (
          !this.box.containsPoint(this.hit) &&
          this.ray.intersectBox(this.box, this.blocker) &&
          this.blocker.distanceTo(origin) < distance - 0.035
        );
      });
      if (!blocked) nearest = { action, distance };
    }
    return nearest;
  }

  near(point: THREE.Vector3, reach: number): ValvehousePick | null {
    let nearest: ValvehousePick | null = null;
    for (const action of this.activeControls()) {
      const target = this.actions.get(action);
      if (!target?.parent || target.parent.worldToLocal(this.hit.copy(point)).z <= 0) continue;
      const distance = this.box.setFromObject(target).distanceToPoint(point);
      if (distance <= reach && (!nearest || distance < nearest.distance))
        nearest = { action, distance };
    }
    return nearest;
  }

  get leaking(): boolean {
    return this.state === 'missing' || this.state === 'held';
  }

  sync(state: ValvehouseState, immediate = false): void {
    this.state = state;
    for (const [name, sign] of Object.entries(this.status)) sign.visible = name === state;
    this.gasket.visible = state === 'missing';
    this.installed.visible = state === 'seated' || state === 'open';
    if (!this.leaking) this.failTime = 0;
    if (immediate || this.reducedMotion) {
      this.needle.rotation.z = state === 'open' ? -0.76 : 0.76;
      this.lever.rotation.z = state === 'open' ? -0.55 : 0;
      if (state === 'open') this.moveGate(GATE_TIME);
    }
  }

  vent(): void {
    this.failTime = 0.66;
  }

  openingPosition(target: THREE.Vector3): THREE.Vector3 {
    return this.gate.localToWorld(target.set(0, 1.3, 0));
  }

  private moveGate(seconds: number): void {
    this.gateTime = seconds;
    const progress = Math.min(1, seconds / GATE_TIME);
    this.leaf.position.y = (DOOR_HEIGHT + 0.05) * progress;
    this.leaf.visible = progress < 1;
    if (progress === 1) this.world.setPuzzleGateOpen('valvehouse', true);
  }

  update(dt: number): void {
    if (this.state === 'open' && this.gateTime < GATE_TIME) this.moveGate(this.gateTime + dt);
    const press = this.state === 'open' ? 1 : Math.min(1, this.failTime * 3);
    const pressure = this.state === 'open' ? 1 : press * 0.33;
    this.failTime = Math.max(0, this.failTime - dt);
    this.needle.rotation.z = THREE.MathUtils.damp(
      this.needle.rotation.z,
      (pressure - 0.5) * -1.52,
      8,
      dt,
    );
    this.lever.rotation.z = this.reducedMotion
      ? -press * 0.42
      : THREE.MathUtils.damp(this.lever.rotation.z, -press * 0.55, 8, dt);
    if (!this.leaking || this.world.current !== this.layout.source.room) {
      this.plume.visible = false;
      return;
    }
    this.age += this.reducedMotion ? 0 : Math.min(dt, 0.05);
    const puff = 1 + press * 0.82;
    for (let i = 0; i < PUFF_COUNT; i++) {
      const t = (this.age * 1.33 + i / PUFF_COUNT) % 1;
      this.plume.puff(
        i,
        -0.05 + 0.11 * t,
        0.31 * t * puff,
        0.36 * t * puff,
        0.058 + 0.18 * t,
        (press ? 0.66 : 0.46) * Math.sin(Math.PI * t),
        i * 1.41 + t,
      );
    }
    this.plume.commit(true);
  }

  dispose(): void {
    for (const fixture of this.fixtures) fixture();
    for (const label of this.labels) label.dispose();
    for (const geometry of this.geometry) geometry.dispose();
    for (const material of [
      this.steel,
      this.dark,
      this.copper,
      this.bronze,
      this.enamel,
      this.fault,
    ])
      material.dispose();
    this.plume.dispose();
    this.supply.removeFromParent();
    this.controls.removeFromParent();
    this.chamber.removeFromParent();
    this.gate.removeFromParent();
  }
}
