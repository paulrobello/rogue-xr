import * as THREE from 'three';
import { CanvasLabel } from '../combat-view/canvas-label.ts';
import type { Box } from '../content/rooms.ts';
import {
  type FloatElevatorControl,
  type FloatElevatorLevel,
  type FloatElevatorState,
  floatElevatorTarget,
  readFloatElevator,
} from '../rules/float-elevator.ts';
import { ClockInscription } from './clock-inscription.ts';
import type { FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import type { Coffer } from './loot.ts';
import { findPuzzleMount } from './puzzle-placement.ts';

type Pick = { readonly action: FloatElevatorControl; readonly distance: number };

export const FLOAT_TRAVEL_SECONDS = 0.66;
export const FLOAT_SHUTTER_SECONDS = 0.86;
const TUBE_BOTTOM = 0.17;
const TUBE_TOP = 1.76;
const WATER_LOW = 0.223;
const LEVEL_STEP = 0.265;
const LOAD_RISE = 0.166;
const HATCH_HALF_HEIGHT = 0.116;
const HATCH_ANGLE = 0.59;
const waterHeight = (level: number): number => WATER_LOW + LEVEL_STEP * level;
const loadHeight = (level: number): number => waterHeight(level) + LOAD_RISE;

function glass(
  radius: number,
  height: number,
  start = 0,
  length = Math.PI * 2,
): THREE.CylinderGeometry {
  return new THREE.CylinderGeometry(radius, radius, height, 32, 1, true, start, length);
}

export class FloatElevator {
  readonly object = new THREE.Group();
  readonly chamber = new THREE.Group();
  readonly room: number;
  readonly target: Exclude<FloatElevatorLevel, 0>;

  private readonly resources: { dispose(): void }[] = [];
  private readonly releases: (() => void)[] = [];
  private releaseShutter: (() => void) | null = null;
  private readonly iron = new THREE.MeshStandardMaterial({
    color: 0x354042,
    metalness: 0.52,
    roughness: 0.52,
  });
  private readonly stone = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(0.37, 0.34, 0.28),
    roughness: 0.9,
  });
  private readonly brass = new THREE.MeshStandardMaterial({
    color: 0xbb9657,
    metalness: 0.59,
    roughness: 0.41,
  });
  private readonly water: THREE.Group = new THREE.Group();
  private readonly float = new THREE.Group();
  private readonly fitting = new THREE.Group();
  private readonly shutter = new THREE.Group();
  private readonly valves: readonly [THREE.Group, THREE.Group];
  private readonly valveTargets: readonly [THREE.Mesh, THREE.Mesh];
  private readonly fill: THREE.Mesh;
  private readonly drain: THREE.Mesh;
  private readonly take: THREE.Mesh;
  private readonly readyLabel: THREE.Mesh;
  private readonly hit = new THREE.Raycaster();
  private readonly obstacle = new THREE.Box3();
  private readonly at = new THREE.Vector3();
  private readonly crossing = new THREE.Vector3();
  private state: FloatElevatorState = readFloatElevator({});
  private age = FLOAT_TRAVEL_SECONDS;
  private from = 0;
  private level = 0;
  private shutterTime = 0;

  static mount(
    world: FloorWorld,
    seed: string,
    reduced: boolean,
    art?: THREE.Object3D,
    environment?: THREE.Texture | null,
    furnishings: readonly InteriorPlacement[] = [],
  ): FloatElevator | null {
    const room = world.plan.floatElevator?.room;
    if (room === undefined) return null;
    const coffer = world.coffers.find((entry) => entry.room === room);
    return coffer
      ? new FloatElevator(world, room, coffer, seed, reduced, art, environment, furnishings)
      : null;
  }

  private constructor(
    private readonly world: FloorWorld,
    room: number,
    coffer: Coffer,
    seed: string,
    private readonly reduced: boolean,
    art: THREE.Object3D | undefined,
    environment: THREE.Texture | null | undefined,
    furnishings: readonly InteriorPlacement[],
  ) {
    this.room = room;
    this.target = floatElevatorTarget(seed);
    this.object.name = 'reservoir-station';
    this.chamber.name = 'reservoir-coffer-recess';
    this.shutter.name = 'reservoir-recess-shutter';
    this.float.name = 'reservoir-float';
    this.fitting.name = 'reservoir-brass-fitting';
    this.water.name = 'reservoir-water';
    this.brass.envMap = environment ?? null;
    this.brass.envMapIntensity = 0.48;
    this.resources.push(this.iron, this.stone, this.brass);

    const parent = world.roomGroups[room];
    parent.add(this.chamber);
    this.chamber.position.copy(coffer.object.position);
    this.chamber.rotation.copy(coffer.object.rotation);
    this.buildRecess();
    const site = findPuzzleMount(world, [room], furnishings, 'reservoir', 1.14, 1.04, 2.1);
    if (site) {
      this.object.position.copy(site.wallSurface).setY(0);
      this.object.rotation.y = site.yaw;
      this.object.translateZ(0.51);
    }
    parent.add(this.object);
    this.buildTube(art);
    this.valves = [this.valve(-0.7, art), this.valve(0.86, art)];
    this.fill = this.sign('reservoir-fill-control', 0.45, 'Fill', 'Raise one mark', '');
    this.fill.position.set(-0.7, 0.75, 0.365);
    this.drain = this.sign('reservoir-drain-control', 0.45, 'Drain', 'Lower one mark', '');
    this.drain.position.set(0.86, 0.75, 0.365);
    const instructions = this.sign(
      'reservoir-instructions',
      1.03,
      'Float Elevator',
      `Raise the fitting to hatch ${this.target}`,
      'Take it when the float settles',
    );
    instructions.position.set(0, 1.93, 0.285);
    this.readyLabel = this.sign(
      'reservoir-fitting-ready',
      0.5,
      'Fitting ready',
      'Select or grab',
      '',
    );
    this.readyLabel.position.set(0.86, 1.61, 0.357);
    const hidden = new THREE.MeshBasicMaterial({ visible: false });
    this.resources.push(hidden);
    this.valveTargets = [
      this.box(
        'reservoir-fill-wheel-hit',
        this.valves[0],
        [0.255, 0.255, 0.08],
        [0, 0, 0.051],
        hidden,
      ),
      this.box(
        'reservoir-drain-wheel-hit',
        this.valves[1],
        [0.255, 0.255, 0.08],
        [0, 0, 0.051],
        hidden,
      ),
    ];
    this.take = this.box(
      'reservoir-take-fitting',
      this.object,
      [0.31, 0.225, 0.09],
      [0, loadHeight(this.target), 0.359],
      hidden,
    );
    this.releases.push(
      this.collider(this.object, { min: [-0.36, 0, -0.36], max: [0.36, TUBE_TOP, 0.315] }),
    );
    this.drawLevel();
  }

  private mesh(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string,
  ): THREE.Mesh {
    this.resources.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    parent.add(mesh);
    return mesh;
  }

  private box(
    name: string,
    parent: THREE.Object3D,
    size: readonly [number, number, number],
    position: readonly [number, number, number],
    material: THREE.Material,
  ): THREE.Mesh {
    const mesh = this.mesh(parent, new THREE.BoxGeometry(...size), material, name);
    mesh.position.fromArray(position);
    return mesh;
  }

  private collar(
    parent: THREE.Object3D,
    radius: number,
    height: number,
    y: number,
    material: THREE.Material,
  ): THREE.Mesh {
    const mesh = this.mesh(
      parent,
      new THREE.CylinderGeometry(radius, radius, height, 32),
      material,
      'reservoir-collar',
    );
    mesh.position.y = y;
    return mesh;
  }

  private flatRing(
    parent: THREE.Object3D,
    radius: number,
    width: number,
    y: number,
    material: THREE.Material,
  ): THREE.Mesh {
    const mesh = this.mesh(
      parent,
      new THREE.TorusGeometry(radius, width, 6, 32),
      material,
      'reservoir-ring',
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    return mesh;
  }

  private sign(
    name: string,
    width: number,
    title: string,
    line1: string,
    line2: string,
  ): THREE.Mesh {
    const sign = new ClockInscription(name, width, title, line1, line2);
    this.resources.push(sign);
    this.object.add(sign.object);
    return sign.object;
  }

  private collider(parent: THREE.Object3D, box: Box): () => void {
    parent.updateWorldMatrix(true, false);
    const bounds = new THREE.Box3(
      new THREE.Vector3(...box.min),
      new THREE.Vector3(...box.max),
    ).applyMatrix4(parent.matrixWorld);
    return this.world.addFixtureCollider(this.room, {
      min: bounds.min.toArray(),
      max: bounds.max.toArray(),
    });
  }

  private buildTube(art: THREE.Object3D | undefined): void {
    this.collar(this.object, 0.356, 0.145, 0.0725, this.stone);
    this.collar(this.object, 0.284, 0.083, 0.172, this.iron);
    this.flatRing(this.object, 0.258, 0.023, TUBE_BOTTOM + 0.018, this.brass);
    this.collar(this.object, 0.281, 0.093, TUBE_TOP + 0.028, this.iron);
    this.flatRing(this.object, 0.259, 0.022, TUBE_TOP - 0.024, this.brass);

    const transparent = new THREE.MeshStandardMaterial({
      color: 0xc2e7df,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
      roughness: 0.16,
      envMap: this.brass.envMap,
      envMapIntensity: 0.7,
      side: THREE.DoubleSide,
    });
    transparent.forceSinglePass = true;
    this.resources.push(transparent);
    const hatch = loadHeight(this.target);
    const low = hatch - HATCH_HALF_HEIGHT,
      high = hatch + HATCH_HALF_HEIGHT;
    for (const [bottom, top, start, length] of [
      [TUBE_BOTTOM, low, 0, Math.PI * 2],
      [low, high, HATCH_ANGLE, Math.PI * 2 - 2 * HATCH_ANGLE],
      [high, TUBE_TOP, 0, Math.PI * 2],
    ]) {
      const shell = this.mesh(
        this.object,
        glass(0.241, top - bottom, start, length),
        transparent,
        'reservoir-sight-glass',
      );
      shell.position.y = (bottom + top) / 2;
      shell.renderOrder = 5;
    }
    for (const side of [-1, 1]) {
      for (const z of [-0.147, 0.147]) {
        const post = this.mesh(
          this.object,
          new THREE.CylinderGeometry(0.019, 0.019, TUBE_TOP - 0.2, 10),
          this.brass,
          'reservoir-glass-stay',
        );
        post.position.set(side * 0.204, (TUBE_TOP + 0.2) / 2, z);
      }
      this.box(
        'reservoir-hatch-jamb',
        this.object,
        [0.033, 2 * HATCH_HALF_HEIGHT, 0.042],
        [side * 0.145, hatch, 0.23],
        this.brass,
      );
    }
    for (const y of [low, high]) {
      const edge = this.mesh(
        this.object,
        new THREE.TorusGeometry(0.252, 0.014, 6, 18, 1.42),
        this.brass,
        'reservoir-hatch-sill',
      );
      edge.position.y = y;
      edge.rotation.set(-Math.PI / 2, 0, -Math.PI / 2 - 0.71);
    }
    this.gauge();

    const liquid = new THREE.MeshBasicMaterial({
      color: 0x269890,
      transparent: true,
      opacity: 0.33,
      depthWrite: false,
    });
    const surface = new THREE.MeshBasicMaterial({
      color: 0x75d5bd,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
    });
    this.resources.push(liquid, surface);
    const body = this.mesh(this.water, glass(0.226, 1), liquid, 'reservoir-water-body');
    body.position.y = 0.5;
    body.renderOrder = 3;
    const top = this.mesh(
      this.water,
      new THREE.CircleGeometry(0.226, 32),
      surface,
      'reservoir-water-surface',
    );
    top.rotation.x = -Math.PI / 2;
    top.position.y = 1;
    top.renderOrder = 4;
    this.object.add(this.water);
    this.water.position.y = TUBE_BOTTOM;

    const source = art?.getObjectByName('float_chamber')?.getObjectByName('float')?.clone(true);
    if (source) {
      source.name = 'reservoir-authored-float';
      source.position.set(0, 0.037, 0);
      source.scale.setScalar(2.14);
      this.float.add(source);
    } else this.collar(this.float, 0.161, 0.105, 0.037, this.brass);
    this.flatRing(this.float, 0.171, 0.019, 0.083, this.brass);
    this.float.add(this.fitting);
    const head = this.mesh(
      this.fitting,
      new THREE.TorusGeometry(0.05, 0.015, 8, 20),
      this.brass,
      'reservoir-fitting-ring',
    );
    head.position.set(-0.045, 0.172, 0);
    this.box(
      'reservoir-fitting-stem',
      this.fitting,
      [0.121, 0.025, 0.032],
      [0.039, 0.172, 0],
      this.brass,
    );
    this.box(
      'reservoir-fitting-tooth',
      this.fitting,
      [0.026, 0.049, 0.032],
      [0.089, 0.148, 0],
      this.brass,
    );
    this.object.add(this.float);
  }

  private gauge(): void {
    if (typeof document === 'undefined' || !document.createElement('canvas').getContext('2d'))
      return;
    const scale = new CanvasLabel(116, 520, 0.305, false);
    const height = scale.mesh.geometry.parameters.height;
    const center = (loadHeight(0) + loadHeight(4)) / 2;
    scale.draw((ctx, w, h) => {
      ctx.fillStyle = '#203631';
      ctx.fillRect(4, 4, w - 8, h - 8);
      ctx.strokeStyle = '#b49358';
      ctx.lineWidth = 4;
      ctx.strokeRect(5, 5, w - 10, h - 10);
      ctx.font = '600 32px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f6e4ad';
      for (const n of [0, 1, 2, 3, 4] as const) {
        const y = (0.5 - (loadHeight(n) - center) / height) * h;
        const width = n === this.target ? 42 : 23;
        ctx.fillRect(12, y - 2, width, 4);
        ctx.fillText(String(n), 85, y);
        if (n === this.target) ctx.strokeRect(66, y - 19, 37, 38);
      }
    });
    scale.mesh.name = 'reservoir-level-gauge';
    scale.mesh.position.set(0.395, center, 0.235);
    this.object.add(scale.mesh);
    this.resources.push(scale);
  }

  private valve(x: number, art: THREE.Object3D | undefined): THREE.Group {
    const wheel = new THREE.Group();
    wheel.name = x < 0 ? 'reservoir-fill-valve' : 'reservoir-drain-valve';
    wheel.position.set(x, 1.076, 0.303);
    const ring = this.mesh(
      wheel,
      new THREE.TorusGeometry(0.113, 0.019, 7, 24),
      this.brass,
      'reservoir-valve-rim',
    );
    ring.position.z = 0.049;
    for (let index = 0; index < 3; index++) {
      const spoke = this.box(
        'reservoir-valve-spoke',
        wheel,
        [0.199, 0.025, 0.019],
        [0, 0, 0.048],
        this.brass,
      );
      spoke.rotation.z = (index * Math.PI) / 3;
    }
    const end = Math.sign(x) * 0.23;
    const pipe = this.mesh(
      this.object,
      new THREE.CylinderGeometry(0.035, 0.035, Math.abs(x - end), 12),
      this.brass,
      'reservoir-valve-pipe',
    );
    pipe.position.set((end + x) / 2, 1.076, 0.175);
    pipe.rotation.z = Math.PI / 2;
    this.box(
      'reservoir-valve-stem',
      this.object,
      [0.095, 0.105, 0.144],
      [x, 1.076, 0.241],
      this.iron,
    );
    const source = art?.getObjectByName('valve_body')?.clone(true);
    if (source) {
      source.position.set(0, 0, -0.015);
      source.rotation.x = Math.PI / 2;
      source.scale.setScalar(0.71);
      wheel.add(source);
    }
    this.object.add(wheel);
    return wheel;
  }

  private buildRecess(): void {
    const trackZ = -0.405;
    for (const side of [-1, 1]) {
      const x = side * 0.515;
      this.box(
        'reservoir-shutter-track',
        this.chamber,
        [0.09, 1.18, 0.16],
        [x, 0.59, trackZ],
        this.iron,
      );
      this.box(
        'reservoir-track-strip',
        this.chamber,
        [0.03, 1.05, 0.014],
        [x, 0.59, trackZ - 0.083],
        this.brass,
      );
      this.box(
        'reservoir-track-foot',
        this.chamber,
        [0.18, 0.09, 0.27],
        [x, 0.045, trackZ + 0.035],
        this.stone,
      );
      const bearing = this.mesh(
        this.chamber,
        new THREE.CylinderGeometry(0.066, 0.066, 0.04, 16),
        this.brass,
        'reservoir-track-bearing',
      );
      bearing.rotation.x = Math.PI / 2;
      bearing.position.set(x, 1.15, trackZ - 0.088);
      this.releases.push(
        this.collider(this.chamber, {
          min: [x - 0.09, 0, trackZ - 0.1],
          max: [x + 0.09, 1.23, trackZ + 0.17],
        }),
      );
    }
    this.box(
      'reservoir-hoist-header',
      this.chamber,
      [1.04, 0.096, 0.126],
      [0, 1.228, trackZ],
      this.brass,
    );
    this.box(
      'reservoir-hoist-inset',
      this.chamber,
      [0.74, 0.036, 0.015],
      [0, 1.229, trackZ - 0.068],
      this.iron,
    );
    this.box(
      'reservoir-shutter-panel',
      this.shutter,
      [0.875, 1.087, 0.078],
      [0, 0.543, -0.408],
      this.stone,
    );
    for (const y of [0.18, 0.92])
      this.box(
        'reservoir-shutter-band',
        this.shutter,
        [0.875, 0.076, 0.099],
        [0, y, -0.412],
        this.brass,
      );
    this.box(
      'reservoir-shutter-fitting',
      this.shutter,
      [0.145, 0.145, 0.109],
      [0, 0.612, -0.419],
      this.brass,
    ).rotation.z = Math.PI / 4;
    this.chamber.add(this.shutter);
    this.releaseShutter = this.collider(this.chamber, {
      min: [-0.437, 0, -0.457],
      max: [0.437, 1.1, -0.35],
    });
  }

  get fittingReachable(): boolean {
    return (
      !this.state.collected && this.age >= FLOAT_TRAVEL_SECONDS && this.state.level === this.target
    );
  }

  get opening(): boolean {
    return this.state.collected && !this.released;
  }

  get released(): boolean {
    return this.state.collected && this.shutterTime >= FLOAT_SHUTTER_SECONDS;
  }

  sync(state: FloatElevatorState, immediate = false): void {
    const delta = state.level - this.state.level;
    if (delta) this.valves[delta > 0 ? 0 : 1].rotation.z += (Math.sign(delta) * Math.PI) / 3;
    this.state = state;
    if (delta) {
      this.from = this.level;
      this.age = immediate || this.reduced ? FLOAT_TRAVEL_SECONDS : 0;
    }
    if (immediate || this.reduced) {
      this.age = FLOAT_TRAVEL_SECONDS;
      if (state.collected) this.shutterTime = FLOAT_SHUTTER_SECONDS;
    }
    this.drawLevel();
    this.drawShutter();
  }

  update(dt: number): void {
    if (this.age < FLOAT_TRAVEL_SECONDS) {
      this.age = Math.min(FLOAT_TRAVEL_SECONDS, this.age + dt);
      this.drawLevel();
    }
    if (this.state.collected && !this.released) {
      this.shutterTime = Math.min(FLOAT_SHUTTER_SECONDS, this.shutterTime + dt);
      this.drawShutter();
    }
  }

  private drawLevel(): void {
    const t = THREE.MathUtils.smoothstep(this.age, 0, FLOAT_TRAVEL_SECONDS);
    this.level = THREE.MathUtils.lerp(this.from, this.state.level, t);
    const height = waterHeight(this.level);
    this.water.scale.y = height - TUBE_BOTTOM;
    this.float.position.y = height;
    this.fitting.visible = !this.state.collected;
    this.fitting.position.z = this.fittingReachable ? 0.192 : 0;
    this.readyLabel.visible = this.fittingReachable;
  }

  private drawShutter(): void {
    this.shutter.position.y =
      -1.11 * THREE.MathUtils.smoothstep(this.shutterTime, 0, FLOAT_SHUTTER_SECONDS);
    this.shutter.visible = !this.released;
    if (this.released) {
      this.releaseShutter?.();
      this.releaseShutter = null;
    }
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): Pick | null {
    if (this.world.current !== this.room) return null;
    this.object.updateWorldMatrix(true, true);
    this.hit.set(origin, direction);
    this.hit.far = 3.8;
    const hit = this.hit.intersectObjects(this.targets(), false)[0];
    if (!hit || this.object.worldToLocal(this.at.copy(origin)).z < 0.32) return null;
    const blocked = this.world.colliders[this.room].some(({ min, max }) => {
      this.obstacle.min.fromArray(min);
      this.obstacle.max.fromArray(max);
      return (
        this.hit.ray.intersectBox(this.obstacle, this.crossing) !== null &&
        this.crossing.distanceTo(origin) < hit.distance - 0.025
      );
    });
    return blocked ? null : { action: this.actionFor(hit.object), distance: hit.distance };
  }

  near(position: THREE.Vector3, reach: number): Pick | null {
    if (
      this.world.current !== this.room ||
      this.object.worldToLocal(this.at.copy(position)).z < 0.23
    )
      return null;
    let picked: Pick | null = null;
    for (const node of this.targets()) {
      const distance = node.getWorldPosition(this.at).distanceTo(position);
      if (distance <= reach && (!picked || distance < picked.distance))
        picked = { action: this.actionFor(node), distance };
    }
    return picked;
  }

  private targets(): THREE.Mesh[] {
    const targets = [...this.valveTargets, this.fill, this.drain];
    if (this.fittingReachable) targets.push(this.take);
    return targets;
  }

  private actionFor(node: THREE.Object3D): FloatElevatorControl {
    if (node === this.take) return 'take';
    return node === this.fill || node === this.valveTargets[0] ? 'fill' : 'drain';
  }

  soundPosition(action: FloatElevatorControl, out: THREE.Vector3): THREE.Vector3 {
    if (action === 'take') return this.chamber.localToWorld(out.set(0, 0.5, -0.4));
    return this.valves[action === 'fill' ? 0 : 1].getWorldPosition(out);
  }

  dispose(): void {
    this.object.removeFromParent();
    this.chamber.removeFromParent();
    this.releaseShutter?.();
    for (const remove of this.releases) remove();
    for (const entry of this.resources) entry.dispose();
  }
}
