import * as THREE from 'three';
import {
  PENDULUM_PERIODS,
  type PendulumDetent,
  type PendulumGalleryState,
  pendulumAngle,
  pendulumTarget,
  pendulumTrialSeconds,
  readPendulumGallery,
} from '../rules/pendulum-gallery.ts';
import { ClockInscription } from './clock-inscription.ts';
import { DOOR_HEIGHT, type FloorWorld } from './floor-world.ts';
import type { InteriorPlacement } from './interior-furnishings.ts';
import type { PbrSet } from './materials.ts';
import { findPuzzleMount } from './puzzle-placement.ts';

type Layout = NonNullable<FloorWorld['plan']['pendulumGallery']>;
type Action = 'adjust' | 'release';
export type PendulumPick = { readonly action: Action; readonly distance: number };
type TrialResult = 'ignored' | 'wrong' | 'opened';
type Feedback = 'ready' | 'running' | 'wrong' | 'opened';
interface Arm {
  readonly pivot: THREE.Object3D;
  readonly rod: THREE.Object3D;
  readonly bob: THREE.Object3D;
  readonly rodLength: number;
}

const FACING = { N: 0, E: -Math.PI / 2, S: Math.PI, W: Math.PI / 2 } as const;
const RELEASE_POS = [0.53, 0.66, 0.2] as const;
const ADJUST_POS = [-0.53, 0.66, 0.2] as const;
const DOOR_SECONDS = 1.12;
const CATCH_SECONDS = 0.13;

function setLength(arm: Arm, detent: PendulumDetent): void {
  const length = [0.154, 0.184, 0.222][detent];
  arm.rod.position.y = -length / 2;
  arm.rod.scale.y = length / arm.rodLength;
  arm.bob.position.y = -length;
}

function crossings(detent: PendulumDetent, time: number): number {
  return Math.floor((time / PENDULUM_PERIODS[detent]) * 2 + 0.5);
}

export class PendulumGallery {
  readonly station = new THREE.Group();
  readonly gate = new THREE.Group();
  readonly reference: THREE.Object3D;
  readonly adjustable: THREE.Object3D;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly labels: ClockInscription[] = [];
  private readonly walnut = new THREE.MeshStandardMaterial({ color: 0x5c3f31, roughness: 0.68 });
  private readonly brass = new THREE.MeshStandardMaterial({
    color: 0xb68f4e,
    metalness: 0.64,
    roughness: 0.48,
  });
  private readonly steel = new THREE.MeshStandardMaterial({
    color: 0x444d50,
    metalness: 0.55,
    roughness: 0.62,
  });
  private readonly glass = new THREE.MeshStandardMaterial({
    color: 0x66938f,
    transparent: true,
    opacity: 0.24,
    roughness: 0.22,
    metalness: 0.12,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
  });
  private readonly controlDark = new THREE.MeshStandardMaterial({
    color: 0x293733,
    roughness: 0.62,
  });
  private readonly dial = new THREE.Group();
  private readonly dialNeedle = new THREE.Group();
  private readonly release = new THREE.Group();
  private readonly doorLeft = new THREE.Group();
  private readonly doorRight = new THREE.Group();
  private readonly latch = new THREE.Group();
  private readonly a: Arm;
  private readonly b: Arm;
  private readonly signs: Record<Feedback, THREE.Object3D>;
  private readonly ray = new THREE.Ray();
  private readonly box = new THREE.Box3();
  private readonly hit = new THREE.Vector3();
  private readonly blocker = new THREE.Vector3();
  private readonly at = new THREE.Vector3();
  private readonly target: PendulumDetent;
  private state: PendulumGalleryState;
  private removeCollider: (() => void) | undefined;
  private trial: number | null = null;
  private doorTime = 0;

  static mount(
    world: FloorWorld,
    art: THREE.Object3D | undefined,
    seed: string,
    reducedMotion: boolean,
    result: () => TrialResult,
    tick: (at: THREE.Vector3) => void,
    props: readonly InteriorPlacement[] = [],
  ): PendulumGallery | null {
    const layout = world.plan.pendulumGallery;
    if (!layout) return null;
    const site = findPuzzleMount(
      world,
      [layout.source.room],
      props,
      'pendulum-gallery-station',
      0.79,
      0.74,
      1.92,
    );
    const door = world.rooms[layout.source.room]?.doors.find((d) => d.id === layout.source.door);
    if (!site || !door) return null;
    const puzzle = new PendulumGallery(world, layout, art, seed, reducedMotion, result, tick);
    puzzle.station.position.copy(site.wallSurface).setY(0);
    puzzle.station.rotation.y = site.yaw;
    puzzle.station.translateZ(0.11);
    world.roomGroups[layout.source.room].add(puzzle.station);
    const bounds = puzzle.box.setFromObject(puzzle.station);
    puzzle.removeCollider = world.addFixtureCollider(layout.source.room, {
      min: bounds.min.toArray(),
      max: bounds.max.toArray(),
    });
    puzzle.buildGate(door);
    puzzle.sync(puzzle.state, true);
    return puzzle;
  }

  private constructor(
    private readonly world: FloorWorld,
    private readonly layout: Layout,
    art: THREE.Object3D | undefined,
    seed: string,
    private readonly reducedMotion: boolean,
    private readonly finishTrial: () => TrialResult,
    private readonly tick: (at: THREE.Vector3) => void,
  ) {
    this.target = pendulumTarget(seed);
    this.state = readPendulumGallery({ seed });
    this.station.name = 'pendulum-gallery-station';
    this.gate.name = 'pendulum-gallery-gate';
    this.release.name = 'pendulum-test-release';
    this.dial.name = 'pendulum-adjustment';
    this.dialNeedle.name = 'pendulum-setting-needle';
    this.doorLeft.name = 'pendulum-leaf-left';
    this.doorRight.name = 'pendulum-leaf-right';
    this.latch.name = 'pendulum-rendezvous-latch';

    this.boxPart(this.station, [1.45, 1.06, 0.111], [0, 1.08, 0.03], this.walnut);
    this.boxPart(this.station, [1.48, 0.067, 0.13], [0, 0.55, 0.06], this.brass);
    this.boxPart(this.station, [1.48, 0.063, 0.13], [0, 1.61, 0.06], this.brass);
    for (const x of [-0.68, 0.68]) {
      this.boxPart(this.station, [0.034, 1.02, 0.038], [x, 1.08, 0.091], this.brass);
      for (const y of [0.59, 1.54])
        this.disk(this.station, 0.025, 0.025, [x, y, 0.118], this.brass);
    }

    const pair = art?.getObjectByName('dual_pendulum')?.clone(true);
    const left = pair?.getObjectByName('pendulum_left_pivot');
    const right = pair?.getObjectByName('pendulum_right_pivot');
    this.a = this.buildArm(left, -0.105, 0.22);
    this.b = this.buildArm(right, 0.105, 0.15);
    this.reference = this.a.pivot;
    this.reference.name = 'pendulum-reference';
    this.adjustable = this.b.pivot;
    this.adjustable.name = 'pendulum-adjustable';
    const bearings = new THREE.Group();
    bearings.name = 'pendulum-bearings';
    bearings.position.set(0, 0.77, 0.19);
    bearings.scale.setScalar(2.52);
    bearings.add(this.reference, this.adjustable);
    const rail = pair?.getObjectByName('rail');
    if (rail) bearings.add(rail);
    else this.boxPart(bearings, [0.32, 0.035, 0.035], [0, 0.31, 0], this.brass);
    this.station.add(bearings);
    this.buildSwingEnvelopes();
    for (const x of [-0.105 * 2.52, 0.105 * 2.52]) {
      this.boxPart(this.station, [0.015, 0.41, 0.013], [x, 1.16, 0.113], this.brass);
      this.disk(this.station, 0.058, 0.032, [x, 1.525, 0.215], this.steel);
    }
    this.buildControls();
    this.signs = {
      ready: this.sign(
        this.station,
        1.35,
        1.87,
        'Pendulum Rendezvous',
        'Match the swings to open the gallery.',
        'Set the dial, then pull the test lever.',
      ),
      running: this.sign(
        this.station,
        1.35,
        1.87,
        'Pendulum Rendezvous',
        'Watch the two centre crossings.',
        '',
      ),
      wrong: this.sign(
        this.station,
        1.35,
        1.87,
        'The crossings drifted',
        'Change the dial and test again.',
        '',
      ),
      opened: this.sign(
        this.station,
        1.35,
        1.87,
        'Crossings aligned',
        'The gallery doors are released.',
        '',
      ),
    };
    for (const [state, sign] of Object.entries(this.signs)) sign.name = `pendulum-caption-${state}`;
  }

  private mesh(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    at: readonly [number, number, number],
  ): THREE.Mesh {
    this.geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.fromArray(at);
    parent.add(mesh);
    return mesh;
  }

  private boxPart(
    parent: THREE.Object3D,
    size: readonly [number, number, number],
    at: readonly [number, number, number],
    material = this.brass,
  ): THREE.Mesh {
    return this.mesh(parent, new THREE.BoxGeometry(...size), material, at);
  }

  private disk(
    parent: THREE.Object3D,
    radius: number,
    depth: number,
    at: readonly [number, number, number],
    material = this.brass,
  ): void {
    this.mesh(
      parent,
      new THREE.CylinderGeometry(radius, radius, depth, 22).rotateX(Math.PI / 2),
      material,
      at,
    );
  }

  private sign(
    parent: THREE.Object3D,
    width: number,
    y: number,
    title: string,
    first: string,
    second: string,
  ): THREE.Object3D {
    const sign = new ClockInscription('pendulum-caption', width, title, first, second);
    sign.object.position.set(0, y, 0.22);
    parent.add(sign.object);
    this.labels.push(sign);
    return sign.object;
  }

  private buildArm(authored: THREE.Object3D | undefined, x: number, length: number): Arm {
    const rod = authored?.children.find((n) => n.name.startsWith('rod'));
    const bob = authored?.children.find((n) => n.name.startsWith('bob'));
    if (authored && rod && bob) return { pivot: authored, rod, bob, rodLength: length };
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.3, 0);
    const newRod = this.boxPart(pivot, [0.012, length, 0.016], [0, -length / 2, 0], this.steel);
    const newBob = new THREE.Group();
    newBob.position.y = -length;
    this.disk(newBob, 0.043, 0.036, [0, 0, 0]);
    pivot.add(newBob);
    return { pivot, rod: newRod, bob: newBob, rodLength: length };
  }

  private buildControls(): void {
    this.dial.position.fromArray(ADJUST_POS);
    this.disk(this.dial, 0.105, 0.068, [0, 0, 0], this.steel);
    this.disk(this.dial, 0.08, 0.025, [0, 0, 0.043], this.brass);
    for (const angle of [-0.9, 0, 0.9])
      this.disk(
        this.dial,
        0.009,
        0.006,
        [0.091 * Math.sin(angle), 0.091 * Math.cos(angle), 0.039],
        this.brass,
      );
    this.boxPart(this.dialNeedle, [0.014, 0.071, 0.012], [0, 0.027, 0.063], this.controlDark);
    this.dial.add(this.dialNeedle);
    this.station.add(this.dial);
    this.release.position.fromArray(RELEASE_POS);
    this.disk(this.release, 0.073, 0.069, [0, 0, 0], this.steel);
    this.boxPart(this.release, [0.032, 0.137, 0.032], [0, 0.049, 0.059], this.steel);
    this.boxPart(this.release, [0.104, 0.054, 0.069], [0, 0.112, 0.069], this.brass);
    this.station.add(this.release);
  }

  private buildSwingEnvelopes(): void {
    for (const arm of [this.a, this.b]) {
      const pivot = arm.pivot.position;
      const curve = new THREE.CatmullRomCurve3(
        Array.from({ length: 9 }, (_, index) => {
          const angle = -0.48 + (index / 8) * 0.96;
          return new THREE.Vector3(
            pivot.x * 2.52 + Math.sin(angle) * 0.62,
            0.77 + pivot.y * 2.52 - Math.cos(angle) * 0.62,
            0.103,
          );
        }),
      );
      const surround = this.mesh(
        this.station,
        new THREE.TubeGeometry(curve, 18, 0.009, 6, false),
        this.brass,
        [0, 0, 0],
      );
      surround.name = 'pendulum-sweep-scale';
    }
  }

  private buildGate(door: FloorWorld['rooms'][number]['doors'][number]): void {
    this.gate.position.set(door.world[0], 0, door.world[1]);
    this.gate.rotation.y = FACING[door.facing];
    const half = door.width / 2 - 0.035;
    for (const [side, hinge] of [
      [-1, this.doorLeft],
      [1, this.doorRight],
    ] as const) {
      hinge.position.x = side * half;
      const leaf = new THREE.Group();
      leaf.position.x = (-side * half) / 2;
      const frameWidth = half - 0.025;
      this.mesh(leaf, new THREE.PlaneGeometry(frameWidth, DOOR_HEIGHT - 0.18), this.glass, [
        0,
        DOOR_HEIGHT / 2,
        0,
      ]);
      for (const x of [-frameWidth / 2, frameWidth / 2])
        this.boxPart(leaf, [0.052, DOOR_HEIGHT - 0.04, 0.052], [x, DOOR_HEIGHT / 2, 0], this.steel);
      for (const y of [0.065, 0.89, DOOR_HEIGHT - 0.065])
        this.boxPart(leaf, [frameWidth, 0.065, 0.058], [0, y, 0], this.steel);
      this.boxPart(leaf, [0.22, 0.144, 0.073], [0, 1.2, 0]);
      for (const diag of [-1, 1]) {
        const bar = this.boxPart(leaf, [0.39, 0.025, 0.02], [0, 1.62 + diag * 0.09, 0.019]);
        bar.rotation.z = (diag * Math.PI) / 3;
      }
      hinge.add(leaf);
      this.gate.add(hinge);
    }
    this.latch.position.set(0, 1.21, 0.062);
    this.boxPart(this.latch, [0.36, 0.073, 0.066], [0, 0, 0], this.brass);
    this.gate.add(this.latch);
    const plaque = this.sign(
      this.gate,
      0.92,
      DOOR_HEIGHT + 0.18,
      'Rendezvous Gallery',
      'Match the pendulum swings.',
      '',
    );
    plaque.name = 'pendulum-gallery-plaque';
    this.world.roomGroups[this.layout.source.room].attach(this.gate);
  }

  dress(set: PbrSet, environment: THREE.Texture | null): void {
    for (const [material, slot] of [
      [this.walnut, 'walnut'],
      [this.brass, 'brass-polished'],
      [this.steel, 'brass-aged'],
    ] as const) {
      const source = set.materials.get(slot);
      if (!source) continue;
      material.normalMap = source.normalMap;
      material.normalScale.setScalar(0.13);
      material.roughnessMap = source.roughnessMap;
      material.map = source.map;
      material.envMap = environment;
      material.envMapIntensity = 0.5;
      material.needsUpdate = true;
    }
  }

  private controls(): readonly (readonly [Action, THREE.Group])[] {
    return this.state.open || this.trial !== null || this.world.current !== this.layout.source.room
      ? []
      : [
          ['adjust', this.dial],
          ['release', this.release],
        ];
  }

  pick(origin: THREE.Vector3, direction: THREE.Vector3): PendulumPick | null {
    const controls = this.controls();
    if (!controls.length || this.station.worldToLocal(this.hit.copy(origin)).z <= 0) return null;
    let nearest: PendulumPick | null = null;
    this.ray.set(origin, direction);
    for (const [action, node] of controls) {
      if (!this.ray.intersectBox(this.box.setFromObject(node), this.hit)) continue;
      const distance = this.hit.distanceTo(origin);
      if (distance > 4 || (nearest && nearest.distance <= distance)) continue;
      const blocked = this.world.colliders[this.layout.source.room].some((obstacle) => {
        this.box.min.fromArray(obstacle.min);
        this.box.max.fromArray(obstacle.max);
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

  near(point: THREE.Vector3, reach: number): PendulumPick | null {
    const controls = this.controls();
    if (!controls.length || this.station.worldToLocal(this.hit.copy(point)).z <= 0) return null;
    let nearest: PendulumPick | null = null;
    for (const [action, node] of controls) {
      const distance = this.box.setFromObject(node).distanceToPoint(point);
      if (distance <= reach && (!nearest || nearest.distance > distance))
        nearest = { action, distance };
    }
    return nearest;
  }

  private show(status: Feedback): void {
    for (const [key, sign] of Object.entries(this.signs)) sign.visible = key === status;
  }

  sync(state: PendulumGalleryState, immediate = false): void {
    if (this.state.detent !== state.detent || immediate) {
      setLength(this.a, this.target);
      setLength(this.b, state.detent);
      this.dialNeedle.rotation.z = 0.9 * (1 - state.detent);
      this.a.pivot.rotation.z = 0;
      this.b.pivot.rotation.z = 0;
      this.show('ready');
    }
    this.state = state;
    if (!state.open) return;
    this.trial = null;
    this.show('opened');
    if (immediate || this.reducedMotion) this.moveGate(DOOR_SECONDS);
  }

  start(): boolean {
    if (this.controls().length === 0) return false;
    this.trial = 0;
    this.show('running');
    this.a.pivot.rotation.z = pendulumAngle(this.target, 0);
    this.b.pivot.rotation.z = pendulumAngle(this.state.detent, 0);
    this.release.rotation.z = -0.34;
    return true;
  }

  openingPosition(target: THREE.Vector3): THREE.Vector3 {
    return this.gate.localToWorld(target.set(0, 1.21, 0));
  }

  private moveGate(seconds: number): void {
    this.doorTime = seconds;
    const progress = THREE.MathUtils.clamp(
      (seconds - CATCH_SECONDS) / (DOOR_SECONDS - CATCH_SECONDS),
      0,
      1,
    );
    const open = (progress * progress * (3 - 2 * progress) * Math.PI) / 2;
    this.latch.position.y = 1.21 + Math.min(1, seconds / CATCH_SECONDS) * 0.23;
    this.latch.visible = seconds < CATCH_SECONDS + 0.04;
    this.doorLeft.rotation.y = open;
    this.doorRight.rotation.y = -open;
    if (progress === 1) this.world.setPuzzleGateOpen('pendulum', true);
  }

  update(dt: number, suspended: boolean): void {
    if (suspended) return;
    if (this.state.open && this.doorTime < DOOR_SECONDS) this.moveGate(this.doorTime + dt);
    const before = this.trial;
    if (before === null) return;
    if (this.world.current !== this.layout.source.room) {
      this.trial = null;
      this.release.rotation.z = 0;
      this.a.pivot.rotation.z = 0;
      this.b.pivot.rotation.z = 0;
      this.show('ready');
      return;
    }
    const end = pendulumTrialSeconds(this.target, this.state.detent);
    const now = Math.min(end, before + dt);
    this.trial = now;
    this.a.pivot.rotation.z = pendulumAngle(this.target, now);
    this.b.pivot.rotation.z = pendulumAngle(this.state.detent, now);
    if (now < end || this.target !== this.state.detent) {
      if (crossings(this.target, now) !== crossings(this.target, before))
        this.tick(this.a.bob.getWorldPosition(this.at));
      if (crossings(this.state.detent, now) !== crossings(this.state.detent, before))
        this.tick(this.b.bob.getWorldPosition(this.at));
    }
    if (now < end) return;
    this.trial = null;
    this.release.rotation.z = 0;
    const result = this.finishTrial();
    if (result === 'wrong') this.show('wrong');
    else if (result === 'ignored') this.show('ready');
  }

  dispose(): void {
    this.removeCollider?.();
    for (const label of this.labels) label.dispose();
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of [this.walnut, this.brass, this.steel, this.glass, this.controlDark])
      material.dispose();
    this.station.removeFromParent();
    this.gate.removeFromParent();
  }
}
